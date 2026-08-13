/**
 * Which snap wins.
 *
 * The rule is that the most specific target within reach wins: a vertex (0-D)
 * beats a boundary (1-D) beats the grid (2-D). Most of these set up a point
 * where two tiers both have a claim and check the right one takes it, because a
 * priority order is only a rule where the tiers actually compete.
 */

import { describe, expect, it } from 'vitest';
import { resolveSnap, snapLabel } from '../src/model/snapping';
import type { SnapSetup } from '../src/model/snapping';
import { emptyDoc, shapeFromPath } from '../src/model/doc';
import type { Doc, Pt } from '../src/core/types';

/**
 * A square from (10, 10) to (30, 30), with straight sides.
 *
 * `shapeFromPath`'s second argument is the shape's NAME; ids are generated. Do
 * not pass 'sq' here and then use it as an id: every exclusion silently matches
 * nothing, and four tests fail for that one reason.
 */
const square = (d = 'M10 10 L30 10 L30 30 L10 30 Z'): Doc => {
  const doc = emptyDoc();
  doc.shapes.push(shapeFromPath(d));
  return doc;
};

/** The generated id of a document's only shape. */
const only = (doc: Doc): string => doc.shapes[0].id;

const setup = (over: Partial<SnapSetup> = {}): SnapSetup => ({
  doc: square(),
  step: 1,
  phase: 0,
  toGrid: true,
  toPoints: true,
  toBoundary: true,
  reach: 2,
  ...over,
});

describe('the priority order', () => {
  it('gives a vertex to the vertex tier, not the grid', () => {
    // The corner is at (10, 10), which is also a grid position, so the point
    // has to be somewhere only one of them can claim.
    const doc = square('M10.4 10.4 L30 10 L30 30 Z');
    const r = resolveSnap([10.6, 10.6], setup({ doc }));
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([10.4, 10.4]);
  });

  it('prefers a vertex to a nearer gridline', () => {
    /* The rule that is not "closest wins". The pointer is 0.05 from a gridline
       and 0.75 from a corner, and the corner still takes it, because a corner
       is something the user can see and aim at. */
    const doc = square('M10.5 10.5 L30 10 L30 30 Z');
    const r = resolveSnap([11.05, 10.5], setup({ doc, reach: 2 }));
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([10.5, 10.5]);
  });

  it('prefers a vertex to a boundary when both are in reach', () => {
    // Just inside the top-left corner: the corner is a vertex, and the two
    // sides meeting there are boundaries at a comparable distance.
    const r = resolveSnap([10.3, 10.3], setup());
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([10, 10]);
  });

  it('gives the middle of a side to the boundary tier', () => {
    // Far from any corner, so the vertex tier has no claim, and off the grid.
    const r = resolveSnap([20.5, 10.4], setup({ step: 3 }));
    expect(r.kind).toBe('boundary');
    // The distance TO the curve is what matters and is exact here; the position
    // along it comes from a sampled projection, so it is close rather than exact.
    expect(r.pt[1]).toBeCloseTo(10, 9);
    expect(r.pt[0]).toBeCloseTo(20.5, 3);
  });

  it('falls back to the grid when nothing is within reach', () => {
    const r = resolveSnap([60.4, 60.4], setup());
    expect(r.kind).toBe('grid');
    expect(r.pt).toEqual([60, 60]);
  });

  it('reports none, and moves nothing, when every tier is off', () => {
    const r = resolveSnap([60.4, 60.4], setup({ toGrid: false, toPoints: false, toBoundary: false }));
    expect(r.kind).toBe('none');
    expect(r.pt).toEqual([60.4, 60.4]);
  });

  it('skips a tier that is switched off and uses the next one down', () => {
    const near: Pt = [10.3, 10.3];
    expect(resolveSnap(near, setup({ toPoints: false })).kind).toBe('boundary');
    expect(resolveSnap(near, setup({ toPoints: false, toBoundary: false })).kind).toBe('grid');
  });
});

describe('pixel fit sits inside the grid tier, rather than beside it', () => {
  it('shifts the lattice the grid tier lands on', () => {
    const r = resolveSnap([60.4, 60.4], setup({ phase: 0.5 }));
    expect(r.kind).toBe('grid');
    expect(r.pt).toEqual([60.5, 60.5]);
  });

  it('does not save the grid from being beaten by a vertex', () => {
    /* The interaction the rule exists to settle. With pixel fit on, a corner
       still wins -- welding to a node someone can see matters more than landing
       on a lattice they cannot, phase or no phase. */
    const r = resolveSnap([10.3, 10.3], setup({ phase: 0.5 }));
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([10, 10]);
  });
});

