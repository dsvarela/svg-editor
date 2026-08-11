/**
 * The transform box's arithmetic.
 *
 * The gesture is hard to test and the maths is not, so the maths lives in
 * functions that take a box and a point. What matters is which point stays
 * still, and that a handle put back where it came from is the identity.
 */

import { describe, expect, it } from 'vitest';
import { applyMat } from '../src/core/affine';
import {
  anchorPoint,
  boxCentre,
  handlePoint,
  rotateMatrix,
  scaleMatrix,
} from '../src/model/transform';
import type { TransformPart } from '../src/model/transform';
import type { Box } from '../src/core/bezier';
import type { Pt } from '../src/core/types';

/** 40 wide, 20 tall, at a deliberately non-zero origin. */
const box: Box = { x0: 10, y0: 5, x1: 50, y1: 25 };

const near = (a: Pt, b: Pt, digits = 9): void => {
  expect(a[0]).toBeCloseTo(b[0], digits);
  expect(a[1]).toBeCloseTo(b[1], digits);
};

describe('scaleMatrix', () => {
  it('holds the opposite corner still', () => {
    const m = scaleMatrix(box, 'se', [70, 45]);
    near(applyMat(m, [10, 5]), [10, 5]);
  });

  it('puts the dragged handle exactly under the pointer', () => {
    for (const part of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as TransformPart[]) {
      const to: Pt = [60, 40];
      const m = scaleMatrix(box, part, to);
      const landed = applyMat(m, handlePoint(box, part));
      // An edge handle only governs one axis, so only that one has to arrive.
      if (part.includes('e') || part.includes('w')) expect(landed[0]).toBeCloseTo(to[0], 9);
      if (part.includes('n') || part.includes('s')) expect(landed[1]).toBeCloseTo(to[1], 9);
    }
  });

  it('is the identity when a handle is dropped where it started', () => {
    for (const part of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as TransformPart[]) {
      const m = scaleMatrix(box, part, handlePoint(box, part));
      near(applyMat(m, [17, 23]), [17, 23]);
    }
  });

  it('leaves the axis a handle does not govern exactly alone', () => {
    // Not approximately alone: dragging the east edge must not change a single
    // y coordinate by a rounding error, or a row of nodes drifts off the grid.
    const m = scaleMatrix(box, 'e', [90, 400]);
    expect(applyMat(m, [30, 17])[1]).toBe(17);
  });

  it('holds the centre still with fromCentre', () => {
    const c = boxCentre(box);
    const m = scaleMatrix(box, 'se', [70, 45], { fromCentre: true });
    near(applyMat(m, c), c);
  });

  it('keeps the aspect ratio when asked, in both directions', () => {
    const ratio = (m: ReturnType<typeof scaleMatrix>): number => m[0] / m[3];
    // Outwards.
    expect(ratio(scaleMatrix(box, 'se', [80, 30], { keepAspect: true }))).toBeCloseTo(1, 9);
    // And inwards, which is the case a max-of-the-two rule gets wrong: the
    // untouched axis sits at 1, wins the comparison, and nothing moves.
    const shrink = scaleMatrix(box, 'se', [30, 25], { keepAspect: true });
    expect(ratio(shrink)).toBeCloseTo(1, 9);
    expect(shrink[0]).toBeLessThan(1);
  });

  it('mirrors when dragged past the anchor', () => {
    const m = scaleMatrix(box, 'e', [0, 0]);
    expect(m[0]).toBeLessThan(0);
    // The anchor is still exactly where it was, mirrored or not.
    near(applyMat(m, [10, 5]), [10, 5]);
  });

  it('refuses to divide by a flat selection', () => {
    const flat: Box = { x0: 10, y0: 5, x1: 50, y1: 5 };
    const m = scaleMatrix(flat, 'se', [70, 40]);
    expect(Number.isFinite(m[3])).toBe(true);
    // Nothing to stretch vertically, so nothing does.
    expect(applyMat(m, [30, 5])[1]).toBe(5);
  });

  it('anchors the opposite handle, whichever one is dragged', () => {
    expect(anchorPoint(box, 'nw')).toEqual([50, 25]);
    expect(anchorPoint(box, 'n')).toEqual([30, 25]);
    expect(anchorPoint(box, 'e')).toEqual([10, 15]);
  });
});

describe('rotateMatrix', () => {
  const c: Pt = [0, 0];

  it('turns by the angle swept, about the centre', () => {
    const r = rotateMatrix(c, [10, 0], [0, 10]);
    expect(r.deg).toBeCloseTo(90, 9);
    near(applyMat(r.m, [10, 0]), [0, 10]);
    near(applyMat(r.m, c), c);
  });

  it('snaps the turn, not the pointer', () => {
    const r = rotateMatrix(c, [10, 0], [10, 1.2], 15);
    expect(r.deg).toBe(0);
    const s = rotateMatrix(c, [10, 0], [10, 9], 15);
    expect(s.deg).toBe(45);
  });

  it('reports the short way round', () => {
    // Swinging 350 degrees anticlockwise is 10 degrees clockwise, and the
    // matrix cannot tell them apart, so neither should the readout.
    const a = (-10 * Math.PI) / 180;
    const r = rotateMatrix(c, [10, 0], [Math.cos(a) * 10, Math.sin(a) * 10]);
    expect(r.deg).toBeCloseTo(-10, 9);
    expect(Math.abs(r.deg)).toBeLessThanOrEqual(180);
  });

  it('does nothing when the pointer has not moved', () => {
    const r = rotateMatrix(c, [10, 3], [10, 3]);
    expect(r.deg).toBe(0);
    near(applyMat(r.m, [7, 11]), [7, 11]);
  });
});
