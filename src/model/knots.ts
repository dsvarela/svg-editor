/**
 * Remove nodes that are not doing anything.
 *
 * Simplify resamples: it throws the path away and refits it from points, which
 * is the right thing to do to a traced raster boundary and the wrong thing to
 * do to curves somebody drew. It cannot recognise a redundant node, because the
 * algorithm it is built on (`core/fit.ts`, Schneider 1990) never sees a curve.
 * Its input is digitised points, so "this input already IS a cubic" is not a
 * question it can be asked. Measured: given 100 exact samples of one cubic and
 * its exact end tangents, at a tolerance of 0.001 it returns seven curves, and
 * the chord-length parameter guess is the whole reason.
 *
 * This file is the other operation. A path of cubic Beziers is a cubic B-spline
 * whose interior knots all have multiplicity equal to the degree, and taking a
 * node out is knot removal. That is not an analogy: it is the standard way to
 * convert piecewise Bezier data to a compact B-spline, and it is what Piegl and
 * Tiller's section 5.4 is for.
 *
 * ## The condition, and why it needs no special cases
 *
 * A knot of multiplicity `s` in a degree `p` curve is removable `t` times if
 * and only if the curve is `C^(p-s+t)` continuous there. Here `p = 3` and
 * `s = 3`, and removing a node outright is `t = 3`, so a node is removable
 * exactly when the path is `C3` across it. A cubic that is `C3` across a knot
 * is one cubic.
 *
 * So the rule is: a node goes if its two segments are pieces of the same cubic.
 * A corner is `C0` and stays. A node from a double-click is `C3` and goes. A
 * node nudged slightly off is nearly `C3`, and how nearly is its price. One
 * test covers all three, including the collinear-node case that would
 * otherwise need a rule of its own.
 *
 * ## The knot vector a Bezier path does not have
 *
 * Tiller assumes the knot vector is given. A Bezier path carries no
 * parameterisation, and which nodes are removable depends on the one you pick:
 * a cubic split at 0.3 is `C3` under knots spaced 0.3 to 0.7 and merely `C1`
 * under uniform ones. The geometry says what the spacing was. Splitting at `t`
 * scales the join handles by `t` on the left and `1 - t` on the right, so
 * `t = a / (a + b)` recovers it from the two handle lengths, exactly, at any
 * split position. Verified to 7e-15 on control points.
 *
 * ## Cost
 *
 * Local and closed-form: a handful of arithmetic per node, no sampling, no
 * projection, no iteration. An earlier prototype that sampled each candidate
 * and projected the samples took 156 ms on 2000 nodes. This does not sample.
 *
 * ## Sources
 *
 * - Piegl and Tiller, *The NURBS Book*, section 5.4, for the removability
 *   condition and the inward-from-both-ends reconstruction.
 * - Tiller, *Knot-removal algorithms for NURBS curves and surfaces*, CAD 24(8),
 *   1992, whose appendix proves that a control-point discrepancy below `TOL`
 *   bounds the curve's movement by `TOL` everywhere, and confines it to the
 *   span of one basis function.
 * - Lyche and Morken, *A Data-Reduction Strategy for Splines*, IMA J. Numer.
 *   Anal. 8(2), 1988, for the ranking: bucket the costs into `2^(i-2) * eps`
 *   and spread removals within a bucket rather than taking them in strict
 *   order, because strict order eats a circle from one end.
 */

import { cubicAt } from '../core/bezier';
import { clonePt, segmentAsCubic, segmentCount } from '../core/types';
import type { Cubic, Pt, Subpath } from '../core/types';

/** Below this a length is zero, and a ratio built from it means nothing. */
const TINY = 1e-12;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt): number => Math.hypot(v[0], v[1]);
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * What removing the node between `L` and `R` would cost, and what would replace
 * them. `cost` is `Infinity` when the pair cannot be merged at all.
 *
 * The cost is a distance between two control points, not a measured deviation.
 * That is deliberate and it is what makes this cheap: Tiller's appendix proves
 * the curve moves by less than that distance everywhere, so it is a bound, and
 * a conservative one. Measuring instead would be slower and would report a
 * smaller number for the same removal.
 */
export interface Merge {
  cost: number;
  cubic: Cubic | null;
}

const REFUSED: Merge = { cost: Infinity, cubic: null };

