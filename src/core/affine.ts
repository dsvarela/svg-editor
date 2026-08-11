/**
 * 2x3 affine matrices, in SVG's own `matrix(a b c d e f)` order:
 *
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 *
 * This whole file is the payoff for normalising to cubics. Every transform the
 * editor offers -- move, rotate, scale, flip, skew -- is one of these applied
 * to every point in a shape. There is no per-command handling, no
 * relative/absolute branch, and in particular no ellipse algebra: compare
 * yqnn's `EllipticalArcTo.scale`, which needs the implicit conic form and an
 * eigenvalue to recompute `rx`, `ry`, the x-axis rotation and the sweep flag,
 * purely to keep an arc spelled as an `A`.
 */

import type { Pt } from './types';

export type Mat = [number, number, number, number, number, number];

export const identity = (): Mat => [1, 0, 0, 1, 0, 0];

/** Apply `m` to a point. */
export const applyMat = (m: Mat, p: Pt): Pt => [
  m[0] * p[0] + m[2] * p[1] + m[4],
  m[1] * p[0] + m[3] * p[1] + m[5],
];

/** Compose: `mul(a, b)` applies `b` first, then `a`. */
export function mul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export const translate = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty];

export const scale = (sx: number, sy: number = sx): Mat => [sx, 0, 0, sy, 0, 0];

export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}

export function skew(degX: number, degY: number): Mat {
  return [1, Math.tan((degY * Math.PI) / 180), Math.tan((degX * Math.PI) / 180), 1, 0, 0];
}

export const flipX = (): Mat => [-1, 0, 0, 1, 0, 0];
export const flipY = (): Mat => [1, 0, 0, -1, 0, 0];

/**
 * Re-anchor a transform so it happens about `(cx, cy)` instead of the origin.
 * Rotating a selection about its own centre is `about(rotate(45), cx, cy)`.
 */
export const about = (m: Mat, cx: number, cy: number): Mat =>
  mul(translate(cx, cy), mul(m, translate(-cx, -cy)));

/** Determinant; negative means the transform mirrors (winding order flips). */
export const det = (m: Mat): number => m[0] * m[3] - m[1] * m[2];

export function invert(m: Mat): Mat | null {
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  return [
    m[3] / d,
    -m[1] / d,
    -m[2] / d,
    m[0] / d,
    (m[2] * m[5] - m[3] * m[4]) / d,
    (m[1] * m[4] - m[0] * m[5]) / d,
  ];
}
