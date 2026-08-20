/**
 * Every geometric edit commutes with moving the drawing.
 *
 * Edit a path, then move it; or move it, then edit it. The two must agree, and
 * they only disagree when something inside has confused a point with a vector.
 * `a + (b - a) / 3` and `a + (b + a) / 3` are the same number at the origin and
 * different everywhere else, which is why a fixture spelled `M0 0 ...` cannot
 * tell them apart -- and every fixture in `ops.test.ts` is spelled that way.
 *
 * So this is not another off-origin fixture. It is the property those fixtures
 * were failing to state, applied once to the whole table: any operation added
 * below inherits the check, and the offset is supplied here rather than by
 * whoever writes the next test.
 *
 * What it does not reach: an error between two quantities that are both already
 * differences. Translating moves both by the same amount, so a sign flip
 * between them survives. Those need a test that says where the geometry went.
 */

import { describe, expect, it } from 'vitest';
import { parsePath } from '../src/core/parse';
import {
  closeSubpath,
  deleteNode,
  fuseNodes,
  latentHandle,
  moveAnchor,
  moveHandle,
  reshapeSegment,
  reverseSubpath,
  setContinuity,
  setSegmentCurved,
  splitSegment,
} from '../src/model/ops';
import {
  cornerAt,
  filletAt,
  roundCorner,
} from '../src/model/corner';
import { serialisePath } from '../src/core/serialise';
import { ellipseSubpath, polygonSubpath, rectSubpath } from '../src/core/primitives';
import { arcToCubics } from '../src/core/arc';
import type { Cubic, Pt, Subpath } from '../src/core/types';

/** Off the origin and off both axes, with the two components unequal. */
const V: Pt = [137, -61];

const moved = (p: Pt): Pt => [p[0] + V[0], p[1] + V[1]];

function shift(sp: Subpath): Subpath {
  return {
    ...sp,
    nodes: sp.nodes.map((n) => ({
      ...n,
      pt: moved(n.pt),
      hIn: n.hIn ? moved(n.hIn) : null,
      hOut: n.hOut ? moved(n.hOut) : null,
    })),
  };
}

/** Every coordinate a subpath holds, in order, so a diff names the node. */
function coords(sp: Subpath): number[] {
  const out: number[] = [sp.nodes.length, sp.closed ? 1 : 0];
  for (const n of sp.nodes) {
    out.push(n.pt[0], n.pt[1]);
    out.push(n.hIn ? n.hIn[0] : NaN, n.hIn ? n.hIn[1] : NaN);
    out.push(n.hOut ? n.hOut[0] : NaN, n.hOut ? n.hOut[1] : NaN);
  }
  return out;
}

/**
 * Compare two coordinate runs, where a missing handle must stay missing.
 *
 * `NaN` stands for a null handle, and `toBeCloseTo` passes on any pair of them,
 * so the two runs are compared for null-ness first and for position second.
 */
function sameGeometry(a: number[], b: number[], shiftBy: Pt): void {
  expect(a.length).toBe(b.length);
  for (let k = 0; k < a.length; k++) {
    expect(Number.isNaN(a[k])).toBe(Number.isNaN(b[k]));
    if (Number.isNaN(a[k])) continue;
    // The first two entries are the node count and the closed flag, and the
    // coordinates alternate x, y from there.
    const d = k < 2 ? 0 : shiftBy[k % 2];
    expect(b[k]).toBeCloseTo(a[k] + d, 8);
  }
}

/** A curved open path, a rectangle, and a corner with neither side on an axis. */
const CURVE = 'M0 0 C0 20 40 20 40 0 C40 -20 80 -20 80 0';
const RECT = 'M0 0 L40 0 L40 25 L0 25 Z';
const SKEW = 'M0 0 L40 10 L10 40 Z';
/** Cusps with a curve on each side, where the arc is solved for rather than measured out. */
const LEAF = 'M0 50 C0 10 30 -10 70 -10 C60 15 55 30 90 55 C60 65 20 65 0 50 Z';

interface Op {
  name: string;
  d: string;
  /** `mv` puts a document point into the frame of the copy being edited. */
  run: (sp: Subpath, mv: (p: Pt) => Pt) => void;
}

