/**
 * The number each of these hands back, and where each of them puts a handle.
 *
 * A different gap from `equivariance.test.ts`, and the one that file says it
 * cannot reach: an error between two quantities that are both already
 * differences. Moving the drawing moves both by the same amount, so a sign flip
 * between them commutes with translation and survives that whole table. The
 * only thing that catches it is a test that says where the geometry went.
 *
 * Every function here has a live caller that reads its answer -- an index the
 * controller selects, a radius a drag converts back to a distance, a node count
 * a merge depends on -- so a wrong answer is a wrong editor and not a wrong
 * internal number.
 */

import { describe, expect, it } from 'vitest';
import { parsePath } from '../src/core/parse';
import {
  closeSubpath,
  cornerArcReach,
  cornerRadiusAtReach,
  filletAt,
  fuseDegenerate,
  fuseNodes,
  mergeEnds,
  roundCorner,
  setSegmentCurved,
  sharedCornerRadius,
  splitSegment,
} from '../src/model/ops';

describe('splitSegment names the node it inserted', () => {
  /* The controller selects that index straight afterwards, so an index one off
     selects the node next door and the click appears to have picked the wrong
     place. `src/tools/controller.ts` and `src/tools/commands.ts` both read it. */
  it('on a straight segment', () => {
    const sp = parsePath('M10 10 L50 10')[0];
    const i = splitSegment(sp, 0, 0.25);
    expect(sp.nodes[i].pt).toEqual([20, 10]);
  });

  it('on a curved one', () => {
    const sp = parsePath('M0 0 C10 -10 30 -10 40 0')[0];
    const i = splitSegment(sp, 0, 0.5);
    expect(sp.nodes[i].pt).toEqual([20, -7.5]);
  });
});

describe('setSegmentCurved puts each handle inside the span', () => {
  // A third of the way along, each from its own node. Outside the span the two
  // handles cross and a segment that was a line draws as a loop. The segment is
  // diagonal so that both coordinates carry a non-zero step: on a horizontal
  // one the y term is a number plus nothing and any sign will do.
  it('a third along, from each end', () => {
    const sp = parsePath('M10 20 L70 50')[0];
    setSegmentCurved(sp, 0, true);
    expect(sp.nodes[0].hOut).toEqual([30, 30]);
    expect(sp.nodes[1].hIn).toEqual([50, 40]);
  });
});

describe('fuseNodes carries the handles with their nodes', () => {
  /* Four nodes and three curves, with the fusing pair separated on both axes:
     60 across and 80 down. A pair that differs on one axis only leaves the
     other step at zero, where adding it and subtracting it agree. */
  const four = (): ReturnType<typeof parsePath>[number] =>
    parsePath('M10 10 C20 15 30 20 40 30 C60 50 80 90 100 110 C110 120 120 125 130 130')[0];

  it('moves each handle by the same vector as its own node', () => {
    const sp = four();
    // [40, 30] and [100, 110] meet halfway at [70, 70], each travelling [30, 40].
    expect(fuseNodes(sp, 1, 2)).toEqual({ moved: 50 });
    const kept = sp.nodes[1];
    expect(kept.pt).toEqual([70, 70]);
    // Node 1's incoming handle was [30, 20] and node 1 moved by [30, 40].
    expect(kept.hIn).toEqual([60, 60]);
    // Node 2's outgoing handle was [110, 120] and node 2 moved by [-30, -40].
    expect(kept.hOut).toEqual([80, 80]);
  });

  it('reports half the gap the pair closed', () => {
    // Each node travels half the distance between them, and that is the number
    // the caller compares against a tolerance to decide whether anything moved.
    // 60 and 80 make a gap of 100, so each node goes 50.
    expect(fuseNodes(four(), 1, 2)).toEqual({ moved: 50 });
    expect(fuseNodes(parsePath('M0 0 L10 20 L10 20 L20 40')[0], 1, 2)).toEqual({ moved: 0 });
  });
});

describe('mergeEnds keeps every node of both paths', () => {
  it('joins three and three into five', () => {
    const a = parsePath('M0 0 L10 0 L20 0')[0];
    const b = parsePath('M40 0 L50 0 L60 0')[0];
    const m = mergeEnds({ sp: a, i: 2 }, { sp: b, i: 0 })!;
    // The two joined ends become one node at their midpoint; everything else
    // survives, so five nodes from six.
    expect(m.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [10, 0],
      [30, 0],
      [50, 0],
      [60, 0],
    ]);
  });
});

describe('fuseDegenerate finds a coincident pair anywhere', () => {
  it('a long way from the origin', () => {
    /* The distance between the pair is what decides, and at the origin a
       distance and a sum of coordinates are the same number. Out here they are
       not: a rule reading the sum sees 880 where the gap is 0 and fuses
       nothing. */
    const sp = parsePath('M400 300 L440 300 L440 300 L440 340 L400 340 Z')[0];
    expect(fuseDegenerate(sp)).toBe(1);
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [400, 300],
      [440, 300],
      [440, 340],
      [400, 340],
    ]);
  });
});

