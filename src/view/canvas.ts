/**
 * The drawing surface: two stacked `<svg>` elements sharing one camera.
 *
 *   artwork  the document itself, one `<path>` per shape
 *   overlay  grid, anchors, handles, marquee -- everything that is not artwork
 *
 * Keeping them apart is what makes dragging cheap. A handle drag rewrites only
 * overlay attributes plus the one `d` of the shape being edited; it never
 * rebuilds the document DOM. The sigla prototype conflated the two and
 * reconstructed the entire SVG on every pointermove, which is invisible at 40
 * nodes and hopeless at 2000.
 *
 * Hit-testing rides on the overlay: each interactive element carries `data-hit`
 * and its address, so `event.target` answers "what did I grab?" with no
 * geometry at all.
 */

import { continuityOf, segmentAsCubic, segmentCount } from '../core/types';
import { bendHandlePos, bendOf } from '../core/bend';
import type { Doc, Pt, Shape, Subpath, ViewBox } from '../core/types';
import { serialisePath } from '../core/serialise';
import type { EditorState } from '../model/store';
import { nodeKey } from '../model/doc';
import { latentHandle } from '../model/ops';
import { CORNER_PARTS, TRANSFORM_PARTS, handlePoint } from '../model/transform';
import type { TransformPart } from '../model/transform';
import type { Box } from '../core/bezier';
import { Pool, setAttrs, svg } from './dom';
import { docPerPixel, gridDisplayFor, viewBoxAttr } from './viewport';

/** Transient things the tools want drawn this frame. */
export interface OverlayExtras {
  marquee?: Box | null;
  /** Point on an outline the pointer is hovering, shown as an insertion ghost. */
  insertAt?: Pt | null;
  /** Rubber-band preview while the pen tool is placing a node. */
  penFrom?: Pt | null;
  penTo?: Pt | null;
  /** Bounding box of the current selection, drawn with its transform handles. */
  selectionBox?: Box | null;
  /**
   * The snap lattice's phase, from pixel fit.
   *
   * Passed in rather than derived here. The controller freezes the phase for the
   * duration of a gesture (see `Controller.phase`), and a grid that recomputed
   * it would drift away from the lattice being snapped to at exactly the moment
   * a drag is under way -- which is §9's defect, half a pixel wide.
   */
  gridPhase?: number;
}

/**
 * How far outside the selection's true bounds the box and its handles are
 * drawn, in screen pixels.
 *
 * Not decoration. A shape's own nodes sit on its bounding box by definition, so
 * a rectangle's corner anchor and its north-west scale handle would land on
 * exactly the same point. Handles are in front of anchors in paint order and
 * would win every click, which would make the corners of a rectangle
 * undraggable. Six pixels puts them clear of each other.
 */
const BOX_PAD = 6;

/** Drawn size of a scale handle, in screen pixels. */
const HANDLE_SIZE = 8;

/**
 * Side of the invisible square that rotates, placed with its inner corner on
 * the box's corner so the whole of it lies outside.
 *
 * Outside, not centred. Centred was the first attempt and it took every click
 * aimed at a corner node: a 26 pixel square centred on the corner of a
 * rectangle covers that rectangle's corner anchor completely, so the shape
 * could be rotated and its corner could never be dragged again. Sitting the
 * zone diagonally outside leaves the anchor clear, and puts rotation where
 * every other editor puts it.
 */
const ROTOR_SIZE = 22;

export class Canvas {
  readonly artwork: SVGSVGElement;
  readonly overlay: SVGSVGElement;

  private artLayer: SVGGElement;
  /** Tracing image, under everything. Never part of the exported document. */
  private backdropEl: SVGImageElement;
  private gridMinor: SVGPathElement;
  private gridMajor: SVGPathElement;
  private axes: SVGPathElement;
  /** Everything outside the document, dimmed. */
  private docShade: SVGPathElement;
  /** The document's own edge: what the exported viewBox will be. */
  private docEdge: SVGRectElement;

