/**
 * Primitives, built out of the same nodes and handles as everything else.
 *
 * There is no rect or ellipse in the model — a circle drawn here is four cubic
 * segments from the moment it exists, which is why you can immediately drag one
 * of its nodes without anything having to "convert to path" first. The price is
 * that a circle is only as round as four cubics can be; see `KAPPA`.
 */

import { makeNode } from './types';
import type { PathNode, Pt, Subpath } from './types';

/**
 * The circle constant: `4/3 · (√2 − 1)`, ≈ 0.5522847498.
 *
 * Handle length for a quarter turn of radius 1. It is the value that makes the
 * cubic pass exactly through the arc's midpoint, which leaves a maximum radial
 * error of about 0.027 % of the radius — 2.7 thousandths of a unit on a radius
 * of 10, well under a rounded coordinate at any sane decimal setting.
 *
 * The general form for an arc of angle θ is `4/3 · tan(θ/4)`, used by
 * `circulariseSubpath` when the nodes are not evenly spaced. At θ = π/2 the two
 * agree, which is the check worth remembering.
 */
export const KAPPA = (4 / 3) * (Math.SQRT2 - 1);

/**
 * Distance below which two tangent points count as the same point.
 *
 * The same bound `roundCorner` uses, and for the same reason. An exact `===`
 * was the first attempt and it looked safe, because when a side genuinely
 * vanishes `x0 + rad` and `x1 - rad` really are bit-identical. But a width one
 * ulp above twice the radius fails `capW`, leaves the two coordinates 4.4e-16
 * apart, and emits both -- a zero-length command in the exported path, and a
 * path that can never be simplified again. Exactness is the wrong test for a
 * predicate about geometry.
 */
const MEET = 1e-9;

/** Handle length for an arc of `angle` radians on a circle of radius `r`. */
export const arcHandle = (r: number, angle: number): number => (r * 4 * Math.tan(angle / 4)) / 3;

/**
 * An ellipse as four cubics, starting at the east point and running clockwise
 * in SVG's y-down coordinates.
 *
 * Every node comes out symmetric by construction — collinear handles of equal
 * length — so dragging one immediately behaves like the smooth point it looks
 * like, without anything having been declared anywhere.
 */
export function ellipseSubpath(cx: number, cy: number, rx: number, ry: number): Subpath {
  const kx = Math.abs(rx) * KAPPA;
  const ky = Math.abs(ry) * KAPPA;

  const east = makeNode([cx + rx, cy]);
  const south = makeNode([cx, cy + ry]);
  const west = makeNode([cx - rx, cy]);
  const north = makeNode([cx, cy - ry]);

  east.hOut = [cx + rx, cy + ky];
  south.hIn = [cx + kx, cy + ry];

  south.hOut = [cx - kx, cy + ry];
  west.hIn = [cx - rx, cy + ky];

  west.hOut = [cx - rx, cy - ky];
  north.hIn = [cx - kx, cy - ry];

  north.hOut = [cx + kx, cy - ry];
  east.hIn = [cx + rx, cy - ky];

  return { nodes: [east, south, west, north], closed: true };
}

/**
 * A rectangle, optionally with rounded corners.
 *
 * `r` is clamped to half the shorter side, so an over-large radius gives a
 * stadium rather than a self-crossing tangle. At `r = 0` the result is four
 * plain nodes with no handles at all — a straight segment has none, and that is
 * what makes the corners stay square under every later edit.
 *
 * A rounded corner is one quarter arc, so each of its two nodes has a handle on
 * the curved side and nothing on the straight side. `continuityOf` reads that
 * as a corner, which is correct: there is no pair to keep in line.
 */
