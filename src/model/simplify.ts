/**
 * Fewer nodes, same drawing.
 *
 * `core/fit.ts` fits cubics through a run of points and knows nothing about
 * paths. This file decides which runs to fit, which is where the judgement is:
 *
 *  - **Corners survive** and end one run and start the next.
 *  - **Every surviving node keeps its tangents**, taken from the original
 *    geometry, so neither a corner's sharpness nor a smooth join is something
 *    the fit gets to choose.
 *  - **A closed path with no corners is cut at node 0** and fitted as one run.
 *    One that has corners is cut at those, and node 0 is not special.
 *  - **Sampling is ten times finer than the tolerance**, so the fit limits the
 *    answer rather than the measurement does. §19.
 */

import { cubicAt, cubicDerivAt, splitCubic } from '../core/bezier';
import { fitCurve } from '../core/fit';
import { clonePt, nextNodeId, segmentAsCubic, segmentCount } from '../core/types';
import type { Cubic, PathNode, Pt, Subpath } from '../core/types';

export interface SimplifyResult {
  before: number;
  after: number;
  /** Largest measured distance between a sampled point and the new outline. */
  error: number;
}

/**
 * Turn angle above which a node is treated as a corner and kept.
 *
 * Fifty degrees keeps the points of a star and the corners of a traced letter,
 * and lets the thousand two-degree wobbles of a hand-drawn curve go. There is no
 * threshold that is right for every drawing; this one errs towards keeping
 * detail, since a corner wrongly kept is a node you can delete and a corner
 * wrongly smoothed is a shape you have to redraw.
 */
const CORNER_ANGLE = (50 * Math.PI) / 180;

/** Sampling error as a fraction of the fitting tolerance. */
const SAMPLE_RATIO = 0.1;

/**
 * Longest gap between samples, as a multiple of the tolerance.
 *
 * Flatness alone is not enough: the tolerance is only checked where a sample
 * sits, so a flat input sampled at its two ends lets the fit bow out between
 * them. A 100-unit run at tolerance 1 costs 50 points. §19.
 */
const SAMPLE_SPACING = 2;

/** How far a fitted curve may sit from its own chord and still be called a line. */
const LINE_RATIO = 0.05;

/**
 * A cubic never strays further from its chord than three quarters of the
 * furthest its control points do. Standard, and exact enough to report with.
 */
const FLATNESS_BOUND = 0.75;

/** Subdivisions before flattening gives up. 2^10 points is far past any need. */
const MAX_FLATTEN_DEPTH = 10;

/**
 * Rebuild `sp` with fewer nodes, or return `null` if it cannot do better.
 *
 * Mutates on success only, so a caller can run it over a selection and know
 * that a `null` left that subpath untouched.
 */
export function simplifySubpath(sp: Subpath, tol: number): SimplifyResult | null {
  const n = sp.nodes.length;
  if (n < 3 || segmentCount(sp) < 2 || !(tol > 0)) return null;

  /* The tolerance is a budget, not a target for the fit alone. Three things
     move the outline: the sampling, which is up to `SAMPLE_RATIO` of it from the
     true curve; the fit itself; and straightening a nearly-flat result, bounded
     by `FLATNESS_BOUND * LINE_RATIO`. Handing the whole tolerance to the fitter
     and adding the other two afterwards is how a simplify at 0.2 ended up 0.217
     away, which is exactly the overshoot the sampling cap was added to stop. */
  const budget = tol * (1 - SAMPLE_RATIO - FLATNESS_BOUND * LINE_RATIO);
  const breaks = breakpoints(sp);
  const curves: Cubic[] = [];
  let error = 0;

  for (let b = 0; b < breaks.length - 1; b++) {
    const from = breaks[b];
    const to = breaks[b + 1];
    const pts = samplePoints(sp, from, to, tol * SAMPLE_RATIO, tol * SAMPLE_SPACING);
    if (pts.length < 2) return null;

    const fit = fitCurve(pts, outTangent(sp, from), backTangent(sp, to), budget);
    if (!fit.curves.length) return null;
    curves.push(...fit.curves);
    error = Math.max(error, fit.error);
  }

  const after = sp.closed ? curves.length : curves.length + 1;
  // Equal is not better: rebuilding a path into the same number of nodes only
  // trades the geometry someone drew for the geometry a fit guessed.
  if (after >= n || after < 2) return null;

  // A fitted curve that is very nearly straight is worth storing as a line: it
  // is what the exported path should say, and it makes the node a real corner
  // rather than one with two invisible handles. Straightening moves the outline,
  // so the amount it moves is added to what gets reported.
  const lineEps = tol * LINE_RATIO;
  let straighten = 0;
  const line = curves.map((c) => {
    const reach = lineReach(c);
    if (reach === null || reach > lineEps) return false;
    // Added, not maxed. Straightening moves the same curve the fit already
    // moved, so the two displacements stack rather than compete.
    straighten = Math.max(straighten, FLATNESS_BOUND * reach);
    return true;
  });

  /* The fit is measured against the sampled polyline, and the polyline is
     itself up to `tol * SAMPLE_RATIO` from the true outline. Reporting only the
     fit error understated the real deviation by that much, while the header of
     this file promises to stay "within a stated distance of the original". */
  const reported = error + tol * SAMPLE_RATIO + straighten;

  /* Refused rather than applied when even the budget could not be met, which
     `fitCurve` reports by giving up at its recursion cap on a dense, heavily
     oscillating run. Applying it anyway rewrote the path further than the number
     the user typed, and only the status line said so afterwards. */
  if (reported > tol) return null;

  sp.nodes = nodesFrom(curves, sp.closed, line);
  return { before: n, after, error: reported };
}

