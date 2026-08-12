/**
 * Angular snap: which ray, and where on it.
 *
 * Two things can go wrong quietly. Rounding the point's angle to the nearest
 * ray is what keeps the projection in front of the origin, so a version that
 * projects onto a line instead of a ray reports a plausible point behind the
 * user; and the tier this answers decides whether an angle can drag the pointer
 * off a node, which it must not.
 */

import { describe, expect, it } from 'vitest';
import { nearestRay, rayAngles } from '../src/model/angles';
import { resolveSnap } from '../src/model/snapping';
import type { SnapSetup } from '../src/model/snapping';
import { emptyDoc, shapeFromPath } from '../src/model/doc';
import type { Pt } from '../src/core/types';

const at = (origin: Pt, step = 45, base = 0): { origin: Pt; step: number; base: number } => ({
  origin,
  step,
  base,
});

describe('the rays themselves', () => {
  it('goes round once, without repeating the first', () => {
    expect(rayAngles(90, 0)).toEqual([0, 90, 180, 270]);
  });

  it('starts where the base says', () => {
    expect(rayAngles(90, 30)).toEqual([30, 120, 210, 300]);
  });

  it('handles a step that does not divide 360', () => {
    /* 7 degrees gives 52 rays and a 4 degree gap at the end, which is legal and
       is what the number field allows. A version computing `360 / step` and
       rounding would either overshoot into a duplicate or stop short. */
    const r = rayAngles(7, 0);
    expect(r).toHaveLength(52);
    expect(r[51]).toBeCloseTo(357, 9);
  });

  it('refuses a step that would ask for infinitely many', () => {
    expect(rayAngles(0, 0)).toEqual([]);
    expect(rayAngles(-45, 0)).toEqual([]);
    expect(rayAngles(Number.NaN, 0)).toEqual([]);
  });

  it('caps a step small enough to flood the overlay', () => {
    expect(rayAngles(0.001, 0).length).toBe(720);
  });
});

describe('finding the nearest ray', () => {
  it('holds a point to the diagonal it is nearly on', () => {
    // Just off the 45 degree ray from the origin.
    const r = nearestRay([10, 9.7], at([0, 0]), 1);
    expect(r).not.toBeNull();
    expect(r!.pt[0]).toBeCloseTo(r!.pt[1], 9);
  });

  it('measures distance to the ray, not to the origin', () => {
    /* The whole point: you hold a direction while moving away along it. A
       hundred units out and a third off the line is still a snap. */
    const r = nearestRay([100, 0.3], at([0, 0]), 1);
    expect(r).not.toBeNull();
    expect(r!.pt).toEqual([expect.closeTo(100, 6), expect.closeTo(0, 6)]);
  });

  it('reports nothing when the point is between rays', () => {
    // 22.5 degrees is exactly between 0 and 45, and a long way out, so the
    // distance to either is large.
    expect(nearestRay([100, 41.4], at([0, 0]), 1)).toBeNull();
  });

  it('answers on the ray the point is nearest, in the direction it points', () => {
    // Down and to the left is the 225 degree ray, not the 45 degree one seen
    // from behind. With a step of 45 the rounding settles it either way.
    const r = nearestRay([-70, -69.5], at([0, 0]), 1);
    expect(r).not.toBeNull();
    expect(r!.pt[0]).toBeLessThan(0);
    expect(r!.pt[1]).toBeLessThan(0);
  });

  it('lands on the origin rather than behind it, when a ray points away', () => {
    /* Only reachable above a 180 degree step, where the rays no longer cover
       every direction: at 270 there are two, at 0 and at 270, and a point up
       and to the left is more than a quarter turn from both. The nearest point
       of a ray you are behind is where it starts.

       The clamp exists for this and for nothing else -- below 180 the rounding
       already guarantees the projection is in front -- so a test at 45 degrees
       cannot tell whether it is there. */
    const r = nearestRay([-10, -10], at([0, 0], 270, 0), 100);
    expect(r).not.toBeNull();
    expect(r!.pt).toEqual([0, 0]);
  });

  it('follows the origin', () => {
    // From (100, 0) the point is 10 across and 9.7 down, so the 45 degree ray
    // takes it 9.85 along each axis -- and the x is 109.85, not 9.85.
    const r = nearestRay([110, 9.7], at([100, 0]), 1);
    expect(r!.pt).toEqual([expect.closeTo(109.85, 2), expect.closeTo(9.85, 2)]);
  });

  it('answers the origin itself when there is no direction to round', () => {
    const r = nearestRay([5, 5], at([5, 5]), 1);
    expect(r).toEqual({ pt: [5, 5], d: 0 });
  });

  it('respects the base angle', () => {
    // Rays at 30, 120, 210, 300. A point near 30 degrees snaps; the same point
    // is 30 degrees from every ray of the default set.
    const p: Pt = [Math.cos(Math.PI / 6) * 50, Math.sin(Math.PI / 6) * 50 + 0.4];
    expect(nearestRay(p, at([0, 0], 90, 30), 1)).not.toBeNull();
    expect(nearestRay(p, at([0, 0], 90, 0), 1)).toBeNull();
  });
});

describe('a ray in the priority order', () => {
  const setup = (over: Partial<SnapSetup> = {}): SnapSetup => ({
    doc: emptyDoc(),
    step: 1,
    phase: 0,
    toGrid: true,
    toPoints: true,
    toBoundary: true,
    reach: 2,
    angles: { origin: [0, 0], step: 45, base: 0 },
    ...over,
  });

  it('answers the boundary tier, because a ray is a line', () => {
    const r = resolveSnap([10, 9.3], setup({ step: 0 }));
    expect(r.kind).toBe('boundary');
    expect(r.pt[0]).toBeCloseTo(r.pt[1], 6);
  });

  it('beats the grid, which is the tier below', () => {
    // (10, 9.3) is 0.3 from the lattice and 0.49 from the ray, and the ray wins
    // because the tier decides, not the distance.
    const r = resolveSnap([10, 9.3], setup());
    expect(r.kind).toBe('boundary');
  });

  it('loses to a node, which is the tier above', () => {
    /* The reason this is a tier rather than a mode. A direction you set once
       must not drag the pointer off a point someone placed. */
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath('M10.1 9.4 L40 80 Z'));
    const r = resolveSnap([10, 9.3], setup({ doc }));
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([10.1, 9.4]);
  });

  it('claims nothing when angular snap is off', () => {
    const r = resolveSnap([10, 9.3], setup({ step: 0, angles: null }));
    expect(r.kind).toBe('none');
  });
});
