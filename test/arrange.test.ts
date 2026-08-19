/**
 * Arranging whole shapes: align, distribute and spacing.
 *
 * Every assertion here measures a bounding box, because a box is the whole
 * subject. Comparing coordinates would pass for the wrong reason on a rectangle
 * whose node order happens to start at the corner being aligned to.
 *
 * The two questions worth the most: does a group move as one thing, and does
 * anything change size. Align may only ever translate, so a shape that comes out
 * a different width has been scaled by something that should not have.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { Commands } from '../src/tools/commands';
import { emptyDoc, shapeBBox, shapeFromPath } from '../src/model/doc';
import {
  alignUnits,
  arrangeUnits,
  distributeUnits,
  edgeOf,
  dropShapes,
  reorderShapes,
  spaceUnits,
  unitsBox,
  viewBoxAsBox,
} from '../src/model/arrange';
import type { Box } from '../src/core/bezier';
import type { Doc, Shape } from '../src/core/types';

const rect = (name: string, x: number, y: number, w: number, h: number): Shape => {
  const sh = shapeFromPath(`M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`);
  sh.name = name;
  return sh;
};

/** A document of rectangles, given as `[name, x, y, w, h]`. */
function docOf(...rects: [string, number, number, number, number][]): Doc {
  const doc = emptyDoc();
  for (const r of rects) doc.shapes.push(rect(...r));
  return doc;
}

const named = (doc: Doc, name: string): Shape => doc.shapes.find((sh) => sh.name === name)!;
const boxOf = (doc: Doc, name: string): Box => shapeBBox(named(doc, name))!;
const idsOf = (doc: Doc, ...names: string[]): Set<string> =>
  new Set(doc.shapes.filter((sh) => names.includes(sh.name)).map((sh) => sh.id));

const size = (b: Box): [number, number] => [b.x1 - b.x0, b.y1 - b.y0];

/** Every shape in the document, name to box. Used to assert nothing else moved. */
const snapshot = (doc: Doc): Record<string, Box> =>
  Object.fromEntries(doc.shapes.map((sh) => [sh.name, shapeBBox(sh)!]));

function editor(doc: Doc): { store: Store; commands: Commands } {
  const store = new Store(doc);
  return { store, commands: new Commands(store, () => false) };
}

const select = (store: Store, ...names: string[]): void =>
  store.update((s) => {
    s.selection.shapes.clear();
    for (const sh of s.doc.shapes) if (names.includes(sh.name)) s.selection.shapes.add(sh.id);
  });

describe('units', () => {
  it('is one unit per selected shape when nothing is grouped', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 40, 5, 10, 10], ['c', 80, 0, 10, 10]);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    expect(units).toHaveLength(3);
    expect(units.every((u) => u.group === null)).toBe(true);
  });

  it('leaves out shapes that are not selected', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 40, 5, 10, 10]);
    expect(arrangeUnits(doc, idsOf(doc, 'a'))).toHaveLength(1);
  });

  it('makes one unit of a group whose every shape is selected', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 80, 0, 10, 10]);
    doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
    named(doc, 'a').group = 'g1';
    named(doc, 'b').group = 'g1';

    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    expect(units).toHaveLength(2);
    const group = units.find((u) => u.group === 'g1')!;
    expect(group.shapes.map((sh) => sh.name).sort()).toEqual(['a', 'b']);
    // The unit's box spans both of them, which is what makes it move as one.
    expect(group.box).toEqual({ x0: 0, y0: 0, x1: 30, y1: 10 });
  });

  it('splits a group whose shapes are only partly selected', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10]);
    doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
    named(doc, 'a').group = 'g1';
    named(doc, 'b').group = 'g1';

    const units = arrangeUnits(doc, idsOf(doc, 'a'));
    expect(units).toHaveLength(1);
    expect(units[0].group).toBeNull();
    expect(units[0].shapes.map((sh) => sh.name)).toEqual(['a']);
  });

  it('takes the outermost wholly selected group when they nest', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 40, 0, 10, 10]);
    doc.groups = [
      { id: 'outer', name: 'outer', parent: null },
      { id: 'inner', name: 'inner', parent: 'outer' },
    ];
    named(doc, 'a').group = 'inner';
    named(doc, 'b').group = 'inner';
    named(doc, 'c').group = 'outer';

    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    expect(units).toHaveLength(1);
    expect(units[0].group).toBe('outer');
  });

  it('takes the inner group when only that one is wholly selected', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 40, 0, 10, 10]);
    doc.groups = [
      { id: 'outer', name: 'outer', parent: null },
      { id: 'inner', name: 'inner', parent: 'outer' },
    ];
    named(doc, 'a').group = 'inner';
    named(doc, 'b').group = 'inner';
    named(doc, 'c').group = 'outer';

    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b'));
    expect(units).toHaveLength(1);
    expect(units[0].group).toBe('inner');
  });
});

