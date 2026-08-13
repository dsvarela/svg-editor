import { describe, expect, it } from 'vitest';
import { bendFromPoint, bendHandlePos, bendOf, bendToHandles } from '../src/core/bend';
import { segmentBend, setSegmentBend } from '../src/model/ops';
import { parsePath } from '../src/core/parse';
import { serialisePath } from '../src/core/serialise';
import { segmentAsCubic } from '../src/core/types';
import { cubicAt } from '../src/core/bezier';
import { makeNode } from '../src/core/types';
import type { PathNode, Pt } from '../src/core/types';

const node = (pt: Pt, hIn: Pt | null = null, hOut: Pt | null = null): PathNode =>
  makeNode(pt, hIn, hOut);

describe('bend <-> handles', () => {
  it('places controls on the thirds at angle 0, reproducing the line', () => {
    const { c1, c2 } = bendToHandles([0, 0], [30, 0], { angle: 0, looseness: 1 });
    expect(c1).toEqual([10, 0]);
    expect(c2).toEqual([20, 0]);
  });

  it('is symmetric about the chord by construction', () => {
    const a: Pt = [0, 0];
    const b: Pt = [40, 0];
    const { c1, c2 } = bendToHandles(a, b, { angle: 30, looseness: 1 });
    // Mirror c1 about the chord's perpendicular bisector and it should be c2.
    expect(c2[0]).toBeCloseTo(b[0] - (c1[0] - a[0]), 9);
    expect(c2[1]).toBeCloseTo(c1[1], 9);
  });

  it('bows opposite ways for opposite signs', () => {
    const up = bendHandlePos([0, 0], [40, 0], { angle: 40, looseness: 1 });
    const down = bendHandlePos([0, 0], [40, 0], { angle: -40, looseness: 1 });
    expect(Math.sign(up[1])).toBe(-Math.sign(down[1]));
    expect(up[0]).toBeCloseTo(down[0], 9);
    expect(up[0]).toBeCloseTo(20, 9);
  });

  it('works on a chord at any orientation', () => {
    const a: Pt = [10, 10];
    const b: Pt = [10, 50]; // vertical
    const { c1, c2 } = bendToHandles(a, b, { angle: 0, looseness: 1 });
    expect(c1[0]).toBeCloseTo(10, 9);
    expect(c1[1]).toBeCloseTo(23.3333, 3);
    expect(c2[1]).toBeCloseTo(36.6667, 3);
  });

  it('round-trips through bendOf', () => {
    for (const angle of [-70, -35, -1, 0, 12.5, 45, 70]) {
      for (const looseness of [0.5, 1, 1.8]) {
        const a: Pt = [3, 7];
        const b: Pt = [29, -11];
        const { c1, c2 } = bendToHandles(a, b, { angle, looseness });
        const got = bendOf(node(a, null, c1), node(b, c2, null));
        expect(got, `angle ${angle} looseness ${looseness}`).not.toBeNull();
        expect(got!.angle).toBeCloseTo(angle, 6);
        expect(got!.looseness).toBeCloseTo(looseness, 6);
      }
    }
  });

  it('reads a straight segment as angle 0', () => {
    expect(bendOf(node([0, 0]), node([10, 0]))).toEqual({ angle: 0, looseness: 1 });
  });

  it('refuses an asymmetric segment', () => {
    // Control lengths differ, so no single bend describes it.
    const got = bendOf(node([0, 0], null, [5, 8]), node([30, 0], [26, 2], null));
    expect(got).toBeNull();
  });

  it('refuses a half-curved segment', () => {
    expect(bendOf(node([0, 0], null, [5, 5]), node([30, 0]))).toBeNull();
  });
});

