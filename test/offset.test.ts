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

/**
 * The offset, as one subpath.
 *
 * `offsetSubpath` returns a list, because an offset can come apart into pieces.
 * Most of these fixtures do not, and unwrapping here keeps each test about the
 * one thing it is measuring -- the case that does come apart has its own test
 * and checks the count.
 */
const one = (sp: Subpath, d: number, tol?: number): Subpath => {
  const out = offsetSubpath(sp, d, tol);
  expect(out).not.toBeNull();
  expect(out!.length).toBe(1);
  return out![0];
};

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
    const off = one(sp, 5, 0.02);
    expect(worstDeviation(sp, off, 5)).toBeLessThan(0.02);
  });

  it('holds it around a circle', () => {
    const sp = path(CIRCLE);
    expect(worstDeviation(sp, one(sp, 5, 0.02), 5)).toBeLessThan(0.05);
  });

  it('holds it through an inflection', () => {
    // An S-curve changes which side its centre of curvature is on, which is
    // where an offset computed by scaling handles goes wrong.
    const sp = path('M0 0 C20 0 20 40 40 40');
    expect(worstDeviation(sp, one(sp, 3, 0.02), 3)).toBeLessThan(0.05);
  });

  it('holds it around corners, which is what the joins are for', () => {
    /* `M0 0 H40 V40 H0 Z` runs clockwise in y-down coordinates, so the left of
       travel is outward and a positive distance is the outside. Every corner
       gains a quarter turn of round join. */
    const sp = path('M0 0 H40 V40 H0 Z');
    expect(worstDeviation(sp, one(sp, 4, 0.02), 4)).toBeLessThan(0.05);
  });

  it('gets finer when asked', () => {
    const sp = path(CIRCLE);
    const coarse = worstDeviation(sp, one(sp, 5, 1), 5);
    const fine = worstDeviation(sp, one(sp, 5, 0.01), 5);
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
    const out = one(sp, 5, 0.02);
    const inn = one(sp, -5, 0.02);
    const radius = (s: Subpath): number => Math.hypot(s.nodes[0].pt[0] - 20, s.nodes[0].pt[1] - 20);
    expect(radius(out)).toBeCloseTo(25, 2);
    expect(radius(inn)).toBeCloseTo(15, 2);
  });
});

describe('what it keeps and what it refuses', () => {
  it('keeps a closed path closed and an open one open', () => {
    expect(one(path(CIRCLE), 4, 0.05).closed).toBe(true);
    expect(one(path('M0 0 L40 0'), 4, 0.05).closed).toBe(false);
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
    expect(worstDeviation(sp, one(sp, 5, 0.05), 5)).toBeLessThan(0.05);
  });

  it('produces fewer nodes than it sampled', () => {
    /* The fitter is doing its job: a circle offset is another circle, and four
       cubics describe one. A result with a node per sample would be parallel
       and useless. */
    expect(one(path(CIRCLE), 5, 0.02).nodes.length).toBeLessThan(20);
  });
});

describe('the overrun, and what is left of it', () => {
  /* Where a corner is offset further than it can hold, the raw offset runs past
     itself. Chen and McMains (2005) settle what to keep -- the invalid parts
     bound regions of non-positive winding number -- and the local form of that
     rule is a distance: a raw-offset point is on the true offset only if it is
     `|d|` from the original, since anything nearer is inside the disc swept
     along the curve. The samples are filtered on exactly that. */

  it('is exact on the inside of a corner, which used to be four units out', () => {
    const sp = path('M0 0 H40 V40 H0 Z');
    const inward = one(sp, -4, 0.02);
    expect(worstDeviation(sp, inward, 4)).toBeLessThan(0.05);
    // A 40-unit square inward by 4 is a 32-unit square, and nothing else.
    const pts = dense(inward, 60);
    expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(4, 1);
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(36, 1);
    expect(inward.closed).toBe(true);
  });

  it('returns nothing when the offset consumes the shape', () => {
    // A 40-unit square has no point 25 from every edge.
    expect(offsetSubpath(path('M0 0 H40 V40 H0 Z'), -25, 0.05)).toBeNull();
  });

  it('comes apart into pieces when the shape cannot hold the offset', () => {
    /* A rectangle with a deep notch. Eight units in, the two sides of the notch
       stop being connected, and the answer is two paths. Returning one, with a
       segment drawn across the gap, is what this used to do. */
    const sp = path('M0 0 L20 30 L40 0 L40 40 L0 40 Z');
    const out = offsetSubpath(sp, -8, 0.02);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2);
    // One either side of the notch, rather than two copies of the same place.
    const mid = (o: Subpath): number =>
      dense(o, 40).reduce((a, p) => a + p[0], 0) / dense(o, 40).length;
    expect(Math.abs(mid(out![0]) - mid(out![1]))).toBeGreaterThan(10);
  });

  it('still bulges through invalid space between two valid samples', () => {
    /* What is left. The filter removes invalid *samples*; a curve fitted
       between two valid ones can still pass through the space between them,
       and near a break that space is where the overrun was. On the notched
       shape above it reaches 1.14 on an eight-unit offset -- down from 6.8
       before the filter, and not zero.
       
       Closing it needs a validation pass over the fitted curves, refitting
       wherever the same distance criterion fails. Stroke to path needs that,
       because the two offsets of a stroke meet at every cap. */
    const sp = path('M0 0 L20 30 L40 0 L40 40 L0 40 Z');
    const out = offsetSubpath(sp, -8, 0.02)!;
    let worst = 0;
    for (const o of out) worst = Math.max(worst, worstDeviation(sp, o, 8));
    expect(worst).toBeGreaterThan(0.1);
    expect(worst).toBeLessThan(1.5);
  });
});
