/**
 * Every mutation the editor can perform on geometry.
 *
 * These functions mutate in place and know nothing about undo, rendering or
 * selection -- the store wraps them. Because the model is nodes-and-handles,
 * each one is a handful of lines with no per-command branching.
 */

import {
  cubicAt,
  cubicDerivAt,
  cubicLength,
  cubicOver,
  cubicSecondDerivAt,
  cubicUnitTangent,
  projectToCubic,
  reverseCubic,
  splitCubic,
} from '../core/bezier';
import { bendOf, bendToHandles } from '../core/bend';
import type { Bend } from '../core/bend';
import { applyMat } from '../core/affine';
import type { Mat } from '../core/affine';
import { arcHandle } from '../core/primitives';
import {
  cloneNode,
  clonePt,
  clonePtOrNull,
  continuityOf,
  endNodeIndex,
  makeNode,
  MEET,
  nextNodeId,
  segmentAsCubic,
  segmentCount,
  SAME_PLACE,
  segmentIsLine,
} from '../core/types';
import type { Cubic, Doc, NodeContinuity, PathNode, Pt, Shape, Subpath } from '../core/types';
import type { NodeRef } from './doc';

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);
/** Lengthen a handle about the anchor it belongs to, keeping its direction. */
const stretchHandle = (anchor: Pt, h: Pt, k: number): Pt =>
  add(anchor, [(h[0] - anchor[0]) * k, (h[1] - anchor[1]) * k]);

/**
 * Where a missing handle would sit: one third along the segment it governs.
 *
 * Returns `null` when there is no segment on that side (the ends of an open
 * subpath), because there is nothing there to curve.
 */
export function latentHandle(sp: Subpath, i: number, which: 'in' | 'out'): Pt | null {
  const n = sp.nodes.length;
  if (n < 2) return null;

  // The neighbour across the governed segment. Past the end of an open subpath
  // there is no such segment; a closed one wraps round to the far end.
  const other = i + (which === 'out' ? 1 : -1);
  if (!sp.closed && (other < 0 || other >= n)) return null;

  const a = sp.nodes[i].pt;
  const b = sp.nodes[(other + n) % n].pt;
  return [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3];
}

/**
 * Round to the grid. `step` of 0 disables snapping.
 *
 * `phase` shifts the lattice, for pixel-fitting: a one-unit stroke wants its
 * centreline on half-integers, not integers. See `model/pixelfit.ts`. It is a
 * shift and not a second lattice, so everything downstream is unaffected.
 */
export function snap(p: Pt, step: number, phase = 0): Pt {
  if (!step) return p;
  const one = (v: number): number => Math.round((v - phase) / step) * step + phase;
  return [one(p[0]), one(p[1])];
}

/* ----------------------------------------------------------------- moving */

/** Move an anchor, carrying its handles so the adjacent curvature is preserved. */
export function moveAnchor(sp: Subpath, i: number, to: Pt): void {
  const n = sp.nodes[i];
  const d = sub(to, n.pt);
  n.pt = to;
  if (n.hIn) n.hIn = add(n.hIn, d);
  if (n.hOut) n.hOut = add(n.hOut, d);
}

/**
 * Move one handle, preserving whatever relationship the two handles already had.
 *
 * The node has no stored type, so the relationship is read off the geometry
 * BEFORE the move -- afterwards the pair is no longer collinear and would
 * always read as a cusp, so a smooth node would break itself on its first drag.
 * Having read it, a `smooth` pair keeps the other handle's length and rotates it
 * to match; a `symmetric` pair mirrors exactly; a cusp moves one handle alone.
 *
 * Because the relation is re-read every move, it is self-maintaining: mirroring
 * keeps lengths exactly equal, so a symmetric node stays symmetric for as long
 * as the drag lasts, and a broken one stays broken.
 *
 * `breakPair` is the Alt-drag escape hatch: move this handle alone regardless,
 * which leaves the pair non-collinear and therefore a cusp from then on.
 */
export function moveHandle(
  sp: Subpath,
  i: number,
  which: 'in' | 'out',
  to: Pt,
  breakPair = false,
): void {
  const n = sp.nodes[i];
  const was = breakPair ? 'cusp' : continuityOf(n);

  if (which === 'in') n.hIn = to;
  else n.hOut = to;

  if (was === 'cusp') return;

  const otherKey = which === 'in' ? 'hOut' : 'hIn';
  const other = n[otherKey];
  if (!other) return;

  const v = sub(n.pt, to);
  const m = len(v);
  if (m < 1e-12) return;

  const keep = was === 'symmetric' ? m : len(sub(other, n.pt));
  n[otherKey] = [n.pt[0] + (v[0] / m) * keep, n.pt[1] + (v[1] / m) * keep];
}

/**
 * Force a node into a given continuity by MOVING ITS HANDLES.
 *
 * With no stored flag there is nothing else to set: to make a node smooth you
 * align its handles, and to make it a cusp you take its handles away. Every
 * call is therefore a real edit to the geometry or no edit at all.
 *
 * A cusp has no handles, so smooth and symmetric materialise them a third
 * along each neighbouring segment and then rotate both to the averaged
 * direction. That moves the drawing: a right-angle corner with 10-unit sides
 * shifts by 1.48 units.
 *
 * Returns whether the handles changed, so a caller can skip an undo entry.
 * `false` for an end of an open subpath, which has no outside segment to align
 * against, and for a node already in the requested state -- which is why
 * `smooth` on a symmetric node reports nothing: symmetric *is* smooth. §6.
 */
export function setContinuity(sp: Subpath, i: number, kind: NodeContinuity): boolean {
  const n = sp.nodes[i];

  if (kind === 'cusp') {
    if (!n.hIn && !n.hOut) return false;
    n.hIn = null;
    n.hOut = null;
    return true;
  }

  /* Work on candidates, not on the node. Assigning the materialised handles
     first and *then* discovering there is no second one to align against left
     a straight segment carrying a handle -- which breaks the rule that a null
     handle is what makes a segment a line -- while the caller announced that
     nothing had happened. Decide first; commit only a complete answer. */
  const hIn = n.hIn ?? latentHandle(sp, i, 'in');
  const hOut = n.hOut ?? latentHandle(sp, i, 'out');
  if (!hIn || !hOut) return false;

  // Average the two directions rather than adopting one of them, so the result
  // does not depend on which handle happens to be called "out".
  const din = norm(sub(n.pt, hIn));
  const dout = norm(sub(hOut, n.pt));
  if (!din || !dout) return false;

  let dx = din[0] + dout[0];
  let dy = din[1] + dout[1];
  if (Math.hypot(dx, dy) < 1e-9) {
    // Exactly opposed: no average exists, so keep the outgoing direction.
    dx = dout[0];
    dy = dout[1];
  }
  const m = Math.hypot(dx, dy);
  const ux = dx / m;
  const uy = dy / m;

  const lIn = len(sub(hIn, n.pt));
  const lOut = len(sub(hOut, n.pt));
  const [a, b] = kind === 'symmetric' ? [(lIn + lOut) / 2, (lIn + lOut) / 2] : [lIn, lOut];

  const nextIn: Pt = [n.pt[0] - ux * a, n.pt[1] - uy * a];
  const nextOut: Pt = [n.pt[0] + ux * b, n.pt[1] + uy * b];
  if (samePt(n.hIn, nextIn) && samePt(n.hOut, nextOut)) return false;

  n.hIn = nextIn;
  n.hOut = nextOut;
  return true;
}

/** Handle comparison, where a missing handle differs from every real one. */
function samePt(a: Pt | null, b: Pt | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
}

/** Unit vector, or `null` if there is no direction to speak of. */
function norm(v: Pt): Pt | null {
  const m = len(v);
  return m < 1e-12 ? null : [v[0] / m, v[1] / m];
}

/* -------------------------------------------------------- adding, removing */

/**
 * Insert a node partway along a segment without changing the drawn shape.
 *
 * de Casteljau gives two curves that trace the original exactly. A split line
 * stays two lines rather than becoming two degenerate curves -- otherwise
 * subdividing a rectangle would quietly make every edge curved.
 */