describe('the bend control point', () => {
  it('sits exactly on the curve at its midpoint', () => {
    const a: Pt = [0, 0];
    const b: Pt = [40, 10];
    const bend = { angle: 35, looseness: 1.2 };
    const { c1, c2 } = bendToHandles(a, b, bend);
    const mid = cubicAt([a, c1, c2, b], 0.5);
    const pos = bendHandlePos(a, b, bend);
    expect(pos[0]).toBeCloseTo(mid[0], 9);
    expect(pos[1]).toBeCloseTo(mid[1], 9);
  });

  it('recovers the bend from a point dragged off the chord', () => {
    const a: Pt = [0, 0];
    const b: Pt = [40, 0];
    for (const angle of [-60, -20, 0, 15, 55]) {
      const target = bendHandlePos(a, b, { angle, looseness: 1 });
      const got = bendFromPoint(a, b, target, 1);
      expect(got.angle).toBeCloseTo(angle, 6);
      expect(got.looseness).toBeCloseTo(1, 6);
    }
  });

  it('grows looseness rather than pinning at the angle cap', () => {
    const a: Pt = [0, 0];
    const b: Pt = [40, 0];
    const far = bendFromPoint(a, b, [20, 60], 1, 80);
    expect(Math.abs(far.angle)).toBeCloseTo(80, 6);
    expect(far.looseness).toBeGreaterThan(1);
    // The control still lands under the pointer, which is what keeps a drag
    // feeling attached rather than sticking.
    const back = bendHandlePos(a, b, far);
    expect(back[1]).toBeCloseTo(60, 6);
  });

  it('ignores movement along the chord', () => {
    const a: Pt = [0, 0];
    const b: Pt = [40, 0];
    const p1 = bendFromPoint(a, b, [10, 5], 1);
    const p2 = bendFromPoint(a, b, [30, 5], 1);
    expect(p1.angle).toBeCloseTo(p2.angle, 9);
  });
});

describe('applying bend to a segment', () => {
  const square = () => parsePath('M0 0 L30 0 L30 30 L0 30 Z')[0];

  it('bends a straight segment and serialises it as a curve', () => {
    const sp = square();
    setSegmentBend(sp, 0, { angle: 30, looseness: 1 });
    expect(sp.nodes[0].hOut).not.toBeNull();
    expect(serialisePath([sp])).toContain('C');
    expect(segmentBend(sp, 0)!.angle).toBeCloseTo(30, 6);
  });

  it('straightens back to a real line at angle 0', () => {
    const sp = square();
    setSegmentBend(sp, 0, { angle: 30, looseness: 1 });
    setSegmentBend(sp, 0, { angle: 0, looseness: 1 });
    expect(sp.nodes[0].hOut).toBeNull();
    expect(sp.nodes[1].hIn).toBeNull();
    expect(serialisePath([sp])).toBe('M 0 0 H 30 V 30 H 0 Z');
  });

  it('bends the closing segment of a ring', () => {
    const sp = square();
    setSegmentBend(sp, 3, { angle: 25, looseness: 1 });
    expect(segmentBend(sp, 3)!.angle).toBeCloseTo(25, 6);
  });

  it('leaves the rest of the path alone', () => {
    const sp = square();
    const before = sp.nodes.map((n) => [...n.pt]);
    setSegmentBend(sp, 1, { angle: 40, looseness: 1.5 });
    expect(sp.nodes.map((n) => [...n.pt])).toEqual(before);
    expect(segmentBend(sp, 0)).toEqual({ angle: 0, looseness: 1 });
    expect(segmentBend(sp, 2)).toEqual({ angle: 0, looseness: 1 });
  });

  it('produces a curve that actually bows the expected way', () => {
    const sp = parsePath('M0 0 L40 0')[0];
    setSegmentBend(sp, 0, { angle: 45, looseness: 1 });
    const mid = cubicAt(segmentAsCubic(sp, 0), 0.5);
    expect(mid[0]).toBeCloseTo(20, 6);
    expect(mid[1]).toBeGreaterThan(0);

    setSegmentBend(sp, 0, { angle: -45, looseness: 1 });
    expect(cubicAt(segmentAsCubic(sp, 0), 0.5)[1]).toBeLessThan(0);
  });

  it('survives a bend applied to an already-curved segment', () => {
    const sp = parsePath('M0 0 C5 20 35 20 40 0')[0];
    setSegmentBend(sp, 0, { angle: 10, looseness: 0.8 });
    const got = segmentBend(sp, 0)!;
    expect(got.angle).toBeCloseTo(10, 6);
    expect(got.looseness).toBeCloseTo(0.8, 6);
  });
});