describe('what a snap must not do', () => {
  /* Each of these leaves exactly ONE tier switched on, so `none` can only mean
     the exclusion worked. Checking the returned point instead was the first
     attempt and it passed for the wrong reason: with the grid on, [10.4, 10.4]
     rounds to [10, 10], which is also where the excluded corner is. */
  it('never snaps a dragged node to itself', () => {
    const doc = square();
    const r = resolveSnap(
      [10.4, 10.4],
      setup({ doc, exclude: { shape: only(doc), sp: 0, i: 0 }, toGrid: false, toBoundary: false }),
    );
    expect(r.kind).toBe('none');
    expect(r.pt).toEqual([10.4, 10.4]);
    // And with the exclusion lifted, the same point IS claimed -- so the tier
    // was working and the exclusion is what silenced it.
    expect(resolveSnap([10.4, 10.4], setup({ doc, toGrid: false, toBoundary: false })).kind).toBe(
      'vertex',
    );
  });

  it('never snaps a dragged node to the segments it sits on', () => {
    /* The same trap one dimension up, and the one that only appears once
       boundary snapping exists: node 0 lies on the two sides that meet at it,
       both of which report a distance of zero. */
    const doc = square();
    const r = resolveSnap(
      [10.4, 10.4],
      setup({ doc, exclude: { shape: only(doc), sp: 0, i: 0 }, toGrid: false, toPoints: false }),
    );
    expect(r.kind).toBe('none');
    expect(resolveSnap([10.4, 10.4], setup({ doc, toGrid: false, toPoints: false })).kind).toBe(
      'boundary',
    );
  });

  it('still lets a node snap to a distant part of its own path', () => {
    // The opposite side of the same square is a legitimate target: excluding the
    // whole subpath would have been the easy fix and the wrong one.
    const doc = square();
    const r = resolveSnap(
      [20, 29.6],
      setup({ doc, exclude: { shape: only(doc), sp: 0, i: 0 }, toGrid: false }),
    );
    expect(r.kind).toBe('boundary');
    expect(r.pt[1]).toBeCloseTo(30, 9);
  });

  it('ignores the shape the pen is drawing, in both tiers', () => {
    const doc = square();
    const s = setup({ doc, excludeShape: only(doc), step: 0, toGrid: false });
    expect(resolveSnap([10.1, 10.1], s).kind).toBe('none');
    expect(resolveSnap([20, 10.1], s).kind).toBe('none');
  });

  it('respects the reach, so a far target does not reach out and grab', () => {
    const far = setup({ reach: 0.1, step: 0, toGrid: false });
    expect(resolveSnap([10.4, 10.4], far).kind).toBe('none');
    const near = setup({ reach: 1, step: 0, toGrid: false });
    expect(resolveSnap([10.4, 10.4], near).kind).toBe('vertex');
  });
});

describe('snapLabel', () => {
  /* Named after what claimed the point rather than after the tier it belongs
     to. Six things answer three tiers now, and `on an outline` while the
     pointer sits on a 45-degree ray is a true statement about the tier and a
     false one about the drawing. */
  it('names what claimed the point, and says nothing when nothing did', () => {
    expect(snapLabel('node')).toBe('on a node');
    expect(snapLabel('outline')).toBe('on an outline');
    expect(snapLabel('keyline')).toBe('on a keyline');
    expect(snapLabel('guide')).toBe('on a guide');
    expect(snapLabel('cross')).toBe('where guides cross');
    expect(snapLabel('ray')).toBe('on an angle');
    expect(snapLabel('grid')).toBe('on the grid');
    expect(snapLabel('none')).toBeNull();
  });

  it('gives a different name to each of the six', () => {
    // A label repeated across two sources would make the readout unable to say
    // which one moved the pointer, which is the whole reason `via` exists.
    const all = (['node', 'outline', 'keyline', 'guide', 'cross', 'ray', 'grid'] as const).map(
      (v) => snapLabel(v),
    );
    expect(new Set(all).size).toBe(all.length);
  });
});
