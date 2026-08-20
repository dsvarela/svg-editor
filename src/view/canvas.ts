/**
 * The drawing surface: two stacked `<svg>` elements sharing one camera.
 *
 *   artwork  the document itself, one `<path>` per shape
 *   overlay  grid, anchors, handles, marquee -- everything that is not artwork
 *
 * Keeping them apart is what makes dragging cheap. A handle drag rewrites only
 * overlay attributes plus the one `d` of the shape being edited; it never
 * rebuilds the document DOM. Conflating the two means reconstructing the whole
 * SVG on every pointermove, which is invisible at 40 nodes and hopeless at
 * 2000.
 *
 * Hit-testing rides on the overlay: each interactive element carries `data-hit`
 * and its address, so `event.target` answers "what did I grab?" with no
 * geometry at all.
 */

import { STROKE_CAP, STROKE_JOIN, continuityOf, segmentAsCubic, segmentCount } from '../core/types';
import type { Doc, Pt, Subpath, ViewBox } from '../core/types';
import type {
  Fillet,
} from '../model/corner';
import { PathCache } from './pathcache';
import type { EditorState } from '../model/store';
import {
  latentHandle,
} from '../model/ops';
import {
  cornerArcReach,
  cornerAt,
  filletAt,
} from '../model/corner';
import { keylinesFor } from '../model/keylines';
import type { Alignment } from '../model/smart';
import { serialisePath } from '../core/serialise';
import { CORNER_PARTS, TRANSFORM_PARTS, handlePoint } from '../model/transform';
import type { TransformPart } from '../model/transform';
import { cubicAt } from '../core/bezier';
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
  /** Index of the guide being dragged, so it can be drawn as the live one. */
  draggingGuide?: number | null;
  /** Alignment lines for this frame. Transient: they belong to the drag. */
  smart?: Alignment[];
  /** Angular-snap rays, in document coordinates. */
  rays?: { x1: number; y1: number; x2: number; y2: number }[];
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
 * How far clear of the corner its radius control sits, in screen pixels.
 *
 * For the reason `BOX_PAD` exists. A node's anchor is drawn centred on the corner
 * and is 7 px across, and the anchor layer paints in front of the handle layer --
 * so a control placed at the corner, or at the arc of a small radius, is covered by
 * the anchor and can never be pressed.
 *
 * Clearing the anchor is the floor, not the target. At 11 the two shapes cleared
 * each other by 3.5 px and still read as one cluster, which is a different failure
 * from being unpressable: you could hit it and could not tell it apart from the
 * node it belongs to.
 *
 * **Sixteen was recorded here as leaving about 8 px of gap, and measured 4.6.**
 * The arithmetic behind the 8 subtracted the anchor's half-width. On a right
 * angle the bisector points at the anchor's *corner*, which is half a diagonal
 * out, and the control is a diamond whose near vertex is half its width in:
 * 16 − 8.5/2·√2 − 10.8/2 = 4.6, read off the rendered boxes at 1400%, 1800% and
 * 2200% zoom, where the centre distance is 16.00 every time. Twenty gives 8.6,
 * which is what the paragraph above always meant.
 *
 * Constant in screen pixels at every zoom, by design: `k` converts it to
 * document units at the point of use. A *rounded* corner's control sits further
 * out again, past its own arc, so it travels away from the node as you zoom in
 * rather than toward it.
 *
 * Shared with `Controller`, which subtracts it again to read a radius back off the
 * pointer. Two numbers here would be a control that does not stay under the finger.
 */
export const CORNER_DOT_PX = 20;

/**
 * Side of the invisible square that rotates, placed with its inner corner on
 * the box's corner so the whole of it lies outside.
 *
 * Outside, not centred. A 26 pixel square centred on the corner of a rectangle
 * covers that rectangle's corner anchor completely, so the shape would rotate
 * and its corner could never be dragged again. Sitting the zone diagonally
 * outside leaves the anchor clear, and puts rotation where every other editor
 * puts it.
 */
const ROTOR_SIZE = 22;

