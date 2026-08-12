/**
 * Knot removal: taking out nodes that are not doing anything.
 *
 * The claims worth testing are geometric, so they are measured geometrically.
 * Node counts alone would pass while the drawing moved, and the whole point of
 * this operation is that the drawing does not move.
 *
 * Two measures are used throughout. **Hausdorff** is the symmetric one: the
 * furthest either outline strays from the other, so neither may wander off
 * where the other has nothing. **Cost** is what the algorithm itself claims,
 * a control-point discrepancy which Tiller proves bounds the movement. Testing
 * that the bound actually holds is one of the tests below, because a bound
 * nobody checks is a comment.
 */

import { describe, expect, it } from 'vitest';
import { parsePath } from '../src/core/parse';
import { serialisePath } from '../src/core/serialise';
import { splitSegment, moveAnchor } from '../src/model/ops';
import {
  invisibleAt,
  mergeSegments,
  nodeRemovalCost,
  removeInvisibleNodes,
  removeRedundantNodes,
} from '../src/model/knots';
import { cubicAt, splitCubic } from '../src/core/bezier';
import { segmentAsCubic, segmentCount } from '../src/core/types';
import type { Cubic, Pt, Subpath } from '../src/core/types';

/** Through the serialiser and back, which is what an edit session does. */
const clone = (sp: Subpath): Subpath => parsePath(serialisePath([sp], { decimals: 12 }))[0];

function sample(sp: Subpath, per = 24): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < segmentCount(sp); i++) {
    const c = segmentAsCubic(sp, i);
    for (let k = 0; k < per; k++) out.push(cubicAt(c, k / per) as Pt);
  }
  return out;
}

/**
 * Distance from `p` to a densely sampled polyline of `b`.
 *
 * `projectToCubic` is not accurate enough to test this operation with. Its
 * answer for a point already on the curve is off by around 3e-4, which is
 * larger than the movement an exact removal causes, so a test built on it
 * measures the projector and reports the result as if the algorithm had moved
 * something. Point-to-segment against 240 samples per curve is exact enough
 * that the floor sits below 1e-6.
 */
function toPolyline(p: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1];
    const [bx, by] = poly[i];
    const dx = bx - ax;
    const dy = by - ay;
    const dd = dx * dx + dy * dy;
    const t = dd < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / dd));
    best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]));
  }
  return best;
}

function polyline(sp: Subpath, per = 240): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < segmentCount(sp); i++) {
    const c = segmentAsCubic(sp, i);
    for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per) as Pt);
  }
  return out;
}

function oneWay(a: Subpath, b: Subpath): number {
  const poly = polyline(b);
  let worst = 0;
  for (const p of sample(a, 60)) {
    const d = toPolyline(p, poly);
    if (d > worst) worst = d;
  }
  return worst;
}

const hausdorff = (a: Subpath, b: Subpath): number => Math.max(oneWay(a, b), oneWay(b, a));

/** Split every segment in half, `times` over, as double-clicking would. */
function subdivide(sp: Subpath, times = 1): Subpath {
  let out = clone(sp);
  for (let t = 0; t < times; t++) {
    for (let i = segmentCount(out) - 1; i >= 0; i--) splitSegment(out, i, 0.5);
    out = clone(out);
  }
  return out;
}

const STARTER =
  'M 20 30 C 20 20 30 12 40 12 L 60 12 A 8 8 0 0 1 68 20 L 68 40 ' +
  'Q 68 52 56 52 L 32 52 C 24 52 20 46 20 38 Z';
const RING =
  'M 40 10 C 56 10 70 24 70 40 C 70 56 56 70 40 70 C 24 70 10 56 10 40 C 10 24 24 10 40 10 Z';
const OPEN = 'M 10 40 C 10 24 24 10 40 10 C 56 10 70 24 70 40';

