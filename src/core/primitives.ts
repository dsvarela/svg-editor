/**
 * Primitives, built out of the same nodes and handles as everything else.
 *
 * There is no rect or ellipse in the model — a circle drawn here is four cubic
 * segments from the moment it exists, which is why you can immediately drag one
 * of its nodes without anything having to "convert to path" first. The price is
 * that a circle is only as round as four cubics can be; see `KAPPA`.
 */

import { makeNode } from './types';
import type { Subpath } from './types';

/**
 * The circle constant: `4/3 · (√2 − 1)`, ≈ 0.5522847498.
 *
 * Handle length for a quarter turn of radius 1. It is the value that makes the
 * cubic pass exactly through the arc's midpoint, which leaves a maximum radial
 * error of about 0.027 % of the radius — 2.7 thousandths of a unit on a radius
 * of 10, well under a rounded coordinate at any sane decimal setting.
 *
 * The general form for an arc of angle θ is `4/3 · tan(θ/4)`, which is what
 * `arcHandle` below computes for an arc of any size. At θ = π/2 the two agree,
 * which is the check worth remembering.
 */
export const KAPPA = (4 / 3) * (Math.SQRT2 - 1);

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
 * A rectangle: four plain nodes with no handles at all.
 *
 * A straight segment has no handles, and that is what makes the corners stay
 * square under every later edit. It is also what lets Round reach them: a
 * corner is only roundable where neither of its sides is curved.
 *
 * It once took a radius of its own, driven by a field in the rail that no other
 * tool read and nothing on screen said so. One radius control rounds any corner
 * on any path now, and `roundCorner` is the only thing that builds a fillet.
 */
export function rectSubpath(x: number, y: number, w: number, h: number): Subpath {
  const x0 = Math.min(x, x + w);
  const y0 = Math.min(y, y + h);
  const x1 = x0 + Math.abs(w);
  const y1 = y0 + Math.abs(h);
  return {
    nodes: [makeNode([x0, y0]), makeNode([x1, y0]), makeNode([x1, y1]), makeNode([x0, y1])],
    closed: true,
  };
}
