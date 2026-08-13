/**
 * The icon keyline grid: a circle, a square and two rectangles, centred.
 *
 * Material's 24dp system-icon grid, held as ratios because a document here is
 * whatever size someone made it:
 *
 *   live area           20 of 24, so 2 of padding on every side
 *   square              18 x 18
 *   circle              20 across
 *   vertical rectangle  16 x 20
 *   horizontal          20 x 16
 *
 * Every one of those is exact in thirds and sixths -- 20/24 is 5/6, 18/24 is
 * 3/4, 16/24 is 2/3 -- so a 24-unit canvas reproduces the published grid to the
 * unit and a 48-unit one doubles it. Hard-coding 18 and 20 would work on one
 * document size only.
 *
 * **The grid is square even when the canvas is not**, inscribed on the shorter
 * side and centred. Stretching the set to an 88 by 64 page puts the circle out
 * of round, and a circle that is not round is not the thing the grid exists to
 * give you.
 *
 * **Nothing here is part of `Doc`.** The subpaths are built on demand from the
 * viewBox, so there is no state to keep in step with the canvas and no path at
 * all from a keyline to an exported file. They are real `Subpath`s even so,
 * which is what lets the snapper treat them as targets like any other outline.
 *
 * `docs/ARCHITECTURE.md` §30 has why this is derived where the backdrop, which
 * looks like the same question, is stored.
 */

import { ellipseSubpath, rectSubpath } from '../core/primitives';
import type { Subpath, ViewBox } from '../core/types';

/** Live area: what the drawing is meant to stay inside. 20 of 24. */
const LIVE = 5 / 6;
/** Square keyline. 18 of 24. */
const SQUARE = 3 / 4;
/** Circle keyline, as a diameter. 20 of 24. */
const CIRCLE = 5 / 6;
/** A rectangle's long side. 20 of 24. */
const RECT_LONG = 5 / 6;
/** A rectangle's short side. 16 of 24. */
const RECT_SHORT = 2 / 3;

export interface Keylines {
  /** Side of the square the grid is inscribed in: the canvas's shorter side. */
  grid: number;
  /** Centre, in document coordinates. */
  cx: number;
  cy: number;
  /** The live area, on its own: it is drawn differently and means something else. */
  live: Subpath;
  /** Square, circle, portrait, landscape -- in that order. */
  shapes: Subpath[];
  /** The measurements, for the readout. Someone drawing to them wants the numbers. */
  sizes: { live: number; square: number; circle: number; short: number; long: number };
}

/**
 * The keyline set for a canvas, or `null` when there is no canvas to draw on.
 *
 * A viewBox with no area is a real state -- the four numbers are editable, and
 * someone typing a new width passes through zero on the way -- so it is refused
 * here rather than left to produce a set of degenerate shapes.
 */
export function keylinesFor(vb: ViewBox): Keylines | null {
  const grid = Math.min(vb.w, vb.h);
  if (!(grid > 0) || !Number.isFinite(grid)) return null;

  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  const box = (w: number, h: number): Subpath => rectSubpath(cx - w / 2, cy - h / 2, w, h);

  const sizes = {
    live: grid * LIVE,
    square: grid * SQUARE,
    circle: grid * CIRCLE,
    short: grid * RECT_SHORT,
    long: grid * RECT_LONG,
  };

  return {
    grid,
    cx,
    cy,
    live: box(sizes.live, sizes.live),
    shapes: [
      box(sizes.square, sizes.square),
      ellipseSubpath(cx, cy, sizes.circle / 2, sizes.circle / 2),
      box(sizes.short, sizes.long),
      box(sizes.long, sizes.short),
    ],
    sizes,
  };
}

/**
 * Every keyline as one list, which is what the snapper and the renderer want.
 *
 * The live area is in it. It is a boundary you aim at as much as the others
 * are, and leaving it out would mean the one rectangle you are told to keep
 * inside is the one the pointer slides past.
 */
export function keylineSubpaths(k: Keylines): Subpath[] {
  return [k.live, ...k.shapes];
}

/**
 * The same list, for the snapper, built at most once per canvas size.
 *
 * The snapper asks on every pointer move, and the answer only changes when the
 * viewBox does. One cached entry covers that: the canvas is not resized
 * mid-gesture, so there is nothing for a larger cache to hold.
 */
let memo: { key: string; guides: Subpath[] } | null = null;

export function keylineGuides(vb: ViewBox): Subpath[] | undefined {
  const key = `${vb.x},${vb.y},${vb.w},${vb.h}`;
  if (memo?.key === key) return memo.guides;
  const k = keylinesFor(vb);
  if (!k) return undefined;
  memo = { key, guides: keylineSubpaths(k) };
  return memo.guides;
}
