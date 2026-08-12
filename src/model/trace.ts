/**
 * Auto-trace: a raster becomes shapes.
 *
 * The join between `core/raster.ts`, which walks a raster's boundaries into
 * polylines, and `model/simplify.ts`, which fits curves through polylines. Both
 * halves already existed as far as this file is concerned, which is the whole
 * point of the decision recorded in SHOPPING-LIST: the expensive half of a
 * tracer is curve fitting, we had it, and buying a library that ships its own
 * would have cost 278 kB gzipped to replace something better.
 *
 * Coordinates come out of the walk in image pixels and are mapped into document
 * space **before** fitting, so the tolerance a person types is in the units they
 * are drawing in rather than in pixels of a reference image whose scale they
 * never chose.
 */

import { censusPalette, indexRaster, interpolate, layerEdges, scanPaths } from '../core/raster';
import type { RasterLike, Rgba } from '../core/raster';
import { makeNode } from '../core/types';
import type { Pt, Shape, Subpath } from '../core/types';
import { simplifySubpath } from './simplify';

/** Where the raster sits in the document, which is the backdrop's placement. */
export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TraceOptions {
  /** Palette cap. Flat artwork wants few; a photograph is not what this is for. */
  colours: number;
  /** How far a fitted curve may move, in document units. Zero keeps the polygons. */
  tolerance: number;
  /** Rings with fewer points than this are dropped as noise. */
  minPoints: number;
}

export interface TraceResult {
  shapes: Shape[];
  /** Rings traced, holes included. */
  paths: number;
  nodesBefore: number;
  nodesAfter: number;
  /** Palette entries that produced at least one shape. */
  colours: number;
}

export const DEFAULT_TRACE: TraceOptions = { colours: 6, tolerance: 1, minPoints: 8 };

const hex = (c: Rgba): string =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Trace `image` into shapes, one per palette colour that survives.
 *
 * A fully transparent palette entry is dropped: it covers real area and paints
 * nothing, so keeping it would put an invisible shape over the drawing and into
 * the exported file. Everything else is kept, including a white background,
 * because deciding on the user's behalf that a background is not part of their
 * image is the kind of helpfulness that loses work.
 *
 * Each shape carries its outlines and their holes as subpaths under
 * `fill-rule: evenodd`, which is what makes a hole a hole without this file
 * having to reason about winding directions the walk did not promise.
 */
export function traceImage(
  image: RasterLike,
  place: Placement,
  opts: TraceOptions = DEFAULT_TRACE,
): TraceResult {
  const palette = censusPalette(image, Math.max(1, Math.round(opts.colours)));
  const indexed = indexRaster(image, palette);
  const layers = layerEdges(indexed);

  // Pixel lattice to document space. The walk's coordinates are lattice points
  // on the raster, so 0 is the left edge of the first pixel and `width` is the
  // right edge of the last -- which is exactly the mapping `w / width` gives.
  const sx = place.w / image.width;
  const sy = place.h / image.height;
  const toDoc = (p: Pt): Pt => [place.x + p[0] * sx, place.y + p[1] * sy];

  const shapes: Shape[] = [];
  let paths = 0;
  let nodesBefore = 0;
  let nodesAfter = 0;

  layers.forEach((layer, k) => {
    const colour = palette[k];
    if (!colour || colour.a === 0) return;

    const rings = interpolate(scanPaths(layer, Math.max(3, Math.round(opts.minPoints))), true);
    if (!rings.length) return;

    const subpaths: Subpath[] = [];
    for (const ring of rings) {
      const sp: Subpath = {
        nodes: ring.points.map((p) => makeNode(toDoc(p))),
        closed: true,
      };
      /* No degenerate sweep here, deliberately. A zero-length segment is what
         makes a path permanently un-simplifiable, so it was the first thing
         guarded against -- and then measured: the walk steps one lattice unit
         at a time and `interpolate` halves that, so consecutive points are 0.5
         or 1.0 apart and never 0. Removing the sweep changed nothing on any
         fixture, which is the definition of code that should not be here.
         `test/trace.test.ts` pins the spacing instead, so if the walk ever
         stops guaranteeing it, something says so. */
      if (sp.nodes.length < 3) continue;

      paths++;
      nodesBefore += sp.nodes.length;
      if (opts.tolerance > 0) simplifySubpath(sp, opts.tolerance);
      nodesAfter += sp.nodes.length;
      subpaths.push(sp);
    }
    if (!subpaths.length) return;

    shapes.push({
      id: '',
      name: hex(colour),
      subpaths,
      style: {
        fill: hex(colour),
        stroke: 'none',
        strokeWidth: 1,
        // The walk gives outlines and holes without promising a winding, so
        // even-odd is the rule that makes a hole a hole regardless.
        fillRule: 'evenodd',
      },
    });
  });

  return { shapes, paths, nodesBefore, nodesAfter, colours: shapes.length };
}

/**
 * Read an image element into a raster.
 *
 * Split out so `traceImage` stays testable without a DOM: everything above
 * takes a plain `{data, width, height}` and this is the only part that needs a
 * canvas. Traced at natural size, whatever the backdrop has been scaled to on
 * screen, because the pixels are the information and the placement is not.
 */
export function rasterFrom(img: HTMLImageElement | ImageBitmap, w: number, h: number): RasterLike {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