/**
 * Merge two segments back into the cubic they were cut from.
 *
 * Reconstruction runs inward from both ends, which is Tiller's shape. With
 * `Q = [q0, q1, q2, q3]` split at `t`, de Casteljau gives
 *
 *   A = lerp(q0, q1, t)   B = lerp(q1, q2, t)   C = lerp(q2, q3, t)
 *   D = lerp(A, B, t)     E = lerp(B, C, t)     F = lerp(D, E, t)
 *   L = [q0, A, D, F]     R = [F, E, C, q3]
 *
 * so `q1` and `q2` follow from `L[1]` and `R[2]` alone, and `B` can be reached
 * from either side. The two answers agree exactly when the pair really is one
 * cubic, and their disagreement is the price of pretending otherwise.
 */
export function mergeSegments(L: Cubic, R: Cubic): Merge {
  /* Both straight is the one case the ratio cannot speak for: two lines have no
     join handles, so `a` and `b` are both zero and `t` is 0/0. Collinearity is
     the whole question there, and the answer is the middle node's distance from
     the chord. Note this is not a special case bolted on: it is the same
     condition, `C3`, in the corner of the space where the general formula
     divides by zero. */
  const lStraight = dist(L[0], L[1]) < TINY && dist(L[2], L[3]) < TINY;
  const rStraight = dist(R[0], R[1]) < TINY && dist(R[2], R[3]) < TINY;
  if (lStraight && rStraight) {
    const chord = sub(R[3], L[0]);
    const m = len(chord);
    if (m < TINY) return REFUSED;
    const v = sub(L[3], L[0]);
    // Perpendicular distance, and the join must lie BETWEEN the two ends
    // rather than beyond one of them: a spike doubling back is collinear and
    // is not a redundant node.
    const along = (v[0] * chord[0] + v[1] * chord[1]) / (m * m);
    if (along < -TINY || along > 1 + TINY) return REFUSED;
    const cost = Math.abs(v[0] * chord[1] - v[1] * chord[0]) / m;
    const q1: Pt = [L[0][0] + chord[0] / 3, L[0][1] + chord[1] / 3];
    const q2: Pt = [R[3][0] - chord[0] / 3, R[3][1] - chord[1] / 3];
    return { cost, cubic: [clonePt(L[0]), q1, q2, clonePt(R[3])] };
  }

  const a = dist(L[3], L[2]);
  const b = dist(R[1], R[0]);
  if (a + b < TINY) return REFUSED;

  const t = a / (a + b);
  if (!(t > TINY && t < 1 - TINY)) return REFUSED;
  const s = 1 - t;

  const q0 = L[0];
  const q3 = R[3];
  const q1: Pt = [q0[0] + (L[1][0] - q0[0]) / t, q0[1] + (L[1][1] - q0[1]) / t];
  const q2: Pt = [q3[0] + (R[2][0] - q3[0]) / s, q3[1] + (R[2][1] - q3[1]) / s];

  // `B` from the left, and `B` from the right. Tiller compares exactly these.
  const bl: Pt = [L[1][0] + (L[2][0] - L[1][0]) / t, L[1][1] + (L[2][1] - L[1][1]) / t];
  const br: Pt = [(R[1][0] - t * R[2][0]) / s, (R[1][1] - t * R[2][1]) / s];

  /* C1 has to be priced separately, and leaving it out was a real defect.
     Removing a knot three times needs C3, and C3 implies C1, but the
     reconstruction above ASSUMES C1: it takes `t` from the ratio of the two
     join handles, which only describes a split when they point the same way.
     Feed it a right angle and it is internally consistent about a curve that
     is not the input, so `bl` and `br` agree exactly and the discrepancy reads
     zero. A square lost its corners.
     The C1 error in the same units: where the far handle would sit if the
     tangents did agree, against where it actually sits. Zero for a real split,
     small for a nudged node, and the length of the handle for a right angle. */
  const c1: Pt = [R[0][0] + ((L[3][0] - L[2][0]) / a) * b, R[0][1] + ((L[3][1] - L[2][1]) / a) * b];
  const bend = a > TINY ? dist(c1, R[1]) : Infinity;

  const cubic: Cubic = [clonePt(q0), q1, q2, clonePt(q3)];

  /* Does the candidate actually pass through the join, at the parameter the
     handles claim it was cut at? The two checks above compare reconstructions
     of the same interior control point against each other, and they can agree
     with each other while both disagree with the input. Dragging a node and
     its two handles together is exactly that case: every ratio survives the
     translation, `bl` and `br` shift by the same amount when the cut was at a
     half, and a node moved two whole units read as free to remove. This is the
     one constraint the pair of them does not carry. */
  const at = cubicAt(cubic, t) as Pt;
  const join = dist(at, L[3]);

  const cost = Math.max(dist(bl, br), bend, join);
  if (!Number.isFinite(cost)) return REFUSED;
  for (const p of [q1, q2]) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return REFUSED;
  }
  return { cost, cubic };
}

