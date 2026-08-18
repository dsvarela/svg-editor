/**
 * Turning a raster into boundary polylines. The half of tracing we did not
 * already own.
 *
 * A tracer is four stages; `core/fit.ts` and `core/serialise.ts` already were
 * the last two. This is the first two: quantise to a palette, then label the
 * regions and walk their boundaries. Both are exact integer work on a pixel
 * grid -- no intersections, no tangent ordering, nothing that can be
 * numerically wrong -- which is why they are written rather than depended on.
 * `docs/SHOPPING-LIST.md` has that decision and the one booleans made.
 *
 * The boundary walk and edge-node scheme are ported from ImageTracerJS by
 * András Jankovics (Unlicense). The quantiser is not: an exact colour census
 * suits flat artwork better than k-means sampling, which lost a colour outright
 * on a three-colour image.
 */

import type { Pt } from './types';

/** One colour, as the raster gives it. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Anything shaped like an `ImageData`, so tests need no canvas. */
export interface RasterLike {
  data: Uint8ClampedArray | number[];
  width: number;
  height: number;
}

/**
 * A raster reduced to palette indices, with a one-pixel border of -1.
 *
 * The border is what lets the edge walk read `[j-1][i-1]` through `[j+1][i+1]`
 * at every real pixel without a bounds test in the inner loop, and it is why
 * every coordinate coming out of `scanPaths` has one subtracted from it.
 */
export interface Indexed {
  array: number[][];
  palette: Rgba[];
}

/** A traced boundary: a closed ring of points, with its holes named. */
export interface RawPath {
  points: Pt[];
  /** `[minX, minY, maxX, maxY]`, used to nest holes inside their parents. */
  bbox: [number, number, number, number];
  /** Indices, into the same array this path came from, of the holes inside it. */
  holes: number[];
  /** True when this ring is a hole rather than an outline. */
  isHole: boolean;
}

/* -------------------------------------------------------------- quantising */

/**
 * The distinct colours in an image, commonest first, capped at `max`.
 *
 * An exact census rather than a cluster fit. Flat artwork -- an icon, a logo, a
 * screenshot of one -- is made of a handful of exact colours, and asking
 * k-means to rediscover them loses some: the original's sampler, given a white
 * disc with a red ring and a blue square at three colours, returned white, red
 * and red, and at eight colours spent five of them on red. Counting is both
 * simpler and exactly right for the case this editor is for.
 *
 * Colours beyond the cap are dropped rather than merged, and every pixel is then
 * assigned to its nearest survivor by `indexRaster`, so a photograph degrades
 * into its commonest colours rather than failing.
 */
export function censusPalette(image: RasterLike, max = 8): Rgba[] {
  const counts = new Map<number, number>();
  const d = image.data;
  for (let i = 0; i < image.width * image.height * 4; i += 4) {
    // Fully transparent pixels are one colour whatever their RGB says, and
    // treating them otherwise splits the background into several palette
    // entries that all paint nothing.
    const a = d[i + 3];
    const key = a === 0 ? 0 : ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | a) >>> 0;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((p, q) => q[1] - p[1])
    .slice(0, Math.max(1, max))
    .map(([key]) => ({
      r: (key >>> 24) & 255,
      g: (key >>> 16) & 255,
      b: (key >>> 8) & 255,
      a: key & 255,
    }));
}

/**
 * Assign every pixel to its nearest palette entry.
 *
 * Nearest by the sum of absolute channel differences, alpha included. Exact for
 * a palette that came from `censusPalette` without hitting its cap, which is the
 * case that matters; a reasonable fallback otherwise.
 */
export function indexRaster(image: RasterLike, palette: Rgba[]): Indexed {
  const { width: w, height: h, data: d } = image;
  const array: number[][] = [];
  for (let j = 0; j < h + 2; j++) array.push(new Array<number>(w + 2).fill(-1));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const p = palette[k];
        // Transparency dominates: a pixel you cannot see is not a near miss for
        // an opaque colour that happens to share its channels.
        const da = Math.abs(p.a - d[i + 3]) * 4;
        const e =
          da + Math.abs(p.r - d[i]) + Math.abs(p.g - d[i + 1]) + Math.abs(p.b - d[i + 2]);
        if (e < bestD) {
          bestD = e;
          best = k;
        }
      }
      array[y + 1][x + 1] = best;
    }
  }
  return { array, palette };
}

/* ------------------------------------------------------- edges and walking */

/**
 * One edge-node grid per palette entry.
 *
 * Each cell holds a four-bit code for which of the 2x2 pixels around that
 * lattice point belong to this layer, which is what the walk below turns into a
 * boundary. Codes 0 and 15 are the interior of "outside" and "inside" and carry
 * no boundary.
 */
