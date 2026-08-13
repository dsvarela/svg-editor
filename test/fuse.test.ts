/**
 * Fusing nodes, and the generators that must not need it.
 *
 * The defect being closed: two anchors on the same point export a zero-length
 * command, and a path carrying one can never be simplified again, because a zero
 * chord leaves the fitter with no tangent to work from. So every test here that
 * claims a repair also checks the repaired path can still be simplified.
 */

import { describe, expect, it } from 'vitest';
import { fuseDegenerate, fuseNodes, circulariseSubpath } from '../src/model/ops';
import { rectSubpath } from '../src/core/primitives';
import { simplifySubpath } from '../src/model/simplify';
import { parsePath } from '../src/core/parse';
import { serialisePath } from '../src/core/serialise';
import { KAPPA } from '../src/core/primitives';
import { continuityOf, makeNode, segmentCount } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';

const open = (pts: Pt[]): Subpath => ({
  nodes: pts.map((pt) => makeNode(pt)),
  closed: false,
});

const closed = (pts: Pt[]): Subpath => ({ ...open(pts), closed: true });

/** The shortest zero-length segment in a subpath, for the claims below. */
const shortestSegment = (sp: Subpath): number => {
  let best = Infinity;
  for (let i = 0; i < segmentCount(sp); i++) {
    const a = sp.nodes[i].pt;
    const b = sp.nodes[(i + 1) % sp.nodes.length].pt;
    best = Math.min(best, Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return best;
};

describe('fuseNodes', () => {
  it('welds two adjacent nodes at their midpoint', () => {
    const sp = open([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    const r = fuseNodes(sp, 0, 1);
    expect(r).toEqual({ moved: 5 });
    expect(sp.nodes).toHaveLength(2);
    expect(sp.nodes[0].pt).toEqual([5, 0]);
  });

  it('does not move a pair that already sits on one point', () => {
    // The case that matters: this is a repair, and a repair that nudges the
    // drawing is not one.
    const sp = closed([
      [0, 0],
      [40, 0],
      [40, 0],
      [40, 20],
    ]);
    const r = fuseNodes(sp, 1, 2);
    expect(r).toEqual({ moved: 0 });
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [40, 0],
      [40, 20],
    ]);
  });

  it('keeps the handle facing away from the joint on each side', () => {
    // The survivor has to end up governing the two segments that still exist,
    // which are the incoming one of the first node and the outgoing one of the
    // second. Taking both from either node would flatten one of them.
    const sp: Subpath = {
      nodes: [
        makeNode([0, 0], null, [3, 0]),
        makeNode([10, 0], [7, 0], [11, 0]),
        makeNode([12, 0], [11.5, 0], [13, 5]),
        makeNode([20, 10], [15, 10]),
      ],
      closed: false,
    };
    fuseNodes(sp, 1, 2);
    expect(sp.nodes).toHaveLength(3);
    /* The pair meets at [11, 0], so the first node's handles travel +1 and the
       second's travel -1. The survivor arrived from node 0 along the first
       node's `hIn` and leaves towards the last along the second's `hOut`. Both
       values are distinct from what taking the pair off either node alone would
       give ([12, 0] and [10.5, 0]), so this test can tell the three apart. */
    expect(sp.nodes[1].hIn).toEqual([8, 0]);
    expect(sp.nodes[1].hOut).toEqual([12, 5]);
  });

  it('welds across the seam of a closed path without re-rooting it', () => {
    // The pair that the plain index comparison gets backwards: the last node
    // precedes the first. Node 0 has to stay node 0, or a ring silently rotates
    // under a repair and every stored index moves with it.
    const sp: Subpath = {
      nodes: [
        // Handles, deliberately. With `hIn`/`hOut` all null the two spellings of
        // "which node survives" produce identical output and the test cannot
        // tell them apart -- which is how it first shipped.
        makeNode([0, 0], [-1, 0], [1, 0]),
        makeNode([10, 0], [9, 0], [11, 0]),
        makeNode([10, 10], [10, 9], [10, 11]),
        makeNode([0, 0], [0, 2], [0, -2]),
      ],
      closed: true,
    };
    const r = fuseNodes(sp, 3, 0);
    expect(r).toEqual({ moved: 0 });
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(sp.closed).toBe(true);
    // Node 0 is still node 0, and it arrives along the old last node's incoming
    // handle while leaving along its own.
    expect(sp.nodes[0].hIn).toEqual([0, 2]);
    expect(sp.nodes[0].hOut).toEqual([1, 0]);
  });

  it('refuses two nodes that are not neighbours', () => {
    // There is a run of segments between them, and welding would pinch the path
    // into two loops while quietly discarding whatever ran across the middle.
    const sp = closed([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    expect(fuseNodes(sp, 0, 2)).toBe('apart');
    expect(sp.nodes).toHaveLength(4);
  });

  it('refuses the two ends of an open path, which is Merge ends', () => {
    const sp = open([
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ]);
    expect(fuseNodes(sp, 0, 3)).toBe('apart');
  });

  it('refuses to take a path below two nodes', () => {
    expect(fuseNodes(open([[0, 0], [10, 0]]), 0, 1)).toBe('tiny');
    expect(fuseNodes(closed([[0, 0], [10, 0]]), 0, 1)).toBe('tiny');
  });

  it('refuses one node twice, and an index off the end', () => {
    const sp = closed([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(fuseNodes(sp, 1, 1)).toBe('same');
    expect(fuseNodes(sp, 1, 9)).toBe('same');
    expect(fuseNodes(sp, -1, 0)).toBe('same');
  });
});

describe('fuseDegenerate', () => {
  it('sweeps every zero-length segment, including the closing one', () => {
    const sp = closed([
      [0, 0],
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ]);
    expect(fuseDegenerate(sp)).toBe(2);
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('leaves a healthy path alone and reports nothing', () => {
    const sp = closed([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(fuseDegenerate(sp)).toBe(0);
    expect(sp.nodes).toHaveLength(3);
  });

  it('leaves a short segment that is genuinely there', () => {
    /* The bound was pinned from below and not from above: setting DEGENERATE to
       3 -- welding anything within three document units -- passed every test and
       every browser scenario. A repair that quietly redraws real geometry is a
       worse failure than the one it repairs, so the ceiling is nailed down here.
       1e-4 is a hundredth of a screen pixel at a typical zoom and a thousand
       times the threshold. */
    const sp = closed([
      [0, 0],
      [10, 0],
      [10, 1e-4],
      [10, 10],
    ]);
    expect(fuseDegenerate(sp)).toBe(0);
    expect(sp.nodes).toHaveLength(4);
    // And just below it, the weld does happen, so the threshold is real.
    const tiny = closed([
      [0, 0],
      [10, 0],
      [10, 1e-9],
      [10, 10],
    ]);
    expect(fuseDegenerate(tiny)).toBe(1);
  });

  it('stops at two nodes rather than sweeping a path out of existence', () => {
    // Four anchors all on one point. Two of them have to survive, because one
    // node draws nothing and the parser drops it on the way back in.
    const sp = closed([
      [5, 5],
      [5, 5],
      [5, 5],
      [5, 5],
    ]);
    fuseDegenerate(sp);
    expect(sp.nodes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the generators no longer produce coincident anchors', () => {
  it('rounds a square to its own limit as a circle, not eight nodes', () => {
    const sp = rectSubpath(0, 0, 20, 20, 10);
    expect(sp.nodes).toHaveLength(4);
    expect(shortestSegment(sp)).toBeGreaterThan(1);
    // Four quarter arcs of radius 10 about the centre.
    for (const n of sp.nodes) {
      expect(Math.hypot(n.pt[0] - 10, n.pt[1] - 10)).toBeCloseTo(10, 9);
    }
    /* Anchors alone are not a circle. The survivor has to take the arc handle
       from EACH direction, and every assertion above passes if it takes both
       from one node: the anchors are identical and only the handles collapse,
       leaving four control points sitting on their own anchors and an outline
       with four cusps in it. */
    const k = 10 * KAPPA;
    for (const n of sp.nodes) {
      expect(n.hIn).not.toBeNull();
      expect(n.hOut).not.toBeNull();
      expect(Math.hypot(n.hIn![0] - n.pt[0], n.hIn![1] - n.pt[1])).toBeCloseTo(k, 9);
      expect(Math.hypot(n.hOut![0] - n.pt[0], n.hOut![1] - n.pt[1])).toBeCloseTo(k, 9);
      // Symmetric, which is what makes it smooth rather than a cusp.
      expect(continuityOf(n)).toBe('symmetric');
    }
  });

  it('collapses a side that has vanished to within a rounding error', () => {
    /* An exact `===` looks safe here, because when a side truly vanishes the two
       tangent coordinates are bit-identical. This width is one ulp above twice
       the radius, so it fails the clamp, leaves them 4.4e-16 apart, and emits
       both: a zero-length command in the export and a path that can never be
       simplified again. */
    const sp = rectSubpath(0, 0, 2.1000000000000005, 20, 1.05);
    expect(sp.nodes).toHaveLength(6);
    expect(shortestSegment(sp)).toBeGreaterThan(0.01);
  });

  it('rounds an oblong to its limit as a six-node stadium', () => {
    const sp = rectSubpath(0, 0, 40, 20, 10);
    expect(sp.nodes).toHaveLength(6);
    expect(shortestSegment(sp)).toBeGreaterThan(1);
    // The straight sides survive: top and bottom, ten units of each.
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [10, 0],
      [30, 0],
      [40, 10],
      [30, 20],
      [10, 20],
      [0, 10],
    ]);
  });

  it('leaves an under-clamped rectangle at eight nodes as before', () => {
    const sp = rectSubpath(0, 0, 20, 10, 3);
    expect(sp.nodes).toHaveLength(8);
    expect(sp.nodes[0].pt).toEqual([3, 0]);
  });

  it('exports a clamped rectangle with no zero-length command', () => {
    // The defect as the file sees it. `L10 0 L10 0` is what a duplicate anchor
    // looks like on the way out.
    const d = serialisePath([rectSubpath(0, 0, 20, 20, 10)], { decimals: 3 });
    const reparsed = parsePath(d)[0];
    expect(shortestSegment(reparsed)).toBeGreaterThan(1);
  });

  it('lets a clamped rectangle be simplified, which it could not before', () => {
    // The consequence that made this worth fixing. A zero chord gives the fitter
    // no tangent, so one duplicate anchor made the whole path un-simplifiable.
    const sp = rectSubpath(0, 0, 20, 20, 10);
    expect(() => simplifySubpath(sp, 0.5)).not.toThrow();
    for (const n of sp.nodes) expect(Number.isFinite(n.pt[0])).toBe(true);
  });

  it('welds two nodes that circularise sends to the same angle', () => {
    /* [12, 0] and [8, 0] are on the same ray from the fitted centre, which the
       two symmetric nodes pin to the x-axis, so both land on the same point of
       the circle however faithfully each was placed. An earlier fixture put the
       fifth node at [5, -5], which shares an angle with nothing: `fused` came
       back 0 and the assertion passed without the code under test running. */
    const sp = closed([
      [12, 0],
      [8, 0],
      [0, 10],
      [-10, 0],
      [0, -10],
    ]);
    const r = circulariseSubpath(sp);
    expect(r).not.toBeNull();
    expect(r!.fused).toBe(1);
    expect(sp.nodes).toHaveLength(4);
    expect(shortestSegment(sp)).toBeGreaterThan(1);
  });

  it('reports nothing fused for a contour with no coincident angles', () => {
    const sp = closed([
      [10, 1],
      [0, 11],
      [-10, 0],
      [0, -9],
    ]);
    const r = circulariseSubpath(sp)!;
    expect(r.fused).toBe(0);
    expect(sp.nodes).toHaveLength(4);
    // And the result is still a circle made of smooth nodes.
    for (const n of sp.nodes) expect(continuityOf(n)).not.toBe('corner');
  });
});
