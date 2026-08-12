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
import type { NodeContinuity, PathNode, Pt, Style, Subpath } from '../core/types';
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
import { phaseInForce, phaseLabel } from '../model/pixelfit';
import { resolveSnap } from '../model/snapping';
import type { SnapResult } from '../model/snapping';
import { traceImage } from '../model/trace';
import type { TraceOptions, TraceResult } from '../model/trace';
import type { RasterLike } from '../core/raster';
import { boxCentre, handlePoint, rotateMatrix, scaleMatrix } from '../model/transform';
import type { TransformPart } from '../model/transform';
import { ellipseSubpath, rectSubpath } from '../core/primitives';
import { BOOLEAN_LABEL, booleanShapes } from '../io/boolean';
import type { BooleanOp } from '../io/boolean';
import type { Store } from '../model/store';
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
  | { kind: 'anchor'; refs: NodeRef[]; grabbed: NodeRef; offset: Pt }
  | { kind: 'handle'; ref: NodeRef; which: 'in' | 'out'; breakPair: boolean }
  /* Moving a selection. The total translation is tracked from the press rather
     than accumulated per move, because it is the TOTAL that gets snapped: see
     `bodyDrag`. */
  | { kind: 'body'; shapes: string[]; refs: NodeRef[]; from: Pt; applied: Pt }
  | { kind: 'pen'; ref: NodeRef }
  /* Drawing a primitive. `id` is null until the drag is big enough to be worth
     a shape, so a stray click on the canvas leaves no empty one behind and no
     history entry either. */
  | { kind: 'create'; tool: 'ellipse' | 'rect'; from: Pt; id: string | null }
  | { kind: 'bend'; shape: string; sp: number; seg: number; looseness: number };

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
    this.canvas.renderOverlay(s, this.extras);
  }

  /* ------------------------------------------------------------- helpers */

  private pt(e: PointerEvent | MouseEvent | WheelEvent): Pt {
    return screenToDoc(this.canvas.overlay, e.clientX, e.clientY);
  }

  /**
   * The lattice shift in force, or zero when pixel-fit is off or undecidable.
   *
   * Read fresh each time rather than cached: it follows the selection and the
   * pending stroke width, both of which change under the user's hand. The canvas
   * calls the same function for the grid it draws, so the lattice you aim at and
   * the lattice you see cannot disagree.
   */
  phase(): number {
    const s = this.store.state;
    if (!s.pixelFit) return 0;
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
  private snapWith(p: Pt, exclude?: NodeRef, excludeShape?: string): SnapResult {
    const s = this.store.state;
    return resolveSnap(p, {
      doc: s.doc,
      step: s.gridStep,
      phase: this.phase(),
      toGrid: s.snapToGrid,
      toPoints: s.snapToPoints,
      toBoundary: s.snapToBoundary,
      reach: Controller.REACH_PX * this.canvas.scale(s.camera),
      exclude,
      excludeShape,
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

  /* -------------------------------------------------------------- pointer */

  private onDown = (e: PointerEvent): void => {
    if (e.button === 2) return;
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
        if (e.shiftKey) {
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
      };
      return;
    }

    if ((hit?.kind === 'in' || hit?.kind === 'out') && hit.ref) {
      this.openBatch();
      // Alt held at the moment of grabbing breaks the pair for the whole drag.
      // Sampling it once, rather than per move, means letting go of Alt midway
      // does not suddenly snap the far handle back into line.
      this.drag = { kind: 'handle', ref: hit.ref, which: hit.kind, breakPair: e.altKey };
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
        if (!e.shiftKey && !st.selection.shapes.has(id) && !wholeShapeSelected) {
          st.selection = emptySelection();
        }
        st.selection.shapes.add(id);
      });
      this.openBatch();
      const shapes = [...this.store.state.selection.shapes];
      // Nodes belonging to a shape that is moving wholesale would be moved
      // twice, once by each rule.
      const refs = this.selectedNodeRefs().filter((r) => !shapes.includes(r.shape));
      this.drag = { kind: 'body', shapes, refs, from: p, applied: [0, 0] };
      return;
    }

    // An unlocked backdrop takes the empty-canvas drag, which is the whole
    // meaning of unlocking it.
    const back = s.backdrop;
    if (back && back.visible && !back.locked) {
      this.openBatch();
      this.drag = { kind: 'backdrop', from: p, origin: [back.x, back.y] };
      return;
    }

    if (!e.shiftKey) this.store.update((st) => (st.selection = emptySelection()));
    this.drag = { kind: 'marquee', from: p };
  };

  private onMove = (e: PointerEvent): void => {
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
          const r = rotateMatrix(boxCentre(d.box), d.grab, p, e.shiftKey ? 15 : 0);
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
            fromCentre: e.altKey,
            keepAspect: e.shiftKey,
          });
          this.onMessage?.(`Scale ${pct(m[0])} × ${pct(m[3])}`, true);
        }
        this.store.edit((st) => transformCaptured(st.doc, d.saved, m));
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
        const want: Pt = s2.snapToGrid && s2.gridStep > 0 ? snapTo(raw, s2.gridStep) : raw;
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
        this.createDrag(p, e.shiftKey, e.altKey);
        return;
      }

      case 'bend': {
        const d = this.drag;
        this.store.edit((st) => {
          const sp = findShape(st.doc, d.shape)?.subpaths[d.sp];
          if (!sp || d.seg >= segmentCount(sp)) return;
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
          n.hOut = this.snap(p, d.ref);
          // The very first node of an open path has nothing arriving at it.
          if (d.ref.i > 0 || sp.closed) n.hIn = [2 * n.pt[0] - n.hOut[0], 2 * n.pt[1] - n.hOut[1]];
        });
        return;
      }
    }
  };

  private onUp = (e: PointerEvent): void => {
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

      /* The live readout during a transform is a measurement, not an outcome.
         Restating it as a sentence on release is what turns the last thing on
         screen into a record of what was done. */
      if (this.drag.kind === 'transform') {
        const d = this.drag;
        const now = selectionBBox(this.store.state.doc, this.store.state.selection);
        if (d.mode === 'rotate') {
          const r = rotateMatrix(boxCentre(d.box), d.grab, this.pt(e), e.shiftKey ? 15 : 0);
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
        const order = ['corner', 'smooth', 'symmetric'] as const;
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
    this.store.tryEdit((st) => {
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
  simplifySelection(tol: number): boolean {
    if (!(tol > 0)) {
      this.onMessage?.('Simplify needs a tolerance above zero. It is how far a node may move.', false);
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
    let error = 0;
    this.store.tryEdit((st) => {
      for (const [id, sps] of targets) {
        const shape = findShape(st.doc, id);
        for (const i of sps) {
          const sp = shape?.subpaths[i];
          if (!sp) continue;
          const r = simplifySubpath(sp, tol);
          if (!r) continue;
          paths++;
          before += r.before;
          after += r.after;
          error = Math.max(error, r.error);
        }
      }
      if (paths) st.selection = emptySelection();
      return paths > 0;
    });

    if (!paths) {
      this.onMessage?.(
        'Nothing to simplify. Raise the tolerance to remove more nodes.',
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

    this.store.tryEdit((st) => {
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

    let r: TraceResult;
    try {
      r = traceImage(raster, { x: b.x, y: b.y, w: b.w, h: b.h }, opts);
    } catch {
      // The walk is exact integer work and should not throw, but it runs over
      // whatever a file decoded to. A failure here leaves the document alone.
      this.onMessage?.('That image could not be traced.', false);
      return false;
    }

    if (!r.shapes.length) {
      this.onMessage?.('Nothing to trace. Every region was smaller than the noise floor.', false);
      return false;
    }

    const ok = this.store.tryEdit((st) => {
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
    this.store.tryEdit((st) => {
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
      this.onMessage?.('Already on the pixel grid. Nothing to move.', true);
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
    this.store.tryEdit((st) => {
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
    this.store.tryEdit((st) => {
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

    return this.store.tryEdit((st) => {
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

    const changed = this.store.tryEdit((st) => {
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
        const step = (e.shiftKey ? 10 : 1) * (s.gridStep || 1);
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
    this.store.edit((st) => {
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
      this.store.edit((st) => {
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

    this.store.edit((st) => {
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

    this.store.edit((st) => {
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
    const ok = this.store.tryEdit((st) => {
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
    this.store.edit((st) => {
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

    this.store.edit((st) => {
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
      message: `${label}: ${operands.length} shapes → ${n} contour${n === 1 ? '' : 's'}.`,
    };
  }

  /** How many anchors are selected, counting whole-shape selections. */
  selectionCount(): number {
    return this.selectedNodeRefs().length;
  }

  /**
   * The single selected node, or `null` unless exactly one is selected.
   * The inspector edits one node at a time; align handles the rest.
   */
  singleSelectedNode(): { ref: NodeRef; node: PathNode; subpath: Subpath } | null {
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

    this.store.edit((st) => {
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
    this.store.edit((st) => alignNodes(st.doc, refs, mode));
  }

  distributeSelection(axis: 'h' | 'v'): void {
    const refs = this.selectedNodeRefs();
    if (refs.length < 3) return;
    this.store.edit((st) => distributeNodes(st.doc, refs, axis));
  }

  /**
   * The one segment both of whose endpoints are selected, if there is exactly
   * one. Same rule the bend controls and Curve/Straighten use.
   */
  activeSegment(): { shape: string; sp: number; seg: number; bend: Bend | null } | null {
    const s = this.store.state;
    const sel = new Set(this.selectedNodeRefs().map(nodeKey));
    if (sel.size < 2) return null;

    let found: { shape: string; sp: number; seg: number; bend: Bend | null } | null = null;
    for (const shape of s.doc.shapes) {
      for (let spI = 0; spI < shape.subpaths.length; spI++) {
        const sp = shape.subpaths[spI];
        for (let seg = 0; seg < segmentCount(sp); seg++) {
          const a = nodeKey({ shape: shape.id, sp: spI, i: seg });
          const b = nodeKey({ shape: shape.id, sp: spI, i: (seg + 1) % sp.nodes.length });
          if (!sel.has(a) || !sel.has(b)) continue;
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
    this.store.edit((st) => {
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
    this.store.edit((st) => {
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

  /** Force every selected anchor into a continuity by moving its handles. */
  setSelectedContinuity(kind: NodeContinuity): void {
    const refs = this.selectedNodeRefs();
    if (!refs.length) return;

    let changed = 0;
    let alreadySymmetric = 0;
    let atEnd = 0;
    let alreadySo = 0;

    this.store.tryEdit((st) => {
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

    this.store.edit((st) => {
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
