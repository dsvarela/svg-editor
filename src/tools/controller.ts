/**
 * Pointer and keyboard interaction.
 *
 * All drags follow one shape: capture the pointer, open a history batch on
 * down, mutate on move, close the batch on up. That is what makes a drag a
 * single undo step regardless of how many pointermove events it produced.
 */

import { about, rotate as rotMat, translate } from '../core/affine';
import type { Box } from '../core/bezier';
import { continuityOf, makeNode, segmentCount } from '../core/types';
import type { NodeContinuity, PathNode, Pt, Shape, Style, Subpath } from '../core/types';
import {
  docBBox,
  emptySelection,
  findShape,
  makeShape,
  nextId,
  nodeKey,
  parseNodeKey,
  selectedShapes,
  selectionBBox,
  shapeBBox,
} from '../model/doc';
import type { HandlePart, NodeRef } from '../model/doc';
import {
  alignNodes,
  breakAt,
  captureNodes,
  circulariseSubpath,
  closeSubpath,
  deleteNode,
  deleteNodesSplitting,
  distributeNodes,
  connectEnds,
  fuseDegenerate,
  fuseNodes,
  isPathEnd,
  mergeEnds,
  latentHandle,
  moveAnchor,
  moveHandle,
  nearestOnPath,
  reverseSubpath,
  roundCorner,
  setContinuity,
  reshapeSegment,
  setSegmentBend,
  segmentBend,
  setSegmentCurved,
  snap as snapTo,
  splitSegment,
  transformCaptured,
  transformShape,
} from '../model/ops';
import type { AlignMode, FuseRefusal, NodeSnapshot, RoundRefusal } from '../model/ops';
import { simplifySubpath } from '../model/simplify';
import { invisibleAt, keepOnly, reduceToCount, removeRedundantNodes } from '../model/knots';
import { phaseInForce, phaseLabel, phaseOf } from '../model/pixelfit';
import { resolveSnap } from '../model/snapping';
import { keylineGuides } from '../model/keylines';
import { alignmentsFor, shiftBox } from '../model/smart';
import { canBeAuto, reflowDoc, setAuto } from '../model/auto';
import { offsetSubpath, strokeOutline } from '../core/offset';
import { rayAngles } from '../model/angles';
import type { AngleSetup } from '../model/angles';
import { addGuide, moveGuide, removeGuide, settleGuide } from '../model/guides';
import type { Guide, GuideAxis } from '../model/guides';
import type { SnapResult } from '../model/snapping';
import { traceImage } from '../model/trace';
import type { Placement, TraceOptions, TraceResult } from '../model/trace';
import type { RasterLike } from '../core/raster';
import { boxCentre, handlePoint, rotateMatrix, scaleMatrix } from '../model/transform';
import type { TransformPart } from '../model/transform';
import { ellipseSubpath, rectSubpath } from '../core/primitives';
import { BOOLEAN_LABEL, booleanShapes } from '../io/boolean';
import type { BooleanOp } from '../io/boolean';
import type { EditorState, Store } from '../model/store';
import type { Canvas, OverlayExtras } from '../view/canvas';
import { shapeIsInBox } from '../view/canvas';
import { bendFromPoint } from '../core/bend';
import type { Bend } from '../core/bend';
import { fitAspect, screenToDoc, zoomAt } from '../view/viewport';

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
  | { kind: 'create'; tool: 'ellipse' | 'rect'; from: Pt; id: string | null }
  /* `free` picks the edit: the two-number symmetric bend, or moving the point
     under the pointer with both handles. Frozen at the press, like
     `looseness`. */
  | { kind: 'bend'; shape: string; sp: number; seg: number; looseness: number; free: boolean }
  /* Placing or moving a guide. `born` marks one dragged out of a ruler, which
     is removed rather than left behind if the drag ends where it started --
     otherwise a stray click on a ruler would litter the canvas. */
  | { kind: 'guide'; i: number; axis: GuideAxis; born: boolean };

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
  | { kind: 'box'; w: number; h: number };

/** One decimal at most, and no trailing zero to make an angle look measured. */
const fmt = (v: number): string => (+v.toFixed(1)).toString();

/**
 * A scale factor as a percentage. Whole numbers only: a readout that flickers
 * through 99.7, 100.2, 99.9 while the pointer sits still is harder to read than
 * one that says 100.
 */
