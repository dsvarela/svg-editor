/**
 * Arranging whole shapes: align, distribute, and even spacing.
 *
 * Distinct from the align in `ops.ts`, which moves anchors inside a path. This
 * one moves paths around each other, and the difference the two of them turn on
 * is what a thing *is*: a node is a point, so a node has no size, and every
 * question here is about size. Aligning two shapes left means putting their left
 * edges together, and a shape's left edge is a property of its curves rather
 * than of any node on it.
 *
 * Everything is stated against a frame -- the box the arrangement happens in --
 * so that "align to the selection" and "align to the canvas" are one operation
 * given two different boxes rather than two operations. §50 of
 * `docs/ARCHITECTURE.md` has the argument.
 */

import { translate } from '../core/affine';
import { unionBox } from '../core/bezier';
import type { Box } from '../core/bezier';
import type { Doc, Shape, ViewBox } from '../core/types';
import { findGroup, groupChain, shapeBBox, shapesInGroup } from './doc';
import { transformShape } from './ops';
import type { AlignMode } from './ops';

/**
 * Whether an arrangement happens inside the selection's own box or the canvas.
 *
 * Which edge it acts on is `AlignMode`, shared with node align rather than
 * restated: "the left edge or the horizontal centre" is one six-way choice, and
 * two copies of that list would be two things to remember to extend.
 */
export type AlignTo = 'selection' | 'canvas';

const isHorizontal = (edge: AlignMode): boolean =>
  edge === 'left' || edge === 'hcenter' || edge === 'right';

/**
 * One thing to be arranged: a loose shape, or a whole group moving together.
 *
 * `box` is a copy rather than a view, and `translateUnit` keeps it in step, so
 * an operation can read every unit's position after moving some of them.
 */
export interface Unit {
  /** The group this unit is, or `null` when it is a single ungrouped shape. */
  group: string | null;
  shapes: Shape[];
  box: Box;
}

/** The coordinate `edge` names on a box. */
export function edgeOf(b: Box, edge: AlignMode): number {
  switch (edge) {
    case 'left':
      return b.x0;
    case 'right':
      return b.x1;
    case 'hcenter':
      return (b.x0 + b.x1) / 2;
    case 'top':
      return b.y0;
    case 'bottom':
      return b.y1;
    case 'vcenter':
      return (b.y0 + b.y1) / 2;
  }
}

/** A viewBox as a box, which is what the canvas frame is. */
export const viewBoxAsBox = (vb: ViewBox): Box => ({
  x0: vb.x,
  y0: vb.y,
  x1: vb.x + vb.w,
  y1: vb.y + vb.h,
});

/**
 * Gather the selected shapes into the things that move.
 *
 * A wholly selected group is one unit, so aligning slides it rather than
 * collapsing it onto its own left edge. Part of a group moves on its own, which
 * is what lets you nudge one shape inside one.
 *
 * A shape joins its *outermost* wholly selected ancestor, that being the
 * largest thing the selection can be said to have chosen. §50.
 */
export function arrangeUnits(doc: Doc, ids: ReadonlySet<string>): Unit[] {
  const whole = new Set<string>();
  for (const g of doc.groups ?? []) {
    const members = shapesInGroup(doc, g.id);
    if (members.length > 0 && members.every((sh) => ids.has(sh.id))) whole.add(g.id);
  }

  const units: Unit[] = [];
  const byKey = new Map<string, Unit>();
  for (const sh of doc.shapes) {
    if (!ids.has(sh.id)) continue;
    const box = shapeBBox(sh);
    if (!box) continue; // A shape with no drawable segment has no position to align.

    const chain = groupChain(doc, sh.group);
    let group: string | null = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (whole.has(chain[i].id)) {
        group = chain[i].id;
        break;
      }
    }

    const key = group ?? sh.id;
    const found = byKey.get(key);
    if (found) {
      found.shapes.push(sh);
      found.box = unionBox(found.box, box);
      continue;
    }
    const unit: Unit = { group, shapes: [sh], box };
    byKey.set(key, unit);
    units.push(unit);
  }
  return units;
}

/* ------------------------------------------------------------- paint order */

/** Where a shape is asked to go in the paint order. */
export type ZMove = 'forward' | 'backward' | 'front' | 'back';