export function splitSegment(sp: Subpath, segIdx: number, t: number): number {
  const aI = segIdx;
  const bI = endNodeIndex(sp, segIdx);
  const a = sp.nodes[aI];
  const b = sp.nodes[bI];

  if (segmentIsLine(sp, segIdx)) {
    const mid: Pt = [a.pt[0] + (b.pt[0] - a.pt[0]) * t, a.pt[1] + (b.pt[1] - a.pt[1]) * t];
    sp.nodes.splice(aI + 1, 0, makeNode(mid));
    return aI + 1;
  }

  const [left, right] = splitCubic(segmentAsCubic(sp, segIdx), t);
  a.hOut = left[1];
  b.hIn = right[2];
  // de Casteljau puts the two new handles collinear with the split point by
  // construction, so the inserted node reads as smooth without being told to.
  sp.nodes.splice(aI + 1, 0, makeNode(left[3], left[2], right[1]));
  return aI + 1;
}

/**
 * Remove a node, fusing its two segments into one.
 *
 * The surviving handles are stretched by how much of the new span each used to
 * cover, which keeps the end tangents and approximates the old path closely
 * without a full curve fit. The 3x clamp stops a very short segment adjacent to
 * a very long one from flinging its handle across the canvas.
 *
 * **There is no minimum size, and deletion never refuses.** A closed subpath
 * goes down to two nodes quite happily: two segments between the same pair of
 * points, which draws as a lens when they are curved and as a plain line when
 * they are not. Below two nodes there is nothing left that draws or serialises,
 * so the caller prunes it.
 *
 * Do not add a minimum back. A floor makes deletion refuse partway through a
 * loop over a selection, which turns "delete these four" into "delete one" and
 * reads as a bug in the marquee. The degenerate results are visible, reversible
 * and rare; a silent refusal is none of those. See `docs/ARCHITECTURE.md` §13.
 */
export function deleteNode(sp: Subpath, i: number): boolean {
  const n = sp.nodes.length;
  if (i < 0 || i >= n) return false;

  // Two nodes or fewer: no pair of segments to fuse, so the node just goes and
  // what remains is the caller's to prune. A lone node is not a path -- it has
  // no segments, draws nothing, and the parser drops a bare `M` on the way back
  // in -- so it must not be left claiming to be one.
  if (n <= 2) {
    sp.nodes.splice(i, 1);
    if (sp.nodes.length === 1) {
      sp.nodes[0].hIn = null;
      sp.nodes[0].hOut = null;
      sp.closed = false;
    }
    return true;
  }

  if (!sp.closed && (i === 0 || i === n - 1)) {
    // An endpoint has only one segment; drop it and let the path get shorter.
    sp.nodes.splice(i, 1);
    if (i === 0) sp.nodes[0].hIn = null;
    else sp.nodes[sp.nodes.length - 1].hOut = null;
    return true;
  }

  const prevI = (i - 1 + n) % n;
  const nextI = (i + 1) % n;
  const prev = sp.nodes[prevI];
  const next = sp.nodes[nextI];

  /* A shortcut, not a second behaviour. Both segments being straight means
     `prev.hOut` and `next.hIn` are already null -- that is what `segmentIsLine`
     reads -- so the rescale below would find nothing to rescale and reach the
     same splice. What this saves is two `cubicLength` walks per node, which a
     marquee delete over a traced drawing pays thousands of times. */
  if (segmentIsLine(sp, prevI) && segmentIsLine(sp, i)) {
    sp.nodes.splice(i, 1);
    return true;
  }

  const l1 = cubicLength(segmentAsCubic(sp, prevI));
  const l2 = cubicLength(segmentAsCubic(sp, i));
  const total = l1 + l2;
  const k1 = Math.min(3, total / Math.max(l1, 1e-9));
  const k2 = Math.min(3, total / Math.max(l2, 1e-9));

  if (prev.hOut) prev.hOut = stretchHandle(prev.pt, prev.hOut, k1);
  if (next.hIn) next.hIn = stretchHandle(next.pt, next.hIn, k2);

  sp.nodes.splice(i, 1);
  return true;
}

/**
 * Remove nodes and leave a gap where each one was, instead of fusing across it.
 *
 * The counterpart to calling `deleteNode` repeatedly. Where that keeps the path
 * whole by rebuilding a segment — approximately, since two cubics do not
 * generally reduce to one — this keeps every surviving segment **exactly** as it
 * was and simply stops joining them up.
 *
 * The survivors fall into maximal runs of originally-adjacent nodes, and each
 * run becomes an open subpath. Runs of one node are dropped: a lone node has no
 * segments, draws nothing, and the parser discards a bare `M` on the way back
 * in, so keeping it would leave an invisible thing in the document.
 *
 * A closed subpath always comes back open — removing any node from a ring
 * breaks it — which is why the scan starts just after a deleted node, so the
 * runs do not wrap.
 */
export function deleteNodesSplitting(sp: Subpath, remove: Set<number>): Subpath[] {
  const n = sp.nodes.length;
  if (!remove.size) return [sp];

  let start = 0;
  if (sp.closed) {
    let first = -1;
    for (let i = 0; i < n; i++) {
      if (remove.has(i)) {
        first = i;
        break;
      }
    }
    if (first < 0) return [sp];
    start = (first + 1) % n;
  }

  const runs: number[][] = [];
  let run: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = sp.closed ? (start + k) % n : k;
    if (remove.has(i)) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push(i);
    }
  }
  if (run.length) runs.push(run);

  return runs
    .filter((r) => r.length >= 2)
    .map((r) => {
      const nodes = r.map((i) => cloneNode(sp.nodes[i]));
      // Each end now faces a gap, so the handle that governed the segment into
      // that gap goes with it. Where a run reaches the original path's own end
      // the handle was already null and this is a no-op.
      nodes[0].hIn = null;
      nodes[nodes.length - 1].hOut = null;
      return { nodes, closed: false };
    });
}

/**
 * Split a subpath at node `i`, leaving two ends where there was one path.
 *
 * The node is **duplicated** rather than moved, so nothing about the drawing
 * changes: both new ends sit exactly where the old node was, carrying the
 * handle that faces the side they kept. That makes this the exact counterpart
 * of deleting a node, which is lossy by nature — fusing two cubics into one
 * cannot be exact across an inflection. Breaking is lossless because it removes
 * a join rather than a point.
 *
 * A closed subpath is opened in place: it becomes one open path starting and
 * ending at `i`. An open one becomes two. Returns the pieces to replace the
 * subpath with, or `null` when there is nothing to break — an endpoint has no
 * second side to split off.
 */
export function breakAt(sp: Subpath, i: number): Subpath[] | null {
  const n = sp.nodes.length;
  if (i < 0 || i >= n) return null;

  /* The end that was not there before is a new node and needs an id of its own.
     `cloneNode` carries the id through, which is what a history snapshot wants
     and the opposite of what this wants: two ends answering to one id are two
     ends no selection can separate, so clicking either drags both and the path
     can never be pulled open. The front keeps the original id, so a selection
     naming the node still names something afterwards. */
  if (sp.closed) {
    if (n < 2) return null;
    // Rotate so the break lands at both ends. The clone at the front keeps the
    // outgoing handle, the one at the back keeps the incoming handle, which is
    // precisely the pair of segments that used to meet here.
    const rotated = [...sp.nodes.slice(i), ...sp.nodes.slice(0, i)].map(cloneNode);
    const tail = { ...cloneNode(sp.nodes[i]), id: nextNodeId() };
    rotated[0].hIn = null;
    tail.hOut = null;
    return [{ nodes: [...rotated, tail], closed: false }];
  }

  if (i === 0 || i === n - 1) return null;

  const head = sp.nodes.slice(0, i + 1).map(cloneNode);
  const tail = sp.nodes.slice(i).map(cloneNode);
  tail[0].id = nextNodeId();
  head[head.length - 1].hOut = null;
  tail[0].hIn = null;
  return [
    { nodes: head, closed: false },
    { nodes: tail, closed: false },
  ];
}

/** Turn a segment between a line and a curve, seeding handles at the thirds. */
export function setSegmentCurved(sp: Subpath, segIdx: number, curved: boolean): void {
  const a = sp.nodes[segIdx];
  const b = sp.nodes[endNodeIndex(sp, segIdx)];
  if (!curved) {
    a.hOut = null;
    b.hIn = null;
    return;
  }
  if (a.hOut === null) a.hOut = [a.pt[0] + (b.pt[0] - a.pt[0]) / 3, a.pt[1] + (b.pt[1] - a.pt[1]) / 3];
  if (b.hIn === null) b.hIn = [b.pt[0] - (b.pt[0] - a.pt[0]) / 3, b.pt[1] - (b.pt[1] - a.pt[1]) / 3];
}

export function closeSubpath(sp: Subpath): void {
  if (sp.nodes.length >= 2) sp.closed = true;
}

