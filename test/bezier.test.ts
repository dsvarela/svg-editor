/**
 * `cubicOver` and `cubicUnitTangent`, the two pieces a corner is undone with.
 *
 * Both are checked against the curve they came from rather than against a
 * second implementation of themselves: a reparameterised cubic is right when it
 * passes through the same points as the original at the matching parameters,
 * and that is decidable by sampling.
 */

import { describe, expect, it } from 'vitest';
import {
  cubicAsQuad,
  cubicAt,
  cubicBBox,
  cubicIsLine,
  cubicOver,
  cubicUnitTangent,
  reverseCubic,
  splitCubic,
} from '../src/core/bezier';
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

/**
 * The box a curve occupies, which is the box every shape in the document gets.
 *
 * `cubicBBox` had no test at all until 2026-08-21, and a mutation sweep found
 * the block that handles an interior extremum surviving six ways over,
 * including swapping which axis it updates. `doc.ts` builds every shape's box
 * from this, so a curve boxed as if it were flat is a wrong selection
 * rectangle, a wrong Fit, a wrong Align and a wrong exported `viewBox`.
 *
 * The bulge is the whole point: a cubic's box is the box of its **curve**, not
 * of its four defining points, and the two differ exactly when a derivative
 * root falls strictly inside the parameter range. Each case below states the
 * extremum as arithmetic rather than taking it from the function.
 */
