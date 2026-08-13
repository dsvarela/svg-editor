/**
 * A path parallel to another.
 *
 * Measured, not compared. An offset is defined by a property -- every point of
 * it is the same distance from the original -- so the tests check that property
 * by sampling both curves densely, rather than asserting control points that
 * would encode one particular approximation and break on any improvement to it.
 */

import { describe, expect, it } from 'vitest';
import { offsetSubpath } from '../src/core/offset';
import { parsePath } from '../src/core/parse';
import { cubicAt } from '../src/core/bezier';
import { segmentAsCubic, segmentCount } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';

const path = (d: string): Subpath => parsePath(d)[0];

/** A circle of radius 20 about (20, 20), as four cubics. */
const CIRCLE =
  'M20 0 C31.05 0 40 8.95 40 20 C40 31.05 31.05 40 20 40 C8.95 40 0 31.05 0 20 C0 8.95 8.95 0 20 0 Z';

/** Points along a subpath, enough of them to measure against. */
function dense(sp: Subpath, per = 400): Pt[] {
  const out: Pt[] = [];
  const n = segmentCount(sp);
  for (let s = 0; s < n; s++) {
    const c = segmentAsCubic(sp, s);
    for (let i = 0; i <= per; i++) out.push(cubicAt(c, i / per) as Pt);
  }
  return out;
}

const nearest = (pts: Pt[], p: Pt): number =>
  pts.reduce((m, q) => Math.min(m, Math.hypot(q[0] - p[0], q[1] - p[1])), Infinity);

/** The worst departure from `d` anywhere along the offset. */
function worstDeviation(sp: Subpath, off: Subpath, d: number): number {
  const src = dense(sp);
  let worst = 0;
  for (const p of dense(off, 120)) worst = Math.max(worst, Math.abs(nearest(src, p) - Math.abs(d)));
  return worst;
}

describe('the offset is parallel', () => {
  it('holds the distance along a straight run', () => {
    const sp = path('M0 0 L40 0');
    const off = offsetSubpath(sp, 5, 0.02)!;
    expect(off).not.toBeNull();
    expect(worstDeviation(sp, off, 5)).toBeLessThan(0.02);
  });

  it('holds it around a circle', () => {
    const sp = path(CIRCLE);
    expect(worstDeviation(sp, offsetSubpath(sp, 5, 0.02)!, 5)).toBeLessThan(0.05);
  });

  it('holds it through an inflection', () => {
    // An S-curve changes which side its centre of curvature is on, which is
    // where an offset computed by scaling handles goes wrong.
    const sp = path('M0 0 C20 0 20 40 40 40');
    expect(worstDeviation(sp, offsetSubpath(sp, 3, 0.02)!, 3)).toBeLessThan(0.05);
  });

  it('holds it around corners, which is what the joins are for', () => {
    /* `M0 0 H40 V40 H0 Z` runs clockwise in y-down coordinates, so the left of
       travel is outward and a positive distance is the outside. Every corner
       gains a quarter turn of round join. */
    const sp = path('M0 0 H40 V40 H0 Z');
    expect(worstDeviation(sp, offsetSubpath(sp, 4, 0.02)!, 4)).toBeLessThan(0.05);
  });

  it('gets finer when asked', () => {
    const sp = path(CIRCLE);
    const coarse = worstDeviation(sp, offsetSubpath(sp, 5, 1)!, 5);
    const fine = worstDeviation(sp, offsetSubpath(sp, 5, 0.01)!, 5);
    expect(fine).toBeLessThan(coarse);
    expect(fine).toBeLessThan(0.05);
  });
});

describe('which side it lands on', () => {
  it('goes outward for a positive distance and inward for a negative one', () => {
    /* Sidedness cannot be caught by a distance test: both sides are the same
       distance away. The circle is the case where it is checkable, since the
       radius says which side you are on. */
    const sp = path(CIRCLE);
    const out = offsetSubpath(sp, 5, 0.02)!;
    const inn = offsetSubpath(sp, -5, 0.02)!;
    const radius = (s: Subpath): number => Math.hypot(s.nodes[0].pt[0] - 20, s.nodes[0].pt[1] - 20);
    expect(radius(out)).toBeCloseTo(25, 2);
    expect(radius(inn)).toBeCloseTo(15, 2);
  });
});

describe('what it keeps and what it refuses', () => {
  it('keeps a closed path closed and an open one open', () => {
    expect(offsetSubpath(path(CIRCLE), 4, 0.05)!.closed).toBe(true);
    expect(offsetSubpath(path('M0 0 L40 0'), 4, 0.05)!.closed).toBe(false);
  });

  it('refuses a distance of zero, which is the path you already have', () => {
    expect(offsetSubpath(path(CIRCLE), 0)).toBeNull();
    expect(offsetSubpath(path(CIRCLE), Number.NaN)).toBeNull();
  });

  it('refuses a subpath with no segment to offset', () => {
    expect(offsetSubpath({ nodes: [{ pt: [0, 0], hIn: null, hOut: null }], closed: false }, 5)).toBeNull();
  });

  it('survives a segment of zero length, which has no tangent', () => {
    // Two coincident nodes: the derivative vanishes, and a normal cannot be
    // taken from nothing. The rest of the path still offsets.
    const sp = path('M0 0 L0 0 L40 0');
    const off = offsetSubpath(sp, 5, 0.05);
    expect(off).not.toBeNull();
    expect(worstDeviation(sp, off!, 5)).toBeLessThan(0.05);
  });

  it('produces fewer nodes than it sampled', () => {
    /* The fitter is doing its job: a circle offset is another circle, and four
       cubics describe one. A result with a node per sample would be parallel
       and useless. */
    expect(offsetSubpath(path(CIRCLE), 5, 0.02)!.nodes.length).toBeLessThan(20);
  });
});

describe('the limitation, stated as a measurement', () => {
  /* On the inside of a corner the two neighbouring offsets overrun each other,
     so the sampled polyline doubles back on itself -- and a curve fitted
     through a sequence that doubles back does not merely loop, it leaves the
     offset altogether. Measured rather than described, because "it loops" is
     the comfortable version and it is not what happens.

     Removing the overrun before fitting is a topology question. Two routes were
     tried and neither shipped; they are recorded in the shopping list under
     Stroke to path, which needs the answer and cannot ship without it. */

  it('departs from the distance at a concave corner, by as much as the offset', () => {
    const sp = path('M0 0 H40 V40 H0 Z');
    const inward = offsetSubpath(sp, -4, 0.02)!;
    const worst = worstDeviation(sp, inward, 4);
    expect(worst).toBeGreaterThan(1);
    // Bounded, at least: it does not run off to infinity.
    expect(worst).toBeLessThan(4.5);
  });

  it('is exact on the same corner from the outside', () => {
    // The same shape, the same distance, the other side: this is what says the
    // failure is the overrun and not the corner handling in general.
    const sp = path('M0 0 H40 V40 H0 Z');
    expect(worstDeviation(sp, offsetSubpath(sp, 4, 0.02)!, 4)).toBeLessThan(0.05);
  });
});
