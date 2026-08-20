/**
 * Pointer gestures on the canvas.
 *
 * All drags follow one shape: capture the pointer, open a history batch on
 * down, mutate on move, close the batch on up. That is what makes a drag a
 * single undo step regardless of how many pointermove events it produced.
 *
 * Nothing a button invokes lives here; that is `commands.ts`, and §44 of
 * `docs/ARCHITECTURE.md` argues the line. The keyboard is in `keys.ts`, because
 * a key both ends gestures and runs commands and so belongs to neither.
 */

import { translate, isIdentity } from '../core/affine';
import type { Mat } from '../core/affine';
import type { Box } from '../core/bezier';
import { cloneSubpath, continuityOf, makeNode, segmentCount } from '../core/types';
import type { Pt, Subpath } from '../core/types';
import {
  emptySelection,
  findShape,
  isHidden,
  isLocked,
  makeShape,
  nextId,
  nodeAt,
  selectedNodes,
  selectedRefs,
  selectionBBox,
  shapeBBox,
} from '../model/doc';
import type { HandlePart, NodeRef } from '../model/doc';
import {
  captureNodes,
  closeSubpath,
  moveAnchor,
  moveHandle,
  nearestOnPath,
  reverseSubpath,
  setContinuity,
  reshapeSegment,
  setSegmentBend,
  segmentBend,
  snap as snapTo,
  splitSegment,
  transformCaptured,
  transformShape,
} from '../model/ops';
import type { Corner } from '../model/corner';
import {
  cornerAt,
  cornerRadiusAtReach,
  maxCornerRadius,
  sharedCornerRadius,
  roundCorner,
  unroundCorner,
} from '../model/corner';
import type {
  NodeSnapshot,
} from '../model/ops';
import { invisibleAt } from '../model/knots';
import { phaseInForce, phaseOf } from '../model/pixelfit';
import { resolveSnap } from '../model/snapping';
import { keylineGuides } from '../model/keylines';
import { alignmentsFor, shiftBox } from '../model/smart';
import { rayAngles } from '../model/angles';
import type { AngleSetup } from '../model/angles';
import { addGuide, moveGuide, removeGuide, settleGuide } from '../model/guides';
import type { Guide, GuideAxis } from '../model/guides';
import type { SnapResult } from '../model/snapping';
import { boxCentre, handlePoint, rotateMatrix, scaleMatrix } from '../model/transform';
import type { TransformPart } from '../model/transform';
import { ellipseSubpath, polygonSubpath, rectSubpath } from '../core/primitives';
import type { Store } from '../model/store';
import { CORNER_DOT_PX } from '../view/canvas';
import type { Canvas, OverlayExtras } from '../view/canvas';
import { bendFromPoint } from '../core/bend';
import { fitAspect, screenToDoc, zoomAt } from '../view/viewport';
import { fmt, pct } from './readout';

type DragKind =
  | { kind: 'none' }
  | { kind: 'pan'; client: Pt; camera: Pt; k: number }
  | { kind: 'marquee'; from: Pt }
  /* Sliding the tracing image into place. Not part of the document, but still
     an edit: the whole drag is one history entry. See `Backdrop`. */
  | { kind: 'backdrop'; from: Pt; origin: Pt }
  /* Dragging the selection box. `box` and `saved` are both frozen at the press:
     the box because a live one would chase the shape it is resizing, and the
     geometry because every frame is recomputed from the original rather than
     stacked on the frame before it. `grab` corrects for the handle being drawn
     outside the true box, so nothing jumps on the first move. */
  | {
      kind: 'transform';
      mode: 'scale' | 'rotate';
      part: TransformPart;
      box: Box;
      saved: NodeSnapshot[];
      grab: Pt;
      /* The matrix the last move actually applied, kept rather than rebuilt on
         release. Rebuilding it read the raw pointer where the move had snapped
         the delta first, so a drag of 2.4 units with a grid step of 2 scaled the
         document by 1.2 and told `Repeat` 1.24, compounding on every press.
         `null` until something moves, which is how a bare click on a grip is
         told from a gesture: it must not record an identity matrix over
         whatever `Repeat` was holding. */
      applied: { m: Mat; what: string; deg: number | null } | null;
      /* Whether any frame of this drag produced a matrix that is not the
         identity. `applied` alone answers "did the pointer move", which is a
         different question: a Shift-held rotate grip moved two units snaps to
         zero degrees, so the drag moved and the matrix it applied was the
         identity, and remembering that destroyed what `Repeat` held exactly as
         a bare click used to. The `body` drag guards on a non-zero delta and
         this is the same guard, asked of a matrix. */
      moved: boolean;
    }
  /* `start` is where the grabbed node was at the press, kept only so the
     readout can say how far it has come. Measuring the pointer instead would
     lie whenever a snap held the node back. */
  | { kind: 'anchor'; refs: NodeRef[]; grabbed: NodeRef; offset: Pt; start: Pt }
  | { kind: 'handle'; ref: NodeRef; which: 'in' | 'out'; breakPair: boolean }
  /* Moving a selection. The total translation is tracked from the press rather
     than accumulated per move, because it is the TOTAL that gets snapped: see
     `bodyDrag`. */
  | { kind: 'body'; shapes: string[]; refs: NodeRef[]; from: Pt; applied: Pt; box: Box | null }
  | { kind: 'pen'; ref: NodeRef }
  /* Drawing a primitive. `id` is null until the drag is big enough to be worth
     a shape, so a stray click on the canvas leaves no empty one behind and no
     history entry either. */
  | { kind: 'create'; tool: 'ellipse' | 'rect' | 'poly'; from: Pt; id: string | null }
  /* `free` picks the edit: the two-number symmetric bend, or moving the point
     under the pointer with both handles. Frozen at the press, like
     `looseness`. */
  | { kind: 'bend'; shape: string; sp: number; seg: number; looseness: number; free: boolean }
  /* Placing or moving a guide. `born` marks one dragged out of a ruler, which
     is removed rather than left behind if the drag ends where it started --
     otherwise a stray click on a ruler would litter the canvas. */
  | { kind: 'guide'; i: number; axis: GuideAxis; born: boolean }
  /* Rounding corners by dragging one of them. `sharp` is the subpath with every
     corner in `ids` un-rounded, captured once at the press: every move rebuilds
     from it and calls `roundCorner`, so the drag and the rail's button produce
     the same geometry by construction rather than by two implementations
     agreeing. Node ids rather than indices, because `roundCorner` splices two
     nodes in where there was one and an index is only true when it is read. */
  | {
      kind: 'corner';
      shape: string;
      sp: number;
      sharp: Subpath;
      ids: string[];
      corner: Pt;
      /** Unit vector from the corner into it, along the bisector of its two sides. */
      bis: Pt;
      /**
       * The corner itself, kept because turning the pointer's distance back
       * into a radius has to read the sides. A half-angle is enough only where
       * both of them are straight.
       */
      measured: Corner;
      max: number;
      applied: number;
    };

/**
 * What the drag currently under way is worth reporting as a number.
 *
 * Two shapes, because drags come in two kinds and forcing both through one
 * would make one of them useless. Moving anything is a displacement, and its
 * length and direction are the question. Drawing a rectangle or sweeping a
 * marquee is a box, and its width and height are the question; the diagonal's
 * length is not what anyone drawing a 40 by 20 rectangle wants to read.
 */
export type Measure =
  | { kind: 'vector'; len: number; deg: number }
  | { kind: 'box'; w: number; h: number }
  /* A third, because a corner's radius is neither. Reporting it as the distance
     the control moved would answer a question nobody asked: what you are setting
     is the radius, and it is not the length of anything on screen. */
  | { kind: 'radius'; r: number };

/**
 * The unit vector into a corner, along the bisector of its two sides.
 *
 * `u` and `v` are the unit vectors leaving the corner, so their sum bisects them.
 * The degenerate case is two opposite directions, which is a path running straight
 * through and not a corner at all -- `cornerAt` has already refused it, so the
 * fallback here is unreachable rather than a decision.
 */
function bisector(u: Pt, v: Pt): Pt {
  const bx = u[0] + v[0];
  const by = u[1] + v[1];
  const len = Math.hypot(bx, by);
  return len < 1e-9 ? [0, 0] : [bx / len, by / len];
}

/**
 * The corners one drag on a corner control rounds, un-rounding each in `sharp`.
 *
 * Illustrator's rule, which is the one people arrive with: a widget dragged
 * while nothing in particular is selected rounds every corner of the path, and
 * one dragged with nodes selected rounds those. The grabbed corner is always in
 * the set, so a drag can never do nothing.
 *
 * `sharp` is mutated. A corner that already holds an arc goes back to being a
 * corner before it can be rounded to a different radius, and doing that to all
 * of them at the press is what lets every frame rebuild from one square path.
 * Returns ids because `unroundCorner` replaces a pair with one new node.
 */
function cornersForDrag(sharp: Subpath, at: number, selected: ReadonlySet<string>): string[] {
  const wanted = new Set<string>([sharp.nodes[at].id]);
  for (const n of sharp.nodes) {
    if (selected.size === 0 || selected.has(n.id)) wanted.add(n.id);
  }

  const ids: string[] = [];
  for (const id of wanted) {
    /* Found again each time round: un-rounding one corner splices two nodes
       into one, which moves every index after it and can consume the other half
       of a pair that is also in this set. That one is gone from `sharp` and
       drops out here. */
    let i = sharp.nodes.findIndex((n) => n.id === id);
    if (i < 0) continue;
    i = unroundCorner(sharp, i) ?? i;
    if (typeof cornerAt(sharp, i) === 'string') continue;
    ids.push(sharp.nodes[i].id);
  }
  return ids;
}


