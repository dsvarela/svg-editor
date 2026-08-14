/**
 * A path parallel to another, at a fixed distance.
 *
 * The exact offset of a cubic is not a cubic -- it is a degree-10 curve in
 * general -- so every editor approximates, and the question is only how. This
 * samples the true offset and fits cubics through the samples, which works here
 * because the editor already owns a good fitter and because offsetting has a
 * property that makes the fitter's job easy:
 *
 * **An offset curve is parallel, so it has the same tangent direction as its
 * original at every parameter.** `fitCurve` takes the end tangents as inputs
 * rather than guessing them, so the two ends of every run come out at exactly
 * the right angle, and the fitter is left with only the middle to solve. It
 * also subdivides on its own when it cannot hit the tolerance, so the error
 * control is already written.
 *
 * **The overrun is removed before fitting, by the distance criterion.** Where a
 * corner or a tight curve is offset further than its radius of curvature, the
 * parallel curve runs past itself and doubles back. Chen and McMains (2005)
 * settle what to keep: the invalid parts of a raw offset bound regions of
 * non-positive winding number, and the local test that says the same thing is a
 * distance. A raw-offset point lies on the true offset exactly when it is `|d|`
 * from the original; anything nearer is inside the disc swept along the curve,
 * so it is not on the boundary of the swept region and it is not on the offset.
 *
 * That is why the filtering happens to the *samples* and not to the fitted
 * curves. Fitting first and trimming after was tried twice and neither worked:
 * a curve fitted through a sequence that doubles back does not merely loop, it
 * leaves the offset altogether, so by then there is nothing left to trim that
 * is worth keeping.
 */

import { cubicAt, cubicDerivAt } from './bezier';
import { fitCurve } from './fit';
import { cloneNode, cloneSubpath, makeNode, nextNodeId, segmentAsCubic, segmentCount } from './types';
import { reverseSubpath } from '../model/ops';
import type { Cubic, PathNode, Pt, Subpath } from './types';

/** Below this, a derivative is treated as no direction at all. */
const TINY = 1e-9;

const norm = (v: Pt): Pt | null => {
  const len = Math.hypot(v[0], v[1]);
  return len < TINY ? null : [v[0] / len, v[1] / len];
};

/** The left-hand normal of a unit tangent, in SVG's y-down coordinates. */
const leftOf = (t: Pt): Pt => [t[1], -t[0]];

/**
 * The unit tangent at `t`, looking either side of a cusp if it has to.
 *
 * A cubic's derivative can vanish -- at a cusp, or wherever two control points
 * coincide -- and a zero tangent has no normal to offset along. Nudging the
 * parameter finds the direction the curve is actually travelling in, which is
 * what a person would say the tangent is there.
 */
function tangentAt(c: Cubic, t: number): Pt | null {
  const direct = norm(cubicDerivAt(c, t));
  if (direct) return direct;
  for (const dt of [1e-6, 1e-4, 1e-2]) {
    const before = t - dt >= 0 ? norm(cubicDerivAt(c, t - dt)) : null;
    const after = t + dt <= 1 ? norm(cubicDerivAt(c, t + dt)) : null;
    if (after) return after;
    if (before) return before;
  }
  return null;
}

/**
 * The length of a cubic's control hull.
 *
 * An upper bound on the arc length, and the reason both samplers below can ask
 * how big a segment is without integrating one. They want different numbers of
 * samples out of it, which is why only this part is shared.
 */
function hullSpan(c: Cubic): number {
  let span = 0;
  for (let i = 1; i < 4; i++) span += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
  return span;
}

/**
 * How many samples a segment gets.
 *
 * Off the control hull's size rather than the true arc length, which would cost
 * an integration to learn: the hull bounds the curve, so it never under-samples,
 * and over-sampling a nearly straight segment costs a few points the fitter
 * collapses anyway. `tol` steers it because a tighter fit needs more evidence.
 */
function sampleCount(c: Cubic, tol: number): number {
  return Math.max(8, Math.min(200, Math.ceil(hullSpan(c) / Math.max(tol, 1e-4))));
}