/** One end of an open path, named as the thing to be joined. */
export interface JoinEnd {
  sp: Subpath;
  i: number;
}

/** Whether a node is a free end: an open path, first or last node. */
export function isPathEnd(sp: Subpath, i: number): boolean {
  return !sp.closed && (i === 0 || i === sp.nodes.length - 1);
}

/** Move a node and carry its handles, so the curvature either side is kept. */
function shiftNodeTo(n: PathNode, to: Pt): void {
  const dx = to[0] - n.pt[0];
  const dy = to[1] - n.pt[1];
  n.pt = to;
  if (n.hIn) n.hIn = [n.hIn[0] + dx, n.hIn[1] + dy];
  if (n.hOut) n.hOut = [n.hOut[0] + dx, n.hOut[1] + dy];
}

/**
 * Span the gap between two free ends with a segment. Nothing moves.
 *
 * There are two operations here and they are worth keeping apart, because a
 * single name covering both was wrong in the way names usually are: it did the
 * destructive one. **Connect** is the literal reading of "join these two ends" —
 * draw the line that is missing, keep both nodes, and leave every coordinate
 * where it was. `mergeEnds` below is the other one, and it costs a node.
 *
 * Inkscape ships both and names them almost identically, which is where the
 * confusion started: `Shift+J` merges nodes, `Shift+Ctrl+J` joins them with a
 * segment. Here `Shift+J` is Connect, because that is what the word means to a
 * reader who has not memorised Inkscape.
 *
 * Two ends of the SAME path close it, since the closing edge of a ring is
 * exactly the segment that was missing. Two ends of different paths concatenate
 * with a new segment between them. The result is one subpath; the caller
 * removes whichever subpath it replaced.
 */
export function connectEnds(a: JoinEnd, b: JoinEnd): Subpath | null {
  if (!isPathEnd(a.sp, a.i) || !isPathEnd(b.sp, b.i)) return null;

  if (a.sp === b.sp) {
    // Closing a path IS adding the missing segment: the ring's last edge runs
    // from the final node back to the first, and both nodes stay.
    if (a.i === b.i || a.sp.nodes.length < 2) return null;
    a.sp.closed = true;
    return a.sp;
  }

  if (a.i === 0) reverseSubpath(a.sp);
  if (b.i !== 0) reverseSubpath(b.sp);

  /* Nothing is welded and nothing moves. Both ends keep their positions, and
     the segment between them is straight for free: the last node of an open
     path has no outgoing handle and the first has no incoming one, which is
     exactly what a straight segment is made of. */
  return { nodes: [...a.sp.nodes, ...b.sp.nodes], closed: false };
}

/**
 * Weld two free ends into a single node.
 *
 * Where `connectEnds` spans the gap, this closes it: the two nodes merge at
 * their midpoint, so coincident ends do not move and this exactly undoes a
 * `breakAt`. Each end keeps the handle facing away from the joint, the other
 * having governed nothing.
 *
 * Two ends of one path close it into a ring; two of different paths
 * concatenate, reversing either so the directions agree. The caller removes
 * whichever subpath was replaced.
 *
 * `null` when either node is not a free end, when both are the same node, or
 * when closing would leave fewer than two nodes.
 */
export function mergeEnds(a: JoinEnd, b: JoinEnd): Subpath | null {
  if (!isPathEnd(a.sp, a.i) || !isPathEnd(b.sp, b.i)) return null;

  const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];

  if (a.sp === b.sp) {
    const sp = a.sp;
    // The two ends of one path. Same node twice is not a join, and welding a
    // two-node path would leave a single node, which draws nothing.
    if (a.i === b.i || sp.nodes.length < 3) return null;

    const first = sp.nodes[0];
    const last = sp.nodes[sp.nodes.length - 1];
    const at = mid(first.pt, last.pt);
    shiftNodeTo(first, at);
    shiftNodeTo(last, at);

    // The closing segment ends at what is now node 0, so it inherits the
    // incoming handle the old last node carried.
    first.hIn = last.hIn;
    sp.nodes.pop();
    sp.closed = true;
    return sp;
  }

  // Orient both so that `a` finishes where `b` starts.
  if (a.i === 0) reverseSubpath(a.sp);
  if (b.i !== 0) reverseSubpath(b.sp);

  const tail = a.sp.nodes[a.sp.nodes.length - 1];
  const head = b.sp.nodes[0];
  const at = mid(tail.pt, head.pt);
  shiftNodeTo(tail, at);
  shiftNodeTo(head, at);

  return {
    nodes: [
      ...a.sp.nodes.slice(0, -1),
      { id: tail.id, pt: at, hIn: tail.hIn, hOut: head.hOut },
      ...b.sp.nodes.slice(1),
    ],
    closed: false,
  };
}

/**
 * Why two nodes could not be fused.
 *
 * Same shape as `RoundRefusal`, and for the same reason: each of these is
 * something the person who pressed the button can act on. `fuseNodes` returns
 * one of these or a `FuseResult`. There is no `null` in the union, so a caller
 * that tests for one is testing for a value that cannot arrive.
 */
export type FuseRefusal = 'same' | 'apart' | 'tiny';

export interface FuseResult {
  /** How far each of the two nodes travelled to meet. Zero when already coincident. */
  moved: number;
}

/**
 * Weld two ADJACENT nodes into one, anywhere along a path.
 *
 * The pair is already joined by a segment, so this removes that segment and
 * changes no topology -- which is why it is simpler than `mergeEnds`, not
 * harder. The survivor sits at the midpoint keeping the handle facing away from
 * the joint on each side, so two nodes already coincident do not move. That is
 * the case that matters: this is the repair for a zero-length segment.
 *
 * **Adjacent only.** A pair further apart has a run of segments between them,
 * and welding would pinch the path into two loops and discard the run. §24.
 */
export function fuseNodes(sp: Subpath, i: number, j: number): FuseResult | FuseRefusal {
  const n = sp.nodes.length;
  if (!Number.isInteger(i) || !Number.isInteger(j)) return 'same';
  if (i < 0 || j < 0 || i >= n || j >= n) return 'same';
  if (i === j) return 'same';

  /* Order the pair so `a` precedes `b` along the direction of travel. In a
     closed subpath the last node also precedes the first, which is the pair the
     ordinary comparison gets backwards. */
  let a = Math.min(i, j);
  let b = Math.max(i, j);
  const wraps = sp.closed && a === 0 && b === n - 1 && n > 2;
  if (wraps) [a, b] = [b, a];
  else if (b - a !== 1) return 'apart';

  // Two nodes is the least that draws anything, closed or open. Fusing a pair
  // out of two would leave one, which draws nothing and which the parser drops
  // on the way back in.
  if (n <= 2) return 'tiny';

  const first = sp.nodes[a];
  const second = sp.nodes[b];
  const moved = Math.hypot(second.pt[0] - first.pt[0], second.pt[1] - first.pt[1]) / 2;
  const at: Pt = [(first.pt[0] + second.pt[0]) / 2, (first.pt[1] + second.pt[1]) / 2];

  // Carry the handles with their nodes first, so an already-coincident pair
  // keeps the curvature either side untouched down to the last bit.
  shiftNodeTo(first, at);
  shiftNodeTo(second, at);

  /* The survivor keeps an index rather than being appended: the earlier node
     normally, and node 0 across the seam, so repairing a ring does not re-root
     it. Either way it takes the incoming handle from the node that arrives and
     the outgoing one from the node that leaves, which is the pair of segments
     that still exists. */
  const keep = wraps ? second : first;
  keep.pt = at;
  keep.hIn = first.hIn;
  keep.hOut = second.hOut;
  sp.nodes.splice(wraps ? a : b, 1);

  return { moved };
}

/**
 * Distance below which two adjacent anchors count as the same point.
 *
 * Deliberately not an epsilon. The cases this repairs put the two anchors at
 * *bit-identical* coordinates, so 1e-9 would do; the looser bound is for
 * geometry that has been through a rotate and a scale since, where a segment
 * that was born zero-length comes back a few ulps long. Anything a person could
 * see is far above this.
 */
const DEGENERATE = 1e-7;

/**
 * Weld away a subpath's zero-length segments. Returns how many went.
 *
 * Not quite *every* one: the sweep stops at two nodes, because one node draws
 * nothing and the parser discards it on the way back in. A path whose anchors
 * are all on the same point therefore comes back as two anchors on that point,
 * with one zero-length segment still in it. That is the least bad answer
 * available and it is worth stating rather than claiming otherwise.
 *
 * The sweep behind Fuse with a shape selected. `roundCorner` reuses a
 * neighbour when a tangent point lands on one, so it needs no sweep; anything
 * that places its nodes in one go and cannot check as it goes leaves the pair
 * for this to find. §23.
 */