export class Controller {
  /**
   * Where user-facing notices go. Set by the wiring, left unset in tests.
   *
   * A callback rather than a return value because delete has two entry points,
   * the button and the key, and a returned message would be reported by one of
   * them and dropped by the other.
   */
  onMessage: ((message: string, ok: boolean) => void) | null = null;

  /**
   * Called after every render, for readouts that describe what was drawn.
   *
   * The store's own subscribers run the moment state changes; a render happens
   * on the next animation frame. Anything a readout says about the *drawing*
   * rather than the document -- whether the overlay drew its markers, say -- is
   * therefore a frame stale if it is read in a subscriber, and stale for good
   * if no further change arrives. This fires late enough to be true.
   */
  onRender: (() => void) | null = null;

  private drag: DragKind = { kind: 'none' };
  /**
   * Whether this gesture opened a history batch.
   *
   * Recorded when the batch opens, never reconstructed in `onUp` by inspecting
   * the drag. That is a different question: the drag can be replaced or change
   * shape mid-gesture, and then the answer differs. An unclosed batch disables
   * checkpointing permanently and says nothing on screen, so the cost of
   * getting this wrong is every later undo point, not this gesture.
   */
  private batchOpen = false;
  private extras: OverlayExtras = {};
  private frame = 0;
  /** Subpath the pen tool is currently extending. */
  private penTarget: { shape: string; sp: number } | null = null;
  private spaceDown = false;

  /**
   * Hold or release the space bar, which turns any press into a pan.
   *
   * Set from `keys.ts` rather than read from a key event here, so that one
   * listener decides what a key means and this class only hears the result.
   */
  holdSpace(down: boolean): void {
    this.spaceDown = down;
  }

  /**
   * Fingers on the glass, in client coordinates, by pointer id.
   *
   * Only touches. A mouse has one pointer and a pen reports as its own type, so
   * neither can start the two-finger gesture by accident.
   */
  private touches = new Map<number, Pt>();
  /** The pinch in progress: how far apart the fingers were, and their midpoint. */
  private pinch: { dist: number; mid: Pt } | null = null;

  constructor(
    private store: Store,
    private canvas: Canvas,
  ) {
    const ov = canvas.overlay;
    ov.addEventListener('pointerdown', this.onDown);
    ov.addEventListener('pointermove', this.onMove);
    ov.addEventListener('pointerup', this.onUp);
    // A cancelled pointer is the browser taking the gesture away -- a scroll
    // takeover, palm rejection. Routing it to `onUp` *committed* whatever was
    // half-drawn, which is the opposite of what a cancel means and the opposite
    // of what Escape does.
    ov.addEventListener('pointercancel', this.onCancel);
    ov.addEventListener('dblclick', this.onDoubleClick);
    ov.addEventListener('wheel', this.onWheel, { passive: false });
    ov.addEventListener('contextmenu', (e) => e.preventDefault());

    /* Last-resort ends for a gesture the overlay never hears the end of.
       `setPointerCapture` can fail -- it is in a try/catch a few lines up
       precisely because it does -- and then a release outside the canvas, or a
       button let go while the window is unfocused after Alt+Tab, never reaches
       `onUp`. The batch would stay open, `checkpoint` would return early for the
       rest of the session, and no undo point would ever be recorded again with
       nothing on screen to say so. That is the worst failure this code has, so
       it gets a floor under it rather than an argument that it cannot happen. */
    window.addEventListener('pointerup', this.onStrayUp);
    window.addEventListener('blur', this.onStrayBlur);

    const refit = (): void => {
      this.store.update((s) => {
        s.camera = fitAspect(s.camera, this.canvas.overlay);
      });
    };
    window.addEventListener('resize', refit);
    // The window is not the only thing that changes the canvas box: opening the
    // source drawer or collapsing the inspector does too, and a camera left at
    // the old aspect draws the document stretched. Guarded because jsdom, where
    // the DOM tests run, has no ResizeObserver.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(refit).observe(ov);
    }

