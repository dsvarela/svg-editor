import { describe, expect, it } from 'vitest';
import { booleanShapes, booleanSubpaths } from '../src/io/boolean';
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

/**
 * The same operations one level down, between the paths of one shape.
 *
 * `booleanShapes` concatenates a shape's subpaths into one region, which is
 * what makes a ring a ring. `booleanSubpaths` hands each one over separately.
 * Those are opposite readings of the same geometry, so the tests that matter
 * are the ones where the two disagree, and the first `describe` below is
 * exactly that pair.
 */
describe('booleans between the paths of one shape', () => {
  /** One shape holding two 20x20 squares overlapping in a 10x10 corner. */
  const pair = () => {
    const sh = sq(0, 0, 20, 20);
    sh.subpaths.push(...sq(10, 10, 20, 20).subpaths);
    return sh;
  };

  it('unites two paths of one shape to the combined area', () => {
    expect(size(booleanSubpaths(pair(), [0, 1], 'unite'))).toBeCloseTo(700, 6);
  });

  it('intersects them to the overlap', () => {
    expect(size(booleanSubpaths(pair(), [0, 1], 'intersect'))).toBeCloseTo(100, 6);
  });

  it('subtracts the second path from the first', () => {
    expect(size(booleanSubpaths(pair(), [0, 1], 'subtract'))).toBeCloseTo(300, 6);
  });

  it('excludes the overlap from both', () => {
    expect(size(booleanSubpaths(pair(), [0, 1], 'exclude'))).toBeCloseTo(600, 6);
  });

  it('needs two paths', () => {
    expect(booleanSubpaths(pair(), [0], 'unite')).toBeNull();
    expect(booleanSubpaths(pair(), [], 'unite')).toBeNull();
  });

  it('ignores an index that names no path', () => {
    expect(booleanSubpaths(pair(), [0, 9], 'unite')).toBeNull();
  });

  it('leaves the shape it was given alone', () => {
    const sh = pair();
    const before = sh.subpaths.map((sp) => sp.nodes.map((n) => [...n.pt]));
    booleanSubpaths(sh, [0, 1], 'unite');
    expect(sh.subpaths.map((sp) => sp.nodes.map((n) => [...n.pt]))).toEqual(before);
  });

  /* Only some of them, which is the case that separates this from splitting the
     shape apart first: a third path that was not selected has to survive
     untouched, and the operation has to ignore it as an operand. */
  it('combines only the paths it was given', () => {
    const sh = pair();
    sh.subpaths.push(...sq(60, 60, 10, 10).subpaths);
    expect(size(booleanSubpaths(sh, [0, 1], 'unite'))).toBeCloseTo(700, 6);
    expect(size(booleanSubpaths(sh, [1, 2], 'unite'))).toBeCloseTo(400 + 100, 6);
  });

  /* The reading that makes the two entry points different rather than one with
     a flag. A ring is a disc with a hole, spelled as two subpaths of one shape
     under even-odd; as one region it has an area of 300, and as two separate
     regions united it is the disc, 400. */
  it('reads two paths of one shape as two regions, where the shape is one', () => {
    const ring = sq(0, 0, 20, 20);
    ring.subpaths.push(...sq(5, 5, 10, 10).subpaths);
    ring.style.fillRule = 'evenodd';

    const asOneRegion = booleanShapes([ring, sq(60, 60, 1, 1)], 'unite');
    expect(size(asOneRegion)).toBeCloseTo(400 - 100 + 1, 6);

    const asTwoRegions = booleanSubpaths(ring, [0, 1], 'unite');
    expect(size(asTwoRegions)).toBeCloseTo(400, 6);
  });

  it("carries the shape's fill rule onto every operand", () => {
    const sh = pair();
    sh.style.fillRule = 'evenodd';
    // A square inside another, exclusive-or'd: even-odd or not, two disjoint
    // regions of 400 with a 100 overlap exclude to 600 either way, so this is
    // asserting the call goes through rather than the rule changing the answer.
    expect(size(booleanSubpaths(sh, [0, 1], 'exclude'))).toBeCloseTo(600, 6);
  });
});
