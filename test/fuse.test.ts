/**
 * Fusing nodes: welding a pair into one, and sweeping away the zero-length
 * segments that make a path unsimplifiable. §24.
 *
 * The generators that had to be checked for coincident anchors were the rect
 * tool's own radius and circularise, and both are gone. `roundCorner` is the
 * one fillet generator left, and `never leaves two anchors on the same point`
 * in `ops.test.ts` is where that property is held.
 */

import { describe, expect, it } from 'vitest';
import { fuseDegenerate, fuseNodes } from '../src/model/ops';
import { makeNode } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';

const open = (pts: Pt[]): Subpath => ({
  nodes: pts.map((pt) => makeNode(pt)),
  closed: false,
});

const closed = (pts: Pt[]): Subpath => ({ ...open(pts), closed: true });

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
