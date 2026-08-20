/**
 * Rounding a corner whose sides are curves.
 *
 * A fillet is defined by tangency, so that is what these measure. Nothing here
 * compares `roundCorner` against a second way of computing the same thing: the
 * arc is checked for being a circle by the distance from its own centre, the
 * joins are checked for being smooth by the angle across them, and the sides
 * are checked for having been cut rather than redrawn by projecting what is
 * left back onto the curve it came from.
 *
 * `docs/ARCHITECTURE.md` §23 has the construction and §48 the recovery.
 */

import { describe, expect, it } from 'vitest';
import { cubicAt, cubicLength, cubicUnitTangent, projectToCubic } from '../src/core/bezier';
import { parsePath } from '../src/core/parse';
import { serialisePath } from '../src/core/serialise';
import { ellipseSubpath } from '../src/core/primitives';
import { segmentAsCubic, segmentCount } from '../src/core/types';
import type { Cubic, Pt, Subpath } from '../src/core/types';
import {
  cornerAt,
  filletAt,
  maxCornerRadius,
  roundCorner,
  sharedCornerRadius,
  unroundCorner,
} from '../src/model/corner';

/* Three nodes and three curves, off the origin and off both axes. Node 1 is a
   cusp of about 68 degrees with neither of its sides straight. */
const LEAF = 'M40 90 C40 50 70 30 110 30 C100 55 95 70 130 95 C100 105 60 105 40 90 Z';

/** A line arriving and a curve leaving, at node 1. */
const HALF = 'M40 30 L110 30 C130 50 130 80 110 100 L40 100 Z';

/** A curve arriving and a line leaving, at node 1. */
const OTHER = 'M40 30 C60 10 100 10 120 30 L120 100 L40 100 Z';

const at = (sp: Subpath, i: number): Pt => sp.nodes[i].pt;
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Direction of travel leaving node `i`, and arriving at it, from the handles. */
function travel(sp: Subpath, i: number, which: 'in' | 'out'): Pt {
  const n = sp.nodes[i];
  const d: Pt =
    which === 'out'
      ? n.hOut
        ? [n.hOut[0] - n.pt[0], n.hOut[1] - n.pt[1]]
        : [
            sp.nodes[(i + 1) % sp.nodes.length].pt[0] - n.pt[0],
            sp.nodes[(i + 1) % sp.nodes.length].pt[1] - n.pt[1],
          ]
      : n.hIn
        ? [n.pt[0] - n.hIn[0], n.pt[1] - n.hIn[1]]
        : [
            n.pt[0] - sp.nodes[(i - 1 + sp.nodes.length) % sp.nodes.length].pt[0],
            n.pt[1] - sp.nodes[(i - 1 + sp.nodes.length) % sp.nodes.length].pt[1],
          ];
  const l = Math.hypot(d[0], d[1]);
  return [d[0] / l, d[1] / l];
}

/** The angle, in radians, between how the path arrives at `i` and how it leaves. */
const kinkAt = (sp: Subpath, i: number): number => {
  const a = travel(sp, i, 'in');
  const b = travel(sp, i, 'out');
  return Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
};

/**
 * The circle a segment sits on, found from its two ends and nothing else.
 *
 * The centre of a circle is on the normal at every point of it, so the normals
 * at the two ends cross there. Read off the segment rather than taken from the
 * code that built it, which is what lets the samples below be evidence.
 */
function circleOf(sp: Subpath, seg: number): { centre: Pt; r: number } | null {
  const c = segmentAsCubic(sp, seg);
  const t0 = cubicUnitTangent(c, 0);
  const t1 = cubicUnitTangent(c, 1);
  if (!t0 || !t1) return null;
  const n0: Pt = [-t0[1], t0[0]];
  const n1: Pt = [-t1[1], t1[0]];
  const det = n0[0] * -n1[1] - -n1[0] * n0[1];
  if (Math.abs(det) < 1e-12) return null;
  const w: Pt = [c[3][0] - c[0][0], c[3][1] - c[0][1]];
  const k = (w[0] * -n1[1] - -n1[0] * w[1]) / det;
  const centre: Pt = [c[0][0] + n0[0] * k, c[0][1] + n0[1] * k];
  return { centre, r: dist(centre, c[0]) };
}

