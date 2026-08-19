/**
 * Whole-SVG import and export.
 *
 * What makes the source box round trip shape-preserving: one concatenated `d`
 * string would collapse every shape into one on Apply.
 *
 *  - Primitives are converted to path data and read by the same parser as
 *    `<path>`, so there is no second geometry path to carry its own bugs.
 *  - `transform` attributes are **baked into coordinates**, following the
 *    model's choice that a shape is its points. An imported `rotate(30)` is
 *    recoverable only as the points it produced. §5.
 */

import { identity, mul, rotate, scale as scaleMat, skew, translate } from '../core/affine';
import type { Mat } from '../core/affine';
import { parsePath } from '../core/parse';
import { formatNumber, serialisePath } from '../core/serialise';
import type { SerialiseOptions } from '../core/serialise';
import { OPACITY_DECIMALS, STROKE_CAP, STROKE_JOIN, defaultStyle } from '../core/types';
import type { Doc, Group, Shape, Style, Subpath, ViewBox } from '../core/types';
import { findGroup, groupChain, makeShape, nextId } from '../model/doc';
import { transformShape } from '../model/ops';

export interface ImportResult {
  shapes: Shape[];
  viewBox: ViewBox | null;
  warnings: string[];
  /** One per `<g>` that held something, nested as the file nested them. */
  groups: Group[];
}

/**
 * Whether a group id sits inside an ancestor, over a list rather than a document.
 *
 * `groupWithin` in `model/doc.ts` answers the same question of a `Doc`, and import
 * has no `Doc` yet -- it is building the parts of one. Kept small and local rather
 * than reaching for a shape of data this function does not have.
 */