describe('sharedCornerRadius measures both sides of each corner', () => {
  /* 80 wide and 30 tall, and the corner asked about is one whose two sides
     differ, so reading the same neighbour twice gives a different answer from
     reading one on each side. The rail shows this number as the largest radius
     a Round will take, and a drag is clamped to it. */
  const rect = (): ReturnType<typeof parsePath>[number] =>
    parsePath('M100 100 L180 100 L180 130 L100 130 Z')[0];

  /* Both corners of the short side, because each puts the 30-unit side on a
     different hand: at node 1 it is the one ahead, at node 2 the one behind.
     One of the two alone leaves the other neighbour free to be measured wrongly
     and still lose the comparison. */
  it.each([1, 2])('is the shorter of the two sides at node %i', (i) => {
    const sp = rect();
    // A right angle has tan(alpha / 2) of 1, so the answer is the side itself.
    expect(sharedCornerRadius(sp, [sp.nodes[i].id])).toBeCloseTo(30, 9);
  });

  it('halves a side whose other end is also being rounded', () => {
    // Two arcs cut from one side have to share it, or they overlap.
    const sp = rect();
    expect(sharedCornerRadius(sp, [sp.nodes[1].id, sp.nodes[2].id])).toBeCloseTo(15, 9);
  });

  it('answers about the corner it was asked about', () => {
    /* An L, whose six right angles all give different answers, so naming one
       node and measuring another is visible. The ids are looked up by search,
       and a search that matched anything but the id would land on node 0. */
    const sp = parsePath('M0 0 L100 0 L100 40 L60 40 L60 90 L0 90 Z')[0];
    const at = (i: number): number => sharedCornerRadius(sp, [sp.nodes[i].id]);
    expect(at(0)).toBeCloseTo(90, 9);
    expect(at(1)).toBeCloseTo(40, 9);
    expect(at(4)).toBeCloseTo(50, 9);
    expect(at(5)).toBeCloseTo(60, 9);
  });

  it('is zero when nothing in the set is a corner', () => {
    const sp = parsePath('M100 100 C110 90 130 90 140 100')[0];
    expect(sharedCornerRadius(sp, [sp.nodes[0].id])).toBe(0);
  });
});

describe('closeSubpath', () => {
  it('closes the smallest subpath that can be closed', () => {
    // Two nodes and two segments between them, which draws as a plain line and
    // is what a ring of three becomes when it loses a node.
    const two = parsePath('M10 20 L70 50')[0];
    closeSubpath(two);
    expect(two.closed).toBe(true);
  });

  it('leaves a lone node open, having nothing to close onto', () => {
    const one = parsePath('M10 20 L70 50')[0];
    one.nodes.length = 1;
    closeSubpath(one);
    expect(one.closed).toBe(false);
  });
});

describe('the radius of a fillet and how far it reaches', () => {
  /* One relation, spelled twice, and the two spellings have to be inverses:
     the canvas draws the control at `cornerArcReach` from the corner and a drag
     of that control is turned back into a radius by `cornerRadiusAtReach`. If
     they disagree the control slides out from under the pointer. */
  it('is stated exactly at a right angle, not just against its own inverse', () => {
    // Half a right angle: the centre sits r / sin(45 degrees) in, which is
    // r * sqrt(2), and the arc begins r nearer than that.
    expect(cornerArcReach(10, Math.PI / 4)).toBeCloseTo(10 * (Math.SQRT2 - 1), 12);
  });

  it('round-trips over the angles a corner can have', () => {
    for (const deg of [10, 30, 45, 60, 89]) {
      const half = (deg * Math.PI) / 180;
      for (const r of [0.5, 3, 40]) {
        expect(cornerRadiusAtReach(cornerArcReach(r, half), half)).toBeCloseTo(r, 9);
      }
    }
  });

  it('is zero for anything that is not a positive radius or distance', () => {
    expect(cornerArcReach(0, Math.PI / 4)).toBe(0);
    expect(cornerArcReach(-1, Math.PI / 4)).toBe(0);
    expect(cornerRadiusAtReach(0, Math.PI / 4)).toBe(0);
    expect(cornerRadiusAtReach(5, Math.PI / 2)).toBe(0);
  });
});

describe('filletAt recovers a corner that is not a right angle', () => {
  /* Nothing stores that a corner was rounded, so this recovers the radius from
     the two handles by working out the angle they meet at. A right angle is the
     one angle where several wrong ways of computing that angle still land on
     the right answer, so the fixture is deliberately not one. */
  it('reads back the radius it was rounded with', () => {
    const sp = parsePath('M0 0 L40 10 L10 40 Z')[0];
    expect(typeof roundCorner(sp, 1, 5)).not.toBe('string');
    const f = filletAt(sp, 1)!;
    expect(f.radius).toBeCloseTo(5, 6);
    // And the corner it was cut from is where the two sides used to meet.
    expect(f.at[0]).toBeCloseTo(40, 6);
    expect(f.at[1]).toBeCloseTo(10, 6);
  });
});
