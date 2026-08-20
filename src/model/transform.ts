/**
 * The maths behind dragging a selection's box: which point stays still, and
 * what matrix the pointer's new position implies.
 *
 * Pure and DOM-free on purpose. A transform box is mostly interaction, and
 * interaction is the hardest thing here to test; keeping the arithmetic in
 * functions that take a box and a point means the part that can be wrong
 * quietly is the part covered by unit tests.
 *
 * Everything returns a matrix, which is then applied to the captured original
 * geometry. See `captureNodes` in `ops.ts` for why the drag never composes one
 * transform onto the last.
 */

import { about, rotate, scale } from '../core/affine';
import type { Mat } from '../core/affine';
import type { Box } from '../core/bezier';
import type { Pt } from '../core/types';

/** Compass position of a handle on the selection box. */
export type TransformPart = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const TRANSFORM_PARTS: TransformPart[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export const CORNER_PARTS: TransformPart[] = ['nw', 'ne', 'se', 'sw'];

export interface ScaleOptions {
  /** Hold the centre still instead of the opposite corner. Alt. */
  fromCentre?: boolean;
  /** Keep the aspect ratio, for corner handles. Shift. */
  keepAspect?: boolean;
}

/**
 * Below this, an edge is treated as having no length and its axis does not
 * scale. A selection can genuinely be flat: one row of nodes, or a horizontal
 * line. Dividing by its height would send every point to infinity.
 *
 * Exported because typing a width into the panel asks the same question a drag
 * does, and two numbers for one threshold would let the panel refuse what a drag
 * allowed.
 */
export const FLAT = 1e-9;

const movesX = (part: TransformPart): boolean => part.includes('e') || part.includes('w');
const movesY = (part: TransformPart): boolean => part.includes('n') || part.includes('s');

/**
 * Which point of the selection a transform holds still.
 *
 * Nine, laid out as the box's corners, edge middles and centre. Illustrator's
 * reference point, and the reason it exists is that a transform has to keep
 * something fixed and the useful choice is not always the same one: scaling a
 * logo about its centre and scaling a column about its left edge are different
 * jobs with the same numbers.
 *
 * Not `TransformPart`, which is the eight box handles. A handle is a thing you
 * grab and there is nothing to grab in the middle; this is a thing you choose.
 */
export type Reference = 'nw' | 'n' | 'ne' | 'w' | 'c' | 'e' | 'sw' | 's' | 'se';

/** Reading order, which is the order the chooser lays them out in. */
export const REFERENCES: Reference[] = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'];

/** The point of `b` that `ref` names. */
export function referencePoint(b: Box, ref: Reference): Pt {
  const x = ref === 'nw' || ref === 'w' || ref === 'sw' ? b.x0 : ref === 'n' || ref === 'c' || ref === 's' ? (b.x0 + b.x1) / 2 : b.x1;
  const y = ref === 'nw' || ref === 'n' || ref === 'ne' ? b.y0 : ref === 'w' || ref === 'c' || ref === 'e' ? (b.y0 + b.y1) / 2 : b.y1;
  return [x, y];
}

export const boxCentre = (b: Box): Pt => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];

/** Where a handle sits on the box. Edge handles sit at the midpoint. */
export function handlePoint(b: Box, part: TransformPart): Pt {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return [
    part.includes('w') ? b.x0 : part.includes('e') ? b.x1 : cx,
    part.includes('n') ? b.y0 : part.includes('s') ? b.y1 : cy,
  ];
}

/**
 * The point that does not move while `part` is dragged: the opposite corner,
 * or the centre when Alt is held.
 *
 * Anchoring the opposite corner is what makes dragging feel like stretching the
 * box rather than moving it. Anchoring the centre is the same gesture mirrored,
 * and is why Alt-scaling keeps a shape where it is.
 */
export function anchorPoint(b: Box, part: TransformPart, fromCentre = false): Pt {
  if (fromCentre) return boxCentre(b);
  const opposite = {
    nw: 'se',
    n: 's',
    ne: 'sw',
    e: 'w',
    se: 'nw',
    s: 'n',
    sw: 'ne',
    w: 'e',
  } as const;
  return handlePoint(b, opposite[part]);
}

