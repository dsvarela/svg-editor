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
import { segmentAsCubic } from '../src/core/types';
import type { Pt } from '../src/core/types';
import { cubicAt } from '../src/core/bezier';
import {
  closeSubpath,
  fuseDegenerate,
  fuseNodes,
  mergeEnds,
  setSegmentCurved,
  splitSegment,
} from '../src/model/ops';
import type { Corner } from '../src/model/corner';
import {
  cornerAt,
  cornerArcReach,
  cornerRadiusAtReach,
  filletAt,
  maxCornerRadius,
  roundCorner,
  sharedCornerRadius,
} from '../src/model/corner';

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

  it('halves a shared side from whichever end takes the longer bite', () => {
    /* Two corners sharing one side, with angles far apart: 40 degrees at the
       first and 120 at the second. A cut is `r / tan(alpha / 2)`, so for one
       radius the sharp corner reaches more than four times as far along the
       shared side as the blunt one.

       That is why the halving is stated at both ends and neither statement is
       spare. A square cannot show it: with equal angles the two ends convert a
       radius to the same cut, so either statement alone gives the same answer.
       Here the sharp corner's forward half is the only thing that binds. */
    const deg = (d: number): number => (d * Math.PI) / 180;
    const p1: Pt = [100, 100];
    const p2: Pt = [180, 100];
    const p0: Pt = [p1[0] + 100 * Math.cos(deg(40)), p1[1] + 100 * Math.sin(deg(40))];
    const p3: Pt = [p2[0] + 60 * Math.cos(deg(-60)), p2[1] + 60 * Math.sin(deg(-60))];
    const at = (p: Pt): string => `${p[0]} ${p[1]}`;
    const sp = parsePath(`M${at(p0)} L${at(p1)} L${at(p2)} L${at(p3)} Z`)[0];

    expect(cornerAt(sp, 1)).not.toBe('straight');
    expect(cornerAt(sp, 2)).not.toBe('straight');

    // Half of the 80-unit shared side, read as a radius at the sharp corner.
    expect(sharedCornerRadius(sp, [sp.nodes[1].id, sp.nodes[2].id])).toBeCloseTo(
      40 * Math.tan(deg(20)),
      6,
    );
    // Alone it has the whole side, and twice the radius.
    expect(sharedCornerRadius(sp, [sp.nodes[1].id])).toBeCloseTo(80 * Math.tan(deg(20)), 6);
  });

  it('does not halve a side for a neighbour that will not round', () => {
    /* An L with node 2 flattened, so the path runs straight through it and it
       takes no arc. Naming it alongside node 1 must not cost node 1 half of the
       side they share: nothing is going to be cut from the far end of it.

       This is the case that tells the two halvings apart. With a neighbour that
       does round, each side is stated twice -- once forward from one corner and
       once back from the other -- so either statement alone gives the same
       answer and neither is measured. */
    const sp = parsePath('M100 100 L180 100 L180 130 L180 190 L100 190 Z')[0];
    const alone = sharedCornerRadius(sp, [sp.nodes[1].id]);
    expect(alone).toBeGreaterThan(0);
    expect(cornerAt(sp, 2)).toBe('straight');
    expect(sharedCornerRadius(sp, [sp.nodes[1].id, sp.nodes[2].id])).toBeCloseTo(alone, 9);
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
  const cornerOf = (d: string, i: number): Corner => {
    const got = cornerAt(parsePath(d)[0], i);
    if (typeof got === 'string') throw new Error(got);
    return got;
  };

  it('is stated exactly at a right angle, not just against its own inverse', () => {
    // Half a right angle: the centre sits r / sin(45 degrees) in, which is
    // r * sqrt(2), and the arc begins r nearer than that.
    const square = cornerOf('M100 100 L180 100 L180 180 L100 180 Z', 1);
    expect(cornerArcReach(square, 10)).toBeCloseTo(10 * (Math.SQRT2 - 1), 9);
  });

  it('round-trips over the corners a path can have', () => {
    for (const [d, i] of [
      ['M100 100 L180 100 L180 180 L100 180 Z', 1],
      ['M0 40 L100 0 L200 40 L100 44 Z', 1],
      ['M0 40 L100 0 L104 40 L52 60 Z', 1],
      ['M40 90 C40 50 70 30 110 30 C100 55 95 70 130 95 C100 105 60 105 40 90 Z', 1],
    ] as [string, number][]) {
      const c = cornerOf(d, i);
      for (const frac of [0.05, 0.3, 0.7]) {
        const r = maxCornerRadius(c) * frac;
        expect(cornerRadiusAtReach(c, cornerArcReach(c, r))).toBeCloseTo(r, 6);
      }
    }
  });

  it('puts the control where the arc really begins, on a curved side too', () => {
    /* The reported symptom: on a sharp tip with a curve running into it the
       control did not sit on the arc and the drag did not track the pointer.
       The half-angle formula it used is exact for two straight sides and was a
       fifth out here, so this measures the arc instead of restating a formula:
       round the corner, walk the arc, and take its nearest point to the corner. */
    const D = 'M100 20 C120 60 140 90 190 120 L120 200 C90 120 95 60 100 20 Z';
    const c = cornerOf(D, 0);
    for (const frac of [0.1, 0.4, 0.8]) {
      const r = maxCornerRadius(c) * frac;
      const sp = parsePath(D)[0];
      expect(typeof roundCorner(sp, 0, r)).not.toBe('string');
      let nearest = Infinity;
      const arc = segmentAsCubic(sp, 0);
      for (let k = 0; k <= 400; k++) {
        const p = cubicAt(arc, k / 400);
        nearest = Math.min(nearest, Math.hypot(p[0] - c.at[0], p[1] - c.at[1]));
      }
      /* The floor is the arc's own approximation to a circle, not zero:
         `cornerArcReach` measures the true circle and this walks the cubic
         standing in for it, which §12 puts at a few hundredths of a percent of
         the radius. */
      expect(Math.abs(cornerArcReach(c, r) - nearest)).toBeLessThan(r * 5e-3);
    }
  });

  it('is zero for anything that is not a positive radius or distance', () => {
    const c = cornerOf('M100 100 L180 100 L180 180 L100 180 Z', 1);
    expect(cornerArcReach(c, 0)).toBe(0);
    expect(cornerArcReach(c, -1)).toBe(0);
    expect(cornerRadiusAtReach(c, 0)).toBe(0);
    expect(cornerRadiusAtReach(c, -3)).toBe(0);
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
