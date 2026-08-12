/**
 * Where two cubics cross.
 *
 * By recursive subdivision on the control hulls, not algebraically. A cubic
 * against a cubic is a degree-9 polynomial system, and the closed forms for it
 * are famously unstable near tangency -- which is exactly the case that matters
 * here, because two curves that nearly touch are two curves someone is trying
 * to snap to. Subdivision has no such cliff: a Bézier lies inside the box of
 * its control points, so two boxes that do not overlap contain no crossing, and
 * halving until the boxes are smaller than the tolerance converges on every
 * crossing at the same rate whatever the angle between them.
 *
 * The cost is that a tangency reports a small cluster rather than one point,
 * which is why the results are merged at the end.
 */

import type { Cubic, Pt } from './types';

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const hull = (c: Cubic): Box => ({
  x0: Math.min(c[0][0], c[1][0], c[2][0], c[3][0]),
  y0: Math.min(c[0][1], c[1][1], c[2][1], c[3][1]),
  x1: Math.max(c[0][0], c[1][0], c[2][0], c[3][0]),
  y1: Math.max(c[0][1], c[1][1], c[2][1], c[3][1]),
});

const apart = (a: Box, b: Box, slack: number): boolean =>
  a.x1 + slack < b.x0 || b.x1 + slack < a.x0 || a.y1 + slack < b.y0 || b.y1 + slack < a.y0;

const span = (b: Box): number => Math.max(b.x1 - b.x0, b.y1 - b.y0);

const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** de Casteljau at the halfway point, which is all the subdivision needed. */
function halve(c: Cubic): [Cubic, Cubic] {
  const p01 = mid(c[0], c[1]);
  const p12 = mid(c[1], c[2]);
  const p23 = mid(c[2], c[3]);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p = mid(p012, p123);
  return [
    [c[0], p01, p012, p],
    [p, p123, p23, c[3]],
  ];
}

/**
 * Every crossing of two cubics, to within `tol`.
 *
 * Bounded by a work budget rather than by depth. Depth alone is the obvious
 * choice and it is the wrong one: each level halves *one* of the two curves, so
 * a depth of 24 only gets each of them twelve halvings, which on a ten-unit
 * curve stops at 0.0024 -- twenty times coarser than the default tolerance,
 * and it stopped there silently while reporting four points instead of one.
 *
 * The budget is what makes a large depth safe. Two curves lying on top of each
 * other overlap at every subdivision and would branch exponentially; counting
 * calls bounds that whatever the geometry does, and the clustering it produces
 * is merged at the end anyway.
 */
export function cubicIntersections(a: Cubic, b: Cubic, tol = 1e-4, budget = 4000): Pt[] {
  const out: Pt[] = [];
  let left = budget;

  const rec = (u: Cubic, v: Cubic): void => {
    if (left-- <= 0) return;
    const bu = hull(u);
    const bv = hull(v);
    if (apart(bu, bv, 0)) return;
    if (span(bu) <= tol && span(bv) <= tol) {
      // The overlap of the two boxes is where the crossing is; its centre is
      // the best single answer either curve can give at this resolution.
      out.push([
        (Math.max(bu.x0, bv.x0) + Math.min(bu.x1, bv.x1)) / 2,
        (Math.max(bu.y0, bv.y0) + Math.min(bu.y1, bv.y1)) / 2,
      ]);
      return;
    }
    /* Halve whichever is bigger. Halving both every level is the obvious
       version and does four times the work per level for the same convergence,
       since the smaller curve was already fine enough. */
    if (span(bu) >= span(bv)) {
      const [u0, u1] = halve(u);
      rec(u0, v);
      rec(u1, v);
    } else {
      const [v0, v1] = halve(v);
      rec(u, v0);
      rec(u, v1);
    }
  };

  rec(a, b);
  return merge(out, tol * 4);
}

/**
 * Collapse a cluster of hits into one point each.
 *
 * A clean crossing produces one box; a tangency produces a run of them, and two
 * curves that overlap along a stretch produce a great many. Reporting each as a
 * separate snap target would be honest about the arithmetic and useless as an
 * answer.
 */
function merge(pts: Pt[], within: number): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const near = out.find((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= within);
    if (!near) out.push(p);
  }
  return out;
}

/** Whether a point is within `d` of a curve's control hull. Cheap rejection. */
export function hullNear(c: Cubic, p: Pt, d: number): boolean {
  const b = hull(c);
  return p[0] >= b.x0 - d && p[0] <= b.x1 + d && p[1] >= b.y0 - d && p[1] <= b.y1 + d;
}
