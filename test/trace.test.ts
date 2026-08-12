/**
 * Auto-trace.
 *
 * The raster half was checked against ImageTracerJS itself, byte for byte, on
 * four fixtures while it was being ported -- see ARCHITECTURE §26. What is
 * tested here is what that check cannot cover: that the polylines it produces
 * survive the join to our own fitter, land where the backdrop is, and come back
 * as shapes a person could actually edit.
 */

import { describe, expect, it } from 'vitest';
import { censusPalette, indexRaster, interpolate, layerEdges, scanPaths } from '../src/core/raster';
import type { RasterLike } from '../src/core/raster';
import { DEFAULT_TRACE, traceImage } from '../src/model/trace';
import { docBBox } from '../src/model/doc';
import { segmentCount } from '../src/core/types';

type Px = [number, number, number, number];

const make = (w: number, h: number, f: (x: number, y: number) => Px): RasterLike => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width: w, height: h };
};

const WHITE: Px = [255, 255, 255, 255];
const BLACK: Px = [0, 0, 0, 255];
const RED: Px = [255, 0, 0, 255];
const CLEAR: Px = [0, 0, 0, 0];

/** A black square, inset so it does not touch the edge of the raster. */
const square = (bg: Px = WHITE): RasterLike =>
  make(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30 ? BLACK : bg));

/**
 * A black rectangle at a DIFFERENT offset and extent in each axis.
 *
 * Deliberately asymmetric. The two placement tests below first used `square()`,
 * whose 10..30 extent is the same in both axes, so swapping x and y in `toDoc`
 * produced identical numbers and both tests passed against a transposed
 * mapping. A fixture that is symmetric cannot detect an asymmetric defect.
 */
const oblong = (): RasterLike =>
  make(40, 40, (x, y) => (x >= 8 && x < 32 && y >= 14 && y < 22 ? BLACK : WHITE));

/** A black annulus: one outline and one hole. */
const ring = make(48, 48, (x, y) => {
  const d = Math.hypot(x - 23.5, y - 23.5);
  return d < 18 && d > 9 ? BLACK : WHITE;
});

const UNIT = { x: 0, y: 0, w: 40, h: 40 };

describe('censusPalette', () => {
  it('counts the colours exactly, commonest first', () => {
    // The reason the library's quantiser is not used. Asked for three colours on
    // an image with three, its sampler returned white, red and red.
    const img = make(20, 20, (x, y) => (y < 4 ? RED : x < 2 ? BLACK : WHITE));
    const pal = censusPalette(img, 3);
    expect(pal.map((c) => [c.r, c.g, c.b])).toEqual([
      [255, 255, 255],
      [255, 0, 0],
      [0, 0, 0],
    ]);
  });

  it('treats every fully transparent pixel as one colour', () => {
    // Otherwise a PNG's transparent border splits into several palette entries
    // that differ only in RGB nobody can see, and each one costs a shape.
    const img = make(10, 10, (x) => (x < 5 ? [255, 0, 0, 0] : [0, 0, 255, 0]));
    expect(censusPalette(img, 8)).toHaveLength(1);
    expect(censusPalette(img, 8)[0].a).toBe(0);
  });

  it('keeps the commonest when the cap bites, rather than the first seen', () => {
    const img = make(10, 10, (x, y) => (y === 0 && x === 0 ? RED : BLACK));
    expect(censusPalette(img, 1)).toEqual([{ r: 0, g: 0, b: 0, a: 255 }]);
  });
});