function within(groups: Group[], id: string | null | undefined, ancestor: string): boolean {
  let at = id ?? null;
  for (let i = 0; at && i <= groups.length; i++) {
    if (at === ancestor) return true;
    at = groups.find((g) => g.id === at)?.parent ?? null;
  }
  return false;
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

/**
 * The style an element draws with, and what had to be thrown away to get it.
 *
 * `dropped` collects the names of properties this editor's model cannot carry.
 * §60 keeps one opacity per shape, so a `fill-opacity` of 0.3 inside a shape at
 * full opacity has nowhere to go. Silence is the wrong answer there: a fill
 * going from 30% to 100% does not look like a loss, it looks like the wrong
 * picture, and the importer already has a channel for saying what it skipped.
 */
function readStyle(el: Element, inherited: Style, dropped: Set<string>): Style {
  const s: Style = { ...inherited };
  for (const name of ['fill-opacity', 'stroke-opacity']) {
    if (styleProp(el, name) !== null) dropped.add(name);
  }
  const fill = styleProp(el, 'fill');
  const stroke = styleProp(el, 'stroke');
  const sw = styleProp(el, 'stroke-width');
  const fr = styleProp(el, 'fill-rule');
  const op = styleProp(el, 'opacity');
  if (fill) s.fill = fill;
  if (stroke) s.stroke = stroke;
  if (sw && Number.isFinite(parseFloat(sw))) s.strokeWidth = parseFloat(sw);
  if (fr === 'evenodd' || fr === 'nonzero') s.fillRule = fr;
  /* Multiplied into what was inherited, which is what the renderer does: a
     `<g opacity="0.5">` holding a path at 0.5 draws it at 0.25. A group carries
     no style here (§5), so the only place that factor can land is on the shape.
     Clamped, because a file may say anything and 1.5 is opaque.

     A percentage is legal in CSS and not as a presentation attribute, so
     `parseFloat` alone reads "50%" as 50 and clamps to opaque -- right for the
     attribute, wrong for the inline style `styleProp` also reads. */
  if (op !== null) {
    const pct = op.trim().endsWith('%');
    const n = parseFloat(op);
    if (Number.isFinite(n)) s.opacity *= Math.min(1, Math.max(0, pct ? n / 100 : n));
  }
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
 * An import that parsed cleanly can still draw nothing: `M 0 0` comes back as a
 * shape with no subpaths. Both import routes refuse text this returns false
 * for, which is what stops an Apply from emptying a shape and reporting
 * "Updated".
 *
 * **Two nodes, not one**, because one node is not a drawing. No input to
 * `parsePath` produces a single-node subpath, so the two behave alike on
 * anything `importSvg` returns; the test builds the shape by hand.
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

  if (!trimmed) return { shapes: [], viewBox: null, warnings, groups: [] };

  // Bare path data: no markup, so parse it directly.
  if (!trimmed.startsWith('<')) {
    return { shapes: [makeShape(parsePath(trimmed), 'path')], viewBox: null, warnings, groups: [] };
  }

  const dom = new DOMParser().parseFromString(trimmed, 'image/svg+xml');
  const parseError = dom.querySelector('parsererror');
  if (parseError) throw new Error(parseError.textContent?.split('\n')[0] ?? 'Malformed SVG');

  const root = dom.documentElement;
  const viewBox = parseViewBox(root);
  const shapes: Shape[] = [];
  const groups: Group[] = [];
  const dropped = new Set<string>();
  let n = 0;

  const walk = (el: Element, m: Mat, inherited: Style, group: string | null): void => {
    if (HIDDEN(el)) return;

    const own = el.getAttribute('transform');
    const here = own ? mul(m, parseTransform(own)) : m;
    const style = readStyle(el, inherited, dropped);
    const tag = el.tagName.toLowerCase();

    if (tag === 'g' || tag === 'svg' || tag === 'a') {
      /* A `<g>` becomes a group; the outer `<svg>` and an `<a>` do not. The first is
         the document itself and the second is a link, and neither is a thing anyone
         drew -- wrapping the whole drawing in a group nobody asked for would put a
         row in the list that cannot be ungrouped into anything meaningful.

         Its transform is still baked into the shapes below, per §5. What survives
         here is which shapes belong together, which is the part that was being
         thrown away. */
      let inner = group;
      if (tag === 'g') {
        const made: Group = {
          id: nextId('group'),
          name: el.getAttribute('id') || `group ${groups.length + 1}`,
          parent: group,
        };
        groups.push(made);
        inner = made.id;
      }
      for (const child of Array.from(el.children)) walk(child, here, style, inner);
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
    if (group) shape.group = group;
    // Bake the accumulated transform rather than storing it.
    transformShape(shape, here);
    shapes.push(shape);
  };

  walk(root, identity(), defaultStyle(), null);
  // Once, however many elements carried them: a file setting one of these on
  // every path would otherwise report the same loss a hundred times.
  if (dropped.size) {
    const was = dropped.size === 1 ? 'was' : 'were';
    warnings.push(`${[...dropped].join(' and ')} cannot be kept and ${was} dropped`);
  }
  /* A `<g>` holding no shape we could read leaves a group naming nothing. Dropped
     here rather than left for `pruneGroups`, so what this function returns is
     already consistent and a caller does not have to know to sweep it. */
  const kept = groups.filter((g) => shapes.some((sh) => within(groups, sh.group, g.id)));
  for (const g of kept) {
    if (g.parent && !kept.some((k) => k.id === g.parent)) g.parent = null;
  }
  return { shapes, viewBox, warnings, groups: kept };
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

  const drawn = doc.shapes.filter((s) => s.subpaths.some((sp) => sp.nodes.length >= 2));

  const pathOf = (s: Shape, indent: string): string => {
    const d = serialisePath(s.subpaths, ser);
    const attrs = [
      `d="${d}"`,
      `fill="${xmlAttr(s.style.fill)}"`,
      s.style.fillRule === 'evenodd' ? 'fill-rule="evenodd"' : '',
      s.style.stroke === 'none' ? '' : `stroke="${xmlAttr(s.style.stroke)}"`,
      s.style.stroke === 'none' ? '' : `stroke-width="${xmlAttr(String(s.style.strokeWidth))}"`,
      s.style.stroke === 'none' ? '' : `stroke-linejoin="${STROKE_JOIN}"`,
      s.style.stroke === 'none' ? '' : `stroke-linecap="${STROKE_CAP}"`,
      /* Only when it says something. `opacity="1"` is the initial value, so
         writing it on every path would put an attribute in every file to state
         the default -- the same reason `fill-rule` is written only for
         even-odd.

         `OPACITY_DECIMALS`, and NOT the geometry's setting. Decimals is offered
         from 0, and is described to the reader as trading file size against a
         coarser shape. At 0 every shape under half opacity exported as
         `opacity="0"` -- invisible, in the file people keep, from a control
         that promised to coarsen an outline. A shape that vanishes is not a
         coarser shape. Three is enough for a percentage typed whole, which is
         all this control can produce. */
      s.style.opacity < 1
        ? `opacity="${xmlAttr(formatNumber(s.style.opacity, OPACITY_DECIMALS))}"`
        : '',
      s.name && s.name !== s.id ? `id="${uniqueXmlId(s.name, used)}"` : '',
    ].filter(Boolean);
    return `${indent}<path ${attrs.join(' ')}/>`;
  };

  /* Groups become `<g>` by walking the shapes in paint order and comparing each
     one's chain of groups with the last one's: shared ancestors stay open, the rest
     close, and whatever is new opens. That works precisely because a group's shapes
     are contiguous, which `groupSelection` is what guarantees -- if they were not,
     one group would have to open twice and would no longer be one group.

     No `transform`. §5 bakes transforms into the coordinates, so a `<g>` here says
     what belongs together and nothing about where it is. */
  const lines: string[] = [];
  let open: string[] = [];
  for (const s of drawn) {
    const chain = groupChain(doc, s.group).map((g) => g.id).reverse();
    let shared = 0;
    while (shared < open.length && shared < chain.length && open[shared] === chain[shared]) shared++;
    for (let i = open.length - 1; i >= shared; i--) {
      lines.push(`${pad}${pad.repeat(i)}</g>`);
    }
    for (let i = shared; i < chain.length; i++) {
      const g = findGroup(doc, chain[i]);
      const id = g && g.name && g.name !== g.id ? ` id="${uniqueXmlId(g.name, used)}"` : '';
      lines.push(`${pad}${pad.repeat(i)}<g${id}>`);
    }
    open = chain;
    lines.push(pathOf(s, pad + pad.repeat(chain.length)));
  }
  for (let i = open.length - 1; i >= 0; i--) lines.push(`${pad}${pad.repeat(i)}</g>`);

  const body = lines.join(nl);

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
function xmlAttr(value: string): string {
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
function uniqueXmlId(name: string, used: Set<string>): string {
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