/** The worst distance from the arc at `seg` to the circle it claims to be on. */
function outOfRound(sp: Subpath, seg: number, steps = 32): number {
  const fit = circleOf(sp, seg);
  if (!fit) return Infinity;
  const c = segmentAsCubic(sp, seg);
  let worst = 0;
  for (let k = 0; k <= steps; k++) {
    worst = Math.max(worst, Math.abs(dist(cubicAt(c, k / steps), fit.centre) - fit.r));
  }
  return worst;
}

/** The worst distance from any point of `piece` to the curve `whole`. */
function strayFrom(piece: Cubic, whole: Cubic, steps = 32): number {
  let worst = 0;
  for (let k = 0; k <= steps; k++) {
    worst = Math.max(worst, projectToCubic(whole, cubicAt(piece, k / steps), 60, 40).d);
  }
  return worst;
}

/**
 * What `strayFrom` reports for points that are exactly on the curve.
 *
 * `projectToCubic` samples and then narrows, so it answers a little above zero
 * even when the point it is given is on the curve. Measuring that here rather
 * than picking a tolerance keeps the check on the geometry: a piece that has
 * drifted has to beat the instrument, not a number somebody chose.
 */
const projectorFloor = (whole: Cubic): number => strayFrom(whole, whole);

/** Every coordinate a subpath holds, so two of them can be compared as numbers. */
function coords(sp: Subpath): number[] {
  const out: number[] = [sp.nodes.length, sp.closed ? 1 : 0];
  for (const n of sp.nodes) {
    out.push(n.pt[0], n.pt[1]);
    out.push(n.hIn ? n.hIn[0] : NaN, n.hIn ? n.hIn[1] : NaN);
    out.push(n.hOut ? n.hOut[0] : NaN, n.hOut ? n.hOut[1] : NaN);
  }
  return out;
}

/** Which segment of the rounded path is the arc: the one between the new pair. */
const arcSeg = (i: number): number => i;

describe('a cusp between two curves is a corner', () => {
  it.each([
    ['two curves', LEAF, 1],
    ['a line then a curve', HALF, 1],
    ['a curve then a line', OTHER, 1],
  ])('%s', (_what, d, i) => {
    const c = cornerAt(parsePath(d)[0], i);
    expect(typeof c).not.toBe('string');
    if (typeof c === 'string') return;
    // A real angle, not a path running smoothly through.
    expect(c.alpha).toBeGreaterThan(0.2);
    expect(c.alpha).toBeLessThan(Math.PI - 0.2);
  });

  it('is not a corner where the two curves meet smoothly', () => {
    // One curve through three nodes, with the middle one collinear by
    // construction: the tangents are exactly opposed there.
    const sp = parsePath('M40 40 C60 20 80 20 100 40 C120 60 140 60 160 40')[0];
    sp.nodes[1].hIn = [90, 30];
    sp.nodes[1].hOut = [110, 50];
    expect(cornerAt(sp, 1)).toBe('straight');
  });
});

describe('the arc meets each side without a kink', () => {
  it.each([
    ['two curves', LEAF, 1, 12],
    ['a line then a curve', HALF, 1, 14],
    ['a curve then a line', OTHER, 1, 10],
  ])('%s', (_what, d, i, r) => {
    const sp = parsePath(d)[0];
    const before = sp.nodes.length;
    const done = roundCorner(sp, i, r);
    expect(typeof done).not.toBe('string');
    expect(sp.nodes.length).toBe(before + 1);

    /* The two joins the arc made. A fillet that is a fraction of a degree off
       tangent looks right and is wrong, which is the whole reason this is
       measured rather than eyeballed. */
    expect(kinkAt(sp, i)).toBeLessThan(1e-9);
    expect(kinkAt(sp, i + 1)).toBeLessThan(1e-9);
  });
});

