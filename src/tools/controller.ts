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
  nodeKey,
  parseNodeKey,
  selectedShapes,
  selectionBBox,
} from '../model/doc';
import type { HandlePart, NodeRef } from '../model/doc';
import {
  alignNodes,
  closeSubpath,
  deleteNode,
  distributeNodes,
  moveAnchor,
  moveHandle,
  nearestOnPath,
  setContinuity,
  setSegmentBend,
  segmentBend,
  setSegmentCurved,
  snap as snapTo,
  splitSegment,
  transformShape,
} from '../model/ops';
import type { AlignMode } from '../model/ops';
import type { Store } from '../model/store';
import type { Canvas, OverlayExtras } from '../view/canvas';
import { latentHandle, shapeIsInBox } from '../view/canvas';
import { bendFromPoint } from '../core/bend';
import type { Bend } from '../core/bend';
import { fitAspect, screenToDoc, zoomAt } from '../view/viewport';

type DragKind =
  | { kind: 'none' }
  | { kind: 'pan'; client: Pt; camera: Pt; k: number }
  | { kind: 'marquee'; from: Pt }
  | { kind: 'anchor'; refs: NodeRef[]; grabbed: NodeRef; offset: Pt }
  | { kind: 'handle'; ref: NodeRef; which: 'in' | 'out'; breakPair: boolean }
  | { kind: 'body'; shapes: string[]; last: Pt }
  | { kind: 'pen'; ref: NodeRef }
  | { kind: 'bend'; shape: string; sp: number; seg: number; looseness: number };

export class Controller {
  private drag: DragKind = { kind: 'none' };
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
    ov.addEventListener('pointercancel', this.onUp);
    ov.addEventListener('dblclick', this.onDoubleClick);
    ov.addEventListener('wheel', this.onWheel, { passive: false });
    ov.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', () => {
      this.store.update((s) => {
        s.camera = fitAspect(s.camera, this.canvas.overlay);
      });
    });

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
  private snap(p: Pt, exclude?: NodeRef): Pt {
    const s = this.store.state;
    let out = p;
    if (s.snapToGrid && s.gridStep > 0) out = snapTo(p, s.gridStep);

    if (s.snapToPoints) {
      const k = this.canvas.scale(s.camera);
      const threshold = 8 * k;
      let best = threshold;
      let hit: Pt | null = null;
      for (const shape of s.doc.shapes) {
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
    const s = this.store.state;
    const p = this.pt(e);
    this.canvas.overlay.setPointerCapture(e.pointerId);

    // Middle button or space always pans, whatever the tool. Panning is
    // tracked in SCREEN coordinates: document coordinates under the cursor are
    // exactly what panning changes, so using them would feed back on itself.
    if (e.button === 1 || this.spaceDown) {
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
      this.store.beginBatch();
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
      this.store.beginBatch();
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
      this.store.beginBatch();
      this.store.checkpoint();
      // Alt held at the moment of grabbing breaks the pair for the whole drag.
      // Sampling it once, rather than per move, means letting go of Alt midway
      // does not suddenly snap the far handle back into line.
      this.drag = { kind: 'handle', ref: hit.ref, which: hit.kind, breakPair: e.altKey };
      return;
    }

    if (hit?.kind === 'outline' && hit.shape) {
      const id = hit.shape;
      this.store.update((st) => {
        if (!e.shiftKey && !st.selection.shapes.has(id)) st.selection = emptySelection();
        st.selection.shapes.add(id);
      });
      this.store.beginBatch();
      this.store.checkpoint();
      this.drag = { kind: 'body', shapes: [...this.store.state.selection.shapes], last: p };
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

      case 'body': {
        const d = this.drag;
        const delta: Pt = [p[0] - d.last[0], p[1] - d.last[1]];
        d.last = p;
        this.store.update((st) => {
          for (const id of d.shapes) {
            const shape = findShape(st.doc, id);
            if (shape) transformShape(shape, translate(delta[0], delta[1]));
          }
        });
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

    if (this.drag.kind !== 'none' && this.drag.kind !== 'pan' && this.drag.kind !== 'marquee') {
      this.store.endBatch();
    }

    this.drag = { kind: 'none' };
    if (this.canvas.overlay.hasPointerCapture(e.pointerId)) {
      this.canvas.overlay.releasePointerCapture(e.pointerId);
    }
    this.schedule();
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const s = this.store.state;
    const p = this.pt(e);
    const hit = this.hitOf(e);

    // Double-clicking an anchor cycles its continuity. Each step is a real edit
    // to the handles, so the cycle is visible rather than a hidden mode change.
    if (hit?.kind === 'anchor' && hit.ref) {
      const ref = hit.ref;
      this.store.edit((st) => {
        const sp = findShape(st.doc, ref.shape)?.subpaths[ref.sp];
        if (!sp?.nodes[ref.i]) return;
        const order = ['corner', 'smooth', 'symmetric'] as const;
        const cur = continuityOf(sp.nodes[ref.i]);
        setContinuity(sp, ref.i, order[(order.indexOf(cur) + 1) % order.length]);
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

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.pt(e);
    const factor = Math.pow(1.0015, e.deltaY);
    this.store.update((st) => {
      st.camera = zoomAt(st.camera, factor, p);
    });
  };

  /* ------------------------------------------------------------------ pen */

  /** The subpath the pen is extending, or `null` if it no longer exists. */
  private penSubpath(): Subpath | null {
    if (!this.penTarget) return null;
    return findShape(this.store.state.doc, this.penTarget.shape)?.subpaths[this.penTarget.sp] ?? null;
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

    this.store.beginBatch();
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
      if (e.shiftKey) this.store.redo();
      else this.store.undo();
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
        this.finishPen();
        this.store.update((st) => (st.selection = emptySelection()));
        return;
      }
      case 'Enter': {
        this.finishPen();
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

  deleteSelection(): void {
    const s = this.store.state;
    if (s.selection.shapes.size > 0) {
      this.store.edit((st) => {
        st.doc.shapes = st.doc.shapes.filter((sh) => !st.selection.shapes.has(sh.id));
        st.selection = emptySelection();
      });
      return;
    }
    const refs = [...s.selection.nodes].map(parseNodeKey);
    if (!refs.length) return;
    this.store.edit((st) => {
      // Delete from the highest index down so earlier indices stay valid.
      refs
        .sort((a, b) => b.i - a.i)
        .forEach((r) => {
          const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
          if (sp) deleteNode(sp, r.i);
        });
      st.doc.shapes.forEach((sh) => {
        sh.subpaths = sh.subpaths.filter((sp) => sp.nodes.length >= 2);
      });
      st.doc.shapes = st.doc.shapes.filter((sh) => sh.subpaths.length > 0);
      st.selection = emptySelection();
    });
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
    this.store.edit((st) => {
      for (const r of refs) {
        const sp = findShape(st.doc, r.shape)?.subpaths[r.sp];
        if (sp?.nodes[r.i]) setContinuity(sp, r.i, kind);
      }
    });
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