/** What removing node `i` would cost, wrapping the window on a closed path. */
export function nodeRemovalCost(sp: Subpath, i: number): Merge {
  const segs = segmentCount(sp);
  if (segs < 2) return REFUSED;
  // An end of an open path has a segment on one side only, so there is nothing
  // to merge and nothing to remove.
  if (!sp.closed && (i === 0 || i === sp.nodes.length - 1)) return REFUSED;
  const before = (i - 1 + segs) % segs;
  return mergeSegments(segmentAsCubic(sp, before), segmentAsCubic(sp, i));
}

export interface RemovalResult {
  before: number;
  after: number;
  /** The largest single removal cost accepted. A bound, not a measurement. */
  cost: number;
  passes: number;
}

/**
 * Take out every node whose removal costs less than `tol`.
 *
 * Ordering follows Lyche and Morken rather than a plain heap. Sorting by cost
 * and taking the cheapest first "does not work for a circle where all weights
 * are approximately equal": a uniformly subdivided ring has identical costs
 * everywhere, and strict order eats it from one end, leaving a shape that is
 * dense on one side and bare on the other. Their fix is to bucket the costs by
 * powers of two of the tolerance and spread the removals across each bucket,
 * which is what `pickSpread` does.
 *
 * Costs are recomputed each pass rather than tracked incrementally, because a
 * removal changes both its neighbours' handles and therefore their prices.
 *
 * The paper advises capping the passes at five, and that advice does not
 * transfer. Their pass removes many knots at once through a binary search on
 * the count; this one takes no two adjacent nodes in a round, so it removes at
 * most every other candidate and needs about log2(n) rounds. Measured on a ring
 * subdivided repeatedly: 64 nodes reach the answer in five passes, 128 need six
 * and 256 need seven, and a cap of five left 128 nodes stranded at 5 and 256 at
 * 9 when the answer was 4 in both cases. The cap here is a runaway guard, not a
 * budget. It costs nothing to raise: each pass has half the nodes of the one
 * before, so the whole loop is under twice the work of the first pass.
 */
export function removeRedundantNodes(sp: Subpath, tol: number, maxPasses = 24): RemovalResult {
  const before = sp.nodes.length;
  let worst = 0;
  let passes = 0;

  for (; passes < maxPasses; passes++) {
    const floor = sp.closed ? 3 : 2;
    if (sp.nodes.length <= floor) break;

    const candidates: { i: number; cost: number }[] = [];
    for (let i = 0; i < sp.nodes.length; i++) {
      const m = nodeRemovalCost(sp, i);
      if (m.cost <= tol) candidates.push({ i, cost: m.cost });
    }
    if (!candidates.length) break;

    /* Bucket by 2^(j-2) * tol, the partition they settled on after trying
       cleverer ones: "none of these partitions has turned out to be
       consistently better than the simple one above." */
    const bucketOf = (c: number): number => {
      if (c < tol / 2) return 0;
      return Math.max(1, Math.floor(Math.log2(Math.max(c, TINY) / tol)) + 2);
    };
    const buckets = new Map<number, number[]>();
    for (const c of candidates) {
      const b = bucketOf(c.cost);
      const list = buckets.get(b);
      if (list) list.push(c.i);
      else buckets.set(b, [c.i]);
    }

    /* No two adjacent nodes in one round. Removing a node rewrites the handles
       either side of it, so its neighbour's price is stale the moment it goes,
       and taking both on the same stale numbers is how a run of nodes collapses
       further than the tolerance allowed. The next pass picks up whatever this
       one skipped. */
    const doomed = new Set<number>();
    const n = sp.nodes.length;
    for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
      for (const i of pickSpread(buckets.get(b) as number[])) {
        const prev = (i - 1 + n) % n;
        const next = (i + 1) % n;
        if (doomed.has(prev) || doomed.has(next)) continue;
        if (n - doomed.size <= (sp.closed ? 3 : 2)) break;
        doomed.add(i);
      }
    }
    if (!doomed.size) break;

    // Highest index first, so the lower indices stay valid while removing.
    for (const i of [...doomed].sort((x, y) => y - x)) {
      const m = nodeRemovalCost(sp, i);
      if (!m.cubic || m.cost > tol) continue;
      worst = Math.max(worst, m.cost);
      applyMerge(sp, i, m.cubic);
    }
  }

  return { before, after: sp.nodes.length, cost: worst, passes };
}

