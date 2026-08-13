/**
 * Bend: a constrained, two-number description of a curved segment.
 *
 * Free bezier handles are expressive but awkward to make *precise* -- you are
 * placing two points by eye to get one visual effect. TikZiT's edge model
 * suggests the alternative: describe the curve by how far it bows away from the
 * straight line between its endpoints, and derive both control points from it.
 *
 *   angle      degrees the curve leaves the start by, relative to the chord.
 *              Mirrored at the far end, so the result is always symmetric.
 *   looseness  control-point distance as a multiple of chord/3. At looseness 1
 *              and angle 0 the controls land on the thirds, which reproduces
 *              the straight line exactly -- so a line is simply `angle: 0`.
 *
 * This is a VIEW of the handles, not a replacement for them. The model still
 * stores two absolute control points; these functions convert back and forth.
 * Keeping one source of truth means a bend and a hand-dragged handle can never
 * disagree, and dropping into free-handle editing costs nothing.
 */

import type { PathNode, Pt } from './types';

export interface Bend {
  /** Degrees away from the chord. Positive and negative bow opposite ways. */
  angle: number;
  /** Control distance as a multiple of chord/3. */
  looseness: number;
}


/** Wrap to (-180, 180]. */
function norm(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/**
 * Control points for a bend across the chord `a` -> `b`.
 *
 * The far control mirrors the near one about the chord's perpendicular
 * bisector, which is what makes the curve symmetric by construction.
 */
export function bendToHandles(a: Pt, b: Pt, bend: Bend): { c1: Pt; c2: Pt } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return { c1: [a[0], a[1]], c2: [b[0], b[1]] };

  const theta = Math.atan2(dy, dx);
  const beta = (bend.angle * Math.PI) / 180;
  const L = (bend.looseness * d) / 3;

  return {
    c1: [a[0] + L * Math.cos(theta + beta), a[1] + L * Math.sin(theta + beta)],
    c2: [b[0] - L * Math.cos(theta - beta), b[1] - L * Math.sin(theta - beta)],
  };
}

/**
 * Recover a bend from a segment's handles, or `null` if they are not symmetric.
 *
 * A straight segment (both handles absent) reads as `angle: 0`, so it can be
 * bent directly without first being "converted" to a curve.
 */
export function bendOf(a: PathNode, b: PathNode, eps = 1e-6): Bend | null {
  const dx = b.pt[0] - a.pt[0];
  const dy = b.pt[1] - a.pt[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return null;

  if (a.hOut === null && b.hIn === null) return { angle: 0, looseness: 1 };
  if (a.hOut === null || b.hIn === null) return null;

  const theta = Math.atan2(dy, dx);

  const v1x = a.hOut[0] - a.pt[0];
  const v1y = a.hOut[1] - a.pt[1];
  const v2x = b.pt[0] - b.hIn[0];
  const v2y = b.pt[1] - b.hIn[1];

  const l1 = Math.hypot(v1x, v1y);
  const l2 = Math.hypot(v2x, v2y);
  if (l1 < 1e-12 || l2 < 1e-12) return null;
  // Equal control lengths are half of symmetry; compare relative to the chord
  // so the tolerance means the same thing at any scale.
  if (Math.abs(l1 - l2) > eps * d) return null;

  // `bendToHandles` puts the near control at theta + beta and the far one at
  // theta - beta, so the far angle is measured the other way round. Reading
  // both the same way makes every bend look asymmetric with the sign flipped.
  const b1 = norm(((Math.atan2(v1y, v1x) - theta) * 180) / Math.PI);
  const b2 = norm(((theta - Math.atan2(v2y, v2x)) * 180) / Math.PI);
  if (Math.abs(norm(b1 - b2)) > eps * 1e3) return null;

  return { angle: (b1 + b2) / 2, looseness: (3 * ((l1 + l2) / 2)) / d };
}

/** Where the bend control sits: the curve's own midpoint. */
export function bendHandlePos(a: Pt, b: Pt, bend: Bend): Pt {
  const { c1, c2 } = bendToHandles(a, b, bend);
  // Cubic at t = 0.5 is (p0 + 3c1 + 3c2 + p3) / 8.
  return [
    (a[0] + 3 * c1[0] + 3 * c2[0] + b[0]) / 8,
    (a[1] + 3 * c1[1] + 3 * c2[1] + b[1]) / 8,
  ];
}

/**
 * Derive a bend from a dragged point.
 *
 * In chord-aligned coordinates the curve's midpoint sits a perpendicular
 * distance `h = looseness * d * sin(angle) / 4` from the chord, so the angle
 * follows directly from how far the pointer is off the line. Past the angle
 * cap the looseness grows instead, which keeps dragging smooth and unbounded
 * rather than pinning at some maximum bow.
 */
export function bendFromPoint(a: Pt, b: Pt, p: Pt, looseness = 1, maxAngle = 80): Bend {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return { angle: 0, looseness };

  // Signed perpendicular offset of `p` from the chord, measured in the same
  // frame `bendToHandles` uses (chord along +x, positive bend toward +y).
  const h = ((p[1] - a[1]) * dx - (p[0] - a[0]) * dy) / d;

  const capped = Math.sin((maxAngle * Math.PI) / 180);
  let L = looseness;
  let s = (4 * h) / (L * d);

  if (Math.abs(s) > capped) {
    // Keep the angle at its cap and let the curve get looser instead.
    L = (4 * Math.abs(h)) / (d * capped);
    s = Math.sign(s) * capped;
  }

  return { angle: (Math.asin(Math.max(-1, Math.min(1, s))) * 180) / Math.PI, looseness: L };
}