describe('the arc is a circle of the radius asked for', () => {
  it.each([
    ['two curves', LEAF, 1, 12],
    ['a line then a curve', HALF, 1, 14],
    ['a curve then a line', OTHER, 1, 10],
  ])('%s', (_what, d, i, r) => {
    const sp = parsePath(d)[0];
    const done = roundCorner(sp, i, r);
    expect(typeof done).not.toBe('string');
    if (typeof done === 'string') return;
    expect(done.clamped).toBe(false);
    expect(done.radius).toBeCloseTo(r, 9);

    const fit = circleOf(sp, arcSeg(i))!;
    // The radius the geometry has, against the one that was requested.
    expect(fit.r).toBeCloseTo(r, 6);
    /* Every point of the arc the same distance from that centre. The floor is
       not zero: a cubic only approximates a circle, at 0.027 % of the radius
       over a quarter turn (§12) and more over a longer one, and these turn
       through 112, 135 and 135 degrees. Measured worst here is 0.12 % of the
       radius. Half a percent separates that from a curve built to the wrong
       handle length, which is out by a quarter and shows as several percent. */
    expect(outOfRound(sp, arcSeg(i))).toBeLessThan(r * 5e-3);
  });
});

describe('what is left of a side is a piece of the side', () => {
  it('lies on the curve it was cut from, rather than near it', () => {
    // Node 1's two sides are segment 0 arriving and segment 1 leaving.
    const before = parsePath(LEAF)[0];
    const incoming = segmentAsCubic(before, 0);
    const outgoing = segmentAsCubic(before, 1);

    const sp = parsePath(LEAF)[0];
    expect(typeof roundCorner(sp, 1, 12)).not.toBe('string');

    /* A cut side has to still be the same curve. An arc placed near the corner
       with the sides redrawn to meet it would pass the tangency test above and
       fail this one, because the redrawn piece would not sit on the original.
       Rounding splices a node in, so what is left of the sides is now segment 0
       and segment 2 with the arc between them. */
    expect(strayFrom(segmentAsCubic(sp, 0), incoming)).toBeLessThanOrEqual(projectorFloor(incoming));
    expect(strayFrom(segmentAsCubic(sp, 2), outgoing)).toBeLessThanOrEqual(projectorFloor(outgoing));
  });

  it('keeps a straight side straight, so it still exports as a line', () => {
    const sp = parsePath(HALF)[0];
    expect(typeof roundCorner(sp, 1, 14)).not.toBe('string');
    // Segment 0 is the straight side that was cut. Both its handles stay absent.
    expect(sp.nodes[0].hOut).toBeNull();
    expect(sp.nodes[1].hIn).toBeNull();
  });
});

