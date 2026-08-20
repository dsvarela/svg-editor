/**
 * Which snap wins.
 *
 * **The most specific target within reach wins**: a vertex (0-D) over a
 * boundary (1-D) over the grid (2-D). **Distance does not break ties between
 * tiers** -- a vertex seven pixels off beats a gridline one pixel off, because
 * you can see the vertex. Reach is in screen pixels, so it feels the same at
 * every zoom.
 *
 * **Nothing else is a fourth tier.** Pixel fit says where the lattice sits, so
 * it is inside the 2-D tier; rays and keylines are outlines not in the
 * document, so a keyline corner is a vertex and its edge a boundary. Within a
 * tier the nearer wins.
 *
 * Kept out of the controller so the order can be tested: everything here is a
 * pure function of a document, a point and some numbers. §27.
 */

import { nearestOnPath, snap as snapToGrid } from './ops';
import { findShape } from './doc';
import type { NodeRef } from './doc';
import { defaultStyle } from '../core/types';
import type { Cubic, Doc, Pt, Subpath } from '../core/types';
import { nearestGuideCross, nearestGuideLine } from './guides';
import type { Guide } from './guides';
import { nearestRay } from './angles';
import type { AngleSetup } from './angles';
import { cubicIntersections, hullNear } from '../core/intersect';
import { projectToCubic } from '../core/bezier';
import { segmentAsCubic, segmentCount } from '../core/types';

/** Which tier answered. `none` means nothing was in reach and nothing moved. */
export type SnapKind = 'vertex' | 'boundary' | 'grid' | 'none';

/**
 * What claimed the pointer, which is not which tier it belongs to.
 *
 * The readout wants this rather than the tier: naming a thing that is not under
 * the pointer is worse than naming nothing. §33 of `docs/ARCHITECTURE.md`.
 */
export type SnapVia =
  | 'node'
  | 'outline'
  | 'keyline'
  | 'guide'
  | 'cross'
  | 'crossing'
  | 'ray'
  | 'grid'
  | 'none';

export interface SnapResult {
  pt: Pt;
  kind: SnapKind;
  via: SnapVia;
}

export interface SnapSetup {
  doc: Doc;
  /** Grid step in document units. 0 turns the 2-D tier off. */
  step: number;
  /** Lattice phase from pixel fit. See `model/pixelfit.ts`. */
  phase: number;
  toGrid: boolean;
  toPoints: boolean;
  toBoundary: boolean;
  /** How near a 0-D or 1-D target has to be, in document units. */
  reach: number;
  /** A node that must not snap to itself: the one being dragged. */
  exclude?: NodeRef | undefined;
  /** A whole shape to ignore, which is how the pen skips the path it is drawing. */
  excludeShape?: string | undefined;
  /**
   * Outlines that are not in the document but can still be aimed at: keylines.
   *
   * They join the tiers they belong to rather than forming one of their own. A
   * keyline corner is a vertex and a keyline outline is a boundary, so the rule
   * above decides them, and inside a tier the nearer target wins exactly as it
   * does between two real shapes. A guide that beat a node would be the wrong
   * way round: the drawing is the thing being made.
   */
  guides?: Subpath[] | undefined;
  /**
   * Guide lines. A guide is 1-D and answers the boundary tier; two crossing
   * guides make a point and answer the vertex tier. §31.
   */
  guideLines?: Guide[] | undefined;
  /**
   * Rays to hold a direction on, or null when angular snap is off.
   *
   * A ray is 1-D, so it joins the boundary tier beside guides and outlines --
   * no new rule, and an angle still loses to a vertex. See `model/angles.ts`.
   */
  angles?: AngleSetup | null | undefined;
  /**
   * Snap where two outlines cross.
   *
   * A crossing is a point, so it answers the vertex tier beside anchors and
   * guide crossings. Off by default and separately switched, because unlike
   * every other target it costs real work to find: see `nearestCrossing`.
   */
  toIntersections?: boolean | undefined;
}

/**
 * Guides are wrapped in a document to be scanned, and this names that document.
 *
 * `#` is what makes it unforgeable: every shape id comes from `nextId` as
 * `prefix-n`, and an imported `id` attribute becomes the shape's name rather
 * than its id. A `\0` here is equally unforgeable and makes the whole file
 * binary to `rg`, which reads as every name in it being unreferenced.
 */
