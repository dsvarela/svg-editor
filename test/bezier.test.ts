/**
 * `cubicOver` and `cubicUnitTangent`, the two pieces a corner is undone with.
 *
 * Both are checked against the curve they came from rather than against a
 * second implementation of themselves: a reparameterised cubic is right when it
 * passes through the same points as the original at the matching parameters,
 * and that is decidable by sampling.
 */

import { describe, expect, it } from 'vitest';
import { cubicAt, cubicOver, cubicUnitTangent, reverseCubic, splitCubic } from '../src/core/bezier';
import type { Cubic } from '../src/core/types';

/** A curve with a real bend, off the origin, and asymmetric on both axes. */
const C: Cubic = [
  [30, 70],
  [45, 20],
  [120, 40],
  [140, 95],
];

/** How far `b` strays from `c` over the parameter range `c` was cut to. */
function deviation(b: Cubic, c: Cubic, t0: number, t1: number, steps = 40): number {
  let worst = 0;
  for (let k = 0; k <= steps; k++) {
    const s = k / steps;
    const got = cubicAt(b, s);
    const want = cubicAt(c, t0 + (t1 - t0) * s);
    worst = Math.max(worst, Math.hypot(got[0] - want[0], got[1] - want[1]));
  }
  return worst;
}

describe('cubicOver traces the range it is given', () => {
  it.each([
    [0, 1],
    [0, 0.37],
    [0.62, 1],
    [0.25, 0.8],
  ])('inside the curve, %f to %f', (t0, t1) => {
    expect(deviation(cubicOver(C, t0, t1), C, t0, t1)).toBeLessThan(1e-9);
  });

  it.each([
    [0, 1.8],
    [-0.6, 1],
    [-0.4, 1.5],
  ])('past the ends, %f to %f', (t0, t1) => {
    /* The case the corner's undo rests on. The continuation is the polynomial
       the original was cut from, so it has to land on the same points a longer
       curve would have, not merely somewhere plausible. */
    expect(deviation(cubicOver(C, t0, t1), C, t0, t1)).toBeLessThan(1e-9);
  });

  it('agrees with splitCubic, which reaches only inside', () => {
    const t = 0.42;
    const [left, right] = splitCubic(C, t);
    expect(deviation(cubicOver(C, 0, t), left, 0, 1)).toBeLessThan(1e-9);
    expect(deviation(cubicOver(C, t, 1), right, 0, 1)).toBeLessThan(1e-9);
  });

  it('undoes a split, which is what recovers a trimmed side', () => {
    // Cut a piece off, then ask that piece for the whole curve back.
    const t = 0.3;
    const [, tail] = splitCubic(C, t);
    // `tail` covers [t, 1] of C, so C's start sits at -t/(1-t) in tail's frame.
    const back = cubicOver(tail, -t / (1 - t), 1);
    expect(deviation(back, C, 0, 1)).toBeLessThan(1e-9);
  });

  it('reverses without moving the curve', () => {
    const r = reverseCubic(C);
    for (const t of [0, 0.2, 0.5, 0.9, 1]) {
      const a = cubicAt(r, t);
      const b = cubicAt(C, 1 - t);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-12);
    }
  });
});

describe('cubicUnitTangent survives a control point on the anchor', () => {
  it('reads the ordinary case off the derivative', () => {
    const t = cubicUnitTangent(C, 0)!;
    const d = [C[1][0] - C[0][0], C[1][1] - C[0][1]];
    const len = Math.hypot(d[0], d[1]);
    expect(t[0]).toBeCloseTo(d[0] / len, 12);
    expect(t[1]).toBeCloseTo(d[1] / len, 12);
  });

  it('answers at both ends of a straight segment stored with collapsed handles', () => {
    /* How the model stores a line: `segmentAsCubic` puts both controls on the
       anchors, which makes the derivative zero at each end. The direction is
       still the chord, and a corner measured from it would otherwise have no
       tangent at all. */
    const line: Cubic = [
      [10, 20],
      [10, 20],
      [70, 60],
      [70, 60],
    ];
    const want = Math.atan2(40, 60);
    for (const t of [0, 1]) {
      const u = cubicUnitTangent(line, t)!;
      expect(Math.atan2(u[1], u[0])).toBeCloseTo(want, 9);
      expect(Math.hypot(u[0], u[1])).toBeCloseTo(1, 12);
    }
  });

  it('falls through to the far anchor when both controls sit on the near one', () => {
    /* Reachable from the model: `segmentAsCubic` reads a handle straight off a
       node, so a handle dragged onto the neighbouring anchor collapses two of
       the four control points onto the start. The chord is still the direction. */
    const collapsed: Cubic = [
      [10, 20],
      [10, 20],
      [10, 20],
      [70, 60],
    ];
    const start = cubicUnitTangent(collapsed, 0)!;
    expect(Math.atan2(start[1], start[0])).toBeCloseTo(Math.atan2(40, 60), 9);

    /* The same collapse at the other end, which takes the other branch. Traced
       backwards the curve arrives at [10, 20] from [70, 60], so the tangent
       there points the opposite way. */
    const end = cubicUnitTangent(reverseCubic(collapsed), 1)!;
    expect(Math.atan2(end[1], end[0])).toBeCloseTo(Math.atan2(-40, -60), 9);
  });

  it('gives up on a curve that is a single point', () => {
    const dot: Cubic = [
      [5, 5],
      [5, 5],
      [5, 5],
      [5, 5],
    ];
    expect(cubicUnitTangent(dot, 0)).toBeNull();
  });
});