describe('the walk', () => {
  it('gives a rectangle back as a rectangle, not a staircase', () => {
    const pal = censusPalette(square(), 2);
    const layers = layerEdges(indexRaster(square(), pal));
    const black = pal.findIndex((c) => c.r === 0);
    const rings = interpolate(scanPaths(layers[black], 8), true);
    expect(rings).toHaveLength(1);
    // The corner points are kept by the right-angle pass, so the extremes are
    // the square's own corners rather than the midpoints either side of them.
    const xs = rings[0].points.map((p) => p[0]);
    const ys = rings[0].points.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(10);
    expect(Math.max(...xs)).toBe(30);
    expect(Math.min(...ys)).toBe(10);
    expect(Math.max(...ys)).toBe(30);
  });

  it('finds the hole in a ring and names its parent', () => {
    const pal = censusPalette(ring, 2);
    const layers = layerEdges(indexRaster(ring, pal));
    const black = pal.findIndex((c) => c.r === 0);
    const rings = scanPaths(layers[black], 8);
    expect(rings).toHaveLength(2);
    const outline = rings.find((r) => !r.isHole)!;
    const hole = rings.find((r) => r.isHole)!;
    expect(outline.holes).toContain(rings.indexOf(hole));
    // And the hole really is the inner one.
    expect(hole.bbox[2] - hole.bbox[0]).toBeLessThan(outline.bbox[2] - outline.bbox[0]);
  });

  it('gives each hole to the outline that actually contains it', () => {
    /* One outline is not a test of a parent search. With a single outline the
       parent index defaults to 0 and lands on the right answer whatever the
       search decides, so `pointInPoly` could return a constant, the
       innermost-box test could go, and the whole rule could be replaced by
       "attach to path 0" — six separate mutations, all of which passed. Two
       rings, each with its own hole, is the smallest fixture that can tell. */
    const twoRings = make(60, 30, (x, y) => {
      const left = Math.hypot(x - 14, y - 14);
      const right = Math.hypot(x - 44, y - 14);
      const on = (d: number): boolean => d < 12 && d > 5;
      return on(left) || on(right) ? BLACK : WHITE;
    });
    const pal = censusPalette(twoRings, 2);
    const black = pal.findIndex((c) => c.r === 0);
    const rings = scanPaths(layerEdges(indexRaster(twoRings, pal))[black], 8);

    const outlines = rings.filter((r) => !r.isHole);
    const holes = rings.filter((r) => r.isHole);
    expect(outlines).toHaveLength(2);
    expect(holes).toHaveLength(2);

    // Each outline owns exactly one hole, and it is the one inside it.
    for (const outline of outlines) {
      expect(outline.holes).toHaveLength(1);
      const owned = rings[outline.holes[0]];
      expect(owned.isHole).toBe(true);
      expect(owned.bbox[0]).toBeGreaterThan(outline.bbox[0]);
      expect(owned.bbox[2]).toBeLessThan(outline.bbox[2]);
    }
    // And no hole was handed to both, or to neither.
    expect(outlines.flatMap((o) => o.holes).sort()).toEqual(
      holes.map((h) => rings.indexOf(h)).sort(),
    );
  });

  /* Two parts of the parent search resist every fixture I could build, and are
     recorded rather than pretended about. `pointInPoly` returning a constant
     `true`, and dropping the innermost-box tie-break, both pass everything
     here. The reason is the scan order: it is row-major, so a nested outline is
     always found AFTER the one containing it, which makes "innermost" and "last
     qualifying" the same answer; and a hole traced from an `11` cell is by
     construction inside the region whose outer boundary produced it, so the
     bounding box never lies about it. Reaching either would need an outline
     whose box is strictly inside another's while its geometry is not, with the
     wrong one innermost. Both are the reference implementation's and are kept;
     neither is claimed to be covered. */

  it('drops a speck below the noise floor', () => {
    const speck = make(30, 30, (x, y) => (x === 5 && y === 5 ? BLACK : WHITE));
    const pal = censusPalette(speck, 2);
    const black = pal.findIndex((c) => c.r === 0);
    const rings = (omit: number): number =>
      scanPaths(layerEdges(indexRaster(speck, pal))[black], omit).length;
    expect(rings(8)).toBe(0);
    // With the floor lowered it is found, so the emptiness above is the floor
    // doing its job rather than the walk missing a region.
    expect(rings(3)).toBe(1);
    // The boundary itself: a stray pixel is a four-point ring, so 4 keeps it and
    // 5 drops it. `<` versus `<=` is one character and this is the only place it
    // shows.
    expect(rings(4)).toBe(1);
    expect(rings(5)).toBe(0);
  });

  it('lets the noise setting actually reach a single stray pixel', () => {
    /* `Math.max(3, ...)` floored the option so hard that `minPoints` of 0, 1, 2,
       3 and 4 all behaved identically -- and a lone pixel, the case the docstring
       names as the reason the control exists, needed 5 before it could be
       dropped. */
    const speck = make(30, 30, (x, y) => (x === 5 && y === 5 || (x > 10 && x < 25 && y > 10 && y < 25) ? BLACK : WHITE));
    const keepAll = traceImage(speck, UNIT, { ...DEFAULT_TRACE, minPoints: 0 });
    const dropSpeck = traceImage(speck, UNIT, { ...DEFAULT_TRACE, minPoints: 5 });
    expect(keepAll.paths).toBeGreaterThan(dropSpeck.paths);
  });
});