const GUIDE_ID = '#guides';

export function resolveSnap(p: Pt, s: SnapSetup): SnapResult {
  const guides: Doc | null = s.guides?.length
    ? {
        shapes: [{ id: GUIDE_ID, name: 'guides', subpaths: s.guides, style: defaultStyle() }],
        viewBox: s.doc.viewBox,
      }
    : null;

  /* The 0-D tier, four sources deep. Each is gated by its own switch and each
     runs against the distance the ones before it achieved, so the cheap ones
     shrink the search for the expensive one.

     Crossings are gated on their own switch, never on `toPoints`. Inside the
     `toPoints` gate, `Snap to crossings` silently does nothing unless `Snap to
     points` is also on: two switches where one quietly requires the other. */
  {
    const v = s.toPoints ? nearestVertex(p, s.doc.shapes, s.reach, s) : null;
    const g =
      s.toPoints && guides ? nearestVertex(p, guides.shapes, v ? v.d : s.reach, s) : null;
    const best = g ?? v;
    // A crossing of guides is two lines agreeing on one point, and it only wins
    // if it is nearer than anything the drawing offered.
    const x =
      s.toPoints && s.guideLines?.length
        ? nearestGuideCross(s.guideLines, p, best ? best.d : s.reach)
        : null;
    const near0 = x ?? best;
    /* Last, and the only target that is computed rather than looked up. It runs
       against whatever the cheap ones already achieved, which usually means it
       barely runs at all. */
    const cross = s.toIntersections
      ? nearestCrossing(s.doc, p, near0 ? near0.d : s.reach)
      : null;
    const win = cross ?? near0;
    if (win) {
      const via: SnapVia = cross ? 'crossing' : x ? 'cross' : g ? 'keyline' : 'node';
      return { pt: win.pt, kind: 'vertex', via };
    }
  }

  if (s.toBoundary) {
    const allow = (shape: string, sp: number, seg: number): boolean => {
      if (shape === s.excludeShape) return false;
      const e = s.exclude;
      if (!e || e.shape !== shape || e.sp !== sp) return true;
      /* The dragged node lies on the two segments it joins, so both would
         report a distance of zero and pin it where it already is. Excluding
         them lets a node snap to a distant part of its own path, which is a
         real thing to want. */
      const nodes = findShape(s.doc, shape)?.subpaths[sp]?.nodes.length ?? 0;
      return seg !== e.i && seg !== (e.i - 1 + nodes) % nodes;
    };
    const hit = nearestOnPath(s.doc, p, s.reach, allow);
    const g = guides ? nearestOnPath(guides, p, hit ? hit.d : s.reach) : null;
    const best = g ?? hit;
    const line = s.guideLines?.length
      ? nearestGuideLine(s.guideLines, p, best ? best.d : s.reach)
      : null;
    const near = line ?? best;
    const ray = s.angles ? nearestRay(p, s.angles, near ? near.d : s.reach) : null;
    const win = ray ?? near;
    if (win) {
      const via: SnapVia = ray ? 'ray' : line ? 'guide' : g ? 'keyline' : 'outline';
      return { pt: win.pt, kind: 'boundary', via };
    }
  }

  if (s.toGrid && s.step > 0) {
    return { pt: snapToGrid(p, s.step, s.phase), kind: 'grid', via: 'grid' };
  }

  return { pt: p, kind: 'none', via: 'none' };
}

/** The nearest anchor within `reach`, with its distance so callers can compare. */
function nearestVertex(
  p: Pt,
  shapes: Doc['shapes'],
  reach: number,
  s: SnapSetup,
): { pt: Pt; d: number } | null {
  let best = reach;
  let hit: { pt: Pt; d: number } | null = null;
  for (const shape of shapes) {
    if (shape.id === s.excludeShape) continue;
    shape.subpaths.forEach((sp, spI) => {
      sp.nodes.forEach((n, i) => {
        const e = s.exclude;
        if (e && e.shape === shape.id && e.sp === spI && e.i === i) return;
        const d = Math.hypot(n.pt[0] - p[0], n.pt[1] - p[1]);
        if (d < best) {
          best = d;
          hit = { pt: [n.pt[0], n.pt[1]], d };
        }
      });
    });
  }
  return hit;
}

