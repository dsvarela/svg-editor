/**
 * Cubic bezier geometry. Pure functions, no model awareness, no DOM.
 *
 * Everything the editor draws or hit-tests reduces to these. Because the model
 * normalises every segment type to a cubic, this file is the *only* place that
 * needs to know curve maths -- there is no parallel implementation for arcs,
 * quadratics or lines.
 */

import type { Cubic, Pt } from './types';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Point on a cubic at parameter `t`. */
export function cubicAt(b: Cubic, t: number): Pt {
  const m = 1 - t;
  const a0 = m * m * m;
  const a1 = 3 * m * m * t;
  const a2 = 3 * m * t * t;
  const a3 = t * t * t;
  return [
    a0 * b[0][0] + a1 * b[1][0] + a2 * b[2][0] + a3 * b[3][0],
    a0 * b[0][1] + a1 * b[1][1] + a2 * b[2][1] + a3 * b[3][1],
  ];
}

/** First derivative (tangent vector, unnormalised) at `t`. */
export function cubicDerivAt(b: Cubic, t: number): Pt {
  const m = 1 - t;
  const k0 = 3 * m * m;
  const k1 = 6 * m * t;
  const k2 = 3 * t * t;
  return [
    k0 * (b[1][0] - b[0][0]) + k1 * (b[2][0] - b[1][0]) + k2 * (b[3][0] - b[2][0]),
    k0 * (b[1][1] - b[0][1]) + k1 * (b[2][1] - b[1][1]) + k2 * (b[3][1] - b[2][1]),
  ];
}

/**
 * Second derivative at `t`. Only the curve fitter needs it, to steer Newton's
 * method towards the parameter of the closest point.
 */
export function cubicSecondDerivAt(b: Cubic, t: number): Pt {
  const m = 1 - t;
  return [
    6 * (m * (b[2][0] - 2 * b[1][0] + b[0][0]) + t * (b[3][0] - 2 * b[2][0] + b[1][0])),
    6 * (m * (b[2][1] - 2 * b[1][1] + b[0][1]) + t * (b[3][1] - 2 * b[2][1] + b[1][1])),
  ];
}

/**
 * de Casteljau split at `t`. The two halves trace the original exactly, which
 * is what makes "add a point" a shape-preserving operation.
 */
export function splitCubic(b: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const p01 = lerp(b[0], b[1]);
  const p12 = lerp(b[1], b[2]);
  const p23 = lerp(b[2], b[3]);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);
  return [
    [[b[0][0], b[0][1]], p01, p012, mid],
    [[mid[0], mid[1]], p123, p23, [b[3][0], b[3][1]]],
  ];
}

/**
 * The cubic tracing `b` over the parameter range `[t0, t1]`, as its own cubic.
 *
 * Inside `[0, 1]` this is what `splitCubic` produces, by a different route.
 * Outside it the polynomial keeps going, and that continuation is the curve the
 * original was cut from: a cubic restricted to part of its range is the same
 * polynomial, so evaluating past the end reproduces the piece that was
 * discarded rather than guessing at one. That is what lets a trimmed side be
 * put back exactly, which is the whole of a corner's undo.
 *
 * Power basis rather than de Casteljau, because de Casteljau's interpolation
 * only reaches within the range it is given.
 */
export function cubicOver(b: Cubic, t0: number, t1: number): Cubic {
  const h = t1 - t0;
  const out: Pt[] = [];
  for (let axis = 0; axis < 2; axis++) {
    const p0 = b[0][axis];
    const p1 = b[1][axis];
    const p2 = b[2][axis];
    const p3 = b[3][axis];

    // C(t) = a0 + a1 t + a2 t^2 + a3 t^3.
    const a0 = p0;
    const a1 = 3 * (p1 - p0);
    const a2 = 3 * (p0 - 2 * p1 + p2);
    const a3 = -p0 + 3 * p1 - 3 * p2 + p3;

    // D(s) = C(t0 + h s), expanded in s.
    const c0 = a0 + a1 * t0 + a2 * t0 * t0 + a3 * t0 * t0 * t0;
    const c1 = h * (a1 + 2 * a2 * t0 + 3 * a3 * t0 * t0);
    const c2 = h * h * (a2 + 3 * a3 * t0);
    const c3 = h * h * h * a3;

    // Back to Bernstein.
    const q = [c0, c0 + c1 / 3, c0 + (2 * c1) / 3 + c2 / 3, c0 + c1 + c2 + c3];
    for (let k = 0; k < 4; k++) {
      if (axis === 0) out.push([q[k], 0]);
      else out[k][1] = q[k];
    }
  }
  return [out[0], out[1], out[2], out[3]];
}

