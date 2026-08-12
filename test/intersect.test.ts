/**
 * Where two cubics cross.
 *
 * Measured rather than compared: an intersection is asserted by putting the
 * reported point back through both curves and checking it lies on each, which
 * catches an answer that is plausible and wrong in a way that comparing to a
 * hand-computed coordinate does not.
 */

import { describe, expect, it } from 'vitest';
import { cubicIntersections, hullNear } from '../src/core/intersect';
import { resolveSnap } from '../src/model/snapping';
import type { SnapSetup } from '../src/model/snapping';
import { emptyDoc, shapeFromPath } from '../src/model/doc';
import { cubicAt } from '../src/core/bezier';
import type { Cubic, Pt } from '../src/core/types';

/** A straight run as a cubic, controls on the thirds. */
const line = (a: Pt, b: Pt): Cubic => [
  a,
  [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
  [a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3],
  b,
];

/**
 * How far `p` is from the nearest point of `c`.
 *
 * Coarse scan, then refine around the winner. A flat scan at 4000 samples has a
 * resolution of 0.0035 on a fourteen-unit curve, which is coarser than the
 * tolerance being tested -- so the first version of this reported the yardstick
 * and called it algorithm error.
 */
function distanceTo(c: Cubic, p: Pt): number {
  const at = (t: number): number => {
    const q = cubicAt(c, t) as Pt;
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  };
  let best = Infinity;
  let bt = 0;
  const n = 2000;
  for (let i = 0; i <= n; i++) {
    const d = at(i / n);
    if (d < best) {
      best = d;
      bt = i / n;
    }
  }
  // Ternary search in the bracket the scan left, which is unimodal there.
  let lo = Math.max(0, bt - 1 / n);
  let hi = Math.min(1, bt + 1 / n);
  for (let k = 0; k < 80; k++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (at(a) < at(b)) hi = b;
    else lo = a;
  }
  return at((lo + hi) / 2);
}

/** Every reported crossing really is on both curves. */
function onBoth(a: Cubic, b: Cubic, pts: Pt[], tol: number): void {
  for (const p of pts) {
    expect(distanceTo(a, p)).toBeLessThan(tol);
    expect(distanceTo(b, p)).toBeLessThan(tol);
  }
}

describe('crossings of two cubics', () => {
  it('finds the one place two straight runs cross', () => {
    const a = line([0, 0], [10, 10]);
    const b = line([0, 10], [10, 0]);
    const hits = cubicIntersections(a, b);
    expect(hits).toHaveLength(1);
    expect(hits[0][0]).toBeCloseTo(5, 3);
    expect(hits[0][1]).toBeCloseTo(5, 3);
    onBoth(a, b, hits, 1e-3);
  });

  it('finds both crossings of a curve and a line through it', () => {
    // An arch, and a horizontal line through it below the peak.
    const arch: Cubic = [
      [0, 10],
      [0, -10],
      [10, -10],
      [10, 10],
    ];
    const across = line([-2, 2], [12, 2]);
    const hits = cubicIntersections(arch, across);
    expect(hits).toHaveLength(2);
    onBoth(arch, across, hits, 1e-3);
    // And they are on opposite sides, rather than the same point twice.
    expect(Math.abs(hits[0][0] - hits[1][0])).toBeGreaterThan(1);
  });

  it('reports nothing when the curves stay apart', () => {
    expect(cubicIntersections(line([0, 0], [10, 0]), line([0, 5], [10, 5]))).toEqual([]);
  });

  it('reports nothing for boxes that overlap where the curves do not', () => {
    /* The case that makes hull rejection alone insufficient: two arcs bowing
       away from each other have overlapping control boxes and never meet. */
    const up: Cubic = [
      [0, 0],
      [3, -6],
      [7, -6],
      [10, 0],
    ];
    const down: Cubic = [
      [0, 1],
      [3, 7],
      [7, 7],
      [10, 1],
    ];
    expect(cubicIntersections(up, down)).toEqual([]);
  });

  it('merges a tangency into one answer rather than a cluster', () => {
    /* Two curves that touch without crossing produce a run of overlapping
       boxes, one per subdivision that survives. Reporting each would be honest
       about the arithmetic and useless as a snap target. */
    const a = line([0, 0], [10, 0]);
    const touch: Cubic = [
      [2, 4],
      [4, -4],
      [6, -4],
      [8, 4],
    ];
    const hits = cubicIntersections(a, touch);
    expect(hits.length).toBeLessThanOrEqual(2);
    onBoth(a, touch, hits, 1e-2);
  });

  it('converges to the tolerance it was given', () => {
    const a = line([0, 0], [10, 10]);
    const b = line([0, 10], [10, 0]);
    const coarse = cubicIntersections(a, b, 1);
    const fine = cubicIntersections(a, b, 1e-6);
    expect(Math.abs(fine[0][0] - 5)).toBeLessThan(Math.abs(coarse[0][0] - 5) + 1e-9);
    expect(Math.abs(fine[0][0] - 5)).toBeLessThan(1e-5);
  });
});

describe('hullNear', () => {
  it('accepts a point inside the control box and rejects one well outside', () => {
    const c = line([0, 0], [10, 0]);
    expect(hullNear(c, [5, 0], 0)).toBe(true);
    expect(hullNear(c, [5, 3], 1)).toBe(false);
    // And the slack is real: the same point passes with enough of it.
    expect(hullNear(c, [5, 3], 4)).toBe(true);
  });
});

describe('a crossing in the priority order', () => {
  const cross = (): ReturnType<typeof emptyDoc> => {
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath('M0 0 L10 10'));
    doc.shapes.push(shapeFromPath('M0 10 L10 0'));
    return doc;
  };

  const setup = (over: Partial<SnapSetup> = {}): SnapSetup => ({
    doc: cross(),
    step: 0,
    phase: 0,
    toGrid: false,
    toPoints: true,
    toBoundary: true,
    reach: 1,
    toIntersections: true,
    ...over,
  });

  it('answers the vertex tier, because a crossing is a point', () => {
    const r = resolveSnap([5.3, 5.3], setup());
    expect(r.kind).toBe('vertex');
    expect(r.via).toBe('crossing');
    expect(r.pt[0]).toBeCloseTo(5, 3);
    expect(r.pt[1]).toBeCloseTo(5, 3);
  });

  it('beats the outline it lies on, which is the tier below', () => {
    // The pointer is 0.21 from the crossing and 0.15 from each outline, so
    // distance alone would give the boundary.
    const r = resolveSnap([5.15, 5.15], setup());
    expect(r.kind).toBe('vertex');
  });

  it('loses to a real node, which is nearer and is a point someone placed', () => {
    const doc = cross();
    /* Off the diagonal, not on it. The first fixture put the node at (5.1,
       5.1), which is exactly on `M0 0 L10 10` -- so the new segment crossed the
       old one at the same point, and the test was comparing a node against a
       crossing in the same place. */
    doc.shapes.push(shapeFromPath('M5.16 5.1 L40 80'));
    const r = resolveSnap([5.15, 5.11], setup({ doc }));
    expect(r.via).toBe('node');
  });

  it('claims nothing when the switch is off', () => {
    const r = resolveSnap([5.3, 5.3], setup({ toIntersections: false, toBoundary: false }));
    expect(r.kind).toBe('none');
  });

  it('works on its own, without Snap to points also being on', () => {
    /* Two switches where one silently requires the other is a switch that
       appears broken. Crossings used to be computed inside the `toPoints`
       gate, so ticking only this one did nothing at all. */
    const r = resolveSnap([5.3, 5.3], setup({ toPoints: false, toBoundary: false }));
    expect(r.via).toBe('crossing');
  });

  it('does not report two neighbours meeting at their shared node', () => {
    /* Every pair of adjacent segments crosses at the node they share, and that
       node is already a vertex target. Reporting it again would put a second,
       worse-named answer on top of a better one -- and on a closed path it
       would do so at every node. */
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath('M0 0 L10 0 L10 10 Z'));
    const r = resolveSnap([10.1, 0.1], setup({ doc, toPoints: false, toBoundary: false }));
    expect(r.kind).toBe('none');
  });
});
