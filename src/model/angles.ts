/**
 * Angular snap: rays from a point, at multiples of an angle.
 *
 * The grid gives positions and this gives directions, which a lattice cannot
 * express: a 45-degree chamfer, an isometric box, a star with twelve arms.
 *
 * **A ray is 1-D, so it answers the boundary tier** rather than becoming a mode
 * that overrides everything. That is `model/snapping.ts`'s rule applied, and it
 * is why an angle set once still loses to a vertex you can see.
 *
 * Two things here that look like details and are not. The nearest ray is found
 * by rounding the point's own angle to the nearest multiple, which is also what
 * keeps the projection in front of the origin instead of behind it. And
 * `rayAngles` walks until it has gone round rather than computing `360 / step`,
 * because a step that does not divide 360 is legal: 7 degrees gives 52 rays and
 * a final gap of 4.
 *
 * `docs/ARCHITECTURE.md` §33 has where this came from and why the origin may be
 * implicit.
 */

import type { Pt } from '../core/types';

export interface AngleSetup {
  /** Where the rays radiate from, in document coordinates. */
  origin: Pt;
  /** Degrees between rays. */
  step: number;
  /** Degrees the first ray sits at, measured the way the readout measures. */
  base: number;
}

const RAD = Math.PI / 180;

/** Degrees, normalised to [0, 360). */
const wrap = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * Every ray direction, in degrees, once each.
 *
 * A step that does not divide 360 is legal and useful -- 7 degrees gives 52
 * rays and a final gap of 4 -- so this walks until it has gone round rather
 * than assuming `360 / step` is whole. Capped, because the field takes any
 * number and a step of 0.001 would ask for 360 000 lines.
 */
export function rayAngles(step: number, base: number, cap = 720): number[] {
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const out: number[] = [];
  for (let k = 0; k * step < 360 && out.length < cap; k++) out.push(wrap(base + k * step));
  return out;
}

/**
 * The nearest ray, and where the point lands on it.
 *
 * Distance to the *ray* decides, not distance to the origin: the whole point is
 * to hold a direction while moving away along it. The nearest ray is found by
 * rounding the point's own angle to the nearest multiple, which also guarantees
 * the projection lands in front of the origin rather than behind it -- the
 * chosen direction is within half a step of where the point already is.
 */
export function nearestRay(p: Pt, s: AngleSetup, reach: number): { pt: Pt; d: number } | null {
  if (!(s.step > 0) || !Number.isFinite(s.step) || !(reach > 0)) return null;
  const vx = p[0] - s.origin[0];
  const vy = p[1] - s.origin[1];
  // On the origin there is no direction to round, and every ray is equally
  // near. Snapping to the origin itself is the honest answer.
  if (vx === 0 && vy === 0) return { pt: [s.origin[0], s.origin[1]], d: 0 };

  const ang = Math.atan2(vy, vx) / RAD;
  const k = Math.round((ang - s.base) / s.step);
  const dir = (s.base + k * s.step) * RAD;
  const dx = Math.cos(dir);
  const dy = Math.sin(dir);

  const t = vx * dx + vy * dy;
  /* Behind the origin only when the point is more than a quarter turn from
     every ray, which needs a step above 180. Clamped rather than refused: the
     nearest point of a ray you are behind is its start. */
  const along = Math.max(0, t);
  const pt: Pt = [s.origin[0] + dx * along, s.origin[1] + dy * along];
  const d = Math.hypot(p[0] - pt[0], p[1] - pt[1]);
  return d < reach ? { pt, d } : null;
}
