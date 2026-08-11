/**
 * Document construction and queries. No mutation lives here -- see `ops.ts`.
 */

import { cubicBBox, unionBox } from '../core/bezier';
import type { Box } from '../core/bezier';
import { defaultStyle, segmentAsCubic, segmentCount } from '../core/types';
import type { Doc, Pt, Shape, Style, Subpath, ViewBox } from '../core/types';
import { parsePath } from '../core/parse';

let idSeq = 0;
export const nextId = (prefix = 'shape'): string => `${prefix}-${++idSeq}`;

/** `style` defaults to the built-in one; callers pass the editor's current one. */
export function makeShape(subpaths: Subpath[], name?: string, style?: Style): Shape {
  const id = nextId();
  return { id, name: name ?? id, subpaths, style: style ? { ...style } : defaultStyle() };
}

export function shapeFromPath(d: string, name?: string): Shape {
  return makeShape(parsePath(d), name);
}

export function emptyDoc(): Doc {
  return { shapes: [], viewBox: { x: 0, y: 0, w: 100, h: 100 } };
}

export const findShape = (doc: Doc, id: string): Shape | undefined =>
  doc.shapes.find((s) => s.id === id);

/* ------------------------------------------------------------------ bounds */

export function subpathBBox(sp: Subpath): Box | null {
  let box: Box | null = null;
  const n = segmentCount(sp);
  if (n === 0) {
    if (sp.nodes.length === 1) {
      const [x, y] = sp.nodes[0].pt;
      return { x0: x, y0: y, x1: x, y1: y };
    }
    return null;
  }
  for (let i = 0; i < n; i++) box = unionBox(box, cubicBBox(segmentAsCubic(sp, i)));
  return box;
}

export function shapeBBox(shape: Shape): Box | null {
  let box: Box | null = null;
  for (const sp of shape.subpaths) {
    const b = subpathBBox(sp);
    if (b) box = unionBox(box, b);
  }
  return box;
}

export function docBBox(doc: Doc): Box | null {
  let box: Box | null = null;
  for (const s of doc.shapes) {
    const b = shapeBBox(s);
    if (b) box = unionBox(box, b);
  }
  return box;
}

export function boxToViewBox(b: Box, pad = 0.1): ViewBox {
  const w = Math.max(b.x1 - b.x0, 1e-6);
  const h = Math.max(b.y1 - b.y0, 1e-6);
  const m = Math.max(w, h) * pad;
  return { x: b.x0 - m, y: b.y0 - m, w: w + 2 * m, h: h + 2 * m };
}

/* --------------------------------------------------------------- selection */

/** A single anchor, addressed stably enough to survive unrelated edits. */
export interface NodeRef {
  shape: string;
  sp: number;
  i: number;
}

export type HandlePart = 'anchor' | 'in' | 'out';

export const nodeKey = (r: NodeRef): string => `${r.shape}/${r.sp}/${r.i}`;

export function parseNodeKey(key: string): NodeRef {
  const [shape, sp, i] = key.split('/');
  return { shape, sp: +sp, i: +i };
}

export interface Selection {
  /** Whole shapes, for transforms. */
  shapes: Set<string>;
  /** Individual anchors, keyed by `nodeKey`. */
  nodes: Set<string>;
}

export const emptySelection = (): Selection => ({ shapes: new Set(), nodes: new Set() });

export const selectionIsEmpty = (s: Selection): boolean =>
  s.shapes.size === 0 && s.nodes.size === 0;

/** Resolve selected node keys to live nodes, dropping any that no longer exist. */
export function resolveNodes(doc: Doc, sel: Selection): { ref: NodeRef; pt: Pt }[] {
  const out: { ref: NodeRef; pt: Pt }[] = [];
  for (const key of sel.nodes) {
    const ref = parseNodeKey(key);
    const shape = findShape(doc, ref.shape);
    const node = shape?.subpaths[ref.sp]?.nodes[ref.i];
    if (node) out.push({ ref, pt: node.pt });
  }
  return out;
}

/** Bounding box of whatever is selected: whole shapes, or just the chosen nodes. */
export function selectionBBox(doc: Doc, sel: Selection): Box | null {
  let box: Box | null = null;
  for (const id of sel.shapes) {
    const s = findShape(doc, id);
    if (!s) continue;
    const b = shapeBBox(s);
    if (b) box = unionBox(box, b);
  }
  if (sel.shapes.size === 0) {
    for (const { pt } of resolveNodes(doc, sel)) {
      box = unionBox(box, { x0: pt[0], y0: pt[1], x1: pt[0], y1: pt[1] });
    }
  }
  return box;
}

/** Every shape touched by the selection, whether whole or by node. */
export function selectedShapes(doc: Doc, sel: Selection): Shape[] {
  const ids = new Set(sel.shapes);
  for (const key of sel.nodes) ids.add(parseNodeKey(key).shape);
  return doc.shapes.filter((s) => ids.has(s.id));
}
