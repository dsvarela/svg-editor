/**
 * Elliptical arc -> cubic beziers.
 *
 * Implements the endpoint-to-centre conversion from the SVG 1.1 spec appendix
 * (F.6.5), including the out-of-range radii handling of F.6.6, then emits one
 * cubic per <=90 degrees of sweep. Maximum error against a true ellipse is
 * around 2.7e-4 of the radius per 90-degree span -- below a rendering pixel at
 * any sane zoom, and below the precision most path data is authored at.
 *
 * This is the only lossy step in the whole import path, and it is a deliberate
 * trade. Keeping arcs as a distinct segment type would preserve `A` on
 * round-trip, but it would put an ellipse special case into every transform,
 * every hit-test and every node operation for the rest of the program's life.
 */

import type { Cubic, Pt } from './types';

/** Signed angle from `u` to `v`. */
function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (len === 0) return 0;
  let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
  if (ux * vy - uy * vx < 0) a = -a;
  return a;
}

/**
 * Convert one `A` command into cubics.
 *
 * Returns `[]` when the arc degenerates to nothing (identical endpoints), and a
 * single straight cubic when a radius is zero -- both per spec F.6.2.
 */
export function arcToCubics(
  p0: Pt,
  rxIn: number,
  ryIn: number,
  xAxisRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Pt,
): Cubic[] {
  const [x0, y0] = p0;
  const [x1, y1] = p1;

  // F.6.2: an arc with coincident endpoints is dropped entirely.
  if (Math.abs(x0 - x1) < 1e-12 && Math.abs(y0 - y1) < 1e-12) return [];

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);

  // F.6.2: a zero radius means a straight line to the endpoint.
  if (rx < 1e-12 || ry < 1e-12) {
    return [[[x0, y0], [x0, y0], [x1, y1], [x1, y1]]];
  }

  const phi = ((xAxisRotDeg % 360) * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // F.6.5.1: endpoint delta, rotated into the ellipse's own frame.
  const dx2 = (x0 - x1) / 2;
  const dy2 = (y0 - y1) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // F.6.6.2: scale the radii up if they are too small to span the endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  // F.6.5.2: centre in the ellipse frame.
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const sign = largeArc === sweep ? -1 : 1;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * (rx * y1p)) / ry;
  const cyp = (-co * (ry * x1p)) / rx;

  // F.6.5.3: centre back in user space.
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x1) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y1) / 2;

  // F.6.5.5 / F.6.5.6: start angle and sweep.
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;

  const theta1 = angleBetween(1, 0, ux, uy);
  let dTheta = angleBetween(ux, uy, vx, vy);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  // Point and tangent on the ellipse at parameter `t`.
  const at = (t: number): Pt => [
    cx + rx * Math.cos(t) * cosPhi - ry * Math.sin(t) * sinPhi,
    cy + rx * Math.cos(t) * sinPhi + ry * Math.sin(t) * cosPhi,
  ];
  const deriv = (t: number): Pt => [
    -rx * Math.sin(t) * cosPhi - ry * Math.cos(t) * sinPhi,
    -rx * Math.sin(t) * sinPhi + ry * Math.cos(t) * cosPhi,
  ];

  const count = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / count;
  // Magic constant for approximating a circular span by one cubic.
  const k = (4 / 3) * Math.tan(delta / 4);

  const out: Cubic[] = [];
  for (let i = 0; i < count; i++) {
    const ta = theta1 + i * delta;
    const tb = ta + delta;
    const pa = at(ta);
    const pb = at(tb);
    const da = deriv(ta);
    const db = deriv(tb);
    out.push([
      pa,
      [pa[0] + k * da[0], pa[1] + k * da[1]],
      [pb[0] - k * db[0], pb[1] - k * db[1]],
      pb,
    ]);
  }

  // Pin the ends to the exact endpoints so consecutive segments stay welded
  // despite the trig above.
  if (out.length > 0) {
    out[0][0] = [x0, y0];
    out[out.length - 1][3] = [x1, y1];
  }
  return out;
}
