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

/** What to draw for the grid: a step in document units, and how often a line is major. */
export interface GridDisplay {
  /** Always a whole multiple of the snap step. */
  step: number;
  /** Every Nth drawn line is major, counted from the origin. */
  majorEvery: number;
  /** `step / snapStep`. 1 means every snap position is drawn. */
  multiple: number;
}

/**
 * The next value at or above `x` on the 1-2-5 ladder (1, 2, 5, 10, 20, 50, …).
 *
 * Only whole multipliers, because the drawn grid must land on snap positions
 * and a fractional multiple of the snap step would not.
 */
function ladderAtLeast(x: number): number {
  if (!(x > 1)) return 1;
  // The epsilon keeps log10(100) = 1.9999… from picking the decade below.
  const decade = Math.pow(10, Math.floor(Math.log10(x) + 1e-12));
  const m = x / decade;
  const pick = m <= 1 + 1e-12 ? 1 : m <= 2 + 1e-12 ? 2 : m <= 5 + 1e-12 ? 5 : 10;
  return pick * decade;
}

/** How many minor lines between major ones, chosen to land on the ladder too. */
const MAJOR_EVERY: Record<number, number> = { 1: 5, 2: 5, 5: 4, 10: 5 };

/**
 * What to tick and what to label on a ruler, along one axis.
 *
 * A ruler is a measurement scale rather than a claim about snapping, so it
 * exists with no snap step. Where there is a grid it borrows that grid's step
 * and labels its major lines, so the edge numbers fall on lines drawn across
 * the canvas.
 *
 * **One axis at a time.** `span` and `lengthPx` are the strip's own, never the
 * camera's: reading `camera.w` gives the vertical ruler the horizontal span,
 * out by the aspect ratio. The 1-2-5 ladder quantises both to the same rung at
 * most zooms, so to see it at all you need the case where it does not. On a
 * 1290 by 772 stage they first disagree at a camera 129 units wide, where the
 * ruler ticks every 2 and the grid draws every 1.
 *
 * `minPx` defaults to the grid's, or ruler ticks land between drawn lines.
 */
export function rulerTicksFor(
  snapStep: number,
  span: number,
  lengthPx: number,
  minPx = 9,
): { step: number; labelEvery: number } | null {
  if (lengthPx <= 0 || !(span > 0)) return null;

  const g = gridDisplayFor(snapStep, { x: 0, y: 0, w: span, h: span }, lengthPx, minPx);
  if (g) return { step: g.step, labelEvery: g.majorEvery };

  // No lattice to agree with, so straight onto the ladder from the camera.
  const step = ladderAtLeast((minPx * span) / lengthPx);
  const mantissa = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-12));
  return { step, labelEvery: MAJOR_EVERY[Math.round(mantissa)] ?? 5 };
}

/**
 * Choose what grid to draw, given the step the editor actually snaps to.
 *
 * **Every drawn line is a snap position**, which is why this takes `snapStep`
 * rather than deriving one from the camera. Zooming out thins the grid to every
 * 2nd, 5th, 10th snap position rather than changing lattice, and zooming in
 * stops at multiple 1: some snap positions stop being drawn, but nothing drawn
 * is ever un-snappable.
 *
 * `null` when there is nothing honest to draw. The 1-2-5 ladder and `minPx`
 * come from svg-path-editor's `refreshGrid` (Apache-2.0); the anchoring to the
 * snap step does not. §9.
 */
export function gridDisplayFor(
  snapStep: number,
  camera: ViewBox,
  widthPx: number,
  minPx = 9,
): GridDisplay | null {
  if (!(snapStep > 0) || widthPx <= 0 || !(camera.w > 0)) return null;

  // Snap steps needed to clear `minPx` on screen.
  const need = (minPx * camera.w) / widthPx / snapStep;
  const multiple = ladderAtLeast(need);
  const mantissa = multiple / Math.pow(10, Math.floor(Math.log10(multiple) + 1e-12));
  return {
    step: snapStep * multiple,
    majorEvery: MAJOR_EVERY[Math.round(mantissa)] ?? 5,
    multiple,
  };
}
