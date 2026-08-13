/**
 * Simplify.
 *
 * The promise is narrow and testable: fewer nodes, and nothing moves further
 * than the tolerance you asked for. Most of these check the second half, since
 * the first half is easy to achieve by throwing the drawing away.
 */

import { describe, expect, it } from 'vitest';
import { simplifySubpath } from '../src/model/simplify';
import { parsePath } from '../src/core/parse';
import { cubicAt, projectToCubic } from '../src/core/bezier';
import { continuityOf, makeNode, segmentAsCubic, segmentCount } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';

/** Closed polygon through `n` points on a circle: all corners, no handles. */
const polygon = (n: number, r = 50): Subpath => ({
  nodes: Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return makeNode([r * Math.cos(a), r * Math.sin(a)] as Pt);
  }),
  closed: true,
});

/** The same circle as a genuinely smooth path, handles and all. */
const smoothCircle = (n: number, r = 50): Subpath => {
  const step = (Math.PI * 2) / n;
  const k = ((4 / 3) * Math.tan(step / 4) * r) / r;
  return {
    nodes: Array.from({ length: n }, (_, i) => {
      const a = i * step;
      const pt: Pt = [r * Math.cos(a), r * Math.sin(a)];
      const tan: Pt = [-Math.sin(a) * r * k, Math.cos(a) * r * k];
      return makeNode(
        pt,
        [pt[0] - tan[0], pt[1] - tan[1]] as Pt,
        [pt[0] + tan[0], pt[1] + tan[1]] as Pt,
      );
    }),
    closed: true,
  };
};

/** Shortest distance from `p` to anywhere on the outline. */
const distanceTo = (sp: Subpath, p: Pt): number => {
  let best = Infinity;
  for (let i = 0; i < segmentCount(sp); i++) {
    best = Math.min(best, projectToCubic(segmentAsCubic(sp, i), p, 48, 24).d);
  }
  return best;
};

/** A closed blob with fifteen smooth nodes, from the review's own corpus. */
const BLOB =
  'M 88.843 0 C 88.843 19.389 101.051 22.212 92.587 41.222 S 90.58 52.047 66.437 73.786 ' +
  'S 72.873 108.237 38.769 119.318 S 44.566 102.639 -10.183 96.884 S -45.273 101.581 -55.304 95.79 ' +
  'S -57.128 108.675 -89.069 64.712 S -120.335 57.204 -126.766 26.945 S -105.076 -1.918 -100.924 -21.452 ' +
  'S -76.425 -15.676 -57.475 -41.758 S -41.143 -42.449 -28.667 -49.653 S -62.446 -62.083 -7.136 -67.896 ' +
  'S -26.52 -93.303 24.889 -76.599 S 47.706 -80.074 61.178 -67.945 S 47.454 -65.67 64.004 -28.497 ' +
  'S 88.843 -19.389 88.843 0 Z';

/** Dense samples along an outline, for measuring how far it actually moved. */
const densePoints = (sp: Subpath, per = 60): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i < segmentCount(sp); i++) {
    const c = segmentAsCubic(sp, i);
    for (let k = 0; k < per; k++) out.push(cubicAt(c, k / per));
  }
  return out;
};