  private outlines: Pool<'path'>;
  private handleLines: Pool<'line'>;
  private handleDots: Pool<'circle'>;
  private anchors: Pool<'rect'>;
  private bendDots: Pool<'circle'>;
  private chrome: SVGGElement;
  private marquee: SVGRectElement;
  private selBox: SVGRectElement;
  private insertDot: SVGCircleElement;
  private penLine: SVGPathElement;
  /** Fixed set: eight scale handles and four rotation zones, made once. */
  private tRotors: { part: TransformPart; el: SVGRectElement }[] = [];
  private tHandles: { part: TransformPart; el: SVGRectElement }[] = [];

  /** Lattice phase for this frame, handed in by whoever owns the gesture. */
  private gridPhase = 0;

  /** Live `<path>` per shape id, so we only touch `d` when it changes. */
  private shapeEls = new Map<string, SVGPathElement>();

  constructor(private root: HTMLElement) {
    this.artwork = svg('svg', { class: 'artwork' });
    this.overlay = svg('svg', { class: 'overlay' });
    this.artLayer = svg('g');
    // First child, so it paints behind every shape. The export is built from
    // the model rather than from this DOM, so nothing here can reach a file.
    this.backdropEl = svg('image', { class: 'backdrop' });
    this.backdropEl.setAttribute('display', 'none');
    this.artwork.append(this.backdropEl, this.artLayer);

    // Order is paint order: grid at the back, anchors in front of handles.
    this.gridMinor = svg('path', { class: 'grid-minor' });
    this.gridMajor = svg('path', { class: 'grid-major' });
    this.axes = svg('path', { class: 'grid-axis' });
    this.docShade = svg('path', { class: 'doc-shade' });
    this.docEdge = svg('rect', { class: 'doc-edge' });
    const outlineLayer = svg('g', { class: 'outlines' });
    const handleLayer = svg('g', { class: 'handles' });
    const anchorLayer = svg('g', { class: 'anchors' });
    this.chrome = svg('g', { class: 'chrome' });

    this.overlay.append(
      this.gridMinor,
      this.gridMajor,
      this.axes,
      // Over the grid and under everything else, so the dimming falls on the
      // lattice and on any artwork that has strayed off the page.
      this.docShade,
      this.docEdge,
      outlineLayer,
      handleLayer,
      anchorLayer,
      this.chrome,
    );

    this.outlines = new Pool(outlineLayer, 'path');
    this.handleLines = new Pool(handleLayer, 'line');
    this.handleDots = new Pool(handleLayer, 'circle');
    this.anchors = new Pool(anchorLayer, 'rect');
    this.bendDots = new Pool(handleLayer, 'circle');

    this.marquee = svg('rect', { class: 'marquee' });
    this.selBox = svg('rect', { class: 'sel-box' });
    this.insertDot = svg('circle', { class: 'insert-dot' });
    this.penLine = svg('path', { class: 'pen-preview' });
    this.chrome.append(this.selBox, this.marquee, this.insertDot, this.penLine);

    /* Rotors before handles, so the handle wins the middle of a corner and the
       rotor keeps the ring around it. Both are in `chrome`, which is the last
       overlay layer, so they are also in front of the anchors: a transform
       handle overlapping a node has to be the thing you grabbed, or the box
       would be decoration. */
    for (const part of CORNER_PARTS) {
      const el = svg('rect', { class: 'rotor', 'data-hit': 'rotate', 'data-part': part });
      this.tRotors.push({ part, el });
      this.chrome.appendChild(el);
    }
    for (const part of TRANSFORM_PARTS) {
      const el = svg('rect', { class: 'thandle', 'data-hit': 'scale', 'data-part': part });
      this.tHandles.push({ part, el });
      this.chrome.appendChild(el);
    }

    this.root.append(this.artwork, this.overlay);
  }

  setCamera(camera: ViewBox): void {
    const vb = viewBoxAttr(camera);
    this.artwork.setAttribute('viewBox', vb);
    this.overlay.setAttribute('viewBox', vb);
    // Both must letterbox identically or the layers will drift apart.
    this.artwork.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.overlay.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }

  get widthPx(): number {
    return this.overlay.getBoundingClientRect().width;
  }

  /** Document units per screen pixel, for keeping chrome a constant size. */
  scale(camera: ViewBox): number {
    return docPerPixel(this.overlay, camera);
  }