const OPS: Op[] = [
  { name: 'moveAnchor', d: CURVE, run: (sp, mv) => moveAnchor(sp, 1, mv([45, 5])) },
  { name: 'moveHandle on a smooth node', d: CURVE, run: (sp, mv) => moveHandle(sp, 1, 'out', mv([55, -14])) },
  { name: 'moveHandle with the pair broken', d: CURVE, run: (sp, mv) => moveHandle(sp, 1, 'out', mv([55, -14]), true) },
  { name: 'setContinuity smooth', d: RECT, run: (sp) => setContinuity(sp, 1, 'smooth') },
  { name: 'setContinuity symmetric', d: RECT, run: (sp) => setContinuity(sp, 1, 'symmetric') },
  { name: 'setContinuity cusp', d: CURVE, run: (sp) => setContinuity(sp, 1, 'cusp') },
  { name: 'splitSegment', d: CURVE, run: (sp) => splitSegment(sp, 0, 0.37) },
  { name: 'setSegmentCurved', d: RECT, run: (sp) => setSegmentCurved(sp, 1, true) },
  { name: 'deleteNode in the middle', d: CURVE, run: (sp) => deleteNode(sp, 1) },
  { name: 'deleteNode at the head of an open path', d: CURVE, run: (sp) => deleteNode(sp, 0) },
  { name: 'deleteNode at the tail of an open path', d: CURVE, run: (sp) => deleteNode(sp, sp.nodes.length - 1) },
  { name: 'deleteNode from a closed path', d: RECT, run: (sp) => deleteNode(sp, 2) },
  { name: 'reverseSubpath', d: CURVE, run: (sp) => reverseSubpath(sp) },
  { name: 'closeSubpath', d: CURVE, run: (sp) => closeSubpath(sp) },
  { name: 'reshapeSegment', d: CURVE, run: (sp, mv) => reshapeSegment(sp, 0, 0.4, mv([18, 31])) },
  { name: 'roundCorner on a rectangle', d: RECT, run: (sp) => roundCorner(sp, 1, 7) },
  { name: 'roundCorner on a skew corner', d: SKEW, run: (sp) => roundCorner(sp, 1, 5) },
  /* The solved fillet, not the measured one. Newton runs on absolute
     coordinates, so a step that is right at the origin and wrong out here is
     exactly what this table exists to catch. */
  { name: 'roundCorner between two curves', d: LEAF, run: (sp) => roundCorner(sp, 1, 9) },
  { name: 'roundCorner with one curved side', d: LEAF, run: (sp) => roundCorner(sp, 2, 6) },
  { name: 'fuseNodes', d: CURVE, run: (sp) => fuseNodes(sp, 1, 2) },
];

describe('an edit commutes with moving the drawing', () => {
  it.each(OPS)('$name', ({ d, run }) => {
    const here = parsePath(d)[0];
    const there = shift(parsePath(d)[0]);

    const untouched = coords(here);
    run(here, (p) => p);
    run(there, moved);

    /* An operation that declined to act agrees with itself perfectly, on both
       copies, and says nothing about anything. Every entry in the table has to
       move the geometry before its agreement is worth reading. */
    expect(coords(here)).not.toEqual(untouched);
    sameGeometry(coords(here), coords(there), V);
  });

  it('would notice a term that should be a difference and is a sum', () => {
    /* The guard on the guard: `sameGeometry` compares a translated copy against
       a translated original, so a shape of error it cannot see is a shape of
       error the whole file cannot see. This is the shape the file exists for --
       a point where a vector belongs -- built by hand and required to fail. */
    const sp = parsePath(RECT)[0];
    const wrong = (s: Subpath, i: number): Pt => {
      const a = s.nodes[i].pt;
      const b = s.nodes[(i + 1) % s.nodes.length].pt;
      return [a[0] + (b[0] + a[0]) / 3, a[1] + (b[1] + a[1]) / 3];
    };
    const shifted = shift(sp);
    expect(wrong(shifted, 1)).not.toEqual(moved(wrong(sp, 1)));
    // And the real one does commute, which is what the table above asserts.
    expect(latentHandle(shifted, 1, 'out')).toEqual(moved(latentHandle(sp, 1, 'out') as Pt));
  });
});

