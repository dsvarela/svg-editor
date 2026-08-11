/**
 * Boolean path operations, via PathBool.js.
 *
 * This is the one piece of geometry not written here, deliberately. A correct
 * boolean needs a robust arrangement: every curve-curve intersection found, a
 * planar graph built from them, winding numbers resolved per face, and all of
 * it surviving tangency and self-intersection. That is a project, and getting
 * it subtly wrong produces output that looks right until it does not.
 *
 * PathBool.js (MIT, github.com/r-flash/PathBool.js) already does it, and its
 * interface happens to be almost exactly our model: a path is a flat array of
 * segments, and a cubic segment is `["C", p0, c1, c2, p3]`. So the adapter
 * below is a translation, not an integration -- no strings in between, no
 * parser round trip, and nothing about our model bends to accommodate it.
 *
 * What we DON'T take from it: its path-data parser and serialiser. We have
 * those, they are tested, and going through segments directly skips a lossy
 * text hop in both directions.
 */

import { FillRule, PathBoolean, PathBooleanOperation } from 'path-bool';
import type { Path as PbPath } from 'path-bool';

/** `PathSegment` is not re-exported from the entry point, so name it here. */
type PbSegment = PbPath[number];
import { quadToCubic } from '../core/bezier';
import {
  endNodeIndex,
  makeNode,
  segmentAsCubic,
  segmentCount,
  segmentIsLine,
} from '../core/types';
import type { Pt, Shape, Subpath } from '../core/types';

export type BooleanOp = 'unite' | 'subtract' | 'intersect' | 'exclude';

const OPS: Record<BooleanOp, PathBooleanOperation> = {
  unite: PathBooleanOperation.Union,
  subtract: PathBooleanOperation.Difference,
  intersect: PathBooleanOperation.Intersection,
  exclude: PathBooleanOperation.Exclusion,
};

/** Endpoints closer than this are the same point when rebuilding contours. */
const WELD_EPS = 1e-9;

/**
 * Our subpaths as one PathBool path.
 *
 * An open subpath is closed with a straight run back to its start. That is not
 * an assumption, it is what SVG fill already does: a boolean operates on the
 * region a path encloses, and an unclosed path encloses the same region as its
 * implicitly-closed twin.
 */
function shapeToPath(shape: Shape): PbPath {
  const out: PbPath = [];

  for (const sp of shape.subpaths) {
    if (sp.nodes.length < 2) continue;

    for (let i = 0; i < segmentCount(sp); i++) {
      const a = sp.nodes[i];
      const b = sp.nodes[endNodeIndex(sp, i)];
      if (segmentIsLine(sp, i)) {
        out.push(['L', [...a.pt], [...b.pt]]);
      } else {
        const c = segmentAsCubic(sp, i);
        out.push(['C', c[0], c[1], c[2], c[3]]);
      }
    }

    if (!sp.closed) {
      const first = sp.nodes[0].pt;
      const last = sp.nodes[sp.nodes.length - 1].pt;
      if (Math.hypot(last[0] - first[0], last[1] - first[1]) > WELD_EPS) {
        out.push(['L', [...last], [...first]]);
      }
    }
  }

  return out;
}

function segStart(s: PbSegment): Pt {
  return s[1] as Pt;
}

function segEnd(s: PbSegment): Pt {
  // Every variant ends with its endpoint except the arc, which ends with one
  // too -- the last tuple slot is the endpoint in all four cases.
  return s[s.length - 1] as Pt;
}

/**
 * A returned path back into our subpaths.
 *
 * The result is a flat segment list that may hold several contours -- an
 * annulus comes back as two. They are separated by walking: wherever one
 * segment's end is not the next one's start, a new contour begins.
 */
function pathToSubpaths(path: PbPath): Subpath[] {
  const contours: PbSegment[][] = [];
  let run: PbSegment[] = [];

  for (const seg of path) {
    if (run.length) {
      const prev = segEnd(run[run.length - 1]);
      const here = segStart(seg);
      if (Math.hypot(here[0] - prev[0], here[1] - prev[1]) > WELD_EPS) {
        contours.push(run);
        run = [];
      }
    }
    run.push(seg);
  }
  if (run.length) contours.push(run);

  return contours.map((segs) => {
    // One node per segment START. A closed contour needs no extra node at the
    // end, because the last segment arrives back at the first one.
    const first = segStart(segs[0]);
    const last = segEnd(segs[segs.length - 1]);
    const closed = Math.hypot(last[0] - first[0], last[1] - first[1]) <= WELD_EPS;

    const nodes = segs.map((seg) => makeNode([...segStart(seg)] as Pt));
    if (!closed) nodes.push(makeNode([...last] as Pt));

    segs.forEach((seg, i) => {
      const c = asCubic(seg);
      if (!c) return; // a line leaves both governing handles null, as it must
      nodes[i].hOut = c[1];
      nodes[closed ? (i + 1) % nodes.length : i + 1].hIn = c[2];
    });

    return { nodes, closed };
  });
}

/** A segment as a cubic, or `null` when it is a straight line. */
function asCubic(seg: PbSegment): [Pt, Pt, Pt, Pt] | null {
  switch (seg[0]) {
    case 'L':
      return null;
    case 'C':
      return [seg[1] as Pt, seg[2] as Pt, seg[3] as Pt, seg[4] as Pt];
    case 'Q': {
      const [c1, c2] = quadToCubic(seg[1] as Pt, seg[2] as Pt, seg[3] as Pt);
      return [seg[1] as Pt, c1, c2, seg[3] as Pt];
    }
    default:
      // We only ever feed L and C, so an arc coming back would mean the library
      // invented one. Treat it as a chord rather than silently dropping it.
      return null;
  }
}

/**
 * Combine shapes. Returns the resulting subpaths, or `null` if the operation
 * produced nothing (a subtraction that removed everything, say).
 *
 * `subtract` is first-minus-the-rest, matching how every other editor reads a
 * multi-selection.
 */
export function booleanShapes(shapes: Shape[], op: BooleanOp): Subpath[] | null {
  if (shapes.length < 2) return null;

  const inputs = shapes.map((s) => ({
    path: shapeToPath(s),
    fillRule: s.style.fillRule === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero,
  }));
  if (inputs.some((i) => i.path.length === 0)) return null;

  const result = new PathBoolean(inputs).get(OPS[op]);

  const subpaths = result.flatMap(pathToSubpaths).filter((sp) => sp.nodes.length >= 2);
  return subpaths.length ? subpaths : null;
}