export function fuseDegenerate(sp: Subpath): number {
  let gone = 0;
  // Backwards, so a splice cannot move a pair that has not been looked at yet.
  for (let i = segmentCount(sp) - 1; i >= 0; i--) {
    if (sp.nodes.length <= 2) break;
    const a = sp.nodes[i];
    const b = sp.nodes[endNodeIndex(sp, i)];
    if (Math.hypot(b.pt[0] - a.pt[0], b.pt[1] - a.pt[1]) > DEGENERATE) continue;
    if (typeof fuseNodes(sp, i, endNodeIndex(sp, i)) === 'string') continue;
    gone++;
  }
  return gone;
}

/** Flip drawing direction. Handles swap sides, and the ring is re-rooted. */
export function reverseSubpath(sp: Subpath): void {
  sp.nodes.reverse();
  for (const n of sp.nodes) {
    const t = n.hIn;
    n.hIn = n.hOut;
    n.hOut = t;
  }
  if (sp.closed && sp.nodes.length > 1) {
    // Reversing a ring moves the start; rotate it back so node 0 is unchanged.
    sp.nodes.unshift(sp.nodes.pop()!);
  }
}

/**
 * Why a corner could not be rounded, or `null` when it was. Named reasons
 * rather than a bare `false`: each one is something the caller can act on.
 */
export type RoundRefusal = 'end' | 'straight' | 'tiny';

export interface RoundResult {
  /** The radius actually used, which may be smaller than the one asked for. */
  radius: number;
  /** True when the sides were too short for the radius requested. */
  clamped: boolean;
}

/**
 * A corner that could be rounded, measured.
 *
 * `u` and `v` are the unit tangents leaving the corner, `alpha` the interior
 * angle between them. `sides` holds those two directions as the curves they
 * actually are, in the same order, each running from the corner outward, and
 * `lines` says which of them is straight.
 */
export interface Corner {
  at: Pt;
  u: Pt;
  v: Pt;
  alpha: number;
  /** The two sides, as cubics leaving the corner. `[0]` runs back toward the previous node. */
  sides: [Cubic, Cubic];
  /** Whether each side is a straight line, in `sides` order. */
  lines: [boolean, boolean];
  /** How much of each side there is to cut into, in `sides` order. */
  lengths: [number, number];
}

/** A straight cubic whose parameter moves at a constant speed along it. */
const evenLine = (a: Pt, b: Pt): Cubic => [
  clonePt(a),
  [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
  [a[0] + (b[0] - a[0]) * (2 / 3), a[1] + (b[1] - a[1]) * (2 / 3)],
  clonePt(b),
];

/**
 * A control point read back as a handle, or `null` where it sits on its anchor.
 *
 * The inverse of what `segmentAsCubic` does on the way out, so a segment taken
 * apart and put back keeps the model's own answer to "is this a line".
 */
const handleOrNull = (h: Pt, anchor: Pt): Pt | null =>
  Math.hypot(h[0] - anchor[0], h[1] - anchor[1]) <= SAME_PLACE ? null : clonePt(h);

/** The unsigned angle between two vectors. */
const turnBetween = (a: Pt, b: Pt): number =>
  Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));

/**
 * The two sides of the corner at `i`, as cubics leaving it.
 *
 * A straight segment is respaced so its parameter moves evenly. The model
 * stores a line with both controls on the anchors, which leaves the derivative
 * zero at each end, and the solver below reads a tangent exactly there. Same
 * line, same endpoints, a parameter that moves.
 */
function cornerSides(sp: Subpath, i: number): { sides: [Cubic, Cubic]; lines: [boolean, boolean] } {
  const n = sp.nodes.length;
  const prevI = (i - 1 + n) % n;
  const here = sp.nodes[i].pt;
  const lines: [boolean, boolean] = [segmentIsLine(sp, prevI), segmentIsLine(sp, i)];
  return {
    sides: [
      lines[0] ? evenLine(here, sp.nodes[prevI].pt) : reverseCubic(segmentAsCubic(sp, prevI)),
      lines[1] ? evenLine(here, sp.nodes[endNodeIndex(sp, i)].pt) : segmentAsCubic(sp, i),
    ],
    lines,
  };
}

/**
 * Measure the corner at node `i`, or say why there is not one.
 *
 * **A corner is a cusp, whatever its sides are made of.** What decides is
 * whether the path changes direction here, which is `alpha`, and not whether
 * the segments either side happen to be straight. Two curves meeting at an
 * angle is a corner to everyone who draws one, and it is the tangents that say
 * so.
 *
 * Shared with `roundCorner` rather than restated in it, because the widget on the
 * canvas and the button in the rail have to agree about which corners are
 * roundable and about what radius a given tangent point means. Two answers to
 * that would be two answers to "why did nothing happen".
 */
export function cornerAt(sp: Subpath, i: number): Corner | RoundRefusal {
  const n = sp.nodes.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) return 'tiny';
  if (!sp.closed && (i === 0 || i === n - 1)) return 'end';
  if (n < 3) return 'tiny';

  const { sides, lines } = cornerSides(sp, i);
  const u = cubicUnitTangent(sides[0], 0);
  const v = cubicUnitTangent(sides[1], 0);
  if (!u || !v) return 'tiny';

  // Interior angle at the corner, between the two tangents leaving it.
  const cos = Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1]));
  const alpha = Math.acos(cos);
  /* Nothing to round where the path runs smoothly through, and nothing sensible
     to do where it folds back on itself. A smooth node has its two tangents
     exactly opposed, which is what puts `alpha` at pi. */
  if (alpha > Math.PI - 1e-6 || alpha < 1e-6) return 'straight';

  const lengths: [number, number] = [
    lines[0] ? len(sub(sides[0][3], sides[0][0])) : cubicLength(sides[0]),
    lines[1] ? len(sub(sides[1][3], sides[1][0])) : cubicLength(sides[1]),
  ];
  if (lengths[0] < 1e-9 || lengths[1] < 1e-9) return 'tiny';

  return { at: clonePt(sp.nodes[i].pt), u, v, alpha, sides, lines, lengths };
}

/**
 * Solve `[c0 c1] step = -f` for the step, or `null` where the columns are parallel.
 *
 * The one piece of algebra both Newton solves here need, written once so a sign
 * cannot be right in the corner and wrong in its undo.
 */
function step2(c0: Pt, c1: Pt, f: Pt): Pt | null {
  const det = c0[0] * c1[1] - c1[0] * c0[1];
  if (Math.abs(det) < 1e-14) return null;
  return [(-f[0] * c1[1] + c1[0] * f[1]) / det, (-c0[0] * f[1] + f[0] * c0[1]) / det];
}

/** Where an arc of a given radius touches the two sides of a corner. */
interface Tangency {
  /** Parameter on each side, in `sides` order. */
  s: [number, number];
  /** The two touch points, in the same order. */
  at: [Pt, Pt];
  /** The arc's centre. */
  centre: Pt;
}

/** Parameter at arc distance `d` from the start of `b`, clamped to the curve. */
function paramAtDistance(b: Cubic, d: number, steps = 32): number {
  if (!(d > 0)) return 0;
  let acc = 0;
  let prev = cubicAt(b, 0);
  for (let k = 1; k <= steps; k++) {
    const q = cubicAt(b, k / steps);
    const seg = Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    prev = q;
    if (seg <= 0) continue;
    if (acc + seg >= d) return (k - 1 + (d - acc) / seg) / steps;
    acc += seg;
  }
  return 1;
}

/**
 * Place a circle of radius `r` tangent to both sides, inside the corner.
 *
 * Two equations, because the centre reached from one side has to be the centre
 * reached from the other. Two unknowns, one per side, saying where the circle
 * touches it. Newton from the answer two straight sides would give, which is
 * what any pair of sides looks like close enough to the corner, so the step
 * count stays small rather than growing with how hard the sides bend.
 *
 * `null` when no such circle sits on both sides within their length, which is
 * the same thing as the radius being too large for this corner.
 */