/**
 * One child of one parent: a loose shape, or a whole group.
 *
 * `doc.shapes` is flat, so the tree it stands for has to be read out before
 * anything can be reordered inside it. This is that reading, one level at a time.
 */
interface Child {
  /** The group this child is, or `null` when it is the shape in `shape`. */
  group: string | null;
  shape: Shape | null;
}

const childKey = (c: Child): string => c.group ?? c.shape!.id;

/**
 * The children of one parent, in paint order.
 *
 * A group appears where its first shape does, which is where the whole run of it
 * begins. That only reads as a position because a group's shapes are contiguous,
 * so this function and §49's invariant hold each other up.
 */
function childrenOf(doc: Doc, parent: string | null): Child[] {
  const out: Child[] = [];
  const seen = new Set<string>();
  for (const sh of doc.shapes) {
    const own = sh.group ?? null;
    if (own === parent) {
      out.push({ group: null, shape: sh });
      continue;
    }
    /* The ancestor of this shape that is a direct child of `parent`. A chain
       member whose own parent is `parent` can only be that, because the chain is
       the path to the root: anything above it is above `parent` too. A shape not
       descended from `parent` has no such member and belongs to no child here. */
    const chain = groupChain(doc, own);
    const at = chain.find((g) => (g.parent ?? null) === parent);
    if (!at || seen.has(at.id)) continue;
    seen.add(at.id);
    out.push({ group: at.id, shape: null });
  }
  return out;
}

/**
 * Put every group's shapes back into one run, in place.
 *
 * §49's invariant -- a group's shapes are contiguous in `doc.shapes` -- was held
 * by asking every operation that touches the array to preserve it, and by a note
 * naming `groupSelection` as the only one that had to think about it. That was
 * wrong in both halves: `reorderShapes` and `dropShapes` also rebuild the array,
 * and `groupSelection` was the one operation that could break the invariant.
 * Grouping a loose shape with one taken from the middle of an existing group
 * split that group into two runs, and `exportSvg` then wrote it as two `<g>`
 * elements under two different ids, so the file no longer said what the document
 * said.
 *
 * An invariant every caller has to remember is one a caller will eventually
 * forget, so this restores it instead. The store runs it after every edit, which
 * makes a broken run a state the document cannot be left in rather than a rule
 * each new operation has to be told about.
 *
 * A group keeps the position of its first shape, so an arrangement nobody
 * disturbed is returned unchanged.
 */
export function rebuildPaintOrder(doc: Doc): void {
  if (!doc.groups?.length) return;
  const orders = new Map<string | null, Child[]>();
  const parents: (string | null)[] = [null, ...doc.groups.map((g) => g.id)];
  for (const p of parents) orders.set(p, childrenOf(doc, p));
  const next = flattenOrders(orders, doc.shapes);
  if (next.some((s, i) => s !== doc.shapes[i])) doc.shapes = next;
}

/**
 * Move the selected children one step, or all the way, through their parent.
 *
 * Reordering happens per parent and never across one, which is §49's invariant
 * stated as a behaviour: a shape leaving its group's run could not be written as
 * one `<g>`. So "bring forward" on a grouped shape means forward among its
 * siblings and it stops at the edge of the group. Front and back on a group move
 * the group. Ungroup is how a shape leaves.
 *
 * `doc.shapes` is then rebuilt by walking the tree, so contiguity holds by
 * construction rather than by every branch here remembering to preserve it.
 */
export function reorderShapes(doc: Doc, ids: ReadonlySet<string>, move: ZMove): boolean {
  const units = arrangeUnits(doc, ids);
  if (units.length === 0) return false;

  /* Which child of which parent each unit is. A unit that is a group is a child
     of that group's own parent; a loose shape is a child of its group. */
  const moving = new Map<string | null, Set<string>>();
  for (const u of units) {
    const parent = u.group
      ? (findGroup(doc, u.group)?.parent ?? null)
      : (u.shapes[0].group ?? null);
    const key = u.group ?? u.shapes[0].id;
    const set = moving.get(parent) ?? new Set<string>();
    set.add(key);
    moving.set(parent, set);
  }

  const orders = new Map<string | null, Child[]>();
  const parents: (string | null)[] = [null, ...(doc.groups ?? []).map((g) => g.id)];
  for (const p of parents) orders.set(p, childrenOf(doc, p));

  let changed = false;
  for (const [parent, keys] of moving) {
    const list = orders.get(parent);
    if (!list) continue;
    const next = stepped(list, keys, move);
    if (next.some((c, i) => childKey(c) !== childKey(list[i]))) changed = true;
    orders.set(parent, next);
  }
  if (!changed) return false;

  doc.shapes = flattenOrders(orders, doc.shapes);
  return true;
}