/** Points on the offset of one cubic, and the tangents at its two ends. */
function offsetSamples(
  c: Cubic,
  d: number,
  tol: number,
): { pts: Pt[]; t0: Pt; t1: Pt } | null {
  const t0 = tangentAt(c, 0);
  const t1 = tangentAt(c, 1);
  if (!t0 || !t1) return null;

  const n = sampleCount(c, tol);
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const tan = tangentAt(c, t);
    if (!tan) continue;
    const nrm = leftOf(tan);
    const p = cubicAt(c, t);
    pts.push([p[0] + nrm[0] * d, p[1] + nrm[1] * d]);
  }
  return pts.length >= 2 ? { pts, t0, t1 } : null;
}

/**
 * Samples along a round join between two offset ends.
 *
 * Only on the outside of a turn. On the inside the two offsets already overlap,
 * and adding an arc there would draw a loop over a loop; that overrun is left
 * to `trimSelfLoops`.
 *
 * The arc is centred on the node itself, which is what makes it a round join:
 * every point of it is exactly `|d|` from the corner.
 */
function joinSamples(at: Pt, from: Pt, to: Pt, d: number, tol: number): Pt[] {
  const a0 = Math.atan2(from[1] - at[1], from[0] - at[0]);
  const a1 = Math.atan2(to[1] - at[1], to[0] - at[0]);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;

  const r = Math.abs(d);
  // Steps fine enough that the chord sags less than the tolerance.
  const steps = Math.max(2, Math.min(64, Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, tol)))) )));
  const out: Pt[] = [];
  for (let i = 1; i < steps; i++) {
    const a = a0 + (sweep * i) / steps;
    out.push([at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r]);
  }
  return out;
}

/**
 * A lookup for "how far is this point from the original path".
 *
 * A dense polyline of the source in a uniform grid. The exact answer would be a
 * projection onto every segment, which is what the snapper does and costs far
 * too much here -- the filter asks this question once per sample, and there are
 * thousands of samples. The grid makes each query a scan of the few cells
 * around the point, and the polyline is fine enough that its error is well
 * under the tolerance the offset is being fitted to.
 */
class NearMap {
  private cells = new Map<string, Pt[]>();
  private size: number;