describe('merging one pair of segments', () => {
  const TRUE: Cubic = [
    [0, 0],
    [2, 40],
    [60, 40],
    [80, 0],
  ];

  it('recovers the parent cubic from its two halves, wherever it was cut', () => {
    for (const t of [0.05, 0.2, 0.371, 0.5, 0.68, 0.95]) {
      const [L, R] = splitCubic(TRUE, t);
      const m = mergeSegments(L, R);
      expect(m.cubic).not.toBeNull();
      // The control points, not a sampled resemblance: an exact operation
      // should be exact, and reporting it loosely would hide a drift.
      for (let k = 0; k < 4; k++) {
        expect(m.cubic![k][0]).toBeCloseTo(TRUE[k][0], 6);
        expect(m.cubic![k][1]).toBeCloseTo(TRUE[k][1], 6);
      }
      expect(m.cost).toBeLessThan(1e-9);
    }
  });

  it('refuses a corner, however close the two segments sit', () => {
    const L: Cubic = [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ];
    // Leaves at a right angle. Nothing about this is one cubic.
    const R: Cubic = [
      [30, 0],
      [30, 10],
      [30, 20],
      [30, 30],
    ];
    const m = mergeSegments(L, R);
    expect(m.cost).toBeGreaterThan(1);
  });

  it('merges two collinear lines, and refuses a spike that doubles back', () => {
    const straight = mergeSegments(
      [
        [0, 0],
        [0, 0],
        [10, 0],
        [10, 0],
      ],
      [
        [10, 0],
        [10, 0],
        [30, 0],
        [30, 0],
      ],
    );
    expect(straight.cost).toBeLessThan(1e-9);

    // Out to 30 and back to 10: collinear, and emphatically not redundant.
    const spike = mergeSegments(
      [
        [0, 0],
        [0, 0],
        [30, 0],
        [30, 0],
      ],
      [
        [30, 0],
        [30, 0],
        [10, 0],
        [10, 0],
      ],
    );
    expect(spike.cost).toBe(Infinity);
  });

  it('prices a node that was nudged, rather than refusing it outright', () => {
    /* The question that prompted this: a node moved so little that nothing is
       visible, but the maths no longer says "useless". It should get a small
       price, and the price should grow with the nudge. Done on a real path so
       the handles move with the anchor, which is what dragging does. */
    const base = parsePath('M 0 0 C 2 40 60 40 80 0')[0];
    let last = -1;
    for (const nudge of [0, 0.001, 0.01, 0.1, 1]) {
      const sp = clone(base);
      splitSegment(sp, 0, 0.5);
      moveAnchor(sp, 1, [sp.nodes[1].pt[0], sp.nodes[1].pt[1] + nudge]);
      const cost = nodeRemovalCost(sp, 1).cost;
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBeGreaterThan(last);
      last = cost;
    }
  });
});

