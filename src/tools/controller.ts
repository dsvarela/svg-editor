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
import type { NodeContinuity, PathNode, Pt, Subpath } from '../core/types';
import {
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
  circulariseSubpath,
  closeSubpath,
  deleteNode,
  deleteNodesSplitting,
  distributeNodes,
  connectEnds,
  isPathEnd,
  mergeEnds,
  latentHandle,
  moveAnchor,
  moveHandle,
  nearestOnPath,
  reverseSubpath,
  setContinuity,
  setSegmentBend,
  segmentBend,
  setSegmentCurved,
  snap as snapTo,
  splitSegment,
  transformShape,
} from '../model/ops';
import type { AlignMode } from '../model/ops';
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
  /* Sliding the tracing image into place. Not a document edit, so it opens no
     batch and records no history -- the same bargain the camera makes. */
  | { kind: 'backdrop'; from: Pt; origin: Pt }
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
    this.extras.selectionBox =
      this.drag.kind === 'none' && s.selection.shapes.size > 0 ? selectionBBox(s.doc, s.selection) : null;
    this.canvas.renderOverlay(s, this.extras);
  }

  /* ------------------------------------------------------------- helpers */

  private pt(e: PointerEvent | MouseEvent | WheelEvent): Pt {
    return screenToDoc(this.canvas.overlay, e.clientX, e.clientY);
  }

  /**
   * Apply snapping. Grid first, then points -- a nearby existing point beats
   * the grid, because welding to something the user can see matters more than
   * landing on an invisible lattice.
   */
  private snap(p: Pt, exclude?: NodeRef, excludeShape?: string): Pt {
    const s = this.store.state;
    let out = p;
    if (s.snapToGrid && s.gridStep > 0) out = snapTo(p, s.gridStep);

    if (s.snapToPoints) {
      const k = this.canvas.scale(s.camera);
      const threshold = 8 * k;
      let best = threshold;
      let hit: Pt | null = null;
      for (const shape of s.doc.shapes) {
        if (shape.id === excludeShape) continue;
        shape.subpaths.forEach((sp, spI) => {
          sp.nodes.forEach((n, i) => {
            if (exclude && exclude.shape === shape.id && exclude.sp === spI && exclude.i === i) return;
            const d = Math.hypot(n.pt[0] - p[0], n.pt[1] - p[1]);
            if (d < best) {
              best = d;
              hit = [n.pt[0], n.pt[1]];
            }
          });
        });
      }
      if (hit) out = hit;
    }
    return out;
  }

  private hitOf(e: PointerEvent | MouseEvent): {
    kind: string;
    ref: NodeRef | null;
    shape: string | null;
    seg: number | null;
  } | null {
    const t = e.target as Element | null;
    const kind = t?.getAttribute?.('data-hit');
    if (!kind || !t) return null;
    const shape = t.getAttribute('data-shape');
    if (kind === 'outline' || !shape) return { kind, shape, ref: null, seg: null };
    const segAttr = t.getAttribute('data-seg');
    return {
      kind,
      shape,
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
      this.store.checkpoint();
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
      this.store.checkpoint();
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
      this.store.checkpoint();
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
      this.store.checkpoint();
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
        this.store.update((st) => {
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
        this.store.update((st) => {
          const sp = findShape(st.doc, d.ref.shape)?.subpaths[d.ref.sp];
          // The node index matters as much as the subpath: an undo mid-drag can
          // shorten the path under us, and `moveHandle` would dereference it.
          if (!sp?.nodes[d.ref.i]) return;
          moveHandle(sp, d.ref.i, d.which, this.snap(p, d.ref), d.breakPair);
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
        this.store.update((st) => {
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
        this.store.update((st) => {
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
        this.store.update((st) => {
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
        this.store.update((st) => {
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

    // A create drag that never grew past nothing opened no batch, so there is
    // none to close -- and the document is untouched, as it should be. That is
    // now recorded rather than inferred: see `batchOpen`.
    this.closeBatch();

    this.drag = { kind: 'none' };
    if (this.canvas.overlay.hasPointerCapture(e.pointerId)) {
      this.canvas.overlay.releasePointerCapture(e.pointerId);
    }
    this.schedule();
  };

  /** Abandon the gesture, leaving the document as it was before the press. */
  private abortDrag(): void {
    const had = this.batchOpen;
    this.closeBatch();
    if (had) this.store.rollback();
    this.drag = { kind: 'none' };
    this.extras.marquee = null;
    this.schedule();
  }

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
        const shape = makeShape([build()], nextId(d.tool));
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
   * Force the selected subpaths onto their own best-fit circles.
   *
   * Whole subpaths rather than loose nodes: circularising some of a path's
   * nodes would leave the segments joining them to the rest built from a circle
   * they are not on, which is a worse drawing than either choice on its own.
   */
  circulariseSelection(): boolean {
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
        const shape = makeShape([
          { nodes: [makeNode(snapped)], closed: false },
        ]);
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
      this.store.endBatch();
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
    const wasDrawing = this.penTarget !== null;
    this.penTarget = null;
    this.extras.penFrom = null;
    this.extras.penTo = null;

    if (wasDrawing) this.pruneDegenerate();
    this.schedule();
  }

  /** Drop subpaths with fewer than two nodes, and shapes left with none. */
  private pruneDegenerate(): void {
    const s = this.store.state;
    const needed = s.doc.shapes.some(
      (sh) => sh.subpaths.some((sp) => sp.nodes.length < 2) || sh.subpaths.length === 0,
    );
    if (!needed) return;

    this.store.update((st) => {
      for (const sh of st.doc.shapes) sh.subpaths = sh.subpaths.filter((sp) => sp.nodes.length >= 2);
      st.doc.shapes = st.doc.shapes.filter((sh) => sh.subpaths.length > 0);
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

    // Everything below is a bare key. Ctrl+E belongs to the source drawer and
    // Ctrl+R to the browser; letting them through here switched the tool as a
    // silent side effect of both.
    if (mod) return;

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