function tangentCircle(c: Corner, r: number): Tangency | null {
  const [A, B] = c.sides;
  /* Which way each side's normal turns to face the other. Fixed at the corner
     and carried, because reading it again further along would let an inflection
     flip the circle to the outside halfway through the solve. */
  const hand = c.u[0] * c.v[1] - c.u[1] * c.v[0];
  if (Math.abs(hand) < 1e-12) return null;

  /* Where a side puts the centre, and how that centre moves as the touch point
     slides. The normal is a unit vector, so its derivative is the tangent's
     with the part along the tangent taken out. */
  const from = (b: Cubic, s: number, rot: number): { at: Pt; c: Pt; d: Pt } | null => {
    const p = cubicAt(b, s);
    const d1 = cubicDerivAt(b, s);
    const L = Math.hypot(d1[0], d1[1]);
    if (L < 1e-12) return null;
    const d2 = cubicSecondDerivAt(b, s);
    const along = (d1[0] * d2[0] + d1[1] * d2[1]) / (L * L);
    const tx = (d2[0] - d1[0] * along) / L;
    const ty = (d2[1] - d1[1] * along) / L;
    return {
      at: p,
      c: [p[0] + (r * -d1[1] * rot) / L, p[1] + (r * d1[0] * rot) / L],
      d: [d1[0] - r * ty * rot, d1[1] + r * tx * rot],
    };
  };

  const cut = r / Math.tan(c.alpha / 2);
  const seed = (k: 0 | 1): number =>
    c.lines[k] ? Math.min(1, cut / c.lengths[k]) : paramAtDistance(c.sides[k], cut);
  let s = seed(0);
  let t = seed(1);

  const tol = 1e-9 * Math.max(1, r);
  for (let k = 0; k < 40; k++) {
    const ca = from(A, s, Math.sign(hand));
    const cb = from(B, t, -Math.sign(hand));
    if (!ca || !cb) return null;
    const f: Pt = [ca.c[0] - cb.c[0], ca.c[1] - cb.c[1]];
    if (Math.hypot(f[0], f[1]) <= tol) {
      return { s: [s, t], at: [ca.at, cb.at], centre: ca.c };
    }
    const step = step2(ca.d, [-cb.d[0], -cb.d[1]], f);
    if (!step) return null;
    /* Held on the sides rather than let loose. Past either end the cubic keeps
       going as a polynomial but the side has stopped, so a step out there would
       converge on a circle touching geometry that is not in the path. Pinned at
       an end the residual stays large and this refuses, which is exactly the
       radius being too big. */
    s = Math.min(1, Math.max(1e-9, s + step[0]));
    t = Math.min(1, Math.max(1e-9, t + step[1]));
  }
  return null;
}

/** The arc a corner actually gets for a requested radius, clamped to what fits. */
interface Arc extends Tangency {
  radius: number;
  clamped: boolean;
}

/**
 * The largest radius this corner holds, subject to `holds` on where it touches.
 *
 * Bisection rather than a formula, because with a curved side there is not one:
 * how far out the touch point travels for a given radius depends on how the
 * side bends the whole way there. Monotone, which is what makes bisection the
 * right tool -- a larger circle always touches further from the corner.
 */