describe('removing nodes from a path', () => {
  it('undoes a subdivision exactly, on the shape that started this', () => {
    const original = parsePath(STARTER)[0];
    const dense = subdivide(original);
    expect(dense.nodes.length).toBe(16);

    const r = removeRedundantNodes(dense, invisibleAt(3));
    expect(r.after).toBe(original.nodes.length);
    // The subdivided path already sits ~2e-4 from the original, from the arc
    // conversion and the serialiser round trip. Removal must not add to that.
    expect(hausdorff(dense, original)).toBeLessThan(3e-4);
    expect(r.cost).toBeLessThan(1e-9);
  });

  it('works at any tolerance above zero, which is the promise', () => {
    const original = parsePath(STARTER)[0];
    for (const tol of [1e-9, 1e-6, 0.0005, 0.01, 1]) {
      const dense = subdivide(original);
      const r = removeRedundantNodes(dense, tol);
      expect(r.after).toBe(original.nodes.length);
    }
  });

  it('takes a ring back to four nodes however deeply it was cut', () => {
    const ring = parsePath(RING)[0];
    for (const times of [1, 2, 3]) {
      const dense = subdivide(ring, times);
      expect(dense.nodes.length).toBe(4 * 2 ** times);
      const r = removeRedundantNodes(dense, invisibleAt(3));
      expect(r.after).toBe(4);
      expect(hausdorff(dense, ring)).toBeLessThan(1e-3);
    }
  });

  it('does not eat a ring from one side when it cannot finish', () => {
    /* Every node of a uniformly subdivided ring costs the same, so a plain
       cheapest-first order would take them in index order and leave a shape
       dense on one side and bare on the other. One pass, so the cap bites. */
    const ring = parsePath(RING)[0];
    const dense = subdivide(ring, 3);
    const before = dense.nodes.length;
    removeRedundantNodes(dense, invisibleAt(3), 1);

    const gaps: number[] = [];
    for (let i = 0; i < segmentCount(dense); i++) {
      const c = segmentAsCubic(dense, i);
      gaps.push(Math.hypot(c[3][0] - c[0][0], c[3][1] - c[0][1]));
    }
    expect(dense.nodes.length).toBeLessThan(before);
    // Evenly spread means no segment is wildly longer than the median.
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(Math.max(...gaps) / median).toBeLessThan(2.5);
  });

  it('keeps the ends of an open path', () => {
    const open = parsePath(OPEN)[0];
    const dense = subdivide(open, 2);
    const firstPt: Pt = [...dense.nodes[0].pt];
    const lastPt: Pt = [...dense.nodes[dense.nodes.length - 1].pt];

    removeRedundantNodes(dense, 10);
    expect(dense.nodes[0].pt).toEqual(firstPt);
    expect(dense.nodes[dense.nodes.length - 1].pt).toEqual(lastPt);
    expect(dense.closed).toBe(false);
  });

  it('treats the seam of a closed path like any other node', () => {
    const ring = parsePath(RING)[0];
    const dense = subdivide(ring);
    // Node 0 is the seam. It is one of the ring's own nodes, so it must cost
    // what the other three cost, not more and not Infinity.
    const seam = nodeRemovalCost(dense, 0).cost;
    const twin = nodeRemovalCost(dense, 2).cost;
    expect(Number.isFinite(seam)).toBe(true);
    expect(seam).toBeCloseTo(twin, 9);
  });

  it('never moves the drawing further than the tolerance it was given', () => {
    /* The load-bearing claim. Tiller proves a control-point discrepancy below
       TOL bounds the curve's movement by TOL everywhere. If that is wrong here,
       every promise this operation makes is void. */
    const shapes = [STARTER, RING, OPEN];
    for (const d of shapes) {
      for (const tol of [0.01, 0.1, 0.5, 2]) {
        const original = parsePath(d)[0];
        const work = subdivide(original, 2);
        const reference = clone(work);
        removeRedundantNodes(work, tol);
        const moved = hausdorff(work, reference);
        expect(moved).toBeLessThanOrEqual(tol * 1.000001);
      }
    }
  });

  it('leaves a shape it cannot improve exactly as it was', () => {
    const original = parsePath(STARTER)[0];
    const work = clone(original);
    const r = removeRedundantNodes(work, invisibleAt(3));
    expect(r.after).toBe(r.before);
    expect(serialisePath([work], { decimals: 9 })).toBe(
      serialisePath([original], { decimals: 9 }),
    );
  });

  it('is idempotent: a second run finds nothing', () => {
    const dense = subdivide(parsePath(STARTER)[0], 2);
    removeRedundantNodes(dense, 0.05);
    const after = serialisePath([dense], { decimals: 9 });
    const second = removeRedundantNodes(dense, 0.05);
    expect(second.after).toBe(second.before);
    expect(serialisePath([dense], { decimals: 9 })).toBe(after);
  });

  it('keeps a corner even when told to be aggressive', () => {
    // A square. Every node is a right angle and none of them is redundant.
    const square = parsePath('M 0 0 L 40 0 L 40 40 L 0 40 Z')[0];
    // 5 units on a 40-unit square is a lot of licence. A right angle is not a
    // redundant node at any licence, because no cubic replaces two sides.
    const r = removeRedundantNodes(square, 5);
    expect(r.after).toBe(4);
  });

  it('removes a node sitting mid-way along a straight run', () => {
    const line = parsePath('M 0 0 L 10 0 L 20 0 L 30 0 L 30 30 Z')[0];
    const r = removeRedundantNodes(line, invisibleAt(3));
    // The two nodes at [10,0] and [20,0] contribute nothing; the corners stay.
    expect(r.after).toBe(3);
  });

  it('survives degenerate input without emitting a broken path', () => {
    const cases = [
      'M 0 0 L 10 0',
      'M 0 0 L 0 0 L 0 0 Z',
      'M 0 0 C 0 0 0 0 0 0 Z',
      'M 5 5 Z',
      'M 0 0 L 10 0 L 10 0 L 20 0 Z',
    ];
    for (const d of cases) {
      const sp = parsePath(d)[0];
      if (!sp) continue;
      expect(() => removeRedundantNodes(sp, 1)).not.toThrow();
      const out = serialisePath([sp], { decimals: 6 });
      expect(out).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it('never writes a handle that sits on its own anchor', () => {
    /* A control point coincident with its anchor draws a straight segment, and
       the model says that with `null`. Writing the point instead makes
       `segmentIsLine` and the serialiser disagree about the same segment. */
    const line = parsePath('M 0 0 L 10 0 L 20 0 L 20 20 Z')[0];
    removeRedundantNodes(line, invisibleAt(3));
    for (const n of line.nodes) {
      if (n.hIn) expect(Math.hypot(n.hIn[0] - n.pt[0], n.hIn[1] - n.pt[1])).toBeGreaterThan(1e-9);
      if (n.hOut) expect(Math.hypot(n.hOut[0] - n.pt[0], n.hOut[1] - n.pt[1])).toBeGreaterThan(1e-9);
    }
  });

  it('reports a cost that really does bound what moved', () => {
    const dense = subdivide(parsePath(RING)[0], 2);
    const reference = clone(dense);
    const r = removeRedundantNodes(dense, 0.4);
    expect(hausdorff(dense, reference)).toBeLessThanOrEqual(Math.max(r.cost, 1e-9) * 1.5);
  });
});

describe('the invisible threshold', () => {
  it('is half a unit in the last exported decimal', () => {
    expect(invisibleAt(0)).toBe(0.5);
    expect(invisibleAt(3)).toBeCloseTo(0.0005, 12);
    expect(invisibleAt(6)).toBeCloseTo(5e-7, 15);
  });

  it('cannot change the exported file', () => {
    /* The definition of "truly useless": removal below this threshold is
       invisible to the serialiser at that precision, so the saved bytes for
       the shared geometry are identical. */
    const original = parsePath(RING)[0];
    const dense = subdivide(original, 2);
    removeInvisibleNodes(dense, 3);
    expect(dense.nodes.length).toBe(4);
    expect(serialisePath([dense], { decimals: 3 })).toBe(
      serialisePath([original], { decimals: 3 }),
    );
  });

  it('declines a node that a coarse export would notice', () => {
    const original = parsePath(RING)[0];
    const dense = subdivide(original, 1);
    // Move one node well off the curve. At 3 decimals it is far too big to go.
    moveAnchor(dense, 1, [dense.nodes[1].pt[0] + 2, dense.nodes[1].pt[1]]);
    const movedPt: Pt = [...dense.nodes[1].pt];
    removeInvisibleNodes(dense, 3);
    // The moved node itself must survive. Counting survivors would pass while
    // the wrong ones went.
    expect(dense.nodes.some((n) => Math.hypot(n.pt[0] - movedPt[0], n.pt[1] - movedPt[1]) < 1e-9)).toBe(true);
  });
});

describe('deep subdivision', () => {
  it('finishes the job however many times the path was cut', () => {
    /* The pass loop takes no two adjacent nodes in a round, so it needs about
       log2(n) rounds. A cap of five, which is what the paper suggests for its
       own differently shaped pass, left 128 nodes stranded at 5 and 256 at 9. */
    const ring = parsePath(RING)[0];
    for (const times of [1, 2, 3, 4, 5, 6]) {
      const dense = subdivide(ring, times);
      expect(dense.nodes.length).toBe(4 * 2 ** times);
      const r = removeRedundantNodes(dense, invisibleAt(3));
      expect(r.after).toBe(4);
      expect(hausdorff(dense, ring)).toBeLessThan(1e-3);
    }
  });

  it('costs about twice the first pass, not once per pass', () => {
    // Each round has half the nodes of the one before, so the total is bounded.
    const dense = subdivide(parsePath(RING)[0], 6);
    const r = removeRedundantNodes(dense, invisibleAt(3));
    expect(r.passes).toBeLessThan(12);
    expect(r.after).toBe(4);
  });
});