export function rectSubpath(x: number, y: number, w: number, h: number, r = 0): Subpath {
  const x0 = Math.min(x, x + w);
  const y0 = Math.min(y, y + h);
  const bw = Math.abs(w);
  const bh = Math.abs(h);
  const x1 = x0 + bw;
  const y1 = y0 + bh;

  const rad = Math.max(0, Math.min(r, Math.min(bw, bh) / 2));
  if (rad <= 0) {
    return {
      nodes: [makeNode([x0, y0]), makeNode([x1, y0]), makeNode([x1, y1]), makeNode([x0, y1])],
      closed: true,
    };
  }

  const k = rad * KAPPA;

  /* Where the radius takes a whole side, the two tangent points on it land on
     the same spot, and that side has ceased to exist. Naming the four tangent
     coordinates once, rather than writing `x0 + rad` and `x1 - rad` in eight
     places, keeps the two ends of a vanished side identical rather than merely
     close. The comparison below is still made against `MEET`, for the width
     that sits an ulp the wrong side of the clamp. */
  const capW = bw <= rad * 2;
  const capH = bh <= rad * 2;
  const lx = capW ? x0 + bw / 2 : x0 + rad;
  const rx = capW ? x0 + bw / 2 : x1 - rad;
  const ty = capH ? y0 + bh / 2 : y0 + rad;
  const by = capH ? y0 + bh / 2 : y1 - rad;

  // Two nodes per corner, in clockwise order from the top edge.
  const n: PathNode[] = [
    makeNode([lx, y0]),
    makeNode([rx, y0]),
    makeNode([x1, ty]),
    makeNode([x1, by]),
    makeNode([rx, y1]),
    makeNode([lx, y1]),
    makeNode([x0, by]),
    makeNode([x0, ty]),
  ];

  n[1].hOut = [rx + k, y0];
  n[2].hIn = [x1, ty - k];

  n[3].hOut = [x1, by + k];
  n[4].hIn = [rx + k, y1];

  n[5].hOut = [lx - k, y1];
  n[6].hIn = [x0, by + k];

  n[7].hOut = [x0, ty - k];
  n[0].hIn = [lx - k, y0];

  /* Emit a vanished side's two tangent points as one node. Leaving both put two
     anchors on the same point and a zero-length command in the exported path,
     and a path carrying one can never be simplified again: a zero chord gives
     the fitter no tangent. The pairs are the even-indexed sides, and the
     survivor takes the arc handle from each direction, which is right
     geometrically too -- the two arcs meet, so they share the point. */
  const nodes: PathNode[] = [];
  for (let i = 0; i < 8; i += 2) {
    const a = n[i];
    const b = n[i + 1];
    if (Math.hypot(b.pt[0] - a.pt[0], b.pt[1] - a.pt[1]) <= MEET) {
      nodes.push({ pt: a.pt, hIn: a.hIn, hOut: b.hOut });
    } else {
      nodes.push(a, b);
    }
  }

  return { nodes, closed: true };
}

/**
 * The best-fit circle through a set of points, by algebraic least squares.
 *
 * Kåsa's method: `x² + y² = 2ax + 2by + c` is linear in `(a, b, c)`, so the fit
 * is a 3×3 normal system rather than an iteration. Centring the data first
 * decouples `c` and leaves a 2×2 solve, which also keeps the conditioning sane
 * when the points sit far from the origin.
 *
 * Returns `null` for fewer than three points or a degenerate (collinear)
 * arrangement, where no circle is determined.
 */
export function fitCircle(pts: Pt[]): { centre: Pt; radius: number } | null {
  const n = pts.length;
  if (n < 3) return null;

  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= n;
  my /= n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  for (const p of pts) {
    const x = p[0] - mx;
    const y = p[1] - my;
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }

  const det = sxx * syy - sxy * sxy;
  // Scale-free degeneracy test: collinear points leave no area in the scatter.
  if (Math.abs(det) <= 1e-12 * Math.max(1, sxx * syy)) return null;

  const a = (syy * sxz - sxy * syz) / (2 * det);
  const b = (sxx * syz - sxy * sxz) / (2 * det);
  const c = sz / n;
  const rsq = c + a * a + b * b;
  if (!(rsq > 0)) return null;

  return { centre: [a + mx, b + my], radius: Math.sqrt(rsq) };
}
