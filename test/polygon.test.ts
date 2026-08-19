/**
 * The polygon and star generator.
 *
 * Measured as geometry rather than compared to a fixture of coordinates. A list
 * of expected numbers passes for whatever the generator produced on the day it
 * was written, including a pentagon with one side slightly wrong; "every side is
 * the same length" cannot.
 *
 * The straightness check is the one with a consequence elsewhere: a node with a
 * handle on either side is not a corner `cornerAt` will round (§48), so a
 * polygon built out of curves would draw the same and silently refuse Round.
 */

import { describe, expect, it } from 'vitest';
import { polygonSubpath } from '../src/core/primitives';
import type { Pt, Subpath } from '../src/core/types';

const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Every side length, in order, wrapping the closing side. */
function sides(sp: Subpath): number[] {
  return sp.nodes.map((n, i) => dist(n.pt, sp.nodes[(i + 1) % sp.nodes.length].pt));
}

const radii = (sp: Subpath, c: Pt): number[] => sp.nodes.map((n) => dist(n.pt, c));

describe('a regular polygon', () => {
  it('has as many nodes as it has corners, and closes', () => {
    for (const n of [3, 4, 5, 6, 12]) {
      const sp = polygonSubpath(0, 0, 10, 10, n);
      expect(sp.nodes).toHaveLength(n);
      expect(sp.closed).toBe(true);
    }
  });

  it('is regular: every side the same, every corner the same distance out', () => {
    const sp = polygonSubpath(5, 7, 10, 10, 7);
    const s = sides(sp);
    for (const len of s) expect(len).toBeCloseTo(s[0], 9);
    for (const r of radii(sp, [5, 7])) expect(r).toBeCloseTo(10, 9);
  });

  /* A pentagon rotated a tenth of a turn reads as a wrong pentagon rather than
     as a rotated one, and a star far more so. */
  it('starts at the top', () => {
    const sp = polygonSubpath(5, 7, 10, 4, 5);
    expect(sp.nodes[0].pt[0]).toBeCloseTo(5, 9);
    expect(sp.nodes[0].pt[1]).toBeCloseTo(3, 9);
  });

  /* Straight sides on both edges of every node is what `cornerAt` needs, so a
     polygon is roundable everywhere. */
  it('has no handles at all, so Round can reach every corner', () => {
    const sp = polygonSubpath(0, 0, 10, 10, 6);
    for (const n of sp.nodes) {
      expect(n.hIn).toBeNull();
      expect(n.hOut).toBeNull();
    }
  });

  it('follows the box it is given rather than forcing itself circular', () => {
    const sp = polygonSubpath(0, 0, 20, 5, 4);
    const xs = sp.nodes.map((n) => n.pt[0]);
    const ys = sp.nodes.map((n) => n.pt[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 9);
  });

  /* A drag up and to the left hands over negative radii, and the shape has to
     land where the pointer is rather than mirrored away from it. A polygon
     reflected through its own centre is the same polygon, so this costs
     nothing on screen and saves the caller an abs. */
  it('takes a negative radius as the same shape, not as an empty one', () => {
    const up = polygonSubpath(0, 0, -10, -10, 5);
    expect(up.nodes).toHaveLength(5);
    const s = sides(up);
    for (const len of s) expect(len).toBeCloseTo(s[0], 9);
    for (const r of radii(up, [0, 0])) expect(r).toBeCloseTo(10, 9);
  });
});

describe('a star', () => {
  it('has twice as many nodes as points, alternating out and in', () => {
    const sp = polygonSubpath(0, 0, 10, 10, 5, 0.4);
    expect(sp.nodes).toHaveLength(10);
    const r = radii(sp, [0, 0]);
    r.forEach((v, i) => expect(v).toBeCloseTo(i % 2 === 0 ? 10 : 4, 9));
  });

  it('puts a point at the top, not a notch', () => {
    const sp = polygonSubpath(0, 0, 10, 10, 5, 0.4);
    expect(sp.nodes[0].pt[1]).toBeCloseTo(-10, 9);
  });

  it('is symmetric: the two sides of every point are the same length', () => {
    const s = sides(polygonSubpath(0, 0, 10, 10, 6, 0.5));
    for (const len of s) expect(len).toBeCloseTo(s[0], 9);
  });

  it('is a polygon when the ratio is 1, which is the degenerate star', () => {
    const star = polygonSubpath(0, 0, 10, 10, 5, 1);
    for (const r of radii(star, [0, 0])) expect(r).toBeCloseTo(10, 9);
  });
});

describe('numbers a person can type', () => {
  it('clamps a corner count below three, which is not a polygon', () => {
    expect(polygonSubpath(0, 0, 10, 10, 2).nodes).toHaveLength(3);
    expect(polygonSubpath(0, 0, 10, 10, -4).nodes).toHaveLength(3);
    expect(polygonSubpath(0, 0, 10, 10, 0).nodes).toHaveLength(3);
  });

  it('clamps a corner count above what is distinguishable', () => {
    expect(polygonSubpath(0, 0, 10, 10, 500).nodes).toHaveLength(60);
  });

  it('rounds a fractional count rather than producing a fractional shape', () => {
    expect(polygonSubpath(0, 0, 10, 10, 5.4).nodes).toHaveLength(5);
    expect(polygonSubpath(0, 0, 10, 10, 5.6).nodes).toHaveLength(6);
  });

  it('keeps a star with a ratio of zero drawable', () => {
    const sp = polygonSubpath(0, 0, 10, 10, 5, 0);
    // Every inner node still has somewhere to be, so no side is zero-length.
    for (const len of sides(sp)) expect(len).toBeGreaterThan(0);
  });

  it('clamps a ratio above one back to the outer radius', () => {
    const sp = polygonSubpath(0, 0, 10, 10, 5, 4);
    for (const r of radii(sp, [0, 0])) expect(r).toBeCloseTo(10, 9);
  });
});
