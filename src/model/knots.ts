/**
 * Remove nodes that are not doing anything: knot removal at `t = 3`.
 *
 * Legal exactly where the path is `C3` across the node, which needs no special
 * cases -- a corner is `C0` and stays, and collinear nodes fall out of the same
 * test.
 *
 * **The knot vector comes from the handles**, because a Bezier path carries
 * none and removability depends on the parameterisation. Splitting at `t`
 * scales the join handles by `t` and `1 - t`, so `t = a / (a + b)` recovers it.
 *
 * **Local and closed-form**, no sampling or iteration: sampling and projecting
 * each candidate costs 156 ms on 2000 nodes, measured.
 *
 * §19 of `docs/ARCHITECTURE.md` has the rest. Piegl and Tiller, *The NURBS
 * Book*, 5.4 has the removability condition.
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
  /**
   * Where on `cubic` the removed node sat, or 0 when there is no cubic.
   *
   * The reconstruction has to know this to run at all, so it is returned rather
   * than recovered: projecting the node back onto the parent is what a caller
   * would otherwise do, and `projectToCubic` answers to about 5e-6 where this
   * is exact.
   */
  t: number;
}

const REFUSED: Merge = { cost: Infinity, cubic: null, t: 0 };

/**
 * Whether a cubic draws a straight line, asked of the drawing.
 *
 * Both controls on the chord and between its ends. Not where the controls sit
 * relative to the anchors, which is a storage convention rather than a fact
 * about the curve: this read `dist(c[0], c[1]) < TINY` until 2026-08-20, and
 * when `segmentAsCubic` moved a line's controls onto the thirds the test went
 * silently false for every line in the document.
 *
 * The branch below stopped running, and the general formula answered for
 * straight runs instead. It gives a curve. Simplifying a nearly straight run
 * wrote `C 33.33 0.833 66.664 0.556 100 0` where the drawing had `H 100`: a
 * curve in place of a straight edge, in more bytes, from the operation whose
 * job is to remove both. A spike that doubles back stopped being refused at
 * the same time, because only this branch asks whether the join lies between
 * the two ends. §70.
 */
const drawsStraight = (c: Cubic): boolean => {
  const chord = sub(c[3], c[0]);
  const m = len(chord);
  if (m < TINY) return false;
  for (const p of [c[1], c[2]]) {
    const v = sub(p, c[0]);
    if (Math.abs(v[0] * chord[1] - v[1] * chord[0]) / m > TINY * m) return false;
    const along = (v[0] * chord[0] + v[1] * chord[1]) / (m * m);
    if (along < -TINY || along > 1 + TINY) return false;
  }
  return true;
};

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
  /* Both straight is the one case the ratio cannot speak for: two lines have
     nothing to take a ratio of, and the general formula below divides by it.
     Collinearity is the whole question there, and the answer is the middle
     node's distance from the chord. Note this is not a special case bolted on:
     it is the same condition, `C3`, in the corner of the space where the
     general formula has nothing to work with. */
  if (drawsStraight(L) && drawsStraight(R)) {
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
    return { cost, cubic: [clonePt(L[0]), q1, q2, clonePt(R[3])], t: along };
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
  return { cost, cubic, t };
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
 * Bucket priced nodes by how many doublings their cost is above the cheapest.
 *
 * The partition `reduceToCount` and `keepOnly` share. Neither has a tolerance
 * to cut against, so the scale comes from what is in front of it rather than
 * from a number the caller chose.
 */
function bucketsByRatio(priced: { i: number; cost: number }[]): Map<number, number[]> {
  const scale = Math.max(TINY, Math.min(...priced.map((p) => p.cost)) || TINY);
  const buckets = new Map<number, number[]>();
  for (const p of priced) {
    const b = Math.max(0, Math.floor(Math.log2(Math.max(p.cost, TINY) / scale)));
    const list = buckets.get(b);
    if (list) list.push(p.i);
    else buckets.set(b, [p.i]);
  }
  return buckets;
}

/**
 * Choose this pass's removals, cheapest bucket first and never two in a row.
 *
 * Removing a node rewrites the handles either side of it, so its neighbour's
 * price is stale the moment it goes, and taking both on the same stale numbers
 * is how a run of nodes collapses further than the tolerance allowed. The next
 * pass picks up whatever this one skipped.
 *
 * `keepAtLeast` is what stops the pass: a floor of 3 or 2 for the callers that
 * prune until nothing is left worth pruning, and the requested count for the
 * one that prunes to a number. All three wrote this loop out; the copies had
 * begun to differ in where they checked that limit, which changed nothing
 * because a bucket entered with no room left leaves with none either.
 */
function pickRemovals(buckets: Map<number, number[]>, n: number, keepAtLeast: number): Set<number> {
  const doomed = new Set<number>();
  for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
    for (const i of pickSpread(buckets.get(b) as number[])) {
      const prev = (i - 1 + n) % n;
      const next = (i + 1) % n;
      if (doomed.has(prev) || doomed.has(next)) continue;
      if (n - doomed.size <= keepAtLeast) break;
      doomed.add(i);
    }
    if (n - doomed.size <= keepAtLeast) break;
  }
  return doomed;
}

/**
 * Take out every node whose removal costs less than `tol`.
 *
 * Ordering follows Lyche and Morken: cheapest-first "does not work for a circle
 * where all weights are approximately equal", because strict order eats a
 * uniform ring from one end. `pickSpread` buckets by powers of two of the
 * tolerance and spreads removals across each bucket. Costs are recomputed each
 * pass, since a removal reprices both neighbours.
 *
 * **Their cap of five passes does not transfer**: this takes no two adjacent
 * nodes per round, so it needs about log2(n). Five stranded 256 nodes at 9
 * where the answer was 4, so the cap here is a runaway guard.
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

    const n = sp.nodes.length;
    const doomed = pickRemovals(buckets, n, floor);
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

    const doomed = pickRemovals(bucketsByRatio(priced), n, want);
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

    const doomed = pickRemovals(bucketsByRatio(priced), n, floor);
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
