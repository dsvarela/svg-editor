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
 * **The loops a concave corner produces are left in.** Offsetting further than
 * the local radius of curvature sends the parallel curve past itself and back,
 * and every point of the resulting loop is the right distance from the original
 * -- so no measurement of distance can find it. Removing it is a topology
 * question, and two attempts are recorded in the shopping list under Stroke to
 * path, which needs the answer and cannot ship without it.
 */

import { cubicAt, cubicDerivAt } from './bezier';
import { fitCurve } from './fit';
import { makeNode, segmentAsCubic, segmentCount } from './types';
import type { Cubic, Pt, Subpath } from './types';

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
 * How many samples a segment gets.
 *
 * Off the control hull's size rather than the true arc length, which would cost
 * an integration to learn: the hull bounds the curve, so it never under-samples,
 * and over-sampling a nearly straight segment costs a few points the fitter
 * collapses anyway. `tol` steers it because a tighter fit needs more evidence.
 */
function sampleCount(c: Cubic, tol: number): number {
  let span = 0;
  for (let i = 1; i < 4; i++) span += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
  return Math.max(8, Math.min(200, Math.ceil(span / Math.max(tol, 1e-4))));
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
 * Offset a subpath by `d`, positive to the left of its direction of travel.
 *
 * Returns null when there is nothing to offset: a subpath of fewer than two
 * nodes, a distance of zero, or geometry so degenerate that no tangent can be
 * found anywhere along it.
 */
export function offsetSubpath(sp: Subpath, d: number, tol = 0.05): Subpath | null {
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

  /* The end tangents are the original's, exactly. That is the whole reason the
     fitter does well here: parallel curves share tangent directions, so the
     ends need no guessing and only the middle is solved. On a closed path the
     run has to leave at the angle it arrives, which is the first segment's
     tangent at both ends. */
  const leftTan = runs[0].t0;
  const rightTan: Pt = sp.closed
    ? [-runs[0].t0[0], -runs[0].t0[1]]
    : [-runs[runs.length - 1].t1[0], -runs[runs.length - 1].t1[1]];

  const fit = fitCurve(pts, leftTan, rightTan, tol);
  if (!fit.curves.length) return null;

  const nodes = fit.curves.map((c, i) =>
    makeNode([c[0][0], c[0][1]], i === 0 ? null : null, [c[1][0], c[1][1]]),
  );
  // Each fitted curve starts where the last ended, so one node per curve plus a
  // last node closes the run; the incoming handles come from the curve before.
  fit.curves.forEach((c, i) => {
    const next = nodes[i + 1];
    if (next) next.hIn = [c[2][0], c[2][1]];
  });
  const last = fit.curves[fit.curves.length - 1];
  if (sp.closed) {
    nodes[0].hIn = [last[2][0], last[2][1]];
  } else {
    nodes.push(makeNode([last[3][0], last[3][1]], [last[2][0], last[2][1]], null));
  }

  return { nodes, closed: sp.closed };
}

