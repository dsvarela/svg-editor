/**
 * Reading a rounded corner back off the path.
 *
 * Nothing stores a radius, so the widget that lets you drag one has to recover it
 * from the geometry. The recovery is exact rather than approximate -- each tangent
 * node's single handle points at the corner it was cut from -- and these are the
 * tests that say so, by rounding at a known radius and asking for it back.
 *
 * §48 of `docs/ARCHITECTURE.md` has the argument.
 */

import { describe, expect, it } from 'vitest';
import { shapeFromPath } from '../src/model/doc';
import {
  cornerAt,
  filletAt,
  maxCornerRadius,
  roundCorner,
  unroundCorner,
} from '../src/model/ops';
import { serialisePath } from '../src/core/serialise';
import type { Subpath } from '../src/core/types';

const square = (): Subpath => shapeFromPath('M0 0 L40 0 L40 40 L0 40 Z').subpaths[0];
const open = (): Subpath => shapeFromPath('M0 0 L40 0 L40 40').subpaths[0];

/* Not a right angle anywhere, which matters more than it looks. Every corner of a
   square is 90°, and `tan(a/2)` and `cot(a/2)` are both 1 there -- so a radius
   derived from the wrong one of the two angles at the corner comes out correct on
   a square and wrong on everything else. Node 1 here is about 63°. */
const wedge = (): Subpath => shapeFromPath('M0 0 L40 0 L10 30 Z').subpaths[0];

/** Move the node order round by `by`, so a fillet can be made to straddle the end. */
function rotate(sp: Subpath, by: number): Subpath {
  return { nodes: [...sp.nodes.slice(by), ...sp.nodes.slice(0, by)], closed: sp.closed };
}