describe('align', () => {
  const three = (): Doc => docOf(['a', 0, 0, 10, 20], ['b', 40, 30, 30, 10], ['c', 80, 5, 10, 10]);

  it('puts every left edge on the leftmost', () => {
    const doc = three();
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    alignUnits(units, 'left', unitsBox(units)!);
    for (const name of ['a', 'b', 'c']) expect(boxOf(doc, name).x0).toBeCloseTo(0, 9);
  });

  it('puts every right edge on the rightmost', () => {
    const doc = three();
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    alignUnits(units, 'right', unitsBox(units)!);
    for (const name of ['a', 'b', 'c']) expect(boxOf(doc, name).x1).toBeCloseTo(90, 9);
  });

  it('puts every horizontal centre on the box centre', () => {
    const doc = three();
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    alignUnits(units, 'hcenter', unitsBox(units)!);
    for (const name of ['a', 'b', 'c']) {
      const b = boxOf(doc, name);
      expect((b.x0 + b.x1) / 2).toBeCloseTo(45, 9);
    }
  });

  it('aligns top, bottom and vertical centre on the other axis', () => {
    for (const [mode, read] of [
      ['top', (b: Box) => b.y0],
      ['bottom', (b: Box) => b.y1],
      ['vcenter', (b: Box) => (b.y0 + b.y1) / 2],
    ] as const) {
      const doc = three();
      const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
      const frame = unitsBox(units)!;
      alignUnits(units, mode, frame);
      const want = edgeOf(frame, mode);
      for (const name of ['a', 'b', 'c']) expect(read(boxOf(doc, name))).toBeCloseTo(want, 9);
    }
  });

  it('never moves anything on the axis it is not aligning', () => {
    const doc = three();
    const before = snapshot(doc);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    alignUnits(units, 'left', unitsBox(units)!);
    for (const name of ['a', 'b', 'c']) {
      expect(boxOf(doc, name).y0).toBeCloseTo(before[name].y0, 9);
      expect(boxOf(doc, name).y1).toBeCloseTo(before[name].y1, 9);
    }
  });

  it('never changes a size', () => {
    const doc = three();
    const before = snapshot(doc);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    alignUnits(units, 'hcenter', unitsBox(units)!);
    for (const name of ['a', 'b', 'c']) {
      expect(size(boxOf(doc, name))).toEqual(size(before[name]));
    }
  });

  it('centres one shape on the canvas', () => {
    const doc = docOf(['a', 3, 7, 10, 20]);
    doc.viewBox = { x: 0, y: 0, w: 100, h: 100 };
    const units = arrangeUnits(doc, idsOf(doc, 'a'));
    alignUnits(units, 'hcenter', viewBoxAsBox(doc.viewBox));
    alignUnits(units, 'vcenter', viewBoxAsBox(doc.viewBox));
    expect(boxOf(doc, 'a')).toEqual({ x0: 45, y0: 40, x1: 55, y1: 60 });
  });

  it('honours a viewBox that does not start at the origin', () => {
    const doc = docOf(['a', 0, 0, 10, 10]);
    doc.viewBox = { x: 200, y: 100, w: 40, h: 40 };
    const units = arrangeUnits(doc, idsOf(doc, 'a'));
    alignUnits(units, 'left', viewBoxAsBox(doc.viewBox));
    expect(boxOf(doc, 'a').x0).toBeCloseTo(200, 9);
  });

  it('moves a group as one, keeping its shapes where they are relative to each other', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 80, 0, 10, 10]);
    doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
    named(doc, 'a').group = 'g1';
    named(doc, 'b').group = 'g1';

    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    alignUnits(units, 'left', unitsBox(units)!);
    // The group's own left edge lands on 0, so `a` has not moved and `b` keeps
    // its 20 unit offset. Without units, `b` would have been dragged to 0 too.
    expect(boxOf(doc, 'a').x0).toBeCloseTo(0, 9);
    expect(boxOf(doc, 'b').x0).toBeCloseTo(20, 9);
    expect(boxOf(doc, 'c').x0).toBeCloseTo(0, 9);
  });
});