/**
 * Move the chosen children of one parent to sit immediately before `before`.
 *
 * What dragging a row in the shape list means, where `reorderShapes` is what the
 * four buttons and `Ctrl+[` mean. Both end at `flattenOrders`, so both preserve
 * §49's invariant the same way: the tree is reordered and the flat paint order
 * is rebuilt from it, rather than each caller remembering to keep a group's
 * shapes together.
 *
 * `parent` names the list being reordered and `before` a key in it, or `null`
 * for the end of it. **Nothing crosses a parent**, which is the same rule stated
 * the same way: a drop outside the moving row's own list is not a legal drop,
 * and the caller is expected to have clamped the pointer to that list rather
 * than to pass a target from another one. A key that is not in `parent`'s list
 * lands at the end of it rather than nowhere.
 */
export function dropShapes(
  doc: Doc,
  ids: ReadonlySet<string>,
  parent: string | null,
  before: string | null,
): boolean {
  const units = arrangeUnits(doc, ids);
  if (units.length === 0) return false;

  const orders = new Map<string | null, Child[]>();
  const parents: (string | null)[] = [null, ...(doc.groups ?? []).map((g) => g.id)];
  for (const p of parents) orders.set(p, childrenOf(doc, p));

  const list = orders.get(parent);
  if (!list) return false;

  const keys = new Set<string>();
  for (const u of units) keys.add(u.group ?? u.shapes[0].id);

  const picked = list.filter((c) => keys.has(childKey(c)));
  if (picked.length === 0) return false;
  const rest = list.filter((c) => !keys.has(childKey(c)));
  /* The index is taken in `rest`, not in `list`. Taking it in `list` counts the
     rows that are about to leave, so dragging a row downward past its own
     neighbours lands it one place short of where the line was drawn. */
  const at = before === null ? rest.length : rest.findIndex((c) => childKey(c) === before);
  const cut = at < 0 ? rest.length : at;

  const next = [...rest.slice(0, cut), ...picked, ...rest.slice(cut)];
  if (next.every((c, i) => childKey(c) === childKey(list[i]))) return false;

  orders.set(parent, next);
  doc.shapes = flattenOrders(orders, doc.shapes);
  return true;
}