/**
 * How many node markers the overlay will draw before it draws none.
 *
 * See `renderNodes` for the reasoning and the measurement behind the number.
 */
export const MARKER_CAP = 2000;

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
  /** The icon keyline grid. Derived from the viewBox; never in the export. */
  private keylineLive: SVGPathElement;
  private keylineShapes: SVGPathElement;
  /** Placed guides, and the fat transparent strips that make them grabbable. */
  private guideLines: Pool<'line'>;
  private guideHits: Pool<'line'>;
  /** Alignment lines, drawn only while a drag is holding to one. */
  private smartLines: Pool<'line'>;
  /** Angular-snap rays: what the pointer will be held to, drawn so it is not a surprise. */
  private rayLines: Pool<'line'>;

  /** Path data, rebuilt only for shapes whose geometry changed. */
  private paths = new PathCache();

  private outlines: Pool<'path'>;
  private handleLines: Pool<'line'>;
  private handleDots: Pool<'circle'>;
  private anchors: Pool<'rect'>;
  private bendDots: Pool<'circle'>;
  private cornerDots: Pool<'rect'>;

  /**
   * True when the last render had more markers in view than it would draw.
   *
   * Read by the readout, which says so. Markers disappearing with no
   * explanation is worse than markers being slow: the drawing is still there,
   * still selectable, still editable through the source drawer, and a person
   * who is not told will reasonably conclude the editor lost their nodes.
   */
  markersCapped = false;
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
    this.keylineLive = svg('path', { class: 'keyline-live' });
    this.keylineShapes = svg('path', { class: 'keyline' });
    // Under the page shading and the guides: rays are scaffolding, and there
    // are a lot of them at a small step.
    const rayLayer = svg('g', { class: 'rays' });
    const guideLayer = svg('g', { class: 'guides' });
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
      rayLayer,
      this.docShade,
      this.docEdge,
      // Over the page edge and under the artwork's outlines: a keyline is
      // something to draw against, so it must never sit on top of the drawing.
      this.keylineLive,
      this.keylineShapes,
      guideLayer,
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
    this.cornerDots = new Pool(handleLayer, 'rect');
    // Lines first, hit strips after, so a strip is in front of the line it
    // belongs to and a press anywhere on it reaches the same guide.
    this.guideLines = new Pool(guideLayer, 'line');
    this.guideHits = new Pool(guideLayer, 'line');
    this.smartLines = new Pool(guideLayer, 'line');
    this.rayLines = new Pool(rayLayer, 'line');

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
      // Full precision on screen; `decimals` only governs exported text. The
      // string comes from the cache, which rebuilds it only when the geometry
      // behind it moved -- see `view/pathcache.ts` for why that is asked as a
      // question about the numbers rather than answered by a flag.
      setAttrs(path, {
        d: this.paths.get(shape.id, shape.subpaths),
        // The shape's own fill, or none. Never a stand-in grey for a fill of
        // `none`: that makes an unfilled shape and a grey one indistinguishable
        // and leaves no way to see what the file would say.
        fill: state.filled ? shape.style.fill : 'none',
        'fill-rule': shape.style.fillRule,
        stroke: shape.style.stroke,
        /* The shape's real width, in document units, and not multiplied by
           `scale()`. Multiplying pins every stroke to a constant number of
           screen pixels, so the drawing does not thicken as you zoom in and a
           shape set to width 4 looks identical to one set to width 1. §17's
           rule is that overlay chrome holds its screen size and the drawing
           scales -- this is the drawing. */
        'stroke-width': shape.style.strokeWidth,
        'stroke-linejoin': STROKE_JOIN,
        'stroke-linecap': STROKE_CAP,
        /* Written always, not only when it is below 1: `setAttrs` sets what it
           is given, so leaving it out on the way back up to opaque would leave
           the last value on the element and a shape would never come back. */
        opacity: shape.style.opacity,
        /* Wireframe is done with a class rather than by rewriting the fill and
           stroke here, because CSS beats presentation attributes: the shape's
           own values stay on the element, exactly as the export will write
           them, and are simply overridden while the switch is on. */
        class: state.wireframe ? 'wire' : '',
      });
    }

    for (const [id, elem] of this.shapeEls) {
      if (!seen.has(id)) {
        elem.remove();
        this.shapeEls.delete(id);
      }
    }

    /* `doc.shapes` is the paint order, so the elements have to be in it. Creating
       them only ever appends, which draws the document in the order its shapes
       were first seen -- right until something reorders the array, and two things
       do: grouping gathers a group's shapes into one run, and the Order buttons
       move a shape through it. Both left the screen disagreeing with the export.

       One pass, writing only where the element is already wrong: at step `i`
       every earlier position is correct, so the element belonging at `i` can only
       be later in the list, and `insertBefore` moves it back. */
    doc.shapes.forEach((shape, i) => {
      const el = this.shapeEls.get(shape.id);
      if (el && this.artLayer.childNodes[i] !== el) {
        this.artLayer.insertBefore(el, this.artLayer.childNodes[i] ?? null);
      }
    });
    this.paths.keep(seen);
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
    this.renderKeylines(state);
    this.renderGuides(state, extras);
    this.renderNodes(state, k);
    this.renderChrome(extras, k);
  }

  /**
   * Draw the document's own edge, and dim everything outside it.
   *
   * This is the `viewBox` the export writes, and nothing else on screen says
   * where it is: the grid runs to the horizon and looks exactly the same inside
   * the page and outside it. Undrawn, a shape in the corner of an 88 by 64
   * document exports occupying a fifth of the file with no clue as to why.
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

  /**
   * Draw the keyline grid, when it is on.
   *
   * Two elements rather than one, because the live area is a different claim
   * from the keylines: it says where the drawing has to stay, and they say what
   * proportions to draw it in. Drawn in document units with a non-scaling
   * stroke, like everything else in the overlay, so the lines stay hairline at
   * any zoom.
   */
  private renderKeylines(state: EditorState): void {
    const k = state.showKeylines ? keylinesFor(state.doc.viewBox) : null;
    if (!k) {
      this.keylineLive.setAttribute('d', '');
      this.keylineShapes.setAttribute('d', '');
      return;
    }
    this.keylineLive.setAttribute('d', serialisePath([k.live]));
    this.keylineShapes.setAttribute('d', serialisePath(k.shapes));
  }

  /**
   * Draw the placed guides, spanning the camera rather than the page.
   *
   * A guide is infinite, and drawing it to the page's edge would make it look
   * like a property of the page -- which is exactly what it is not. Redrawn on
   * every camera change for the same reason the grid is: the line has to reach
   * both edges of whatever is on screen.
   */
  private renderGuides(state: EditorState, extras: OverlayExtras): void {
    this.guideLines.begin();
    this.guideHits.begin();
    if (state.showGuides) {
      const c = state.camera;
      state.guides.forEach((g, i) => {
        const ends =
          g.axis === 'x'
            ? { x1: g.at, y1: c.y, x2: g.at, y2: c.y + c.h }
            : { x1: c.x, y1: g.at, x2: c.x + c.w, y2: g.at };
        const cls = extras.draggingGuide === i ? 'guide dragging' : 'guide';
        setAttrs(this.guideLines.next(ends), { class: cls });
        setAttrs(this.guideHits.next(ends), {
          class: `guide-hit ${g.axis}`,
          'data-hit': 'guide',
          'data-guide': i,
        });
      });
    }
    this.guideLines.end();
    this.guideHits.end();

    /* Alignment lines. Pooled in the same layer, drawn after the placed guides
       so a transient line is not hidden under a permanent one that happens to
       be in the same place -- which is exactly when both are interesting. */
    this.smartLines.begin();
    for (const a of extras.smart ?? []) {
      this.smartLines.next(
        a.axis === 'x'
          ? { x1: a.at, y1: a.from, x2: a.at, y2: a.to }
          : { x1: a.from, y1: a.at, x2: a.to, y2: a.at },
      ).setAttribute('class', `smart ${a.kind}`);
    }
    this.smartLines.end();

    this.rayLines.begin();
    for (const r of extras.rays ?? []) this.rayLines.next(r).setAttribute('class', 'ray');
    this.rayLines.end();
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
    this.cornerDots.begin();

    const anchorSize = 7 * k;
    const dotR = 3.5 * k;
    const sel = state.selection;

    /* Two rules, in this order. Off-screen markers are not drawn, with a
       margin of the marker's own size so one straddling the edge still appears.
       Above `MARKER_CAP` in view, none are: at 2 microseconds each, measured in
       Edge, the overlay's share of a render reaches 4 ms and stops fitting a
       frame.

       **All or none, never the first 2 000.** Which nodes you got would follow
       the order shapes are stored in, and read as the rest of the document
       having none.

       With markers off, nodes cannot be clicked at all, because the anchors are
       the hit targets. That is a real cost and the cap is still right: 23 454
       anchors over a 1600 px canvas is eight markers deep, so they could not be
       clicked accurately anyway. The readout says which state it is in. §28. */
    const cam = state.camera;
    const pad = anchorSize;
    const inView = (p: Pt): boolean =>
      p[0] >= cam.x - pad &&
      p[0] <= cam.x + cam.w + pad &&
      p[1] >= cam.y - pad &&
      p[1] <= cam.y + cam.h + pad;

    let inFrame = 0;
    for (const shape of state.doc.shapes) {
      for (const sp of shape.subpaths) {
        for (const n of sp.nodes) if (inView(n.pt)) inFrame++;
      }
    }
    this.markersCapped = inFrame > MARKER_CAP;
    const markers = !this.markersCapped;

    for (const shape of state.doc.shapes) {
      const shapeSelected = sel.shapes.has(shape.id);

      // A hit target for the outline itself: invisible, generously wide, and
      // it is what "drag the body" and "click to insert" grab.
      // The same string as the artwork's, and now literally the same string:
      // this was a second full serialisation of every shape on every render.
      this.outlines.next({
        d: this.paths.get(shape.id, shape.subpaths),
        'stroke-width': 10 * k,
        'data-hit': 'outline',
        'data-shape': shape.id,
        class: shapeSelected ? 'outline selected' : 'outline',
      });

      shape.subpaths.forEach((sp, spI) => {
        sp.nodes.forEach((n, i) => {
          const isSel = sel.nodes.has(n.id) || shapeSelected;
          const near = markers && inView(n.pt);

          if (state.showHandles && isSel && markers) {
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
              // A handle pulled far enough out to be on screen while its node
              // is not is still a control you can grab, so this asks about both
              // ends rather than only the node's.
              if (!near && !inView(h)) continue;

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
          if (!near) return;
          const r = continuityOf(n) === 'cusp' ? 0 : anchorSize / 2;
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
        if (state.showHandles && markers) {
          for (let seg = 0; seg < segmentCount(sp); seg++) {
            const aI = seg;
            const bI = (seg + 1) % sp.nodes.length;
            const both =
              shapeSelected ||
              (sel.nodes.has(sp.nodes[aI].id) && sel.nodes.has(sp.nodes[bI].id));
            if (!both) continue;

            /* The curve's own midpoint, taken from the segment and never from a
               bend. Gating this on `bendOf` succeeding hides the control on
               every segment whose handles are not symmetric, which is most of
               them in any drawing that has been edited. Both routes put the dot
               in the same place: `bendHandlePos` is the cubic at t = 0.5 for a
               bend, and this is the cubic at t = 0.5 for anything. */
            const at = cubicAt(segmentAsCubic(sp, seg), 0.5) as Pt;
            if (!inView(at)) continue;
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

        /* One corner control per roundable corner, sharp or already rounded.
           Placed on the bisector at the tangent point's own distance out, so the
           control sits where the arc begins and dragging it toward the corner
           makes the radius smaller -- which is the direction the thing under the
           pointer is actually moving.

           Nothing here stores a radius. A sharp corner is measured by `cornerAt`
           and a rounded one recovered by `filletAt`, so the control cannot claim
           a radius the geometry does not have. §48 of `docs/ARCHITECTURE.md`. */
        if (state.showHandles && markers) {
          for (let i = 0; i < sp.nodes.length; i++) {
            const lit = shapeSelected || sel.nodes.has(sp.nodes[i].id);
            const f = filletAt(sp, i);
            if (f) {
              // A fillet is drawn for a press on either of its two nodes, since
              // both are the corner as far as a person is concerned.
              if (!lit && !sel.nodes.has(sp.nodes[f.j].id)) continue;
              const dot = filletControl(sp, f, k);
              if (!dot || !inView(dot)) continue;
              this.cornerDots.next({
                ...cornerDiamond(dot, k),
                'data-hit': 'corner',
                'data-shape': shape.id,
                'data-sp': spI,
                'data-i': f.i,
                class: 'corner-dot rounded',
              });
              continue;
            }
            if (!lit) continue;
            const c = cornerAt(sp, i);
            if (typeof c === 'string') continue;
            // At the offset and no further: a sharp corner has no arc to sit on.
            const dot = alongBisector(c.at, c.u, c.v, CORNER_DOT_PX * k);
            if (!dot || !inView(dot)) continue;
            this.cornerDots.next({
              ...cornerDiamond(dot, k),
              'data-hit': 'corner',
              'data-shape': shape.id,
              'data-sp': spI,
              'data-i': i,
              class: 'corner-dot',
            });
          }
        }
      });
    }

    this.bendDots.end();
    this.cornerDots.end();
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


/**
 * A point `d` from `at`, along the bisector of the two directions `u` and `v`.
 *
 * `null` when the two are opposite, where there is no bisector to speak of and no
 * corner either. Both are unit vectors leaving `at`, so their sum points into the
 * corner and its length is what says how open the corner is.
 */
function alongBisector(at: Pt, u: Pt, v: Pt, d: number): Pt | null {
  const bx = u[0] + v[0];
  const by = u[1] + v[1];
  const len = Math.hypot(bx, by);
  if (len < 1e-9) return null;
  return [at[0] + (bx / len) * d, at[1] + (by / len) * d];
}

/** Drawn side of the corner control's square before it is turned, in screen pixels. */
const CORNER_SIDE = 7.5;

/**
 * The corner control's box, drawn as a diamond.
 *
 * **A diamond because the other two shapes are taken, and taken with meanings
 * that would clash.** A circle at `--measure` is the bend control, so a round
 * corner control is the same picture for a different tool. A square is worse: an
 * anchor is a square when its node is a cusp and a rounded square when it is
 * smooth, so a corner control drawn either of those ways spells the anchor's
 * sentence 16 px from an anchor saying something else. Turning the square 45
 * degrees leaves the tools distinct at a glance and keeps the corner control out
 * of the node vocabulary entirely.
 *
 * The turn is the only difference between the two states' geometry. Sharp and
 * rounded differ by fill, in `styles.css`, so one tool cannot read as two.
 */
function cornerDiamond(at: Pt, k: number): Record<string, string | number> {
  const side = CORNER_SIDE * k;
  return {
    x: at[0] - side / 2,
    y: at[1] - side / 2,
    width: side,
    height: side,
    transform: `rotate(45 ${at[0]} ${at[1]})`,
    'stroke-width': 1.5 * k,
  };
}

/**
 * Where a rounded corner's control goes: on the bisector, at the arc plus the offset.
 *
 * The two side directions come from the tangent points, so this needs no stored
 * radius. `cornerArcReach` is the same function the controller inverts, which is
 * what keeps the control under the pointer through a drag.
 */
function filletControl(sp: Subpath, f: Fillet, k: number): Pt | null {
  const a = sp.nodes[f.i]?.pt;
  const b = sp.nodes[f.j]?.pt;
  if (!a || !b) return null;
  const dir = (p: Pt): Pt | null => {
    const dx = p[0] - f.at[0];
    const dy = p[1] - f.at[1];
    const len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : [dx / len, dy / len];
  };
  const u = dir(a);
  const v = dir(b);
  if (!u || !v) return null;
  const cos = Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1]));
  const half = Math.acos(cos) / 2;
  return alongBisector(f.at, u, v, CORNER_DOT_PX * k + cornerArcReach(f.radius, half));
}