describe('a corner cut with a curved side goes back exactly', () => {
  it.each([
    ['two curves', LEAF, 1, 12],
    ['a line then a curve', HALF, 1, 14],
    ['a curve then a line', OTHER, 1, 10],
  ])('%s', (_what, d, i, r) => {
    const before = coords(parsePath(d)[0]);
    const sp = parsePath(d)[0];
    expect(typeof roundCorner(sp, i, r)).not.toBe('string');

    const back = unroundCorner(sp, i);
    expect(back).toBe(i);
    const after = coords(sp);
    expect(after).toHaveLength(before.length);
    for (let k = 0; k < before.length; k++) {
      expect(Number.isNaN(after[k])).toBe(Number.isNaN(before[k]));
      if (!Number.isNaN(before[k])) expect(after[k]).toBeCloseTo(before[k], 6);
    }
  });

  it('recovers the corner point and the radius it was cut with', () => {
    const sp = parsePath(LEAF)[0];
    const corner = at(parsePath(LEAF)[0], 1);
    expect(typeof roundCorner(sp, 1, 12)).not.toBe('string');

    const f = filletAt(sp, 1);
    expect(f).not.toBeNull();
    expect(f!.radius).toBeCloseTo(12, 6);
    expect(dist(f!.at, corner)).toBeLessThan(1e-6);
  });

  it('refuses an arc that meets a curved side at an angle', () => {
    /* Everything about the arc still checks out -- circular, equal handles,
       tangent rays crossing at equal distances -- and the side it sits against
       no longer runs into it. An arc that is not tangent to its side was not
       cut from that side's corner, so there is no corner to hand back. */
    const sp = parsePath(LEAF)[0];
    expect(typeof roundCorner(sp, 1, 12)).not.toBe('string');
    expect(filletAt(sp, 1)).not.toBeNull();

    const h = sp.nodes[1].hIn!;
    const p = sp.nodes[1].pt;
    // The incoming curve's tangent at this node is set by this handle alone.
    // Turned by a fifth of a radian, the arc leaves at a kink.
    const a = Math.atan2(h[1] - p[1], h[0] - p[0]) + 0.2;
    const l = dist(h, p);
    sp.nodes[1].hIn = [p[0] + Math.cos(a) * l, p[1] + Math.sin(a) * l];
    expect(filletAt(sp, 1)).toBeNull();
  });

  it('hands back the centre of the circle the arc sits on', () => {
    /* What the canvas puts the radius control on: the arc's nearest point to
       the corner is `radius` back along the line from one to the other, and
       that is true whatever the sides are made of. A centre on the wrong side
       of the tangent puts the control across the shape. */
    for (const [d, i, r] of [
      ['M60 20 L200 90 L170 150 L30 80 Z', 0, 20],
      /* The same quadrilateral drawn the other way round. Every fixture above
         winds one way, and which side of the tangent the centre lies on is
         exactly what winding decides, so without this the sign is never read. */
      ['M60 20 L30 80 L170 150 L200 90 Z', 0, 20],
      [LEAF, 1, 12],
      [HALF, 1, 14],
      [OTHER, 1, 10],
    ] as [string, number, number][]) {
      const sp = parsePath(d)[0];
      expect(typeof roundCorner(sp, i, r)).not.toBe('string');
      const f = filletAt(sp, i);
      expect(f, d).not.toBeNull();
      // Equidistant from both touch points, at exactly the radius.
      expect(dist(f!.centre, sp.nodes[f!.i].pt)).toBeCloseTo(r, 6);
      expect(dist(f!.centre, sp.nodes[f!.j].pt)).toBeCloseTo(r, 6);
      // And further from the corner than the radius, which is what puts the
      // arc between the two rather than across them.
      expect(dist(f!.centre, f!.at)).toBeGreaterThan(r);
    }
  });

  it('survives being written to a file and read back', () => {
    /* The recognition tolerances are the width of the coordinate grid a save
       rounds to, not floating-point slack. Tight enough for exact geometry and
       a rounded corner stops being one the moment it goes through the source
       drawer, which is what it did until 2026-08-20. */
    const cases: [string, number, number][] = [
      ['M60 20 L200 90 L170 150 L30 80 Z', 0, 30],
      ['M60 20 L200 90 L170 150 L30 80 Z', 0, 0.5],
      ['M0 40 L100 0 L200 40 L100 44 Z', 1, 6],
      ['M0 40 L100 0 L104 40 L52 60 Z', 1, 6],
      // Far from the origin, where the quantum is a smaller share of each number.
      ['M1060 1020 L1200 1090 L1170 1150 L1030 1080 Z', 0, 30],
    ];
    for (const [d, i, r] of cases) {
      const sp = parsePath(d)[0];
      expect(typeof roundCorner(sp, i, r)).not.toBe('string');
      const saved = parsePath(serialisePath([sp], { decimals: 3 }))[0];
      const found = saved.nodes.map((_, k) => (filletAt(saved, k) ? k : -1)).filter((k) => k >= 0);
      expect(found, `${d} at r ${r}`).toHaveLength(1);
      // And the radius still reads back as the one it was cut with.
      expect(filletAt(saved, found[0])!.radius).toBeCloseTo(r, 2);
    }
  });

  it('tells a circle from an ellipse, and reads a circle as filleted', () => {
    /* An ellipse's segments are not circular arcs, so none of its nodes claims
       to be a corner. A circle's are, and every node of one does -- the sides
       either side of any node cross at about 165 degrees when carried past
       their ends, and an arc tangent to both of them at that radius is what
       sits between. It is a fillet by every measure this can take.

       That is a limit rather than a decision, and it is not new: a circle built
       at full precision read this way before any of the corner work as well.
       What changed on 2026-08-20 is only that the fixture here used to be
       written at four decimals, so the old tolerance rejected it for its
       rounding rather than for its shape. §48. */
    const round = ellipseSubpath(50, 50, 40, 40);
    const asFillet = round.nodes.map((_, i) => (filletAt(round, i) ? i : -1)).filter((i) => i >= 0);
    expect(asFillet).toHaveLength(round.nodes.length);

    const oval = ellipseSubpath(50, 50, 60, 30);
    for (let i = 0; i < oval.nodes.length; i++) expect(filletAt(oval, i)).toBeNull();
  });

});