function largestRadius(c: Corner, holds: (t: Tangency) => boolean): number {
  const ok = (r: number): boolean => {
    const t = tangentCircle(c, r);
    return t !== null && holds(t);
  };
  let lo = 0;
  let hi = Math.min(c.lengths[0], c.lengths[1]) * Math.tan(c.alpha / 2);
  if (!(hi > 0)) return 0;
  // The straight-sided answer is the right scale to start from; a curved side
  // moves it by a factor, so grow until it stops fitting and bracket from there.
  for (let k = 0; k < 8 && ok(hi); k++) {
    lo = hi;
    hi *= 2;
  }
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** How far along side `k` the touch point sits, measured along the side. */
const cutAlong = (c: Corner, t: Tangency, k: 0 | 1): number =>
  c.lines[k] ? t.s[k] * c.lengths[k] : cubicLength(cubicOver(c.sides[k], 0, t.s[k]));

/**
 * The largest radius a corner can hold before its arc runs off the end of a side.
 */
export function maxCornerRadius(c: Corner): number {
  /* Two lines touch a circle the same distance out along each, so the shorter
     side answers this outright. Not a shortcut for speed: the closed form is
     exact where a search only converges. */
  if (c.lines[0] && c.lines[1]) {
    return Math.min(c.lengths[0], c.lengths[1]) * Math.tan(c.alpha / 2);
  }
  return largestRadius(c, () => true);
}

/** The largest radius whose arc touches each side no further out than its limit. */
function radiusWithin(c: Corner, limitA: number, limitB: number): number {
  if (c.lines[0] && c.lines[1]) return Math.min(limitA, limitB) * Math.tan(c.alpha / 2);
  return largestRadius(c, (t) => cutAlong(c, t, 0) <= limitA && cutAlong(c, t, 1) <= limitB);
}

/** Fit an arc of at most `radius` into the corner, saying whether it was cut down. */
function fitArc(c: Corner, radius: number): Arc | null {
  if (c.lines[0] && c.lines[1]) {
    /* Clamped as a distance and read back as a radius, rather than the other way
       round. Both are one relation, and the direction matters: the limit is a
       length of side, so clamping there is exact, while clamping the radius and
       converting would land a hair off the side it was meant to reach. */
    const half = c.alpha / 2;
    const reach = Math.min(c.lengths[0], c.lengths[1]);
    let cut = radius / Math.tan(half);
    const clamped = cut > reach;
    if (clamped) cut = reach;
    const r = cut * Math.tan(half);
    if (!(r > 1e-9)) return null;
    const bx = c.u[0] + c.v[0];
    const by = c.u[1] + c.v[1];
    const bl = Math.hypot(bx, by);
    if (bl < 1e-12) return null;
    const away = r / Math.sin(half);
    return {
      radius: r,
      clamped,
      s: [cut / c.lengths[0], cut / c.lengths[1]],
      at: [
        [c.at[0] + c.u[0] * cut, c.at[1] + c.u[1] * cut],
        [c.at[0] + c.v[0] * cut, c.at[1] + c.v[1] * cut],
      ],
      centre: [c.at[0] + (bx / bl) * away, c.at[1] + (by / bl) * away],
    };
  }

  const direct = tangentCircle(c, radius);
  if (direct) return { radius, clamped: false, ...direct };
  const held = maxCornerRadius(c);
  if (!(held > 1e-9)) return null;
  const t = tangentCircle(c, held);
  return t ? { radius: held, clamped: true, ...t } : null;
}

/**
 * The largest radius every corner named by `ids` can hold at the same time.
 *
 * `maxCornerRadius` answers for one corner on its own, which stops being the
 * right question the moment its neighbour is rounding too: the two arcs eat the
 * side between them from both ends, so each may have half of it. Rounding a
 * square's four corners without this clamps them one at a time, in whatever
 * order the loop ran, and returns four different radii for one request.
 *
 * Ids rather than indices because rounding splices, and 0 rather than infinity
 * when nothing in the set is a corner, so the caller has one number to test.
 */
export function sharedCornerRadius(sp: Subpath, ids: readonly string[]): number {
  const set = new Set(ids);
  const n = sp.nodes.length;
  let max = Infinity;
  for (const id of ids) {
    const i = sp.nodes.findIndex((nd) => nd.id === id);
    if (i < 0) continue;
    const c = cornerAt(sp, i);
    if (typeof c === 'string') continue;
    const prev = sp.nodes[(i - 1 + n) % n];
    const next = sp.nodes[(i + 1) % n];
    // How much of each side this corner may take: all of it, or half where the
    // corner at the far end is cutting into the same side.
    const back = c.lengths[0] / (set.has(prev.id) ? 2 : 1);
    const fwd = c.lengths[1] / (set.has(next.id) ? 2 : 1);
    max = Math.min(max, radiusWithin(c, back, fwd));
  }
  return Number.isFinite(max) ? max : 0;
}

/**
 * Replace a corner with a circular arc tangent to both of its sides.
 *
 * The node becomes two, one at each tangent point, with a cubic between them.
 *
 * **A side may be curved.** The arc is tangent to whatever is there, found by
 * placing a circle of the radius asked for against both sides at once. What a
 * curved side costs is that the tangent point no longer sits at a distance
 * anyone can write down, so it is solved for rather than measured out, and the
 * side is cut at the point that comes back. §23.
 *
 * The radius is clamped to what the shorter side can hold. Rounding the corners
 * of a rectangle one at a time works because each one sees the sides the
 * previous ones left behind.
 */
export function roundCorner(
  sp: Subpath,
  i: number,
  radius: number,
): RoundResult | RoundRefusal {
  if (!(radius > 0)) return 'tiny';
  const c = cornerAt(sp, i);
  if (typeof c === 'string') return c;
  const arc = fitArc(c, radius);
  if (!arc || !(arc.radius > 1e-9)) return 'tiny';

  const n = sp.nodes.length;
  const prevI = (i - 1 + n) % n;
  const nextI = (i + 1) % n;
  const prev = sp.nodes[prevI];
  const next = sp.nodes[nextI];

  /* What is left of each side once the arc has taken its piece. A straight side
     keeps its handles absent, which is how the model says "line" and what keeps
     a rectangle exporting as one. A curved side is split, and both halves of
     that split are handles somebody has to carry: the near one belongs to the
     neighbour and the far one to the new node. */
  const keptIn = c.lines[0] ? null : splitCubic(segmentAsCubic(sp, prevI), 1 - arc.s[0])[0];
  const keptOut = c.lines[1] ? null : splitCubic(segmentAsCubic(sp, i), arc.s[1])[1];
  const t1: Pt = keptIn ? clonePt(keptIn[3]) : arc.at[0];
  const t2: Pt = keptOut ? clonePt(keptOut[0]) : arc.at[1];

  // The arc turns through the angle its own ends subtend at the centre, which
  // is the exterior angle when both sides are straight and is not otherwise.
  const h = arcHandle(arc.radius, turnBetween(sub(t1, arc.centre), sub(t2, arc.centre)));
  const d1 = cubicUnitTangent(c.sides[0], arc.s[0]);
  const d2 = cubicUnitTangent(c.sides[1], arc.s[1]);
  if (!d1 || !d2) return 'tiny';

  /* A tangent point can land exactly on a neighbour: at the clamp, and where
     two fillets meet on a side they share. The neighbour is reused there, or
     the path carries a zero-length segment and can never be simplified again --
     a zero chord gives the fitter no tangent. §23. */
  const startsAtPrev = Math.hypot(t1[0] - prev.pt[0], t1[1] - prev.pt[1]) <= MEET;
  const endsAtNext = Math.hypot(t2[0] - next.pt[0], t2[1] - next.pt[1]) <= MEET;

  // Travel runs prev -> t1 -> arc -> t2 -> next, so the tangent leaving `t1`
  // points into the corner and the one arriving at `t2` points away from it.
  const first: PathNode = {
    id: nextNodeId(),
    pt: t1,
    hIn: keptIn ? handleOrNull(keptIn[2], keptIn[3]) : null,
    hOut: [t1[0] - d1[0] * h, t1[1] - d1[1] * h],
  };
  const second: PathNode = {
    id: nextNodeId(),
    pt: t2,
    hIn: [t2[0] - d2[0] * h, t2[1] - d2[1] * h],
    hOut: keptOut ? handleOrNull(keptOut[1], keptOut[0]) : null,
  };

  const insert: PathNode[] = [];
  if (startsAtPrev) {
    prev.hOut = first.hOut;
  } else {
    if (keptIn) prev.hOut = handleOrNull(keptIn[1], keptIn[0]);
    insert.push(first);
  }
  if (endsAtNext) {
    next.hIn = second.hIn;
  } else {
    if (keptOut) next.hIn = handleOrNull(keptOut[2], keptOut[3]);
    insert.push(second);
  }
  sp.nodes.splice(i, 1, ...insert);
  return { radius: arc.radius, clamped: arc.clamped };
}

/**
 * A rounded corner, read back off the path.
 *
 * `i` and `j` are the two tangent nodes, `at` the corner they were cut from, and
 * `radius` the one they were cut with. `sides` holds those sides restored to the
 * length they had before the cut, `[0]` arriving at the corner and `[1]` leaving
 * it, and `ends` names the neighbour each one reaches back to.
 */
export interface Fillet {
  i: number;
  j: number;
  at: Pt;
  radius: number;
  sides: [Cubic, Cubic];
  /** The node each side reaches, or -1 where the path ends there. */
  ends: [number, number];
}

/** A fillet's side, run outward from its tangent node toward the corner. */
interface SideRun {
  at: (q: number) => Pt;
  d: (q: number) => Pt;
  /** The side rebuilt whole, with the corner at `q`. */
  whole: (q: number) => Cubic;
  /** Where to start looking: the distance to the crossing the arc's tangents make. */
  seed: number;
  /** The neighbour this side reaches, or -1 where the path ends there. */
  end: number;
  line: boolean;
}

/** Where two sides met before the arc between them cut them apart. */
function crossSides(A: SideRun, B: SideRun): { q: [number, number]; at: Pt } | null {
  let p = A.seed;
  let q = B.seed;
  for (let k = 0; k < 40; k++) {
    const pa = A.at(p);
    const pb = B.at(q);
    const f: Pt = [pa[0] - pb[0], pa[1] - pb[1]];
    if (Math.hypot(f[0], f[1]) <= 1e-10 * (1 + Math.hypot(pa[0], pa[1]))) {
      // Behind either tangent point is some other crossing, not this corner.
      return p > 1e-9 && q > 1e-9 ? { q: [p, q], at: pa } : null;
    }
    const db = B.d(q);
    const s = step2(A.d(p), [-db[0], -db[1]], f);
    if (!s) return null;
    p += s[0];
    q += s[1];
  }
  return null;
}

/**
 * Is the pair of nodes starting at `i` a rounded corner, and if so what of?
 *
 * **Nothing is stored to answer this.** The arc between the two nodes carries
 * its own radius: a circular arc is the one curve whose handles have a fixed
 * length for the angle it turns through, so the radius is read off the geometry
 * and cannot disagree with it.
 *
 * Recovering the *corner* is the harder half, and what it takes depends on the
 * sides. Two straight sides meet where their tangent rays cross, which is one
 * division. A curved side has to be put back: the trimmed piece is an exact
 * restriction of the curve it was cut from, so running that polynomial past its
 * end reproduces what was discarded, and the corner is where the two
 * continuations meet. §48 has the argument.
 */
export function filletAt(sp: Subpath, i: number): Fillet | null {
  const n = sp.nodes.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) return null;
  if (n < 3) return null;
  const j = (i + 1) % n;
  if (!sp.closed && j === 0) return null;

  const a = sp.nodes[i];
  const b = sp.nodes[j];
  // The span between them has to be a curve at all before it can be an arc.
  if (a.hOut === null || b.hIn === null) return null;

  // Direction of travel leaving `a`, and arriving at `b`.
  const da: Pt = [a.hOut[0] - a.pt[0], a.hOut[1] - a.pt[1]];
  const db: Pt = [b.pt[0] - b.hIn[0], b.pt[1] - b.hIn[1]];
  const ha = Math.hypot(da[0], da[1]);
  const hb = Math.hypot(db[0], db[1]);
  if (ha < 1e-9 || hb < 1e-9) return null;
  // Equal handles, which a fillet has by construction and a hand-pulled pair of
  // curves has only by accident.
  if (Math.abs(ha - hb) > 1e-6 * Math.max(ha, hb)) return null;

  const ea: Pt = [da[0] / ha, da[1] / ha];
  const eb: Pt = [db[0] / hb, db[1] / hb];
  // Parallel rays never meet, and a straight run through is not a corner.
  const cross = ea[0] * eb[1] - ea[1] * eb[0];
  if (Math.abs(cross) < 1e-9) return null;

  const w: Pt = [b.pt[0] - a.pt[0], b.pt[1] - a.pt[1]];
  const t = (w[0] * eb[1] - w[1] * eb[0]) / cross;
  if (!(t > 1e-9)) return null; // the crossing is behind `a`, so it is not this arc's
  const meet: Pt = [a.pt[0] + ea[0] * t, a.pt[1] + ea[1] * t];

  const cutA = t;
  const cutB = Math.hypot(b.pt[0] - meet[0], b.pt[1] - meet[1]);
  /* Tangent lengths from one point to one circle are equal, so an arc whose two
     end tangents cross at unequal distances is not one circle's worth of arc. */
  if (Math.abs(cutA - cutB) > 1e-6 * Math.max(cutA, cutB)) return null;

  // The angle the tangent rays make, which is the corner's own only when both
  // sides are straight.
  const cos = Math.min(1, Math.max(-1, -ea[0] * eb[0] + -ea[1] * eb[1]));
  const spread = Math.acos(cos);
  if (spread > Math.PI - 1e-6 || spread < 1e-6) return null;

  const radius = cutA * Math.tan(spread / 2);
  // Circular, not merely tangent: the handle a circular arc through this angle
  // needs is a fixed length, so a pair that misses it is some other curve.
  if (Math.abs(ha - arcHandle(radius, Math.PI - spread)) > 1e-6 * Math.max(ha, 1)) return null;

  /* Both sides are run from their tangent node toward the corner. The arc
     leaves `a` that way already; it arrives at `b` from the corner, so `b`
     looks back along the reverse. */
  const A = filletSide(sp, i, 'in', ea, cutA);
  const B = filletSide(sp, j, 'out', [-eb[0], -eb[1]], cutB);
  if (!A || !B) return null;
  const met = crossSides(A, B);
  if (!met) return null;

  const sides: [Cubic, Cubic] = [A.whole(met.q[0]), B.whole(met.q[1])];
  const fillet: Fillet = {
    i,
    j,
    at: met.at,
    radius,
    sides,
    ends: [A.end, B.end],
  };
  return fillet;
}