/** One list reordered: the chosen entries move, the rest close up around them. */
function stepped(list: Child[], keys: ReadonlySet<string>, move: ZMove): Child[] {
  const chosen = (c: Child): boolean => keys.has(childKey(c));
  if (move === 'front' || move === 'back') {
    const picked = list.filter(chosen);
    const rest = list.filter((c) => !chosen(c));
    return move === 'front' ? [...rest, ...picked] : [...picked, ...rest];
  }

  const out = [...list];
  /* Swept from the leading end, so a run of neighbours moves as a block instead
     of the first one hopping over the second and the second then hopping back. */
  if (move === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) {
      if (chosen(out[i]) && !chosen(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (chosen(out[i]) && !chosen(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]];
    }
  }
  return out;
}

/**
 * Walk the tree of orders back into one flat paint order.
 *
 * **Total: every shape that went in comes out.** The walk starts at the root, so
 * a shape whose group chain never reaches the root is sitting in the map under a
 * key nothing visits. That happens for a group whose `parent` names no group and
 * for two groups naming each other, both of which a workspace file can carry.
 * Returning the walk's result alone deletes those shapes from the document and
 * reports success, which is the one outcome no reorder is allowed to have.
 *
 * So anything the walk missed is appended in the order it had. It is loose in
 * the paint order rather than where its broken chain would have put it, which is
 * the honest answer: there is no such place. `pruneGroups` clears the dangling
 * parent on the next edit and the shape settles.
 */
function flattenOrders(orders: Map<string | null, Child[]>, all: readonly Shape[]): Shape[] {
  const out: Shape[] = [];
  const done = new Set<string>();
  const walk = (parent: string | null): void => {
    for (const c of orders.get(parent) ?? []) {
      if (!c.group) {
        out.push(c.shape!);
        continue;
      }
      // Bounded against a parent cycle, which would otherwise recur forever.
      if (done.has(c.group)) continue;
      done.add(c.group);
      walk(c.group);
    }
  };
  walk(null);

  if (out.length === all.length) return out;
  const kept = new Set(out.map((s) => s.id));
  for (const s of all) if (!kept.has(s.id)) out.push(s);
  return out;
}

/** The box every unit sits in, or `null` when there are none. */
export function unitsBox(units: Unit[]): Box | null {
  let box: Box | null = null;
  for (const u of units) box = unionBox(box, u.box);
  return box;
}

/** Move a unit and keep its cached box true. */
function translateUnit(u: Unit, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const m = translate(dx, dy);
  for (const sh of u.shapes) transformShape(sh, m);
  u.box = { x0: u.box.x0 + dx, y0: u.box.y0 + dy, x1: u.box.x1 + dx, y1: u.box.y1 + dy };
}

/** Put the named edge of every unit on the same edge of the frame. */
export function alignUnits(units: Unit[], edge: AlignMode, frame: Box): void {
  const target = edgeOf(frame, edge);
  const horizontal = isHorizontal(edge);
  for (const u of units) {
    const d = target - edgeOf(u.box, edge);
    translateUnit(u, horizontal ? d : 0, horizontal ? 0 : d);
  }
}

/**
 * Space the named edge of every unit evenly.
 *
 * Illustrator distributes between the two outermost objects, which stay where
 * they are. That is this function given the selection's own box as the frame,
 * because then the extreme edge already sits on the frame. Given the canvas
 * instead, the outer two go flush against its sides and the rest spread between
 * them, which is what "distribute across the canvas" has to mean if it is to
 * differ from distributing within the selection at all.
 *
 * Fewer than three units is a no-op: two are already evenly spaced.
 */
export function distributeUnits(units: Unit[], edge: AlignMode, frame: Box): void {
  if (units.length < 3) return;
  const horizontal = isHorizontal(edge);
  const sorted = [...units].sort((a, b) => edgeOf(a.box, edge) - edgeOf(b.box, edge));

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const lo = horizontal
    ? frame.x0 + (edgeOf(first.box, edge) - first.box.x0)
    : frame.y0 + (edgeOf(first.box, edge) - first.box.y0);
  const hi = horizontal
    ? frame.x1 - (last.box.x1 - edgeOf(last.box, edge))
    : frame.y1 - (last.box.y1 - edgeOf(last.box, edge));

  const step = (hi - lo) / (sorted.length - 1);
  sorted.forEach((u, i) => {
    const d = lo + step * i - edgeOf(u.box, edge);
    translateUnit(u, horizontal ? d : 0, horizontal ? 0 : d);
  });
}

/**
 * Put the same gap between every pair of neighbours, across the frame.
 *
 * `gap` of `null` asks for whatever gap fills the frame exactly, which against
 * the selection's own box leaves the outer two where they are and evens out the
 * middle. A number packs the units from the frame's leading edge at that gap,
 * so the run ends wherever it ends.
 *
 * Nothing clamps a negative result. Units wider than the frame they are being
 * spaced across can only overlap, and overlapping them by an even amount is a
 * truer answer than refusing or than silently spilling off one end.
 */
export function spaceUnits(units: Unit[], axis: 'h' | 'v', frame: Box, gap: number | null): void {
  if (units.length < 2) return;
  const horizontal = axis === 'h';
  const size = (u: Unit): number => (horizontal ? u.box.x1 - u.box.x0 : u.box.y1 - u.box.y0);
  const low = (u: Unit): number => (horizontal ? u.box.x0 : u.box.y0);

  const sorted = [...units].sort((a, b) => low(a) - low(b));
  const span = horizontal ? frame.x1 - frame.x0 : frame.y1 - frame.y0;
  const total = sorted.reduce((sum, u) => sum + size(u), 0);
  const g = gap ?? (span - total) / (sorted.length - 1);

  let at = horizontal ? frame.x0 : frame.y0;
  for (const u of sorted) {
    const d = at - low(u);
    translateUnit(u, horizontal ? d : 0, horizontal ? 0 : d);
    at += size(u) + g;
  }
}