  /**
   * `cell` and `step` are separate on purpose, and conflating them was a bug
   * that survived three attempts to find it elsewhere.
   *
   * The cell size decides how many cells a query scans, so it wants to be the
   * query radius. The polyline step decides how accurate the answer is, so it
   * wants to be the tolerance. Using one number for both meant that making
   * queries cheap made the polyline coarse: a forty-unit edge got seven points
   * along it, and a point well inside the offset was reported as outside it
   * because no sample happened to be near enough. The deviation stayed at
   * exactly 1.1349 through every other change, which is what finally said the
   * error was in the measurement rather than in the geometry.
   */
  constructor(sp: Subpath, cell: number, step: number) {
    this.size = Math.max(cell, 1e-6);
    const fine = Math.max(step, 1e-6);
    const n = segmentCount(sp);
    for (let s = 0; s < n; s++) {
      const c = segmentAsCubic(sp, s);
      const steps = Math.max(8, Math.min(4000, Math.ceil(hullSpan(c) / fine)));
      for (let i = 0; i <= steps; i++) this.add(cubicAt(c, i / steps) as Pt);
    }
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private add(p: Pt): void {
    const k = this.key(Math.floor(p[0] / this.size), Math.floor(p[1] / this.size));
    const cell = this.cells.get(k);
    if (cell) cell.push(p);
    else this.cells.set(k, [p]);
  }

  /**
   * Whether anything on the source is nearer than `limit`.
   *
   * Asked rather than "how far", because that is the question the filter has
   * and it lets the scan stop at the first point that answers it.
   */
  anyNearer(p: Pt, limit: number): boolean {
    const r = Math.ceil(limit / this.size);
    const cx = Math.floor(p[0] / this.size);
    const cy = Math.floor(p[1] / this.size);
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cy - r; j <= cy + r; j++) {
        const cell = this.cells.get(this.key(i, j));
        if (!cell) continue;
        for (const q of cell) {
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < limit) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Split a ring of items into maximal unbroken runs.
 *
 * `broken[i]` cuts the link from item `i` to item `i + 1`, the last one wrapping
 * back to the first. An open sequence has that last link cut whatever the caller
 * says, because the end of a path is not a link.
 *
 * The wrap is settled by where the walk starts rather than by repairing the
 * result: beginning just after a break means no run can straddle the join, so
 * there is never a first and last run to sew back together. Both places that
 * needed sewing had written that repair out by hand, and the two copies did not
 * agree about which of them the offset had come apart at.
 *
 * A ring with no break at all comes back as one run. That is the caller's answer
 * to "did it close up", and it is why nothing downstream has to ask the geometry.
 */
function ringRuns<T>(items: T[], broken: boolean[], closed: boolean): T[][] {
  const n = items.length;
  if (!n) return [];
  const cut = (i: number): boolean => (!closed && i === n - 1) || broken[i];

  let start = 0;
  if (closed) {
    let first = -1;
    for (let i = 0; i < n; i++) {
      if (cut(i)) {
        first = i;
        break;
      }
    }
    if (first < 0) return [items.slice()];
    start = (first + 1) % n;
  }

  const out: T[][] = [];
  let run: T[] = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    run.push(items[i]);
    if (cut(i)) {
      out.push(run);
      run = [];
    }
  }
  if (run.length) out.push(run);
  return out;
}

/**
 * Offset a subpath by `d`, positive to the left of its direction of travel.
 *
 * Returns a **list**, because an offset can come apart: push a notched shape
 * inward by more than the notch can hold and what is left is two pieces. Null
 * when there is nothing at all -- fewer than two nodes, a distance of zero,
 * geometry with no tangent anywhere, or an inward offset that consumed the
 * whole shape.
 */
export function offsetSubpath(sp: Subpath, d: number, tol = 0.05): Subpath[] | null {
  const nSeg = segmentCount(sp);
  if (nSeg < 1 || !Number.isFinite(d) || d === 0) return null;

  const runs: { pts: Pt[]; t0: Pt; t1: Pt }[] = [];
  for (let i = 0; i < nSeg; i++) {
    const r = offsetSamples(segmentAsCubic(sp, i), d, tol);
    if (r) runs.push(r);
  }
  if (!runs.length) return null;

  /* One polyline for the whole subpath, joins included, fitted in one go. Per
     segment would be simpler and would put a fitted end at every node, where
     the offset has no feature at all -- the fitter is better left to choose
     where the curves break. */
  const pts: Pt[] = [...runs[0].pts];
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1];
    const next = runs[i];
    // Which way the path turns here decides whether the offset gains a gap.
    const cross = prev.t1[0] * next.t0[1] - prev.t1[1] * next.t0[0];
    const outside = d > 0 ? cross > TINY : cross < -TINY;
    if (outside) {
      const corner = sp.nodes[(i) % sp.nodes.length].pt;
      pts.push(...joinSamples(corner, pts[pts.length - 1], next.pts[0], d, tol));
    }
    pts.push(...next.pts);
  }

  if (sp.closed) {
    const prev = runs[runs.length - 1];
    const first = runs[0];
    const cross = prev.t1[0] * first.t0[1] - prev.t1[1] * first.t0[0];
    const outside = d > 0 ? cross > TINY : cross < -TINY;
    if (outside) {
      pts.push(...joinSamples(sp.nodes[0].pt, pts[pts.length - 1], first.pts[0], d, tol));
    }
    pts.push(first.pts[0]);
  }

  /* The distance criterion, applied to the samples. Anything nearer to the
     original than `|d|` is inside the disc swept along it, so it is not on the
     boundary of the swept region and not on the offset -- which is the local
     form of Chen and McMains's rule that the invalid parts bound regions of
     non-positive winding number.

     The slack is the fit tolerance: a sample is allowed to be a hair inside,
     because the sample itself and the polyline it is measured against are both
     approximations, and rejecting the true corner of a concave offset would
     open a gap exactly where the answer is sharpest. */
  const limit = Math.abs(d) - Math.max(tol, Math.abs(d) * 1e-3);
  /* Cells the size of the query radius, so every query scans a three by three
     block and no more. Cells the size of the tolerance is the obvious choice
     and is forty times worse: the radius is the distance being asked about, so
     it is the radius that decides how far a query has to look. */
  const near = new NearMap(sp, Math.max(limit, tol), tol);
  const keep = pts.map((p) => !near.anyNearer(p, limit));