describe('the clamp on a curved side', () => {
  it('stops the arc before it runs off the end of a side', () => {
    const sp = parsePath(LEAF)[0];
    const c = cornerAt(sp, 1);
    if (typeof c === 'string') throw new Error(c);
    const max = maxCornerRadius(c);
    expect(max).toBeGreaterThan(0);

    // Just inside the limit both tangent points land on the sides, so the pair
    // is inserted whole and the arc meets each side smoothly.
    const inside = parsePath(LEAF)[0];
    expect(typeof roundCorner(inside, 1, max * 0.98)).not.toBe('string');
    expect(inside.nodes.length).toBe(4);
    expect(kinkAt(inside, 1)).toBeLessThan(1e-9);
    expect(kinkAt(inside, 2)).toBeLessThan(1e-9);

    /* At the limit the far tangent point has arrived at the neighbour, which is
       what the limit is: `roundCorner` reuses that node rather than leaving two
       anchors on one point. The side is used up, so the join there is the
       corner the arc did not reach and not a kink the arc left. */
    const held = parsePath(LEAF)[0];
    const done = roundCorner(held, 1, max);
    expect(typeof done).not.toBe('string');
    if (typeof done === 'string') return;
    expect(done.radius).toBeCloseTo(max, 6);
    expect(held.nodes.length).toBe(3);
    expect(kinkAt(held, 1)).toBeLessThan(1e-9);
  });

  it('will not go past the limit even when asked just over it', () => {
    const c = cornerAt(parsePath(LEAF)[0], 1);
    if (typeof c === 'string') throw new Error(c);
    const max = maxCornerRadius(c);
    const sp = parsePath(LEAF)[0];
    const done = roundCorner(sp, 1, max * 1.05);
    expect(typeof done).not.toBe('string');
    if (typeof done === 'string') return;
    expect(done.clamped).toBe(true);
    expect(done.radius).toBeCloseTo(max, 6);
  });

  it('cuts an oversized radius down instead of refusing it', () => {
    const sp = parsePath(LEAF)[0];
    const done = roundCorner(sp, 1, 1e6);
    expect(typeof done).not.toBe('string');
    if (typeof done === 'string') return;
    expect(done.clamped).toBe(true);
    expect(done.radius).toBeLessThan(1e6);
    expect(done.radius).toBeGreaterThan(0);
    // Cut down, not cut away: the arc is still tangent to what is left.
    expect(kinkAt(sp, 1)).toBeLessThan(1e-9);
  });
});

