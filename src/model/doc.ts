/**
 * Document construction and queries. No mutation lives here -- see `ops.ts`.
 */

import { cubicBBox, unionBox } from '../core/bezier';
import type { Box } from '../core/bezier';
import { defaultStyle, nextNodeId, reserveNodeId, segmentAsCubic, segmentCount } from '../core/types';
import type { Doc, Group, PathNode, Pt, Shape, Style, Subpath } from '../core/types';
import { parsePath } from '../core/parse';

let idSeq = 0;
export const nextId = (prefix = 'shape'): string => `${prefix}-${++idSeq}`;

/**
 * Move both counters past every id in a document that came from outside.
 *
 * Called once on whatever a restore or a workspace file hands over, before the
 * store gets it. Without it the counters are still at zero and the next shape
 * drawn takes an id the document is already using, which is §46's defect
 * arriving by a route §46 does not cover: nothing was copied, the collision came
 * from the counter being younger than the document.
 *
 * Reads the trailing number rather than the whole id, because `nextId` spells
 * one `prefix-n` and the prefix varies. An id in any other shape is left alone:
 * it cannot collide with `prefix-n`, so there is nothing to reserve.
 */
export function reserveIds(doc: Doc): void {
  const reserve = (id: string): void => {
    const m = /-(\d+)$/.exec(id);
    if (m) idSeq = Math.max(idSeq, Number(m[1]));
  };
  for (const s of doc.shapes) {
    reserve(s.id);
    for (const sp of s.subpaths) for (const n of sp.nodes) reserveNodeId(n.id);
  }
  for (const g of doc.groups ?? []) reserve(g.id);
}

/**
 * Give a fresh id to anything in an outside document that shares one.
 *
 * §46: an id naming two things is two things no selection can separate. The
 * reader in `io/session.ts` refuses a file that is the wrong shape and repairs
 * one that is merely inconsistent, and this is the second kind. A duplicate
 * costs nothing to fix and nothing to lose, because a node id is a name inside
 * this session and never means anything outside it, so refusing the drawing
 * over one would be the harsher answer for no gain.
 *
 * The symptom it prevents is not an exception. `resolveNodes` walks every shape,
 * so a shared node id is one click selecting two points and one drag moving
 * both; a shared shape id is one row of the list selecting two shapes.
 *
 * Runs after `reserveIds`, which is what makes a minted id safe: the counters
 * are still at zero until then, so a fresh `shape-1` would land on an id the
 * document already holds. Returns how many it had to rename.
 */
export function dedupeIds(doc: Doc): number {
  let fixed = 0;
  const shapes = new Set<string>();
  const nodes = new Set<string>();
  for (const s of doc.shapes) {
    if (shapes.has(s.id)) {
      s.id = nextId();
      fixed++;
    }
    shapes.add(s.id);
    for (const sp of s.subpaths) {
      for (const n of sp.nodes) {
        if (nodes.has(n.id)) {
          n.id = nextNodeId();
          fixed++;
        }
        nodes.add(n.id);
      }
    }
  }
  const groups = new Set<string>();
  for (const g of doc.groups ?? []) {
    if (groups.has(g.id)) {
      /* A second group under one id owns whichever shapes point at it, and
         renaming it here would take them all with it. Rooting the copy leaves
         it empty, and `pruneGroups` clears it on the next edit. */
      g.id = nextId('group');
      fixed++;
    }
    groups.add(g.id);
  }
  return fixed;
}

/** `style` defaults to the built-in one; callers pass the editor's current one. */
export function makeShape(subpaths: Subpath[], name?: string, style?: Style): Shape {
  const id = nextId();
  return { id, name: name ?? id, subpaths, style: style ? { ...style } : defaultStyle() };
}

export function shapeFromPath(d: string, name?: string): Shape {
  return makeShape(parsePath(d), name);
}

/* ------------------------------------------------------------------ groups */

/**
 * The group with this id, or `undefined`.
 *
 * Every question about groups is answered from `Shape.group` and `Doc.groups`
 * together, and never from a list of members held on the group. One statement of
 * the relation is what stops the two disagreeing after a delete. §49 of
 * `docs/ARCHITECTURE.md` has the argument.
 */
export const findGroup = (doc: Doc, id: string): Group | undefined =>
  doc.groups?.find((g) => g.id === id);

/** A group's ancestors, nearest first, ending at the outermost. */
export function groupChain(doc: Doc, id: string | null | undefined): Group[] {
  const out: Group[] = [];
  let at = id ?? null;
  /* Bounded by the number of groups rather than by `while (at)`, so a parent cycle
     that some future edit introduces cannot hang the renderer. A cycle is a bug
     either way; this is the difference between a wrong list and a frozen page. */
  const limit = doc.groups?.length ?? 0;
  for (let i = 0; at && i <= limit; i++) {
    const g = findGroup(doc, at);
    if (!g) break;
    out.push(g);
    at = g.parent;
  }
  return out;
}

