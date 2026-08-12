/**
 * Fitting cubics through a run of points. Pure geometry, no model awareness.
 *
 * This is Schneider's algorithm from Graphics Gems (1990), the same one behind
 * Inkscape's simplify and paper.js's `Path.simplify`. It is worth knowing why a
 * least-squares fit is not enough on its own, because the two extra ideas are
 * where the quality comes from.
 *
 * Fitting one cubic to n points needs each point to be assigned a parameter
 * along the curve. Nobody knows those parameters up front, so the first guess
 * is chord length: a point a third of the way along the polyline is assumed to
 * be at t = 1/3. That is wrong wherever the curve's speed is uneven, and the
 * error it causes looks exactly like the curve being unfittable.
 *
 * So the fit runs twice over. First the least-squares solve, which is exact
 * given the parameters. Then, if the result is close but not close enough,
 * Newton's method walks each point's parameter towards the true nearest point
 * and the solve is repeated. Only when that stops helping is the run split at
 * its worst point and each half fitted on its own.
 *
 * Reparameterisation is skipped when the error is large, which is not an
 * optimisation. Newton's method converges towards a *local* nearest point, and
 * from far away that is as likely to be the wrong lobe of the curve as the
 * right one. Splitting is the honest answer there.
 */

import { cubicAt, cubicDerivAt, cubicSecondDerivAt } from './bezier';
import type { Cubic, Pt } from './types';

export interface Fit {
  curves: Cubic[];
  /**
   * The largest distance from any input point to the curves fitted through it.
   *
   * A real measurement of the result rather than the tolerance that was asked
   * for: a fit that had to give up on a split reports what it actually
   * achieved, which is the number worth showing a user.
   */
  error: number;
}

/**
 * Recursion cap.
 *
 * Reachable, despite an earlier comment here claiming otherwise: a densely
 * sampled stroke with twenty oscillations reaches depth 24 and takes the cap.
 * When it does, the last fit is accepted as-is and `Fit.error` reports what that
 * actually achieved, which is how the caller learns the tolerance was not met.
 */
const MAX_DEPTH = 24;

/** Newton passes before giving up and splitting. Four is Schneider's number. */
const MAX_ITERATIONS = 4;

/**
 * How far past the tolerance a fit can be and still be worth reparameterising,
 * as a multiple of it. Schneider used the tolerance squared, which only reads
 * as a multiplier because his distances were squared too.
 */
const ITERATION_SLACK = 4;

const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const dot = (a: Pt, b: Pt): number => a[0] * b[0] + a[1] * b[1];

function unit(v: Pt): Pt {
  const len = Math.hypot(v[0], v[1]);
  return len < 1e-12 ? [0, 0] : [v[0] / len, v[1] / len];
}

/**
 * Fit a chain of cubics through `points`.
 *
 * `leftTan` points forward from the first point, `rightTan` backward from the
 * last. They are inputs rather than something the fitter chooses, because the
 * caller knows things this file cannot: that the first point is a deliberate
 * corner, or that the run closes a loop and has to leave at the angle it
 * arrives. Both are normalised here, so callers can pass any non-zero vector.
 *
 * The returned curves are contiguous: each one starts where the last ended.
 */
export function fitCurve(points: Pt[], leftTan: Pt, rightTan: Pt, tol: number): Fit {
  // Repeated points give a chord length of zero between them, which would put
  // two parameters at the same place and make the solve singular.
  const pts: Pt[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || dist(last, p) > 1e-12) pts.push(p);
  }
  if (pts.length < 2) return { curves: [], error: 0 };

  const curves: Cubic[] = [];
  const error = fitInto(
    curves,
    pts,
    0,
    pts.length - 1,
    unit(leftTan),
    unit(rightTan),
    Math.max(tol, 1e-12),
    0,
  );
  return { curves, error };
}

function fitInto(
  out: Cubic[],
  pts: Pt[],
  first: number,
  last: number,
  tan1: Pt,
  tan2: Pt,
  tol: number,
  depth: number,
): number {
  // Two points cannot say anything about the curve between them, so the
  // handles get a third of the chord: the classic guess, and exactly what the
  // pen tool would have drawn.
  if (last - first === 1) {
    const d = dist(pts[first], pts[last]) / 3;
    out.push(bezierFrom(pts[first], pts[last], tan1, tan2, d, d));
    return 0;
  }

  let u = chordParams(pts, first, last);
  let bez = generateBezier(pts, first, last, u, tan1, tan2);
  let worst = maxError(pts, first, last, bez, u);
  if (worst.error <= tol) {
    out.push(bez);
    return worst.error;
  }

  if (worst.error <= tol * ITERATION_SLACK) {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      u = reparameterise(pts, first, last, u, bez);
      bez = generateBezier(pts, first, last, u, tan1, tan2);
      worst = maxError(pts, first, last, bez, u);
      if (worst.error <= tol) {
        out.push(bez);
        return worst.error;
      }
    }
  }

  /* `maxError` only ever nominates an interior point, so the index test below
     has never fired and cannot; it is kept as a belt against a future change to
     that function, not because a degenerate middle can reach it. The depth cap
     is the live half, and it is reachable: a stroke of nine hundred samples with
     twenty oscillations gets there. */
  if (depth >= MAX_DEPTH || worst.index <= first || worst.index >= last) {
    out.push(bez);
    return worst.error;
  }

  const centre = centreTangent(pts, worst.index);
  const left = fitInto(out, pts, first, worst.index, tan1, centre, tol, depth + 1);
  const right = fitInto(
    out,
    pts,
    worst.index,
    last,
    [-centre[0], -centre[1]],
    tan2,
    tol,
    depth + 1,
  );
  return Math.max(left, right);
}