describe('traceImage', () => {
  it('turns a two-colour image into two shapes', () => {
    const r = traceImage(square(), UNIT, DEFAULT_TRACE);
    expect(r.shapes).toHaveLength(2);
    expect(r.colours).toBe(2);
    expect(r.shapes.map((s) => s.style.fill).sort()).toEqual(['#000000', '#ffffff']);
  });

  it('fits the square down to four nodes', () => {
    // The claim that makes this usable rather than node soup: a traced square is
    // a square, not the eighty-odd boundary points the walk produced.
    const r = traceImage(square(), UNIT, DEFAULT_TRACE);
    const black = r.shapes.find((s) => s.style.fill === '#000000')!;
    expect(black.subpaths).toHaveLength(1);
    expect(black.subpaths[0].nodes).toHaveLength(4);
    expect(black.subpaths[0].closed).toBe(true);
    expect(r.nodesBefore).toBeGreaterThan(r.nodesAfter);
  });

  it('lands the traced shape exactly where the pixels were', () => {
    // 40x40 pixels onto a 40x40 placement is one to one, so the black oblong
    // that ran x 8..32 and y 14..22 has to come back at those numbers.
    const r = traceImage(oblong(), UNIT, DEFAULT_TRACE);
    const black = r.shapes.find((s) => s.style.fill === '#000000')!;
    const box = docBBox({ shapes: [black], viewBox: { x: 0, y: 0, w: 40, h: 40 } })!;
    expect(box.x0).toBeCloseTo(8, 6);
    expect(box.y0).toBeCloseTo(14, 6);
    expect(box.x1).toBeCloseTo(32, 6);
    expect(box.y1).toBeCloseTo(22, 6);
  });

  it('maps into a placement that is not one to one', () => {
    const r = traceImage(oblong(), { x: 100, y: 50, w: 80, h: 20 }, DEFAULT_TRACE);
    const black = r.shapes.find((s) => s.style.fill === '#000000')!;
    const box = docBBox({ shapes: [black], viewBox: { x: 0, y: 0, w: 1, h: 1 } })!;
    // x: 100 + 8/40 * 80 = 116 .. 100 + 32/40 * 80 = 164
    expect(box.x0).toBeCloseTo(116, 6);
    expect(box.x1).toBeCloseTo(164, 6);
    // y: 50 + 14/40 * 20 = 57 .. 50 + 22/40 * 20 = 61
    expect(box.y0).toBeCloseTo(57, 6);
    expect(box.y1).toBeCloseTo(61, 6);
  });

  it('keeps a hole as a second subpath under even-odd', () => {
    const r = traceImage(ring, { x: 0, y: 0, w: 48, h: 48 }, DEFAULT_TRACE);
    const black = r.shapes.find((s) => s.style.fill === '#000000')!;
    expect(black.subpaths).toHaveLength(2);
    expect(black.style.fillRule).toBe('evenodd');
  });

  it('drops a transparent background rather than exporting an invisible shape', () => {
    const r = traceImage(square(CLEAR), UNIT, DEFAULT_TRACE);
    expect(r.shapes).toHaveLength(1);
    expect(r.shapes[0].style.fill).toBe('#000000');
  });

  it('keeps an opaque background, because that is a decision for the user', () => {
    expect(traceImage(square(WHITE), UNIT, DEFAULT_TRACE).shapes).toHaveLength(2);
  });

  it('keeps the polygons when the tolerance is zero', () => {
    const r = traceImage(square(), UNIT, { ...DEFAULT_TRACE, tolerance: 0 });
    expect(r.nodesAfter).toBe(r.nodesBefore);
    const black = r.shapes.find((s) => s.style.fill === '#000000')!;
    expect(black.subpaths[0].nodes.length).toBeGreaterThan(4);
  });

  it('cannot emit a zero-length segment, because 0.5 is the floor', () => {
    /* A zero-length segment makes a path permanently un-simplifiable, so the
       tracer first carried a `fuseDegenerate` sweep against one. Removing that
       sweep changed nothing on any fixture, and this is why: the walk steps one
       lattice unit at a time and `interpolate` halves that, so no two
       consecutive points are closer than 0.5.

       A **floor**, not the enumeration this first asserted. `smallest === 0.5
       && largest === 1` held only because the fixture is axis-aligned: two
       midpoints across a turn are √2/2 ≈ 0.7071 apart, which sat invisibly
       between those two bounds, and on a checkerboard every single gap is. The
       fixtures below include a diagonal and a checkerboard for that reason. */
    const fixtures: RasterLike[] = [
      ring,
      make(24, 24, (x, y) => (x > y ? BLACK : WHITE)),
      make(16, 16, (x, y) => ((x + y) % 2 ? BLACK : WHITE)),
    ];
    for (const img of fixtures) {
      const pal = censusPalette(img, 4);
      let smallest = Infinity;
      for (const layer of layerEdges(indexRaster(img, pal))) {
        for (const r of interpolate(scanPaths(layer, 3), true)) {
          for (let i = 0; i < r.points.length; i++) {
            const a = r.points[i];
            const b = r.points[(i + 1) % r.points.length];
            smallest = Math.min(smallest, Math.hypot(b[0] - a[0], b[1] - a[1]));
          }
        }
      }
      expect(smallest).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('carries that guarantee through to the shapes', () => {
    const r = traceImage(ring, { x: 0, y: 0, w: 48, h: 48 }, DEFAULT_TRACE);
    for (const shape of r.shapes) {
      for (const sp of shape.subpaths) {
        for (let i = 0; i < segmentCount(sp); i++) {
          const a = sp.nodes[i].pt;
          const b = sp.nodes[(i + 1) % sp.nodes.length].pt;
          expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThan(1e-6);
        }
      }
    }
  });

  it('reports what it did, and the numbers agree with the shapes', () => {
    const r = traceImage(ring, { x: 0, y: 0, w: 48, h: 48 }, DEFAULT_TRACE);
    const subpaths = r.shapes.reduce((n, s) => n + s.subpaths.length, 0);
    expect(r.paths).toBe(subpaths);
    expect(r.colours).toBe(r.shapes.length);
    expect(r.nodesAfter).toBe(
      r.shapes.reduce((n, s) => n + s.subpaths.reduce((m, sp) => m + sp.nodes.length, 0), 0),
    );
  });

  it('gives every shape a blank id, for the document to assign', () => {
    // The tracer knows nothing about the document it is going into, and an id
    // it invented would collide with one already there.
    for (const s of traceImage(square(), UNIT, DEFAULT_TRACE).shapes) expect(s.id).toBe('');
  });
});