/**
 * The matrix implied by dragging `part` to `to`.
 *
 * The factor on each axis is the ratio of two distances from the anchor: where
 * the handle is now, over where it started. An axis the handle does not govern
 * keeps a factor of exactly 1, so dragging the east edge cannot change the
 * height by a rounding error.
 *
 * Nothing clamps the result. A factor of zero flattens the selection and a
 * negative one mirrors it, and both are things people do on purpose; the drag
 * recomputes from the original geometry every frame, so passing through zero on
 * the way somewhere else costs nothing.
 */
export function scaleMatrix(b: Box, part: TransformPart, to: Pt, o: ScaleOptions = {}): Mat {
  const anchor = anchorPoint(b, part, o.fromCentre);
  const from = handlePoint(b, part);
  const dx = from[0] - anchor[0];
  const dy = from[1] - anchor[1];

  let sx = movesX(part) && Math.abs(dx) > FLAT ? (to[0] - anchor[0]) / dx : 1;
  let sy = movesY(part) && Math.abs(dy) > FLAT ? (to[1] - anchor[1]) / dy : 1;

  if (o.keepAspect && movesX(part) && movesY(part)) {
    /* One factor for both axes, taken by projecting the pointer onto the box's
       diagonal.

       Taking the larger of `sx` and `sy` instead looks reasonable and is wrong
       in one direction: dragging a corner inwards leaves the axis you did not
       move at a factor of 1, which is the larger of the two, so a constrained
       drag inwards does nothing at all. Projection is symmetric, and it is what
       makes a diagonal drag land the corner under the pointer. */
    // Squared, so the threshold has to be squared too. Comparing a squared
    // length against a length tripped at a diagonal of 3e-5 rather than 1e-9,
    // which silently ignored Shift on a very small selection.
    const len2 = dx * dx + dy * dy;
    if (len2 > FLAT * FLAT) {
      const k = ((to[0] - anchor[0]) * dx + (to[1] - anchor[1]) * dy) / len2;
      sx = k;
      sy = k;
    }
  }

  return about(scale(sx, sy), anchor[0], anchor[1]);
}

export interface Rotation {
  m: Mat;
  /** Turn applied, in degrees, normalised to (-180, 180]. */
  deg: number;
}

/**
 * The matrix implied by swinging the pointer from `from` to `to` about `centre`.
 *
 * `snapDeg` rounds the turn rather than the resulting orientation, because the
 * only angle this function can know about is the one it has been asked to
 * apply. Snapping to 15 degrees therefore means fifteen from where you started,
 * which is what someone holding Shift is asking for.
 */
export function rotateMatrix(centre: Pt, from: Pt, to: Pt, snapDeg = 0): Rotation {
  /* A point on the centre has no angle. `atan2(0, 0)` is 0 rather than
     undefined, so sweeping the pointer through the middle of the selection used
     to apply minus the grab angle in one jump. */
  const ra = Math.hypot(from[0] - centre[0], from[1] - centre[1]);
  const rb = Math.hypot(to[0] - centre[0], to[1] - centre[1]);
  if (ra < FLAT || rb < FLAT) return { m: about(rotate(0), centre[0], centre[1]), deg: 0 };

  const a0 = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
  const a1 = Math.atan2(to[1] - centre[1], to[0] - centre[0]);
  let deg = ((a1 - a0) * 180) / Math.PI;
  if (snapDeg > 0) deg = Math.round(deg / snapDeg) * snapDeg;
  /* atan2 differences land anywhere in (-360, 360). Reported as the short way
     round, since a 350 degree turn is a 10 degree turn the other way. The
     half turn is written as +180: the modulo lands it on -180, and a readout
     saying "Rotated -180" for a drag that went the other way is a wrong sign
     on the one angle where the matrix cannot tell the difference. */
  deg = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (deg === -180) deg = 180;
  return { m: about(rotate(deg), centre[0], centre[1]), deg };
}
