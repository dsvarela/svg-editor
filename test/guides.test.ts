/**
 * Guides: the list, and what the snapper does with it.
 *
 * The list operations are small enough that the interesting cases are the ones
 * where two guides meet: adding one where another already is, dragging one onto
 * another, and the moment during a drag when two are legitimately in the same
 * place. The snapping half checks that a guide answers the tier its dimension
 * puts it in and never a tier above.
 */

import { describe, expect, it } from 'vitest';
import {
  addGuide,
  moveGuide,
  nearestGuideCross,
  nearestGuideLine,
  removeGuide,
  settleGuide,
} from '../src/model/guides';
import type { Guide } from '../src/model/guides';
import { resolveSnap } from '../src/model/snapping';
import type { SnapSetup } from '../src/model/snapping';
import { emptyDoc, shapeFromPath } from '../src/model/doc';

describe('keeping the list honest', () => {
  it('adds a guide and reports that it did', () => {
    const list: Guide[] = [];
    expect(addGuide(list, { axis: 'x', at: 12 })).toBe(true);
    expect(list).toEqual([{ axis: 'x', at: 12 }]);
  });

  it('refuses a second guide in the same place, without touching the list', () => {
    /* Reported as false so the caller records no undo step. A press on a ruler
       where a guide already sits is the common way to get here. */
    const list: Guide[] = [{ axis: 'x', at: 12 }];
    expect(addGuide(list, { axis: 'x', at: 12 })).toBe(false);
    expect(list).toHaveLength(1);
  });

  it('does not confuse the two axes', () => {
    const list: Guide[] = [{ axis: 'x', at: 12 }];
    expect(addGuide(list, { axis: 'y', at: 12 })).toBe(true);
    expect(list).toHaveLength(2);
  });

  it('refuses a position that is not a number', () => {
    // Reachable by typing: the field is a number input and an empty one reads
    // as NaN. A guide at NaN draws nowhere and is within reach of everything.
    const list: Guide[] = [];
    expect(addGuide(list, { axis: 'x', at: Number.NaN })).toBe(false);
    expect(addGuide(list, { axis: 'x', at: Infinity })).toBe(false);
    expect(list).toHaveLength(0);
  });

  it('lets two guides sit in one place while a drag is under way', () => {
    /* The reason `moveGuide` does not merge. Splicing the list under a gesture
       that is holding an index into it would hand the drag whichever guide
       inherited the index, so passing over another guide on the way somewhere
       else would silently start moving a different line. */
    const list: Guide[] = [
      { axis: 'x', at: 10 },
      { axis: 'x', at: 40 },
    ];
    expect(moveGuide(list, 1, 10)).toBe(true);
    expect(list).toHaveLength(2);
    expect(list[1].at).toBe(10);
  });

  it('settles the duplicate once the drag ends', () => {
    const list: Guide[] = [
      { axis: 'x', at: 10 },
      { axis: 'x', at: 10 },
    ];
    expect(settleGuide(list, 1)).toBe(true);
    expect(list).toEqual([{ axis: 'x', at: 10 }]);
  });

  it('leaves a guide alone when it settled somewhere of its own', () => {
    const list: Guide[] = [
      { axis: 'x', at: 10 },
      { axis: 'x', at: 40 },
    ];
    expect(settleGuide(list, 1)).toBe(false);
    expect(list).toHaveLength(2);
  });

  it('removes by index, and says so when there is nothing there', () => {
    const list: Guide[] = [{ axis: 'y', at: 3 }];
    expect(removeGuide(list, 1)).toBe(false);
    expect(removeGuide(list, 0)).toBe(true);
    expect(list).toHaveLength(0);
  });
});

describe('finding the nearest guide', () => {
  const list: Guide[] = [
    { axis: 'x', at: 10 },
    { axis: 'y', at: 40 },
    { axis: 'x', at: 90 },
  ];

  it('projects onto the line rather than moving along it', () => {
    const hit = nearestGuideLine(list, [10.4, 77], 2);
    expect(hit).not.toBeNull();
    expect(hit!.pt).toEqual([10, 77]);
    expect(hit!.i).toBe(0);
  });

  it('reports nothing when the nearest is out of reach', () => {
    expect(nearestGuideLine(list, [50, 77], 2)).toBeNull();
  });

  it('finds a crossing, which is two guides agreeing on a point', () => {
    const hit = nearestGuideCross(list, [10.3, 40.3], 2);
    expect(hit).not.toBeNull();
    expect(hit!.pt).toEqual([10, 40]);
  });

  it('will not invent a crossing from two guides on the same axis', () => {
    // Two verticals never meet, and a version that looped over pairs without
    // checking the axes would happily return one of their positions.
    const parallel: Guide[] = [
      { axis: 'x', at: 10 },
      { axis: 'x', at: 12 },
    ];
    expect(nearestGuideCross(parallel, [11, 11], 5)).toBeNull();
  });

  it('needs the crossing itself in reach, not just one of its lines', () => {
    // On the vertical guide but forty units from the horizontal one: there is
    // a line here and there is no point here.
    expect(nearestGuideCross(list, [10, 80], 2)).toBeNull();
    expect(nearestGuideLine(list, [10, 80], 2)).not.toBeNull();
  });
});

describe('guides in the priority order', () => {
  const setup = (over: Partial<SnapSetup> = {}): SnapSetup => ({
    doc: emptyDoc(),
    step: 1,
    phase: 0,
    toGrid: true,
    toPoints: true,
    toBoundary: true,
    reach: 2,
    guideLines: [
      { axis: 'x', at: 10.5 },
      { axis: 'y', at: 40.5 },
    ],
    ...over,
  });

  it('answers the boundary tier with a line', () => {
    const r = resolveSnap([10.7, 77.3], setup({ step: 0 }));
    expect(r.kind).toBe('boundary');
    expect(r.pt).toEqual([10.5, 77.3]);
  });

  it('answers the vertex tier with a crossing', () => {
    /* The rule applied rather than an exception carved out: a line is 1-D and
       a crossing is 0-D, so the crossing wins even though it is the same two
       guides. */
    const r = resolveSnap([10.7, 40.7], setup({ step: 0 }));
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([10.5, 40.5]);
  });

  it('beats the grid from further away', () => {
    // The lattice point at (11, 77) is 0.3 off; the guide is 0.2 off in x but
    // the tier decides it, not the distance.
    const r = resolveSnap([10.8, 77], setup({ step: 1 }));
    expect(r.kind).toBe('boundary');
    expect(r.pt[0]).toBe(10.5);
  });

  it('loses to a node of the drawing, which is nearer and is the work', () => {
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath('M10.6 40.6 L80 80 Z'));
    const r = resolveSnap([10.65, 40.65], setup({ doc, step: 0 }));
    expect(r.kind).toBe('vertex');
    expect(r.pt).toEqual([10.6, 40.6]);
  });

  it('does not answer a tier that is switched off', () => {
    expect(resolveSnap([10.7, 77.3], setup({ step: 0, toBoundary: false })).kind).toBe('none');
    // Points off drops the crossing to the line it lies on, not to nothing.
    const r = resolveSnap([10.7, 40.7], setup({ step: 0, toPoints: false }));
    expect(r.kind).toBe('boundary');
  });

  it('claims nothing when there are no guides to claim with', () => {
    const r = resolveSnap([10.7, 77.3], setup({ step: 0, guideLines: [] }));
    expect(r.kind).toBe('none');
    expect(r.pt).toEqual([10.7, 77.3]);
  });
});