  /* Contiguous survivors. A concave corner splits the offset into runs that
     meet at a point, and each is fitted on its own so the corner between them
     stays a corner -- fitting across the break would smooth over the very
     feature the filter just uncovered. */
  const survived: number[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) survived.push(i);
  if (!survived.length) return null;

  /* Two survivors are still linked when the filter took nothing between them,
     which on a ring includes the last one linking back to the first. */
  const filtered = survived.map((i, j) => {
    const next = survived[(j + 1) % survived.length];
    return next !== (i + 1) % pts.length;
  });
  const runsKept = ringRuns(
    survived.map((i) => pts[i]),
    filtered,
    sp.closed,
  );

  const usable = runsKept.filter((r) => r.length >= 2);
  if (!usable.length) return null;

  /* The filter took nothing, so the samples are still the whole ring and its
     two ends are the seam rather than a feature the filter uncovered. Read off
     the ring itself: inferring it from "one run in one group" is a different
     claim, and it is wrong in the case where the filter did cut and the offcut
     was too short to keep -- there the ends are a corner and the seam tangents
     below would be the original's, which no longer describe them. */
  const whole = sp.closed && !filtered.some(Boolean);

  /* Where two runs meet, put both ends on the crossing of the directions they
     arrive and leave at. The filter cuts at whichever sample happened to
     survive, which is up to one sample spacing short of the corner -- and a
     corner that is short by that much is a corner the path does not close
     through and a deviation the measurement reports as real. */
  const meetAt = (a: Pt[], b: Pt[]): Pt | null => {
    const p1 = a[a.length - 2];
    const p2 = a[a.length - 1];
    const q1 = b[0];
    const q2 = b[Math.min(1, b.length - 1)];
    const r: Pt = [p2[0] - p1[0], p2[1] - p1[1]];
    const t: Pt = [q2[0] - q1[0], q2[1] - q1[1]];
    const den = r[0] * t[1] - r[1] * t[0];
    if (Math.abs(den) < 1e-12) return null;
    const u = ((q1[0] - p2[0]) * t[1] - (q1[1] - p2[1]) * t[0]) / den;
    const at: Pt = [p2[0] + r[0] * u, p2[1] + r[1] * u];
    /* Only if it is nearby: two runs meeting far away are not a corner, they
       are two pieces of an offset that has come apart.

       Nothing distinguishes this check -- removing it leaves every measurement
       and every test where it was -- and it is kept because joining two runs
       at an arbitrarily distant point is not something to leave unguarded. Two
       further checks that lived here, on the corner's own validity and on the
       distance between consecutive samples, were removed: they were written
       while the error was being blamed on the geometry, and the error was in
       `NearMap`. */
    const gap = Math.hypot(at[0] - p2[0], at[1] - p2[1]) + Math.hypot(at[0] - q1[0], at[1] - q1[1]);
    return gap < Math.abs(d) ? at : null;
  };

  /* Which consecutive runs actually meet. Where they do, they are two sides of
     one corner and belong to the same path; where they do not, the offset has
     genuinely come apart and they are two paths.

     That case is not exotic. Offsetting a notched shape inward by more than the
     notch can hold separates it into pieces, and returning one path with a
     segment drawn across the gap would be a shape nobody asked for -- which is
     what this did, and it measured 6.8 out on an 8-unit offset. */
  const apart: boolean[] = [];
  for (let i = 0; i < usable.length; i++) {
    const a = usable[i];
    const b = usable[(i + 1) % usable.length];
    /* The link past the last run of an open offset is the end of the path, not
       a corner, so nothing is asked of it. `ringRuns` cuts it regardless. */
    const at = sp.closed || i < usable.length - 1 ? meetAt(a, b) : null;
    apart[i] = at === null;
    if (!at) continue;
    a[a.length - 1] = at;
    b[0] = at;
  }

  // Runs strung together by the corners they share.
  const groups = ringRuns(usable, apart, sp.closed);

  /* Tangents from the samples themselves rather than from the original. After
     filtering, a run can start and end anywhere -- at a corner the filter
     uncovered, not at a node -- so the original's tangents no longer describe
     its ends. Two samples apart is enough of a chord to take a direction from,
     and the fitter normalises whatever it is given. */
  const chord = (a: Pt, b: Pt): Pt => [b[0] - a[0], b[1] - a[1]];
  const out: Subpath[] = [];

