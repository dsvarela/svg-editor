/**
 * Document construction and queries. No mutation lives here -- see `ops.ts`.
 */

import { cubicBBox, unionBox } from '../core/bezier';
import type { Box } from '../core/bezier';
import { defaultStyle, segmentAsCubic, segmentCount } from '../core/types';
import type { Doc, PathNode, Pt, Shape, Style, Subpath } from '../core/types';
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

/* --------------------------------------------------------------- selection */

/**
 * Where a node sits right now.
 *
 * A position, not an identity: correct at the moment it was resolved and wrong
 * as soon as anything splices the array it indexes. Resolve one, use it, and
 * throw it away. What persists between operations is `PathNode.id`.
 */
export interface NodeRef {
  shape: string;
  sp: number;
  i: number;
}

export type HandlePart = 'anchor' | 'in' | 'out';

/**
 * Find where a node is now, or learn that it has gone.
 *
 * Linear in the document. Every caller that wants more than one node should ask
 * `resolveNodes` instead, which walks it once for the whole set.
 */
export function findNode(doc: Doc, id: string): NodeRef | null {
  for (const shape of doc.shapes) {
    for (let sp = 0; sp < shape.subpaths.length; sp++) {
      const i = shape.subpaths[sp].nodes.findIndex((n) => n.id === id);
      if (i >= 0) return { shape: shape.id, sp, i };
    }
  }
  return null;
}

/** The node a ref points at, if it still points at one. */
export function nodeAt(doc: Doc, r: NodeRef): PathNode | null {
  return findShape(doc, r.shape)?.subpaths[r.sp]?.nodes[r.i] ?? null;
}

export interface Selection {
  /** Whole shapes, for transforms. */
  shapes: Set<string>;
  /** Individual anchors, by `PathNode.id`. */
  nodes: Set<string>;
}

export const emptySelection = (): Selection => ({ shapes: new Set(), nodes: new Set() });

/**
 * Where the selected nodes are now, in document order, dropping any that have
 * gone.
 *
 * One walk of the document rather than a lookup per id, and the only way any
 * caller should turn a selection into positions. A selection holds identities;
 * an index is only true at the instant it is read.
 */
export function resolveNodes(doc: Doc, sel: Selection): { ref: NodeRef; pt: Pt }[] {
  const out: { ref: NodeRef; pt: Pt }[] = [];
  if (!sel.nodes.size) return out;
  for (const shape of doc.shapes) {
    for (let sp = 0; sp < shape.subpaths.length; sp++) {
      const nodes = shape.subpaths[sp].nodes;
      for (let i = 0; i < nodes.length; i++) {
        if (sel.nodes.has(nodes[i].id)) out.push({ ref: { shape: shape.id, sp, i }, pt: nodes[i].pt });
      }
    }
  }
  return out;
}

/**
 * The id of the node at a position, for the callers that have a position and
 * need an identity: a hit test, a freshly split segment, a test fixture.
 */
export function nodeIdAt(doc: Doc, shape: string, sp: number, i: number): string {
  const node = findShape(doc, shape)?.subpaths[sp]?.nodes[i];
  if (!node) throw new Error(`no node at ${shape}/${sp}/${i}`);
  return node.id;
}

/** The same, when only the positions are wanted. */
export const selectedRefs = (doc: Doc, sel: Selection): NodeRef[] =>
  resolveNodes(doc, sel).map((r) => r.ref);

/**
 * Every node an operation on the selection should touch.
 *
 * Wider than `selectedRefs`: a whole-shape selection implies all of that
 * shape's nodes. That is what makes dragging a shape and dragging its nodes one
 * piece of code rather than two, and it is why an operation asks this rather
 * than reading `selection.nodes` itself.
 *
 * Deduplicated by position, not by identity, because the two branches can name
 * the same place from both directions.
 */
export function selectedNodes(doc: Doc, sel: Selection): NodeRef[] {
  const refs = selectedRefs(doc, sel);
  for (const id of sel.shapes) {
    findShape(doc, id)?.subpaths.forEach((sp, spI) =>
      sp.nodes.forEach((_, i) => refs.push({ shape: id, sp: spI, i })),
    );
  }
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.shape}/${r.sp}/${r.i}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The same reach, grouped as whole subpaths.
 *
 * For the operations that cannot act on loose nodes -- circularise, simplify,
 * offset -- because rewriting some of a path's nodes leaves the segments joining
 * them to the rest built from geometry they are not on.
 */
export function selectedSubpaths(doc: Doc, sel: Selection): Map<string, Set<number>> {
  const targets = new Map<string, Set<number>>();
  const add = (shape: string, sp: number): void => {
    const set = targets.get(shape) ?? new Set<number>();
    set.add(sp);
    targets.set(shape, set);
  };
  for (const r of selectedRefs(doc, sel)) add(r.shape, r.sp);
  for (const id of sel.shapes) {
    findShape(doc, id)?.subpaths.forEach((_, i) => add(id, i));
  }
  return targets;
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
  for (const { ref } of resolveNodes(doc, sel)) ids.add(ref.shape);
  return doc.shapes.filter((s) => ids.has(s.id));
}