/**
 * One side of a candidate fillet, in the direction the corner lies.
 *
 * A straight side is its own extension, so the run is the tangent ray. A curved
 * one is the neighbouring segment carried past its end, which requires the arc
 * to leave along that segment's tangent -- a kink there means the arc is not
 * this curve's fillet, whatever else it is.
 *
 * `e` points from the tangent node toward the corner, for both sides.
 */
function filletSide(
  sp: Subpath,
  at: number,
  which: 'in' | 'out',
  e: Pt,
  cut: number,
): SideRun | null {
  const n = sp.nodes.length;
  const node = sp.nodes[at];
  const segment = which === 'in' ? (at - 1 + n) % n : at;
  const absent = !sp.closed && (which === 'in' ? at === 0 : at === n - 1);
  const end = absent ? -1 : which === 'in' ? segment : endNodeIndex(sp, segment);

  if (absent || segmentIsLine(sp, segment)) {
    const far = end < 0 ? node.pt : sp.nodes[end].pt;
    const on = (q: number): Pt => [node.pt[0] + e[0] * q, node.pt[1] + e[1] * q];
    return {
      at: on,
      d: () => clonePt(e),
      whole: (q) =>
        which === 'in'
          ? [clonePt(far), clonePt(far), on(q), on(q)]
          : [on(q), on(q), clonePt(far), clonePt(far)],
      seed: cut,
      end,
      line: true,
    };
  }

  const c = segmentAsCubic(sp, segment);
  // The corner sits past the end the arc starts at: beyond 1 going forward,
  // before 0 coming back.
  const base = which === 'in' ? 1 : 0;
  const sign = which === 'in' ? 1 : -1;
  const tangent = cubicUnitTangent(c, base);
  if (!tangent) return null;
  // Forward at the far end, backward at the near one, both compared with the
  // direction the arc leaves in.
  const along = sign * (tangent[0] * e[0] + tangent[1] * e[1]);
  if (along < 1 - 1e-9) return null;

  const speed = Math.hypot(...(cubicDerivAt(c, base) as [number, number]));
  return {
    at: (q) => cubicAt(c, base + sign * q),
    d: (q) => {
      const d1 = cubicDerivAt(c, base + sign * q);
      return [sign * d1[0], sign * d1[1]];
    },
    whole: (q) => (which === 'in' ? cubicOver(c, 0, 1 + q) : cubicOver(c, -q, 1)),
    seed: speed > 1e-9 ? cut / speed : cut,
    end,
    line: false,
  };
}


/**
 * How far along the bisector, from the corner, the arc of radius `r` begins.
 *
 * The arc's nearest point to the corner: its centre sits `r / sin(half)` in, and the
 * arc is `r` nearer than that. Paired with `cornerRadiusAtReach`, which is its
 * inverse, so the control drawn on the canvas and the radius a drag means are one
 * relation and not two -- a control that tracked the pointer at some other ratio
 * would slide out from under it.
 */
export const cornerArcReach = (r: number, half: number): number =>
  r <= 0 ? 0 : r / Math.sin(half) - r;

/** The radius whose arc begins `d` from the corner. Zero for anything not positive. */
export const cornerRadiusAtReach = (d: number, half: number): number => {
  const sin = Math.sin(half);
  // `sin` reaches 1 only as the corner opens out flat, which `cornerAt` refuses,
  // so the division is safe for any corner that exists.
  return sin >= 1 || d <= 0 ? 0 : (d * sin) / (1 - sin);
};

/**
 * Put a rounded corner back to the sharp one it was cut from.
 *
 * Returns the index of the node that replaced the pair, or `null` when `i` does
 * not start a fillet. Exact, because `filletAt` recovers the corner rather than
 * approximating it, so unrounding and rounding again at the same radius is the
 * identity on the geometry.
 */
export function unroundCorner(sp: Subpath, i: number): number | null {
  const f = filletAt(sp, i);
  if (!f) return null;
  const [A, B] = f.sides;

  /* The sides come back to the length they had, so the neighbours' handles come
     back with them. A curved side was trimmed at the corner end, which moved the
     handle at the *other* end too, and putting only the corner back would leave
     that trim in the path. Written before the splice, while the indices still
     mean what they meant. */
  if (f.ends[0] >= 0) sp.nodes[f.ends[0]].hOut = handleOrNull(A[1], A[0]);
  if (f.ends[1] >= 0) sp.nodes[f.ends[1]].hIn = handleOrNull(B[2], B[3]);
  const sharp = makeNode(clonePt(f.at), handleOrNull(A[2], A[3]), handleOrNull(B[1], B[0]));

  /* The pair wraps when the first of the two is the last node, and a splice
     cannot remove across the end of an array. Removing the tail and the head
     separately leaves the corner at index 0, which is where the wrap put it. */
  if (f.j === 0) {
    sp.nodes.splice(f.i, 1);
    sp.nodes.splice(0, 1, sharp);
    return 0;
  }
  sp.nodes.splice(f.i, 2, sharp);
  return f.i;
}

/* ------------------------------------------------------------- transforms */

function transformSubpath(sp: Subpath, m: Mat): void {
  for (const n of sp.nodes) {
    n.pt = applyMat(m, n.pt);
    if (n.hIn) n.hIn = applyMat(m, n.hIn);
    if (n.hOut) n.hOut = applyMat(m, n.hOut);
  }
}

/**
 * Apply an affine transform to a whole shape.
 *
 * This is the entire implementation of move, rotate, scale, flip and skew. No
 * command types to dispatch on, no arc radii to recompute, no relative
 * coordinates to leave alone.
 */
export function transformShape(shape: Shape, m: Mat): void {
  for (const sp of shape.subpaths) transformSubpath(sp, m);
}

export interface NodeSnapshot {
  ref: NodeRef;
  pt: Pt;
  hIn: Pt | null;
  hOut: Pt | null;
}

/**
 * Copy the geometry of `refs` so a live gesture can recompute from it.
 *
 * A transform drag has to answer "where would this be if the whole gesture so
 * far were applied at once", and the tempting way is to apply each frame's
 * change on top of the last. That accumulates: scaling to 50 % and back does
 * not return the shape it started with, and a hundred frames of rotation drift
 * visibly. Recomputing from a copy of the original makes every frame exact and
 * makes the final result depend only on where the pointer ended up.
 */
export function captureNodes(doc: Doc, refs: NodeRef[]): NodeSnapshot[] {
  const out: NodeSnapshot[] = [];
  for (const ref of refs) {
    const n = doc.shapes.find((s) => s.id === ref.shape)?.subpaths[ref.sp]?.nodes[ref.i];
    if (!n) continue;
    out.push({ ref, pt: clonePt(n.pt), hIn: clonePtOrNull(n.hIn), hOut: clonePtOrNull(n.hOut) });
  }
  return out;
}

/** Write `m` applied to captured geometry back into the document. */
export function transformCaptured(doc: Doc, saved: NodeSnapshot[], m: Mat): void {
  for (const s of saved) {
    const n = doc.shapes.find((sh) => sh.id === s.ref.shape)?.subpaths[s.ref.sp]?.nodes[s.ref.i];
    if (!n) continue;
    n.pt = applyMat(m, s.pt);
    n.hIn = s.hIn ? applyMat(m, s.hIn) : null;
    n.hOut = s.hOut ? applyMat(m, s.hOut) : null;
  }
}

/* ------------------------------------------------------------------ bend */

/**
 * Set a segment's curvature from a bend, writing both control points.
 *
 * An angle of exactly 0 with looseness 1 is the straight line, so it clears the
 * handles instead of storing controls on the thirds -- that keeps the model's
 * "a line has no handles" invariant, and lets the segment serialise as `L`.
 */