describe('the box a cubic occupies', () => {
  /* p0 and p3 at y = 0 with both controls at y = 20 puts the derivative root at
     t = 0.5, where the curve reaches 3/4 of the control height. Nothing here is
     at the origin, because a box is four differences and a fixture at 0 0 lets
     a sum pass for one. */
  it('reaches past its endpoints where the curve bulges', () => {
    const b: Cubic = [
      [10, 50],
      [10, 90],
      [50, 90],
      [50, 50],
    ];
    const box = cubicBBox(b);
    expect(box.x0).toBeCloseTo(10, 9);
    expect(box.x1).toBeCloseTo(50, 9);
    expect(box.y0).toBeCloseTo(50, 9);
    // 50 + 3/4 of the 40-unit control offset, and cubicAt agrees.
    expect(box.y1).toBeCloseTo(80, 9);
    expect(cubicAt(b, 0.5)[1]).toBeCloseTo(80, 9);
  });

  it('bulges the other way round, so neither axis can stand in for the other', () => {
    const b: Cubic = [
      [50, 10],
      [90, 10],
      [90, 50],
      [50, 50],
    ];
    const box = cubicBBox(b);
    expect(box.x1).toBeCloseTo(80, 9);
    expect(box.x0).toBeCloseTo(50, 9);
    expect(box.y0).toBeCloseTo(10, 9);
    expect(box.y1).toBeCloseTo(50, 9);
  });

  it('bulges below and left as well as above and right', () => {
    const b: Cubic = [
      [10, 50],
      [10, 10],
      [50, 10],
      [50, 50],
    ];
    const box = cubicBBox(b);
    expect(box.y0).toBeCloseTo(20, 9);
    expect(box.y1).toBeCloseTo(50, 9);
  });

  it('is the segment itself when the curve does not turn', () => {
    // Controls on the thirds: a straight run, no interior root, box is the chord.
    const b: Cubic = [
      [10, 20],
      [20, 30],
      [30, 40],
      [40, 50],
    ];
    expect(cubicBBox(b)).toEqual({ x0: 10, y0: 20, x1: 40, y1: 50 });
  });

  it('never reports a box the curve leaves', () => {
    /* The property behind the four cases above, swept rather than stated: 200
       samples of a curve that turns on both axes, every one inside the box. */
    const b: Cubic = [
      [30, 70],
      [140, 15],
      [-20, 45],
      [95, 120],
    ];
    const box = cubicBBox(b);
    let hit = { x0: false, x1: false, y0: false, y1: false };
    for (let i = 0; i <= 200; i++) {
      const [x, y] = cubicAt(b, i / 200);
      expect(x).toBeGreaterThanOrEqual(box.x0 - 1e-9);
      expect(x).toBeLessThanOrEqual(box.x1 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(box.y0 - 1e-9);
      expect(y).toBeLessThanOrEqual(box.y1 + 1e-9);
      // And the box is tight: something has to touch each side.
      if (Math.abs(x - box.x0) < 0.05) hit.x0 = true;
      if (Math.abs(x - box.x1) < 0.05) hit.x1 = true;
      if (Math.abs(y - box.y0) < 0.05) hit.y0 = true;
      if (Math.abs(y - box.y1) < 0.05) hit.y1 = true;
    }
    expect(hit).toEqual({ x0: true, x1: true, y0: true, y1: true });
  });
});

/**
 * The two questions asked of foreign path data, neither of which had a test.
 *
 * `cubicIsLine` decides whether an imported `C` is stored with null handles and
 * re-emitted as `L`; `cubicAsQuad` decides whether the serialiser writes `Q`
 * instead of `C`. Both change what a saved file says. A mutation sweep on
 * 2026-08-21 left nineteen survivors between them, including `return false`
 * turned to `return true` on the guard that catches a curve doubling back.
 */
describe('recognising a cubic that is really a line', () => {
  it.each([
    ['controls on the thirds', [[10, 20], [20, 30], [30, 40], [40, 50]]],
    ['controls both on the start', [[10, 20], [10, 20], [10, 20], [40, 50]]],
    ['controls both on the end', [[10, 20], [40, 50], [40, 50], [40, 50]]],
    ['controls unevenly spaced along the chord', [[10, 20], [13, 23], [34, 44], [40, 50]]],
    ['a vertical chord', [[10, 20], [10, 30], [10, 40], [10, 50]]],
  ])('says yes: %s', (_name, c) => {
    expect(cubicIsLine(c as Cubic)).toBe(true);
  });

  it.each([
    ['a control off the chord', [[10, 20], [20, 40], [30, 40], [40, 50]]],
    ['a control before the start, so the curve doubles back', [[10, 20], [0, 10], [30, 40], [40, 50]]],
    ['a control past the end, so the curve overshoots', [[10, 20], [20, 30], [50, 60], [40, 50]]],
    ['a bulge with both controls on the same side', [[10, 50], [10, 90], [50, 90], [50, 50]]],
  ])('says no: %s', (_name, c) => {
    expect(cubicIsLine(c as Cubic)).toBe(false);
  });

  it('a span of nothing is a line only when the controls sit on the point', () => {
    expect(cubicIsLine([[30, 40], [30, 40], [30, 40], [30, 40]])).toBe(true);
    expect(cubicIsLine([[30, 40], [35, 40], [30, 40], [30, 40]])).toBe(false);
  });
});

describe('recovering the quadratic a cubic was elevated from', () => {
  /* Built forwards: pick a quadratic, elevate it by the standard formula, and
     require the recovery to name the control it started from. Nothing here is
     at the origin, so a term that must be `p + 2/3 (q - p)` cannot pass as
     `p + 2/3 (q + p)`. */
  const elevate = (p0: [number, number], q: [number, number], p3: [number, number]): Cubic => [
    p0,
    [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
    [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])],
    p3,
  ];

  it.each([
    ['a bend upward', [20, 60], [55, 15], [90, 60]],
    ['a bend the other way', [20, 60], [55, 105], [90, 60]],
    ['an asymmetric one', [-30, 45], [12, -18], [70, 25]],
  ])('recovers the control of %s', (_name, p0, q, p3) => {
    const got = cubicAsQuad(elevate(p0 as [number, number], q as [number, number], p3 as [number, number]));
    expect(got).not.toBeNull();
    expect(got![0]).toBeCloseTo((q as number[])[0], 9);
    expect(got![1]).toBeCloseTo((q as number[])[1], 9);
  });

  it('refuses a cubic that is not an elevated quadratic', () => {
    // The two derivations disagree, which is the whole test: nudging one control
    // off by a unit is a shape no single quadratic control can produce.
    const c = elevate([20, 60], [55, 15], [90, 60]);
    expect(cubicAsQuad([c[0], [c[1][0] + 1, c[1][1]], c[2], c[3]])).toBeNull();
    expect(cubicAsQuad([c[0], c[1], [c[2][0], c[2][1] - 1], c[3]])).toBeNull();
  });

  it('a straight cubic on the thirds is the quadratic through its midpoint', () => {
    const q = cubicAsQuad([[10, 20], [20, 30], [30, 40], [40, 50]]);
    expect(q).not.toBeNull();
    expect(q![0]).toBeCloseTo(25, 9);
    expect(q![1]).toBeCloseTo(35, 9);
  });
});
