/**
 * Every mutation the editor can perform on geometry.
 *
 * These functions mutate in place and know nothing about undo, rendering or
 * selection -- the store wraps them. Because the model is nodes-and-handles,
 * each one is a handful of lines with no per-command branching.
 */

import { cubicLength, projectToCubic, splitCubic } from '../core/bezier';
import { bendOf, bendToHandles } from '../core/bend';
import type { Bend } from '../core/bend';
import { applyMat } from '../core/affine';
import type { Mat } from '../core/affine';
import {
  cloneNode,
  continuityOf,
  endNodeIndex,
  makeNode,
  segmentAsCubic,
  segmentCount,
  segmentIsLine,
} from '../core/types';
import type { Doc, NodeContinuity, Pt, Shape, Subpath } from '../core/types';
import type { HandlePart, NodeRef } from './doc';

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);

/** Round to the grid. `step` of 0 disables snapping. */
export function snap(p: Pt, step: number): Pt {
  if (!step) return p;
  return [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];
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

/** Translate an anchor by a delta, handles included. */
export function nudgeAnchor(sp: Subpath, i: number, d: Pt): void {
  moveAnchor(sp, i, add(sp.nodes[i].pt, d));
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
 * align its handles, and to make it a corner you take its handles away. That is
 * a real edit to the geometry, which is the honest version of what the old
 * type-switch pretended to do -- setting the flag to `corner` used to change
 * nothing visible at all, then silently altered how the next drag behaved.
 *
 * A node with a missing handle has a straight segment on that side; aligning
 * against nothing is meaningless, so smooth/symmetric leave it alone.
 */
export function setContinuity(sp: Subpath, i: number, kind: NodeContinuity): void {
  const n = sp.nodes[i];

  if (kind === 'corner') {
    n.hIn = null;
    n.hOut = null;
    return;
  }
  if (!n.hIn || !n.hOut) return;

  // Average the two directions rather than adopting one of them, so the result
  // does not depend on which handle happens to be called "out".
  const din = norm(sub(n.pt, n.hIn));
  const dout = norm(sub(n.hOut, n.pt));
  if (!din || !dout) return;

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

  const lIn = len(sub(n.hIn, n.pt));
  const lOut = len(sub(n.hOut, n.pt));
  const [a, b] = kind === 'symmetric' ? [(lIn + lOut) / 2, (lIn + lOut) / 2] : [lIn, lOut];

  n.hIn = [n.pt[0] - ux * a, n.pt[1] - uy * a];
  n.hOut = [n.pt[0] + ux * b, n.pt[1] + uy * b];
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
 * It used to refuse below three nodes closed, two open, on the reasoning that a
 * path being edited should not degenerate. Run in a loop over a selection that
 * turned "delete these four" into "delete one" and left survivors that looked
 * like a bug in the marquee. A three-node closed path could not be reduced at
 * all. Refusing was the worse half of the trade: the degenerate cases are
 * visible, reversible and rare, and the refusal was none of those.
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

  if (sp.closed) {
    if (n < 2) return null;
    // Rotate so the break lands at both ends. The clone at the front keeps the
    // outgoing handle, the one at the back keeps the incoming handle, which is
    // precisely the pair of segments that used to meet here.
    const rotated = [...sp.nodes.slice(i), ...sp.nodes.slice(0, i)].map(cloneNode);
    const tail = cloneNode(sp.nodes[i]);
    rotated[0].hIn = null;
    tail.hOut = null;
    return [{ nodes: [...rotated, tail], closed: false }];
  }

  if (i === 0 || i === n - 1) return null;

  const head = sp.nodes.slice(0, i + 1).map(cloneNode);
  const tail = sp.nodes.slice(i).map(cloneNode);
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

/** Append a node to the end of an open subpath (the pen tool's basic move). */
export function appendNode(sp: Subpath, pt: Pt, hIn: Pt | null = null): number {
  sp.nodes.push(makeNode(pt, hIn));
  return sp.nodes.length - 1;
}

export function closeSubpath(sp: Subpath): void {
  if (sp.nodes.length >= 2) sp.closed = true;
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

export function transformNodes(doc: Doc, refs: NodeRef[], m: Mat): void {
  for (const r of refs) {
    const sp = doc.shapes.find((s) => s.id === r.shape)?.subpaths[r.sp];
    const n = sp?.nodes[r.i];
    if (!n) continue;
    n.pt = applyMat(m, n.pt);
    if (n.hIn) n.hIn = applyMat(m, n.hIn);
    if (n.hOut) n.hOut = applyMat(m, n.hOut);
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
export function nearestOnPath(doc: Doc, p: Pt, maxDist: number): PathHit | null {
  let best: PathHit | null = null;
  for (const shape of doc.shapes) {
    shape.subpaths.forEach((sp, spI) => {
      const n = segmentCount(sp);
      for (let seg = 0; seg < n; seg++) {
        const pr = projectToCubic(segmentAsCubic(sp, seg), p);
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

export function nearestNode(doc: Doc, p: Pt, maxDist: number): NodeHit | null {
  let best: NodeHit | null = null;
  const consider = (ref: NodeRef, part: HandlePart, at: Pt): void => {
    const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
    if (d < (best?.d ?? maxDist)) best = { ...ref, part, d };
  };
  for (const shape of doc.shapes) {
    shape.subpaths.forEach((sp, spI) => {
      sp.nodes.forEach((n, i) => {
        const ref = { shape: shape.id, sp: spI, i };
        // Handles win ties: they sit on top and are harder to hit.
        if (n.hIn) consider(ref, 'in', n.hIn);
        if (n.hOut) consider(ref, 'out', n.hOut);
        consider(ref, 'anchor', n.pt);
      });
    });
  }
  return best;
}
