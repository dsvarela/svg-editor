import { describe, expect, it } from 'vitest';
import { booleanShapes } from '../src/io/boolean';
import { shapeFromPath } from '../src/model/doc';
import { serialisePath } from '../src/core/serialise';
import { segmentAsCubic, segmentCount } from '../src/core/types';
import { cubicAt } from '../src/core/bezier';
import type { Subpath } from '../src/core/types';

/**
 * Signed area by the shoelace formula on a dense sample.
 *
 * Comparing areas rather than path strings is the point: a boolean is only
 * obliged to produce a region, not a particular spelling of it. Asserting on
 * the `d` string would break every time the library reorders a contour.
 */
function area(subpaths: Subpath[], per = 64): number {
  let total = 0;
  for (const sp of subpaths) {
    const pts = [];
    for (let i = 0; i < segmentCount(sp); i++) {
      const c = segmentAsCubic(sp, i);
      for (let k = 0; k < per; k++) pts.push(cubicAt(c, k / per));
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      total += a[0] * b[1] - b[0] * a[1];
    }
  }
  return total / 2;
}

/** Winding-agnostic: contour direction encodes inside/outside, not size. */
const size = (sp: Subpath[] | null): number => Math.abs(area(sp ?? []));

const sq = (x: number, y: number, w: number, h: number) =>
  shapeFromPath(`M${x} ${y} H${x + w} V${y + h} H${x} Z`);

describe('boolean operations on overlapping squares', () => {
  // Two 20x20 squares overlapping in a 10x10 corner.
  const a = () => sq(0, 0, 20, 20);
  const b = () => sq(10, 10, 20, 20);

  it('unites to the combined area', () => {
    expect(size(booleanShapes([a(), b()], 'unite'))).toBeCloseTo(700, 6);
  });

  it('intersects to the overlap', () => {
    expect(size(booleanShapes([a(), b()], 'intersect'))).toBeCloseTo(100, 6);
  });

  it('subtracts the second from the first', () => {
    expect(size(booleanShapes([a(), b()], 'subtract'))).toBeCloseTo(300, 6);
  });

  it('excludes the overlap from both', () => {
    expect(size(booleanShapes([a(), b()], 'exclude'))).toBeCloseTo(600, 6);
  });

  it('satisfies union = sum - intersection', () => {
    const u = size(booleanShapes([a(), b()], 'unite'));
    const i = size(booleanShapes([a(), b()], 'intersect'));
    expect(u + i).toBeCloseTo(400 + 400, 6);
  });
});

describe('round-tripping through our model', () => {
  it('produces a path we can serialise and re-read', () => {
    const out = booleanShapes([sq(0, 0, 20, 20), sq(10, 10, 20, 20)], 'unite')!;
    const d = serialisePath(out, { decimals: 6 });
    expect(d).toMatch(/^M/);
    expect(d).toContain('Z');
    expect(d).not.toContain('NaN');
  });

  it('keeps straight edges straight rather than degenerate curves', () => {
    const out = booleanShapes([sq(0, 0, 20, 20), sq(10, 10, 20, 20)], 'unite')!;
    // Every edge of two axis-aligned squares is a line; if the adapter dropped
    // handles wrongly we would see curves here and `H`/`V` would vanish.
    expect(serialisePath(out, { decimals: 6 })).not.toContain('C');
  });

  it('closes every contour it returns', () => {
    const out = booleanShapes([sq(0, 0, 20, 20), sq(10, 10, 20, 20)], 'unite')!;
    expect(out.every((sp) => sp.closed)).toBe(true);
  });
});

describe('curved input', () => {
  const circle = (cx: number, cy: number, r: number) =>
    shapeFromPath(
      `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`,
    );

  it('unites two overlapping circles into one region', () => {
    // Our parser flattens the arcs to cubics on the way in, so this also
    // exercises curve-curve intersection rather than just line crossings.
    const out = booleanShapes([circle(0, 0, 10), circle(12, 0, 10)], 'unite');
    expect(out).not.toBeNull();
    const one = Math.PI * 100;
    // Strictly between one circle and two disjoint ones.
    expect(size(out)).toBeGreaterThan(one);
    expect(size(out)).toBeLessThan(2 * one);
  });

  it('intersects two circles into a lens', () => {
    const out = booleanShapes([circle(0, 0, 10), circle(12, 0, 10)], 'intersect');
    // Exact lens area for r = 10, d = 12:
    //   2r^2*acos(d/2r) - (d/2)*sqrt(4r^2 - d^2)
    const exact = 2 * 100 * Math.acos(0.6) - 6 * Math.sqrt(400 - 144);
    expect(size(out)).toBeCloseTo(exact, 1);
  });
});

describe('degenerate input', () => {
  it('returns null for fewer than two shapes', () => {
    expect(booleanShapes([sq(0, 0, 10, 10)], 'unite')).toBeNull();
  });

  it('returns null when a subtraction removes everything', () => {
    expect(booleanShapes([sq(5, 5, 10, 10), sq(0, 0, 20, 20)], 'subtract')).toBeNull();
  });

  it('handles disjoint shapes by returning both contours', () => {
    const out = booleanShapes([sq(0, 0, 10, 10), sq(50, 50, 10, 10)], 'unite')!;
    expect(out.length).toBe(2);
    expect(size(out)).toBeCloseTo(200, 6);
  });

  it('treats an open subpath as implicitly closed, per fill semantics', () => {
    const open = shapeFromPath('M0 0 H20 V20 H0'); // no Z
    const closed = sq(0, 0, 20, 20);
    const withOpen = size(booleanShapes([open, sq(10, 10, 20, 20)], 'intersect'));
    const withClosed = size(booleanShapes([closed, sq(10, 10, 20, 20)], 'intersect'));
    expect(withOpen).toBeCloseTo(withClosed, 6);
  });
});