  /* ------------------------------------------------------------- artwork */

  renderArtwork(doc: Doc, state: EditorState): void {
    this.renderBackdrop(state);
    const seen = new Set<string>();

    for (const shape of doc.shapes) {
      seen.add(shape.id);
      let path = this.shapeEls.get(shape.id);
      if (!path) {
        path = svg('path');
        this.shapeEls.set(shape.id, path);
        this.artLayer.appendChild(path);
      }
      // Full precision on screen; `decimals` only governs exported text.
      setAttrs(path, {
        d: serialisePath(shape.subpaths, { decimals: 6 }),
        // The shape's own fill, or none. This used to substitute a grey for
        // shapes whose fill is `none`, which made an unfilled shape and a grey
        // one indistinguishable and left no way to see what the file would say.
        fill: state.filled ? shape.style.fill : 'none',
        'fill-rule': shape.style.fillRule,
        stroke: shape.style.stroke,
        /* The shape's real width, in document units. It used to be multiplied
           by `scale()`, which pinned every stroke to a constant number of screen
           pixels: the drawing did not thicken as you zoomed in, and a shape set
           to width 4 looked identical to one set to width 1. That was tolerable
           while every shape was a hairline preview and nothing could change the
           width; it stopped being tolerable the moment the Style panel could.
           §17's rule is that overlay chrome holds its screen size and the
           drawing scales -- this is the drawing. */
        'stroke-width': shape.style.strokeWidth,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      });
    }

    for (const [id, elem] of this.shapeEls) {
      if (!seen.has(id)) {
        elem.remove();
        this.shapeEls.delete(id);
      }
    }
  }

  private renderBackdrop(state: EditorState): void {
    const b = state.backdrop;
    if (!b || !b.visible) {
      this.backdropEl.setAttribute('display', 'none');
      return;
    }
    this.backdropEl.removeAttribute('display');
    setAttrs(this.backdropEl, {
      href: b.src,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      opacity: b.opacity,
      // Placement already carries the aspect ratio, so letterboxing here would
      // fight the numbers in the panel.
      preserveAspectRatio: 'none',
    });
  }

  /* ------------------------------------------------------------- overlay */

  renderOverlay(state: EditorState, extras: OverlayExtras = {}): void {
    this.gridPhase = extras.gridPhase ?? 0;
    const k = this.scale(state.camera);
    this.renderGrid(state, k);
    this.renderDocEdge(state);
    this.renderNodes(state, k);
    this.renderChrome(extras, k);
  }

  /**
   * Draw the document's own edge, and dim everything outside it.
   *
   * This is the `viewBox` the export writes, and until it was drawn there was
   * nothing on screen that said where it was. You could draw a shape in the
   * corner of a 88 by 64 document, export it, and find the drawing occupying a
   * fifth of the file with no clue as to why: the grid runs to the horizon and
   * looks exactly the same inside the page and outside it.
   *
   * The shade is one path of two rectangles with `fill-rule: evenodd`, so the
   * document is a hole in a sheet covering the camera. Filled elements in the
   * overlay would otherwise swallow clicks, which is why the stylesheet turns
   * pointer events off for both.
   */
  private renderDocEdge(state: EditorState): void {
    const vb = state.doc.viewBox;
    const cam = state.camera;
    setAttrs(this.docEdge, { x: vb.x, y: vb.y, width: Math.max(0, vb.w), height: Math.max(0, vb.h) });

    // Generous margins on the outer rectangle: it only has to cover the camera,
    // and growing it costs nothing while a rounding error at the edge shows.
    const m = Math.max(cam.w, cam.h);
    const outer = `M${cam.x - m} ${cam.y - m}H${cam.x + cam.w + m}V${cam.y + cam.h + m}H${cam.x - m}Z`;
    const hole = `M${vb.x} ${vb.y}H${vb.x + vb.w}V${vb.y + vb.h}H${vb.x}Z`;
    this.docShade.setAttribute('d', `${outer}${hole}`);
  }

