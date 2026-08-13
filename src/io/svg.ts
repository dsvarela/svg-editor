/**
 * Whole-SVG import and export.
 *
 * This is what makes the source box round trip shape-preserving, and what lets
 * you paste a real icon in. A box holding one concatenated `d` string collapses
 * every shape into one on Apply: the geometry survives and the shape boundaries
 * do not.
 *
 * Two decisions worth stating:
 *
 *  - Primitives (`rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`)
 *    are converted to path data and parsed with the same parser as `<path>`.
 *    Writing a second geometry path for them would mean a second set of bugs.
 *
 *  - `transform` attributes are BAKED into coordinates rather than stored.
 *    That follows the model's existing choice: a shape is its points, and
 *    nothing downstream has to unwind a matrix before hit-testing or editing.
 *    The cost is that an imported `rotate(30)` is not recoverable as "30
 *    degrees" afterwards, only as the points it produced.
 */

import { identity, mul, rotate, scale as scaleMat, skew, translate } from '../core/affine';
import type { Mat } from '../core/affine';
import { parsePath } from '../core/parse';
import { serialisePath } from '../core/serialise';
import type { SerialiseOptions } from '../core/serialise';
import { defaultStyle } from '../core/types';
import type { Doc, Shape, Style, Subpath, ViewBox } from '../core/types';
import { makeShape } from '../model/doc';
import { transformShape } from '../model/ops';

export interface ImportResult {
  shapes: Shape[];
  viewBox: ViewBox | null;
  warnings: string[];
}

/* ------------------------------------------------------------- transforms */

const NUM = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?';
const TRANSFORM_RE = new RegExp(`(matrix|translate|scale|rotate|skewX|skewY)\\s*\\(([^)]*)\\)`, 'g');

/** Parse an SVG `transform` attribute into a single matrix. */
export function parseTransform(text: string): Mat {
  let m = identity();
  TRANSFORM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TRANSFORM_RE.exec(text)) !== null) {
    const args = (match[2].match(new RegExp(NUM, 'g')) ?? []).map(Number);
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = args;

    switch (match[1]) {
      case 'matrix':
        if (args.length >= 6) m = mul(m, [a, b, c, d, e, f]);
        break;
      case 'translate':
        m = mul(m, translate(a, args.length > 1 ? b : 0));
        break;
      case 'scale':
        m = mul(m, scaleMat(a, args.length > 1 ? b : a));
        break;
      case 'rotate':
        // `rotate(angle cx cy)` rotates about a point rather than the origin.
        m = args.length >= 3
          ? mul(m, mul(translate(b, c), mul(rotate(a), translate(-b, -c))))
          : mul(m, rotate(a));
        break;
      case 'skewX':
        m = mul(m, skew(a, 0));
        break;
      case 'skewY':
        m = mul(m, skew(0, a));
        break;
    }
  }
  return m;
}

/* ---------------------------------------------------- primitives -> paths */

const num = (el: Element, name: string, fallback = 0): number => {
  const v = parseFloat(el.getAttribute(name) ?? '');
  return Number.isFinite(v) ? v : fallback;
};