/** A cubic traced backwards, so `t` runs from its end point to its start. */
export const reverseCubic = (b: Cubic): Cubic => [
  [b[3][0], b[3][1]],
  [b[2][0], b[2][1]],
  [b[1][0], b[1][1]],
  [b[0][0], b[0][1]],
];

/**
 * Unit tangent at `t`, or `null` where the curve has no direction at all.
 *
 * The derivative vanishes at an end whose control point sits on the anchor,
 * which is how the model stores a straight segment and how a hand-dragged
 * handle can be left. The limit direction there is the first control point that
 * differs from the anchor, so the fallbacks are the curve's own answer rather
 * than a substitute for it.
 */
export function cubicUnitTangent(b: Cubic, t: number): Pt | null {
  const candidates: Pt[] = [cubicDerivAt(b, t)];
  // Past a vanishing derivative the direction is set by the next control that
  // has moved, taken from whichever end `t` is at.
  if (t <= 0.5) candidates.push([b[2][0] - b[0][0], b[2][1] - b[0][1]], [b[3][0] - b[0][0], b[3][1] - b[0][1]]);
  else candidates.push([b[3][0] - b[1][0], b[3][1] - b[1][1]], [b[3][0] - b[0][0], b[3][1] - b[0][1]]);

  for (const d of candidates) {
    const len = Math.hypot(d[0], d[1]);
    if (len > 1e-12) return [d[0] / len, d[1] / len];
  }
  return null;
}

/**
 * Exact bounding box, via the roots of the derivative rather than by sampling.
 * Sampling would under-report the box on tight curves, which matters because
 * this drives the selection rectangle and "fit to view".
 */
export function cubicBBox(b: Cubic): Box {
  let x0 = Math.min(b[0][0], b[3][0]);
  let x1 = Math.max(b[0][0], b[3][0]);
  let y0 = Math.min(b[0][1], b[3][1]);
  let y1 = Math.max(b[0][1], b[3][1]);

  for (let axis = 0; axis < 2; axis++) {
    const p0 = b[0][axis];
    const p1 = b[1][axis];
    const p2 = b[2][axis];
    const p3 = b[3][axis];

    // B'(t)/3 = at^2 + bt + c
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const bb = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;

    const roots: number[] = [];
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(bb) > 1e-12) roots.push(-c / bb);
    } else {
      const disc = bb * bb - 4 * a * c;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        roots.push((-bb + sq) / (2 * a), (-bb - sq) / (2 * a));
      }
    }

    for (const t of roots) {
      if (t <= 0 || t >= 1) continue;
      const v = cubicAt(b, t)[axis];
      if (axis === 0) {
        if (v < x0) x0 = v;
        if (v > x1) x1 = v;
      } else {
        if (v < y0) y0 = v;
        if (v > y1) y1 = v;
      }
    }
  }
  return { x0, y0, x1, y1 };
}