describe('distribute', () => {
  it('spaces centres evenly and leaves the outer two alone', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 15, 0, 20, 10], ['c', 90, 0, 10, 10]);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    distributeUnits(units, 'hcenter', unitsBox(units)!);

    const mid = (n: string): number => (boxOf(doc, n).x0 + boxOf(doc, n).x1) / 2;
    expect(mid('a')).toBeCloseTo(5, 9);
    expect(mid('c')).toBeCloseTo(95, 9);
    expect(mid('b') - mid('a')).toBeCloseTo(mid('c') - mid('b'), 9);
  });

  it('spaces left edges evenly when asked for left', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 15, 0, 30, 10], ['c', 90, 0, 10, 10]);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    distributeUnits(units, 'left', unitsBox(units)!);
    expect(boxOf(doc, 'a').x0).toBeCloseTo(0, 9);
    expect(boxOf(doc, 'b').x0).toBeCloseTo(45, 9);
    expect(boxOf(doc, 'c').x0).toBeCloseTo(90, 9);
  });

  it('reads the order from position, not from the document', () => {
    // `c` is drawn first and sits in the middle. Distributing must not treat the
    // paint order as the left-to-right order.
    const doc = docOf(['c', 40, 0, 10, 10], ['a', 0, 0, 10, 10], ['b', 100, 0, 10, 10]);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    distributeUnits(units, 'hcenter', unitsBox(units)!);
    expect(boxOf(doc, 'a').x0).toBeCloseTo(0, 9);
    expect(boxOf(doc, 'b').x0).toBeCloseTo(100, 9);
    expect(boxOf(doc, 'c').x0).toBeCloseTo(50, 9);
  });

  it('puts the outer two flush against the canvas', () => {
    const doc = docOf(['a', 10, 0, 10, 10], ['b', 30, 0, 10, 10], ['c', 50, 0, 10, 10]);
    doc.viewBox = { x: 0, y: 0, w: 100, h: 100 };
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    distributeUnits(units, 'hcenter', viewBoxAsBox(doc.viewBox));
    expect(boxOf(doc, 'a').x0).toBeCloseTo(0, 9);
    expect(boxOf(doc, 'c').x1).toBeCloseTo(100, 9);
    const mid = (n: string): number => (boxOf(doc, n).x0 + boxOf(doc, n).x1) / 2;
    expect(mid('b')).toBeCloseTo(50, 9);
  });

  it('distributes down the page on the vertical modes', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 0, 5, 10, 10], ['c', 0, 90, 10, 10]);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    distributeUnits(units, 'vcenter', unitsBox(units)!);
    const mid = (n: string): number => (boxOf(doc, n).y0 + boxOf(doc, n).y1) / 2;
    expect(mid('b')).toBeCloseTo(50, 9);
  });

  it('does nothing to two shapes', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 90, 0, 10, 10]);
    const before = snapshot(doc);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b'));
    distributeUnits(units, 'hcenter', unitsBox(units)!);
    expect(snapshot(doc)).toEqual(before);
  });
});

describe('spacing', () => {
  it('makes the gaps equal without moving the outer two', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 12, 0, 30, 10], ['c', 90, 0, 10, 10]);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    spaceUnits(units, 'h', unitsBox(units)!, null);
    expect(boxOf(doc, 'a').x0).toBeCloseTo(0, 9);
    expect(boxOf(doc, 'c').x1).toBeCloseTo(100, 9);
    // 100 units of span less 50 of shape, over two gaps.
    expect(boxOf(doc, 'b').x0 - boxOf(doc, 'a').x1).toBeCloseTo(25, 9);
    expect(boxOf(doc, 'c').x0 - boxOf(doc, 'b').x1).toBeCloseTo(25, 9);
  });

  it('uses the gap it is given, packing from the frame', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 50, 0, 20, 10], ['c', 90, 0, 10, 10]);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    spaceUnits(units, 'h', unitsBox(units)!, 5);
    expect(boxOf(doc, 'a').x0).toBeCloseTo(0, 9);
    expect(boxOf(doc, 'b').x0).toBeCloseTo(15, 9);
    expect(boxOf(doc, 'c').x0).toBeCloseTo(40, 9);
  });

  it('spaces across the canvas when that is the frame', () => {
    const doc = docOf(['a', 10, 0, 10, 10], ['b', 30, 0, 10, 10]);
    doc.viewBox = { x: 0, y: 0, w: 100, h: 100 };
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b'));
    spaceUnits(units, 'h', viewBoxAsBox(doc.viewBox), null);
    expect(boxOf(doc, 'a').x0).toBeCloseTo(0, 9);
    expect(boxOf(doc, 'b').x1).toBeCloseTo(100, 9);
  });

  it('overlaps rather than refusing when the shapes do not fit', () => {
    const doc = docOf(['a', 0, 0, 60, 10], ['b', 0, 0, 60, 10]);
    doc.viewBox = { x: 0, y: 0, w: 100, h: 100 };
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b'));
    spaceUnits(units, 'h', viewBoxAsBox(doc.viewBox), null);
    expect(boxOf(doc, 'a').x0).toBeCloseTo(0, 9);
    expect(boxOf(doc, 'b').x1).toBeCloseTo(100, 9);
  });

  it('stacks down the page on the vertical axis', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 0, 3, 10, 10], ['c', 0, 90, 10, 10]);
    const units = arrangeUnits(doc, idsOf(doc, 'a', 'b', 'c'));
    spaceUnits(units, 'v', unitsBox(units)!, null);
    expect(boxOf(doc, 'b').y0 - boxOf(doc, 'a').y1).toBeCloseTo(35, 9);
    expect(boxOf(doc, 'c').y0 - boxOf(doc, 'b').y1).toBeCloseTo(35, 9);
  });

  it('does nothing to one shape', () => {
    const doc = docOf(['a', 30, 0, 10, 10]);
    const before = snapshot(doc);
    const units = arrangeUnits(doc, idsOf(doc, 'a'));
    spaceUnits(units, 'h', viewBoxAsBox(doc.viewBox), null);
    expect(snapshot(doc)).toEqual(before);
  });
});