/**
 * Whether two segments meet at a node they share.
 *
 * Such a pair is skipped by both searches below. Two neighbours meet at their
 * shared node by construction, and that node is already a vertex target:
 * reporting it again as a crossing would put a second, worse-named answer on
 * top of a better one, and would offer to insert a node on top of one that is
 * already there.
 */
const meetAtANode = (u: Cubic, v: Cubic): boolean => {
  const same = (a: Pt, b: Pt): boolean => a[0] === b[0] && a[1] === b[1];
  return same(u[0], v[0]) || same(u[0], v[3]) || same(u[3], v[0]) || same(u[3], v[3]);
};

/**
 * The nearest place two outlines cross, within `reach`.
 *
 * Pruned twice before any real work happens. Only segments whose control hull
 * comes within `reach` of the pointer can hold a crossing near the pointer, so
 * the first pass collects those -- one linear scan, the same order as the
 * boundary tier already costs -- and only pairs drawn from that short list are
 * intersected. On a drawing of two thousand segments the list is normally empty
 * or has two entries in it.
 */
function nearestCrossing(doc: Doc, p: Pt, reach: number): { pt: Pt; d: number } | null {
  const near: Cubic[] = [];
  for (const shape of doc.shapes) {
    for (const sp of shape.subpaths) {
      const n = segmentCount(sp);
      for (let seg = 0; seg < n; seg++) {
        const c = segmentAsCubic(sp, seg);
        if (hullNear(c, p, reach)) near.push(c);
      }
    }
  }

  let best = reach;
  let hit: { pt: Pt; d: number } | null = null;
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      if (meetAtANode(near[i], near[j])) continue;
      for (const q of cubicIntersections(near[i], near[j])) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < best) {
          best = d;
          hit = { pt: q, d };
        }
      }
    }
  }
  return hit;
}

/**
 * Where another outline crosses one named segment, as a parameter on it.
 *
 * `nearestCrossing` above answers where two outlines cross without saying which
 * two, which is all a snapped pointer needs. An inserted node needs both: it is
 * a split of one named segment at one parameter, and of the two outlines
 * through a crossing only the one under the pointer was clicked. `resolveSnap`
 * answers neither, which is why the insert does not go through it. §69.
 *
 * `pt` is the crossing brought back onto the host segment rather than the
 * crossing itself, so it is the point the split will produce. The two agree to
 * about 1e-4, which is `cubicIntersections`'s own tolerance.
 *
 * Null when nothing crosses within `reach`, which is the ordinary case and
 * leaves the caller with its plain projection.
 */
export function crossingOnSegment(
  doc: Doc,
  at: { shape: string; sp: number; seg: number },
  p: Pt,
  reach: number,
): { t: number; pt: Pt } | null {
  const host = findShape(doc, at.shape)?.subpaths[at.sp];
  if (!host) return null;
  const c = segmentAsCubic(host, at.seg);

  let best = reach;
  let hit: Pt | null = null;
  for (const shape of doc.shapes) {
    shape.subpaths.forEach((sp, spI) => {
      const n = segmentCount(sp);
      for (let seg = 0; seg < n; seg++) {
        if (shape.id === at.shape && spI === at.sp && seg === at.seg) continue;
        const other = segmentAsCubic(sp, seg);
        if (!hullNear(other, p, reach) || meetAtANode(c, other)) continue;
        for (const q of cubicIntersections(c, other)) {
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d < best) {
            best = d;
            hit = q;
          }
        }
      }
    });
  }
  if (!hit) return null;
  const pr = projectToCubic(c, hit);
  return { t: pr.t, pt: pr.pt };
}

/** How a snap reads in the status line, or `null` when nothing claimed it. */
export function snapLabel(via: SnapVia): string | null {
  switch (via) {
    case 'node':
      return 'on a node';
    case 'outline':
      return 'on an outline';
    case 'keyline':
      return 'on a keyline';
    case 'guide':
      return 'on a guide';
    case 'cross':
      return 'where guides cross';
    case 'crossing':
      return 'where outlines cross';
    case 'ray':
      return 'on an angle';
    case 'grid':
      return 'on the grid';
    default:
      return null;
  }
}