const bezierFrom = (p0: Pt, p3: Pt, tan1: Pt, tan2: Pt, a1: number, a2: number): Cubic => [
  [p0[0], p0[1]],
  [p0[0] + tan1[0] * a1, p0[1] + tan1[1] * a1],
  [p3[0] + tan2[0] * a2, p3[1] + tan2[1] * a2],
  [p3[0], p3[1]],
];

/** First parameter guess: distance along the polyline, scaled to 0..1. */
function chordParams(pts: Pt[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(pts[i - 1], pts[i]));
  const total = u[u.length - 1];
  if (total <= 0) return u.map((_, i) => i / (u.length - 1));
  return u.map((v) => v / total);
}

/**
 * The least-squares solve.
 *
 * Both endpoints and both tangent directions are fixed, so the only unknowns
 * are how far along each tangent its control point sits. That reduces the fit
 * to two scalars and a 2x2 system, which is why this is fast enough to run
 * inside a Newton loop inside a recursion.
 */
function generateBezier(
  pts: Pt[],
  first: number,
  last: number,
  u: number[],
  tan1: Pt,
  tan2: Pt,
): Cubic {
  const p0 = pts[first];
  const p3 = pts[last];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;

  for (let i = 0; i <= last - first; i++) {
    const t = u[i];
    const m = 1 - t;
    const b0 = m * m * m;
    const b1 = 3 * t * m * m;
    const b2 = 3 * t * t * m;
    const b3 = t * t * t;

    const a1: Pt = [tan1[0] * b1, tan1[1] * b1];
    const a2: Pt = [tan2[0] * b2, tan2[1] * b2];
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);

    const p = pts[first + i];
    const rest: Pt = [
      p[0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3)),
      p[1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3)),
    ];
    x0 += dot(a1, rest);
    x1 += dot(a2, rest);
  }

  const det = c00 * c11 - c01 * c01;
  let a1 = 0;
  let a2 = 0;
  if (Math.abs(det) > 1e-12) {
    a1 = (c11 * x0 - c01 * x1) / det;
    a2 = (c00 * x1 - c01 * x0) / det;
  }

  // A negative or vanishing length means the solve wanted a control point
  // behind its own anchor, which draws a cusp rather than the curve the points
  // describe. Wu and Barsky's fallback is a third of the chord each way.
  /* A negative or vanishing length means the solve wanted a control point
     behind its own anchor, which draws a cusp rather than the curve the points
     describe. An enormous one is the same failure in the other direction: the
     least-squares system is near-singular and the answer runs away. Both fall
     back to Wu and Barsky's third of the chord.

     The upper bound matters most when the run closes a loop, where `p0` and
     `p3` are the same point: the chord is zero, so the lower bound is zero too
     and nothing catches a control point a thousand units out. */
  const chord = dist(p0, p3);
  const floor = chord * 1e-6;
  const ceiling = chord * 10;
  const runaway = !Number.isFinite(a1) || !Number.isFinite(a2) || a1 > ceiling || a2 > ceiling;
  if (a1 < floor || a2 < floor || runaway) {
    a1 = chord / 3;
    a2 = chord / 3;
  }
  return bezierFrom(p0, p3, tan1, tan2, a1, a2);
}

interface Worst {
  error: number;
  index: number;
}

/** The input point furthest from where the fitted curve says it should be. */
function maxError(pts: Pt[], first: number, last: number, bez: Cubic, u: number[]): Worst {
  let error = 0;
  let index = first + Math.floor((last - first) / 2);
  for (let i = 1; i < last - first; i++) {
    const d = dist(cubicAt(bez, u[i]), pts[first + i]);
    if (d >= error) {
      error = d;
      index = first + i;
    }
  }
  return { error, index };
}

/**
 * Move every parameter to the curve's nearest point, by Newton's method.
 *
 * The function being zeroed is the dot product of (curve point minus target)
 * with the tangent: it vanishes exactly where the offset is perpendicular to
 * the curve, which is the definition of nearest.
 */
function reparameterise(
  pts: Pt[],
  first: number,
  last: number,
  u: number[],
  bez: Cubic,
): number[] {
  const next: number[] = [];
  for (let i = 0; i <= last - first; i++) {
    const t = u[i];
    const p = pts[first + i];
    const q = cubicAt(bez, t);
    const d1 = cubicDerivAt(bez, t);
    const d2 = cubicSecondDerivAt(bez, t);
    const off: Pt = [q[0] - p[0], q[1] - p[1]];
    const num = dot(off, d1);
    const den = dot(d1, d1) + dot(off, d2);
    // A stationary or inflecting point gives no direction to step in. Leaving
    // the parameter alone costs one wasted iteration; stepping anyway can throw
    // it outside the curve entirely.
    /* Clamped to the curve. Newton is free to step outside [0, 1], and
       `cubicAt` happily extrapolates there, so an escaped parameter let
       `maxError` measure the distance to a point that is not on the curve being
       returned: a fit that missed by 18 units reported an error of 1e-12. */
    const step = Math.abs(den) < 1e-12 ? t : t - num / den;
    next.push(Math.min(1, Math.max(0, step)));
  }
  return next;
}

/**
 * Tangent at a split point, pointing back towards the start of the run.
 *
 * Averaging the two chords rather than taking either one keeps the two halves
 * meeting smoothly: the left half ends along this direction and the right half
 * leaves along its opposite, so the join is a straight line through the node.
 */
function centreTangent(pts: Pt[], i: number): Pt {
  const before: Pt = [pts[i - 1][0] - pts[i][0], pts[i - 1][1] - pts[i][1]];
  const after: Pt = [pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]];
  return unit([(before[0] + after[0]) / 2, (before[1] + after[1]) / 2]);
}