/**
 * Spread picks across a bucket instead of taking them in order.
 *
 * `i_j = floor((r + 1)(j - 1/2)/p + 1/2)` from the paper, with every member
 * wanted, so this is the even walk of the whole list. Kept as its own function
 * because the ordering is the part that stops a ring being eaten from one side,
 * and inlining it would hide that.
 */
function pickSpread(members: number[]): number[] {
  if (members.length < 3) return members;
  const r = members.length;
  const out: number[] = [];
  const seen = new Set<number>();
  for (let j = 1; j <= r; j++) {
    const idx = Math.min(r - 1, Math.max(0, Math.round(((r + 1) * (j - 0.5)) / r + 0.5) - 1));
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(members[idx]);
    }
  }
  // Any the rounding skipped, in their own order, so nothing is silently lost.
  for (let k = 0; k < r; k++) if (!seen.has(k)) out.push(members[k]);
  return out;
}

/** Replace node `i` and its two segments with one cubic. */
function applyMerge(sp: Subpath, i: number, cubic: Cubic): void {
  const n = sp.nodes.length;
  const prev = (i - 1 + n) % n;
  const next = (i + 1) % n;

  const a = sp.nodes[prev];
  const b = sp.nodes[next];

  /* A straight result must be written as `null` handles, not as control points
     that happen to lie on the chord. The model's rule is that a null handle is
     what makes a segment a line, and `segmentIsLine`, the serialiser and the
     Straighten button all read it. Merging two collinear lines produces
     controls on the thirds of the chord, which draws the same line and reads
     as a curve, so a straight run collapsed once and then refused to collapse
     again: the next pass no longer recognised it as straight.
     Checked as "on the chord", not "on its own anchor", because the thirds are
     nowhere near either endpoint. */
  const chord = sub(b.pt, a.pt);
  const m = len(chord);
  const onChord = (p: Pt): boolean => {
    if (m < TINY) return false;
    const v = sub(p, a.pt);
    const across = Math.abs(v[0] * chord[1] - v[1] * chord[0]) / m;
    const along = (v[0] * chord[0] + v[1] * chord[1]) / (m * m);
    return across < TINY * Math.max(1, m) && along > -TINY && along < 1 + TINY;
  };

  if (onChord(cubic[1]) && onChord(cubic[2])) {
    a.hOut = null;
    b.hIn = null;
  } else {
    a.hOut = dist(cubic[1], a.pt) < TINY ? null : clonePt(cubic[1]);
    b.hIn = dist(cubic[2], b.pt) < TINY ? null : clonePt(cubic[2]);
  }
  sp.nodes.splice(i, 1);
}

/**
 * The largest movement that cannot survive being written to the file.
 *
 * The export rounds to `decimals` places, so anything below half a unit in the
 * last place is not representable in the output at all. That is what makes
 * "truly useless" a definition rather than a feeling, and it is why removal at
 * this threshold is safe to do at any tolerance the user asks for: it cannot
 * change a single character of what gets saved.
 */
export const invisibleAt = (decimals: number): number =>
  0.5 * Math.pow(10, -Math.max(0, Math.min(9, decimals)));

/** Convenience: nodes that cannot affect the exported file, at any tolerance. */
export function removeInvisibleNodes(sp: Subpath, decimals: number): RemovalResult {
  return removeRedundantNodes(sp, invisibleAt(decimals));
}

/**
 * Remove nodes until only `target` are left, whatever it costs.
 *
 * The same machinery as `removeRedundantNodes` with the question turned round.
 * That one asks "what can go for free?" and stops when the answer is nothing;
 * this asks "what goes first?" and stops when the count is right. Both price
 * every node the same way, bucket by cost, and take a spread of non-adjacent
 * ones per pass, because a run that ate the cheapest node and then its
 * neighbour would eat a circle from one side.
 *
 * The bucket scale comes from the costs themselves rather than from a
 * tolerance, since there is no tolerance here -- the caller has asked for a
 * count and accepted whatever it costs. `cost` comes back as the worst removal
 * accepted, which is what the caller has to report.
 *
 * A run of passes can only halve a run at a time, since no two adjacent nodes
 * go together, so the last pass usually has more to remove than it needs. It
 * takes the cheapest of what it picked, and no more.
 */