describe('what a reading of the geometry reports', () => {
  it.each([
    ['out', 1],
    ['in', 1],
    ['out', 0],
    ['in', 3],
  ] as const)('latentHandle %s of node %i travels with the path', (which, i) => {
    const here = latentHandle(parsePath(RECT)[0], i, which);
    const there = latentHandle(shift(parsePath(RECT)[0]), i, which);
    expect(there).toEqual(moved(here as Pt));
  });

  it('latentHandle still refuses the ends of an open path once it has moved', () => {
    const open = shift(parsePath(CURVE)[0]);
    expect(latentHandle(open, 0, 'in')).toBeNull();
    expect(latentHandle(open, open.nodes.length - 1, 'out')).toBeNull();
    /* And a closed path answers both, by wrapping. Node 0's incoming neighbour
       is the last node, [0, 25], so a third of the way back is [0, 25 / 3] --
       stated as the arithmetic rather than taken from the function. */
    const ring = shift(parsePath(RECT)[0]);
    expect(latentHandle(ring, 0, 'in')).toEqual(moved([0, 25 / 3]));
    expect(latentHandle(ring, 3, 'out')).toEqual(moved([0, 25 - 25 / 3]));
  });

  it('cornerAt reports the same angle and reach from anywhere', () => {
    const here = cornerAt(parsePath(SKEW)[0], 1);
    const there = cornerAt(shift(parsePath(SKEW)[0]), 1);
    if (typeof here === 'string' || typeof there === 'string') throw new Error('refused');
    expect(there.alpha).toBeCloseTo(here.alpha, 12);
    expect(there.lengths[0]).toBeCloseTo(here.lengths[0], 9);
    expect(there.lengths[1]).toBeCloseTo(here.lengths[1], 9);
    expect(there.u[0]).toBeCloseTo(here.u[0], 12);
    expect(there.v[1]).toBeCloseTo(here.v[1], 12);
    expect(there.at[0]).toBeCloseTo(here.at[0] + V[0], 9);
    expect(there.at[1]).toBeCloseTo(here.at[1] + V[1], 9);
  });

  it('filletAt finds the same corner and radius from anywhere', () => {
    const build = (): Subpath => {
      const sp = parsePath(RECT)[0];
      roundCorner(sp, 1, 6);
      return sp;
    };
    const here = filletAt(build(), 1);
    const there = filletAt(shift(build()), 1);
    if (!here || !there) throw new Error('no fillet');
    expect(there.radius).toBeCloseTo(here.radius, 9);
    expect(there.at[0]).toBeCloseTo(here.at[0] + V[0], 6);
    expect(there.at[1]).toBeCloseTo(here.at[1] + V[1], 6);
  });
});

/**
 * The same property, one layer out: reading a `d`, writing one, and building a
 * shape from its centre.
 *
 * `ops.ts` was swept for the origin class and these three were not, though the
 * 2026-08-19d wave found the same shape in all of them. Each is a place where
 * a point and a difference sit in the same argument list, which is the only
 * condition the class needs.
 */
describe('reading a path commutes with moving the drawing', () => {
  /* Written out by hand rather than computed, so the test does not reimplement
     the thing it is checking. Absolute coordinates carry `V`; relative ones do
     not, because a relative command is already a difference. A parser that adds
     the current point to the wrong operand, or treats a relative pair as
     absolute, agrees with the correct one only when the path starts at 0 0. */
  const READS: [name: string, here: string, there: string][] = [
    ['absolute cubics', 'M10 20 C10 40 50 40 50 20', 'M147 -41 C147 -21 187 -21 187 -41'],
    ['relative cubics', 'M10 20 c0 20 40 20 40 0', 'M147 -41 c0 20 40 20 40 0'],
    ['absolute lines and their shorthands', 'M10 20 H40 V35 L30 40 Z', 'M147 -41 H177 V-26 L167 -21 Z'],
    ['relative lines and their shorthands', 'M10 20 h30 v15 l-10 5 Z', 'M147 -41 h30 v15 l-10 5 Z'],
    ['absolute quadratics', 'M10 20 Q30 40 50 20 T90 20', 'M147 -41 Q167 -21 187 -41 T227 -41'],
    ['relative quadratics', 'M10 20 q20 20 40 0 t40 0', 'M147 -41 q20 20 40 0 t40 0'],
    ['absolute smooth cubics', 'M10 20 C10 40 50 40 50 20 S90 0 90 20', 'M147 -41 C147 -21 187 -21 187 -41 S227 -61 227 -41'],
    ['relative smooth cubics', 'M10 20 c0 20 40 20 40 0 s40 -20 40 0', 'M147 -41 c0 20 40 20 40 0 s40 -20 40 0'],
    ['an absolute arc', 'M10 20 A25 15 30 1 0 60 45', 'M147 -41 A25 15 30 1 0 197 -16'],
    ['a relative arc', 'M10 20 a25 15 30 1 0 50 25', 'M147 -41 a25 15 30 1 0 50 25'],
    ['a second subpath opened relatively', 'M10 20 L30 20 m5 5 l10 0', 'M147 -41 L167 -41 m5 5 l10 0'],
  ];

  it.each(READS)('%s', (_name, here, there) => {
    const a = parsePath(here);
    const b = parsePath(there);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
    a.forEach((sp, i) => sameGeometry(coords(sp), coords(b[i]), V));
  });
});

