/**
 * Which snap wins.
 *
 * Three things can claim the pointer, and until now the answer was "grid, then
 * let points overwrite it" -- which lands in the right place and is not a rule.
 * With pixel fit added there are more interactions than that can carry, so here
 * is the rule, taken from IPE:
 *
 * **The most specific target within reach wins**, where specific means lower
 * dimensional.
 *
 *   0-D  a vertex: one exact point, an anchor already in the drawing
 *   1-D  a boundary: any point along an existing curve
 *   2-D  the grid: a lattice that fills the plane
 *
 * A vertex is a stronger statement of intent than a boundary, and a boundary
 * than a lattice, so each beats the one below it whenever it is close enough to
 * count. Distance does not break ties between tiers: a vertex seven pixels away
 * beats a gridline one pixel away, because the person aiming at it can see the
 * vertex and cannot see the lattice line.
 *
 * **Pixel fit is not a fourth tier.** It is the grid's phase (see
 * `model/pixelfit.ts`), so it lives inside the 2-D tier and is beaten by the
 * same things the grid is beaten by. That is the honest reading: pixel fit says
 * *where the lattice sits*, not *what to aim at*, and welding to a node someone
 * can see still matters more than landing on a lattice they cannot.
 *
 * Kept apart from the controller because the rule is worth testing and the
 * controller is not: everything here is a pure function of a document, a point
 * and some numbers.
 */

import { nearestOnPath, snap as snapToGrid } from './ops';
import { findShape } from './doc';
import type { NodeRef } from './doc';
import type { Doc, Pt } from '../core/types';

/** Which tier answered. `none` means nothing was in reach and nothing moved. */
export type SnapKind = 'vertex' | 'boundary' | 'grid' | 'none';

export interface SnapResult {
  pt: Pt;
  kind: SnapKind;
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
}

export function resolveSnap(p: Pt, s: SnapSetup): SnapResult {
  if (s.toPoints) {
    const v = nearestVertex(p, s);
    if (v) return { pt: v, kind: 'vertex' };
  }

  if (s.toBoundary) {
    const hit = nearestOnPath(s.doc, p, s.reach, (shape, sp, seg) => {
      if (shape === s.excludeShape) return false;
      const e = s.exclude;
      if (!e || e.shape !== shape || e.sp !== sp) return true;
      /* The dragged node lies on the two segments it joins, so both would
         report a distance of zero and pin it where it already is. Excluding
         them lets a node snap to a distant part of its own path, which is a
         real thing to want. */
      const nodes = findShape(s.doc, shape)?.subpaths[sp]?.nodes.length ?? 0;
      return seg !== e.i && seg !== (e.i - 1 + nodes) % nodes;
    });
    if (hit) return { pt: hit.pt, kind: 'boundary' };
  }

  if (s.toGrid && s.step > 0) return { pt: snapToGrid(p, s.step, s.phase), kind: 'grid' };

  return { pt: p, kind: 'none' };
}

function nearestVertex(p: Pt, s: SnapSetup): Pt | null {
  let best = s.reach;
  let hit: Pt | null = null;
  for (const shape of s.doc.shapes) {
    if (shape.id === s.excludeShape) continue;
    shape.subpaths.forEach((sp, spI) => {
      sp.nodes.forEach((n, i) => {
        const e = s.exclude;
        if (e && e.shape === shape.id && e.sp === spI && e.i === i) return;
        const d = Math.hypot(n.pt[0] - p[0], n.pt[1] - p[1]);
        if (d < best) {
          best = d;
          hit = [n.pt[0], n.pt[1]];
        }
      });
    });
  }
  return hit;
}

/** How a snap reads in the status line, or `null` when nothing claimed it. */
export function snapLabel(kind: SnapKind): string | null {
  return kind === 'vertex'
    ? 'on a node'
    : kind === 'boundary'
      ? 'on an outline'
      : kind === 'grid'
        ? 'on the grid'
        : null;
}