export function setSegmentBend(sp: Subpath, segIdx: number, bend: Bend): void {
  const a = sp.nodes[segIdx];
  const b = sp.nodes[endNodeIndex(sp, segIdx)];

  if (Math.abs(bend.angle) < 1e-9 && Math.abs(bend.looseness - 1) < 1e-9) {
    a.hOut = null;
    b.hIn = null;
    return;
  }

  const { c1, c2 } = bendToHandles(a.pt, b.pt, bend);
  // Going through `moveHandle` rather than assigning directly is what carries
  // the change across a smooth join: it reads each node's continuity before
  // touching it, so bending one segment rotates its neighbour's handle to match
  // instead of quietly putting a kink in a curve that had none.
  moveHandle(sp, segIdx, 'out', c1);
  moveHandle(sp, endNodeIndex(sp, segIdx), 'in', c2);
}

/** Read a segment's bend, or `null` when its handles are not symmetric. */
export function segmentBend(sp: Subpath, segIdx: number): Bend | null {
  return bendOf(sp.nodes[segIdx], sp.nodes[endNodeIndex(sp, segIdx)]);
}

/**
 * Move the point at `t` on a segment to `target`, changing both handles.
 *
 * The unconstrained edit, where `setSegmentBend` is the symmetric one. The
 * endpoints are fixed, so the displacement comes out of the two controls:
 *
 *   d = b1 * dC1 + b2 * dC2,  b1 = 3(1-t)^2 t,  b2 = 3(1-t) t^2
 *
 * One equation, two unknowns, so the answer is a choice. The least-norm
 * solution `dCi = d * bi / (b1^2 + b2^2)` moves the handles as little as the
 * displacement allows, and splits the work in the ratio the two controls
 * already influence the point.
 *
 * `t` is clamped off the ends, where `b1` and `b2` vanish: no handle can move
 * the endpoint, and the least-norm answer there is an infinity.
 */
export function reshapeSegment(sp: Subpath, segIdx: number, t: number, target: Pt): void {
  const tc = Math.min(0.95, Math.max(0.05, t));
  const cubic = segmentAsCubic(sp, segIdx);
  const at = cubicAt(cubic, tc);

  const u = 1 - tc;
  const b1 = 3 * u * u * tc;
  const b2 = 3 * u * tc * tc;
  const denom = b1 * b1 + b2 * b2;
  if (denom < 1e-12) return;

  const dx = target[0] - at[0];
  const dy = target[1] - at[1];

  const c1: Pt = [cubic[1][0] + (dx * b1) / denom, cubic[1][1] + (dy * b1) / denom];
  const c2: Pt = [cubic[2][0] + (dx * b2) / denom, cubic[2][1] + (dy * b2) / denom];

  // Through `moveHandle` for the reason `setSegmentBend` does it: a smooth
  // join rotates its neighbour to match rather than gaining a kink.
  moveHandle(sp, segIdx, 'out', c1);
  moveHandle(sp, endNodeIndex(sp, segIdx), 'in', c2);
}

/* ------------------------------------------------- aligning, distributing */

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Resolve refs to live nodes, silently dropping any that no longer exist. */
function resolve(doc: Doc, refs: NodeRef[]): { sp: Subpath; i: number }[] {
  const out: { sp: Subpath; i: number }[] = [];
  for (const r of refs) {
    const sp = doc.shapes.find((s) => s.id === r.shape)?.subpaths[r.sp];
    if (sp?.nodes[r.i]) out.push({ sp, i: r.i });
  }
  return out;
}


/**
 * Align anchors to one edge or centre of their common bounding box.
 *
 * Aligning to the box rather than to a "key" node means the result does not
 * depend on selection order, which is invisible in the UI and so a bad thing to
 * make the outcome hinge on.
 *
 * Returns whether anything moved, so the caller can use `tryEdit`: three presses
 * of Align Left are one arrangement and one entry in the history.
 */
export function alignNodes(doc: Doc, refs: NodeRef[], mode: AlignMode): boolean {
  const items = resolve(doc, refs);
  if (items.length < 2) return false;

  const xs = items.map((it) => it.sp.nodes[it.i].pt[0]);
  const ys = items.map((it) => it.sp.nodes[it.i].pt[1]);
  const target = {
    left: Math.min(...xs),
    right: Math.max(...xs),
    hcenter: (Math.min(...xs) + Math.max(...xs)) / 2,
    top: Math.min(...ys),
    bottom: Math.max(...ys),
    vcenter: (Math.min(...ys) + Math.max(...ys)) / 2,
  }[mode];

  const horizontal = mode === 'left' || mode === 'right' || mode === 'hcenter';
  let moved = false;
  for (const it of items) {
    const p = it.sp.nodes[it.i].pt;
    if (Math.abs((horizontal ? p[0] : p[1]) - target) < SAME_PLACE) continue;
    moved = true;
    moveAnchor(it.sp, it.i, horizontal ? [target, p[1]] : [p[0], target]);
  }
  return moved;
}

/** Space anchors evenly between the two extremes, which stay put. */
export function distributeNodes(doc: Doc, refs: NodeRef[], axis: 'h' | 'v'): boolean {
  const items = resolve(doc, refs);
  if (items.length < 3) return false;

  const ax = axis === 'h' ? 0 : 1;
  items.sort((a, b) => a.sp.nodes[a.i].pt[ax] - b.sp.nodes[b.i].pt[ax]);

  const first = items[0].sp.nodes[items[0].i].pt[ax];
  const last = items[items.length - 1].sp.nodes[items[items.length - 1].i].pt[ax];
  const step = (last - first) / (items.length - 1);

  let moved = false;
  items.forEach((it, k) => {
    if (k === 0 || k === items.length - 1) return;
    const p = it.sp.nodes[it.i].pt;
    const v = first + step * k;
    if (Math.abs(p[ax] - v) < SAME_PLACE) return;
    moved = true;
    moveAnchor(it.sp, it.i, ax === 0 ? [v, p[1]] : [p[0], v]);
  });
  return moved;
}

/* ------------------------------------------------------------- hit testing */

export interface PathHit {
  shape: string;
  sp: number;
  seg: number;
  t: number;
  d: number;
  pt: Pt;
}

/** Closest point on any shape's outline, for click-to-insert and body drags. */
export function nearestOnPath(
  doc: Doc,
  p: Pt,
  maxDist: number,
  /**
   * Segments to consider. Snapping needs this and hit-testing does not: a node
   * being dragged sits on the two segments it joins, so without a filter it
   * would find itself at distance zero and never move again.
   */
  allow?: (shape: string, sp: number, seg: number) => boolean,
): PathHit | null {
  let best: PathHit | null = null;
  for (const shape of doc.shapes) {
    shape.subpaths.forEach((sp, spI) => {
      const n = segmentCount(sp);
      for (let seg = 0; seg < n; seg++) {
        if (allow && !allow(shape.id, spI, seg)) continue;
        /* Reject on the segment's control hull before projecting. A cubic lies
           inside the box of its four control points, so anything whose box is
           further than `maxDist` cannot win, and `projectToCubic` costs 24
           samples plus 20 refinements. This was pure hit-testing until snapping
           started calling it on every pointermove: on a traced drawing of 2 400
           segments a hover over empty canvas cost 12.8 to 16.7 ms, which is a
           dropped frame for doing nothing. */
        const c = segmentAsCubic(sp, seg);
        const lo0 = Math.min(c[0][0], c[1][0], c[2][0], c[3][0]);
        const hi0 = Math.max(c[0][0], c[1][0], c[2][0], c[3][0]);
        const lo1 = Math.min(c[0][1], c[1][1], c[2][1], c[3][1]);
        const hi1 = Math.max(c[0][1], c[1][1], c[2][1], c[3][1]);
        /* One bound, read once: the distance a segment has to beat to win. The
           box test and the win test below are the same predicate at two
           resolutions, so stating it twice is a way for them to disagree, and a
           reject looser than the win test drops a segment that would have won. */
        const reach = best?.d ?? maxDist;
        if (p[0] < lo0 - reach || p[0] > hi0 + reach) continue;
        if (p[1] < lo1 - reach || p[1] > hi1 + reach) continue;

        const pr = projectToCubic(c, p);
        if (pr.d < reach) {
          best = { shape: shape.id, sp: spI, seg, t: pr.t, d: pr.d, pt: pr.pt };
        }
      }
    });
  }
  return best;
}
