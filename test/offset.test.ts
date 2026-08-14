/**
 * A path parallel to another.
 *
 * Measured, not compared. An offset is defined by a property -- every point of
 * it is the same distance from the original -- so the tests check that property
 * by sampling both curves densely, rather than asserting control points that
 * would encode one particular approximation and break on any improvement to it.
 */

import { describe, expect, it } from 'vitest';
import { offsetSubpath, strokeOutline } from '../src/core/offset';
import { parsePath } from '../src/core/parse';
import { cubicAt } from '../src/core/bezier';
import { continuityOf, makeNode, segmentAsCubic, segmentCount } from '../src/core/types';
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

/** An open path that turns sharply, four times, and never closes. */
const ZIGZAG = 'M0 40 L15 0 L30 40 L45 0 L60 40';

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

/**
 * How long the path is, end to end.
 *
 * The measure `worstDeviation` cannot take. It asks of each point of the offset
 * "is this the right distance from the original", and every point of a piece
 * that should not be there, or of an offset missing a piece, answers yes: what
 * is left is still parallel. Length is what notices that there is less of it.
 */
function lengthOf(sp: Subpath, per = 400): number {
  const pts = dense(sp, per);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return total;
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
    expect(offsetSubpath({ nodes: [makeNode([0, 0])], closed: false }, 5)).toBeNull();
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
       stop being connected, and the answer is two paths. The wrong answer is one
       path with a segment drawn across the gap. */
    const sp = path('M0 0 L20 30 L40 0 L40 40 L0 40 Z');
    const out = offsetSubpath(sp, -8, 0.02);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2);
    // One either side of the notch, rather than two copies of the same place.
    const mid = (o: Subpath): number =>
      dense(o, 40).reduce((a, p) => a + p[0], 0) / dense(o, 40).length;
    expect(Math.abs(mid(out![0]) - mid(out![1]))).toBeGreaterThan(10);
  });

  it('holds the distance on the pieces too', () => {
    /* This asserted a residual of 1.14 for a while, and the residual was in
       the measurement: `NearMap` used one number for its grid cells and for its
       polyline, so making queries cheap made the source coarse -- a forty-unit
       edge got seven points along it. The deviation stayed at exactly 1.1349
       through three attempts to fix the geometry, which is what eventually said
       the geometry was not what was wrong. */
    const sp = path('M0 0 L20 30 L40 0 L40 40 L0 40 Z');
    const out = offsetSubpath(sp, -8, 0.02)!;
    let worst = 0;
    for (const o of out) worst = Math.max(worst, worstDeviation(sp, o, 8));
    expect(worst).toBeLessThan(0.05);
  });
});

describe('how much of it there is', () => {
  /* Length, where the tests above measure distance. The two catch different
     mistakes: a distance measure is blind to an offset that stops early or
     doubles back over itself, because the part that is there is parallel and
     that is all it asks. These four have an answer arithmetic can supply, so
     nothing here is copied from a run. */

  it('is as long as the geometry says a parallel curve is', () => {
    // A circle offset outward is a circle of the larger radius, and its
    // circumference is that radius times two pi.
    expect(lengthOf(one(path(CIRCLE), 5, 0.02))).toBeCloseTo(2 * Math.PI * 25, 1);
    expect(lengthOf(one(path(CIRCLE), -5, 0.02))).toBeCloseTo(2 * Math.PI * 15, 1);
  });

  it('adds one whole turn of join going round a square, and no length at all coming in', () => {
    /* Outward, the four sides keep their length and the four round joins add a
       quarter turn each: one full circle of radius 4 between them, however the
       corners are distributed. Inward there are no joins, and a 40-unit square
       inset by 4 is a 32-unit square. */
    const sq = path('M0 0 H40 V40 H0 Z');
    expect(lengthOf(one(sq, 4, 0.02))).toBeCloseTo(160 + 2 * Math.PI * 4, 1);
    expect(lengthOf(one(sq, -4, 0.02))).toBeCloseTo(128, 1);
  });
});

describe('how many pieces come back', () => {
  it('keeps an open path whole where its corners still have room', () => {
    /* Each vertex turns through 41.1 degrees, so offsetting into it trims
       6 / tan(20.56 deg) = 16.0 units off each arm, and the arms are
       hypot(15, 40) = 42.7 long. An interior arm loses 16 at each end and has
       10.7 left, so nothing is consumed and the answer is one path either side.
       The suite had no open path that turned sharply at all, and every way of
       cutting this one into two or three passed. */
    const sp = path(ZIGZAG);
    for (const d of [6, -6]) {
      const out = offsetSubpath(sp, d, 0.02);
      expect(out).toHaveLength(1);
      expect(out![0].closed).toBe(false);
      expect(worstDeviation(sp, out![0], d)).toBeLessThan(0.05);
    }
  });

  it('keeps it whole once the trim is deeper than the arms are long', () => {
    /* At 24 the trim is 65.8 against arms of 42.7, so every arm is eaten
       through. What that removes is the two ends, not the middle: the part of
       the offset that survives is the far side of the middle valley, which is
       one connected run and not three. */
    const out = offsetSubpath(path(ZIGZAG), -24, 0.02);
    expect(out).toHaveLength(1);
    expect(worstDeviation(path(ZIGZAG), out![0], 24)).toBeLessThan(0.05);
  });
});