/**
 * How far a curve's controls sit off its own chord, or `null` if calling it a
 * line would be wrong however small that distance is.
 *
 * The projection test is the `null` case: a control point can sit exactly on
 * the chord's line but beyond its end, which draws a curve that overshoots and
 * comes back. That is not a line at any tolerance.
 */
function lineReach(b: Cubic): number | null {
  const dx = b[3][0] - b[0][0];
  const dy = b[3][1] - b[0][1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return null;

  let reach = 0;
  for (const c of [b[1], b[2]]) {
    const vx = c[0] - b[0][0];
    const vy = c[1] - b[0][1];
    const along = (vx * dx + vy * dy) / (len * len);
    if (along < 0 || along > 1) return null;
    reach = Math.max(reach, Math.abs(vx * dy - vy * dx) / len);
  }
  return reach;
}

/**
 * The nodes that must survive, in path order.
 *
 * An open path is cut at both ends and at every corner. A closed one is cut at
 * every corner, or at node 0 if it has none, and the list wraps back to where it
 * started so the final run closes the loop.
 */
function breakpoints(sp: Subpath): number[] {
  const n = sp.nodes.length;
  const corners: number[] = [];
  const first = sp.closed ? 0 : 1;
  const stop = sp.closed ? n : n - 1;
  for (let i = first; i < stop; i++) if (isCorner(sp, i)) corners.push(i);

  if (!sp.closed) return [0, ...corners, n - 1];
  if (!corners.length) return [0, 0];
  return [...corners, corners[0]];
}

/** True when the path changes direction sharply enough at `i` to be a feature. */
function isCorner(sp: Subpath, i: number): boolean {
  const arrive = inTangent(sp, i);
  const leave = outTangent(sp, i);
  const la = Math.hypot(arrive[0], arrive[1]);
  const lb = Math.hypot(leave[0], leave[1]);
  if (la < 1e-12 || lb < 1e-12) return true;
  const cos = (arrive[0] * leave[0] + arrive[1] * leave[1]) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, cos))) > CORNER_ANGLE;
}

/** Index of the segment leaving node `i`, or `null` at the end of an open path. */
function segAfter(sp: Subpath, i: number): number | null {
  if (sp.closed) return i % sp.nodes.length;
  return i < sp.nodes.length - 1 ? i : null;
}

function segBefore(sp: Subpath, i: number): number | null {
  if (sp.closed) return (i - 1 + sp.nodes.length) % sp.nodes.length;
  return i > 0 ? i - 1 : null;
}

/** Direction the path leaves node `i` in. */
function outTangent(sp: Subpath, i: number): Pt {
  const seg = segAfter(sp, i);
  if (seg === null) return [0, 0];
  return endTangent(segmentAsCubic(sp, seg), true);
}

/** Direction the path arrives at node `i` in, pointing forwards along it. */
function inTangent(sp: Subpath, i: number): Pt {
  const seg = segBefore(sp, i);
  if (seg === null) return [0, 0];
  return endTangent(segmentAsCubic(sp, seg), false);
}

