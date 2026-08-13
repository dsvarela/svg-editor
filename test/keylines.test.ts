/**
 * The icon keyline grid.
 *
 * Two things are worth testing and one of them is arithmetic. The ratios have
 * to reproduce Material's published grid exactly on a 24-unit canvas, because
 * that is the only claim the feature makes about being standard; and the
 * keylines have to be reachable by the snapper without disturbing the priority
 * order, which is the part that could go wrong silently.
 */

import { describe, expect, it } from 'vitest';
import { keylineGuides, keylineSubpaths, keylinesFor } from '../src/model/keylines';
import { resolveSnap } from '../src/model/snapping';
import type { SnapSetup } from '../src/model/snapping';
import { emptyDoc, shapeFromPath } from '../src/model/doc';
import { segmentAsCubic, segmentCount } from '../src/core/types';
import type { Subpath, ViewBox } from '../src/core/types';

const vb = (w: number, h = w, x = 0, y = 0): ViewBox => ({ x, y, w, h });

/** Bounding box of a subpath, over the curve rather than over the anchors. */
function bounds(sp: Subpath): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let seg = 0; seg < segmentCount(sp); seg++) {
    const c = segmentAsCubic(sp, seg);
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const u = 1 - t;
      const bx =
        u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0];
      const by =
        u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1];
      x0 = Math.min(x0, bx);
      y0 = Math.min(y0, by);
      x1 = Math.max(x1, bx);
      y1 = Math.max(y1, by);
    }
  }
  return { x0, y0, x1, y1 };
}

const size = (sp: Subpath): [number, number] => {
  const b = bounds(sp);
  return [b.x1 - b.x0, b.y1 - b.y0];
};

describe('the published grid, reproduced', () => {
  it('gives Material system-icon numbers on a 24-unit canvas', () => {
    /* The whole claim of the feature. If these drift, a set of icons drawn
       here no longer matches a set drawn anywhere else, which is the one thing
       a shared grid is for. Source: m1.material.io/style/icons.html, the 24dp
       system-icon keylines. */
    const k = keylinesFor(vb(24));
    expect(k).not.toBeNull();
    expect(k!.sizes.live).toBeCloseTo(20, 10);
    expect(k!.sizes.square).toBeCloseTo(18, 10);
    expect(k!.sizes.circle).toBeCloseTo(20, 10);
    expect(k!.sizes.short).toBeCloseTo(16, 10);
    expect(k!.sizes.long).toBeCloseTo(20, 10);
  });

  it('doubles on a 48-unit canvas, since the ratios are exact', () => {
    const k = keylinesFor(vb(48))!;
    expect(k.sizes.square).toBeCloseTo(36, 10);
    expect(k.sizes.circle).toBeCloseTo(40, 10);
    expect(k.sizes.short).toBeCloseTo(32, 10);
  });

  it('draws the shapes at the sizes it reports', () => {
    /* The numbers in the readout and the geometry on screen come from the same
       record, but not by the same route: `sizes` is arithmetic and the shapes
       go through `rectSubpath` and `ellipseSubpath`. Measuring the curve is
       what catches the two disagreeing -- and for the circle it also catches a
       KAPPA approximation being read as an exact radius. */
    const k = keylinesFor(vb(24))!;
    const [sw, sh] = size(k.shapes[0]);
    expect(sw).toBeCloseTo(18, 6);
    expect(sh).toBeCloseTo(18, 6);

    const [cw, ch] = size(k.shapes[1]);
    expect(cw).toBeCloseTo(20, 6);
    expect(ch).toBeCloseTo(20, 6);

    expect(size(k.shapes[2])).toEqual([expect.closeTo(16, 6), expect.closeTo(20, 6)]);
    expect(size(k.shapes[3])).toEqual([expect.closeTo(20, 6), expect.closeTo(16, 6)]);
    expect(size(k.live)).toEqual([expect.closeTo(20, 6), expect.closeTo(20, 6)]);
  });

  it('puts every keyline on one centre, wherever the page is', () => {
    // An off-origin viewBox is the case that a naive `w / 2` gets wrong.
    const k = keylinesFor(vb(24, 24, 100, -40))!;
    expect([k.cx, k.cy]).toEqual([112, -28]);
    for (const sp of keylineSubpaths(k)) {
      const b = bounds(sp);
      expect((b.x0 + b.x1) / 2).toBeCloseTo(112, 6);
      expect((b.y0 + b.y1) / 2).toBeCloseTo(-28, 6);
    }
  });
});

describe('a page that is not square', () => {
  it('inscribes the grid on the shorter side and keeps the circle round', () => {
    /* Stretching the set to the page would put the circle out of round, and a
       circle that is not round is not the thing the grid exists to give you. */
    const k = keylinesFor(vb(88, 64))!;
    expect(k.grid).toBe(64);
    const [cw, ch] = size(k.shapes[1]);
    expect(cw).toBeCloseTo(ch, 9);
    expect(cw).toBeCloseTo(64 * (5 / 6), 6);
  });

  it('still centres on the page rather than on the square it inscribed', () => {
    const k = keylinesFor(vb(88, 64))!;
    expect([k.cx, k.cy]).toEqual([44, 32]);
  });

  it('refuses a canvas with no area rather than returning degenerate shapes', () => {
    // Reachable by typing: the four canvas numbers are editable, and a width
    // passes through zero on the way to a new one.
    expect(keylinesFor(vb(0, 24))).toBeNull();
    expect(keylinesFor(vb(24, 0))).toBeNull();
    expect(keylinesFor(vb(-5, 24))).toBeNull();
    expect(keylinesFor(vb(Number.NaN, 24))).toBeNull();
    expect(keylineGuides(vb(0, 24))).toBeUndefined();
  });
});

