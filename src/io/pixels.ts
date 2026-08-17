/**
 * The document as pixels.
 *
 * Two consumers, one string: the small previews are `<img>` elements pointed at
 * a data URI, and a PNG is that same URI drawn into a canvas and read back out.
 *
 * A data-URI SVG does not taint a canvas, which is the whole reason this needs
 * no server and no dependency. An `<img>` pointed at a *file* would, and
 * `toDataURL` on a tainted canvas throws. Everything here therefore stays a URI
 * the page built itself, and it works from `file://` like the rest of the
 * editor. §53 of `docs/ARCHITECTURE.md` has the argument.
 */

import { exportSvg } from './svg';
import type { ExportOptions } from './svg';
import type { Doc, ViewBox } from '../core/types';

/**
 * The document as a URI a browser can draw.
 *
 * Written with the document's own output settings, so a preview shows what the
 * exported file draws rather than what the editor holds. Dropping decimals to
 * nothing visibly rounds the drawing, and seeing that is the point.
 */
export function svgDataUri(doc: Doc, o: ExportOptions = {}): string {
  /* Percent-encoded rather than pasted in raw: a data URI ends at the first
     unescaped `#`, and every fill and stroke this editor writes is a hex
     colour. Raw, the browser reads the first colour as a fragment identifier
     and everything after it is lost. */
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(exportSvg(doc, o))}`;
}

/**
 * The pixel size a PNG of this document gets, given a width.
 *
 * Height follows the viewBox's proportions, so the PNG cannot be a differently
 * shaped picture from the canvas. At least one pixel each way: a viewBox flat
 * enough to round to zero would give a canvas no browser will draw into.
 */
export function pngSize(vb: ViewBox, width: number): { w: number; h: number } {
  const w = Math.max(1, Math.round(width));
  const ratio = vb.w > 0 ? vb.h / vb.w : 1;
  return { w, h: Math.max(1, Math.round(w * ratio)) };
}

/**
 * Draw the document into a PNG of the given width.
 *
 * The background stays transparent, which is what an icon wants and what the
 * SVG itself says: nothing is painted where no shape is.
 *
 * Rejects rather than resolving with a blank image when the browser declines to
 * decode or to encode. A silently empty PNG is the worst outcome available --
 * the download succeeds and the file is blank.
 */
export async function renderPng(doc: Doc, width: number, o: ExportOptions = {}): Promise<Blob> {
  const { w, h } = pngSize(doc.viewBox, width);

  const img = new Image();
  img.src = svgDataUri(doc, o);
  /* `decode` rather than an `onload` race: it resolves when the image is ready
     to be drawn rather than when it has loaded, and it rejects on a broken
     source instead of never firing. */
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser gave no 2D canvas to draw into.');
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The browser encoded no PNG.'))),
      'image/png',
    );
  });
}