describe('simplifySubpath', () => {
  it('turns a dense polygon into a handful of curves', () => {
    const sp = polygon(40);
    const r = simplifySubpath(sp, 1);
    expect(r).not.toBeNull();
    expect(r!.before).toBe(40);
    expect(r!.after).toBeLessThan(12);
    expect(sp.nodes.length).toBe(r!.after);
    expect(sp.closed).toBe(true);
  });

  it('keeps every original point within the tolerance it was given', () => {
    // The claim the status line makes. A 40-gon's corners are the sampled
    // points exactly, since each of its sides flattens to itself.
    const before = polygon(40);
    const originals: Pt[] = [];
    for (let i = 0; i < before.nodes.length; i++) {
      const a = before.nodes[i].pt;
      const b = before.nodes[(i + 1) % before.nodes.length].pt;
      // Along the sides as well as at the corners. Checking only the corners is
      // how a fit that bows out between them passes a test it should fail.
      for (let k = 0; k < 8; k++) {
        originals.push([a[0] + ((b[0] - a[0]) * k) / 8, a[1] + ((b[1] - a[1]) * k) / 8]);
      }
    }

    const sp = polygon(40);
    const r = simplifySubpath(sp, 1)!;
    for (const p of originals) {
      expect(distanceTo(sp, p)).toBeLessThanOrEqual(1);
    }
    // And the number it reports is not smaller than what actually happened.
    const worst = Math.max(...originals.map((p) => distanceTo(sp, p)));
    expect(r.error).toBeGreaterThanOrEqual(worst - 1e-6);
  });

  it('tightening the tolerance keeps more nodes', () => {
    const coarse = polygon(60);
    const fine = polygon(60);
    const a = simplifySubpath(coarse, 2)!;
    const b = simplifySubpath(fine, 0.2)!;
    expect(b.after).toBeGreaterThan(a.after);
  });

  it('refuses to redraw a polygon at a tolerance finer than its own corners', () => {
    // A 40-gon at a tolerance of 0.05 cannot be described by fewer than forty
    // curves, because its flat sides and 9-degree corners are the shape. It
    // succeeds if the fit is checked only at the corners and nowhere along the
    // sides the curve bows away from.
    expect(simplifySubpath(polygon(40), 0.05)).toBeNull();
  });

  it('leaves a square alone, because four nodes is already the answer', () => {
    const sp: Subpath = {
      nodes: [
        makeNode([0, 0]),
        makeNode([10, 0]),
        makeNode([10, 10]),
        makeNode([0, 10]),
      ],
      closed: true,
    };
    expect(simplifySubpath(sp, 1)).toBeNull();
    expect(sp.nodes.length).toBe(4);
  });

  it('collapses a run of collinear points to one straight segment', () => {
    const sp: Subpath = {
      nodes: Array.from({ length: 11 }, (_, i) => (makeNode([i, 0] as Pt))),
      closed: false,
    };
    const r = simplifySubpath(sp, 0.5)!;
    expect(r.after).toBe(2);
    // Straight means no handles at all, not handles that happen to line up.
    expect(sp.nodes[0].hOut).toBeNull();
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes[0].pt).toEqual([0, 0]);
    expect(sp.nodes[1].pt).toEqual([10, 0]);
  });

  it('keeps a sharp corner exactly where it was', () => {
    // Two dense straight runs meeting at ninety degrees. Fitting through the
    // join would round it off, which is the whole reason corners are found
    // first and fitted around.
    const nodes = [];
    for (let i = 0; i <= 10; i++) nodes.push(makeNode([i, 0] as Pt));
    for (let i = 1; i <= 10; i++) nodes.push(makeNode([10, i] as Pt));
    const sp: Subpath = { nodes, closed: false };

    const r = simplifySubpath(sp, 0.5)!;
    expect(r.after).toBe(3);
    expect(sp.nodes[1].pt).toEqual([10, 0]);
    expect(continuityOf(sp.nodes[1])).toBe('corner');
  });

  it('does not put a kink in a closed curve where it cut it', () => {
    // The seam is node 0, and it is the one node the fit sees twice. It is
    // handed the original tangents from both sides, so a smooth circle comes
    // back smooth rather than with a corner at three o'clock.
    const sp = smoothCircle(24);
    const r = simplifySubpath(sp, 0.5);
    expect(r).not.toBeNull();
    expect(continuityOf(sp.nodes[0])).not.toBe('corner');
  });

  it('holds the ends of an open path still', () => {
    const nodes = Array.from({ length: 21 }, (_, i) => {
      const a = (i / 20) * Math.PI;
      return makeNode([30 * Math.cos(a), 30 * Math.sin(a)] as Pt);
    });
    const sp: Subpath = { nodes, closed: false };
    const first = nodes[0].pt.slice();
    const last = nodes[20].pt.slice();

    simplifySubpath(sp, 0.5);
    expect(sp.nodes[0].pt).toEqual(first);
    expect(sp.nodes[sp.nodes.length - 1].pt).toEqual(last);
    expect(sp.closed).toBe(false);
  });

it('reports a number that covers the whole deviation, not just the fit', () => {
    /* The fit is measured against the sampled polyline, and the polyline is
       itself a little way off the true curve; straightening a nearly-flat result
       moves it again. Reporting only the fit error understated the real
       deviation, and on one blob at a tolerance of 8 the outline actually moved
       8.33. The tolerance is now a budget split between all three. */
    const before = parsePath(BLOB)[0];
    const originals = densePoints(before);
    const sp = parsePath(BLOB)[0];
    const r = simplifySubpath(sp, 14);
    expect(r).not.toBeNull();

    const worst = Math.max(...originals.map((p) => distanceTo(sp, p)));
    expect(worst).toBeLessThanOrEqual(14);
    expect(r!.error).toBeGreaterThanOrEqual(worst - 1e-9);
  });

  it('refuses when it cannot fit inside the budget rather than overshooting', () => {
    // The same blob at a tolerance it cannot meet. Applying the result anyway
    // rewrote the path further than the number the user typed.
    expect(simplifySubpath(parsePath(BLOB)[0], 8)).toBeNull();
  });

  it('declines rather than mangling a path too small to fit', () => {
    const sp: Subpath = {
      nodes: [
        makeNode([0, 0]),
        makeNode([10, 0]),
      ],
      closed: false,
    };
    expect(simplifySubpath(sp, 1)).toBeNull();
    expect(simplifySubpath(polygon(40), 0)).toBeNull();
    expect(simplifySubpath(polygon(40), -1)).toBeNull();
  });
});