export function unionBox(a: Box | null, b: Box): Box {
  if (!a) return { ...b };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export interface Projection {
  /** Parameter of the closest point found. */
  t: number;
  /** Distance from the query point. */
  d: number;
  /** The closest point itself. */
  pt: Pt;
}

/**
 * Closest point on a cubic to `p`.
 *
 * Coarse sample to find the basin, then bisect to refine. Sampling alone
 * quantises "click the outline to insert a node" to 1/24 of a segment, which
 * makes an inserted node visibly jump away from the cursor. The refinement pass
 * costs about 20 extra evaluations and removes that entirely.
 *
 * **The two ends are then answered exactly rather than approached.** A point
 * beyond the end of a segment has its nearest neighbour at `t = 0` or `t = 1`,
 * and a search that only ever narrows an interval arrives near the end without
 * reaching it: twenty thirds of 1/24 leaves the parameter about 6e-6 short,
 * which on a segment 40 units long is 2.5e-4 of position. Small, and wrong in
 * the one place the right answer is known in advance and free.
 */
export function projectToCubic(b: Cubic, p: Pt, coarse = 24, refine = 20): Projection {
  let bestT = 0;
  let bestD = Infinity;

  for (let i = 0; i <= coarse; i++) {
    const t = i / coarse;
    const q = cubicAt(b, t);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }

  let lo = Math.max(0, bestT - 1 / coarse);
  let hi = Math.min(1, bestT + 1 / coarse);
  for (let i = 0; i < refine; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const q1 = cubicAt(b, m1);
    const q2 = cubicAt(b, m2);
    const d1 = Math.hypot(q1[0] - p[0], q1[1] - p[1]);
    const d2 = Math.hypot(q2[0] - p[0], q2[1] - p[1]);
    if (d1 < d2) hi = m2;
    else lo = m1;
  }

  const at = (t: number): Projection => {
    const pt = cubicAt(b, t);
    return { t, d: Math.hypot(pt[0] - p[0], pt[1] - p[1]), pt };
  };
  let best = at((lo + hi) / 2);
  for (const end of [0, 1]) {
    const e = at(end);
    if (e.d < best.d) best = e;
  }
  return best;
}

/** Approximate arc length by flattening. Used for handle-length heuristics. */
export function cubicLength(b: Cubic, steps = 24): number {
  let len = 0;
  let prev = b[0];
  for (let i = 1; i <= steps; i++) {
    const q = cubicAt(b, i / steps);
    len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    prev = q;
  }
  return len;
}

/**
 * True when a cubic is geometrically a straight line within `eps`.
 *
 * Only used when importing foreign path data: an author who wrote a degenerate
 * `C` meant a line, and detecting that lets us store `hIn`/`hOut` as `null` and
 * re-emit a clean `L`. Internally the model already knows, so this is never
 * consulted during editing.
 */
export function cubicIsLine(b: Cubic, eps = 1e-9): boolean {
  const dx = b[3][0] - b[0][0];
  const dy = b[3][1] - b[0][1];
  const len = Math.hypot(dx, dy);

  if (len < eps) {
    // Degenerate span: a line only if the controls sit on the point too.
    return (
      Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1]) < eps &&
      Math.hypot(b[2][0] - b[0][0], b[2][1] - b[0][1]) < eps
    );
  }

  // Perpendicular distance of each control from the chord, plus a check that
  // neither control projects outside it (which would curve then double back).
  for (const c of [b[1], b[2]]) {
    const vx = c[0] - b[0][0];
    const vy = c[1] - b[0][1];
    const cross = Math.abs(vx * dy - vy * dx) / len;
    if (cross > eps) return false;
    const dot = (vx * dx + vy * dy) / (len * len);
    if (dot < -eps || dot > 1 + eps) return false;
  }
  return true;
}

/**
 * Exact quadratic -> cubic elevation.
 * c1 = p0 + 2/3 (q - p0), c2 = p2 + 2/3 (q - p2).
 */
export function quadToCubic(p0: Pt, q: Pt, p2: Pt): Cubic {
  return [
    [p0[0], p0[1]],
    [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
    [p2[0] + (2 / 3) * (q[0] - p2[0]), p2[1] + (2 / 3) * (q[1] - p2[1])],
    [p2[0], p2[1]],
  ];
}

/**
 * The inverse: recover a quadratic control point if this cubic is exactly a
 * degree-elevated quadratic, else `null`. Lets the serialiser emit `Q` (4
 * numbers) instead of `C` (6) without ever changing the rendered shape.
 */
export function cubicAsQuad(b: Cubic, eps = 1e-9): Pt | null {
  // From c1: q = p0 + 3/2 (c1 - p0). From c2: q = p3 + 3/2 (c2 - p3).
  const q1x = b[0][0] + 1.5 * (b[1][0] - b[0][0]);
  const q1y = b[0][1] + 1.5 * (b[1][1] - b[0][1]);
  const q2x = b[3][0] + 1.5 * (b[2][0] - b[3][0]);
  const q2y = b[3][1] + 1.5 * (b[2][1] - b[3][1]);
  if (Math.abs(q1x - q2x) > eps || Math.abs(q1y - q2y) > eps) return null;
  return [(q1x + q2x) / 2, (q1y + q2y) / 2];
}
