/**
 * Camera maths: document space <-> screen space.
 *
 * Zoom is a viewBox change, never a transform on the content. That keeps
 * document coordinates absolute -- a node at (12, 40) is at (12, 40) no matter
 * what the user is looking at -- so nothing downstream needs to unwind a view
 * transform before hit-testing or editing.
 */

import type { Box } from '../core/bezier';
import type { Pt, ViewBox } from '../core/types';

/**
 * Convert a pointer event to document coordinates.
 *
 * `getScreenCTM().inverse()` is the only reliable way to do this: it accounts
 * for the viewBox, `preserveAspectRatio` letterboxing, CSS transforms on any
 * ancestor and page scroll, all of which hand-rolled `getBoundingClientRect`
 * arithmetic gets wrong in at least one case.
 */
export function screenToDoc(svgEl: SVGSVGElement, clientX: number, clientY: number): Pt {
  const m = svgEl.getScreenCTM();
  if (!m) return [0, 0];
  const inv = m.inverse();
  const p = new DOMPoint(clientX, clientY).matrixTransform(inv);
  return [p.x, p.y];
}

/** Document units per screen pixel. */
export function docPerPixel(svgEl: SVGSVGElement, camera: ViewBox): number {
  const rect = svgEl.getBoundingClientRect();
  return rect.width > 0 ? camera.w / rect.width : 1;
}

/** Zoom about a fixed document point, so that point stays under the cursor. */
export function zoomAt(camera: ViewBox, factor: number, at: Pt): ViewBox {
  const w = camera.w * factor;
  const h = camera.h * factor;
  return {
    x: at[0] - (at[0] - camera.x) * factor,
    y: at[1] - (at[1] - camera.y) * factor,
    w,
    h,
  };
}

/** Match the camera's aspect ratio to the element, keeping width authoritative. */
export function fitAspect(camera: ViewBox, svgEl: SVGSVGElement): ViewBox {
  const rect = svgEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return camera;
  const h = (camera.w * rect.height) / rect.width;
  // Grow or shrink about the centre so the view does not jump on resize.
  return { ...camera, y: camera.y + (camera.h - h) / 2, h };
}

export function fitBox(box: Box, svgEl: SVGSVGElement, pad = 0.12): ViewBox {
  const bw = Math.max(box.x1 - box.x0, 1e-6);
  const bh = Math.max(box.y1 - box.y0, 1e-6);
  const rect = svgEl.getBoundingClientRect();
  const aspect = rect.width > 0 && rect.height > 0 ? rect.height / rect.width : 1;

  // Widen to whichever dimension is the binding constraint.
  let w = bw;
  let h = bh;
  if (h / w > aspect) w = h / aspect;
  else h = w * aspect;

  const mx = w * pad;
  const my = h * pad;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return { x: cx - w / 2 - mx, y: cy - h / 2 - my, w: w + 2 * mx, h: h + 2 * my };
}

export const viewBoxAttr = (v: ViewBox): string => `${v.x} ${v.y} ${v.w} ${v.h}`;

/**
 * Choose a grid step that keeps lines at least `minPx` apart on screen.
 *
 * Decade steps (…0.1, 1, 10…) rather than a fixed step, so the grid stays
 * meaningful at every zoom level. Adapted from svg-path-editor's `refreshGrid`
 * (Apache-2.0).
 */
export function gridStepFor(camera: ViewBox, widthPx: number, minPx = 9): number {
  if (widthPx <= 0) return 1;
  const raw = (minPx * camera.w) / widthPx;
  const e = Math.ceil(Math.log10(Math.max(raw, 1e-10)));
  return Math.pow(10, Math.max(e, -4));
}