export function reduceToCount(sp: Subpath, target: number, maxPasses = 40): RemovalResult {
  const before = sp.nodes.length;
  const floor = sp.closed ? 3 : 2;
  const want = Math.max(floor, Math.floor(target));
  let worst = 0;
  let passes = 0;

  for (; passes < maxPasses && sp.nodes.length > want; passes++) {
    const n = sp.nodes.length;
    const priced: { i: number; cost: number }[] = [];
    for (let i = 0; i < n; i++) {
      const m = nodeRemovalCost(sp, i);
      if (m.cubic) priced.push({ i, cost: m.cost });
    }
    if (!priced.length) break;

    // The scale the buckets are cut on, taken from what is actually here.
    const scale = Math.max(TINY, Math.min(...priced.map((p) => p.cost)) || TINY);
    const buckets = new Map<number, number[]>();
    for (const p of priced) {
      const b = Math.max(0, Math.floor(Math.log2(Math.max(p.cost, TINY) / scale)));
      const list = buckets.get(b);
      if (list) list.push(p.i);
      else buckets.set(b, [p.i]);
    }

    const doomed = new Set<number>();
    for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
      for (const i of pickSpread(buckets.get(b) as number[])) {
        const prev = (i - 1 + n) % n;
        const next = (i + 1) % n;
        if (doomed.has(prev) || doomed.has(next)) continue;
        if (n - doomed.size <= want) break;
        doomed.add(i);
      }
      if (n - doomed.size <= want) break;
    }
    if (!doomed.size) break;

    /* Cheapest first, and only as many as are still wanted. Without the second
       half a pass that picked six when four were needed would overshoot the
       count the caller asked for, which is the one thing this promises. */
    const order = [...doomed]
      .map((i) => ({ i, cost: nodeRemovalCost(sp, i).cost }))
      .sort((a, b) => a.cost - b.cost)
      .slice(0, Math.max(0, n - want));
    for (const { i } of order.sort((a, b) => b.i - a.i)) {
      const m = nodeRemovalCost(sp, i);
      if (!m.cubic) continue;
      worst = Math.max(worst, m.cost);
      applyMerge(sp, i, m.cubic);
    }
  }

  return { before, after: sp.nodes.length, cost: worst, passes };
}

/**
 * Remove every node except the ones named, whatever it costs.
 *
 * The count variant with the stopping condition replaced by a set: a node in
 * `keep` is never a candidate, and the run ends when nothing else can go. No
 * scale problem and no overshoot problem, because nothing is being counted.
 *
 * `keep` is by index into the subpath as it stands when the call is made.
 * Indices shift as nodes go, so this tracks the kept nodes by identity -- the
 * node objects themselves -- rather than re-deriving indices it would have to
 * keep correcting.
 */
export function keepOnly(sp: Subpath, keep: Set<number>, maxPasses = 40): RemovalResult {
  const before = sp.nodes.length;
  const floor = sp.closed ? 3 : 2;
  const protectedNodes = new Set([...keep].map((i) => sp.nodes[i]).filter(Boolean));
  let worst = 0;
  let passes = 0;

  for (; passes < maxPasses && sp.nodes.length > floor; passes++) {
    const n = sp.nodes.length;
    const priced: { i: number; cost: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (protectedNodes.has(sp.nodes[i])) continue;
      const m = nodeRemovalCost(sp, i);
      if (m.cubic) priced.push({ i, cost: m.cost });
    }
    if (!priced.length) break;

    const scale = Math.max(TINY, Math.min(...priced.map((p) => p.cost)) || TINY);
    const buckets = new Map<number, number[]>();
    for (const p of priced) {
      const b = Math.max(0, Math.floor(Math.log2(Math.max(p.cost, TINY) / scale)));
      const list = buckets.get(b);
      if (list) list.push(p.i);
      else buckets.set(b, [p.i]);
    }

    const doomed = new Set<number>();
    for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
      for (const i of pickSpread(buckets.get(b) as number[])) {
        const prev = (i - 1 + n) % n;
        const next = (i + 1) % n;
        if (doomed.has(prev) || doomed.has(next)) continue;
        if (n - doomed.size <= floor) break;
        doomed.add(i);
      }
    }
    if (!doomed.size) break;

    for (const i of [...doomed].sort((x, y) => y - x)) {
      const m = nodeRemovalCost(sp, i);
      if (!m.cubic) continue;
      worst = Math.max(worst, m.cost);
      applyMerge(sp, i, m.cubic);
    }
  }

  return { before, after: sp.nodes.length, cost: worst, passes };
}