    store.subscribe(() => this.schedule());
  }

  /* ------------------------------------------------------------ rendering */

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render(): void {
    const s = this.store.state;
    this.canvas.setCamera(s.camera);
    this.canvas.renderArtwork(s.doc, s);
    // Shown while idle and while it is itself being dragged, so a scale or a
    // rotation has something to read against. Hidden during every other drag,
    // where a box chasing the thing it measures is noise.
    this.extras.selectionBox =
      this.drag.kind === 'none' || this.drag.kind === 'transform' ? this.transformBox() : null;
    // The grid draws the lattice the tools are actually snapping to, frozen
    // phase and all, because there is only one of them.
    this.extras.gridPhase = this.phase();
    this.extras.draggingGuide = this.drag.kind === 'guide' ? this.drag.i : null;
    // Recomputed every frame rather than cached: the implicit origin moves with
    // the gesture, so the rays are only right if they are asked again.
    this.extras.rays = this.rayLines();
    this.canvas.renderOverlay(s, this.extras);
    this.onRender?.();
  }

  /* ------------------------------------------------------------- helpers */

  private pt(e: PointerEvent | MouseEvent | WheelEvent): Pt {
    return screenToDoc(this.canvas.overlay, e.clientX, e.clientY);
  }

  /**
   * Shift and Alt, from the keyboard or from the two buttons in the status
   * strip.
   *
   * Every pointer gesture asks these rather than the event, so a finger and a
   * keyboard reach the same seven behaviours. The keyboard handlers are not
   * routed through them: `Shift` there means the second half of a shortcut, and
   * a latched Shift turning `Tab` into `Shift+Tab` would be a trap.
   */
  private shift(e: { shiftKey: boolean }): boolean {
    return e.shiftKey || this.store.state.heldShift;
  }

  private alt(e: { altKey: boolean }): boolean {
    return e.altKey || this.store.state.heldAlt;
  }

  /**
   * The lattice shift in force, or zero when pixel-fit is off or undecidable.
   *
   * **A drawing tool asks the pending style, not the selection.**
   * `phaseInForce` prefers what is selected and a create drag replaces the
   * selection with the shape it just made, so the phase would change partway
   * through the gesture: two corners on one lattice and two on another gives a
   * rectangle 20.5 units wide, which is the failure §25 exists to prevent.
   *
   * **No freeze-at-the-press**, measured rather than assumed: with the rule
   * above, removing the freeze changed no test. Nothing else moves the phase
   * mid-gesture, since a node drag does not alter the selection and shape drags
   * snap a displacement, which is phase-invariant.
   */
  phase(): number {
    const s = this.store.state;
    if (!s.pixelFit) return 0;
    const creating = s.tool === 'pen' || s.tool === 'ellipse' || s.tool === 'rect' || s.tool === 'poly';
    if (creating) return phaseOf(s.style);
    return phaseInForce(s.doc, s.selection, s.style) ?? 0;
  }

  /**
   * How near a 0-D or 1-D target has to be to claim the pointer, in screen
   * pixels.
   *
   * Screen pixels rather than document units, so the reach feels the same at
   * every zoom: eight pixels is about how far the eye reads as "on it".
   */
  private static readonly REACH_PX = 8;

  /**
   * Apply snapping. The rule lives in `model/snapping.ts`; this supplies it with
   * the things only the controller knows -- the camera, and what is being
   * dragged.
   */
  private snap(p: Pt, exclude?: NodeRef, excludeShape?: string): Pt {
    return this.snapWith(p, exclude, excludeShape).pt;
  }

  /**
   * Where a point put down here would land, and what claimed it.
   *
   * For the readout. No exclusions, because a hover is asking about a point that
   * does not exist yet: the node under the pointer is a legitimate target for
   * one, where it would not be a target for itself.
   */
  snapPreview(p: Pt): SnapResult {
    return this.snapWith(p);
  }

  /**
   * The guides worth aiming at, which never includes the one being dragged.
   *
   * A guide lies on itself at distance zero, so without the exclusion the first
   * move pins it where it already is and it can never be moved again. §31.
   */
  private guideTargets(exclude?: number): Guide[] | undefined {
    const s = this.store.state;
    if (!s.showGuides || !s.guides.length) return undefined;
    return exclude === undefined ? s.guides : s.guides.filter((_, i) => i !== exclude);
  }

  /**
   * Where the rays radiate from, or null when there is nothing to radiate from.
   *
   * An explicit origin wins. Without one the answer is wherever the gesture
   * started, which is what makes the feature usable without setting anything:
   * the direction you want to hold is almost always the direction away from the
   * point you are drawing from. With neither -- angular snap on, no origin set,
   * nothing being drawn -- there are no rays, and the pointer is left alone
   * rather than held to an origin nobody chose.
   */
  private angleSetup(): AngleSetup | null {
    const s = this.store.state;
    if (!s.snapToAngles) return null;
    const origin = s.angleOrigin ?? this.gestureOrigin();
    if (!origin) return null;
    return { origin, step: s.angleStep, base: s.angleBase };
  }

  /** The point the gesture under way started from, for an implicit origin. */
  private gestureOrigin(): Pt | null {
    const s = this.store.state;
    switch (this.drag.kind) {
      case 'anchor':
        return this.drag.start;
      case 'body':
      case 'create':
        return this.drag.from;
      case 'handle': {
        const n = findShape(s.doc, this.drag.ref.shape)?.subpaths[this.drag.ref.sp]?.nodes[
          this.drag.ref.i
        ];
        return n ? n.pt : null;
      }
      default: {
        // The pen between clicks is not a drag, and its origin is the node it
        // is trailing the rubber band from.
        if (s.tool !== 'pen') return null;
        const sp = this.penSubpath();
        const last = sp?.nodes[sp.nodes.length - 1];
        return last ? last.pt : null;
      }
    }
  }

  /** The rays as document-space line ends, for the overlay to draw. */
  rayLines(): { x1: number; y1: number; x2: number; y2: number }[] {
    const a = this.angleSetup();
    if (!a) return [];
    const cam = this.store.state.camera;
    // Long enough to leave the camera from anywhere inside it, whatever the
    // origin: the far corner plus the camera's own diagonal covers it.
    const reach =
      Math.hypot(cam.w, cam.h) +
      Math.hypot(a.origin[0] - (cam.x + cam.w / 2), a.origin[1] - (cam.y + cam.h / 2));
    return rayAngles(a.step, a.base).map((deg) => {
      const r = (deg * Math.PI) / 180;
      return {
        x1: a.origin[0],
        y1: a.origin[1],
        x2: a.origin[0] + Math.cos(r) * reach,
        y2: a.origin[1] + Math.sin(r) * reach,
      };
    });
  }

  private snapWith(p: Pt, exclude?: NodeRef, excludeShape?: string, excludeGuide?: number): SnapResult {
    const s = this.store.state;
    return resolveSnap(p, {
      doc: s.doc,
      step: s.gridStep,
      phase: this.phase(),
      toGrid: s.snapToGrid,
      toPoints: s.snapToPoints,
      toBoundary: s.snapToBoundary,
      toIntersections: s.snapToIntersections,
      reach: Controller.REACH_PX * this.canvas.scale(s.camera),
      exclude,
      excludeShape,
      // Only when they are on screen. A target you cannot see pulling the
      // pointer off the grid would read as the editor misbehaving.
      guides: s.showKeylines ? keylineGuides(s.doc.viewBox) : undefined,
      guideLines: this.guideTargets(excludeGuide),
      angles: this.angleSetup(),
    });
  }

  private hitOf(e: PointerEvent | MouseEvent): {
    kind: string;
    ref: NodeRef | null;
    shape: string | null;
    seg: number | null;
    /** Compass position, for the transform box's handles. */
    part: string | null;
  } | null {
    const t = e.target as Element | null;
    const kind = t?.getAttribute?.('data-hit');
    if (!kind || !t) return null;
    const shape = t.getAttribute('data-shape');
    const part = t.getAttribute('data-part');
    /* A locked shape takes no press at all, and the gate is here because every
       pointer gesture asks this one question first. Anywhere else it would be a
       check each of the twenty-six places that add to a selection has to
       remember. The canvas draws no hit surface for a locked shape either, so
       this catches only what is left: a marker still on screen from the frame
       the lock landed in. §66. */
    if (shape && isLocked(this.store.state.doc, this.store.state.locked, shape)) return null;
    // Hidden takes no press either, and for a plainer reason: there is nothing
    // there to press. The canvas draws neither the shape nor its markers.
    if (shape && isHidden(this.store.state.doc, shape)) return null;
    if (kind === 'outline' || !shape) return { kind, shape, part, ref: null, seg: null };
    const segAttr = t.getAttribute('data-seg');
    return {
      kind,
      shape,
      part,
      seg: segAttr === null ? null : Number(segAttr),
      ref: { shape, sp: Number(t.getAttribute('data-sp')), i: Number(t.getAttribute('data-i')) },
    };
  }

  /** Open the gesture's history batch, remembering that we did. */
  private openBatch(): void {
    if (this.batchOpen) return;
    this.store.beginBatch();
    this.batchOpen = true;
  }

  /** Close it, at most once, whatever route the gesture took out. */
  private closeBatch(): void {
    if (!this.batchOpen) return;
    this.store.endBatch();
    this.batchOpen = false;
  }

  /**
   * The box the transform handles hang off, or `null` for no box at all.
   *
   * Refused when the selection has no extent in either direction, which is a
   * single node: there is nothing to scale it against, and the handles would
   * pile up on the node itself. A selection flat in one direction keeps its
   * box, because stretching a row of nodes sideways is a real thing to want.
   *
   * Only in the select tool. The pen and the primitive tools own the canvas
   * while they are active, and handles under the cursor would take clicks meant
   * for drawing.
   */
  private transformBox(): Box | null {
    const s = this.store.state;
    if (s.tool !== 'select') return null;
    const b = selectionBBox(s.doc, s.selection);
    if (!b) return null;
    if (Math.abs(b.x1 - b.x0) < 1e-9 && Math.abs(b.y1 - b.y0) < 1e-9) return null;
    return b;
  }

  /**
   * True while a gesture is in progress.
   *
   * `onKeyDown` already refuses Ctrl+Z mid-drag, because popping the checkpoint
   * a drag is standing on makes it roll back somebody else's edit when it ends.
   * The toolbar buttons had no such guard, and a second finger on a touchscreen
   * reaches them while the first is still dragging.
   */
  get busy(): boolean {
    return this.drag.kind !== 'none';
  }

  /**
   * What the live drag measures, or null when there is nothing to say.
   *
   * Read every frame by the status strip. It reports the RESULT rather than the
   * pointer: a shape held back by a grid snap has moved a whole number of
   * steps, and a readout tracking the pointer would show the fraction the shape
   * did not travel. Every kind below therefore measures geometry that is
   * already in the document, except `create` before its shape exists.
   *
   * Angles are `atan2(dy, dx)` in document coordinates, the same convention as
   * `rotateMatrix`. Document y grows downwards, so a positive angle turns
   * clockwise on screen and 90 degrees points down. Matching the rotate readout
   * matters more than matching a maths textbook: rotating a shape by 30 and
   * then measuring the edge you made should not disagree about the sign.
   *
   * Silent for `pan`, which moves the camera and not the drawing, and for
   * `transform`, which already reports its own turn or scale through
   * `onMessage` and would otherwise contradict itself in two places at once.
   */
  measure(): Measure | null {
    const s = this.store.state;
    const vec = (dx: number, dy: number): Measure => ({
      kind: 'vector',
      len: Math.hypot(dx, dy),
      deg: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
    const box = (b: Box): Measure => ({
      kind: 'box',
      w: Math.abs(b.x1 - b.x0),
      h: Math.abs(b.y1 - b.y0),
    });

    switch (this.drag.kind) {
      case 'body':
        // The applied translation, which is the snapped one.
        return vec(this.drag.applied[0], this.drag.applied[1]);

      /* The radius that was applied, not the one the pointer asked for: it is
         clamped to what the corner can hold and snapped to the lattice, and a
         readout showing the request rather than the result is a readout that
         disagrees with the drawing. */
      case 'corner':
        return { kind: 'radius', r: this.drag.applied };

      case 'anchor': {
        const d = this.drag;
        const n = findShape(s.doc, d.grabbed.shape)?.subpaths[d.grabbed.sp]?.nodes[d.grabbed.i];
        return n ? vec(n.pt[0] - d.start[0], n.pt[1] - d.start[1]) : null;
      }

      /* The handle itself, not how far it was dragged. Its length and direction
         are what shape the curve, and they are what you are watching. */
      case 'handle': {
        const d = this.drag;
        const n = findShape(s.doc, d.ref.shape)?.subpaths[d.ref.sp]?.nodes[d.ref.i];
        const h = d.which === 'in' ? n?.hIn : n?.hOut;
        return n && h ? vec(h[0] - n.pt[0], h[1] - n.pt[1]) : null;
      }

      // Pulling handles out of a node just placed. Always the outgoing one:
      // the incoming one is its mirror, so reporting both would say it twice.
      case 'pen': {
        const d = this.drag;
        const n = findShape(s.doc, d.ref.shape)?.subpaths[d.ref.sp]?.nodes[d.ref.i];
        return n?.hOut ? vec(n.hOut[0] - n.pt[0], n.hOut[1] - n.pt[1]) : null;
      }

      case 'backdrop': {
        const b = s.backdrop;
        const d = this.drag;
        return b ? vec(b.x - d.origin[0], b.y - d.origin[1]) : null;
      }

      case 'marquee':
        return this.extras.marquee ? box(this.extras.marquee) : null;

      /* Before the drag is big enough to be worth a shape there is no geometry
         to measure, and inventing one from the pointer would report a size the
         document does not have. */
      case 'create': {
        const shape = this.drag.id ? findShape(s.doc, this.drag.id) : null;
        const b = shape ? shapeBBox(shape) : null;
        return b ? box(b) : null;
      }

      default:
        return null;
    }
  }

  /* --------------------------------------------------------------- guides */

  /**
   * Let the two rulers hand out guides.
   *
   * A press anywhere on a ruler makes a guide and starts dragging it, rather
   * than waiting for the pointer to reach the canvas. The guide is visible from
   * the first frame, so the gesture explains itself; and a press that never
   * goes anywhere is undone on release by the same rule that removes one
   * dragged off the canvas.
   *
   * The pointer is captured on the ruler, so the drag carries on over the
   * stage, and coordinates go through the overlay's own matrix -- which is an
   * inverse transform, not a hit test, and so answers correctly for a client
   * point that is nowhere near the overlay.
   */
  attachRulers(h: SVGSVGElement, v: SVGSVGElement): void {
    const start = (axis: GuideAxis) => (e: PointerEvent): void => {
      if (e.button !== 0 || this.drag.kind !== 'none') return;
      /* Locked guides are still handed out. Lock says "do not move what is
         already there, so a press near a guide edits the drawing" -- it is
         about the guides on the canvas, not about the ruler. Refusing here made
         the strip look broken while the Vertical and Horizontal buttons next to
         it carried on working. */
      e.preventDefault();
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        // Same as the overlay's: losing capture costs the drag, aborting costs
        // it outright.
      }
      const p = this.pt(e);
      const at = axis === 'x' ? p[0] : p[1];
      this.openBatch();
      /* `tryEdit`, not `edit`. A press on a ruler where a guide already sits
         changes nothing, and `edit` checkpoints before it finds that out --
         which left an entry that undoes to the state it was already in, and
         threw the redo stack away on the way. */
      const made = this.store.tryEdit((st) => {
        const ok = addGuide(st.guides, { axis, at });
        // Showing a guide is implied by placing one. Dragging one out of a
        // ruler while they are hidden would otherwise draw nothing at all.
        if (ok) st.showGuides = true;
        return ok;
      });
      if (!made) {
        this.closeBatch();
        return;
      }
      this.drag = { kind: 'guide', i: this.store.state.guides.length - 1, axis, born: true };
    };
    h.addEventListener('pointerdown', start('y'));
    v.addEventListener('pointerdown', start('x'));
    // The gesture continues on the ruler's own capture, so the ruler has to
    // forward the rest of it to the same handlers the overlay uses.
    for (const el of [h, v]) {
      el.addEventListener('pointermove', (e) => {
        if (this.drag.kind === 'guide') this.onMove(e);
      });
      el.addEventListener('pointerup', (e) => {
        if (this.drag.kind === 'guide') this.onUp(e);
      });
    }
  }

  /**
   * What a drag can line up with: every shape that is not moving, and the page.
   *
   * The page earns its place. An icon is drawn to a canvas, so its edges and
   * its centre are the alignments wanted most often, and they are the ones no
   * other shape can offer.
   */
  private staticBoxes(moving: string[]): Box[] {
    const s = this.store.state;
    const out: Box[] = [];
    for (const shape of s.doc.shapes) {
      if (moving.includes(shape.id)) continue;
      const b = shapeBBox(shape);
      if (b) out.push(b);
    }
    const vb = s.doc.viewBox;
    if (vb.w > 0 && vb.h > 0) {
      out.push({ x0: vb.x, y0: vb.y, x1: vb.x + vb.w, y1: vb.y + vb.h });
    }
    return out;
  }

  /* ---------------------------------------------------------------- pinch */

  /** How far apart two fingers are, and where the point between them is. */
  private spread(): { dist: number; mid: Pt } | null {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return null;
    return {
      dist: Math.hypot(b[0] - a[0], b[1] - a[1]),
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    };
  }

  /**
   * Zoom and pan from two fingers moving.
   *
   * One gesture, so both at once: spreading zooms about the point between the
   * fingers, moving that point pans.
   *
   * **Zoom about the old midpoint, then pan.** That leaves the point under the
   * fingers where it was and makes the pan a screen distance in the new scale.
   * About the new midpoint the drawing moves twice. §42.
   */
  private pinchMove(): void {
    const now = this.spread();
    const was = this.pinch;
    if (!now || !was) return;
    /* Closer together than a pixel says nothing about scale, and dividing by it
       says something absurd: the camera comes back `NaN` and the drawing is
       gone. Two fingers landing on the same spot is an ordinary press, so this
       takes the new positions as the baseline rather than returning outright --
       returning left `was` at a distance of zero for the rest of the gesture,
       and the pinch never zoomed again however far the fingers travelled. */
    if (now.dist < 1 || was.dist < 1) {
      this.pinch = now;
      return;
    }

    const factor = was.dist / now.dist;
    const anchor = screenToDoc(this.canvas.overlay, was.mid[0], was.mid[1]);
    const dx = now.mid[0] - was.mid[0];
    const dy = now.mid[1] - was.mid[1];

    this.store.update((st) => {
      const zoomed = zoomAt(st.camera, factor, anchor);
      const k = this.canvas.scale(zoomed);
      st.camera = { ...zoomed, x: zoomed.x - dx * k, y: zoomed.y - dy * k };
    });
    this.pinch = now;
  }

  /* -------------------------------------------------------------- pointer */

  private onDown = (e: PointerEvent): void => {
    if (e.button === 2) return;

    /* Recorded before the one-drag-at-a-time rule below, which returns early:
       the second finger has to be seen even though it starts no drag. */
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.touches.size === 2) {
        /* Whatever the first finger began, it was the start of this gesture
           rather than a gesture of its own. Abandoning it rolls back an edit it
           had already made -- a node the pen added, a handle it moved -- which
           is what makes a two-finger zoom safe to do over the drawing. */
        this.abortDrag();
        this.pinch = this.spread();
        return;
      }
      /* A third finger, a palm, a hand resting: it starts nothing.
         **Nothing distinguishes this line, and it is kept anyway.** Removing it
         lets the third press start a drag -- a marquee, measured, not
         supposed -- and that drag is never seen: its moves are swallowed while
         the pinch is live, and the first of the other two fingers to lift runs
         `onUp`, whose `finally` puts the drag back to none. Two accidents,
         either of which could stop being true. Saying it once here is cheaper
         than depending on both. */
      if (this.touches.size > 2) return;
    }
    // One drag at a time. A second press must not overwrite `this.drag`: the
    // first drag's batch would never close, after which `checkpoint()` returns
    // early forever and no undo point is ever recorded again, with nothing on
    // screen to say so. Two fingers on a touchscreen are enough to do it.
    if (this.drag.kind !== 'none') return;
    const s = this.store.state;
    const p = this.pt(e);
    try {
      this.canvas.overlay.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is no longer active cannot be captured. Losing capture
      // costs us the drag if it leaves the canvas; aborting here would cost us
      // the drag outright.
    }

    // Middle button or space always pans, whatever the tool. Panning is
    // tracked in SCREEN coordinates: document coordinates under the cursor are
    // exactly what panning changes, so using them would feed back on itself.
    if (e.button === 1 || this.spaceDown || s.tool === 'hand') {
      this.drag = {
        kind: 'pan',
        client: [e.clientX, e.clientY],
        camera: [s.camera.x, s.camera.y],
        k: this.canvas.scale(s.camera),
      };
      return;
    }

    if (s.tool === 'pen') {
      this.penDown(p);
      return;
    }

    if (s.tool === 'ellipse' || s.tool === 'rect' || s.tool === 'poly') {
      this.drag = { kind: 'create', tool: s.tool, from: this.snap(p), id: null };
      return;
    }

    const hit = this.hitOf(e);

    // Before anchors, because a handle sits in front of one on screen and has
    // to be what you grabbed when it does.
    if ((hit?.kind === 'scale' || hit?.kind === 'rotate') && hit.part) {
      const box = this.transformBox();
      if (box) {
        const part = hit.part as TransformPart;
        const at = handlePoint(box, part);
        this.openBatch();
        this.drag = {
          kind: 'transform',
          mode: hit.kind === 'rotate' ? 'rotate' : 'scale',
          part,
          box,
          saved: captureNodes(s.doc, selectedNodes(s.doc, s.selection)),
          // For a scale, the pointer is a few pixels outside the corner it is
          // about to drag, because that is where the handle is drawn. Recording
          // the difference is what stops the selection twitching on the first
          // move. A rotation measures an angle from wherever the press landed,
          // so it wants the raw point.
          grab: hit.kind === 'rotate' ? p : [p[0] - at[0], p[1] - at[1]],
          applied: null,
          moved: false,
        };
        return;
      }
    }

    if (hit?.kind === 'anchor' && hit.ref) {
      const key = nodeAt(this.store.state.doc, hit.ref)?.id;
      if (key === undefined) return;
      this.store.update((st) => {
        if (this.shift(e)) {
          if (st.selection.nodes.has(key)) st.selection.nodes.delete(key);
          else st.selection.nodes.add(key);
        } else if (!st.selection.nodes.has(key)) {
          st.selection = emptySelection();
          st.selection.nodes.add(key);
        }
      });
      const node = findShape(s.doc, hit.ref.shape)?.subpaths[hit.ref.sp]?.nodes[hit.ref.i];
      if (!node) return;
      this.openBatch();
      this.drag = {
        kind: 'anchor',
        refs: selectedNodes(s.doc, s.selection),
        grabbed: hit.ref,
        offset: [p[0] - node.pt[0], p[1] - node.pt[1]],
        start: [node.pt[0], node.pt[1]],
      };
      return;
    }

    if (hit?.kind === 'corner' && hit.ref) {
      const live = findShape(s.doc, hit.ref.shape)?.subpaths[hit.ref.sp];
      if (live) {
        /* Un-round on a copy, and keep the copy. A corner that already holds an arc
           has to go back to being a corner before it can be rounded to a different
           radius, and doing that to the live path would make the drag's first frame
           a visible jump to square. */
        const sharp: Subpath = cloneSubpath(live);
        const grabbed = unroundCorner(sharp, hit.ref.i) ?? hit.ref.i;
        const id = sharp.nodes[grabbed].id;
        /* Every corner this drag is for, un-rounded together. The grabbed one is
           found again afterwards, because un-rounding another corner ahead of it
           moves it. */
        const ids = cornersForDrag(sharp, grabbed, s.selection.nodes);
        const at = sharp.nodes.findIndex((n) => n.id === id);
        const c = at < 0 ? 'end' : cornerAt(sharp, at);
        if (typeof c !== 'string') {
          this.openBatch();
          this.drag = {
            kind: 'corner',
            shape: hit.ref.shape,
            sp: hit.ref.sp,
            sharp,
            ids,
            corner: c.at,
            bis: bisector(c.u, c.v),
            measured: c,
            /* The whole set's limit, not this corner's. `maxCornerRadius` alone
               would let the pointer ask for a radius its neighbours cannot hold,
               and they would clamp one at a time to different sizes. */
            max: ids.length > 1 ? sharedCornerRadius(sharp, ids) : maxCornerRadius(c),
            applied: 0,
          };
          return;
        }
      }
    }

    if (hit?.kind === 'bend' && hit.ref && hit.seg !== null) {
      const sp = findShape(s.doc, hit.ref.shape)?.subpaths[hit.ref.sp];
      const cur = sp ? segmentBend(sp, hit.seg) : null;
      this.openBatch();
      this.drag = {
        kind: 'bend',
        shape: hit.ref.shape,
        sp: hit.ref.sp,
        seg: hit.seg,
        looseness: cur?.looseness ?? 1,
        /* Which of the two edits this drag is, decided once at the press.
           Re-reading it every frame would let a segment that happened to pass
           through symmetry mid-drag change what dragging means underneath the
           pointer. `cur` is null exactly when the handles are not symmetric,
           and Alt asks for the free edit regardless -- the same key that
           breaks a handle pair, doing the same thing. */
        free: cur === null || this.alt(e),
      };
      return;
    }

    if ((hit?.kind === 'in' || hit?.kind === 'out') && hit.ref) {
      this.openBatch();
      // Alt held at the moment of grabbing breaks the pair for the whole drag.
      // Sampling it once, rather than per move, means letting go of Alt midway
      // does not suddenly snap the far handle back into line.
      this.drag = { kind: 'handle', ref: hit.ref, which: hit.kind, breakPair: this.alt(e) };
      return;
    }

    if (hit?.kind === 'outline' && hit.shape) {
      const id = hit.shape;
      // Grabbing the outline of a shape that already has nodes selected drags
      // the whole selection. Clearing it and selecting this one shape instead
      // means a marquee over three shapes followed by a drag moves one of them,
      // which reads as the marquee having been forgotten.
      /* "Some of this shape's nodes are selected" was the wrong test. It is
         true of a marquee across several shapes, where dragging should move
         them all -- and equally true of one clicked vertex, where it turned an
         outline drag into a deformation: the corner tore off and the shape
         stayed put. What distinguishes the marquee is that it caught the WHOLE
         shape, so that is what to ask. */
      const shapeNodes = findShape(s.doc, id)?.subpaths.reduce((a, sp) => a + sp.nodes.length, 0) ?? 0;
      const selectedHere = selectedRefs(s.doc, s.selection).filter((r) => r.shape === id).length;
      const wholeShapeSelected = shapeNodes > 0 && selectedHere === shapeNodes;
      this.store.update((st) => {
        if (!this.shift(e) && !st.selection.shapes.has(id) && !wholeShapeSelected) {
          st.selection = emptySelection();
        }
        st.selection.shapes.add(id);
      });
      this.openBatch();
      const shapes = [...this.store.state.selection.shapes];
      // Nodes belonging to a shape that is moving wholesale would be moved
      // twice, once by each rule.
      const refs = selectedNodes(s.doc, s.selection).filter((r) => !shapes.includes(r.shape));
      /* Frozen at the press, like the transform box's. A box recomputed each
         frame would be the box of what is already moving, so an alignment
         would be measured against the answer it just produced. */
      this.drag = {
        kind: 'body',
        shapes,
        refs,
        from: p,
        applied: [0, 0],
        box: selectionBBox(this.store.state.doc, this.store.state.selection),
      };
      return;
    }

    /* A guide, if one is under the pointer and they are not locked. After the
       drawing, because the hit strips sit behind every outline and anchor: a
       guide crossing a shape must not take a press aimed at the shape. */
    if (hit?.kind === 'guide' && !s.guidesLocked) {
      const i = Number((e.target as Element).getAttribute('data-guide'));
      const g = s.guides[i];
      if (g) {
        this.openBatch();
        this.drag = { kind: 'guide', i, axis: g.axis, born: false };
        return;
      }
    }

    // An unlocked backdrop takes the empty-canvas drag, which is the whole
    // meaning of unlocking it.
    const back = s.backdrop;
    if (back && back.visible && !back.locked) {
      this.openBatch();
      this.drag = { kind: 'backdrop', from: p, origin: [back.x, back.y] };
      return;
    }

    if (!this.shift(e)) this.store.update((st) => (st.selection = emptySelection()));
    this.drag = { kind: 'marquee', from: p };
  };

  private onMove = (e: PointerEvent): void => {
    /* Membership, not pointer type: what counts as a finger is decided once, in
       `onDown`, and asking the same question twice in two places is how the two
       answers come to disagree. */
    if (this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pinch) {
        this.pinchMove();
        return;
      }
    }

    const p = this.pt(e);
    const s = this.store.state;

    switch (this.drag.kind) {
      case 'none': {
        // With the pen mid-path, trail a rubber band from the last node so it
        // is clear where the next click will land.
        if (s.tool === 'pen') {
          const sp = this.penSubpath();
          const last = sp?.nodes[sp.nodes.length - 1];
          const from = last ? last.pt : null;
          if (from) {
            this.extras.penFrom = from;
            this.extras.penTo = p;
            this.schedule();
            return;
          }
          this.extras.penFrom = null;
          this.extras.penTo = null;
        }

        // Hovering an outline offers an insertion point.
        const hit = this.hitOf(e);
        const near =
          hit?.kind === 'outline'
            ? nearestOnPath(s.doc, p, 12 * this.canvas.scale(s.camera))
            : null;
        const changed = !!near !== !!this.extras.insertAt;
        this.extras.insertAt = near ? near.pt : null;
        if (changed || near) this.schedule();
        return;
      }

      case 'pan': {
        const d = this.drag;
        const dx = (e.clientX - d.client[0]) * d.k;
        const dy = (e.clientY - d.client[1]) * d.k;
        // The camera is not the document. Panning records no history, which is
        // why this one stays an `update` while every other drag became an `edit`.
        this.store.update((st) => {
          st.camera = { ...st.camera, x: d.camera[0] - dx, y: d.camera[1] - dy };
        });
        return;
      }

      case 'marquee': {
        this.extras.marquee = {
          x0: Math.min(this.drag.from[0], p[0]),
          y0: Math.min(this.drag.from[1], p[1]),
          x1: Math.max(this.drag.from[0], p[0]),
          y1: Math.max(this.drag.from[1], p[1]),
        };
        this.schedule();
        return;
      }

      case 'anchor': {
        const d = this.drag;
        const grabbedNode = findShape(s.doc, d.grabbed.shape)?.subpaths[d.grabbed.sp]?.nodes[d.grabbed.i];
        if (!grabbedNode) return;
        const target = this.snap([p[0] - d.offset[0], p[1] - d.offset[1]], d.grabbed);
        const delta: Pt = [target[0] - grabbedNode.pt[0], target[1] - grabbedNode.pt[1]];
        this.store.edit((st) => {
          for (const r of d.refs) {
            const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
            if (!sp?.nodes[r.i]) continue;
            moveAnchor(sp, r.i, [sp.nodes[r.i].pt[0] + delta[0], sp.nodes[r.i].pt[1] + delta[1]]);
          }
        });
        return;
      }

      case 'handle': {
        const d = this.drag;
        this.store.edit((st) => {
          const sp = findShape(st.doc, d.ref.shape)?.subpaths[d.ref.sp];
          // The node index matters as much as the subpath: an undo mid-drag can
          // shorten the path under us, and `moveHandle` would dereference it.
          if (!sp?.nodes[d.ref.i]) return;
          moveHandle(sp, d.ref.i, d.which, this.snap(p, d.ref), d.breakPair);
        });
        return;
      }

      case 'transform': {
        const d = this.drag;
        const s2 = this.store.state;
        let m;
        if (d.mode === 'rotate') {
          // Shift snaps to fifteen degrees, the interval every editor uses:
          // it divides the right angle and the eighth turn both.
          const r = rotateMatrix(boxCentre(d.box), d.grab, p, this.shift(e) ? 15 : 0);
          m = r.m;
          d.applied = { m, what: `rotate ${fmt(r.deg)}°`, deg: r.deg };
          if (!isIdentity(m)) d.moved = true;
          this.onMessage?.(`Rotate ${fmt(r.deg)}°`, true);
        } else {
          const want: Pt = [p[0] - d.grab[0], p[1] - d.grab[1]];
          /* Grid only, deliberately. `this.snap` would also weld the corner of
             a bounding box to any node within eight pixels, and a box corner is
             not a point on the drawing: welding it to an unrelated shape's node
             would scale the selection by whatever ratio that happened to
             produce. */
          const to = s2.snapToGrid && s2.gridStep > 0 ? snapTo(want, s2.gridStep) : want;
          m = scaleMatrix(d.box, d.part, to, {
            // Read every frame rather than sampled at the press, because both
            // are things people reach for once a drag is already under way.
            fromCentre: this.alt(e),
            keepAspect: this.shift(e),
          });
          d.applied = { m, what: 'scale', deg: null };
          if (!isIdentity(m)) d.moved = true;
          this.onMessage?.(`Scale ${pct(m[0])} × ${pct(m[3])}`, true);
        }
        this.store.edit((st) => transformCaptured(st.doc, d.saved, m));
        return;
      }

      case 'guide': {
        const d = this.drag;
        // Snapped like anything else being placed, and against everything --
        // lining a guide up with a node is most of why you would place one.
        const at = this.snapWith(p, undefined, undefined, d.i).pt;
        this.store.edit((st) => {
          moveGuide(st.guides, d.i, d.axis === 'x' ? at[0] : at[1]);
        });
        return;
      }

      case 'backdrop': {
        const d = this.drag;
        const s2 = this.store.state;
        const raw: Pt = [p[0] - d.from[0], p[1] - d.from[1]];
        // Snapped as a displacement, like moving a shape: the reference keeps
        // its proportions and lands a whole number of steps from where it was.
        const want: Pt = s2.snapToGrid && s2.gridStep > 0 ? snapTo(raw, s2.gridStep) : raw;
        this.store.edit((st) => {
          if (st.backdrop) {
            st.backdrop.x = d.origin[0] + want[0];
            st.backdrop.y = d.origin[1] + want[1];
          }
        });
        return;
      }

      case 'body': {
        const d = this.drag;
        /* Snap the TRANSLATION, not the positions.
           Snapping each node's own position drags every off-lattice node onto
           the grid and destroys the shape's proportions, which is why there is
           no sane way to do it that way. Rounding the total displacement keeps
           every relative offset exactly, and
           has the property worth having: a shape whose nodes start on the grid
           ends on it, and one that starts off it stays off it by the same
           amount. Tracked from the press rather than accumulated per move, so
           the rounding cannot drift over a long drag. */
        const s2 = this.store.state;
        const raw: Pt = [p[0] - d.from[0], p[1] - d.from[1]];
        const grid: Pt = s2.snapToGrid && s2.gridStep > 0 ? snapTo(raw, s2.gridStep) : raw;

        /* Alignment beats the lattice on whichever axis it found something and
           leaves the other to the grid. Computed from the raw translation, not
           the snapped one, or the grid pulls the box off the edge it was about
           to meet. §32. */
        const align =
          s2.smartGuides && d.box
            ? alignmentsFor(
                shiftBox(d.box, raw[0], raw[1]),
                this.staticBoxes(d.shapes),
                Controller.REACH_PX * this.canvas.scale(s2.camera),
              )
            : { x: null, y: null };
        this.extras.smart = [align.x, align.y].filter((a) => a !== null);

        const want: Pt = [
          align.x ? raw[0] + align.x.shift : grid[0],
          align.y ? raw[1] + align.y.shift : grid[1],
        ];
        const delta: Pt = [want[0] - d.applied[0], want[1] - d.applied[1]];
        if (delta[0] === 0 && delta[1] === 0) return;
        d.applied = want;
        this.store.edit((st) => {
          for (const id of d.shapes) {
            const shape = findShape(st.doc, id);
            if (shape) transformShape(shape, translate(delta[0], delta[1]));
          }
          for (const r of d.refs) {
            const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
            if (!sp?.nodes[r.i]) continue;
            moveAnchor(sp, r.i, [sp.nodes[r.i].pt[0] + delta[0], sp.nodes[r.i].pt[1] + delta[1]]);
          }
        });
        return;
      }

      case 'create': {
        this.createDrag(p, this.shift(e), this.alt(e));
        return;
      }

      case 'corner': {
        const d = this.drag;
        // The pointer's distance along the bisector, read back as a radius.
        const along = (p[0] - d.corner[0]) * d.bis[0] + (p[1] - d.corner[1]) * d.bis[1];
        /* Less the offset the control is drawn at, so the radius comes out of the
           same relation the drawing used and the dot stays under the pointer. */
        const offset = CORNER_DOT_PX * this.canvas.scale(this.store.state.camera);
        let r = cornerRadiusAtReach(d.measured, along - offset);
        /* Snapped as a length, not as a point: every other drag lands on the
           lattice, and a radius that came out at 3.87 would be the odd one.
           Skipped where a whole step does not fit in what the corner can hold,
           because there the only values on the lattice are nothing and more
           than it has, and the corner rounds off in one move. */
        const step = this.store.state.gridStep;
        if (this.store.state.snapToGrid && step > 0 && step < d.max) {
          r = Math.round(r / step) * step;
        }
        // After the snap, so a snapped value can never ask for more than fits.
        r = Math.max(0, Math.min(d.max, r));
        d.applied = r;

        this.store.edit((st) => {
          const live = findShape(st.doc, d.shape)?.subpaths[d.sp];
          if (!live) return;
          /* Rebuilt from the sharp copy every frame rather than adjusted in place.
             One function decides what a fillet is, so a dragged radius and a typed
             one cannot disagree, and dragging back to zero leaves the corner sharp
             because `roundCorner` declines a radius of nothing. */
          live.nodes = cloneSubpath(d.sharp).nodes;
          live.closed = d.sharp.closed;
          if (r <= 0) return;
          /* By id, and looked up again for each one, because rounding a corner
             splices a second node in beside it and moves everything after. The
             clone carries the ids through, which is what makes the lookup work
             at all. */
          for (const id of d.ids) {
            const i = live.nodes.findIndex((n) => n.id === id);
            if (i >= 0) roundCorner(live, i, r);
          }
        });
        return;
      }

      case 'bend': {
        const d = this.drag;
        this.store.edit((st) => {
          const sp = findShape(st.doc, d.shape)?.subpaths[d.sp];
          if (!sp || d.seg >= segmentCount(sp)) return;
          if (d.free) {
            // The curve's midpoint is what the dot is drawn on, so that is the
            // point the pointer is holding.
            reshapeSegment(sp, d.seg, 0.5, p);
            return;
          }
          const a = sp.nodes[d.seg].pt;
          const b = sp.nodes[(d.seg + 1) % sp.nodes.length].pt;
          // Looseness is held at whatever it was when the drag began, so a
          // sideways wobble does not also change how taut the curve is.
          setSegmentBend(sp, d.seg, bendFromPoint(a, b, p, d.looseness));
        });
        return;
      }

      case 'pen': {
        const d = this.drag;
        this.store.edit((st) => {
          const sp = findShape(st.doc, d.ref.shape)?.subpaths[d.ref.sp];
          const n = sp?.nodes[d.ref.i];
          if (!sp || !n) return;
          // Dragging away from a freshly placed node pulls out its handles.
          // Mirroring the two makes the node symmetric by construction -- there
          // is nothing to declare, the geometry says it.
          const h = this.snap(p, d.ref);

          /* **A handle on top of its own anchor is not a handle.** It draws
             nothing and `continuityOf` reads the node as a corner, but the
             model still counts the segment as a curve: `segmentIsLine` is
             false, the export writes `C` rather than `L`, and Round cuts a
             curved side where the shape on screen has a straight one. Two
             identically drawn shapes otherwise differ for a reason invisible
             on the canvas and in the panel alike.

             A hand produces this. Snap-to-points drags a one-pixel drift back
             onto the node, so tapping the pen writes every control onto its
             own endpoint.

             `invisibleAt` rather than an arbitrary epsilon: below half a unit
             in the last exported place, a handle cannot change one character
             of the saved file, so it is not curvature by the only definition
             the rest of this program uses. §23. */
          if (Math.hypot(h[0] - n.pt[0], h[1] - n.pt[1]) <= invisibleAt(st.decimals)) {
            n.hOut = null;
            if (d.ref.i > 0 || sp.closed) n.hIn = null;
            return;
          }

          n.hOut = h;
          // The very first node of an open path has nothing arriving at it.
          if (d.ref.i > 0 || sp.closed) n.hIn = [2 * n.pt[0] - n.hOut[0], 2 * n.pt[1] - n.hOut[1]];
        });
        return;
      }
    }
  };

  private onUp = (e: PointerEvent): void => {
    /* A finger coming off a pinch ends the pinch and starts nothing. The one
       still down could be read as the beginning of a drag, but it is the middle
       of a gesture the person has not finished making, and drawing a line with
       it is not what they asked for. That falls out of the drag being abandoned
       when the second finger landed: there is nothing left for the rest of this
       to finish, so it runs and does nothing rather than being skipped. An
       early return here was tried and no test could tell it apart. */
    if (this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId);
      this.pinch = this.touches.size >= 2 ? this.spread() : null;
    }

    try {
      if (this.drag.kind === 'marquee' && this.extras.marquee) {
        const box: Box = this.extras.marquee;
        this.store.update((st) => {
          const inBox = (p: Pt): boolean =>
            p[0] >= box.x0 && p[0] <= box.x1 && p[1] >= box.y0 && p[1] <= box.y1;
          for (const shape of st.doc.shapes) {
            // A locked shape is not swept up either: a marquee is a press the
            // pointer never landed on it, and the answer has to be the same.
            if (isLocked(st.doc, st.locked, shape.id)) continue;
            if (isHidden(st.doc, shape.id)) continue;
            let caught = 0;
            let total = 0;
            for (const sp of shape.subpaths) {
              for (const node of sp.nodes) {
                total++;
                if (!inBox(node.pt)) continue;
                caught++;
                st.selection.nodes.add(node.id);
              }
            }
            /* A shape the box swallowed whole is selected as a shape, not only
               as a heap of its nodes -- otherwise Combine, Split and the
               booleans, which all read `selection.shapes`, refuse a selection
               that plainly holds two shapes. Reported from use.

               The old test was `shapeIsInBox(shape, box) && !selection.nodes
               .size`, which was wrong twice over: the node loop above had just
               made the second half false for this very shape, and
               `shapeIsInBox` asks whether ANY node is in the box, so without
               that accident it would have selected every shape the box merely
               grazed. Enclosure is counted here rather than asked of a helper
               whose name says "in" and whose body says "touches". */
            if (total > 0 && caught === total) st.selection.shapes.add(shape.id);
          }
        });
        this.extras.marquee = null;
      }

      /* A guide dropped off the canvas is removed, which is how every editor
         gets rid of one and the only gesture that does not need a second
         control. Measured against the stage rather than the window, so the
         rulers themselves count as off it: dragging a guide back where it came
         from is the obvious way to put it away. One dragged out of a ruler and
         released without ever reaching the canvas goes the same way, so a
         stray click on a ruler leaves nothing behind. */
      if (this.drag.kind === 'guide') {
        const d = this.drag;
        const r = this.canvas.overlay.getBoundingClientRect();
        const out =
          e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (out && d.born) {
          /* Dragged out of a ruler and dropped straight back. As far as the
             drawing is concerned this guide never existed, so the gesture is
             abandoned rather than reversed: removing it as an edit would leave
             an undo step that arrives where it already was. Same treatment as
             any other gesture that decides against itself. */
          if (this.store.batchDirty) this.store.rollback();
        } else {
          // `tryEdit` again, for the press on a guide that released without
          // moving it: settling a guide that is already settled is not an edit.
          this.store.tryEdit((st) => (out ? removeGuide(st.guides, d.i) : settleGuide(st.guides, d.i)));
          if (out) this.onMessage?.('Guide removed.', true);
        }
      }

      /* The live readout during a transform is a measurement, not an outcome.
         Restating it as a sentence on release is what turns the last thing on
         screen into a record of what was done. */
      /* A corner dragged to the limit of what its sides can hold is a corner
         that has ceased to exist: the arc's tangent points land on the
         neighbours, `roundCorner` reuses them, and the sides that defined the
         corner are used up. Nothing stores a radius (§48), so there is nothing
         left for `filletAt` to recover from and the control goes with it.
         Undo brings it back; without a word here, it looks like the control
         broke. */
      if (this.drag.kind === 'corner') {
        const d = this.drag;
        if (d.applied > 0 && d.applied >= d.max - 1e-9) {
          this.onMessage?.(
            `Rounded to r ${fmt(d.applied)}, which uses the sides up. No corner is left to adjust.`,
            true,
          );
        }
      }

      /* Read rather than rebuilt. Every frame recomputes the matrix against
         `d.saved`, the geometry as it was at the press, so the last one the move
         handler applied IS the whole gesture -- and it is the only one that went
         through the snap. Rebuilding it here from the pointer gave `Repeat` a
         matrix the document had never been transformed by.

         `applied` being null is a press on a grip that never moved. It leaves
         `lastTransform` alone, because a click is not a gesture and an identity
         matrix would destroy whatever `Repeat` was holding. */
      if (this.drag.kind === 'transform') {
        const d = this.drag;
        const a = d.moved ? d.applied : null;
        if (a) {
          const now = selectionBBox(this.store.state.doc, this.store.state.selection);
          if (d.mode === 'rotate') {
            this.onMessage?.(`Rotated ${fmt(a.deg ?? 0)}°.`, true);
          } else if (now) {
            this.onMessage?.(`Scaled to ${fmt(now.x1 - now.x0)} × ${fmt(now.y1 - now.y0)}.`, true);
          }
          this.remember(a.m, a.what);
        }
      }

      /* `applied` rather than the pointer: it is the total after snapping, so a
         repeat lands on the same lattice the drag did.

         `body` and not `anchor`: dragging a node moves each selected node
         through its own snap, so there is no one translation that describes the
         gesture. §62 of `docs/ARCHITECTURE.md` lists what counts as a
         transform. */
      if (this.drag.kind === 'body' && (this.drag.applied[0] || this.drag.applied[1])) {
        const d = this.drag;
        this.remember(translate(d.applied[0], d.applied[1]), `move ${fmt(d.applied[0])}, ${fmt(d.applied[1])}`);
      }

      /* In a `finally` because everything above runs listeners: the marquee's
         `update` notifies every subscriber, which touches forty DOM nodes and
         re-serialises the document. A throw anywhere in there would otherwise
         leave the batch open, and an open batch makes `checkpoint` return early
         for the rest of the session. The ending of a gesture is not allowed to
         depend on the rest of the application behaving. */
    } finally {
      // A create drag that never grew past nothing opened no batch, so there is
      // none to close -- and the document is untouched, as it should be.
      this.closeBatch();

      this.drag = { kind: 'none' };
      // The lines are true only while something is being held to them.
      this.extras.smart = [];
      if (this.canvas.overlay.hasPointerCapture(e.pointerId)) {
        this.canvas.overlay.releasePointerCapture(e.pointerId);
      }
      this.schedule();
    }
  };

  /**
   * Keep the matrix a gesture produced, so `Repeat` can apply it again.
   *
   * Written straight into the store rather than routed through `Commands`,
   * which the controller does not hold: the two are siblings, both given the
   * store, and threading one into the other to set one field would be a
   * dependency for the sake of a setter.
   *
   * `update` and not `edit`, because this is not a change to the document. That
   * is what keeps it out of the history entry, and it has to be: this runs
   * inside the gesture's batch, which `closeBatch` shuts in the `finally`
   * below, so an `edit` here would fold straight into it.
   */
  private remember(m: Mat, what: string): void {
    this.store.update((st) => (st.lastTransform = { m, what }));
  }

  /** Abandon the gesture, leaving the document as it was before the press. */
  abortDrag(): void {
    /* Read before closing: `endBatch` clears the flag. `batchOpen` alone is not
       enough any more -- a press that never moved opens a batch and takes no
       checkpoint, and rolling back on that would discard the edit before it. */
    const mine = this.batchOpen && this.store.batchDirty;
    this.closeBatch();
    if (mine) this.store.rollback();
    this.drag = { kind: 'none' };
    this.extras.marquee = null;
    this.extras.smart = [];
    this.schedule();
  }

  /** A release the overlay never saw. Finish the gesture rather than strand it. */
  private onStrayUp = (e: PointerEvent): void => {
    if (this.drag.kind === 'none') return;
    if (e.target instanceof Node && this.canvas.overlay.contains(e.target)) return;
    this.onUp(e);
  };

  /** Focus lost mid-gesture. Nothing more is coming, so abandon it. */
  private onStrayBlur = (): void => {
    if (this.drag.kind !== 'none') this.abortDrag();
  };

  private onCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    this.abortDrag();
    if (this.canvas.overlay.hasPointerCapture(e.pointerId)) {
      this.canvas.overlay.releasePointerCapture(e.pointerId);
    }
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const s = this.store.state;
    const p = this.pt(e);
    const hit = this.hitOf(e);

    // Double-clicking an anchor cycles its continuity. Each step is a real edit
    // to the handles, so the cycle is visible rather than a hidden mode change.
    if (hit?.kind === 'anchor' && hit.ref) {
      const ref = hit.ref;
      this.store.tryEdit((st) => {
        const sp = findShape(st.doc, ref.shape)?.subpaths[ref.sp];
        if (!sp?.nodes[ref.i]) return false;
        const order = ['cusp', 'smooth', 'symmetric'] as const;
        const cur = continuityOf(sp.nodes[ref.i]);
        return setContinuity(sp, ref.i, order[(order.indexOf(cur) + 1) % order.length]);
      });
      return;
    }

    // Double-clicking the outline inserts a node exactly where you clicked.
    const near = nearestOnPath(s.doc, p, 12 * this.canvas.scale(s.camera));
    if (near) {
      this.store.edit((st) => {
        const sp = findShape(st.doc, near.shape)?.subpaths[near.sp];
        if (!sp) return;
        const i = splitSegment(sp, near.seg, near.t);
        st.selection = emptySelection();
        st.selection.nodes.add(sp.nodes[i].id);
      });
    }
  };

  /**
   * Wheel, with the modifiers doing three different things.
   *
   * Every combination is bound, because a modifier that changes nothing reads
   * as broken rather than unassigned. Plain and Ctrl both zoom, since Ctrl+wheel
   * is the page-zoom gesture everywhere and doing anything else with it would
   * surprise. Shift and Alt pan along one axis each.
   */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const s = this.store.state;

    if (e.shiftKey || e.altKey) {
      // A trackpad reports sideways scrolling as deltaX, so take whichever axis
      // actually moved rather than assuming the wheel.
      const amount = (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * this.canvas.scale(s.camera);
      this.store.update((st) => {
        st.camera = {
          ...st.camera,
          x: st.camera.x + (e.shiftKey ? amount : 0),
          y: st.camera.y + (e.shiftKey ? 0 : amount),
        };
      });
      return;
    }

    const p = this.pt(e);
    const factor = Math.pow(1.0015, e.deltaY);
    this.store.update((st) => {
      st.camera = zoomAt(st.camera, factor, p);
    });
  };

  /* -------------------------------------------------------------- shapes */

  /**
   * Size a primitive from the drag so far.
   *
   * `shift` constrains to a square or circle by taking the smaller span, which
   * keeps the result on the grid whenever both spans already were. `alt` reads
   * the starting point as the centre rather than a corner.
   *
   * The shape is created on the first move that has any area, not on the press,
   * so a click that was meant for something else costs nothing.
   */
  private createDrag(p: Pt, shift: boolean, alt: boolean): void {
    if (this.drag.kind !== 'create') return;
    const d = this.drag;
    /* Point-snapping has to ignore the shape being drawn. Every other drag
       passes an `exclude`; this one did not, so the corner it had just placed
       sat within the snap threshold of the pointer and captured it -- the
       rectangle stopped following the cursor and resized in 8-pixel jumps. */
    const cur = this.snap(p, undefined, d.id ?? undefined);

    let dx = cur[0] - d.from[0];
    let dy = cur[1] - d.from[1];
    if (shift) {
      // Take the shorter span, but never collapse a shape that already exists:
      // dragging exactly along one axis for a moment would otherwise squash it
      // to a point, and with grid snapping on that is a common moment.
      const m = Math.min(Math.abs(dx), Math.abs(dy));
      if (m > 0 || !d.id) {
        dx = m * (dx < 0 ? -1 : 1);
        dy = m * (dy < 0 ? -1 : 1);
      }
    }
    const x = alt ? d.from[0] - dx : d.from[0];
    const y = alt ? d.from[1] - dy : d.from[1];
    const w = alt ? dx * 2 : dx;
    const h = alt ? dy * 2 : dy;

    /* No area, nothing to draw, and that holds after the shape exists too. Do
       not narrow this to `!d.id &&`: a drag that comes back to zero width would
       then rebuild the shape flat, and `onUp` would commit an invisible
       degenerate path. Skipping the rebuild leaves the last good size on screen,
       and the pointer can always grow it again. */
    if (Math.abs(w) < 1e-9 || Math.abs(h) < 1e-9) return;

    const poly = this.store.state.polygon;
    const build = (): Subpath =>
      d.tool === 'ellipse'
        ? ellipseSubpath(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2)
        : d.tool === 'poly'
          ? /* Inscribed in the drag's box, and signed radii rather than
               absolute: dragging up or left has to put the shape where the
               pointer is, and a polygon reflected through its centre is the
               same polygon, so nothing looks upside down. */
            polygonSubpath(
              x + w / 2,
              y + h / 2,
              w / 2,
              h / 2,
              poly.corners,
              poly.star ? poly.ratio : null,
            )
          : rectSubpath(x, y, w, h);

    if (!d.id) {
      this.openBatch();
      this.store.checkpoint();
      this.store.update((st) => {
        const shape = makeShape([build()], nextId(d.tool), st.style);
        st.doc.shapes.push(shape);
        st.selection = emptySelection();
        st.selection.shapes.add(shape.id);
        d.id = shape.id;
      });
      return;
    }

    const id = d.id;
    this.store.update((st) => {
      const shape = findShape(st.doc, id);
      if (shape) shape.subpaths = [build()];
    });
  }

  /** The subpath the pen is extending, or `null` if it no longer exists. */
  private penSubpath(): Subpath | null {
    if (!this.penTarget) return null;
    return findShape(this.store.state.doc, this.penTarget.shape)?.subpaths[this.penTarget.sp] ?? null;
  }

  /** A free end of some existing open path within grabbing distance of `p`. */
  private endNear(p: Pt): NodeRef | null {
    const s = this.store.state;
    const reach = 8 * this.canvas.scale(s.camera);
    let best = reach;
    let hit: NodeRef | null = null;
    for (const shape of s.doc.shapes) {
      shape.subpaths.forEach((sp, spI) => {
        if (sp.closed || sp.nodes.length < 1) return;
        for (const i of [0, sp.nodes.length - 1]) {
          const q = sp.nodes[i].pt;
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d < best) {
            best = d;
            hit = { shape: shape.id, sp: spI, i };
          }
        }
      });
    }
    return hit;
  }

  private penDown(p: Pt): void {
    const s = this.store.state;
    const snapped = this.snap(p);

    // `penTarget` is a shape id held across events, and the shape underneath it
    // can disappear: undo past its creation, Apply in the source box (which
    // replaces every shape), or deleting it with the select tool. Revalidate
    // before trusting it, or the next click reaches for a shape that is gone.
    let target = this.penSubpath();
    if (!target) this.penTarget = null;

    /* Pick up a path that was already finished. Without this the pen could only
       ever start something new, so a path put down and then let go of could
       never be extended again -- you could edit its nodes forever and never add
       one to the end. Clicking either end resumes from there, reversing the path
       when it was the start, since the pen always appends. */
    if (!this.penTarget) {
      const resume = this.endNear(p);
      if (resume) {
        this.openBatch();
        this.store.checkpoint();
        this.store.update((st) => {
          const sp = findShape(st.doc, resume.shape)?.subpaths[resume.sp];
          if (sp && resume.i === 0) reverseSubpath(sp);
        });
        this.penTarget = { shape: resume.shape, sp: resume.sp };
        target = this.penSubpath();
        if (target) {
          // Picking the path up is not placing a node. Clicking the end adopts
          // it and the NEXT click extends, which is what makes the gesture read
          // as "carry on from here" rather than "stamp another node on top".
          const i = target.nodes.length - 1;
          const last = target.nodes[i];
          this.drag = { kind: 'pen', ref: { shape: resume.shape, sp: resume.sp, i } };
          this.extras.penFrom = last.pt;
          this.store.update((st) => {
            st.selection = emptySelection();
            st.selection.nodes.add(last.id);
          });
          return;
        }
      }
    }

    // Clicking the first node of the subpath being drawn closes it.
    if (this.penTarget && target && target.nodes.length >= 2) {
      const first = target.nodes[0].pt;
      if (Math.hypot(first[0] - p[0], first[1] - p[1]) < 8 * this.canvas.scale(s.camera)) {
        const ref = this.penTarget;
        this.store.edit((st) => {
          const sp = findShape(st.doc, ref.shape)?.subpaths[ref.sp];
          if (sp) closeSubpath(sp);
        });
        this.finishPen();
        return;
      }
    }

    this.openBatch();
    this.store.checkpoint();

    if (!this.penTarget) {
      this.store.update((st) => {
        const shape = makeShape([{ nodes: [makeNode(snapped)], closed: false }], undefined, st.style);
        st.doc.shapes.push(shape);
        this.penTarget = { shape: shape.id, sp: 0 };
      });
    } else {
      const ref = this.penTarget;
      this.store.update((st) => {
        const sp = findShape(st.doc, ref.shape)?.subpaths[ref.sp];
        sp?.nodes.push(makeNode(snapped));
      });
    }

    target = this.penSubpath();
    if (!this.penTarget || !target) {
      // Could not establish a subpath to draw into; leave no half-open batch.
      this.closeBatch();
      this.finishPen();
      return;
    }

    this.drag = {
      kind: 'pen',
      ref: { shape: this.penTarget.shape, sp: this.penTarget.sp, i: target.nodes.length - 1 },
    };
    this.extras.penFrom = snapped;
  }

  /**
   * Stop drawing, discarding anything too small to be a path.
   *
   * A single pen click that is never followed up leaves a one-node subpath.
   * It draws nothing -- `serialisePath` skips it -- but it still puts an anchor
   * on the canvas with no geometry attached and inflates the node count, which
   * reads as a rendering fault rather than an empty shape.
   */
  finishPen(): void {
    const drawn = this.penTarget?.shape ?? null;
    this.penTarget = null;
    this.extras.penFrom = null;
    this.extras.penTo = null;

    if (drawn) this.pruneDegenerate(drawn);
    this.schedule();
  }

  /**
   * Drop the pen's own stub: a subpath of fewer than two nodes, and the shape if
   * that was all it had.
   *
   * Scoped to the shape the pen was drawing, and it must stay that way. A sweep
   * of the whole document would also take one-node subpaths that arrived by
   * import or by Apply, and with no checkpoint of their own, the only undo that
   * brings one back also undoes the drawing. Same rule as `deleteSelection`:
   * prune what this operation touched, nothing else.
   */
  private pruneDegenerate(shapeId: string): void {
    const shape = findShape(this.store.state.doc, shapeId);
    if (!shape) return;
    const needed = shape.subpaths.some((sp) => sp.nodes.length < 2) || shape.subpaths.length === 0;
    if (!needed) return;

    this.store.update((st) => {
      const sh = findShape(st.doc, shapeId);
      if (sh) sh.subpaths = sh.subpaths.filter((sp) => sp.nodes.length >= 2);
      st.doc.shapes = st.doc.shapes.filter((s2) => s2.subpaths.length > 0);
      /* A dropped node's id resolves to nothing, so nothing downstream can act
         on the wrong node -- but `selection.nodes.size` is read directly as
         "how many are selected", and a ghost would be counted. Swept here
         rather than on every edit: this is where nodes disappear without the
         caller replacing the selection outright. */
      const live = new Set<string>();
      for (const sh2 of st.doc.shapes) {
        for (const sp of sh2.subpaths) for (const n of sp.nodes) live.add(n.id);
      }
      for (const id of [...st.selection.nodes]) {
        if (!live.has(id)) st.selection.nodes.delete(id);
      }
      for (const id of [...st.selection.shapes]) {
        if (!findShape(st.doc, id)) st.selection.shapes.delete(id);
      }
    });
  }
}

export type { HandlePart };
