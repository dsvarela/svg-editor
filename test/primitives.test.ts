/**
 * Primitives and circle fitting.
 *
 * The question a circle test has to answer is "how round is it", not "are the
 * numbers the ones I wrote down". So these measure: they sample the curve and
 * check the radius, which is the property the drawing actually has, and would
 * catch a handle on the wrong side in a way that comparing coordinates against
 * a fixture would not.
 */

import { describe, expect, it } from 'vitest';
import { KAPPA, arcHandle, ellipseSubpath, fitCircle, rectSubpath } from '../src/core/primitives';
import { circulariseSubpath } from '../src/model/ops';
import { continuityOf, segmentAsCubic, segmentCount } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';
import { cubicAt } from '../src/core/bezier';
import { parsePath } from '../src/core/parse';

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
  it('is four handle-less nodes when square-cornered', () => {
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

  it('rounds corners with quarter arcs and keeps the sides straight', () => {
    const sp = rectSubpath(0, 0, 20, 10, 3);
    expect(sp.nodes).toHaveLength(8);

    // Every second segment is a side, and a side must have no handles at all or
    // it is not straight -- which is the whole reason corners get two nodes.
    const sideStart = [1, 3, 5, 7];
    for (const i of sideStart) {
      const j = (i + 1) % 8;
      const curved = sp.nodes[i].hOut !== null || sp.nodes[j].hIn !== null;
      expect(curved).toBe(true); // i -> i+1 is a corner arc
    }
    for (const i of [0, 2, 4, 6]) {
      const j = i + 1;
      expect(sp.nodes[i].hOut).toBeNull();
      expect(sp.nodes[j].hIn).toBeNull();
    }
  });

  it('clamps the radius to half the shorter side rather than crossing itself', () => {
    const stadium = rectSubpath(0, 0, 20, 10, 999);
    // r clamped to 5: the top edge runs from x = 5 to x = 15.
    expect(stadium.nodes[0].pt).toEqual([5, 0]);
    expect(stadium.nodes[1].pt).toEqual([15, 0]);
    // And the ends are semicircles, so the extent is still the box.
    const xs = samples(stadium).map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(20, 6);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
  });

  it('treats a zero or negative radius as square', () => {
    expect(rectSubpath(0, 0, 8, 8, 0).nodes).toHaveLength(4);
    expect(rectSubpath(0, 0, 8, 8, -3).nodes).toHaveLength(4);
  });
});

describe('fitCircle', () => {
  it('recovers a circle it was given exactly', () => {
    const c: Pt = [17, -5];
    const r = 12;
    const pts: Pt[] = [0, 1, 2, 3, 4].map((k) => {
      const t = (k / 5) * Math.PI * 2;
      return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
    });
    const fit = fitCircle(pts)!;
    expect(fit.centre[0]).toBeCloseTo(17, 9);
    expect(fit.centre[1]).toBeCloseTo(-5, 9);
    expect(fit.radius).toBeCloseTo(12, 9);
  });

  it('averages noise rather than following it', () => {
    // Deterministic wobble of +/- 0.1 on a radius of 10.
    const pts: Pt[] = [];
    for (let k = 0; k < 12; k++) {
      const t = (k / 12) * Math.PI * 2;
      const r = 10 + (k % 2 ? 0.1 : -0.1);
      pts.push([r * Math.cos(t), r * Math.sin(t)]);
    }
    const fit = fitCircle(pts)!;
    expect(Math.hypot(...fit.centre)).toBeLessThan(0.02);
    expect(fit.radius).toBeCloseTo(10, 2);
  });

  it('refuses collinear points and short lists', () => {
    expect(fitCircle([[0, 0], [1, 1], [2, 2], [3, 3]])).toBeNull();
    expect(fitCircle([[0, 0], [1, 0]])).toBeNull();
  });

  it('is not thrown by points a long way from the origin', () => {
    const c: Pt = [1e6, -1e6];
    const pts: Pt[] = [0, 1, 2, 3].map((k) => {
      const t = (k / 4) * Math.PI * 2;
      return [c[0] + 5 * Math.cos(t), c[1] + 5 * Math.sin(t)];
    });
    const fit = fitCircle(pts)!;
    expect(fit.radius).toBeCloseTo(5, 6);
    expect(fit.centre[0]).toBeCloseTo(1e6, 3);
  });
});