const pct = (k: number): string => `${Math.round(k * 100)} %`;

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
   * `onUp` used to work this out by inspecting the drag it found, which is a
   * different question and gave a different answer whenever the drag had been
   * replaced or had changed shape mid-gesture. An unclosed batch disables
   * checkpointing permanently and says nothing, so the fact is recorded when it
   * happens rather than reconstructed afterwards.
   */
  private batchOpen = false;
  private extras: OverlayExtras = {};
  private frame = 0;
  /** Subpath the pen tool is currently extending. */
  private penTarget: { shape: string; sp: number } | null = null;
  private spaceDown = false;

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

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
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
   * **A drawing tool asks the pending style, not the selection.** That one line
   * is the whole fix for a defect worth stating: `phaseInForce` prefers what is
   * selected, and a create drag *replaces the selection with the shape it just
   * made*. So drawing a rectangle while an unstroked shape happened to be
   * selected snapped the first corner on that shape's lattice and every later
   * corner on the new shape's, giving a rectangle 20.5 units wide -- two edges
   * on whole pixels and two not, the exact failure §25 exists to prevent. The
   * drawn grid moved with it, leaving the committed corner on no gridline.
   *
   * Asking the pending style makes the answer constant for the length of the
   * gesture, because a tool that is drawing is asking about a shape that does
   * not exist yet and the pending style is the only honest description of it.
   *
   * **There is deliberately no freeze-at-the-press.** One was written first, on
   * the transform box's principle of capturing at the press. Then it was
   * measured: with the rule above in place, removing the freeze changed nothing
   * on any test, because nothing else moves the phase mid-gesture -- a node drag
   * does not alter the selection, and shape and backdrop drags snap a
   * displacement, which is phase-invariant. Keeping a guard that cannot be shown
   * to do anything is the habit this project keeps catching itself in.
   */
  phase(): number {
    const s = this.store.state;
    if (!s.pixelFit) return 0;
    const creating = s.tool === 'pen' || s.tool === 'ellipse' || s.tool === 'rect';
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

  /** The same, keeping which tier answered, for the status line. */
  /**
   * The guides worth aiming at, which never includes the one being dragged.
   *
   * A guide lies on itself at distance zero, so without the exclusion the first
   * move would pin it where it already is and it could never be moved again --
   * the same trap boundary snapping hit with the segments either side of a
   * dragged node, arriving from a different direction.
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

  /**
   * `Store.edit`, with the auto-smooth sweep on the way out.
   *
   * One choke point rather than a call at each site that could invalidate an
   * auto node. Moving one, deleting one, inserting one, reversing a path,
   * fusing two, applying a boolean: every one of them disturbs a neighbour, and
   * each would otherwise have to work out which indices it touched. Getting
   * that wrong leaves a stale handle, which reads as a rendering bug rather
   * than as a missed call.
   *
   * The sweep is one pass over nodes that are about to be walked to redraw
   * anyway, and it skips every node in one comparison.
   */
  private edit(fn: (st: EditorState) => void): void {
    this.store.edit((st) => {
      fn(st);
      reflowDoc(st.doc);
    });
  }

  /** The same for `tryEdit`, which reports whether it changed anything. */
  private tryEdit(fn: (st: EditorState) => boolean): boolean {
    return this.store.tryEdit((st) => {
      const changed = fn(st);
      if (changed) reflowDoc(st.doc);
      return changed;
    });
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

  private selectedNodeRefs(): NodeRef[] {
    const s = this.store.state;
    const refs = [...s.selection.nodes].map(parseNodeKey);
    // A whole-shape selection implies all of its nodes for a drag.
    for (const id of s.selection.shapes) {
      const shape = findShape(s.doc, id);
      shape?.subpaths.forEach((sp, spI) =>
        sp.nodes.forEach((_, i) => refs.push({ shape: id, sp: spI, i })),
      );
    }
    const seen = new Set<string>();
    return refs.filter((r) => {
      const k = nodeKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
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
      const made = this.tryEdit((st) => {
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

  /** Place a guide by number, which is the keyboard-and-button route. */
  addGuideAt(axis: GuideAxis, at: number): boolean {
    const ok = this.tryEdit((st) => {
      const made = addGuide(st.guides, { axis, at });
      if (made) st.showGuides = true;
      return made;
    });
    this.onMessage?.(
      ok
        ? `Guide at ${axis} = ${fmt(at)}.`
        : `There is already a guide at ${axis} = ${fmt(at)}.`,
      ok,
    );
    return ok;
  }

  /**
   * Make the selected nodes auto-smooth, or hand control back if they are.
   *
   * A toggle rather than a fourth setting beside corner, smooth and symmetric,
   * because it is not the same kind of thing: those three are readings of the
   * handles and this is an instruction about them. Pressing it on nodes that
   * already have it leaves the handles exactly where they are and stops them
   * moving on their own.
   */
  setSelectedAuto(): boolean {
    const refs = this.selectedNodeRefs();
    if (!refs.length) {
      this.onMessage?.('Select a node first.', false);
      return false;
    }
    /* Off only when every selected node is already auto. With a mixed
       selection the useful reading of one press is "make them all auto", not
       "toggle each of them and leave me with the opposite mixture". */
    const allAuto = refs.every(
      (r) => findShape(this.store.state.doc, r.shape)?.subpaths[r.sp]?.nodes[r.i]?.auto === true,
    );

    let changed = 0;
    let atEnd = 0;
    const ok = this.tryEdit((st) => {
      for (const r of refs) {
        const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
        if (!sp?.nodes[r.i]) continue;
        if (!allAuto && !canBeAuto(sp, r.i)) {
          atEnd++;
          continue;
        }
        if (setAuto(sp, r.i, !allAuto)) changed++;
      }
      return changed > 0;
    });

    if (ok) {
      this.onMessage?.(
        allAuto
          ? `${changed} ${changed === 1 ? 'node stops' : 'nodes stop'} re-deriving.`
          : `${changed} ${changed === 1 ? 'node takes' : 'nodes take'} their handles from the neighbours.`,
        true,
      );
    } else if (atEnd) {
      this.onMessage?.(
        'That node ends the path. There is no neighbour on the far side to take a direction from.',
        false,
      );
    } else {
      this.onMessage?.('Nothing changed.', false);
    }
    return ok;
  }

  /**
   * Draw a path parallel to each selected shape, at a distance.
   *
   * A new shape rather than a change to the old one: the original is almost
   * always still wanted -- an outline and its offset are a pair -- and an
   * operation that consumes its input to produce a near-copy is one undo away
   * from being useless and one step away from being a duplicate.
   */
  offsetSelection(d: number): boolean {
    const shapes = selectedShapes(this.store.state.doc, this.store.state.selection);
    if (!shapes.length) {
      this.onMessage?.('Select a shape to offset.', false);
      return false;
    }
    if (!Number.isFinite(d) || d === 0) {
      this.onMessage?.('Offset by how far? Zero is the shape you already have.', false);
      return false;
    }

    const made: string[] = [];
    let refused = 0;
    const ok = this.tryEdit((st) => {
      for (const shape of shapes) {
        const live = findShape(st.doc, shape.id);
        if (!live) continue;
        /* Tolerance from the document's own precision: an offset fitted finer
           than the serialiser will write is work nobody can see. */
        const tol = Math.max(invisibleAt(st.decimals), 0.01);
        /* Flattened, because one subpath can offset into several: an inward
           offset of a notched shape comes apart into pieces, and each is a
           path of the same shape. */
        const subpaths = live.subpaths.flatMap((sp) => offsetSubpath(sp, d, tol) ?? []);
        if (!subpaths.length) {
          refused++;
          continue;
        }
        const next = makeShape(subpaths, `${live.name} offset`, live.style);
        st.doc.shapes.push(next);
        made.push(next.id);
      }
      if (!made.length) return false;
      st.selection = emptySelection();
      for (const id of made) st.selection.shapes.add(id);
      return true;
    });

    if (ok) {
      this.onMessage?.(
        `Offset ${made.length} ${made.length === 1 ? 'shape' : 'shapes'} by ${fmt(d)}.` +
          (refused ? ` ${refused} had no direction to offset along.` : ''),
        true,
      );
    } else {
      this.onMessage?.('Nothing there could be offset.', false);
    }
    return ok;
  }

  /**
   * Turn the selected shapes' strokes into filled outlines.
   *
   * The width comes from each shape's own style, because that is what is being
   * converted -- asking for a number would let you convert a 1-unit stroke into
   * a 4-unit outline and call it the same drawing.
   *
   * The result replaces the original and is filled with what the stroke was
   * coloured, since the outline *is* the stroke. A shape with no stroke has
   * nothing to convert and is refused rather than silently skipped.
   */
  strokeToPath(cap: 'butt' | 'round' = 'butt'): boolean {
    const shapes = selectedShapes(this.store.state.doc, this.store.state.selection);
    if (!shapes.length) {
      this.onMessage?.('Select a shape to outline.', false);
      return false;
    }

    let done = 0;
    let noStroke = 0;
    let refused = 0;
    const ok = this.tryEdit((st) => {
      for (const shape of shapes) {
        const live = findShape(st.doc, shape.id);
        if (!live) continue;
        if (live.style.stroke === 'none' || !(live.style.strokeWidth > 0)) {
          noStroke++;
          continue;
        }
        const tol = Math.max(invisibleAt(st.decimals), 0.01);
        const subpaths = live.subpaths.flatMap(
          (sp) => strokeOutline(sp, live.style.strokeWidth, cap, tol) ?? [],
        );
        if (!subpaths.length) {
          refused++;
          continue;
        }
        live.subpaths = subpaths;
        /* The outline is the stroke, so it is filled with the stroke's colour
           and stops being stroked itself. `evenodd` is what makes a closed
           path's two contours read as a band rather than a filled disc. */
        live.style = {
          ...live.style,
          fill: live.style.stroke,
          stroke: 'none',
          fillRule: 'evenodd',
        };
        done++;
      }
      return done > 0;
    });

    if (ok) {
      this.onMessage?.(
        `Outlined ${done} ${done === 1 ? 'shape' : 'shapes'}.` +
          (noStroke ? ` ${noStroke} had no stroke to outline.` : '') +
          (refused ? ` ${refused} came apart and were left alone.` : ''),
        true,
      );
    } else if (noStroke) {
      this.onMessage?.('That shape has no stroke to turn into a path.', false);
    } else {
      this.onMessage?.('That outline comes apart; nothing was changed.', false);
    }
    return ok;
  }

  /**
   * Step the node selection along the path.
   *
   * The gap the keyboard survey could not see. Every control in the Node panel
   * is reachable by Tab and every one of them acts on the selected nodes -- and
   * until now the only way to select a node was to click it, so the whole panel
   * was pointer-only however tabbable its buttons were.
   *
   * With a shape selected and no nodes, it takes the first. With one node it
   * moves. `extend` adds instead of replacing, which is how you get the two
   * adjacent nodes that Insert node and Fuse want.
   */
  stepNodeSelection(by: 1 | -1, extend = false): boolean {
    const s = this.store.state;
    const refs = this.selectedNodeRefs();

    // Nothing chosen yet: start at the first node of the first selected shape.
    if (!refs.length) {
      const id = [...s.selection.shapes][0];
      const sp = id ? findShape(s.doc, id)?.subpaths[0] : null;
      if (!id || !sp?.nodes.length) {
        this.onMessage?.('Select a shape or a node first.', false);
        return false;
      }
      this.store.update((st) => {
        st.selection.nodes.clear();
        st.selection.nodes.add(nodeKey({ shape: id, sp: 0, i: by > 0 ? 0 : sp.nodes.length - 1 }));
      });
      return true;
    }

    /* From the last one added, which is the one a run of presses is walking.
       Taking the lowest index instead would make Shift-extend collapse back on
       itself the moment the run passed a node with a smaller index. */
    const from = refs[refs.length - 1];
    const sp = findShape(s.doc, from.shape)?.subpaths[from.sp];
    if (!sp?.nodes.length) return false;

    const n = sp.nodes.length;
    /* Wrapping on a closed path and stopping at the ends of an open one, which
       is what the path itself does: there is no node past the end of an open
       path to step to. */
    let next = from.i + by;
    if (sp.closed) next = (next + n) % n;
    else if (next < 0 || next >= n) {
      this.onMessage?.(`That is the ${by > 0 ? 'last' : 'first'} node of the path.`, false);
      return false;
    }

    const key = nodeKey({ shape: from.shape, sp: from.sp, i: next });
    this.store.update((st) => {
      if (!extend) st.selection.nodes.clear();
      // Re-adding moves it to the end of the set, so a run of presses keeps
      // walking from where it just arrived rather than from where it started.
      st.selection.nodes.delete(key);
      st.selection.nodes.add(key);
      st.selection.shapes.clear();
    });
    return true;
  }

  /**
   * Insert a node in the middle of the selected segment.
   *
   * Double-clicking the outline already does this and needs a pointer to aim.
   * Two adjacent selected nodes name a segment exactly, so this is the same
   * operation with the keyboard's way of saying where.
   */
  insertInSelection(): boolean {
    const refs = this.selectedNodeRefs();
    if (refs.length !== 2 || refs[0].shape !== refs[1].shape || refs[0].sp !== refs[1].sp) {
      this.onMessage?.('Select the two nodes either side of a segment.', false);
      return false;
    }
    const s = this.store.state;
    const sp = findShape(s.doc, refs[0].shape)?.subpaths[refs[0].sp];
    if (!sp) return false;

    const n = sp.nodes.length;
    const a = Math.min(refs[0].i, refs[1].i);
    const b = Math.max(refs[0].i, refs[1].i);
    /* Adjacent, or the pair that wraps: on a closed path the last node and the
       first are neighbours too, and that segment has as much right to a node
       as any other. */
    const seg = b - a === 1 ? a : sp.closed && a === 0 && b === n - 1 ? n - 1 : -1;
    if (seg < 0) {
      this.onMessage?.('Those two nodes are not the ends of one segment.', false);
      return false;
    }

    let at = -1;
    const ok = this.tryEdit((st) => {
      const live = findShape(st.doc, refs[0].shape)?.subpaths[refs[0].sp];
      if (!live) return false;
      at = splitSegment(live, seg, 0.5);
      if (at < 0) return false;
      st.selection.nodes.clear();
      st.selection.nodes.add(nodeKey({ shape: refs[0].shape, sp: refs[0].sp, i: at }));
      return true;
    });
    this.onMessage?.(ok ? 'Node inserted, and the curve is unchanged.' : 'Nothing to insert into.', ok);
    return ok;
  }

  /**
   * Pin the rays to the middle of the selection, or report that there is none.
   *
   * Not an edit: where the rays come from is a property of how you are working,
   * not of the drawing, so it records no undo step -- the same reasoning that
   * keeps the grid step and the style-for-new-shapes out of the history.
   */
  setAngleOrigin(): boolean {
    const s = this.store.state;
    const box = selectionBBox(s.doc, s.selection);
    if (!box) {
      this.onMessage?.('Select something to put the origin on.', false);
      return false;
    }
    const at: Pt = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
    this.store.update((st) => {
      st.angleOrigin = [at[0], at[1]];
      st.snapToAngles = true;
    });
    this.onMessage?.(`Angles from ${fmt(at[0])}, ${fmt(at[1])}.`, true);
    return true;
  }

  /** Back to radiating from wherever the gesture starts. */
  clearAngleOrigin(): void {
    this.store.update((st) => (st.angleOrigin = null));
    this.onMessage?.('Angles from wherever a gesture starts.', true);
  }

  /** Remove every guide, in one undo step. */
  clearGuides(): boolean {
    const n = this.store.state.guides.length;
    const ok = this.tryEdit((st) => {
      st.guides = [];
      return n > 0;
    });
    if (ok) this.onMessage?.(`Removed ${n} ${n === 1 ? 'guide' : 'guides'}.`, true);
    return ok;
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

  /* -------------------------------------------------------------- pointer */

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
   * Both at once, because they are one gesture: spreading the fingers zooms in
   * about the point between them, and moving that point drags the drawing with
   * it. Doing only the zoom would pin the view to wherever the pinch started,
   * which on a screen the size of a hand is most of the way to unusable.
   *
   * The order matters. The zoom is taken about the document point under the old
   * midpoint, which leaves that point exactly where it was on screen; the pan
   * afterwards is then a screen distance in the new scale. Zooming about the
   * new midpoint instead would move the drawing twice.
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
    // A second press while a drag is live used to overwrite `this.drag`, and
    // since the matching `onUp` decided whether to close the batch by looking
    // at whatever drag it found, the first one's batch was never closed --
    // after which `checkpoint()` returns early forever and no undo point is
    // ever recorded again, with nothing on screen to say so. Two fingers on a
    // touchscreen were enough. One drag at a time.
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

    if (s.tool === 'ellipse' || s.tool === 'rect') {
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
          saved: captureNodes(s.doc, this.selectedNodeRefs()),
          // For a scale, the pointer is a few pixels outside the corner it is
          // about to drag, because that is where the handle is drawn. Recording
          // the difference is what stops the selection twitching on the first
          // move. A rotation measures an angle from wherever the press landed,
          // so it wants the raw point.
          grab: hit.kind === 'rotate' ? p : [p[0] - at[0], p[1] - at[1]],
        };
        return;
      }
    }

    if (hit?.kind === 'anchor' && hit.ref) {
      const key = nodeKey(hit.ref);
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
        refs: this.selectedNodeRefs(),
        grabbed: hit.ref,
        offset: [p[0] - node.pt[0], p[1] - node.pt[1]],
        start: [node.pt[0], node.pt[1]],
      };
      return;
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
      const selectedHere = [...s.selection.nodes].filter((k) => parseNodeKey(k).shape === id).length;
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
      const refs = this.selectedNodeRefs().filter((r) => !shapes.includes(r.shape));
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
        this.edit((st) => {
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
        this.edit((st) => {
          const sp = findShape(st.doc, d.ref.shape)?.subpaths[d.ref.sp];
          // The node index matters as much as the subpath: an undo mid-drag can
          // shorten the path under us, and `moveHandle` would dereference it.
          if (!sp?.nodes[d.ref.i]) return;
          /* Taking hold of a handle takes control back. An auto node would
             otherwise recompute the handle away on the very next sweep, so the
             drag would do nothing and there would be nothing on screen to say
             why -- and the sweep runs at the end of this same edit. */
          delete sp.nodes[d.ref.i].auto;
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
          this.onMessage?.(`Scale ${pct(m[0])} × ${pct(m[3])}`, true);
        }
        this.edit((st) => transformCaptured(st.doc, d.saved, m));
        return;
      }

      case 'guide': {
        const d = this.drag;
        // Snapped like anything else being placed, and against everything --
        // lining a guide up with a node is most of why you would place one.
        const at = this.snapWith(p, undefined, undefined, d.i).pt;
        this.edit((st) => {
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
        this.edit((st) => {
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
           Snapping each node's own position would drag every off-lattice node
           onto the grid and destroy the shape's proportions -- which is why
           moving a shape ignored the grid entirely until now. Rounding the
           total displacement instead keeps every relative offset exactly, and
           has the property worth having: a shape whose nodes start on the grid
           ends on it, and one that starts off it stays off it by the same
           amount. Tracked from the press rather than accumulated per move, so
           the rounding cannot drift over a long drag. */
        const s2 = this.store.state;
        const raw: Pt = [p[0] - d.from[0], p[1] - d.from[1]];
        const grid: Pt = s2.snapToGrid && s2.gridStep > 0 ? snapTo(raw, s2.gridStep) : raw;

        /* Alignment beats the lattice on whichever axis it found something,
           and leaves the other axis to the grid. Same reasoning as the snap
           tiers: a line you can see beats a lattice you cannot, and here you
           can literally see it, because holding the alignment is what draws
           it. Computed from the raw translation rather than the snapped one,
           so the grid does not first pull the box off the edge it was about
           to meet. */
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
        this.edit((st) => {
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

      case 'bend': {
        const d = this.drag;
        this.edit((st) => {
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
        this.edit((st) => {
          const sp = findShape(st.doc, d.ref.shape)?.subpaths[d.ref.sp];
          const n = sp?.nodes[d.ref.i];
          if (!sp || !n) return;
          // Dragging away from a freshly placed node pulls out its handles.
          // Mirroring the two makes the node symmetric by construction -- there
          // is nothing to declare, the geometry says it.
          n.hOut = this.snap(p, d.ref);
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
          for (const shape of st.doc.shapes) {
            shape.subpaths.forEach((sp, spI) => {
              sp.nodes.forEach((n, i) => {
                if (n.pt[0] >= box.x0 && n.pt[0] <= box.x1 && n.pt[1] >= box.y0 && n.pt[1] <= box.y1) {
                  st.selection.nodes.add(nodeKey({ shape: shape.id, sp: spI, i }));
                }
              });
            });
            if (shapeIsInBox(shape, box) && st.selection.nodes.size === 0) {
              st.selection.shapes.add(shape.id);
            }
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
          this.tryEdit((st) => (out ? removeGuide(st.guides, d.i) : settleGuide(st.guides, d.i)));
          if (out) this.onMessage?.('Guide removed.', true);
        }
      }

      /* The live readout during a transform is a measurement, not an outcome.
         Restating it as a sentence on release is what turns the last thing on
         screen into a record of what was done. */
      if (this.drag.kind === 'transform') {
        const d = this.drag;
        const now = selectionBBox(this.store.state.doc, this.store.state.selection);
        if (d.mode === 'rotate') {
          const r = rotateMatrix(boxCentre(d.box), d.grab, this.pt(e), this.shift(e) ? 15 : 0);
          this.onMessage?.(`Rotated ${fmt(r.deg)}°.`, true);
        } else if (now) {
          this.onMessage?.(
            `Scaled to ${fmt(now.x1 - now.x0)} × ${fmt(now.y1 - now.y0)}.`,
            true,
          );
        }
      }

      /* In a `finally` because everything above runs listeners: the marquee's
         `update` notifies every subscriber, which touches forty DOM nodes and
         re-serialises the document. A throw anywhere in there used to leave the
         batch open, and an open batch makes `checkpoint` return early for the rest
         of the session. The ending of a gesture is not allowed to depend on the
         rest of the application behaving. */
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

  /** Abandon the gesture, leaving the document as it was before the press. */
  private abortDrag(): void {
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
      this.tryEdit((st) => {
        const sp = findShape(st.doc, ref.shape)?.subpaths[ref.sp];
        if (!sp?.nodes[ref.i]) return false;
        const order = ['corner', 'smooth', 'symmetric'] as const;
        const cur = continuityOf(sp.nodes[ref.i]);
        return setContinuity(sp, ref.i, order[(order.indexOf(cur) + 1) % order.length]);
      });
      return;
    }

    // Double-clicking the outline inserts a node exactly where you clicked.
    const near = nearestOnPath(s.doc, p, 12 * this.canvas.scale(s.camera));
    if (near) {
      this.edit((st) => {
        const sp = findShape(st.doc, near.shape)?.subpaths[near.sp];
        if (!sp) return;
        const i = splitSegment(sp, near.seg, near.t);
        st.selection = emptySelection();
        st.selection.nodes.add(nodeKey({ shape: near.shape, sp: near.sp, i }));
      });
    }
  };

  /**
   * Wheel, with the modifiers doing three different things.
   *
   * All four combinations used to zoom, because none of them was bound: holding
   * Shift, Ctrl or Alt changed nothing, which reads as the modifiers being
   * broken rather than unassigned. Plain and Ctrl both zoom, since Ctrl+wheel is
   * the page-zoom gesture everywhere and doing anything else with it would
   * surprise; Shift and Alt pan along one axis each.
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

    /* No area, nothing to draw -- and that holds after the shape exists too.
       The guard used to be `!d.id &&`, so a drag that came back to zero width
       rebuilt the shape flat and `onUp` committed an invisible degenerate path.
       Skipping the rebuild leaves the last good size on screen; the pointer can
       always grow it again. */
    if (Math.abs(w) < 1e-9 || Math.abs(h) < 1e-9) return;

    const radius = this.store.state.cornerRadius;
    const build = (): Subpath =>
      d.tool === 'ellipse'
        ? ellipseSubpath(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2)
        : rectSubpath(x, y, w, h, radius);

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

  /**
   * Which subpaths a whole-subpath operation should act on.
   *
   * Selecting one node of a contour selects that contour for these purposes.
   * Anything else would need an answer to "what happens to the segments joining
   * the part you changed to the part you did not", and there is no good one.
   */
  private selectedSubpaths(): Map<string, Set<number>> {
    const s = this.store.state;
    const targets = new Map<string, Set<number>>();
    const add = (shape: string, sp: number): void => {
      const set = targets.get(shape) ?? new Set<number>();
      set.add(sp);
      targets.set(shape, set);
    };
    for (const key of s.selection.nodes) {
      const r = parseNodeKey(key);
      add(r.shape, r.sp);
    }
    for (const id of s.selection.shapes) {
      findShape(s.doc, id)?.subpaths.forEach((_, i) => add(id, i));
    }
    return targets;
  }

  /**
   * Force the selected subpaths onto their own best-fit circles.
   *
   * Whole subpaths rather than loose nodes: circularising some of a path's
   * nodes would leave the segments joining them to the rest built from a circle
   * they are not on, which is a worse drawing than either choice on its own.
   */
  circulariseSelection(): boolean {
    const s = this.store.state;
    const targets = this.selectedSubpaths();

    let eligible = 0;
    let tooFew = 0;
    for (const [id, sps] of targets) {
      const shape = findShape(s.doc, id);
      for (const i of sps) {
        const sp = shape?.subpaths[i];
        if (!sp) continue;
        if (sp.nodes.length >= 3) eligible++;
        else tooFew++;
      }
    }

    if (!eligible) {
      this.onMessage?.(
        targets.size
          ? 'Circularise needs a path of three or more nodes.'
          : 'Select a shape, or some of its nodes, first.',
        false,
      );
      return false;
    }

    let done = 0;
    let flat = 0;
    let moved = 0;
    let radius = 0;
    let widest = 0;
    let fused = 0;
    this.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (!sp || sp.nodes.length < 3) continue;
          const r = circulariseSubpath(sp);
          if (!r) {
            flat++;
            continue;
          }
          done++;
          moved = Math.max(moved, r.moved);
          radius = r.radius;
          widest = Math.max(widest, r.widestSpan);
          fused += r.fused;
        }
      }
      return done > 0;
    });

    if (!done) {
      this.onMessage?.(
        'Those nodes do not determine a circle. They are collinear, or they do not go ' +
          'round in order.',
        false,
      );
      return false;
    }

    const dp = (v: number): string => (+v.toFixed(3)).toString();
    const extra = [
      tooFew ? `${tooFew} too small` : '',
      flat ? `${flat} not a ring` : '',
    ].filter(Boolean);
    // A cubic's radial error climbs steeply with the arc it covers, so a wide
    // gap is the ceiling on the result and the user should hear about it rather
    // than wonder why one side looks flat.
    const wideDeg = Math.round((widest * 180) / Math.PI);
    this.onMessage?.(
      `Circularised ${done} path${done === 1 ? '' : 's'} onto r ${dp(radius)}${
        done > 1 ? ' (the last one)' : ''
      }. Furthest node moved ${dp(moved)}.` +
        (extra.length ? ` Skipped ${extra.join(', ')}.` : '') +
        /* Two nodes at the same angle land on the same point of the circle, so
           one of them goes. The count was computed and thrown away, while three
           documents claimed the user was told. */
        (fused ? ` Welded ${fused} node${fused === 1 ? '' : 's'} that shared an angle.` : '') +
        (wideDeg > 120
          ? ` Widest gap is ${wideDeg}°. One curve cannot hold that arc tightly; add a node in it.`
          : ''),
      true,
    );
    return true;
  }

  /**
   * Refit the selected subpaths with as few nodes as the tolerance allows.
   *
   * The selection is dropped afterwards. Node selections are keyed by index,
   * and after a refit index 7 is a different point on the drawing than the one
   * that was highlighted a moment ago; keeping them would leave the panel
   * editing coordinates nobody chose.
   */
  /**
   * Reduce the selected paths to a node count.
   *
   * The other question the same machinery answers. `Within` asks what can go
   * for a given cost; this asks what goes first, and stops when the count is
   * right. It reports how far the drawing moved rather than promising it did
   * not, because at a low enough count it certainly did.
   */
  simplifyToCount(target: number): boolean {
    if (!Number.isFinite(target) || target < 2) {
      this.onMessage?.('Keep how many? Two is the fewest a path can have.', false);
      return false;
    }
    const targets = this.selectedSubpaths();
    if (!targets.size) {
      this.onMessage?.('Select a shape, or some of its nodes, first.', false);
      return false;
    }

    let paths = 0;
    let before = 0;
    let after = 0;
    let moved = 0;
    const ok = this.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (!sp) continue;
          const r = reduceToCount(sp, target);
          if (r.after === r.before) continue;
          paths++;
          before += r.before;
          after += r.after;
          moved = Math.max(moved, r.cost);
        }
      }
      if (paths) st.selection.nodes.clear();
      return paths > 0;
    });

    this.onMessage?.(
      ok
        ? `Kept ${after} of ${before} nodes across ${paths} ${paths === 1 ? 'path' : 'paths'}. Nothing moved further than ${fmt(moved)}.`
        : 'Those paths are already at or below that many nodes.',
      ok,
    );
    return ok;
  }

  /**
   * Remove everything except the selected nodes.
   *
   * The same run again, with the stopping condition replaced by a set. A
   * separate operation rather than a mode on Simplify: selecting nodes already
   * means "work within these", and one gesture cannot also mean "keep these"
   * without the other reading quietly changing under anyone who relied on it.
   */
  keepSelectedNodes(): boolean {
    const refs = this.selectedNodeRefs();
    if (refs.length < 2) {
      this.onMessage?.('Select the nodes to keep. Two is the fewest a path can have.', false);
      return false;
    }

    // Grouped by the subpath they belong to; a path with none selected is left
    // alone rather than reduced to nothing.
    const byPath = new Map<string, { shape: string; sp: number; keep: Set<number> }>();
    for (const r of refs) {
      const key = `${r.shape}/${r.sp}`;
      const entry = byPath.get(key);
      if (entry) entry.keep.add(r.i);
      else byPath.set(key, { shape: r.shape, sp: r.sp, keep: new Set([r.i]) });
    }

    let paths = 0;
    let before = 0;
    let after = 0;
    let moved = 0;
    let tooFew = 0;
    const ok = this.tryEdit((st) => {
      for (const { shape, sp: spI, keep } of byPath.values()) {
        const sp = findShape(st.doc, shape)?.subpaths[spI];
        if (!sp) continue;
        if (keep.size < (sp.closed ? 3 : 2)) {
          tooFew++;
          continue;
        }
        const r = keepOnly(sp, keep);
        if (r.after === r.before) continue;
        paths++;
        before += r.before;
        after += r.after;
        moved = Math.max(moved, r.cost);
      }
      if (paths) st.selection.nodes.clear();
      return paths > 0;
    });

    this.onMessage?.(
      ok
        ? `Kept ${after} of ${before} nodes across ${paths} ${paths === 1 ? 'path' : 'paths'}. Nothing moved further than ${fmt(moved)}.`
        : tooFew
          ? 'A closed path needs three nodes kept, and an open one two.'
          : 'Nothing else could go.',
      ok,
    );
    return ok;
  }

  simplifySelection(tol: number, redraw = false): boolean {
    if (!(tol >= 0) || !Number.isFinite(tol)) {
      this.onMessage?.('Within has to be a number, and not a negative one.', false);
      return false;
    }

    const targets = this.selectedSubpaths();
    if (!targets.size) {
      this.onMessage?.('Select a shape, or some of its nodes, first.', false);
      return false;
    }

    /* Zero is a real value, not a refusal. It says "move nothing", and the
       budget that honours it is the export precision: a node whose removal
       cannot change a character of the saved file has moved nothing that can
       be observed. Making the tolerance continuous down to zero is what let
       three modes collapse into one number and one checkbox. */
    const floor = invisibleAt(this.store.state.decimals);
    const budget = tol > 0 ? Math.max(tol, floor) : floor;

    let paths = 0;
    let before = 0;
    let after = 0;
    let error = 0;
    this.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (!sp) continue;

          /* Knot removal first in every mode. It takes out what is provably
             free, so the refit is only ever asked to approximate the nodes
             that are actually carrying the shape. Running it after would be
             pointless: a refit leaves nothing redundant behind. */
          const k = removeRedundantNodes(sp, budget);
          let n = k.after;
          let moved = k.cost;

          // Refitting needs a budget to fit inside. At zero there is none, and
          // the checkbox is disabled in the panel for the same reason.
          if (redraw && tol > 0) {
            const r = simplifySubpath(sp, tol);
            if (r) {
              n = r.after;
              moved = Math.max(moved, r.error);
            }
          }

          if (n === k.before) continue;
          paths++;
          before += k.before;
          after += n;
          error = Math.max(error, moved);
        }
      }
      if (paths) st.selection = emptySelection();
      return paths > 0;
    });

    if (!paths) {
      this.onMessage?.(
        tol > 0
          ? 'Nothing to simplify. Raise Within to give up more of the shape.'
          : 'Every node here is carrying the shape. Raise Within to remove some anyway.',
        false,
      );
      return false;
    }

    const dp = (v: number): string => (+v.toFixed(3)).toString();
    this.onMessage?.(
      `Simplified ${paths} path${paths === 1 ? '' : 's'}: ${before} nodes to ${after}. ` +
        `Nothing moved further than ${dp(error)}.`,
      true,
    );
    return true;
  }

  /**
   * Round the selected corners with an arc of `radius`.
   *
   * Each rounded corner becomes two nodes, so the indices after it all shift.
   * Working from the highest index down means the ones still to do keep the
   * positions they were found at, which is the whole reason this is not a loop
   * over the selection in the order the selection happens to iterate.
   *
   * The selection is dropped afterwards, for the same reason Simplify drops it:
   * the node that was index 3 is a different point now.
   */
  roundSelection(radius: number): boolean {
    if (!(radius > 0)) {
      this.onMessage?.('Round needs a radius above zero.', false);
      return false;
    }

    const s = this.store.state;
    const byPath = new Map<string, number[]>();
    for (const key of s.selection.nodes) {
      const r = parseNodeKey(key);
      const k = `${r.shape}/${r.sp}`;
      byPath.set(k, [...(byPath.get(k) ?? []), r.i]);
    }
    if (!byPath.size) {
      this.onMessage?.('Select one or more nodes to round.', false);
      return false;
    }

    let done = 0;
    let clamped = 0;
    let smallest = Infinity;
    const refused: Record<RoundRefusal, number> = { end: 0, curved: 0, straight: 0, tiny: 0 };

    this.tryEdit((st) => {
      for (const [key, indices] of byPath) {
        const [shapeId, spIdx] = key.split('/');
        const sp = findShape(st.doc, shapeId)?.subpaths[Number(spIdx)];
        if (!sp) continue;
        for (const i of [...indices].sort((a, b) => b - a)) {
          const r = roundCorner(sp, i, radius);
          if (typeof r === 'string') {
            refused[r]++;
            continue;
          }
          done++;
          if (r.clamped) clamped++;
          smallest = Math.min(smallest, r.radius);
        }
      }
      if (done) st.selection = emptySelection();
      return done > 0;
    });

    if (!done) {
      // One reason, chosen by what actually happened, rather than a list of
      // everything that could have gone wrong.
      const why = refused.curved
        ? 'Round needs a straight segment on both sides of the node.'
        : refused.end
          ? 'That node ends the path, so it has only one side.'
          : refused.straight
            ? 'The path runs straight through that node. There is no corner to round.'
            : 'Those nodes cannot be rounded.';
      this.onMessage?.(why, false);
      return false;
    }

    const dp = (v: number): string => (+v.toFixed(3)).toString();
    const skipped = Object.values(refused).reduce((a, b) => a + b, 0);
    this.onMessage?.(
      `Rounded ${done} corner${done === 1 ? '' : 's'}.` +
        (clamped ? ` ${clamped} clamped to r ${dp(smallest)} by the shorter side.` : '') +
        (skipped ? ` Skipped ${skipped}.` : ''),
      true,
    );
    return true;
  }

  /**
   * Turn the loaded backdrop into shapes.
   *
   * One undo step, and the raster is left exactly where it was: tracing does
   * not consume the reference, because the first thing anyone does after a trace
   * is compare it against the original. Hiding the backdrop afterwards would
   * also be a view change smuggled into an edit, which §18 keeps apart.
   *
   * The traced shapes land on top of the backdrop in document space, so the two
   * can be flicked between. Ids are assigned here rather than in the tracer,
   * which knows nothing about the document it is going into.
   */
  traceBackdrop(raster: RasterLike, opts: TraceOptions): boolean {
    const s = this.store.state;
    const b = s.backdrop;
    if (!b) {
      this.onMessage?.('Load an image in the Backdrop panel first.', false);
      return false;
    }
    const place: Placement = { x: b.x, y: b.y, w: b.w, h: b.h };

    let r: TraceResult;
    try {
      r = traceImage(raster, place, opts);
    } catch {
      // The walk is exact integer work and should not throw, but it runs over
      // whatever a file decoded to. A failure here leaves the document alone.
      this.onMessage?.('That image could not be traced.', false);
      return false;
    }

    return this.applyTrace(r, place);
  }

  /**
   * Commit a finished trace, wherever it was computed.
   *
   * Split from `traceBackdrop` because the tracer now usually runs in a worker
   * (`model/trace.worker.ts`), and the gap between asking for a trace and
   * getting one back is no longer zero: the main thread stays live for those
   * seconds, so the person can move the backdrop, delete it, or start a drag
   * while the walk is still running. Every one of those makes the result wrong
   * rather than late, so this checks the world it was computed against is still
   * the world it is landing in.
   *
   * The placement comparison is exact on purpose. §Class 4's lesson was that a
   * question about *geometry* needs a tolerance, and this is not one: it asks
   * whether these numbers were changed, and a backdrop nudged by a
   * ten-thousandth is still a backdrop that moved under a trace that assumed
   * otherwise.
   */
  applyTrace(r: TraceResult, place: Placement): boolean {
    const b = this.store.state.backdrop;
    if (!b) {
      this.onMessage?.('The backdrop was removed while tracing. Nothing was added.', false);
      return false;
    }
    if (b.x !== place.x || b.y !== place.y || b.w !== place.w || b.h !== place.h) {
      this.onMessage?.('The backdrop moved while tracing. Nothing was added.', false);
      return false;
    }
    if (this.busy) {
      this.onMessage?.('Finish the drag first, then trace.', false);
      return false;
    }

    if (!r.shapes.length) {
      this.onMessage?.('Nothing to trace. Every region was smaller than the noise floor.', false);
      return false;
    }

    const ok = this.tryEdit((st) => {
      for (const shape of r.shapes) {
        shape.id = nextId('trace');
        st.doc.shapes.push(shape);
      }
      st.selection = emptySelection();
      for (const shape of r.shapes) st.selection.shapes.add(shape.id);
      return true;
    });
    if (!ok) return false;

    this.onMessage?.(
      `Traced ${r.colours} colour${r.colours === 1 ? '' : 's'} into ${r.paths} path${r.paths === 1 ? '' : 's'}: ` +
        `${r.nodesBefore} nodes fitted to ${r.nodesAfter}.`,
      true,
    );
    return true;
  }

  /**
   * Move the selection onto the pixel lattice it should already be on.
   *
   * The other half of pixel fit. Snapping only helps what you place next, and an
   * icon that already exists -- imported, traced, or drawn before the switch was
   * found -- needs the same lattice applied to what is there. Anchors move;
   * handles ride along, so a curve keeps its shape rather than being flattened
   * towards the grid.
   *
   * Deliberately not automatic. Nothing here rewrites coordinates the user did
   * not ask about, and a preference that silently moved the drawing the moment
   * it was ticked would be the worst version of this feature.
   */
  fitToPixels(): boolean {
    const s = this.store.state;
    const step = s.gridStep > 0 ? s.gridStep : 1;
    const phase = phaseInForce(s.doc, s.selection, s.style);
    if (phase === null) {
      this.onMessage?.(
        'Those shapes have different stroke widths, so no one lattice fits them all. Fit them one at a time.',
        false,
      );
      return false;
    }

    const targets = this.selectedSubpaths();
    if (!targets.size) {
      this.onMessage?.('Select a shape, or some of its nodes, to fit.', false);
      return false;
    }

    let moved = 0;
    let count = 0;
    this.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (!sp) continue;
          sp.nodes.forEach((_, j) => {
            const from = sp.nodes[j].pt;
            const to = snapTo(from, step, phase);
            const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
            if (d === 0) return;
            moveAnchor(sp, j, to);
            moved = Math.max(moved, d);
            count++;
          });
        }
      }
      return count > 0;
    });

    if (!count) {
      this.onMessage?.('Already on the pixel grid. Nothing to move.', false);
      return false;
    }
    const dp = (v: number): string => (+v.toFixed(3)).toString();
    this.onMessage?.(
      `Fitted ${count} node${count === 1 ? '' : 's'} to ${phaseLabel(phase)}. ` +
        `The furthest moved ${dp(moved)}.`,
      true,
    );
    return true;
  }

  /**
   * Weld nodes together in the middle of a path.
   *
   * Two readings, and the selection says which one is meant. With exactly two
   * nodes picked it welds that pair; with a shape or a run of nodes it sweeps
   * for zero-length segments and welds those. The sweep is the repair half: a
   * path can arrive carrying one from an import, and a path carrying one can
   * never be simplified again, because a zero chord leaves the fitter with no
   * tangent to work from.
   *
   * `Merge ends` covers the other case, two free ends, and is pointed at rather
   * than quietly stood in for: welding the two ends of an open path is a
   * topology change and deserves the keystroke that says so.
   */
  fuseSelection(): boolean {
    const s = this.store.state;
    const refs = [...s.selection.nodes].map(parseNodeKey);

    if (refs.length === 2) return this.fusePair(refs[0], refs[1]);

    const targets = this.selectedSubpaths();
    if (!targets.size) {
      this.onMessage?.('Select two adjacent nodes, or a shape to sweep.', false);
      return false;
    }

    let gone = 0;
    this.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (sp) gone += fuseDegenerate(sp);
        }
      }
      if (gone) st.selection = emptySelection();
      return gone > 0;
    });

    if (!gone) {
      this.onMessage?.('No two nodes there sit on the same point.', false);
      return false;
    }
    this.onMessage?.(`Fused ${gone} zero-length segment${gone === 1 ? '' : 's'} away.`, true);
    return true;
  }

  /** The two-node half of `fuseSelection`, split out to keep both readable. */
  private fusePair(ra: NodeRef, rb: NodeRef): boolean {
    const s = this.store.state;
    if (ra.shape !== rb.shape || ra.sp !== rb.sp) {
      this.onMessage?.('Fuse works within one path. Those two nodes are on different ones.', false);
      return false;
    }
    const sp = findShape(s.doc, ra.shape)?.subpaths[ra.sp];
    if (!sp) return false;

    if (isPathEnd(sp, ra.i) && isPathEnd(sp, rb.i)) {
      this.onMessage?.('Those are the two ends of the path. Merge ends welds them.', false);
      return false;
    }

    let moved = 0;
    let why: FuseRefusal | null = null;
    this.tryEdit((st) => {
      const live = findShape(st.doc, ra.shape)?.subpaths[ra.sp];
      if (!live) return false;
      const r = fuseNodes(live, ra.i, rb.i);
      if (typeof r === 'string') {
        why = r;
        return false;
      }
      moved = r.moved;
      st.selection = emptySelection();
      return true;
    });

    if (why) {
      this.onMessage?.(
        why === 'apart'
          ? 'Fuse needs two nodes next to each other along the path.'
          : why === 'tiny'
            ? 'That path is too short to fuse. Two nodes is the least that draws.'
            : 'Pick two different nodes.',
        false,
      );
      return false;
    }

    const dp = (v: number): string => (+v.toFixed(3)).toString();
    this.onMessage?.(
      moved > 0
        ? `Fused the two nodes. Each moved ${dp(moved)} to meet.`
        : 'Fused the two nodes. They were already on the same point.',
      true,
    );
    return true;
  }

  /**
   * Set fill, stroke, width or fill rule.
   *
   * With something selected this restyles it, one undo step. With nothing
   * selected it sets what the next shape you draw will look like, and records no
   * history: that is a statement about the future, and `Ctrl+Z` should not walk
   * back through the colours you considered.
   *
   * A node selection restyles the shape it belongs to. Style is a property of
   * the whole path in SVG, so there is no smaller thing to change.
   */
  setStyle(patch: Partial<Style>): boolean {
    const s = this.store.state;
    const targets = selectedShapes(s.doc, s.selection);

    if (!targets.length) {
      this.store.update((st) => Object.assign(st.style, patch));
      return true;
    }

    return this.tryEdit((st) => {
      let changed = false;
      for (const shape of selectedShapes(st.doc, st.selection)) {
        for (const [k, v] of Object.entries(patch)) {
          if (shape.style[k as keyof Style] === v) continue;
          Object.assign(shape.style, { [k]: v });
          changed = true;
        }
      }
      return changed;
    });
  }

  /**
   * Wrap the document's canvas around whatever has been drawn.
   *
   * The canvas never follows the drawing on its own, and should not: an icon is
   * drawn to a page, and a page that resized itself every time a node moved
   * would make the margins you were aiming for impossible to hold. But nothing
   * else could change it either, which left a drawing sitting in the corner of a
   * canvas nobody chose with no way to say so.
   *
   * Rounded outwards to whole grid steps, so the result is a page with tidy
   * numbers rather than the drawing's exact extent to three decimals. The
   * rounding always grows the box, never crops it.
   */
  fitCanvasToDrawing(): boolean {
    const s = this.store.state;
    const b = docBBox(s.doc);
    if (!b) {
      this.onMessage?.('Nothing drawn yet, so there is nothing to fit the canvas to.', false);
      return false;
    }

    const step = s.gridStep > 0 ? s.gridStep : 0;
    const down = (v: number): number => (step ? Math.floor(v / step) * step : v);
    const up = (v: number): number => (step ? Math.ceil(v / step) * step : v);
    const x = down(b.x0);
    const y = down(b.y0);
    // A drawing with no width at all, such as one straight vertical line, still
    // needs a page it can be seen on.
    const w = Math.max(up(b.x1) - x, step || 1);
    const h = Math.max(up(b.y1) - y, step || 1);

    const changed = this.tryEdit((st) => {
      const vb = st.doc.viewBox;
      if (vb.x === x && vb.y === y && vb.w === w && vb.h === h) return false;
      st.doc.viewBox = { x, y, w, h };
      return true;
    });

    if (!changed) {
      this.onMessage?.('The canvas already fits the drawing.', false);
      return false;
    }
    const dp = (v: number): string => (+v.toFixed(3)).toString();
    this.onMessage?.(`Canvas is now ${dp(w)} × ${dp(h)} at ${dp(x)}, ${dp(y)}.`, true);
    return true;
  }

  /* ------------------------------------------------------------------ pen */

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
          this.drag = { kind: 'pen', ref: { shape: resume.shape, sp: resume.sp, i } };
          this.extras.penFrom = target.nodes[i].pt;
          this.store.update((st) => {
            st.selection = emptySelection();
            st.selection.nodes.add(nodeKey({ shape: resume.shape, sp: resume.sp, i }));
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
        this.edit((st) => {
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
   * Scoped to the shape the pen was drawing. It used to sweep the whole
   * document, so finishing a path also silently deleted any one-node subpath
   * that had arrived by import or by Apply -- and with no checkpoint, the only
   * undo that brought it back also undid the drawing. Same rule as
   * `deleteSelection`: prune what this operation touched, nothing else.
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
      // Selection may now point at nodes that are gone.
      for (const key of [...st.selection.nodes]) {
        const r = parseNodeKey(key);
        if (!findShape(st.doc, r.shape)?.subpaths[r.sp]?.nodes[r.i]) st.selection.nodes.delete(key);
      }
      for (const id of [...st.selection.shapes]) {
        if (!findShape(st.doc, id)) st.selection.shapes.delete(id);
      }
    });
  }

  /* ------------------------------------------------------------- keyboard */

  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    /* Somebody nearer the event has already claimed this key. The inspector's
       tab strip and its shape list both handle the arrows and both call
       `preventDefault`, and this listener is on the window, so without this
       line arrowing through the shape list also nudged the drawing one grid
       step per press. */
    if (e.defaultPrevented) return;

    if (e.code === 'Space') {
      this.spaceDown = true;
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      // Undoing mid-drag pops the checkpoint the drag is standing on, and the
      // gesture then rolls back somebody else's edit when it ends.
      if (this.drag.kind !== 'none') return;
      if (e.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }

    /* Everything below is a bare key, with one exception. Ctrl+E belongs to the
       source drawer and Ctrl+R to the browser, and letting them through here
       switched the tool as a silent side effect of both. The arrows are the
       exception because Ctrl gives them a second meaning of their own: bend
       rather than nudge. Guarding them out too made that branch unreachable and
       quietly retired a documented shortcut. */
    if (mod && !e.key.startsWith('Arrow')) return;

    /* An operation that rewrites the document is refused while a drag is live,
       for the reason §16 refuses undo there: the drag holds node indices into
       an array the operation is about to splice, its edit folds silently into
       the drag's batch, and Escape then rolls back both with no redo. Delete
       had this hole from the beginning and Shift+F, Shift+B, Shift+J and
       Shift+M all widened it. Escape and Enter are deliberately still allowed
       -- ending a gesture is exactly what they are for. */
    const rewrites = ['Delete', 'Backspace', 'B', 'J', 'M', 'F', 'R', 'C', 'S', 'Y', 'A', 'I'];
    if (this.drag.kind !== 'none' && rewrites.includes(e.key)) {
      e.preventDefault();
      this.onMessage?.('Finish the drag first.', false);
      return;
    }

    switch (e.key) {
      case 'Delete':
      case 'Backspace': {
        e.preventDefault();
        this.deleteSelection();
        return;
      }
      case 'Escape': {
        // Abandoning a drag rolls back to the checkpoint it opened, which is
        // what genuinely leaves no trace of it in history. This used to call
        // `undo`, which kept the abandoned shape on the redo stack, and it only
        // covered `create` -- so Escape during any other drag cleared the
        // selection and left the drag running.
        if (this.drag.kind !== 'none') {
          this.abortDrag();
          return;
        }
        this.finishPen();
        this.store.update((st) => (st.selection = emptySelection()));
        return;
      }
      case 'Enter': {
        this.finishPen();
        return;
      }
      // Shift+B, the same binding Inkscape uses. Matched on the capital so it
      // cannot fire from a bare `b`.
      case 'B': {
        if (!e.shiftKey) return;
        e.preventDefault();
        this.breakAtSelection();
        return;
      }
      /* `[` and `]` walk the node selection along the path, with Shift to
         extend. The one thing the keyboard could not do: every control in the
         Node panel is reachable by Tab and every one of them acts on selected
         nodes, and until now selecting a node meant clicking it. */
      case '[':
      case ']':
      // With Shift held the browser reports the shifted character, so the
      // extend form arrives as a brace and never as a bracket.
      case '{':
      case '}': {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        const forward = e.key === ']' || e.key === '}';
        this.stepNodeSelection(forward ? 1 : -1, e.shiftKey);
        return;
      }
      // Shift+I, the keyboard's version of double-clicking an outline.
      case 'I': {
        if (!e.shiftKey) return;
        e.preventDefault();
        this.insertInSelection();
        return;
      }
      /* Shift+A, beside the three continuity keys. Ctrl+A is select-all in
         every browser, so the plain letter was never available. */
      case 'A': {
        if (!e.shiftKey) return;
        e.preventDefault();
        this.setSelectedAuto();
        return;
      }
      // Shift+R, which is Inkscape's binding for the same thing.
      case 'R': {
        if (!e.shiftKey) return;
        e.preventDefault();
        this.reverseSelection();
        return;
      }
      /* Shift+C, Shift+S and Shift+Y set a node's continuity outright, which
         double-clicking an anchor already cycles through. A cycle is fine for
         one node and no use for forty: it depends on where each of them
         started, so the same three double-clicks leave a mixed selection still
         mixed. These say which one you want. */
      case 'C':
      case 'S':
      case 'Y': {
        if (!e.shiftKey) return;
        e.preventDefault();
        this.setSelectedContinuity(e.key === 'C' ? 'corner' : e.key === 'S' ? 'smooth' : 'symmetric');
        return;
      }
      // Shift+J spans the gap; Shift+M welds. Inkscape uses Shift+J for the
      // weld, but "join" reads as "draw the missing line" to anyone who has not
      // memorised Inkscape, and that is the non-destructive one.
      case 'J': {
        if (!e.shiftKey) return;
        e.preventDefault();
        this.joinSelection('connect');
        return;
      }
      case 'M': {
        if (!e.shiftKey) return;
        e.preventDefault();
        this.joinSelection('merge');
        return;
      }
      // Shift+F welds two adjacent nodes anywhere along a path, where Shift+M
      // only ever welds two free ends.
      case 'F': {
        if (!e.shiftKey) return;
        e.preventDefault();
        this.fuseSelection();
        return;
      }
      /* Shift+P rather than TikZiT's Ctrl+P, which the browser has already
         taken for printing and will not give back from a page. It also joins
         the family every other path operation is already in. */
      case 'P': {
        if (!e.shiftKey) return;
        e.preventDefault();
        const r = this.makeOneShape();
        this.onMessage?.(r.message, r.ok);
        return;
      }
      /* Shift+K for the inverse. Inkscape puts Break Apart on Ctrl+Shift+K,
         and the letter is the only part of that worth borrowing: Shift+S is
         already smooth continuity, and every other operation here is Shift and
         a letter. */
      case 'K': {
        if (!e.shiftKey) return;
        e.preventDefault();
        const r = this.splitShapes();
        this.onMessage?.(r.message, r.ok);
        return;
      }
      case 'v': {
        this.store.update((st) => (st.tool = 'select'));
        this.finishPen();
        return;
      }
      case 'p': {
        this.store.update((st) => (st.tool = 'pen'));
        return;
      }
      case 'h': {
        this.store.update((st) => (st.tool = 'hand'));
        this.finishPen();
        return;
      }
      case 'e': {
        this.store.update((st) => (st.tool = 'ellipse'));
        this.finishPen();
        return;
      }
      case 'r': {
        this.store.update((st) => (st.tool = 'rect'));
        this.finishPen();
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        // Ctrl turns the arrows into curve controls rather than nudges:
        // left/right bend, up/down tighten or loosen.
        if (mod) {
          const seg = this.activeSegment();
          if (!seg) return;
          const step = e.shiftKey ? 1 : 5;
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            this.adjustBend(e.key === 'ArrowRight' ? step : -step, 0);
          } else {
            this.adjustBend(0, e.key === 'ArrowUp' ? 0.1 : -0.1);
          }
          return;
        }
        const s = this.store.state;
        const step = (e.shiftKey ? s.nudgeBig || 1 : 1) * (s.gridStep || 1);
        const d: Pt = [
          e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
          e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
        ];
        this.nudge(d);
        return;
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.spaceDown = false;
  };

  /* -------------------------------------------------------------- actions */

  nudge(d: Pt): void {
    const refs = this.selectedNodeRefs();
    if (!refs.length) return;
    this.edit((st) => {
      for (const r of refs) {
        const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
        if (!sp?.nodes[r.i]) continue;
        moveAnchor(sp, r.i, [sp.nodes[r.i].pt[0] + d[0], sp.nodes[r.i].pt[1] + d[1]]);
      }
    });
  }

  /**
   * Delete whatever is selected. It always deletes; there is no case where it
   * quietly does less than it was asked.
   *
   * `state.deleteMode` decides what happens to the path around the node. In
   * `fuse`, the default, the two segments either side become one, so a pentagon
   * becomes a quadrilateral -- what every other editor does on Delete, and what
   * you want when simplifying. In `split` the path is left open at the gap
   * instead, which is what you want when cutting one apart, and which is exact
   * because no segment is rebuilt.
   *
   * Neither is `breakAtSelection`, on `Shift+B`: that keeps the node and
   * duplicates it, so the drawing does not change at all. Split delete removes
   * the node; break does not.
   *
   * What is left over is pruned rather than protected: a subpath below two
   * nodes has no segments, draws nothing and serialises to nothing, so leaving
   * one behind would be leaving an invisible shape in the document. Only
   * subpaths this deletion actually touched are pruned -- a one-node subpath
   * elsewhere is the pen mid-stroke and must survive.
   */
  deleteSelection(): { deleted: number; blocked: number } {
    const s = this.store.state;

    if (s.selection.shapes.size > 0) {
      const n = s.selection.shapes.size;
      this.edit((st) => {
        st.doc.shapes = st.doc.shapes.filter((sh) => !st.selection.shapes.has(sh.id));
        st.selection = emptySelection();
      });
      return { deleted: n, blocked: 0 };
    }

    const refs = [...s.selection.nodes].map(parseNodeKey);
    if (!refs.length) return { deleted: 0, blocked: 0 };

    // Grouped by subpath, because "all of them" and "some of them" mean
    // different things and only the group knows which this is.
    const groups = new Map<string, { shape: string; sp: number; idx: number[] }>();
    for (const r of refs) {
      const key = `${r.shape}/${r.sp}`;
      const g = groups.get(key) ?? { shape: r.shape, sp: r.sp, idx: [] };
      g.idx.push(r.i);
      groups.set(key, g);
    }

    let deleted = 0;
    let blocked = 0;

    this.edit((st) => {
      // What each touched subpath becomes, applied only once the loop is done:
      // splicing as we go would shift the indices the remaining groups hold.
      const replace = new Map<string, Subpath[]>();

      for (const g of groups.values()) {
        const shape = findShape(st.doc, g.shape);
        const sp = shape?.subpaths[g.sp];
        if (!shape || !sp) continue;

        const idx = [...new Set(g.idx)].filter((i) => i >= 0 && i < sp.nodes.length);
        if (!idx.length) continue;
        const key = `${g.shape}/${g.sp}`;

        // Everything selected: the subpath goes, in either mode. Removing the
        // nodes one at a time reaches the same place; this skips the work.
        if (idx.length === sp.nodes.length) {
          replace.set(key, []);
          deleted += idx.length;
          continue;
        }

        if (st.deleteMode === 'split') {
          replace.set(key, deleteNodesSplitting(sp, new Set(idx)));
          deleted += idx.length;
          continue;
        }

        // Highest index first, so the lower ones stay valid as we go.
        for (const i of idx.sort((a, b) => b - a)) {
          if (deleteNode(sp, i)) deleted++;
          else blocked++;
        }
        replace.set(key, sp.nodes.length >= 2 ? [sp] : []);
      }

      // Untouched subpaths pass through whatever their size, so a one-node
      // stroke the pen is still drawing survives a deletion somewhere else.
      for (const sh of st.doc.shapes) {
        sh.subpaths = sh.subpaths.flatMap((sp, i) => replace.get(`${sh.id}/${i}`) ?? [sp]);
      }
      st.doc.shapes = st.doc.shapes.filter((sh) => sh.subpaths.length > 0);
      st.selection = emptySelection();
    });

    // `blocked` can now only mean a stale index -- a ref pointing past the end
    // of a subpath something else already shortened. It is kept as a return
    // value rather than a message because it is a bug signal, not user-facing.
    return { deleted, blocked };
  }

  /**
   * Break the path at the selected node, leaving two ends.
   *
   * The counterpart to deleting a node, and lossless where deleting is not:
   * the node is duplicated, so both new ends sit exactly where it was and the
   * drawing does not move. Deleting has to fuse two cubics into one, which
   * cannot be exact across an inflection.
   *
   * A closed path opens at that node. An open one becomes two, in the same
   * shape, so they keep one style and one entry in the shape list.
   */
  breakAtSelection(): boolean {
    const sel = this.singleSelectedNode();
    if (!sel) {
      this.onMessage?.('Break needs exactly one node selected.', false);
      return false;
    }

    const ref = sel.ref;
    const pieces = breakAt(sel.subpath, ref.i);
    if (!pieces) {
      this.onMessage?.('That node already ends the path.', false);
      return false;
    }

    this.edit((st) => {
      const shape = findShape(st.doc, ref.shape);
      if (!shape?.subpaths[ref.sp]) return;
      shape.subpaths.splice(ref.sp, 1, ...pieces);
      st.selection = emptySelection();
    });

    this.onMessage?.(
      pieces.length === 1 ? 'Opened the path at that node.' : 'Broke the path into two.',
      true,
    );
    return true;
  }

  /**
   * Weld two selected free ends into one node.
   *
   * The inverse of `Break here`, and the answer to "I drew this in two pieces
   * and now I want one path". Ends that already sit on top of each other do not
   * move; ends apart meet in the middle.
   */
  joinSelection(mode: 'connect' | 'merge' = 'connect'): boolean {
    const s = this.store.state;
    const refs = [...s.selection.nodes].map(parseNodeKey);
    const verb = mode === 'merge' ? 'Merge' : 'Connect';
    if (refs.length !== 2) {
      this.onMessage?.(`${verb} needs exactly two nodes selected.`, false);
      return false;
    }

    const [ra, rb] = refs;
    const resolve = (r: NodeRef): Subpath | null =>
      findShape(s.doc, r.shape)?.subpaths[r.sp] ?? null;
    const spa = resolve(ra);
    const spb = resolve(rb);
    if (!spa || !spb) return false;

    if (!isPathEnd(spa, ra.i) || !isPathEnd(spb, rb.i)) {
      this.onMessage?.(
        `${verb} needs two free ends. Both nodes have to start or finish an open path.`,
        false,
      );
      return false;
    }
    const sameSubpath = ra.shape === rb.shape && ra.sp === rb.sp;
    if (sameSubpath && spa.nodes.length < (mode === 'merge' ? 3 : 2)) {
      this.onMessage?.('That path is too short to close.', false);
      return false;
    }

    let closed = false;
    const ok = this.tryEdit((st) => {
      const shapeA = findShape(st.doc, ra.shape);
      const shapeB = findShape(st.doc, rb.shape);
      const a = shapeA?.subpaths[ra.sp];
      const b = shapeB?.subpaths[rb.sp];
      if (!shapeA || !shapeB || !a || !b) return false;

      const join = mode === 'merge' ? mergeEnds : connectEnds;
      const joined = join({ sp: a, i: ra.i }, { sp: b, i: rb.i });
      if (!joined) return false;

      if (sameSubpath) {
        closed = true;
      } else {
        shapeA.subpaths[ra.sp] = joined;
        shapeB.subpaths.splice(rb.sp, 1);
        // A shape with no subpaths left draws nothing and serialises to
        // nothing, so it goes rather than lingering in the list.
        if (!shapeB.subpaths.length) {
          st.doc.shapes = st.doc.shapes.filter((sh) => sh.id !== shapeB.id);
        }
      }
      st.selection = emptySelection();
      return true;
    });

    if (!ok) {
      this.onMessage?.(`Those two ends cannot be ${mode === 'merge' ? 'merged' : 'connected'}.`, false);
      return false;
    }
    this.onMessage?.(
      closed
        ? 'Closed the path.'
        : mode === 'merge'
          ? 'Merged the two ends into one node.'
          : 'Connected the two ends with a segment.',
      true,
    );
    return true;
  }

  /** Rotate, flip or scale the selection about its own centre. */
  applyTransform(kind: 'rotate' | 'flipH' | 'flipV' | 'scale', amount = 0): void {
    const s = this.store.state;
    const shapes = selectedShapes(s.doc, s.selection);
    const targets = shapes.length ? shapes : s.doc.shapes;
    if (!targets.length) return;

    const box = selectionBBox(s.doc, s.selection) ?? null;
    let cx = 0;
    let cy = 0;
    if (box) {
      cx = (box.x0 + box.x1) / 2;
      cy = (box.y0 + box.y1) / 2;
    } else {
      const all = targets.flatMap((sh) => sh.subpaths.flatMap((sp) => sp.nodes.map((n) => n.pt)));
      cx = all.reduce((a, p) => a + p[0], 0) / all.length;
      cy = all.reduce((a, p) => a + p[1], 0) / all.length;
    }

    const m =
      kind === 'rotate'
        ? about(rotMat(amount), cx, cy)
        : kind === 'flipH'
          ? about([-1, 0, 0, 1, 0, 0], cx, cy)
          : kind === 'flipV'
            ? about([1, 0, 0, -1, 0, 0], cx, cy)
            : about([amount, 0, 0, amount, 0, 0], cx, cy);

    const ids = new Set(targets.map((t) => t.id));
    this.edit((st) => {
      for (const shape of st.doc.shapes) if (ids.has(shape.id)) transformShape(shape, m);
    });
  }

  /**
   * Combine the selected shapes into one.
   *
   * Whole-shape selection only. A boolean operates on regions, and a region is
   * a shape -- inferring one from a couple of selected nodes would be a guess
   * about which shape the user meant, made silently and destructively.
   *
   * Order is document order, which is paint order: the first (bottom-most)
   * shape survives, keeping its id, name and style, and the rest are consumed.
   * That makes `subtract` bottom-minus-the-rest, which is what Inkscape's
   * Difference and Illustrator's Minus Front both do, and it means the result
   * keeps the appearance of the shape it visually replaced.
   *
   * Returns a message rather than touching the DOM, so the caller decides where
   * to say it and this stays testable without a page.
   */
  booleanSelection(op: BooleanOp): { ok: boolean; message: string } {
    const s = this.store.state;
    const operands = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));
    const label = BOOLEAN_LABEL[op];
    if (operands.length < 2) {
      return { ok: false, message: `${label} needs two or more selected shapes.` };
    }

    let result: Subpath[] | null;
    try {
      result = booleanShapes(operands, op);
    } catch (err) {
      // Either the library threw, or it handed back geometry that failed the
      // finite check. Both leave the document untouched.
      return { ok: false, message: `${label} failed: ${(err as Error).message}` };
    }
    if (!result) {
      return { ok: false, message: `${label} left nothing. The document is unchanged.` };
    }

    const subpaths = result;
    const keep = operands[0].id;
    const consumed = new Set(operands.slice(1).map((sh) => sh.id));

    this.edit((st) => {
      const target = findShape(st.doc, keep);
      if (!target) return;
      target.subpaths = subpaths;
      st.doc.shapes = st.doc.shapes.filter((sh) => !consumed.has(sh.id));
      st.selection = emptySelection();
      st.selection.shapes.add(keep);
    });

    const n = subpaths.length;
    return {
      ok: true,
      message: `${label}: ${operands.length} shapes → ${n} path${n === 1 ? '' : 's'}.`,
    };
  }

  /**
   * Put the selected shapes into one shape, without touching their geometry.
   *
   * The quiet relative of the booleans, and the one people reach for without
   * knowing it. `Unite` asks what region the shapes cover and rebuilds the
   * outline from the answer, which destroys every node that fell inside. This
   * moves the paths and changes nothing about them, so a ring inside a disc
   * stays two rings and the fill rule decides whether the middle is a hole.
   * That is the only way to draw a hole here, and no boolean produces one.
   *
   * Shipped as **Make one shape** rather than the shopping list's "Make path".
   * `STYLE.md` reserves "path" for one continuous run of nodes and "shape" for
   * one entry in the Shapes list, and this makes one of the latter out of
   * several of the former. A button called Make path that produces a shape
   * would teach the wrong noun in the one place the reader is paying attention.
   *
   * Same conventions as `booleanSelection`, deliberately: whole shapes only,
   * document order, the bottom-most survives with its id, name and style. A
   * sibling that differed for no reason would read as carelessness.
   */
  makeOneShape(): { ok: boolean; message: string } {
    const s = this.store.state;
    const operands = s.doc.shapes.filter((sh) => s.selection.shapes.has(sh.id));
    if (operands.length < 2) {
      return { ok: false, message: 'Make one shape needs two or more selected shapes.' };
    }

    const keep = operands[0];
    const keepId = keep.id;
    const consumed = new Set(operands.slice(1).map((sh) => sh.id));
    const subpaths = operands.flatMap((sh) => sh.subpaths);
    const n = subpaths.length;

    /* Worth saying out loud, because it is the one thing that is lost. Every
       other shape's fill, stroke and width go with it, and a silent recolour
       is the kind of change people notice three steps later and blame on
       something else. */
    const differs = operands
      .slice(1)
      .some(
        (sh) =>
          sh.style.fill !== keep.style.fill ||
          sh.style.stroke !== keep.style.stroke ||
          sh.style.strokeWidth !== keep.style.strokeWidth,
      );

    this.edit((st) => {
      const target = findShape(st.doc, keepId);
      if (!target) return;
      /* The same subpath objects, not copies. Filtering a shape out of
         `doc.shapes` drops the shape, not the paths inside it, and each one
         ends up in exactly one place, so nothing is aliased. A hand-written
         deep copy would also quietly drop any field a future `PathNode`
         gains, which is a worse failure than the one it guards against. */
      target.subpaths = subpaths;
      st.doc.shapes = st.doc.shapes.filter((sh) => !consumed.has(sh.id));
      st.selection = emptySelection();
      st.selection.shapes.add(keepId);
    });

    const rule = keep.style.fillRule === 'evenodd' ? 'Even-odd' : 'Nonzero';
    return {
      ok: true,
      message: differs
        ? `${keep.name} now holds ${n} paths. The other colours are gone, and the rule is ${rule}.`
        : `${keep.name} now holds ${n} paths. The rule is ${rule}.`,
    };
  }

  /** Whether anything in the selection has more than one path to split. */
  canSplitShapes(): boolean {
    const s = this.store.state;
    return s.doc.shapes.some((sh) => s.selection.shapes.has(sh.id) && sh.subpaths.length > 1);
  }

  /**
   * Give every path in the selected shapes a shape of its own.
   *
   * The inverse of `makeOneShape`, and the reason that one is safe to use.
   * Without it the only way back out is undo, which stops being an option the
   * moment you do anything else, and a door that only opens one way is a trap
   * however useful the room behind it.
   *
   * Not an exact inverse, and cannot be. Splitting a shape that was never made
   * by combining still works, and `Make one shape` afterwards will not restore
   * a name or a colour that this discarded. Undo is the exact inverse; this is
   * the useful one.
   *
   * Each new shape takes the original's style, so a ring split out of an
   * even-odd shape stops being a hole and becomes a filled disc. Nothing else
   * is honest: a hole is a relationship between two paths in one shape, and
   * once they are in two shapes the relationship is gone.
   *
   * The original keeps its id, name and first path, and the rest are inserted
   * directly behind it so paint order does not change. Same rule as the
   * booleans and `makeOneShape`, where the first also survives.
   */
  splitShapes(): { ok: boolean; message: string } {
    const s = this.store.state;
    const targets = s.doc.shapes.filter(
      (sh) => s.selection.shapes.has(sh.id) && sh.subpaths.length > 1,
    );
    if (!targets.length) {
      /* Two different refusals, because "nothing selected" and "the thing you
         selected is already one path" call for different next moves. A single
         message covering both would be right about neither. */
      const anySelected = s.selection.shapes.size > 0;
      return {
        ok: false,
        message: anySelected
          ? 'Split needs a shape holding two or more paths. These hold one each.'
          : 'Split needs a shape selected. It gives each of its paths a shape of its own.',
      };
    }

    const ids = new Set(targets.map((sh) => sh.id));
    let made = 0;

    this.edit((st) => {
      const out: Shape[] = [];
      const selected = new Set<string>();
      for (const sh of st.doc.shapes) {
        if (!ids.has(sh.id)) {
          out.push(sh);
          continue;
        }
        const [first, ...rest] = sh.subpaths;
        // The original, reduced to its first path. Keeping the object rather
        // than replacing it is what preserves the id the export carries.
        sh.subpaths = [first];
        out.push(sh);
        selected.add(sh.id);
        rest.forEach((sp, i) => {
          const copy = makeShape([sp], `${sh.name} ${i + 2}`, sh.style);
          out.push(copy);
          selected.add(copy.id);
          made++;
        });
      }
      st.doc.shapes = out;
      st.selection = emptySelection();
      for (const id of selected) st.selection.shapes.add(id);
    });

    const from = targets.length;
    return {
      ok: true,
      message:
        from === 1
          ? `${targets[0].name} split into ${made + 1} shapes.`
          : `${from} shapes split into ${from + made}.`,
    };
  }

  /** How many anchors are selected, counting whole-shape selections. */
  selectionCount(): number {
    const s = this.store.state;
    /* With nothing selected by key there is nothing for the union in
       `selectedNodeRefs` to dedupe, so the count is just the selected shapes'
       nodes and can be added up instead of materialised. That matters because
       this is called twice on every notification, and a traced document
       selects seven shapes holding 23 454 nodes: the general path builds 23 454
       ref objects and 23 454 dedupe keys to answer "how many", twice, on every
       pointermove. Measured at 13.5 ms per notification before this. */
    if (s.selection.nodes.size === 0) {
      let n = 0;
      for (const id of s.selection.shapes) {
        const shape = findShape(s.doc, id);
        if (shape) for (const sp of shape.subpaths) n += sp.nodes.length;
      }
      return n;
    }
    return this.selectedNodeRefs().length;
  }

  /**
   * The single selected node, or `null` unless exactly one is selected.
   * The inspector edits one node at a time; align handles the rest.
   */
  singleSelectedNode(): { ref: NodeRef; node: PathNode; subpath: Subpath } | null {
    // Asked first, because it can answer "not one" without building the list.
    if (this.selectionCount() !== 1) return null;
    const refs = this.selectedNodeRefs();
    if (refs.length !== 1) return null;
    const r = refs[0];
    const sp = findShape(this.store.state.doc, r.shape)?.subpaths[r.sp];
    const node = sp?.nodes[r.i];
    return sp && node ? { ref: r, node, subpath: sp } : null;
  }

  /**
   * Set one coordinate of the selected node's anchor or a handle.
   *
   * Setting a handle that does not exist yet creates it, which is the typed
   * equivalent of dragging the hollow ghost out on canvas.
   */
  setNodeCoord(part: HandlePart, axis: 0 | 1, value: number): void {
    const sel = this.singleSelectedNode();
    if (!sel || !Number.isFinite(value)) return;
    const ref = sel.ref;

    this.edit((st) => {
      const sp = findShape(st.doc, ref.shape)?.subpaths[ref.sp];
      const n = sp?.nodes[ref.i];
      if (!sp || !n) return;

      if (part === 'anchor') {
        const p: Pt = [n.pt[0], n.pt[1]];
        p[axis] = value;
        moveAnchor(sp, ref.i, p);
        return;
      }

      const existing = part === 'in' ? n.hIn : n.hOut;
      const seed = existing ?? latentHandle(sp, ref.i, part);
      if (!seed) return;
      const p: Pt = [seed[0], seed[1]];
      p[axis] = value;
      moveHandle(sp, ref.i, part, p);
    });
  }

  alignSelection(mode: AlignMode): void {
    const refs = this.selectedNodeRefs();
    if (refs.length < 2) return;
    this.edit((st) => alignNodes(st.doc, refs, mode));
  }

  distributeSelection(axis: 'h' | 'v'): void {
    const refs = this.selectedNodeRefs();
    if (refs.length < 3) return;
    this.edit((st) => distributeNodes(st.doc, refs, axis));
  }

  /**
   * The one segment both of whose endpoints are selected, if there is exactly
   * one. Same rule the bend controls and Curve/Straighten use.
   */
  activeSegment(): { shape: string; sp: number; seg: number; bend: Bend | null } | null {
    const s = this.store.state;
    if (this.selectionCount() < 2) return null;
    const sel = s.selection;

    /* Membership is asked one node at a time rather than by materialising the
       whole selection into a Set of keys first. The answer here is `null` the
       moment a second segment qualifies, so with a whole shape selected this
       looks at two segments -- while building the Set cost 23 454 refs and
       23 454 strings before the first question was asked. It was 12.3 ms on
       every notification, which is most of what a pointermove used to cost. */
    const picked = (id: string, spI: number, i: number): boolean =>
      sel.shapes.has(id) || sel.nodes.has(nodeKey({ shape: id, sp: spI, i }));
    // Shapes with nothing selected in them cannot contribute a segment, and
    // skipping them keeps this off the other 23 000 nodes entirely.
    const touched = new Set(sel.shapes);
    for (const key of sel.nodes) touched.add(parseNodeKey(key).shape);

    let found: { shape: string; sp: number; seg: number; bend: Bend | null } | null = null;
    for (const shape of s.doc.shapes) {
      if (!touched.has(shape.id)) continue;
      for (let spI = 0; spI < shape.subpaths.length; spI++) {
        const sp = shape.subpaths[spI];
        for (let seg = 0; seg < segmentCount(sp); seg++) {
          if (!picked(shape.id, spI, seg)) continue;
          if (!picked(shape.id, spI, (seg + 1) % sp.nodes.length)) continue;
          if (found) return null; // ambiguous: more than one segment qualifies
          found = { shape: shape.id, sp: spI, seg, bend: segmentBend(sp, seg) };
        }
      }
    }
    return found;
  }

  /** Set the active segment's bend outright. */
  setActiveBend(bend: Bend): void {
    const seg = this.activeSegment();
    if (!seg) return;
    this.edit((st) => {
      const sp = findShape(st.doc, seg.shape)?.subpaths[seg.sp];
      if (sp && seg.seg < segmentCount(sp)) setSegmentBend(sp, seg.seg, bend);
    });
  }

  /**
   * Drop the active segment out of bend mode and back to free handles.
   *
   * A bend exists only while the two handles stay mirrored, so leaving it means
   * making them genuinely unequal -- there is no flag to clear. Lengthening one
   * by a tenth of a percent is the smallest edit that does it: below what the
   * eye can see, above the tolerance `bendOf` uses to call a pair symmetric.
   */
  freeActiveSegment(): void {
    const seg = this.activeSegment();
    if (!seg?.bend) return;
    this.edit((st) => {
      const sp = findShape(st.doc, seg.shape)?.subpaths[seg.sp];
      if (!sp || seg.seg >= segmentCount(sp)) return;
      const n = sp.nodes[seg.seg];
      if (!n.hOut) return;
      n.hOut = [n.pt[0] + (n.hOut[0] - n.pt[0]) * 1.001, n.pt[1] + (n.hOut[1] - n.pt[1]) * 1.001];
    });
  }

  /** Nudge the active segment's bend, for keyboard control. */
  adjustBend(dAngle: number, dLoose: number): void {
    const seg = this.activeSegment();
    if (!seg || !seg.bend) return;
    this.setActiveBend({
      angle: seg.bend.angle + dAngle,
      looseness: Math.max(0.05, seg.bend.looseness + dLoose),
    });
  }

  /**
   * Turn the selected subpaths round.
   *
   * A selected shape means all of its subpaths; selected nodes mean the
   * subpaths they sit in. Both at once is a union, so selecting a shape and one
   * of its own nodes reverses each subpath once rather than twice.
   *
   * The selection is carried across rather than cleared. Reversing renumbers
   * every node -- `i` becomes `n - 1 - i` in an open subpath, and `n - i` in a
   * closed one, which keeps node 0 where `reverseSubpath` leaves it -- so
   * without remapping, the nodes you had selected would stay highlighted while
   * pointing at different nodes, and the next nudge would move the wrong ones.
   */
  reverseSelection(): boolean {
    const s = this.store.state;
    const targets = new Set<string>();
    // `nodeKey` already assumes an id holds no slash, so this can too.
    const key = (shape: string, sp: number): string => `${shape}/${sp}`;

    for (const id of s.selection.shapes) {
      const shape = findShape(s.doc, id);
      shape?.subpaths.forEach((_, spI) => targets.add(key(id, spI)));
    }
    for (const k of s.selection.nodes) {
      const r = parseNodeKey(k);
      if (findShape(s.doc, r.shape)?.subpaths[r.sp]) targets.add(key(r.shape, r.sp));
    }

    if (!targets.size) {
      this.onMessage?.('Select a shape or some nodes to reverse.', false);
      return false;
    }

    let done = 0;
    const ok = this.tryEdit((st) => {
      for (const t of targets) {
        const [shapeId, spText] = t.split('/');
        const sp = findShape(st.doc, shapeId)?.subpaths[Number(spText)];
        if (!sp || sp.nodes.length < 2) continue;
        reverseSubpath(sp);
        done++;
      }
      if (!done) return false;

      // Renumber the selection to follow the nodes it was pointing at.
      const moved = new Set<string>();
      for (const k of st.selection.nodes) {
        const r = parseNodeKey(k);
        const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
        if (!sp || !targets.has(key(r.shape, r.sp))) {
          moved.add(k);
          continue;
        }
        const n = sp.nodes.length;
        const i = sp.closed ? (n - r.i) % n : n - 1 - r.i;
        moved.add(nodeKey({ shape: r.shape, sp: r.sp, i }));
      }
      st.selection.nodes = moved;
      return true;
    });
    if (!ok) return false;

    this.onMessage?.(`Reversed ${done} subpath${done === 1 ? '' : 's'}.`, true);
    return true;
  }

  /** Force every selected anchor into a continuity by moving its handles. */
  setSelectedContinuity(kind: NodeContinuity): void {
    const refs = this.selectedNodeRefs();
    if (!refs.length) return;

    let changed = 0;
    let alreadySymmetric = 0;
    let atEnd = 0;
    let alreadySo = 0;

    this.tryEdit((st) => {
      for (const r of refs) {
        const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
        const node = sp?.nodes[r.i];
        if (!sp || !node) continue;

        const before = continuityOf(node);
        // An end of an open subpath has a segment on one side only, so there is
        // no pair to line up and smooth/symmetric cannot apply.
        const oneSided =
          kind !== 'corner' &&
          !sp.closed &&
          (r.i === 0 || r.i === sp.nodes.length - 1) &&
          (!node.hIn || !node.hOut);

        if (setContinuity(sp, r.i, kind)) changed++;
        else if (oneSided) atEnd++;
        else if (kind === 'smooth' && before === 'symmetric') alreadySymmetric++;
        else alreadySo++;
      }
      return changed > 0;
    });

    // A button that does nothing and says nothing reads as broken, and there
    // are more of those cases than the two this used to cover.
    if (changed) return;
    if (alreadySymmetric) {
      this.onMessage?.(
        'Already smooth. Symmetric is smooth with equal handle lengths; drag one to differ.',
        true,
      );
    } else if (atEnd) {
      this.onMessage?.(
        'That node ends the path. There is no second handle to line up with.',
        false,
      );
    } else if (alreadySo) {
      const word = kind === 'corner' ? 'a corner' : kind === 'smooth' ? 'smooth' : 'symmetric';
      this.onMessage?.(
        `Already ${word}.`,
        true,
      );
    }
  }

  /**
   * Curve or straighten the segments *between* selected anchors.
   *
   * Acting on segments whose BOTH endpoints are selected is the unambiguous
   * reading: selecting two adjacent nodes and pressing Curve affects exactly
   * the one segment joining them, never the ones trailing off either end.
   */
  setSelectedSegmentsCurved(curved: boolean): void {
    const s = this.store.state;
    const selected = new Set(this.selectedNodeRefs().map(nodeKey));
    if (!selected.size) return;

    this.edit((st) => {
      for (const shape of st.doc.shapes) {
        shape.subpaths.forEach((sp, spI) => {
          for (let seg = 0; seg < segmentCount(sp); seg++) {
            const a = nodeKey({ shape: shape.id, sp: spI, i: seg });
            const b = nodeKey({ shape: shape.id, sp: spI, i: (seg + 1) % sp.nodes.length });
            if (selected.has(a) && selected.has(b)) setSegmentCurved(sp, seg, curved);
          }
        });
      }
    });
    void s;
  }

  countNodes(): number {
    return this.store.state.doc.shapes.reduce(
      (a, sh) => a + sh.subpaths.reduce((b, sp) => b + sp.nodes.length, 0),
      0,
    );
  }

  countSegments(): number {
    return this.store.state.doc.shapes.reduce(
      (a, sh) => a + sh.subpaths.reduce((b, sp) => b + segmentCount(sp), 0),
      0,
    );
  }
}

export type { HandlePart };