describe('the corners it should and should not have', () => {
  /* A corner in the result is a claim that the offset changes direction
     abruptly there, and the model reads that claim off the handles rather than
     storing it. So a node that should be smooth and is not is a real defect
     even when every point is still the right distance away: it is the tangent
     that is wrong, not the position, and no distance measure can see it. */

  const cornersOf = (sp: Subpath): number =>
    sp.nodes.filter((n) => continuityOf(n) === 'corner').length;

  it('leaves none on the offset of a circle, which is another circle', () => {
    expect(cornersOf(one(path(CIRCLE), 5, 0.02))).toBe(0);
    expect(cornersOf(one(path(CIRCLE), -5, 0.02))).toBe(0);
  });

  it('leaves none going round the outside of a square', () => {
    // Four straight runs and four arcs, and an arc leaves its straight run at a
    // tangent, so there is no corner anywhere on it.
    expect(cornersOf(one(path('M0 0 H40 V40 H0 Z'), 4, 0.02))).toBe(0);
  });

  it('puts one where a trimmed corner lands on the path’s own seam', () => {
    /* Offsetting the notch outward trims at its tip, and the tip's bisector at
       8 / sin(33.7 deg) = 14.42 is where the seam of this path already is. The
       seam takes its tangents from the original only when the filter took
       nothing; here it took a cut whose offcut was too short to keep, which
       read as nothing having been cut. That left the node a cusp: handles
       collinear, so the model called it smooth, and the outgoing one pointing
       back the way the curve had arrived. It measured 0.059 out against 0.012
       everywhere else on the same shape. */
    const sp = path('M0 0 L20 30 L40 0 L40 40 L0 40 Z');
    const out = one(sp, 8, 0.02);
    expect(cornersOf(out)).toBe(1);
    expect(worstDeviation(sp, out, 8)).toBeLessThan(0.03);
  });

  it('keeps all four coming in, where the sides really do meet at a point', () => {
    // The inward offset of a square is a smaller square. Rounding those would
    // be the same mistake in the other direction.
    expect(cornersOf(one(path('M0 0 H40 V40 H0 Z'), -4, 0.02))).toBe(4);
  });
});

describe('stroke to path', () => {
  /* Two offsets joined up, so the geometry is the offset's and what is tested
     here is the joining: which contours come back, which way they wind, and
     where the caps go. Measured the same way -- every point of the outline is
     half the width from the original, except across a butt cap, which is the
     one part of the outline that is not an offset. */

  const outline = (d: string, w: number, cap: 'butt' | 'round' = 'butt'): Subpath[] => {
    const out = strokeOutline(path(d), w, cap, 0.02);
    expect(out).not.toBeNull();
    return out!;
  };

  it('gives a closed path two contours, which is what makes it a ring', () => {
    /* One loop would be a filled disc. The band between two loops is what a
       stroke looks like, and it needs them wound in opposite directions. */
    const out = outline(CIRCLE, 6);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.closed)).toBe(true);

    const area = (o: Subpath): number => {
      const pts = dense(o, 200);
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return a / 2;
    };
    // Opposite signs: one clockwise, one anticlockwise.
    expect(Math.sign(area(out[0]))).toBe(-Math.sign(area(out[1])));
  });

  it('holds half the width all the way round a closed path', () => {
    const sp = path(CIRCLE);
    for (const o of outline(CIRCLE, 6)) {
      expect(worstDeviation(sp, o, 3)).toBeLessThan(0.05);
    }
  });

  it('gives an open path one contour, closed', () => {
    const out = outline('M10 20 L50 20', 6);
    expect(out).toHaveLength(1);
    expect(out[0].closed).toBe(true);
  });

  it('rounds the caps on the outside of the ends, not back over the stroke', () => {
    /* The two ends of a cap are exactly opposite each other, so the sweep
       between them is half a turn and its sign is a coin toss. The wrong toss
       puts the cap back over the stroke, and the drawing still looks like a
       stroke until you notice the ends are dented. */
    const sp = path('M10 20 L50 20');
    const out = outline('M10 20 L50 20', 6, 'round');
    expect(worstDeviation(sp, out[0], 3)).toBeLessThan(0.05);
    // It reaches past both ends, by half the width.
    const xs = dense(out[0], 120).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(7, 1);
    expect(Math.max(...xs)).toBeCloseTo(53, 1);
  });

  it('cuts a butt cap straight across the end', () => {
    // Which is the one part of the outline that is not at half the width: the
    // middle of the cap sits on the path's own end.
    const out = outline('M10 20 L50 20', 6, 'butt');
    const xs = dense(out[0], 120).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(10, 3);
    expect(Math.max(...xs)).toBeCloseTo(50, 3);
  });

  it('refuses a width of zero, which has no outline', () => {
    expect(strokeOutline(path(CIRCLE), 0)).toBeNull();
    expect(strokeOutline(path(CIRCLE), Number.NaN)).toBeNull();
  });

  it('refuses a width the shape cannot hold at all', () => {
    /* 60 on a 40-unit square: the inner offset does not come apart, it comes
       back with nothing, and the refusal is the empty check rather than the
       count. Written for the count check and never reaching it, which is what
       the test below is for. */
    expect(offsetSubpath(path('M0 0 H40 V40 H0 Z'), -30, 0.05)).toBeNull();
    expect(strokeOutline(path('M0 0 H40 V40 H0 Z'), 60, 'butt', 0.05)).toBeNull();
  });

  it('refuses when a side comes apart, rather than guessing how to pair it', () => {
    /* The notched rectangle, whose inner offset at 8 separates into two pieces
       while the outer stays one. There is no single other side to pair each
       piece with, so the outline is refused. */
    const NOTCH = 'M0 0 L20 30 L40 0 L40 40 L0 40 Z';
    expect(offsetSubpath(path(NOTCH), -8, 0.02)).toHaveLength(2);
    expect(offsetSubpath(path(NOTCH), 8, 0.02)).toHaveLength(1);
    expect(strokeOutline(path(NOTCH), 16, 'butt', 0.02)).toBeNull();
  });
});
