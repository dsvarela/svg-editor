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

  it('drops a speck below the noise floor', () => {
    const speck = make(30, 30, (x, y) => (x === 5 && y === 5 ? BLACK : WHITE));
    const pal = censusPalette(speck, 2);
    const layers = layerEdges(indexRaster(speck, pal));
    const black = pal.findIndex((c) => c.r === 0);
    expect(scanPaths(layers[black], 8)).toHaveLength(0);
    // With the floor lowered it is found, so the emptiness above is the floor
    // doing its job rather than the walk missing a region.
    expect(scanPaths(layerEdges(indexRaster(speck, pal))[black], 3)).toHaveLength(1);
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

  it('lands the traced square exactly where the pixels were', () => {
    // 40x40 pixels onto a 40x40 placement is one to one, so the black square
    // that ran from pixel 10 to pixel 30 has to come back at 10 to 30.
    const r = traceImage(square(), UNIT, DEFAULT_TRACE);
    const black = r.shapes.find((s) => s.style.fill === '#000000')!;
    const box = docBBox({ shapes: [black], viewBox: { x: 0, y: 0, w: 40, h: 40 } })!;
    expect(box.x0).toBeCloseTo(10, 6);
    expect(box.y0).toBeCloseTo(10, 6);
    expect(box.x1).toBeCloseTo(30, 6);
    expect(box.y1).toBeCloseTo(30, 6);
  });

  it('maps into a placement that is not one to one', () => {
    const r = traceImage(square(), { x: 100, y: 50, w: 80, h: 20 }, DEFAULT_TRACE);
    const black = r.shapes.find((s) => s.style.fill === '#000000')!;
    const box = docBBox({ shapes: [black], viewBox: { x: 0, y: 0, w: 1, h: 1 } })!;
    // x: 100 + 10/40 * 80 = 120 .. 100 + 30/40 * 80 = 160
    expect(box.x0).toBeCloseTo(120, 6);
    expect(box.x1).toBeCloseTo(160, 6);
    // y: 50 + 10/40 * 20 = 55 .. 50 + 30/40 * 20 = 65
    expect(box.y0).toBeCloseTo(55, 6);
    expect(box.y1).toBeCloseTo(65, 6);
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

  it('cannot emit a zero-length segment, because of how far apart its points are', () => {
    /* A zero-length segment makes a path permanently un-simplifiable, so the
       tracer first carried a `fuseDegenerate` sweep against one. Removing that
       sweep changed nothing on any fixture, and this is why: the walk steps one
       lattice unit at a time and `interpolate` halves that, so consecutive
       points are 0.5 or 1.0 apart, never 0. The guarantee is pinned here rather
       than defended by code that never fires. */
    const pal = censusPalette(ring, 4);
    let smallest = Infinity;
    let largest = 0;
    for (const layer of layerEdges(indexRaster(ring, pal))) {
      for (const r of interpolate(scanPaths(layer, 8), true)) {
        for (let i = 0; i < r.points.length; i++) {
          const a = r.points[i];
          const b = r.points[(i + 1) % r.points.length];
          const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
          smallest = Math.min(smallest, d);
          largest = Math.max(largest, d);
        }
      }
    }
    expect(smallest).toBe(0.5);
    expect(largest).toBe(1);
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