describe('paint order', () => {
  /**
   * Whether every group's shapes sit in one unbroken run of `doc.shapes`.
   *
   * The invariant reordering could break and the reason it happens per parent.
   * Asserted as a property over every group rather than as a particular order,
   * because any order satisfying it is a legal document.
   */
  function contiguous(doc: Doc): boolean {
    for (const g of doc.groups ?? []) {
      const at = doc.shapes
        .map((sh, i) => (sh.group === g.id || groupOf(doc, sh) === g.id ? i : -1))
        .filter((i) => i >= 0);
      if (!at.length) continue;
      if (at[at.length - 1] - at[0] !== at.length - 1) return false;
    }
    return true;
  }
  /** The outermost group a shape is in, walked without importing the query. */
  function groupOf(doc: Doc, sh: Shape): string | null {
    let at = sh.group ?? null;
    const chain: string[] = [];
    for (let i = 0; at && i <= (doc.groups?.length ?? 0); i++) {
      chain.push(at);
      at = doc.groups?.find((g) => g.id === at)?.parent ?? null;
    }
    return chain.length ? chain[chain.length - 1] : null;
  }

  const order = (doc: Doc): string[] => doc.shapes.map((sh) => sh.name);
  const flat = (): Doc =>
    docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 40, 0, 10, 10], ['d', 60, 0, 10, 10]);

  it('brings one shape forward by one', () => {
    const doc = flat();
    expect(reorderShapes(doc, idsOf(doc, 'b'), 'forward')).toBe(true);
    expect(order(doc)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('sends one shape backward by one', () => {
    const doc = flat();
    reorderShapes(doc, idsOf(doc, 'c'), 'backward');
    expect(order(doc)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('takes a shape to the front and to the back', () => {
    const doc = flat();
    reorderShapes(doc, idsOf(doc, 'a'), 'front');
    expect(order(doc)).toEqual(['b', 'c', 'd', 'a']);
    reorderShapes(doc, idsOf(doc, 'a'), 'back');
    expect(order(doc)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('declines when there is nowhere left to go', () => {
    const doc = flat();
    expect(reorderShapes(doc, idsOf(doc, 'd'), 'forward')).toBe(false);
    expect(reorderShapes(doc, idsOf(doc, 'a'), 'backward')).toBe(false);
    expect(order(doc)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moves two neighbours as a block rather than past each other', () => {
    const doc = flat();
    reorderShapes(doc, idsOf(doc, 'a', 'b'), 'forward');
    expect(order(doc)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('keeps the relative order of what it moves to the front', () => {
    const doc = flat();
    reorderShapes(doc, idsOf(doc, 'a', 'c'), 'front');
    expect(order(doc)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('moves a shape only within its own group', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 40, 0, 10, 10]);
    doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
    named(doc, 'a').group = 'g1';
    named(doc, 'b').group = 'g1';

    expect(reorderShapes(doc, idsOf(doc, 'b'), 'forward')).toBe(false);
    expect(order(doc)).toEqual(['a', 'b', 'c']);
    expect(contiguous(doc)).toBe(true);
  });

  it('moves the whole group when the whole group is selected', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 40, 0, 10, 10]);
    doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
    named(doc, 'a').group = 'g1';
    named(doc, 'b').group = 'g1';

    expect(reorderShapes(doc, idsOf(doc, 'a', 'b'), 'forward')).toBe(true);
    expect(order(doc)).toEqual(['c', 'a', 'b']);
    expect(contiguous(doc)).toBe(true);
  });

  it('keeps a group contiguous when a loose shape is sent past it', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 40, 0, 10, 10]);
    doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
    named(doc, 'b').group = 'g1';
    named(doc, 'c').group = 'g1';

    // `a` is behind the group, so forward puts it in front of the whole run and
    // never between `b` and `c`.
    expect(reorderShapes(doc, idsOf(doc, 'a'), 'forward')).toBe(true);
    expect(order(doc)).toEqual(['b', 'c', 'a']);
    expect(contiguous(doc)).toBe(true);
  });

  it('reorders inside a nested group without disturbing the outer one', () => {
    const doc = docOf(
      ['a', 0, 0, 10, 10],
      ['b', 20, 0, 10, 10],
      ['c', 40, 0, 10, 10],
      ['d', 60, 0, 10, 10],
    );
    doc.groups = [
      { id: 'outer', name: 'outer', parent: null },
      { id: 'inner', name: 'inner', parent: 'outer' },
    ];
    named(doc, 'a').group = 'inner';
    named(doc, 'b').group = 'inner';
    named(doc, 'c').group = 'outer';

    expect(reorderShapes(doc, idsOf(doc, 'a'), 'forward')).toBe(true);
    expect(order(doc)).toEqual(['b', 'a', 'c', 'd']);
    expect(contiguous(doc)).toBe(true);
  });

  it('keeps every shape, and only those shapes', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 40, 0, 10, 10]);
    doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
    named(doc, 'b').group = 'g1';
    named(doc, 'c').group = 'g1';
    reorderShapes(doc, idsOf(doc, 'a'), 'front');
    expect(order(doc).slice().sort()).toEqual(['a', 'b', 'c']);
  });

  it('does nothing with nothing selected', () => {
    const doc = flat();
    expect(reorderShapes(doc, new Set(), 'front')).toBe(false);
    expect(order(doc)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves no undo entry when it declines', () => {
    const doc = flat();
    const { store, commands } = editor(doc);
    select(store, 'd');
    expect(commands.reorderSelection('forward')).toBe(false);
    // Undo now would have to take back the last real edit, and there is none.
    store.undo();
    expect(store.state.doc.shapes.map((sh) => sh.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('undoes a reorder in one step', () => {
    const doc = flat();
    const { store, commands } = editor(doc);
    select(store, 'a');
    expect(commands.reorderSelection('front')).toBe(true);
    expect(store.state.doc.shapes.map((sh) => sh.name)).toEqual(['b', 'c', 'd', 'a']);
    store.undo();
    expect(store.state.doc.shapes.map((sh) => sh.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  /* Dropping is the same reordering with the destination named outright, which
     is what dragging a row in the list means. Every case here also asserts
     contiguity, because that is the invariant a destination could break and a
     step never could. */
  describe('dropShapes', () => {
    const idOf = (doc: Doc, name: string): string => named(doc, name).id;

    it('lands a shape immediately before the row it was dropped on', () => {
      const doc = flat();
      expect(dropShapes(doc, idsOf(doc, 'd'), null, idOf(doc, 'b'))).toBe(true);
      expect(order(doc)).toEqual(['a', 'd', 'b', 'c']);
    });

    it('lands at the end when there is no row after the drop', () => {
      const doc = flat();
      expect(dropShapes(doc, idsOf(doc, 'a'), null, null)).toBe(true);
      expect(order(doc)).toEqual(['b', 'c', 'd', 'a']);
    });

    it('counts the destination among the rows that are staying', () => {
      /* Two rows dragged down past a third. Taking the destination's index in
         the list as it stands counts the two that are about to leave, so the
         insertion point is two too far along and the pair lands at the end:
         `c d a b` rather than in front of `d` where the line was drawn. */
      const doc = flat();
      expect(dropShapes(doc, idsOf(doc, 'a', 'b'), null, idOf(doc, 'd'))).toBe(true);
      expect(order(doc)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('keeps the relative order of what it moves', () => {
      const doc = flat();
      expect(dropShapes(doc, idsOf(doc, 'd', 'b'), null, idOf(doc, 'a'))).toBe(true);
      expect(order(doc)).toEqual(['b', 'd', 'a', 'c']);
    });

    it('declines a drop that changes nothing', () => {
      const doc = flat();
      expect(dropShapes(doc, idsOf(doc, 'b'), null, idOf(doc, 'c'))).toBe(false);
      expect(order(doc)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('moves a group as one child of its parent', () => {
      const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 40, 0, 10, 10]);
      doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
      named(doc, 'b').group = 'g1';
      named(doc, 'c').group = 'g1';

      expect(dropShapes(doc, idsOf(doc, 'b', 'c'), null, idOf(doc, 'a'))).toBe(true);
      expect(order(doc)).toEqual(['b', 'c', 'a']);
      expect(contiguous(doc)).toBe(true);
    });

    it('reorders inside a group without taking the shape out of it', () => {
      const doc = docOf(
        ['a', 0, 0, 10, 10],
        ['b', 20, 0, 10, 10],
        ['c', 40, 0, 10, 10],
        ['d', 60, 0, 10, 10],
      );
      doc.groups = [{ id: 'g1', name: 'three', parent: null }];
      for (const n of ['a', 'b', 'c']) named(doc, n).group = 'g1';

      expect(dropShapes(doc, idsOf(doc, 'c'), 'g1', idOf(doc, 'a'))).toBe(true);
      expect(order(doc)).toEqual(['c', 'a', 'b', 'd']);
      expect(named(doc, 'c').group).toBe('g1');
      expect(contiguous(doc)).toBe(true);
    });

    it('keeps every shape, and only those shapes', () => {
      const doc = flat();
      dropShapes(doc, idsOf(doc, 'c'), null, idOf(doc, 'a'));
      expect(order(doc).slice().sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('does nothing with nothing selected', () => {
      const doc = flat();
      expect(dropShapes(doc, new Set(), null, null)).toBe(false);
      expect(order(doc)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('undoes a drop in one step', () => {
      const doc = flat();
      const { store, commands } = editor(doc);
      const target = store.state.doc.shapes.find((sh) => sh.name === 'a')!.id;
      select(store, 'd');
      expect(commands.dropSelection(null, target)).toBe(true);
      expect(store.state.doc.shapes.map((sh) => sh.name)).toEqual(['d', 'a', 'b', 'c']);
      store.undo();
      expect(store.state.doc.shapes.map((sh) => sh.name)).toEqual(['a', 'b', 'c', 'd']);
    });
  });
});

describe('the commands', () => {
  it('counts a group as one thing to arrange', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10], ['c', 80, 0, 10, 10]);
    doc.groups = [{ id: 'g1', name: 'pair', parent: null }];
    named(doc, 'a').group = 'g1';
    named(doc, 'b').group = 'g1';
    const { store, commands } = editor(doc);
    select(store, 'a', 'b', 'c');
    expect(commands.arrangeCount).toBe(2);
  });

  it('declines to align one shape to the selection and says why', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10]);
    const { store, commands } = editor(doc);
    const said: string[] = [];
    commands.onMessage = (m) => said.push(m);
    select(store, 'a');
    expect(commands.alignShapes('left', 'selection')).toBe(false);
    expect(said[0]).toMatch(/two shapes/);
    expect(boxOf(store.state.doc, 'a').x0).toBe(0);
  });

  it('aligns one shape to the canvas', () => {
    const doc = docOf(['a', 3, 3, 10, 10]);
    doc.viewBox = { x: 0, y: 0, w: 100, h: 100 };
    const { store, commands } = editor(doc);
    select(store, 'a');
    expect(commands.alignShapes('right', 'canvas')).toBe(true);
    expect(boxOf(store.state.doc, 'a').x1).toBeCloseTo(100, 9);
  });

  it('declines to distribute two shapes', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 20, 0, 10, 10]);
    const { store, commands } = editor(doc);
    const said: string[] = [];
    commands.onMessage = (m) => said.push(m);
    select(store, 'a', 'b');
    expect(commands.distributeShapes('hcenter', 'selection')).toBe(false);
    expect(said[0]).toMatch(/three shapes/);
  });

  it('undoes an align in one step', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 40, 0, 10, 10], ['c', 80, 0, 10, 10]);
    const { store, commands } = editor(doc);
    select(store, 'a', 'b', 'c');
    const before = snapshot(store.state.doc);
    commands.alignShapes('left', 'selection');
    expect(boxOf(store.state.doc, 'c').x0).toBeCloseTo(0, 9);
    store.undo();
    expect(snapshot(store.state.doc)).toEqual(before);
  });

  /* `reorderSelection` argues this case and uses `tryEdit`; these three used
     `edit`, so three presses of Align Left filed three entries, two of them
     describing a document that did not change. The press still reports success:
     the shapes are where it was asked to put them. */
  it('files no history entry for an arrangement that moves nothing', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 40, 0, 10, 10], ['c', 80, 0, 10, 10]);
    const { store, commands } = editor(doc);
    select(store, 'a', 'b', 'c');

    expect(commands.alignShapes('left', 'selection')).toBe(true);
    const once = snapshot(store.state.doc);
    expect(commands.alignShapes('left', 'selection')).toBe(true);
    expect(commands.alignShapes('left', 'selection')).toBe(true);
    expect(snapshot(store.state.doc)).toEqual(once);

    store.undo();
    expect(boxOf(store.state.doc, 'c').x0).toBeCloseTo(80, 9);
    expect(store.canUndo).toBe(false);
  });

  it('files no entry for a distribute or a space that moves nothing', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 12, 0, 10, 10], ['c', 90, 0, 10, 10]);
    const { store, commands } = editor(doc);
    select(store, 'a', 'b', 'c');

    commands.distributeShapes('hcenter', 'selection');
    commands.distributeShapes('hcenter', 'selection');
    commands.spaceShapes('h', 'selection', 4);
    commands.spaceShapes('h', 'selection', 4);

    // Two arrangements, so two entries: one each, and none for the repeats.
    store.undo();
    store.undo();
    expect(boxOf(store.state.doc, 'b').x0).toBeCloseTo(12, 9);
    expect(store.canUndo).toBe(false);
  });

  it('treats an empty gap field as fill the frame', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 12, 0, 10, 10], ['c', 90, 0, 10, 10]);
    const { store, commands } = editor(doc);
    select(store, 'a', 'b', 'c');
    expect(commands.spaceShapes('h', 'selection', null)).toBe(true);
    const d = store.state.doc;
    expect(boxOf(d, 'b').x0 - boxOf(d, 'a').x1).toBeCloseTo(35, 9);
  });

  it('treats a half-typed number the same as an empty field', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 12, 0, 10, 10], ['c', 90, 0, 10, 10]);
    const { store, commands } = editor(doc);
    select(store, 'a', 'b', 'c');
    commands.spaceShapes('h', 'selection', Number.NaN);
    const d = store.state.doc;
    expect(boxOf(d, 'b').x0 - boxOf(d, 'a').x1).toBeCloseTo(35, 9);
  });

  it('ignores a node selection, which the node align owns', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 40, 0, 10, 10]);
    const { store, commands } = editor(doc);
    store.update((s) => {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
      const sh = s.doc.shapes[0];
      for (const n of sh.subpaths[0].nodes) s.selection.nodes.add(n.id);
    });
    expect(commands.arrangeCount).toBe(0);
  });
});