describe('circulariseSubpath', () => {
  it('makes a wobbly ring exactly round', () => {
    const sp = ellipseSubpath(0, 0, 10, 10);
    // Push every node off the circle by a different amount.
    sp.nodes.forEach((n, i) => {
      const f = 1 + (i - 1.5) * 0.06;
      n.pt = [n.pt[0] * f, n.pt[1] * f];
    });
    expect(roundness(sp, [0, 0], 10)).toBeGreaterThan(0.02);

    const r = circulariseSubpath(sp)!;
    expect(r.radius).toBeCloseTo(10, 1);

    // The anchors land on the circle exactly; that part has no tolerance.
    for (const n of sp.nodes) {
      expect(Math.hypot(n.pt[0] - r.centre[0], n.pt[1] - r.centre[1])).toBeCloseTo(r.radius, 12);
    }
    // The curve between them is as round as its arcs allow. The bound is looser
    // than a quarter arc's 2.7e-4 because the fitted centre shifts off the
    // original one, which leaves the four spans no longer exactly 90 degrees.
    expect(roundness(sp, r.centre, r.radius)).toBeLessThan(5e-4);
  });

  it('leaves an already exact circle where it is', () => {
    const sp = ellipseSubpath(4, 4, 7, 7);
    const before = samples(sp);
    const r = circulariseSubpath(sp)!;
    expect(r.moved).toBeLessThan(1e-9);
    samples(sp).forEach((p, i) => {
      expect(p[0]).toBeCloseTo(before[i][0], 9);
      expect(p[1]).toBeCloseTo(before[i][1], 9);
    });
  });

  it('is as round with uneven nodes as with even ones', () => {
    // Three nodes bunched into half the circle and two spread over the rest:
    // the per-arc handle length is what keeps this exact.
    const angles = [0, 0.4, 0.9, 2.6, 4.6];
    const sp: Subpath = {
      nodes: angles.map((t) => ({
        pt: [9 * Math.cos(t), 9 * Math.sin(t)] as Pt,
        hIn: null,
        hOut: null,
      })),
      closed: true,
    };
    const r = circulariseSubpath(sp)!;
    for (const n of sp.nodes) {
      expect(Math.hypot(n.pt[0] - r.centre[0], n.pt[1] - r.centre[1])).toBeCloseTo(r.radius, 12);
    }
    // The widest gap here spans about 96 degrees, and a cubic's radial error
    // climbs steeply with the arc it covers -- so the ceiling is the span's,
    // not the method's. Even spacing gets the 2.7e-4 the ellipse test asserts.
    expect(roundness(sp, r.centre, r.radius)).toBeLessThan(2e-3);
  });

  it('reports how far the furthest node had to move', () => {
    const sp = ellipseSubpath(0, 0, 10, 10);
    sp.nodes[2].pt = [-13, 0];
    const r = circulariseSubpath(sp)!;
    // The fit splits the difference: pulling one node 3 units out drags the
    // fitted circle after it, so the node travels back well under 3.
    expect(r.moved).toBeGreaterThan(0.5);
    expect(r.moved).toBeLessThan(3);
  });

  it('opens an arc without closing it', () => {
    // Three points on the circle of radius 10 about the origin: 0, 45 and 90
    // degrees. Anything else and "nothing moves" would be false.
    const sp = parsePath('M10 0 L7.0710678118654755 7.0710678118654755 L0 10')[0];
    expect(sp.closed).toBe(false);
    const r = circulariseSubpath(sp)!;
    expect(sp.closed).toBe(false);
    // Three points determine a circle exactly, so nothing moves.
    expect(r.moved).toBeLessThan(1e-9);
    expect(r.radius).toBeCloseTo(10, 6);
    // The last node ends a path, so it keeps no outgoing handle.
    expect(sp.nodes[2].hOut).toBeNull();
    expect(sp.nodes[0].hIn).toBeNull();
  });

  it('refuses what is not a circle to begin with', () => {
    expect(circulariseSubpath(parsePath('M0 0 L10 0')[0])).toBeNull();
    expect(circulariseSubpath(parsePath('M0 0 L5 5 L10 10 L15 15')[0])).toBeNull();
  });
});