export function layerEdges(indexed: Indexed): number[][][] {
  const { array, palette } = indexed;
  const ah = array.length;
  const aw = array[0].length;

  const layers: number[][][] = [];
  for (let k = 0; k < palette.length; k++) {
    const layer: number[][] = [];
    for (let j = 0; j < ah; j++) layer.push(new Array<number>(aw).fill(0));
    layers.push(layer);
  }

  for (let j = 1; j < ah - 1; j++) {
    for (let i = 1; i < aw - 1; i++) {
      const val = array[j][i];
      if (val < 0) continue;
      const same = (dj: number, di: number): number => (array[j + dj][i + di] === val ? 1 : 0);
      const n1 = same(-1, -1);
      const n2 = same(-1, 0);
      const n3 = same(-1, 1);
      const n4 = same(0, -1);
      const n5 = same(0, 1);
      const n6 = same(1, -1);
      const n7 = same(1, 0);
      const n8 = same(1, 1);

      // This lattice point, and the three behind it that this pixel completes.
      layers[val][j + 1][i + 1] = 1 + n5 * 2 + n8 * 4 + n7 * 8;
      if (!n4) layers[val][j + 1][i] = 2 + n7 * 4 + n6 * 8;
      if (!n2) layers[val][j][i + 1] = n3 * 2 + n5 * 4 + 8;
      if (!n1) layers[val][j][i] = n2 * 2 + 4 + n4 * 8;
    }
  }
  return layers;
}

/**
 * The walk table: `LOOKUP[cell][direction]` is
 * `[cellAfterwards, nextDirection, dx, dy]`.
 *
 * Directions are 0 east, 1 north, 2 west, 3 south. Writing the cell back is how
 * a visited boundary is consumed, which is what stops the walk retracing itself;
 * the two saddle cells, 5 and 10, are rewritten to their other reading rather
 * than cleared, so the second crossing of an hourglass takes the other pair of
 * arms. Rows 0 and 15 are unreachable and kept as -1 so a bug lands on an
 * obvious value rather than walking off quietly.
 */
const LOOKUP: number[][][] = [
  [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]],
  [[0, 1, 0, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [0, 2, -1, 0]],
  [[-1, -1, -1, -1], [-1, -1, -1, -1], [0, 1, 0, -1], [0, 0, 1, 0]],
  [[0, 0, 1, 0], [-1, -1, -1, -1], [0, 2, -1, 0], [-1, -1, -1, -1]],

  [[-1, -1, -1, -1], [0, 0, 1, 0], [0, 3, 0, 1], [-1, -1, -1, -1]],
  [[13, 3, 0, 1], [13, 2, -1, 0], [7, 1, 0, -1], [7, 0, 1, 0]],
  [[-1, -1, -1, -1], [0, 1, 0, -1], [-1, -1, -1, -1], [0, 3, 0, 1]],
  [[0, 3, 0, 1], [0, 2, -1, 0], [-1, -1, -1, -1], [-1, -1, -1, -1]],

  [[0, 3, 0, 1], [0, 2, -1, 0], [-1, -1, -1, -1], [-1, -1, -1, -1]],
  [[-1, -1, -1, -1], [0, 1, 0, -1], [-1, -1, -1, -1], [0, 3, 0, 1]],
  [[11, 1, 0, -1], [14, 0, 1, 0], [14, 3, 0, 1], [11, 2, -1, 0]],
  [[-1, -1, -1, -1], [0, 0, 1, 0], [0, 3, 0, 1], [-1, -1, -1, -1]],

  [[0, 0, 1, 0], [-1, -1, -1, -1], [0, 2, -1, 0], [-1, -1, -1, -1]],
  [[-1, -1, -1, -1], [-1, -1, -1, -1], [0, 1, 0, -1], [0, 0, 1, 0]],
  [[0, 1, 0, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [0, 2, -1, 0]],
  [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]],
];

const inside = (parent: RawPath['bbox'], child: RawPath['bbox']): boolean =>
  parent[0] < child[0] && parent[1] < child[1] && parent[2] > child[2] && parent[3] > child[3];

/** Even-odd point-in-polygon, for deciding which outline a hole belongs to. */
function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let is = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (
      poly[i][1] > p[1] !== poly[j][1] > p[1] &&
      p[0] < ((poly[j][0] - poly[i][0]) * (p[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]
    ) {
      is = !is;
    }
  }
  return is;
}