  private renderGrid(state: EditorState, k: number): void {
    const cam = state.camera;

    if (!state.showGrid) {
      this.gridMinor.setAttribute('d', '');
      this.gridMajor.setAttribute('d', '');
      this.axes.setAttribute('d', '');
      return;
    }

    // The axes are real coordinates rather than a claim about snapping, so they
    // stay even when there is no lattice to draw.
    setAttrs(this.axes, {
      d: `M${cam.x} 0H${cam.x + cam.w}M0 ${cam.y}V${cam.y + cam.h}`,
      'stroke-width': k * 1.5,
    });

    // Driven by the step the tools snap to, so every line drawn here is a
    // position the pointer can actually land on. See `gridDisplayFor`.
    const g = gridDisplayFor(state.gridStep, cam, this.widthPx);
    if (!g) {
      this.gridMinor.setAttribute('d', '');
      this.gridMajor.setAttribute('d', '');
      return;
    }

    // One `<path>` of many subpaths rather than one element per line. yqnn
    // emits a `<rect>` per gridline; at a few hundred lines that is a few
    // hundred elements to lay out on every camera change.
    const minorD: string[] = [];
    const majorD: string[] = [];
    const round = (v: number): number => Math.round(v * 1e10) / 1e10;

    /* Pixel-fit shifts the lattice the tools snap to, so this has to shift by
       the same amount. The value comes from the controller, which is the only
       thing that knows whether a gesture is holding it fixed. */
    const phase = this.gridPhase;

    // Index lines by whole multiples of the step rather than accumulating a
    // float. Major-line selection is then exact integer arithmetic, and index 0
    // is the origin, so major lines cannot drift off the axes at odd zooms.
    const ix0 = Math.ceil((cam.x - phase) / g.step);
    const ix1 = Math.floor((cam.x + cam.w - phase) / g.step);
    for (let i = ix0; i <= ix1; i++) {
      const line = `M${round(i * g.step + phase)} ${cam.y}V${cam.y + cam.h}`;
      (i % g.majorEvery === 0 ? majorD : minorD).push(line);
    }
    const iy0 = Math.ceil((cam.y - phase) / g.step);
    const iy1 = Math.floor((cam.y + cam.h - phase) / g.step);
    for (let i = iy0; i <= iy1; i++) {
      const line = `M${cam.x} ${round(i * g.step + phase)}H${cam.x + cam.w}`;
      (i % g.majorEvery === 0 ? majorD : minorD).push(line);
    }

    setAttrs(this.gridMinor, { d: minorD.join(''), 'stroke-width': k });
    setAttrs(this.gridMajor, { d: majorD.join(''), 'stroke-width': k });
  }

