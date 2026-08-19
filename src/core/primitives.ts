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

/**
 * The bounds a corner count and an inner ratio are held to, in one place.
 *
 * Clamped rather than refused: both reach the generator from a number field
 * somebody can type -1 into, and a polygon of two sides is a line drawn twice.
 * The corner ceiling is where the sides stop being distinguishable from the
 * circle they approximate at any size this editor draws.
 *
 * Exported because three other places hold the same numbers to the same bounds
 * -- the settings the rail writes, the settings a session restores, and the
 * generator itself -- and three copies of a bound are three chances for one of
 * them to be widened alone. The `min` and `max` attributes on the number fields
 * in `index.html` are a fourth copy that cannot import this, so they are the
 * only ones that have to be changed by hand.
 */
export const clampCorners = (n: number): number => Math.max(3, Math.min(60, Math.round(n)));
export const clampRatio = (k: number): number => Math.max(0.01, Math.min(1, k));

/**
 * A regular polygon or a star, inscribed in the box `(cx, cy)` with radii
 * `rx, ry`, first point at the top.
 *
 * `inner` is the star's spoke ratio: `null` for a polygon, otherwise the inner
 * radius as a fraction of the outer, which gives `corners * 2` nodes alternating
 * out and in. A five-pointed star is `corners = 5, inner = 0.382`, which is the
 * ratio that makes the points meet at the golden angle and is what everybody
 * draws when they draw a star.
 *
 * **Points, not arcs.** Every node comes out with no handles, so every side is
 * straight and stays straight under later edits -- and Round can reach the
 * corners, which needs both sides of a node to be straight (§48). An ellipse has
 * to be four cubics because a circle is not a polygon; this has no such excuse.
 *
 * **First point at the top**, which is where a star has to have one: a
 * five-pointed star rotated by a tenth of a turn reads as a wrong star rather
 * than as a rotated one. The polygon inherits the same rule for free, and it is
 * the reason the angle starts at `-π/2` rather than at 0 the way `ellipseSubpath`
 * does.
 *
 * The radii are separate, so the shape follows the drag's box rather than being
 * forced circular. A pentagon in a wide box is a wide pentagon, which is what
 * dragging a wide box asks for; Shift during the drag is what makes it regular.
 */
export function polygonSubpath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  corners: number,
  inner: number | null = null,
): Subpath {
  const n = clampCorners(corners);
  const k = inner === null ? 1 : clampRatio(inner);
  const nodes = [];
  const steps = inner === null ? n : n * 2;
  for (let i = 0; i < steps; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / steps;
    const r = inner === null || i % 2 === 0 ? 1 : k;
    nodes.push(makeNode([cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a)]));
  }
  return { nodes, closed: true };
}