/** Convert a shape element to path data, or `null` if it is not one. */
export function primitiveToPath(el: Element): string | null {
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'path':
      return el.getAttribute('d') ?? '';

    case 'rect': {
      const x = num(el, 'x');
      const y = num(el, 'y');
      const w = num(el, 'width');
      const h = num(el, 'height');
      if (w <= 0 || h <= 0) return '';
      // Per spec, a missing rx takes ry's value and vice versa, and both are
      // clamped to half the side.
      const hasRx = el.hasAttribute('rx');
      const hasRy = el.hasAttribute('ry');
      let rx = hasRx ? num(el, 'rx') : hasRy ? num(el, 'ry') : 0;
      let ry = hasRy ? num(el, 'ry') : rx;
      rx = Math.min(Math.abs(rx), w / 2);
      ry = Math.min(Math.abs(ry), h / 2);

      if (rx === 0 || ry === 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
        `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }

    case 'circle':
    case 'ellipse': {
      const cx = num(el, 'cx');
      const cy = num(el, 'cy');
      const rx = tag === 'circle' ? num(el, 'r') : num(el, 'rx');
      const ry = tag === 'circle' ? num(el, 'r') : num(el, 'ry');
      if (rx <= 0 || ry <= 0) return '';
      // Two half arcs: a single arc command cannot express a full ellipse,
      // because its endpoints would coincide and the spec drops it.
      return (
        `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}` +
        `A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`
      );
    }

    case 'line':
      return `M${num(el, 'x1')} ${num(el, 'y1')}L${num(el, 'x2')} ${num(el, 'y2')}`;

    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') ?? '').match(new RegExp(NUM, 'g')) ?? [];
      if (pts.length < 4) return '';
      const pairs: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) pairs.push(`${pts[i]} ${pts[i + 1]}`);
      return `M${pairs.join('L')}${tag === 'polygon' ? 'Z' : ''}`;
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ style */

/** Read a presentation property from the attribute or the inline `style`. */
function styleProp(el: Element, name: string): string | null {
  const inline = el.getAttribute('style');
  if (inline) {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(inline);
    if (m) return m[1].trim();
  }
  return el.getAttribute(name);
}

function readStyle(el: Element, inherited: Style): Style {
  const s: Style = { ...inherited };
  const fill = styleProp(el, 'fill');
  const stroke = styleProp(el, 'stroke');
  const sw = styleProp(el, 'stroke-width');
  const fr = styleProp(el, 'fill-rule');
  if (fill) s.fill = fill;
  if (stroke) s.stroke = stroke;
  if (sw && Number.isFinite(parseFloat(sw))) s.strokeWidth = parseFloat(sw);
  if (fr === 'evenodd' || fr === 'nonzero') s.fillRule = fr;
  return s;
}

/* ----------------------------------------------------------------- import */

const HIDDEN = (el: Element): boolean =>
  styleProp(el, 'display') === 'none' || el.getAttribute('visibility') === 'hidden';

function parseViewBox(el: Element): ViewBox | null {
  const vb = el.getAttribute('viewBox');
  if (!vb) return null;
  const n = (vb.match(new RegExp(NUM, 'g')) ?? []).map(Number);
  if (n.length < 4 || !n.every(Number.isFinite) || n[2] <= 0 || n[3] <= 0) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

/**
 * Whether an import would put anything on the canvas.
 *
 * An import that parsed cleanly can still draw nothing. `M 0 0` and
 * `M 0 0 Q Q Q` both come back as a shape with no subpaths at all, since the
 * parser drops a subpath with nothing in it. Both import routes refuse text
 * this returns false for, which is what stops an Apply over a selected shape
 * from emptying it, reporting "Updated Star." and leaving a `<path d="">`
 * behind.
 *
 * **Two nodes, not one, and the difference is not reachable from here.** No
 * input to `parsePath` produces a subpath holding a single node -- every
 * degenerate case is dropped whole, which was measured rather than assumed --
 * so `>= 2` and `>= 1` behave identically on anything `importSvg` can return.
 * It is written as the geometric fact, that one node is not a drawing, and
 * tested against a shape built by hand, because the argument is about the
 * shape and not about which parser handed it over.
 *
 * Lives here rather than in `main.ts` because it is the importer's own
 * question, and because the two callers there each had their own copy of it.
 */
export function drawsSomething(shapes: Shape[]): boolean {
  return shapes.some((sh) => sh.subpaths.some((sp) => sp.nodes.length >= 2));
}

/**
 * Import SVG markup, or bare path data.
 *
 * Input that does not look like markup is treated as a `d` string, so pasting
 * either form into the same box works.
 */
export function importSvg(text: string): ImportResult {
  const trimmed = text.trim();
  const warnings: string[] = [];

  if (!trimmed) return { shapes: [], viewBox: null, warnings };

  // Bare path data: no markup, so parse it directly.
  if (!trimmed.startsWith('<')) {
    return { shapes: [makeShape(parsePath(trimmed), 'path')], viewBox: null, warnings };
  }

  const dom = new DOMParser().parseFromString(trimmed, 'image/svg+xml');
  const parseError = dom.querySelector('parsererror');
  if (parseError) throw new Error(parseError.textContent?.split('\n')[0] ?? 'Malformed SVG');

  const root = dom.documentElement;
  const viewBox = parseViewBox(root);
  const shapes: Shape[] = [];
  let n = 0;

  const walk = (el: Element, m: Mat, inherited: Style): void => {
    if (HIDDEN(el)) return;

    const own = el.getAttribute('transform');
    const here = own ? mul(m, parseTransform(own)) : m;
    const style = readStyle(el, inherited);
    const tag = el.tagName.toLowerCase();

    if (tag === 'g' || tag === 'svg' || tag === 'a') {
      for (const child of Array.from(el.children)) walk(child, here, style);
      return;
    }
    if (tag === 'defs' || tag === 'clippath' || tag === 'mask' || tag === 'symbol') return;

    const d = primitiveToPath(el);
    if (d === null) {
      if (tag === 'text' || tag === 'image' || tag === 'use') {
        warnings.push(`<${tag}> is not supported and was skipped`);
      }
      return;
    }
    if (!d.trim()) return;

    let subpaths: Subpath[];
    try {
      subpaths = parsePath(d);
    } catch (err) {
      warnings.push(`<${tag}>: ${(err as Error).message}`);
      return;
    }
    if (subpaths.length === 0) return;

    const shape = makeShape(subpaths, el.getAttribute('id') || `${tag}-${++n}`);
    shape.style = style;
    // Bake the accumulated transform rather than storing it.
    transformShape(shape, here);
    shapes.push(shape);
  };

  walk(root, identity(), defaultStyle());
  return { shapes, viewBox, warnings };
}

/* ----------------------------------------------------------------- export */

export interface ExportOptions extends SerialiseOptions {
  /** Emit newlines and indentation. */
  pretty?: boolean;
}

export function exportSvg(doc: Doc, options: ExportOptions = {}): string {
  const { pretty = true, ...ser } = options;
  const vb = doc.viewBox;
  const nl = pretty ? '\n' : '';
  const pad = pretty ? '  ' : '';

  // Ids have to be unique within one document, and `xmlId` is not injective --
  // `a b`, `a-b` and `a/b` all sanitise to the same thing. Export is the only
  // place an id is written, so it is the only place that can guarantee it.
  const used = new Set<string>();

  const body = doc.shapes
    .filter((s) => s.subpaths.some((sp) => sp.nodes.length >= 2))
    .map((s) => {
      const d = serialisePath(s.subpaths, ser);
      const attrs = [
        `d="${d}"`,
        `fill="${xmlAttr(s.style.fill)}"`,
        s.style.fillRule === 'evenodd' ? 'fill-rule="evenodd"' : '',
        s.style.stroke === 'none' ? '' : `stroke="${xmlAttr(s.style.stroke)}"`,
        s.style.stroke === 'none' ? '' : `stroke-width="${xmlAttr(String(s.style.strokeWidth))}"`,
        s.name && s.name !== s.id ? `id="${uniqueXmlId(s.name, used)}"` : '',
      ].filter(Boolean);
      return `${pad}<path ${attrs.join(' ')}/>`;
    })
    .join(nl);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}">` +
    nl + body + nl + '</svg>' + nl
  );
}

