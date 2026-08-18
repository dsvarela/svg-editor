/**
 * Primitives: the ellipse and the rectangle the two draw tools build.
 *
 * The question a circle test has to answer is "how round is it", not "are the
 * numbers the ones I wrote down". So these measure: they sample the curve and
 * check the radius, which is the property the drawing actually has, and would
 * catch a handle on the wrong side in a way that comparing coordinates against
 * a fixture would not.
 */

import { describe, expect, it } from 'vitest';
import { KAPPA, arcHandle, ellipseSubpath, rectSubpath } from '../src/core/primitives';
import { continuityOf, segmentAsCubic, segmentCount } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';
import { cubicAt } from '../src/core/bezier';

/** Dense samples along every segment of a subpath. */
function samples(sp: Subpath, per = 64): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < segmentCount(sp); i++) {
    const c = segmentAsCubic(sp, i);
    for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per));
  }
  return out;
}

/** Worst radial error of a sampled curve against a circle, as a fraction of r. */
function roundness(sp: Subpath, centre: Pt, r: number): number {
  let worst = 0;
  for (const p of samples(sp)) {
    worst = Math.max(worst, Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - r));
  }
  return worst / r;
}

describe('the circle constant', () => {
  it('is 4/3 (sqrt 2 - 1), and the general arc formula agrees at a quarter turn', () => {
    expect(KAPPA).toBeCloseTo(0.5522847498307936, 15);
    expect(arcHandle(1, Math.PI / 2)).toBeCloseTo(KAPPA, 15);
  });

  it('shrinks toward the chord as the arc gets shorter', () => {
    // A vanishing arc needs a handle a third of the way along it, which is what
    // makes a nearly straight segment nearly a straight line.
    const tiny = arcHandle(1, 1e-4);
    expect(tiny / (1 * 1e-4)).toBeCloseTo(1 / 3, 6);
  });
});

describe('ellipseSubpath', () => {
  it('draws a circle that is round to better than 0.03 %', () => {
    const sp = ellipseSubpath(10, -4, 6, 6);
    // The known ceiling for four cubics is about 2.7e-4 of the radius. Asserting
    // the published figure rather than a slack one means a wrong handle length
    // fails here rather than passing by a wide margin.
    expect(roundness(sp, [10, -4], 6)).toBeLessThan(2.8e-4);
  });

  it('puts four nodes on the axes and closes', () => {
    const sp = ellipseSubpath(0, 0, 8, 3);
    expect(sp.closed).toBe(true);
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [8, 0],
      [0, 3],
      [-8, 0],
      [0, -3],
    ]);
  });

  it('comes out symmetric at every node, with nothing declared', () => {
    const sp = ellipseSubpath(3, 3, 5, 2);
    for (const n of sp.nodes) expect(continuityOf(n)).toBe('symmetric');
  });

  it('bounds an ellipse of the right extent', () => {
    const pts = samples(ellipseSubpath(0, 0, 10, 4));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(10, 6);
    expect(Math.min(...xs)).toBeCloseTo(-10, 6);
    expect(Math.max(...ys)).toBeCloseTo(4, 6);
    expect(Math.min(...ys)).toBeCloseTo(-4, 6);
  });
});

describe('rectSubpath', () => {
  it('is four handle-less nodes', () => {
    const sp = rectSubpath(2, 3, 10, 6);
    expect(sp.closed).toBe(true);
    expect(sp.nodes).toHaveLength(4);
    for (const n of sp.nodes) {
      expect(n.hIn).toBeNull();
      expect(n.hOut).toBeNull();
    }
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [2, 3],
      [12, 3],
      [12, 9],
      [2, 9],
    ]);
  });

  it('normalises a drag that went up and to the left', () => {
    expect(rectSubpath(12, 9, -10, -6).nodes.map((n) => n.pt)).toEqual(
      rectSubpath(2, 3, 10, 6).nodes.map((n) => n.pt),
    );
  });

});