/**
 * Is this shape locked, by itself or by a group it is inside?
 *
 * One question with one answer, asked by the hit test, the marquee, the
 * overlay and the list. Locking a group locks what is under it without
 * touching any of them, because a group is a relation and the chain is walked
 * rather than copied down. §49, §66.
 */
/**
 * Is this shape hidden, by itself or by a group it is inside?
 *
 * The same walk `isLocked` makes and a different question: what this reads is
 * on the document, because it is part of the drawing and goes in the file.
 * §66.
 */
export function isHidden(doc: Doc, id: string): boolean {
  const shape = findShape(doc, id);
  if (shape?.hidden) return true;
  const group = shape ? shape.group : id;
  return groupChain(doc, group).some((g) => g.hidden === true);
}

export function isLocked(doc: Doc, locked: ReadonlySet<string>, id: string): boolean {
  if (locked.size === 0) return false;
  if (locked.has(id)) return true;
  /* `id` names a shape or a group, and either way the question is the same:
     does anything above it hold a lock. A shape is asked about from the group
     it is in; a group is asked about from itself, which walks one link further
     than it needs to and cannot change the answer, because the line above has
     already said what its own id means. An id that is neither gets an empty
     chain and a `false`. */
  const shape = findShape(doc, id);
  return groupChain(doc, shape ? shape.group : id).some((g) => locked.has(g.id));
}

/** Whether `id` is `ancestor`, or nested anywhere inside it. */
export function groupWithin(doc: Doc, id: string | null | undefined, ancestor: string): boolean {
  if (!id) return false;
  if (id === ancestor) return true;
  return groupChain(doc, id).some((g) => g.id === ancestor);
}

/**
 * The shapes of a group, nested ones included, in paint order.
 *
 * Paint order because that is `doc.shapes` order, which is the only order there is.
 */
export const shapesInGroup = (doc: Doc, id: string): Shape[] =>
  doc.shapes.filter((sh) => groupWithin(doc, sh.group, id));

/**
 * Drop groups that hold no shapes.
 *
 * Deleting the last shape out of a group leaves a group naming nothing, which would
 * show as an empty row in the list and write an empty `<g>` on export. Run after
 * anything that removes shapes. Repeated until nothing changes, because a group
 * whose only content was an empty group becomes empty in the same sweep.
 */
export function pruneGroups(doc: Doc): void {
  for (;;) {
    const groups = doc.groups;
    if (!groups?.length) break;
    const keep = groups.filter((g) => doc.shapes.some((sh) => groupWithin(doc, sh.group, g.id)));
    if (keep.length === groups.length) break;
    doc.groups = keep;
  }
  // A parent that has gone takes its children out to the top rather than leaving
  // them pointing at nothing, which would read as ungrouped anyway but through a
  // dangling id that every lookup has to survive.
  for (const g of doc.groups ?? []) {
    if (g.parent && !findGroup(doc, g.parent)) g.parent = null;
  }
  /* Outside the guard above, because a document with no groups left is exactly the
     state that leaves a dangling `Shape.group`: dropping the last group is what
     makes every shape still naming it point at nothing. */
  for (const sh of doc.shapes) {
    if (sh.group && !findGroup(doc, sh.group)) sh.group = null;
  }
}

/**
 * Give a shape, and every node in it, an identity of its own. Mutates and
 * returns it.
 *
 * The second half of any copy that is going to live in the document beside what
 * it was copied from. `cloneShape` deliberately carries ids through, because
 * that is what makes a selection survive a history snapshot, and a copy that
 * keeps them is a copy no selection can tell from the original: `resolveNodes`
 * finds a node by walking every shape, so one id naming two nodes selects both
 * and drags both.
 *
 * Anything putting a copy into the live document is expected to call this, and
 * `test/identity.test.ts` sweeps the operations that do. §46 of
 * `docs/ARCHITECTURE.md` has the argument for keeping the two halves separate
 * rather than folding the minting into `cloneShape`.
 */
export function reidentify(shape: Shape): Shape {
  shape.id = nextId();
  for (const sp of shape.subpaths) {
    for (const node of sp.nodes) node.id = nextNodeId();
  }
  return shape;
}

export function emptyDoc(): Doc {
  return { shapes: [], viewBox: { x: 0, y: 0, w: 100, h: 100 } };
}

export const findShape = (doc: Doc, id: string): Shape | undefined =>
  doc.shapes.find((s) => s.id === id);

/* ------------------------------------------------------------------ bounds */

function subpathBBox(sp: Subpath): Box | null {
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

/** `resolveNodes` when only the positions are wanted. */
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
 * For the operations that cannot act on loose nodes -- simplify, offset, and a
 * boolean between the paths of one shape -- because rewriting some of a path's
 * nodes leaves the segments joining them to the rest built from geometry they
 * are not on.
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