describe('two curved corners sharing a side', () => {
  /**
   * Each may have half of the side between them, and no more.
   *
   * Measured on what is left rather than on the number handed back: two arcs
   * that ate past the middle would leave the segment between them running
   * backwards, and its length is the thing that says so.
   */
  it('leaves the side between them with room to spare', () => {
    const sp = parsePath(LEAF)[0];
    const ids = [sp.nodes[1].id, sp.nodes[2].id];
    const shared = sharedCornerRadius(sp, ids);
    expect(shared).toBeGreaterThan(0);

    // Highest index first, because rounding one splices a node in beside it.
    const order = [2, 1];
    for (const i of order) expect(typeof roundCorner(sp, i, shared)).not.toBe('string');
    expect(sp.nodes.length).toBe(5);

    /* Nodes 2 and 3 are the two touch points facing each other across the side
       they share, so segment 2 is what is left of it. */
    const between = cubicLength(segmentAsCubic(sp, 2));
    expect(between).toBeGreaterThan(0);
    // And each arc took no more than its half.
    const whole = cubicLength(segmentAsCubic(parsePath(LEAF)[0], 1));
    expect(between).toBeLessThan(whole);
    expect(kinkAt(sp, 2)).toBeLessThan(1e-9);
    expect(kinkAt(sp, 3)).toBeLessThan(1e-9);
  });

  it('gives each less than it would have had alone', () => {
    const sp = parsePath(LEAF)[0];
    const alone = sharedCornerRadius(sp, [sp.nodes[1].id]);
    const shared = sharedCornerRadius(sp, [sp.nodes[1].id, sp.nodes[2].id]);
    expect(shared).toBeLessThan(alone);
  });
});

describe('the solver agrees with the closed form where both can answer', () => {
  /**
   * A corner whose sides are curves that happen to be straight.
   *
   * Handles at the thirds of each side make `segmentIsLine` false, so the
   * general solve runs, while the geometry is the same line the closed form
   * handles. The two have to land on the same tangent points, which is the one
   * case where Newton can be checked against an exact answer.
   */
  const PLAIN = 'M40 30 L110 30 L110 100 L40 100 Z';

  /* Built rather than parsed: the parser recognises a cubic that is really a
     line and stores it as one, which is the opposite of what this needs. */
  const spelledRect = (): Subpath => {
    const sp = parsePath(PLAIN)[0];
    const part = (a: Pt, b: Pt, k: number): Pt => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    for (const [x, y] of [
      [0, 1],
      [1, 2],
    ]) {
      sp.nodes[x].hOut = part(sp.nodes[x].pt, sp.nodes[y].pt, 1 / 3);
      sp.nodes[y].hIn = part(sp.nodes[x].pt, sp.nodes[y].pt, 2 / 3);
    }
    return sp;
  };

  it.each([4, 11, 23])('at radius %i', (r) => {
    const spelled = spelledRect();
    const plain = parsePath(PLAIN)[0];
    expect(typeof roundCorner(spelled, 1, r)).not.toBe('string');
    expect(typeof roundCorner(plain, 1, r)).not.toBe('string');

    // The two tangent points, which is what the solve is for.
    for (const k of [1, 2]) {
      expect(dist(at(spelled, k), at(plain, k))).toBeLessThan(1e-7);
    }
  });

  it('reports the same largest radius from either spelling', () => {
    const a = cornerAt(spelledRect(), 1);
    const b = cornerAt(parsePath(PLAIN)[0], 1);
    if (typeof a === 'string' || typeof b === 'string') throw new Error('no corner');
    expect(a.lines).toEqual([false, false]);
    expect(b.lines).toEqual([true, true]);
    expect(maxCornerRadius(a)).toBeCloseTo(maxCornerRadius(b), 5);
  });
});

describe('every segment survives a round', () => {
  it('leaves the path with one more node and one more segment', () => {
    const sp = parsePath(LEAF)[0];
    const segs = segmentCount(sp);
    expect(typeof roundCorner(sp, 1, 12)).not.toBe('string');
    expect(segmentCount(sp)).toBe(segs + 1);
    for (const n of sp.nodes) {
      expect(Number.isFinite(n.pt[0]) && Number.isFinite(n.pt[1])).toBe(true);
      for (const h of [n.hIn, n.hOut]) {
        if (h) expect(Number.isFinite(h[0]) && Number.isFinite(h[1])).toBe(true);
      }
    }
  });
});
