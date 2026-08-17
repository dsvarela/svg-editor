/**
 * The document as pixels: the data URI, and the size a PNG gets.
 *
 * The raster itself is not here. Drawing an image into a canvas needs a real
 * browser, so what a PNG actually contains is asserted in the `png` scenario of
 * `tools/drive.mjs`, which downloads one and reads its header back. What is
 * testable without a browser is the string the browser is handed and the
 * arithmetic that decides how big the canvas is, and both have been wrong.
 */

import { describe, expect, it } from 'vitest';
import { pngSize, svgDataUri } from '../src/io/pixels';
import { emptyDoc, shapeFromPath } from '../src/model/doc';
import type { Doc } from '../src/core/types';

function docOf(d = 'M10 10 H40 V40 H10 Z'): Doc {
  const doc = emptyDoc();
  doc.viewBox = { x: 0, y: 0, w: 100, h: 100 };
  doc.shapes.push(shapeFromPath(d));
  return doc;
}

/** What the URI says, once the browser has undone the percent-encoding. */
const decoded = (uri: string): string =>
  decodeURIComponent(uri.slice('data:image/svg+xml;charset=utf-8,'.length));

describe('the data URI', () => {
  it('is an SVG data URI holding the document', () => {
    const uri = svgDataUri(docOf());
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    const svg = decoded(uri);
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain('M 10 10');
  });

  /**
   * A `#` is what makes this a URI rather than a string. Unescaped it ends the
   * data and the browser reads the rest as a fragment, so every fill would be
   * lost -- and the SVG in this editor is full of them.
   */
  it('escapes the hash of every colour', () => {
    const doc = docOf();
    doc.shapes[0].style.fill = '#2563d8';
    const uri = svgDataUri(doc);
    expect(uri).not.toContain('#');
    expect(decoded(uri)).toContain('#2563d8');
  });

  /** The point of writing it with the Output settings rather than in full. */
  it('is written with the settings the export would use', () => {
    const doc = docOf('M10.123456 10 H40 V40 H10 Z');
    expect(decoded(svgDataUri(doc, { decimals: 1 }))).toContain('M 10.1 10');
    expect(decoded(svgDataUri(doc, { decimals: 6 }))).toContain('M 10.123456 10');
  });
});

describe('the PNG size', () => {
  it('takes the width it is given', () => {
    expect(pngSize({ x: 0, y: 0, w: 100, h: 100 }, 512)).toEqual({ w: 512, h: 512 });
  });

  it('takes the height from the canvas proportions', () => {
    expect(pngSize({ x: 0, y: 0, w: 100, h: 50 }, 512)).toEqual({ w: 512, h: 256 });
    expect(pngSize({ x: 0, y: 0, w: 50, h: 100 }, 512)).toEqual({ w: 512, h: 1024 });
  });

  it('ignores where the canvas is, and reads only how big', () => {
    expect(pngSize({ x: -70, y: 400, w: 100, h: 50 }, 200)).toEqual({ w: 200, h: 100 });
  });

  it('rounds to whole pixels', () => {
    expect(pngSize({ x: 0, y: 0, w: 3, h: 1 }, 10)).toEqual({ w: 10, h: 3 });
  });

  /* A canvas of zero pixels either way is one no browser will draw into, and
     `toBlob` on it returns null, so the download would fail rather than produce
     a small image. */
  it('never returns a side of zero', () => {
    expect(pngSize({ x: 0, y: 0, w: 1000, h: 1 }, 16)).toEqual({ w: 16, h: 1 });
    expect(pngSize({ x: 0, y: 0, w: 100, h: 100 }, 0.2)).toEqual({ w: 1, h: 1 });
  });

  it('survives a canvas with no width, rather than dividing by it', () => {
    expect(pngSize({ x: 0, y: 0, w: 0, h: 100 }, 64)).toEqual({ w: 64, h: 64 });
  });
});
