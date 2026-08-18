/**
 * Smart guides: alignment you did not have to place.
 *
 * **This does not go through `resolveSnap`, and must not be made to.** Every
 * other snap maps a point to a point: the pointer is near a target, so the
 * pointer moves. An alignment is not about the pointer at all. It is about the
 * *bounding box of what is moving* agreeing with the box of something that is
 * not, and the pointer may be nowhere near either edge that matched. So this
 * takes boxes and returns an offset, and the priority rule in
 * `model/snapping.ts` has nothing here to arbitrate.
 *
 * Nine candidates per axis, every edge and centre of the moving box against
 * every edge and centre of the static one. Like against like alone would miss
 * butting one shape's left to another's right. §32.
 */

import type { Box } from '../core/bezier';

/** One agreement between the moving box and a static one, on one axis. */
export interface Alignment {
  /** The axis the agreement is on. `x` means they share an x coordinate. */
  axis: 'x' | 'y';
  /** How far the moving box has to shift along that axis to make it exact. */
  shift: number;
  /** The coordinate they agree on, once shifted. */
  at: number;
  /** The span to draw across, on the other axis: both boxes, end to end. */
  from: number;
  to: number;
  /** Whether it was an edge or a centre that matched, on the moving side. */
  kind: 'edge' | 'centre';
}

export interface Alignments {
  x: Alignment | null;
  y: Alignment | null;
}

/**
 * How much better a later candidate has to be to displace an earlier one.
 *
 * Not a tolerance on the geometry: a guard against ties being settled by binary
 * representation. A box at 0.2 whose far edge is at 10.2 is exactly 0.2 from a
 * static edge at 0 and 0.19999999999999929 from one at 10, so a strict `<`
 * hands the line to the second and makes the *drawn* alignment depend on which
 * decimals happen to be exact. Which one wins does not matter; that it is the
 * same one every time does.
 */
const BETTER = 1e-9;

const lo = (b: Box, axis: 'x' | 'y'): number => (axis === 'x' ? b.x0 : b.y0);
const hi = (b: Box, axis: 'x' | 'y'): number => (axis === 'x' ? b.x1 : b.y1);
const mid = (b: Box, axis: 'x' | 'y'): number => (lo(b, axis) + hi(b, axis)) / 2;

/** The three coordinates a box offers on one axis, near edge first. */
const marks = (b: Box, axis: 'x' | 'y'): { v: number; kind: 'edge' | 'centre' }[] => [
  { v: lo(b, axis), kind: 'edge' },
  { v: hi(b, axis), kind: 'edge' },
  { v: mid(b, axis), kind: 'centre' },
];

export const shiftBox = (b: Box, dx: number, dy: number): Box => ({
  x0: b.x0 + dx,
  y0: b.y0 + dy,
  x1: b.x1 + dx,
  y1: b.y1 + dy,
});

/**
 * The best agreement on each axis, or null where there is none within `reach`.
 *
 * Independent per axis on purpose: a shape can line its left edge up with one
 * object while its middle lines up with another, and reporting only the single
 * best match would silently drop one of them. Ties go to whichever was found
 * first, which is edges before centres and earlier shapes before later ones,
 * because an edge is the thing a person was more likely aiming at.
 */
export function alignmentsFor(moving: Box, statics: Box[], reach: number): Alignments {
  const out: Alignments = { x: null, y: null };
  if (!(reach > 0)) return out;

  for (const axis of ['x', 'y'] as const) {
    const other = axis === 'x' ? 'y' : 'x';
    let best = reach;
    for (const s of statics) {
      for (const m of marks(moving, axis)) {
        for (const t of marks(s, axis)) {
          const shift = t.v - m.v;
          if (Math.abs(shift) >= best - BETTER) continue;
          best = Math.abs(shift);
          out[axis] = {
            axis,
            shift,
            at: t.v,
            /* The drawn line reaches across both boxes, so it says which two
               things agreed. A line spanning only the moving one would leave
               you guessing what it had lined up with. */
            from: Math.min(lo(moving, other), lo(s, other)),
            to: Math.max(hi(moving, other), hi(s, other)),
            kind: m.kind,
          };
        }
      }
    }
  }
  return out;
}