/**
 * The selection's box, typed rather than dragged.
 *
 * Measured on the box that comes back out, because that is the number the field
 * shows and the promise the control makes: type 40 into width and the selection
 * is 40 wide. Asserting on coordinates would pass for a shape whose nodes happen
 * to start at the corner being anchored.
 */
describe('the selection box as numbers', () => {
  const one = (): Doc => docOf(['a', 10, 20, 30, 40]);

  const bounds = (c: Commands): { x: number; y: number; w: number; h: number } => c.selectionBounds()!;

  it('reads the box of what is selected', () => {
    const { store, commands } = editor(one());
    select(store, 'a');
    expect(bounds(commands)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('reads nothing when nothing is selected', () => {
    const { commands } = editor(one());
    expect(commands.selectionBounds()).toBeNull();
  });

  it('moves the selection to a typed X, leaving its size and Y alone', () => {
    const { store, commands } = editor(one());
    select(store, 'a');
    expect(commands.setSelectionBound('x', 100)).toBe(true);
    expect(bounds(commands)).toEqual({ x: 100, y: 20, w: 30, h: 40 });
  });

  it('moves to a typed Y, including a negative one', () => {
    const { store, commands } = editor(one());
    select(store, 'a');
    commands.setSelectionBound('y', -5);
    expect(bounds(commands)).toEqual({ x: 10, y: -5, w: 30, h: 40 });
  });

  it('scales width about the left edge, leaving X, Y and height alone', () => {
    const { store, commands } = editor(one());
    select(store, 'a');
    expect(commands.setSelectionBound('w', 60)).toBe(true);
    const b = bounds(commands);
    expect(b.w).toBeCloseTo(60, 9);
    expect(b.x).toBeCloseTo(10, 9);
    expect(b.y).toBeCloseTo(20, 9);
    expect(b.h).toBeCloseTo(40, 9);
  });

  it('scales height about the top edge', () => {
    const { store, commands } = editor(one());
    select(store, 'a');
    commands.setSelectionBound('h', 10);
    const b = bounds(commands);
    expect(b.h).toBeCloseTo(10, 9);
    expect(b.y).toBeCloseTo(20, 9);
    expect(b.w).toBeCloseTo(30, 9);
  });

  /**
   * The reason the matrix is derived from the current box rather than composed
   * onto the last one. Transforms are baked (§5), so there is no stored size to
   * correct: setting the same width twice has to be a no-op the second time.
   */
  it('reaches the same size however many times it is set', () => {
    const { store, commands } = editor(one());
    select(store, 'a');
    for (const w of [60, 15, 60, 60, 7.5]) commands.setSelectionBound('w', w);
    expect(bounds(commands).w).toBeCloseTo(7.5, 9);
    expect(bounds(commands).x).toBeCloseTo(10, 9);
  });

  it('refuses a size of zero or less, and says so', () => {
    const { store, commands } = editor(one());
    const said: string[] = [];
    commands.onMessage = (m) => said.push(m);
    select(store, 'a');
    expect(commands.setSelectionBound('w', 0)).toBe(false);
    expect(commands.setSelectionBound('h', -3)).toBe(false);
    expect(said).toHaveLength(2);
    expect(bounds(commands)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('refuses to scale an axis the selection has no length on', () => {
    const doc = emptyDoc();
    const flat = shapeFromPath('M0 50 L100 50');
    flat.name = 'line';
    doc.shapes.push(flat);
    const { store, commands } = editor(doc);
    select(store, 'line');
    const said: string[] = [];
    commands.onMessage = (m) => said.push(m);
    expect(commands.setSelectionBound('h', 20)).toBe(false);
    expect(said[0]).toMatch(/no height/);
    // The other axis still works, so the refusal is about the flat side only.
    expect(commands.setSelectionBound('w', 50)).toBe(true);
    expect(bounds(commands).w).toBeCloseTo(50, 9);
  });

  it('refuses with nothing selected, and says so', () => {
    const { commands } = editor(one());
    const said: string[] = [];
    commands.onMessage = (m) => said.push(m);
    expect(commands.setSelectionBound('x', 5)).toBe(false);
    expect(said[0]).toMatch(/Nothing is selected/);
  });

  it('leaves no undo entry when it refuses', () => {
    const { store, commands } = editor(one());
    select(store, 'a');
    commands.setSelectionBound('x', 100);
    commands.setSelectionBound('w', 0);
    store.undo();
    expect(bounds(commands)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('moves only the selected shape', () => {
    const doc = docOf(['a', 0, 0, 10, 10], ['b', 50, 50, 10, 10]);
    const { store, commands } = editor(doc);
    select(store, 'a');
    commands.setSelectionBound('x', 30);
    expect(boxOf(store.state.doc, 'b')).toEqual({ x0: 50, y0: 50, x1: 60, y1: 60 });
  });

  /**
   * With nodes selected the box is the nodes' box, and typing into it moves
   * those nodes. That is the typed form of dragging the box handles, which move
   * the selected nodes and not the shapes around them.
   */
  it('moves the selected nodes when the selection is nodes', () => {
    const doc = emptyDoc();
    const sh = shapeFromPath('M0 0 L10 0 L10 10 L0 10 Z');
    sh.name = 'quad';
    doc.shapes.push(sh);
    const { store, commands } = editor(doc);
    store.update((s) => {
      s.selection.shapes.clear();
      const nodes = s.doc.shapes[0].subpaths[0].nodes;
      s.selection.nodes.add(nodes[0].id);
      s.selection.nodes.add(nodes[1].id);
    });
    expect(bounds(commands)).toEqual({ x: 0, y: 0, w: 10, h: 0 });
    commands.setSelectionBound('y', 4);
    // The two moved nodes are on y = 4; the other two are where they were.
    const ys = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt[1]);
    expect(ys).toEqual([4, 4, 10, 10]);
  });
});

/**
 * The gap a drop aims at, when the row that owns it is itself being dragged.
 *
 * `dropShapes` takes its index in the rows that are STAYING, which is right --
 * counting in the whole list puts a row dragged downward one place short. But it
 * means the key it is given has to be a row that stays. The shape list passed
 * the row at the gap whether or not that row was one of the lifted ones, so
 * `findIndex` returned -1 and the not-found fallback landed the selection at the
 * end of the list.
 *
 * These pin `dropShapes`' half of the contract: a `before` naming a moving row
 * is the caller's mistake, so the caller is where the fix went, and these say
 * what the function does with a key that IS still there.
 */
describe('dropping before a row that stays', () => {
  const four = (): Doc => {
    const doc = emptyDoc();
    for (const n of ['A', 'B', 'C', 'D']) doc.shapes.push(shapeFromPath('M0 0 L1 1', n));
    return doc;
  };
  const order = (d: Doc): string => d.shapes.map((s) => s.name).join('');
  const idOf = (d: Doc, n: string): string => d.shapes.find((s) => s.name === n)!.id;

  it('puts the selection before the named row', () => {
    const d = four();
    dropShapes(d, new Set([idOf(d, 'D')]), null, idOf(d, 'B'));
    expect(order(d)).toBe('ADBC');
  });

  it('puts it at the end when the gap is past the last row', () => {
    const d = four();
    dropShapes(d, new Set([idOf(d, 'A')]), null, null);
    expect(order(d)).toBe('BCDA');
  });

  it('moves a multi-row selection together, keeping their order', () => {
    const d = four();
    dropShapes(d, new Set([idOf(d, 'A'), idOf(d, 'C')]), null, idOf(d, 'D'));
    expect(order(d)).toBe('BACD');
  });

  /* The shape of the bug, stated against the function rather than the caller:
     a key that names nothing among the staying rows is the case whose fallback
     was silently reached. It still falls back -- that is the honest answer for
     a key it cannot place -- and the caller no longer produces one. */
  it('falls back to the end for a key that is not among the rows staying', () => {
    const d = four();
    dropShapes(d, new Set([idOf(d, 'B')]), null, idOf(d, 'B'));
    expect(order(d)).toBe('ACDB');
  });
});