describe('keylines as snap targets', () => {
  /* A 240-unit canvas rather than a 24-unit one. The grid is deliberately
     crowded -- the square, the circle and the live area are all within two
     units of each other on a 24 -- so on that scale a point aimed at one
     keyline is in reach of three, and a test asserting which one answered
     would be asserting a coincidence. Scaled up by ten, each keyline has room
     of its own and the target is unambiguous:

       centre        120, 120
       live          20 .. 220
       square        30 .. 210
       circle        20 .. 220, centred
       portrait      40 .. 200 across, 20 .. 220 down
  */
  const setup = (over: Partial<SnapSetup> = {}): SnapSetup => ({
    doc: emptyDoc(),
    step: 1,
    phase: 0,
    toGrid: true,
    toPoints: true,
    toBoundary: true,
    reach: 2,
    guides: keylineGuides(vb(240)),
    ...over,
  });

  /* Left edge of the square keyline, level with the centre. The circle is at
     its widest there and so is ten units away, and the portrait rectangle is
     ten the other way. */
  const onSquareEdge: [number, number] = [30.6, 120.9];
  /** Top-left corner of the portrait rectangle. */
  const atCorner: [number, number] = [40.3, 20.3];

  it('takes a point on a keyline as a boundary', () => {
    const r = resolveSnap(onSquareEdge, setup({ step: 0 }));
    expect(r.kind).toBe('boundary');
    expect(r.pt[0]).toBeCloseTo(30, 6);
    /* And it slid along the edge rather than to the end of it. Loose, because
       the position along the segment is `projectToCubic`'s answer and that is
       a sampled refinement good to about 1e-3, where the distance to the edge
       is exact arithmetic. */
    expect(r.pt[1]).toBeCloseTo(120.9, 2);
  });

  it('takes a keyline corner as a vertex', () => {
    const r = resolveSnap(atCorner, setup({ step: 0 }));
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([expect.closeTo(40, 6), expect.closeTo(20, 6)]);
  });

  it('is beaten by the drawing at the same tier', () => {
    /* The point that matters. A guide is scenery and the drawing is the work,
       so where both are in reach the node wins -- but only because it is
       nearer, which is the same rule that decides two real shapes. A keyline
       that pulled the pointer off a node would make the grid unusable while
       drawing to it. */
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath('M40.1 20.1 L200 200 Z'));
    const r = resolveSnap([40.2, 20.2], setup({ doc, step: 0 }));
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([40.1, 20.1]);
  });

  it('beats the grid even from further away', () => {
    /* The tier rule, not "closest wins". The lattice point at (31, 121) is
       0.41 from the pointer and the keyline edge is 0.6, and the edge still
       takes it. */
    const grid = Math.hypot(31 - onSquareEdge[0], 121 - onSquareEdge[1]);
    expect(grid).toBeLessThan(0.6);
    const r = resolveSnap(onSquareEdge, setup());
    expect(r.kind).toBe('boundary');
    expect(r.pt[0]).toBeCloseTo(30, 6);
  });

  it('claims nothing when the keylines are not being shown', () => {
    // The controller passes `undefined` with the checkbox off, and a target
    // nobody can see must not move the pointer.
    const r = resolveSnap(onSquareEdge, setup({ step: 0, guides: undefined }));
    expect(r.kind).toBe('none');
    expect(r.pt).toEqual(onSquareEdge);
  });

  it('does not let a guide answer a tier that is switched off', () => {
    // The corner is on the rectangle's outline as well as being its corner, so
    // with points off it drops a tier rather than going unanswered.
    expect(resolveSnap(atCorner, setup({ step: 0, toPoints: false })).kind).toBe('boundary');
    expect(resolveSnap(atCorner, setup({ step: 0, toPoints: false, toBoundary: false })).kind).toBe(
      'none',
    );
  });
});

describe('the guide cache', () => {
  it('rebuilds when the canvas changes size', () => {
    /* One cached entry keyed on the viewBox. A stale hit leaves the keylines
       snapping to where the page was before the resize, which is invisible until
       something lands in the wrong place. */
    const a = keylineGuides(vb(24));
    const b = keylineGuides(vb(48));
    expect(a).not.toBe(b);
    expect(bounds(b![0]).x1 - bounds(b![0]).x0).toBeCloseTo(40, 6);
    // And back, which the single entry cannot serve from cache.
    expect(bounds(keylineGuides(vb(24))![0]).x1).toBeCloseTo(22, 6);
  });

  it('returns the same list for the same canvas', () => {
    expect(keylineGuides(vb(36))).toBe(keylineGuides(vb(36)));
  });
});
