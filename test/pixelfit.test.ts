/**
 * Pixel fit.
 *
 * The claim is not "anchors land on nice numbers", which is what the plain grid
 * already does and which is exactly wrong for an odd-width stroke. The claim is
 * that the **painted edges** land on whole pixels, so most of these compute
 * `x ± w/2` and check that, rather than checking where the anchor went.
 */

import { describe, expect, it } from 'vitest';
import { phaseInForce, phaseLabel, phaseOf } from '../src/model/pixelfit';
import { snap } from '../src/model/ops';
import { emptyDoc, emptySelection, nodeKey, shapeFromPath } from '../src/model/doc';
import { defaultStyle } from '../src/core/types';
import type { Doc, Style } from '../src/core/types';

const style = (over: Partial<Style> = {}): Style => ({ ...defaultStyle(), stroke: '#000', ...over });

/** Where a stroke of width `w` centred at `x` actually paints. */
const edges = (x: number, w: number): [number, number] => [x - w / 2, x + w / 2];
const whole = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-9;

describe('phaseOf', () => {
  it('puts an odd-width stroke on half pixels', () => {
    expect(phaseOf(style({ strokeWidth: 1 }))).toBe(0.5);
    expect(phaseOf(style({ strokeWidth: 3 }))).toBe(0.5);
  });

  it('puts an even-width stroke on whole pixels', () => {
    expect(phaseOf(style({ strokeWidth: 2 }))).toBe(0);
    expect(phaseOf(style({ strokeWidth: 4 }))).toBe(0);
  });

  it('handles a fractional width rather than rounding it away', () => {
    expect(phaseOf(style({ strokeWidth: 1.5 }))).toBeCloseTo(0.75, 12);
  });

  it('is zero for a shape with no stroke, whose edges are the path', () => {
    expect(phaseOf(style({ stroke: 'none', strokeWidth: 1 }))).toBe(0);
    expect(phaseOf(style({ strokeWidth: 0 }))).toBe(0);
  });

  it('never returns a negative zero, which would print as "-0"', () => {
    expect(Object.is(phaseOf(style({ strokeWidth: 2 })), 0)).toBe(true);
  });
});

describe('the claim itself: painted edges land on whole pixels', () => {
  for (const w of [1, 2, 3, 4, 8]) {
    it(`holds for a stroke of whole width ${w}`, () => {
      const phase = phaseOf(style({ strokeWidth: w }));
      // A pointer anywhere, snapped, then painted.
      for (const raw of [0.13, 4.62, -3.4, 17.5, 99.999]) {
        const [x] = snap([raw, 0], 1, phase);
        const [lo, hi] = edges(x, w);
        expect(whole(lo)).toBe(true);
        expect(whole(hi)).toBe(true);
      }
    });
  }

  it('can only align one edge of a fractional-width stroke, and aligns the leading one', () => {
    /* Not a shortcoming of the phase: the two edges are `w` apart, so a width
       that is not a whole number cannot put both on whole pixels from any
       position at all. The choice is which edge to align, and it is the leading
       one. Worth a test rather than a comment, because the obvious assertion
       (both edges whole, for every width) is false and looks true. */
    for (const w of [1.5, 0.5, 2.25]) {
      const phase = phaseOf(style({ strokeWidth: w }));
      const [x] = snap([4.62, 0], 1, phase);
      const [lo, hi] = edges(x, w);
      expect(whole(lo)).toBe(true);
      expect(whole(hi)).toBe(false);
    }
  });

  it('is what the plain grid gets wrong for a one-unit stroke', () => {
    // The defect, stated as a test: snapping the anchor to an integer puts the
    // stroke across two pixel columns, half in each.
    const [x] = snap([4.4, 0], 1, 0);
    expect(x).toBe(4);
    expect(whole(edges(x, 1)[0])).toBe(false);
  });

  it('snaps to the nearest position on the shifted lattice, not the plain one', () => {
    expect(snap([4.4, 0], 1, 0.5)[0]).toBe(4.5);
    expect(snap([4.6, 0], 1, 0.5)[0]).toBe(4.5);
    expect(snap([5.1, 0], 1, 0.5)[0]).toBe(5.5);
  });

  it('leaves a phase of zero exactly where the old grid put it', () => {
    // The default is off, so this is the compatibility claim for every existing
    // test and every drawing made before the switch existed.
    for (const raw of [0.13, 4.62, -3.4, 17.5]) {
      expect(snap([raw, raw], 2, 0)).toEqual(snap([raw, raw], 2));
    }
  });

  it('shifts both axes, since a stroke has horizontal edges too', () => {
    expect(snap([4.4, 4.4], 1, 0.5)).toEqual([4.5, 4.5]);
  });
});

describe('phaseInForce', () => {
  const docWith = (...widths: number[]): Doc => {
    const doc = emptyDoc();
    widths.forEach((w, i) => {
      const shape = shapeFromPath('M0 0 L10 0 L10 10 Z', `s${i}`);
      shape.style = style({ strokeWidth: w });
      doc.shapes.push(shape);
    });
    return doc;
  };

  it('describes what you are about to draw when nothing is selected', () => {
    const doc = docWith(4);
    expect(phaseInForce(doc, emptySelection(), style({ strokeWidth: 1 }))).toBe(0.5);
  });

  it('follows the selected shape, not the pending style', () => {
    const doc = docWith(2);
    const sel = emptySelection();
    sel.shapes.add(doc.shapes[0].id);
    expect(phaseInForce(doc, sel, style({ strokeWidth: 1 }))).toBe(0);
  });

  it('follows a selected node to the shape that owns it', () => {
    const doc = docWith(1);
    const sel = emptySelection();
    sel.nodes.add(nodeKey({ shape: doc.shapes[0].id, sp: 0, i: 0 }));
    expect(phaseInForce(doc, sel, style({ strokeWidth: 2 }))).toBe(0.5);
  });

  it('agrees when two selected shapes want the same lattice', () => {
    // Widths 1 and 3 are different numbers and the same phase, so there is a
    // single honest answer and `null` would be the wrong one.
    const doc = docWith(1, 3);
    const sel = emptySelection();
    for (const sh of doc.shapes) sel.shapes.add(sh.id);
    expect(phaseInForce(doc, sel, style())).toBe(0.5);
  });

  it('returns null when no single lattice can serve the selection', () => {
    const doc = docWith(1, 2);
    const sel = emptySelection();
    for (const sh of doc.shapes) sel.shapes.add(sh.id);
    expect(phaseInForce(doc, sel, style())).toBeNull();
  });
});

describe('phaseLabel', () => {
  it('says the thing icon people already say', () => {
    expect(phaseLabel(0)).toBe('whole pixels');
    expect(phaseLabel(0.5)).toBe('half pixels');
    expect(phaseLabel(null)).toBe('mixed widths');
    expect(phaseLabel(0.75)).toBe('offset 0.75');
  });
});