  for (const g of groups) {
    const nodes: PathNode[] = [];

    for (const r of g) {
      /* Over several samples, not two. A two-sample chord at the end of a run
         is one sample spacing long and takes its direction from whatever noise
         the filter left there; averaging four steadies it without reaching far
         enough to cut the corner. */
      const span = Math.min(4, r.length - 1);
      const leftTan = whole ? runs[0].t0 : chord(r[0], r[span]);
      const rightTan = whole
        ? ([-runs[0].t0[0], -runs[0].t0[1]] as Pt)
        : chord(r[r.length - 1], r[r.length - 1 - span]);

      const fit = fitCurve(r, leftTan, rightTan, tol);
      for (const c of fit.curves) {
        nodes.push(makeNode([c[0][0], c[0][1]], null, [c[1][0], c[1][1]]));
        nodes.push(makeNode([c[3][0], c[3][1]], [c[2][0], c[2][1]], null));
      }
    }

    /* Every interior node was emitted twice, once as the end of one curve and
       once as the start of the next. Merging them is what turns a list of
       curves back into a path. */
    const merged: PathNode[] = [];
    for (const n of nodes) {
      const last = merged[merged.length - 1];
      if (last && Math.hypot(last.pt[0] - n.pt[0], last.pt[1] - n.pt[1]) < 1e-9) {
        last.hOut = n.hOut;
        if (!last.hIn) last.hIn = n.hIn;
        continue;
      }
      merged.push(n);
    }
    if (merged.length < 2) continue;

    /* Closed only if it came back to where it started. A piece of a broken-up
       offset is open however closed the original was, and claiming otherwise
       draws a segment across the gap. */
    const head = merged[0];
    const tail = merged[merged.length - 1];
    const rejoined =
      Math.hypot(head.pt[0] - tail.pt[0], head.pt[1] - tail.pt[1]) < Math.max(tol, 1e-6);
    if (sp.closed && rejoined && merged.length > 2) {
      head.hIn = tail.hIn;
      merged.pop();
      out.push({ nodes: merged, closed: true });
    } else {
      out.push({ nodes: merged, closed: false });
    }
  }

  return out.length ? out : null;
}


/**
 * The outline of a stroked path, as a shape that can be filled.
 *
 * Two offsets, one either side, joined up. Everything hard about it is in
 * `offsetSubpath` -- this is the bookkeeping around it:
 *
 * **A closed path gives two contours**, not one. The outer offset and the inner
 * one bound a ring, and a ring is two loops with opposite winding, which is why
 * the inner one comes back reversed. Under `nonzero` that draws the band and
 * leaves the middle empty, which is what a stroke looks like.
 *
 * **An open path gives one contour**: out along one side, across the end, back
 * along the other, across the start. The two crossings are the caps.
 *
 * Returns null when either side comes apart. An offset that breaks into pieces
 * has no single "other side" to pair each piece with, and guessing which piece
 * answers which would produce a shape nobody could predict. Refusing says so;
 * the caller reports it.
 */