/** The same direction, reversed: what the fitter wants at the end of a run. */
function backTangent(sp: Subpath, i: number): Pt {
  const t = inTangent(sp, i);
  return [-t[0], -t[1]];
}

/**
 * Tangent at one end of a cubic.
 *
 * The derivative vanishes when a handle sits exactly on its anchor, which
 * imported data does often enough to matter. Sampling just inside the curve
 * recovers the direction; a segment with no direction at all falls back to its
 * chord.
 */
function endTangent(b: Cubic, atStart: boolean): Pt {
  const raw = cubicDerivAt(b, atStart ? 0 : 1);
  if (Math.hypot(raw[0], raw[1]) > 1e-12) return raw;

  const probe = cubicAt(b, atStart ? 0.05 : 0.95);
  const anchor = atStart ? b[0] : b[3];
  const near: Pt = atStart
    ? [probe[0] - anchor[0], probe[1] - anchor[1]]
    : [anchor[0] - probe[0], anchor[1] - probe[1]];
  if (Math.hypot(near[0], near[1]) > 1e-12) return near;
  return [b[3][0] - b[0][0], b[3][1] - b[0][1]];
}

/** Flatten the run from node `from` to node `to` into points, `from` included. */
function samplePoints(sp: Subpath, from: number, to: number, eps: number, span: number): Pt[] {
  const out: Pt[] = [clonePt(sp.nodes[from].pt)];
  const total = segmentCount(sp);
  let seg = segAfter(sp, from);
  for (let guard = 0; guard <= total && seg !== null; guard++) {
    flatten(segmentAsCubic(sp, seg), eps, span, out, 0);
    const end = (seg + 1) % sp.nodes.length;
    if (end === to) break;
    seg = segAfter(sp, end);
  }
  return out;
}

/**
 * Subdivide until the curve is within `eps` of its chord and no longer than
 * `span`, pushing the end of each piece.
 */
function flatten(b: Cubic, eps: number, span: number, out: Pt[], depth: number): void {
  const long = Math.hypot(b[3][0] - b[0][0], b[3][1] - b[0][1]) > span;
  if (depth >= MAX_FLATTEN_DEPTH || (!long && flatEnough(b, eps))) {
    out.push(clonePt(b[3]));
    return;
  }
  const [left, right] = splitCubic(b, 0.5);
  flatten(left, eps, span, out, depth + 1);
  flatten(right, eps, span, out, depth + 1);
}

/**
 * Close enough to its chord to stop subdividing.
 *
 * Perpendicular distance is not sufficient on its own: a control point can sit
 * on the chord's line but past its end, which draws a curve that runs out and
 * doubles back. The projection test catches that, and without it a sampled
 * hook would silently flatten into a straight line.
 */
function flatEnough(b: Cubic, eps: number): boolean {
  const dx = b[3][0] - b[0][0];
  const dy = b[3][1] - b[0][1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) {
    return (
      Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) <= eps &&
      Math.hypot(b[2][0] - b[0][0], b[2][1] - b[0][1]) <= eps
    );
  }
  for (const c of [b[1], b[2]]) {
    const vx = c[0] - b[0][0];
    const vy = c[1] - b[0][1];
    if (Math.abs(vx * dy - vy * dx) / len > eps) return false;
    const along = (vx * dx + vy * dy) / (len * len);
    if (along < -0.01 || along > 1.01) return false;
  }
  return true;
}

/**
 * Turn a chain of fitted curves back into nodes.
 *
 * The curves already meet exactly -- each one starts at the point the last
 * ended -- so a node is just the join between two of them, and its handles are
 * the two control points either side. A curve that came out straight gives up
 * both of its handles, which is what keeps `L` in the exported path instead of
 * a curve that happens to be flat.
 */
function nodesFrom(curves: Cubic[], closed: boolean, line: boolean[]): PathNode[] {
  const count = closed ? curves.length : curves.length + 1;
  const nodes: PathNode[] = [];

  for (let i = 0; i < count; i++) {
    const out = i < curves.length ? i : null;
    const inc = i > 0 ? i - 1 : closed ? curves.length - 1 : null;
    nodes.push({
      id: nextNodeId(),
      pt: out !== null ? clonePt(curves[out][0]) : clonePt(curves[curves.length - 1][3]),
      hIn: inc === null || line[inc] ? null : clonePt(curves[inc][2]),
      hOut: out === null || line[out] ? null : clonePt(curves[out][1]),
    });
  }
  return nodes;
}