  private renderNodes(state: EditorState, k: number): void {
    this.outlines.begin();
    this.handleLines.begin();
    this.handleDots.begin();
    this.anchors.begin();
    this.bendDots.begin();

    const anchorSize = 7 * k;
    const dotR = 3.5 * k;
    const sel = state.selection;

    for (const shape of state.doc.shapes) {
      const shapeSelected = sel.shapes.has(shape.id);

      // A hit target for the outline itself: invisible, generously wide, and
      // it is what "drag the body" and "click to insert" grab.
      this.outlines.next({
        d: serialisePath(shape.subpaths, { decimals: 6 }),
        'stroke-width': 10 * k,
        'data-hit': 'outline',
        'data-shape': shape.id,
        class: shapeSelected ? 'outline selected' : 'outline',
      });

      shape.subpaths.forEach((sp, spI) => {
        sp.nodes.forEach((n, i) => {
          const key = nodeKey({ shape: shape.id, sp: spI, i });
          const isSel = sel.nodes.has(key) || shapeSelected;

          if (state.showHandles && isSel) {
            for (const which of ['in', 'out'] as const) {
              const real = which === 'in' ? n.hIn : n.hOut;
              // A straight segment has no handle, but selecting its node should
              // still offer one to pull out -- otherwise a shape drawn entirely
              // with straight segments looks like it cannot be curved at all.
              // The ghost sits exactly where `setSegmentCurved` would put it.
              const h = real ?? latentHandle(sp, i, which);
              if (!h) continue;

              /* A handle you cannot separate from its own node is not a control,
                 it is clutter. Markers are drawn at a fixed size on screen, so
                 zooming out shrinks the drawing while they stay put: a shape
                 that fits in 150 px ends up buried under its own anchors and
                 handles, which is what "the overlay goes funny at low zoom"
                 turned out to be. Below the anchor's own width there is nothing
                 left to aim at, so the handle is not worth drawing. */
              const reach = Math.hypot(h[0] - n.pt[0], h[1] - n.pt[1]);
              if (reach < anchorSize) continue;

              this.handleLines.next({
                x1: n.pt[0],
                y1: n.pt[1],
                x2: h[0],
                y2: h[1],
                'stroke-width': k,
                class: real ? 'handle-line' : 'handle-line latent',
              });
              this.handleDots.next({
                cx: h[0],
                cy: h[1],
                r: real ? dotR : dotR * 0.85,
                'stroke-width': k,
                'data-hit': which,
                'data-shape': shape.id,
                'data-sp': spI,
                'data-i': i,
                class: real ? 'handle-dot' : 'handle-dot latent',
              });
            }
          }

          // Squares for corners, rounded for smooth: the node's continuity is
          // readable at a glance instead of hidden in a properties panel. It is
          // read off the handles every frame, so the marker cannot claim
          // something the geometry does not back up.
          const r = continuityOf(n) === 'corner' ? 0 : anchorSize / 2;
          this.anchors.next({
            x: n.pt[0] - anchorSize / 2,
            y: n.pt[1] - anchorSize / 2,
            width: anchorSize,
            height: anchorSize,
            rx: r,
            ry: r,
            'data-hit': 'anchor',
            'data-shape': shape.id,
            'data-sp': spI,
            'data-i': i,
            class: isSel ? 'anchor selected' : 'anchor',
          });
        });

        // One bend control per segment whose BOTH endpoints are selected. That
        // rule is the same one `Curve`/`Straighten` already use, so which
        // segment a control belongs to is never ambiguous.
        if (state.showHandles) {
          for (let seg = 0; seg < segmentCount(sp); seg++) {
            const aI = seg;
            const bI = (seg + 1) % sp.nodes.length;
            const both =
              shapeSelected ||
              (sel.nodes.has(nodeKey({ shape: shape.id, sp: spI, i: aI })) &&
                sel.nodes.has(nodeKey({ shape: shape.id, sp: spI, i: bI })));
            if (!both) continue;

            const bend = bendOf(sp.nodes[aI], sp.nodes[bI]);
            if (!bend) continue; // asymmetric: free handles are the truth here
            const at = bendHandlePos(sp.nodes[aI].pt, sp.nodes[bI].pt, bend);
            this.bendDots.next({
              cx: at[0],
              cy: at[1],
              r: 4.5 * k,
              'stroke-width': 1.5 * k,
              'data-hit': 'bend',
              'data-shape': shape.id,
              'data-sp': spI,
              'data-seg': seg,
              class: 'bend-dot',
            });
          }
        }
      });
    }

    this.bendDots.end();
    this.outlines.end();
    this.handleLines.end();
    this.handleDots.end();
    this.anchors.end();
  }

  private renderChrome(extras: OverlayExtras, k: number): void {
    const box = (elem: SVGRectElement, b: Box | null | undefined): void => {
      if (!b) {
        elem.setAttribute('display', 'none');
        return;
      }
      elem.removeAttribute('display');
      /* No `stroke-width` here. The marquee and the selection box carry
         `vector-effect: non-scaling-stroke`, which already means "one CSS pixel
         whatever the zoom", so multiplying by `k` scaled the width a second
         time: at 9 % zoom `k` is about 11, and 11 px of stroke dashed 4-on-3-off
         is the picket fence that started this. CSS owns the width for anything
         non-scaling; the code owns it for everything else. */
      setAttrs(elem, {
        x: Math.min(b.x0, b.x1),
        y: Math.min(b.y0, b.y1),
        width: Math.abs(b.x1 - b.x0),
        height: Math.abs(b.y1 - b.y0),
      });
    };

    box(this.marquee, extras.marquee);
    box(this.selBox, padded(extras.selectionBox, BOX_PAD * k));
    this.renderTransform(extras.selectionBox, k);

    if (extras.insertAt) {
      this.insertDot.removeAttribute('display');
      // Radius scales with the zoom so the dot stays 4 px; the width does not,
      // because `.insert-dot` is non-scaling. See `box` above.
      setAttrs(this.insertDot, { cx: extras.insertAt[0], cy: extras.insertAt[1], r: 4 * k });
    } else {
      this.insertDot.setAttribute('display', 'none');
    }

    if (extras.penFrom && extras.penTo) {
      this.penLine.removeAttribute('display');
      setAttrs(this.penLine, {
        d: `M${extras.penFrom[0]} ${extras.penFrom[1]}L${extras.penTo[0]} ${extras.penTo[1]}`,
      });
    } else {
      this.penLine.setAttribute('display', 'none');
    }
  }