describe('writing a path commutes with moving the drawing', () => {
  /* Round tripped rather than compared as text: two `d` strings that differ
     only by 137 are not equal as strings, and what has to agree is the geometry
     they name. The shorthand and relative paths are both exercised, because
     those are the two places the serialiser computes a difference and could
     compute a sum. Every fixture is on integers, so rounding to `PATH_DECIMALS`
     lands in the same place before and after the move.

     **The minified row is the only one that reaches the relative branch**, and
     it was measured: a sum where `rel[i] = rel[i] - pen[0]` belongs fails that
     row alone. A relative command is emitted only where it is shorter, and on
     these four fixtures nothing but minifying makes it so. The other two rows
     cover the absolute branch, which is not the same code. */
  const WRITES: [name: string, options: Parameters<typeof serialisePath>[1]][] = [
    ['with shorthands', { shorthands: true }],
    ['without shorthands', { shorthands: false }],
    ['minified', { minify: true }],
  ];

  it.each(WRITES)('%s', (_name, options) => {
    for (const d of [CURVE, RECT, SKEW, LEAF]) {
      const here = parsePath(serialisePath(parsePath(d), options));
      const there = parsePath(serialisePath(parsePath(d).map(shift), options));
      expect(there.length).toBe(here.length);
      here.forEach((sp, i) => sameGeometry(coords(sp), coords(there[i]), V));
    }
  });
});

describe('building a shape from its centre commutes with moving the drawing', () => {
  /* A radius is a difference and a centre is a point, in one argument list.
     `cx + rx` and `rx` are the same number when `cx` is 0, which is how every
     primitive fixture that starts at the origin is written. */
  it('an ellipse', () => {
    const here = ellipseSubpath(30, 20, 18, 11);
    const there = ellipseSubpath(30 + V[0], 20 + V[1], 18, 11);
    sameGeometry(coords(here), coords(there), V);
  });

  it('a rectangle', () => {
    const here = rectSubpath(30, 20, 45, 25);
    const there = rectSubpath(30 + V[0], 20 + V[1], 45, 25);
    sameGeometry(coords(here), coords(there), V);
  });

  it('a rectangle dragged the other way, so the corner is not the origin', () => {
    const here = rectSubpath(30, 20, -45, -25);
    const there = rectSubpath(30 + V[0], 20 + V[1], -45, -25);
    sameGeometry(coords(here), coords(there), V);
  });

  it.each([
    ['a polygon', 5, null],
    ['a star', 6, 0.42],
  ] as const)('%s', (_name, corners, inner) => {
    const here = polygonSubpath(30, 20, 18, 11, corners, inner);
    const there = polygonSubpath(30 + V[0], 20 + V[1], 18, 11, corners, inner);
    sameGeometry(coords(here), coords(there), V);
  });
});

describe('an arc commutes with moving the drawing', () => {
  /* The centre is solved for from the two endpoints, so a step that is right at
     the origin and wrong out here is what this catches -- the argument the
     fillet entry above already makes, applied to the other solved construction
     in the tree. The radii, the rotation and the two flags are shape rather
     than position and are passed unchanged. */
  const flat = (cs: Cubic[]): number[] => cs.flatMap((c) => c.flatMap((p) => [p[0], p[1]]));

  it.each([
    ['the large sweep', true, false],
    ['the small sweep', false, true],
  ] as const)('%s', (_name, largeArc, sweep) => {
    const here = arcToCubics([10, 20], 25, 15, 30, largeArc, sweep, [60, 45]);
    const there = arcToCubics(moved([10, 20]), 25, 15, 30, largeArc, sweep, moved([60, 45]));
    expect(here.length).toBeGreaterThan(0);
    expect(there.length).toBe(here.length);
    const a = flat(here);
    const b = flat(there);
    a.forEach((v, k) => expect(b[k]).toBeCloseTo(v + V[k % 2], 8));
  });
});
