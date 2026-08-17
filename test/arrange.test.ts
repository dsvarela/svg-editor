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