  /**
   * Place the eight scale handles and the four rotation zones.
   *
   * Everything here is sized in document units scaled by `k`, so it stays a
   * constant size on screen. The handles are drawn on the padded box while the
   * controller does its arithmetic on the true one, which is why grabbing a
   * corner does not jump: the drag records the offset between the two at the
   * moment of the press.
   *
   * A selection with no height, such as a row of nodes on one line, hides the
   * handles that would only stretch it vertically. They would have nothing to
   * multiply and would sit on top of the ones that do.
   */
  private renderTransform(b: Box | null | undefined, k: number): void {
    const hide = (el: SVGElement): void => el.setAttribute('display', 'none');
    if (!b) {
      for (const { el } of this.tRotors) hide(el);
      for (const { el } of this.tHandles) hide(el);
      return;
    }

    const pad = padded(b, BOX_PAD * k)!;
    const flatX = Math.abs(b.x1 - b.x0) < 1e-9;
    const flatY = Math.abs(b.y1 - b.y0) < 1e-9;

    const place = (el: SVGRectElement, part: TransformPart, size: number): void => {
      const p = handlePoint(pad, part);
      el.removeAttribute('display');
      setAttrs(el, { x: p[0] - size / 2, y: p[1] - size / 2, width: size, height: size });
    };

    // Pushed outward by half its own size, which puts its inner corner exactly
    // on the box's corner and the rest of it in clear space.
    const rot = ROTOR_SIZE * k;
    for (const { part, el } of this.tRotors) {
      const c = handlePoint(pad, part);
      const x = c[0] + (part.includes('w') ? -rot / 2 : rot / 2);
      const y = c[1] + (part.includes('n') ? -rot / 2 : rot / 2);
      el.removeAttribute('display');
      setAttrs(el, { x: x - rot / 2, y: y - rot / 2, width: rot, height: rot });
    }
    for (const { part, el } of this.tHandles) {
      const useless = (flatY && (part === 'n' || part === 's')) || (flatX && (part === 'e' || part === 'w'));
      if (useless) hide(el);
      else place(el, part, HANDLE_SIZE * k);
    }
  }
}

/** The same box grown by `d` on every side. Used for drawn chrome only. */
function padded(b: Box | null | undefined, d: number): Box | null {
  if (!b) return null;
  return { x0: b.x0 - d, y0: b.y0 - d, x1: b.x1 + d, y1: b.y1 + d };
}

/** Sample a subpath's outline, used by marquee selection. */
export function subpathPoints(sp: Subpath, per = 8): Pt[] {
  const out: Pt[] = [];
  const n = segmentCount(sp);
  for (let i = 0; i < n; i++) {
    const c = segmentAsCubic(sp, i);
    for (let j = 0; j < per; j++) {
      const t = j / per;
      const m = 1 - t;
      out.push([
        m * m * m * c[0][0] + 3 * m * m * t * c[1][0] + 3 * m * t * t * c[2][0] + t * t * t * c[3][0],
        m * m * m * c[0][1] + 3 * m * m * t * c[1][1] + 3 * m * t * t * c[2][1] + t * t * t * c[3][1],
      ]);
    }
  }
  return out;
}

export const shapeIsInBox = (shape: Shape, b: Box): boolean =>
  shape.subpaths.some((sp) =>
    sp.nodes.some((n) => n.pt[0] >= b.x0 && n.pt[0] <= b.x1 && n.pt[1] >= b.y0 && n.pt[1] <= b.y1),
  );