/**
 * A shape name made safe to write as an XML `id`.
 *
 * Names are typed by hand and can hold anything -- spaces, quotes, an emoji --
 * while an `id` is an XML Name: no whitespace, no quotes, and not starting with
 * a digit. Writing one straight through would produce a document that will not
 * parse, so anything invalid becomes a hyphen and a leading digit gains a
 * prefix. The name in the editor is left exactly as typed; only the export is
 * constrained.
 */
export function xmlId(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'shape';
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n${cleaned}`;
}

/**
 * An attribute value made safe to write between double quotes.
 *
 * `d` and the numbers we generate ourselves cannot contain anything dangerous,
 * but `fill` and `stroke` are whatever an imported document carried, and a
 * value holding a quote closes the attribute early and produces a file that
 * will not re-open. `xmlId` was written for exactly this failure on the `id`
 * and left its two neighbours interpolating raw.
 */
export function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * `xmlId`, then made unique against the ids already written to this document.
 *
 * Two shapes may legitimately carry the same name -- duplicating one is the
 * usual way it happens -- but two elements may not carry the same `id`, and a
 * document that does is invalid rather than merely untidy. A collision gets a
 * numeric suffix, which is the same shape `nextId` uses for names.
 */
export function uniqueXmlId(name: string, used: Set<string>): string {
  const base = xmlId(name);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

/** Just the path data, for when only the `d` is wanted. */
export function exportPathData(doc: Doc, options: SerialiseOptions = {}): string {
  return doc.shapes
    .map((s) => serialisePath(s.subpaths, options))
    .filter(Boolean)
    .join(options.minify ? '' : ' ');
}