/**
 * Walk every boundary in one layer's edge grid.
 *
 * Rings shorter than `pathomit` points are dropped, which is the only noise
 * control here: a single stray pixel traces to a four-point square that nobody
 * wants as a shape.
 *
 * Holes are nested as they are found. A hole belongs to the innermost outline
 * whose bounding box contains it and whose outline actually contains its first
 * point -- the bounding box alone is not enough, since a C-shape's box contains
 * plenty of things that are not inside the C.
 */
export function scanPaths(layer: number[][], pathomit = 8): RawPath[] {
  const paths: RawPath[] = [];
  const h = layer.length;
  const w = layer[0].length;

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      // 4 and 11 are the two cells a boundary can start on; every other
      // boundary cell is reached from one of them.
      if (layer[j][i] !== 4 && layer[j][i] !== 11) continue;

      let px = i;
      let py = j;
      let dir = 1;
      const isHole = layer[j][i] === 11;
      const path: RawPath = {
        points: [],
        bbox: [px - 1, py - 1, px - 1, py - 1],
        holes: [],
        isHole,
      };

      for (;;) {
        // Coordinates are lattice points on the original raster, so the border
        // the index array carries comes back off here.
        const pt: Pt = [px - 1, py - 1];
        path.points.push(pt);
        if (pt[0] < path.bbox[0]) path.bbox[0] = pt[0];
        if (pt[0] > path.bbox[2]) path.bbox[2] = pt[0];
        if (pt[1] < path.bbox[1]) path.bbox[1] = pt[1];
        if (pt[1] > path.bbox[3]) path.bbox[3] = pt[1];

        const row = LOOKUP[layer[py][px]][dir];
        layer[py][px] = row[0];
        dir = row[1];
        px += row[2];
        py += row[3];

        if (px - 1 === path.points[0][0] && py - 1 === path.points[0][1]) break;
      }

      if (path.points.length < pathomit) continue;

      if (isHole) {
        let parent = 0;
        let parentBox: RawPath['bbox'] = [-1, -1, w + 1, h + 1];
        for (let k = 0; k < paths.length; k++) {
          const cand = paths[k];
          if (
            !cand.isHole &&
            inside(cand.bbox, path.bbox) &&
            inside(parentBox, cand.bbox) &&
            pointInPoly(path.points[0], cand.points)
          ) {
            parent = k;
            parentBox = cand.bbox;
          }
        }
        if (paths[parent]) paths[parent].holes.push(paths.length);
      }
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Replace each staircase of pixel corners with the midpoints between them.
 *
 * The boundary as walked is a lattice path: every step is one unit, axis
 * aligned, so a 45-degree edge comes out as a flight of stairs. Taking midpoints
 * cuts every step in half and lands the polyline on the diagonal, which is both
 * closer to the truth and far kinder to a curve fitter.
 *
 * `rightAngles` keeps the actual corner point wherever two straight runs meet at
 * ninety degrees, because midpoints alone round off exactly the corners that
 * were meant to be sharp. It costs one extra point per corner.
 *
 * **It needs two lattice steps of straight run on each side**, so it works from
 * two pixels up and not below. A feature one pixel wide or tall keeps none of
 * its corners: a single pixel traces to a diamond of half its area. Measured,
 * and worth measuring again before anyone writes that this pass "is what makes
 * a traced rectangle come back as a rectangle" -- that is false for exactly the
 * 1-px-stroke case this editor is aimed at.
 */
export function interpolate(paths: RawPath[], rightAngles = true): RawPath[] {
  return paths.map((path) => {
    const src = path.points;
    const n = src.length;
    const out: Pt[] = [];

    for (let i = 0; i < n; i++) {
      const next = src[(i + 1) % n];
      const here = src[i];
      if (rightAngles && isRightAngle(src, i)) out.push([here[0], here[1]]);
      out.push([(here[0] + next[0]) / 2, (here[1] + next[1]) / 2]);
    }
    return { ...path, points: out };
  });
}

/** Two straight runs of two meeting square on, with `i` at the corner. */
function isRightAngle(pts: Pt[], i: number): boolean {
  const n = pts.length;
  const at = (k: number): Pt => pts[((k % n) + n) % n];
  const c = at(i);
  const a1 = at(i - 2);
  const a2 = at(i - 1);
  const b1 = at(i + 1);
  const b2 = at(i + 2);
  return (
    (c[0] === a1[0] && c[0] === a2[0] && c[1] === b1[1] && c[1] === b2[1]) ||
    (c[1] === a1[1] && c[1] === a2[1] && c[0] === b1[0] && c[0] === b2[0])
  );
}