/** The one fillet in a subpath, wherever it starts. */
function onlyFillet(sp: Subpath): ReturnType<typeof filletAt> {
  const found = sp.nodes.map((_, i) => filletAt(sp, i)).filter((f) => f !== null);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('measuring a corner', () => {
  it('gives the two side directions and the angle between them', () => {
    const c = cornerAt(square(), 1);
    expect(typeof c).not.toBe('string');
    if (typeof c === 'string') return;
    expect(c.at).toEqual([40, 0]);
    // The sides run back along -x and on along +y, so a right angle.
    expect(c.alpha).toBeCloseTo(Math.PI / 2, 12);
    expect(c.reach).toBeCloseTo(40, 12);
    expect(maxCornerRadius(c)).toBeCloseTo(40, 12);
  });

  it('refuses the end of an open path, which has only one side', () => {
    expect(cornerAt(open(), 0)).toBe('end');
    expect(cornerAt(open(), 2)).toBe('end');
  });

  it('refuses a corner with a curve on either side', () => {
    const sp = square();
    roundCorner(sp, 1, 8);
    // Node 0 now has a curve arriving at it from the fillet just placed.
    const which = sp.nodes.map((_, i) => cornerAt(sp, i)).filter((c) => c === 'curved');
    expect(which.length).toBeGreaterThan(0);
  });
});

describe('reading a fillet back', () => {
  for (const radius of [1, 4, 10, 19.5]) {
    it(`recovers the corner and the radius after rounding at ${radius}`, () => {
      const sp = square();
      const before = cornerAt(sp, 1);
      if (typeof before === 'string') throw new Error(before);
      const done = roundCorner(sp, 1, radius);
      expect(typeof done).not.toBe('string');

      const f = onlyFillet(sp);
      expect(f).not.toBeNull();
      expect(f!.at[0]).toBeCloseTo(before.at[0], 9);
      expect(f!.at[1]).toBeCloseTo(before.at[1], 9);
      expect(f!.radius).toBeCloseTo(radius, 9);
    });
  }

  it('reads back the radius it was clamped to, not the one asked for', () => {
    const sp = square();
    const c = cornerAt(sp, 1);
    if (typeof c === 'string') throw new Error(c);
    const done = roundCorner(sp, 1, 1000);
    if (typeof done === 'string') throw new Error(done);
    expect(done.clamped).toBe(true);
    expect(onlyFillet(sp)!.radius).toBeCloseTo(done.radius, 9);
  });

  /* A corner that is not a right angle. `radius = cut * tan(alpha / 2)`, and the
     angle has to be the interior one: at 90° the interior and exterior halves have
     the same tangent, so a square cannot tell the two apart and every assertion
     above would hold with the wrong one. */
  it('recovers the radius at a corner that is not a right angle', () => {
    const sp = wedge();
    const c = cornerAt(sp, 1);
    if (typeof c === 'string') throw new Error(c);
    // 45°, where `tan(a/2)` is 0.414 and `cot(a/2)` is 2.414. Nothing about this
    // corner reads the same under the two.
    expect(c.alpha).toBeCloseTo(Math.PI / 4, 12);
    roundCorner(sp, 1, 5);
    expect(onlyFillet(sp)!.radius).toBeCloseTo(5, 9);
  });

  /* The wrap, built rather than rounded into place. `roundCorner` splices the pair
     in at `i`, so rounding alone always leaves it at `(i, i + 1)` and never across
     the end -- reversing or re-ordering a path is what puts it there. */
  it('reads a fillet that straddles the end of the node list', () => {
    const rounded = square();
    roundCorner(rounded, 1, 6);
    const f = onlyFillet(rounded)!;
    // Bring the pair's first node to the last slot, so its partner is index 0.
    const sp = rotate(rounded, f.i + 1);
    expect(filletAt(sp, f.i)).toBeNull(); // it is no longer there
    const moved = filletAt(sp, sp.nodes.length - 1);
    expect(moved).not.toBeNull();
    expect(moved!.j).toBe(0);
    expect(moved!.radius).toBeCloseTo(6, 9);
  });

  it('says no to two hand-pulled curves that are not a fillet', () => {
    // Both handles present at each node, which no fillet has.
    const sp = shapeFromPath('M0 0 C10 0 30 0 40 0 C40 10 40 30 40 40 L0 40 Z').subpaths[0];
    expect(sp.nodes.every((_, i) => filletAt(sp, i) === null)).toBe(true);
  });

  /* The two checks below need a pair that passes every other test, so they are
     built by hand from the numbers a real fillet would have. `arcHandle(r, pi/2)`
     is `r * 4/3 * tan(pi/8)`, so a handle of 10 belongs to a cut of that over the
     factor -- and putting the far tangent point anywhere else leaves an arc that is
     circular, symmetric in its handles, and still not a fillet. */
  const CUT = 10 / ((4 / 3) * Math.tan(Math.PI / 8));

  it('says no when the two sides are cut at different distances', () => {
    const sp: Subpath = {
      closed: true,
      nodes: [
        { id: 'a', pt: [0, 0], hIn: null, hOut: [10, 0] },
        // Right-angled corner at [CUT, 0], but this side is cut at 5, not CUT.
        { id: 'b', pt: [CUT, 5], hIn: [CUT, -5], hOut: null },
        { id: 'c', pt: [CUT, 60], hIn: null, hOut: null },
      ],
    };
    expect(filletAt(sp, 0)).toBeNull();
  });

  it('says no when the two handles are different lengths', () => {
    const sp = square();
    roundCorner(sp, 1, 8);
    const f = onlyFillet(sp)!;
    const b = sp.nodes[f.j];
    // Only the far handle stretched: the cuts still match and the near handle is
    // still the length a circle wants, so nothing but this check refuses it.
    b.hIn = [b.pt[0] + (b.hIn![0] - b.pt[0]) * 1.4, b.pt[1] + (b.hIn![1] - b.pt[1]) * 1.4];
    expect(filletAt(sp, f.i)).toBeNull();
  });

  it('says no to an arc that is tangent but the wrong length to be circular', () => {
    const sp = square();
    roundCorner(sp, 1, 8);
    const f = onlyFillet(sp)!;
    // Stretch both handles equally: still tangent, still symmetric, no longer a
    // circle. Equal lengths alone would let this through.
    const a = sp.nodes[f.i];
    const b = sp.nodes[f.j];
    const pull = (p: [number, number], from: [number, number]): [number, number] => [
      from[0] + (p[0] - from[0]) * 1.5,
      from[1] + (p[1] - from[1]) * 1.5,
    ];
    a.hOut = pull(a.hOut!, a.pt);
    b.hIn = pull(b.hIn!, b.pt);
    expect(filletAt(sp, f.i)).toBeNull();
  });
});

describe('unrounding', () => {
  it('puts the corner back exactly where it was', () => {
    const sp = square();
    const was = serialisePath([sp], { decimals: 9 });
    roundCorner(sp, 1, 9);
    const f = onlyFillet(sp)!;
    const at = unroundCorner(sp, f.i);
    expect(at).not.toBeNull();
    expect(serialisePath([sp], { decimals: 9 })).toBe(was);
  });

  it('puts back a corner whose fillet straddles the end of the list', () => {
    const rounded = square();
    roundCorner(rounded, 1, 5);
    const f = onlyFillet(rounded)!;
    const sp = rotate(rounded, f.i + 1);
    const last = sp.nodes.length - 1;
    expect(filletAt(sp, last)!.j).toBe(0);

    expect(unroundCorner(sp, last)).toBe(0);
    expect(sp.nodes).toHaveLength(4);
    // Same four corners, whichever node the walk now starts at.
    const pts = sp.nodes.map((n) => `${n.pt[0]},${n.pt[1]}`).sort();
    expect(pts).toEqual(['0,0', '0,40', '40,0', '40,40'].sort());
    expect(sp.nodes.every((n) => n.hIn === null && n.hOut === null)).toBe(true);
  });

  it('unrounds a corner that is not a right angle back to where it was', () => {
    const sp = wedge();
    const was = serialisePath([sp], { decimals: 9 });
    roundCorner(sp, 1, 4);
    const f = onlyFillet(sp)!;
    expect(unroundCorner(sp, f.i)).not.toBeNull();
    expect(serialisePath([sp], { decimals: 9 })).toBe(was);
  });

  /* The property the widget rests on: unround, round again at the same radius,
     and the path is what it was. Anything less and a second drag on a corner
     would drift it. */
  for (const radius of [2, 7, 15]) {
    it(`round-trips at radius ${radius}`, () => {
      const sp = square();
      roundCorner(sp, 1, radius);
      const once = serialisePath([sp], { decimals: 9 });
      const f = onlyFillet(sp)!;
      const at = unroundCorner(sp, f.i)!;
      roundCorner(sp, at, radius);
      expect(serialisePath([sp], { decimals: 9 })).toBe(once);
    });
  }

  it('refuses a node that does not start a fillet', () => {
    const sp = square();
    expect(unroundCorner(sp, 0)).toBeNull();
    expect(sp.nodes).toHaveLength(4);
  });
});