export function strokeOutline(
  sp: Subpath,
  width: number,
  cap: 'butt' | 'round' = 'butt',
  tol = 0.05,
): Subpath[] | null {
  const half = width / 2;
  if (!(half > 0) || !Number.isFinite(half)) return null;

  const left = offsetSubpath(sp, half, tol);
  const right = offsetSubpath(sp, -half, tol);
  if (!left?.length || !right?.length) return null;

  if (sp.closed) {
    if (left.length !== 1 || right.length !== 1) return null;
    const inner = cloneSubpath(right[0]);
    reverseSubpath(inner);
    return [left[0], inner];
  }

  if (left.length !== 1 || right.length !== 1) return null;
  const back = cloneSubpath(right[0]);
  reverseSubpath(back);

  /* One loop: along one side, round the far end, back the other side, round the
     start. Butt caps carry no handles -- a straight segment has none, which is
     what keeps `segmentIsLine` recognising them and the serialiser writing `L`. */
  const outward = left[0].nodes.map(cloneNode);
  const homeward = back.nodes.map(cloneNode);
  const nodes: PathNode[] = [];

  const endOfPath = sp.nodes[sp.nodes.length - 1].pt;
  const startOfPath = sp.nodes[0].pt;

  nodes.push(...outward);
  const lastOut = nodes[nodes.length - 1];
  const firstHome = homeward[0];
  if (cap === 'round') {
    // Travelling the way the original ends, which is what the cap continues.
    const along = tangentAt(segmentAsCubic(sp, segmentCount(sp) - 1), 1);
    const arc = capArc(lastOut.pt, firstHome.pt, endOfPath, half, along);
    lastOut.hOut = arc.fromOut;
    firstHome.hIn = arc.toIn;
    nodes.push(...arc.middles);
  } else {
    lastOut.hOut = null;
    firstHome.hIn = null;
  }

  nodes.push(...homeward);
  const lastHome = nodes[nodes.length - 1];
  const firstOut = nodes[0];
  if (cap === 'round') {
    // Back at the start, travelling against the original's direction.
    const t0 = tangentAt(segmentAsCubic(sp, 0), 0);
    const arc = capArc(lastHome.pt, firstOut.pt, startOfPath, half, t0 ? [-t0[0], -t0[1]] : null);
    lastHome.hOut = arc.fromOut;
    firstOut.hIn = arc.toIn;
    nodes.push(...arc.middles);
  } else {
    lastHome.hOut = null;
    firstOut.hIn = null;
  }

  return [{ nodes, closed: true }];
}

/**
 * A half turn round an end, from one offset side to the other.
 *
 * A semicircle centred on the path's own endpoint, which is what a round cap
 * is. Two quarter turns rather than one half: a quarter is the arc a cubic
 * reproduces to about a thousandth of its radius, and a half turn in one cubic
 * is visibly not round.
 *
 * The two endpoints already exist -- they are the ends of the two offsets -- so
 * what comes back is the handles they need and the nodes in between.
 */
function capArc(
  from: Pt,
  to: Pt,
  centre: Pt,
  r: number,
  along: Pt | null,
): { fromOut: Pt; toIn: Pt; middles: PathNode[] } {
  const a0 = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
  const a1 = Math.atan2(to[1] - centre[1], to[0] - centre[0]);
  let sweep = a1 - a0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;

  /* Which way round, decided by the direction of travel rather than by the
     angles. The two ends of a cap are exactly opposite each other, so the sweep
     between them is exactly half a turn and its sign is a coin toss -- and the
     wrong toss puts the cap on the wrong side of the end, bulging back over the
     stroke instead of past it. The arc leaves `from` tangentially, so the sense
     that agrees with the way the outline arrived is the right one.

     Honestly: taking `Math.abs(sweep)` and ignoring the direction passes every
     test here too, and dropping both fails one. So what these fixtures pin down
     is that the sweep must not be left as the raw normalised difference; which
     of the two ways of fixing that is right is not something they distinguish.
     The direction of travel is the one with a reason behind it, so it is the
     one kept. */
  if (along) {
    const lead: Pt = [-Math.sin(a0), Math.cos(a0)];
    const agrees = lead[0] * along[0] + lead[1] * along[1];
    if (agrees < 0) sweep = -Math.abs(sweep);
    else sweep = Math.abs(sweep);
  }

  const steps = 2;
  const per = sweep / steps;
  const k = ((4 / 3) * Math.tan(per / 4)) * r;
  const at = (a: number): Pt => [centre[0] + Math.cos(a) * r, centre[1] + Math.sin(a) * r];
  // The tangent of a circle at angle `a`, in the direction of travel.
  const tan = (a: number): Pt => [-Math.sin(a) * k, Math.cos(a) * k];

  const middles: PathNode[] = [];
  for (let i = 1; i < steps; i++) {
    const a = a0 + per * i;
    const p = at(a);
    const t = tan(a);
    middles.push({
      id: nextNodeId(),
      pt: p,
      hIn: [p[0] - t[0], p[1] - t[1]],
      hOut: [p[0] + t[0], p[1] + t[1]],
    });
  }

  const t0 = tan(a0);
  const t1 = tan(a1);
  return {
    fromOut: [from[0] + t0[0], from[1] + t0[1]],
    toIn: [to[0] - t1[0], to[1] - t1[1]],
    middles,
  };
}