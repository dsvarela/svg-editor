/**
 * Every mutation the editor can perform on geometry.
 *
 * These functions mutate in place and know nothing about undo, rendering or
 * selection -- the store wraps them. Because the model is nodes-and-handles,
 * each one is a handful of lines with no per-command branching.
 */

import { cubicAt, cubicLength, projectToCubic, splitCubic } from '../core/bezier';
import { bendOf, bendToHandles } from '../core/bend';
import type { Bend } from '../core/bend';
import { applyMat } from '../core/affine';
import type { Mat } from '../core/affine';
import { arcHandle, fitCircle } from '../core/primitives';
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
  segmentIsLine,
} from '../core/types';
import type { Doc, NodeContinuity, PathNode, Pt, Shape, Subpath } from '../core/types';
import type { HandlePart, NodeRef } from './doc';

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);

/**
 * Where a missing handle would sit: one third along the segment it governs.
 *
 * Returns `null` when there is no segment on that side (the ends of an open
 * subpath), because there is nothing there to curve.
 */
export function latentHandle(sp: Subpath, i: number, which: 'in' | 'out'): Pt | null {
  const n = sp.nodes.length;
  if (n < 2) return null;
  const hasSegment = which === 'out' ? sp.closed || i < n - 1 : sp.closed || i > 0;
  if (!hasSegment) return null;

  const other = which === 'out' ? (i + 1) % n : (i - 1 + n) % n;
  const a = sp.nodes[i].pt;
  const b = sp.nodes[other].pt;
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
 * always read as a corner, so a smooth node would break itself on its first
 * drag. Having read it, a `smooth` pair keeps the other handle's length and
 * rotates it to match; a `symmetric` pair mirrors exactly; a corner moves one
 * handle alone.
 *
 * Because the relation is re-read every move, it is self-maintaining: mirroring
 * keeps lengths exactly equal, so a symmetric node stays symmetric for as long
 * as the drag lasts, and a broken one stays broken.
 *
 * `breakPair` is the Alt-drag escape hatch: move this handle alone regardless,
 * which leaves the pair non-collinear and therefore a corner from then on.
 */
export function moveHandle(
  sp: Subpath,
  i: number,
  which: 'in' | 'out',
  to: Pt,
  breakPair = false,
): void {
  const n = sp.nodes[i];
  const was = breakPair ? 'corner' : continuityOf(n);

  if (which === 'in') n.hIn = to;
  else n.hOut = to;

  if (was === 'corner') return;

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
 * align its handles, and to make it a corner you take its handles away. Every
 * call is therefore a real edit to the geometry or no edit at all.
 *
 * A corner has no handles to align, so smooth and symmetric first materialise
 * them where the hollow ghosts are drawn — a third along each neighbouring
 * segment. This moves the drawing: both handles are placed on their chords and
 * then rotated to the averaged direction, which pulls them off. A right-angle
 * corner with 10-unit sides shifts by 1.48 units.
 *
 * Returns whether the handles actually changed, so a caller can decline to
 * record an undo entry for a click that did nothing. It is `false` in two
 * situations. An end of an open subpath has no segment on the outside, so there
 * is no handle to invent and nothing to align against. A node already in the
 * requested state computes the handles it already has, which is why `smooth` on
 * a symmetric node reports no change: symmetric *is* smooth. See
 * `docs/ARCHITECTURE.md` §6 for why that case is not weakened into a change.
 */
export function setContinuity(sp: Subpath, i: number, kind: NodeContinuity): boolean {
  const n = sp.nodes[i];

  if (kind === 'corner') {
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

  const wasLine =
    segmentIsLine(sp, prevI) && segmentIsLine(sp, i < n ? i : 0) && prev.hOut === null;

  if (wasLine) {
    prev.hOut = null;
    next.hIn = null;
    sp.nodes.splice(i, 1);
    return true;
  }

  const l1 = cubicLength(segmentAsCubic(sp, prevI));
  const l2 = cubicLength(segmentAsCubic(sp, i));
  const total = l1 + l2;
  const k1 = Math.min(3, total / Math.max(l1, 1e-9));
  const k2 = Math.min(3, total / Math.max(l2, 1e-9));

  if (prev.hOut) prev.hOut = add(prev.pt, [(prev.hOut[0] - prev.pt[0]) * k1, (prev.hOut[1] - prev.pt[1]) * k1]);
  if (next.hIn) next.hIn = add(next.pt, [(next.hIn[0] - next.pt[0]) * k2, (next.hIn[1] - next.pt[1]) * k2]);

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
 * The other half of the pair, and the one that loses a node. Where
 * `connectEnds` spans the gap, this closes it: the two nodes merge at their
 * midpoint, so ends already sitting on top of each other do not move and the
 * operation exactly undoes a `breakAt`.
 *
 * Each end keeps the handle facing away from the joint, which is the one that
 * shapes a segment that still exists. The handles facing the joint governed
 * nothing, because an end of an open path has no segment on its outside.
 *
 * Two ends of the SAME path close it into a ring, one node shorter. Two ends of
 * different paths concatenate, reversing either as needed so the drawing
 * directions agree. The result is one subpath; the caller is responsible for
 * removing whichever subpath it replaced.
 *
 * Returns `null` when either node is not a free end, when both are the same
 * node, or when closing would leave fewer than two nodes to draw with.
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
 * `mergeEnds` deliberately refuses anything but two free ends, because welding
 * two ends is a topology change it has to reason about: two paths become one, or
 * one becomes a ring. In the middle of a path there is no topology to change.
 * The pair is already joined by a segment, and fusing them just removes that
 * segment, so this is the simpler operation of the two despite sounding like the
 * harder one.
 *
 * The survivor sits at the midpoint and keeps the handle facing away from the
 * joint on each side, exactly as `mergeEnds` does. Two nodes already on top of
 * each other therefore do not move at all, which is the case that matters: this
 * is the repair for a **zero-length segment**, and a path carrying one can never
 * be simplified again, because a zero chord leaves the fitter with no tangent.
 *
 * **Adjacent only.** Two nodes further apart along the path have a run of
 * segments between them, and welding them would pinch the path into two loops
 * that no longer share an interior. That is a different operation with a
 * different name, and guessing at it here would silently discard whatever ran
 * between the pair.
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
 * The sweep behind the fillet generators. `roundCorner` reuses a neighbour when
 * a tangent point lands on one, but the rectangle tool and `circulariseSubpath`
 * build their nodes in one go and cannot check as they place them: a rectangle
 * rounded to exactly half its shorter side has two anchors on each of the ends
 * it just made into a semicircle. Running this afterwards is one rule in one
 * place rather than a coincidence test threaded through three constructors.
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

/* --------------------------------------------------------- circularising */

export interface CirculariseResult {
  centre: Pt;
  radius: number;
  /** How far the furthest node had to travel to reach the circle. */
  moved: number;
  /**
   * Nodes welded away because two of them shared an angle.
   *
   * Two nodes at the same angle about the centre land on the same point of the
   * circle, which is a zero-length segment however faithfully each one was
   * placed. Reported rather than silent, because the node count changing is
   * something the person watching should be told.
   */
  fused: number;
  /**
   * The widest arc any one segment now spans, in radians. A cubic's radial
   * error climbs steeply with it, so this is the ceiling on how round the
   * result can be — 2.7e-4 of the radius at a quarter turn, 1.8e-2 at a half.
   */
  widestSpan: number;
}

/**
 * Force every node of a subpath onto its own best-fit circle.
 *
 * Each node keeps its angle about the fitted centre and is pushed out or pulled
 * in to the fitted radius; the handles are then rebuilt from the angle each
 * segment now spans, at `r · 4/3 · tan(θ/4)`. That is the midpoint-matching
 * approximation rather than an exact arc — a cubic cannot be one — and its
 * error grows steeply with the span: 2.7e-4 of the radius at a quarter turn,
 * 1.8e-2 at a half. So node spacing does matter, and `widestSpan` is returned
 * so the caller can say how round the result can possibly be.
 *
 * **A closed contour is a ring, and its spans must sum to a full turn.** Taking
 * each span the shorter way round is right for spans under half a turn and
 * silently destructive above it: four nodes at
 * 0°, 20°, 40° and 60° leave a 300° gap, the shorter way reads that as −60°,
 * and the closing segment retraces the other three instead of completing the
 * circle. Every node still lands exactly on the circle, so a radial measurement
 * cannot see it, and the reported travel is zero. It looked like a success.
 *
 * So a closed contour picks one winding from the sign of the polygon's area and
 * forces every span to follow it. The spans then sum to exactly one turn when
 * the nodes are in angular order, and to a multiple of one when they are not —
 * a star, a figure of eight — which is the test for whether this was a ring at
 * all. When it was not, nothing is mutated and `null` comes back.
 *
 * An open subpath has no such constraint, and its anchors alone cannot say
 * which way an arc went, so it keeps the shorter way round.
 *
 * Returns `null` for fewer than three nodes, a collinear arrangement, a node
 * sitting on the fitted centre (its angle is undefined), or a closed contour
 * whose nodes are not in angular order.
 */
export function circulariseSubpath(sp: Subpath): CirculariseResult | null {
  const n = sp.nodes.length;
  if (n < 3) return null;

  const fit = fitCircle(sp.nodes.map((nd) => nd.pt));
  if (!fit) return null;
  const [cx, cy] = fit.centre;
  const r = fit.radius;

  // A node on the centre has no angle to keep. atan2(0, 0) is 0, which would
  // teleport it to the eastern point of the circle on top of whatever is there.
  if (sp.nodes.some((nd) => Math.hypot(nd.pt[0] - cx, nd.pt[1] - cy) < 1e-9)) return null;

  const ang = sp.nodes.map((nd) => Math.atan2(nd.pt[1] - cy, nd.pt[0] - cx));
  const segs = sp.closed ? n : n - 1;

  /* Decide every span before moving anything, so a contour that turns out not
     to be a ring leaves the document untouched. */
  const spans: number[] = [];
  if (sp.closed) {
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = sp.nodes[i].pt;
      const b = sp.nodes[(i + 1) % n].pt;
      area += a[0] * b[1] - b[0] * a[1];
    }
    const dir = area >= 0 ? 1 : -1;

    let total = 0;
    for (let i = 0; i < segs; i++) {
      let d = ang[(i + 1) % n] - ang[i];
      // Into (0, 2π) going one way, (−2π, 0) the other. A span of zero stays
      // zero rather than becoming a full turn.
      d -= Math.floor(d / (2 * Math.PI)) * 2 * Math.PI; // [0, 2π)
      if (dir < 0 && d > 0) d -= 2 * Math.PI;
      if (Math.abs(d) < 1e-9 || Math.abs(Math.abs(d) - 2 * Math.PI) < 1e-9) d = 0;
      spans.push(d);
      total += d;
    }
    // One turn means the nodes go round once, in order. Anything else is a
    // star or a doubled loop, which no circle through these nodes can be.
    if (Math.abs(Math.abs(total) - 2 * Math.PI) > 1e-6) return null;
  } else {
    for (let i = 0; i < segs; i++) {
      let d = ang[i + 1] - ang[i];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      spans.push(Math.abs(d) < 1e-9 ? 0 : d);
    }
  }

  let moved = 0;
  sp.nodes.forEach((nd, i) => {
    const to: Pt = [cx + r * Math.cos(ang[i]), cy + r * Math.sin(ang[i])];
    moved = Math.max(moved, Math.hypot(to[0] - nd.pt[0], to[1] - nd.pt[1]));
    nd.pt = to;
    nd.hIn = null;
    nd.hOut = null;
  });

  let widestSpan = 0;
  for (let i = 0; i < segs; i++) {
    const d = spans[i];
    widestSpan = Math.max(widestSpan, Math.abs(d));
    // Coincident angles span no arc: leave the segment straight rather than
    // emitting a zero-length handle that reads as a cusp.
    if (d === 0) continue;

    const j = (i + 1) % n;
    const L = arcHandle(r, d);
    const a = sp.nodes[i];
    const b = sp.nodes[j];
    // The tangent at angle t, for increasing t, is (-sin t, cos t).
    a.hOut = [a.pt[0] - Math.sin(ang[i]) * L, a.pt[1] + Math.cos(ang[i]) * L];
    b.hIn = [b.pt[0] + Math.sin(ang[j]) * L, b.pt[1] - Math.cos(ang[j]) * L];
  }

  return { centre: fit.centre, radius: r, moved, widestSpan, fused: fuseDegenerate(sp) };
}

/**
 * Why a corner could not be rounded, or `null` when it was.
 *
 * Named reasons rather than a bare `false`, because every one of them is
 * something the person pressing the button can act on, and "it did not work" is
 * the least useful thing to tell them.
 */
export type RoundRefusal = 'end' | 'curved' | 'straight' | 'tiny';

export interface RoundResult {
  /** The radius actually used, which may be smaller than the one asked for. */
  radius: number;
  /** True when the sides were too short for the radius requested. */
  clamped: boolean;
}

/**
 * Replace a corner with a circular arc tangent to both of its sides.
 *
 * The operation the rectangle tool performs while drawing, available afterwards
 * on any corner. The node is replaced by two, one at each tangent point, and the
 * arc between them is a cubic, the same approximation used everywhere else here.
 *
 * **Both sides have to be straight.** A fillet is defined by being tangent to
 * two lines, and there is no honest version of it against a curve: you can put
 * an arc somewhere near, but it will not meet the curve smoothly, and a corner
 * operation that leaves a kink has not done its job. Refused rather than
 * approximated.
 *
 * The radius is clamped to what the shorter side can hold. Rounding the corners
 * of a rectangle one at a time works because each one sees the sides the
 * previous ones left behind.
 */
/**
 * A corner that could be rounded, measured.
 *
 * `u` and `v` are unit vectors from the corner along its two sides, so a tangent
 * point at distance `d` is `at + u * d`. `alpha` is the interior angle between
 * them and `reach` the furthest a tangent point can go before it runs past a
 * neighbour, which is what the radius gets clamped to.
 */
export interface Corner {
  at: Pt;
  u: Pt;
  v: Pt;
  alpha: number;
  reach: number;
}

/**
 * Measure the corner at node `i`, or say why there is not one.
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

  const here = sp.nodes[i];
  const prev = sp.nodes[(i - 1 + n) % n];
  const next = sp.nodes[(i + 1) % n];

  // The segment arriving at `i` is straight when neither governing handle
  // exists, and likewise the one leaving it.
  if (prev.hOut !== null || here.hIn !== null || here.hOut !== null || next.hIn !== null) {
    return 'curved';
  }

  const a: Pt = [prev.pt[0] - here.pt[0], prev.pt[1] - here.pt[1]];
  const b: Pt = [next.pt[0] - here.pt[0], next.pt[1] - here.pt[1]];
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  if (la < 1e-9 || lb < 1e-9) return 'tiny';

  const u: Pt = [a[0] / la, a[1] / la];
  const v: Pt = [b[0] / lb, b[1] / lb];
  // Interior angle at the corner, between the two rays leaving it.
  const cos = Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1]));
  const alpha = Math.acos(cos);
  // Nothing to round when the path runs straight through, and nothing sensible
  // to do when it folds back on itself.
  if (alpha > Math.PI - 1e-6 || alpha < 1e-6) return 'straight';

  return { at: clonePt(here.pt), u, v, alpha, reach: Math.min(la, lb) };
}

/** The largest radius a corner can hold, which is `reach` read as a radius. */
export const maxCornerRadius = (c: Corner): number => c.reach * Math.tan(c.alpha / 2);

export function roundCorner(
  sp: Subpath,
  i: number,
  radius: number,
): RoundResult | RoundRefusal {
  if (!(radius > 0)) return 'tiny';
  const c = cornerAt(sp, i);
  if (typeof c === 'string') return c;

  const n = sp.nodes.length;
  const prevI = (i - 1 + n) % n;
  const nextI = (i + 1) % n;
  const here = sp.nodes[i];
  const prev = sp.nodes[prevI];
  const next = sp.nodes[nextI];
  const { u, v, alpha } = c;

  const half = alpha / 2;
  // Distance from the corner to each tangent point, for the radius asked for.
  let cut = radius / Math.tan(half);
  const clamped = cut > c.reach;
  if (clamped) cut = c.reach;
  const r = cut * Math.tan(half);
  if (!(r > 1e-9)) return 'tiny';

  const t1: Pt = [here.pt[0] + u[0] * cut, here.pt[1] + u[1] * cut];
  const t2: Pt = [here.pt[0] + v[0] * cut, here.pt[1] + v[1] * cut];
  // The arc turns through the exterior angle, not the interior one.
  const h = arcHandle(r, Math.PI - alpha);

  /* A tangent point can land exactly on a neighbour: at the clamp, and whenever
     two fillets meet in the middle of a side they share. Inserting a node there
     anyway left two anchors on the same point and a zero-length segment in the
     exported path -- and a path carrying one can never be simplified again,
     because a zero chord gives the fitter no tangent to work from. Where they
     coincide the neighbour is reused, which is also the right answer
     geometrically: two arcs that meet share the point where they meet. */
  const startsAtPrev = Math.hypot(t1[0] - prev.pt[0], t1[1] - prev.pt[1]) <= MEET;
  const endsAtNext = Math.hypot(t2[0] - next.pt[0], t2[1] - next.pt[1]) <= MEET;

  const first: PathNode = {
    id: nextNodeId(),
    pt: t1,
    hIn: null,
    hOut: [t1[0] - u[0] * h, t1[1] - u[1] * h],
  };
  const second: PathNode = {
    id: nextNodeId(),
    pt: t2,
    hIn: [t2[0] - v[0] * h, t2[1] - v[1] * h],
    hOut: null,
  };

  const insert: PathNode[] = [];
  if (startsAtPrev) prev.hOut = first.hOut;
  else insert.push(first);
  if (endsAtNext) next.hIn = second.hIn;
  else insert.push(second);
  // Travel runs prev -> t1 -> arc -> t2 -> next, so the tangent leaving `t1`
  // points away from `prev`, and the one arriving at `t2` points at `next`.
  sp.nodes.splice(i, 1, ...insert);
  return { radius: r, clamped };
}

/**
 * A rounded corner, read back off the path.
 *
 * `i` and `j` are the two tangent nodes, `at` the corner they were cut from, and
 * `radius` the one they were cut with.
 */
export interface Fillet {
  i: number;
  j: number;
  at: Pt;
  radius: number;
}

/**
 * Is the pair of nodes starting at `i` a rounded corner, and if so what of?
 *
 * **Nothing is stored to answer this.** A fillet's two tangent nodes each carry
 * exactly one handle, and each of those handles points at the corner the fillet
 * was cut from -- so the corner is where the two handle rays cross, and the radius
 * follows from the distance to it. That is what lets a rounded corner be grabbed
 * and re-rounded without the path holding a radius that the geometry could then
 * disagree with.
 *
 * Measured rather than assumed. Two nodes with one handle each are not necessarily
 * a fillet, so the arc is checked for being circular and tangent to both sides
 * before this says it is one: equal cuts, equal handles, and handles the length a
 * circular arc through that angle actually needs. §48 has the argument.
 */
export function filletAt(sp: Subpath, i: number): Fillet | null {
  const n = sp.nodes.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) return null;
  if (n < 3) return null;
  const j = (i + 1) % n;
  if (!sp.closed && j === 0) return null;

  const a = sp.nodes[i];
  const b = sp.nodes[j];
  // One handle each, and both facing the arc between them. Anything else is not
  // a corner that was rounded, whatever it looks like.
  if (a.hIn !== null || a.hOut === null || b.hIn === null || b.hOut !== null) return null;

  // Direction of travel leaving `a`, and arriving at `b`. The corner lies where
  // the first ray forward meets the second ray backward.
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
  if (!(t > 1e-9)) return null; // the crossing is behind `a`, so it is not this corner
  const at: Pt = [a.pt[0] + ea[0] * t, a.pt[1] + ea[1] * t];

  const cutA = t;
  const cutB = Math.hypot(b.pt[0] - at[0], b.pt[1] - at[1]);
  // Equal cuts: a fillet is tangent to both sides at the same distance out.
  if (Math.abs(cutA - cutB) > 1e-6 * Math.max(cutA, cutB)) return null;

  /* The interior angle, from the two rays *leaving* the corner -- which is `-ea`
     toward `a` and `eb` toward `b`, the same frame `cornerAt` measures in. */
  const cos = Math.min(1, Math.max(-1, -ea[0] * eb[0] + -ea[1] * eb[1]));
  const alpha = Math.acos(cos);
  if (alpha > Math.PI - 1e-6 || alpha < 1e-6) return null;

  const radius = cutA * Math.tan(alpha / 2);
  // Circular, not merely tangent: the handle a circular arc through this angle
  // needs is a fixed length, so a pair that misses it is some other curve.
  if (Math.abs(ha - arcHandle(radius, Math.PI - alpha)) > 1e-6 * Math.max(ha, 1)) return null;

  return { i, j, at, radius };
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
  const sharp = makeNode(f.at);
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

export function transformSubpath(sp: Subpath, m: Mat): void {
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
 * `setSegmentBend` is the constrained edit: two numbers, a symmetric result,
 * and no way to express a curve that leans. It is the better tool when the
 * segment is already symmetric, and it has nothing to say when it is not.
 * Most curves in a real drawing are not, so this unconstrained edit is what
 * the bend control reaches for outside the symmetric case.
 *
 * A cubic's point at `t` is a weighted sum of its four control points, and the
 * endpoints are fixed here, so the displacement has to come out of the two
 * controls:
 *
 *   d = b1 * dC1 + b2 * dC2,  b1 = 3(1-t)^2 t,  b2 = 3(1-t) t^2
 *
 * One equation, two unknowns, so the answer is a choice rather than a
 * derivation. Taking the least-norm solution -- `dCi = d * bi / (b1^2 + b2^2)`
 * -- moves the handles as little as the displacement allows, which is what
 * makes a drag feel like it is dragging the curve rather than rearranging it.
 * It also splits the work in the ratio the two controls already influence the
 * point, so the control nearer the pointer does more of it.
 *
 * `t` is clamped away from the ends because `b1` and `b2` vanish there: the
 * point at `t = 0` is the endpoint, no handle can move it, and the least-norm
 * answer to an unsatisfiable equation is an infinity.
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
 */
export function alignNodes(doc: Doc, refs: NodeRef[], mode: AlignMode): void {
  const items = resolve(doc, refs);
  if (items.length < 2) return;

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
  for (const it of items) {
    const p = it.sp.nodes[it.i].pt;
    moveAnchor(it.sp, it.i, horizontal ? [target, p[1]] : [p[0], target]);
  }
}

/** Space anchors evenly between the two extremes, which stay put. */
export function distributeNodes(doc: Doc, refs: NodeRef[], axis: 'h' | 'v'): void {
  const items = resolve(doc, refs);
  if (items.length < 3) return;

  const ax = axis === 'h' ? 0 : 1;
  items.sort((a, b) => a.sp.nodes[a.i].pt[ax] - b.sp.nodes[b.i].pt[ax]);

  const first = items[0].sp.nodes[items[0].i].pt[ax];
  const last = items[items.length - 1].sp.nodes[items[items.length - 1].i].pt[ax];
  const step = (last - first) / (items.length - 1);

  items.forEach((it, k) => {
    if (k === 0 || k === items.length - 1) return;
    const p = it.sp.nodes[it.i].pt;
    const v = first + step * k;
    moveAnchor(it.sp, it.i, ax === 0 ? [v, p[1]] : [p[0], v]);
  });
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
        const reach = best?.d ?? maxDist;
        if (p[0] < lo0 - reach || p[0] > hi0 + reach) continue;
        if (p[1] < lo1 - reach || p[1] > hi1 + reach) continue;

        const pr = projectToCubic(c, p);
        if (pr.d < (best?.d ?? maxDist)) {
          best = { shape: shape.id, sp: spI, seg, t: pr.t, d: pr.d, pt: pr.pt };
        }
      }
    });
  }
  return best;
}

/** The handle or anchor nearest `p`, within `maxDist`. */
export interface NodeHit extends NodeRef {
  part: HandlePart;
  d: number;
}

