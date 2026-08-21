/** @vitest-environment jsdom */
/**
 * Groups: the relation, the invariant, and the round trip.
 *
 * A group is a named set of shapes exported as one `<g>`. It carries no transform,
 * because §5 bakes transforms into coordinates and a group holding one would be the
 * hidden coordinate system §5 exists to refuse.
 *
 * Which shapes a group holds is read off `Shape.group` and never written on the
 * group, so there is one statement of the relation. What that costs is an invariant:
 * a group's shapes have to be **contiguous** in `doc.shapes`, because a `<g>` holds
 * its children contiguously and `doc.shapes` is the paint order. §49 of
 * `docs/ARCHITECTURE.md` has the argument.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { Commands } from '../src/tools/commands';
import {
  emptyDoc,
  groupChain,
  groupWithin,
  pruneGroups,
  shapeFromPath,
  shapesInGroup,
} from '../src/model/doc';
import { reorderShapes } from '../src/model/arrange';
import { exportSvg, importSvg } from '../src/io/svg';
import type { Doc } from '../src/core/types';

function editor(
  count = 3,
  busy = false,
): { store: Store; commands: Commands; said: () => { message: string; ok: boolean } | null } {
  const doc = emptyDoc();
  for (let i = 0; i < count; i++) {
    const sh = shapeFromPath(`M${i * 20} 0 L${i * 20 + 10} 0 L${i * 20 + 10} 10 Z`);
    sh.name = `s${i}`;
    doc.shapes.push(sh);
  }
  const store = new Store(doc);
  const commands = new Commands(store, () => busy);
  let last: { message: string; ok: boolean } | null = null;
  commands.onMessage = (message, ok) => (last = { message, ok });
  return { store, commands, said: () => last };
}

const names = (doc: Doc): string[] => doc.shapes.map((sh) => sh.name);
const select = (store: Store, ...which: string[]): void =>
  store.update((s) => {
    s.selection.shapes.clear();
    for (const sh of s.doc.shapes) if (which.includes(sh.name)) s.selection.shapes.add(sh.id);
  });

/**
 * Whether every group's shapes sit in one unbroken run of `doc.shapes`.
 *
 * The invariant the whole design rests on, asserted as a property rather than as a
 * particular order: a group whose shapes are scattered cannot be written as one
 * `<g>` without changing what is painted on top of what.
 */
function contiguous(doc: Doc): boolean {
  for (const g of doc.groups ?? []) {
    const at = doc.shapes.map((sh, i) => (groupWithin(doc, sh.group, g.id) ? i : -1)).filter((i) => i >= 0);
    if (!at.length) continue;
    if (at[at.length - 1] - at[0] !== at.length - 1) return false;
  }
  return true;
}

describe('grouping', () => {
  it('refuses fewer than two shapes', () => {
    const { store, commands, said } = editor();
    expect(commands.groupSelection()).toBe(false);
    select(store, 's0');
    expect(commands.groupSelection()).toBe(false);
    expect(store.state.doc.groups ?? []).toHaveLength(0);
    expect(said()).toEqual({ message: 'Group needs two or more shapes selected.', ok: false });
  });

  it('puts the selected shapes in one group', () => {
    const { store, commands, said } = editor();
    select(store, 's0', 's1');
    expect(commands.groupSelection()).toBe(true);
    const doc = store.state.doc;
    expect(doc.groups).toHaveLength(1);
    expect(shapesInGroup(doc, doc.groups![0].id).map((sh) => sh.name)).toEqual(['s0', 's1']);
    expect(contiguous(doc)).toBe(true);
    expect(said()).toEqual({ message: 'Grouped 2 shapes.', ok: true });
  });

  it('counts what it grouped rather than what was in the document', () => {
    // Four shapes, three of them selected. A count read from the wrong array
    // gives 4 and every other assertion here still passes.
    const { store, commands, said } = editor(4);
    select(store, 's0', 's1', 's2');
    expect(commands.groupSelection()).toBe(true);
    expect(said()!.message).toBe('Grouped 3 shapes.');
  });

  /* The reordering, which is the part that is not optional. Grouping the outermost
     two of three leaves them adjacent, at the position the topmost of them had. */
  it('brings shapes together in the paint order, at the topmost of them', () => {
    const { store, commands } = editor();
    select(store, 's0', 's2');
    commands.groupSelection();
    const doc = store.state.doc;
    expect(names(doc)).toEqual(['s1', 's0', 's2']);
    expect(contiguous(doc)).toBe(true);
  });

  it('keeps their order among themselves', () => {
    const { store, commands } = editor(4);
    select(store, 's0', 's2', 's3');
    commands.groupSelection();
    expect(names(store.state.doc)).toEqual(['s1', 's0', 's2', 's3']);
  });

  /* Two shapes that are already together in one group make a group inside it, not a
     break-out. Grouping part of a group and having the outer group fall apart is the
     answer nobody wants. */
  it('nests when everything selected is already in the same group', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1', 's2');
    commands.groupSelection();
    const outer = store.state.doc.groups![0].id;

    select(store, 's0', 's1');
    commands.groupSelection();
    const doc = store.state.doc;
    expect(doc.groups).toHaveLength(2);
    const inner = doc.groups!.find((g) => g.id !== outer)!;
    expect(inner.parent).toBe(outer);
    expect(shapesInGroup(doc, outer).map((sh) => sh.name).sort()).toEqual(['s0', 's1', 's2']);
    expect(shapesInGroup(doc, inner.id).map((sh) => sh.name).sort()).toEqual(['s0', 's1']);
    expect(contiguous(doc)).toBe(true);
  });

  it('goes to the top when the selection spans two different groups', () => {
    const { store, commands } = editor(4);
    select(store, 's0', 's1');
    commands.groupSelection();
    select(store, 's2', 's3');
    commands.groupSelection();
    select(store, 's1', 's2');
    commands.groupSelection();
    const doc = store.state.doc;
    const outermost = doc.groups!.filter((g) => g.parent === null);
    expect(outermost.length).toBeGreaterThanOrEqual(1);
    expect(contiguous(doc)).toBe(true);
  });
});

describe('ungrouping', () => {
  it('takes the shapes out and drops the group', () => {
    const { store, commands, said } = editor();
    select(store, 's0', 's1');
    commands.groupSelection();
    expect(commands.ungroupSelection()).toBe(true);
    expect(store.state.doc.groups ?? []).toHaveLength(0);
    expect(store.state.doc.shapes.every((sh) => !sh.group)).toBe(true);
    expect(said()).toEqual({ message: 'Ungrouped.', ok: true });
  });

  it('counts the groups it freed when there is more than one', () => {
    /* Two groups, one press. The plain `Ungrouped.` is the singular branch, and
       a selection spanning two groups is the only fixture that separates them. */
    const { store, commands, said } = editor(4);
    select(store, 's0', 's1');
    commands.groupSelection();
    select(store, 's2', 's3');
    commands.groupSelection();

    select(store, 's0', 's2');
    expect(commands.ungroupSelection()).toBe(true);
    expect(said()).toEqual({ message: 'Ungrouped 2 groups.', ok: true });
    expect(store.state.doc.shapes.every((sh) => !sh.group)).toBe(true);
  });

  /* One level per press, so two presses unwrap two levels. Flattening everything at
     once would make nesting a thing you can build and not a thing you can take back
     a step at a time. */
  it('unwraps one level at a time', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1', 's2');
    commands.groupSelection();
    select(store, 's0', 's1');
    commands.groupSelection();
    expect(store.state.doc.groups).toHaveLength(2);

    select(store, 's0', 's1');
    commands.ungroupSelection();
    const doc = store.state.doc;
    expect(doc.groups).toHaveLength(1);
    // Still in the outer one.
    expect(doc.shapes.filter((sh) => sh.group).map((sh) => sh.name).sort()).toEqual(['s0', 's1', 's2']);
  });

  it('refuses when nothing selected is in a group', () => {
    const { store, commands, said } = editor();
    select(store, 's0', 's1');
    expect(commands.ungroupSelection()).toBe(false);
    expect(said()).toEqual({ message: 'Nothing selected is in a group.', ok: false });
  });

  it('says something different when nothing is selected at all', () => {
    // Two refusals behind one `false`, and only the sentence tells you which
    // of "you picked the wrong thing" and "you picked nothing" you are in.
    const { commands, said } = editor();
    expect(commands.ungroupSelection()).toBe(false);
    expect(said()).toEqual({ message: 'Ungroup needs a shape selected.', ok: false });
  });

  it('moves nothing in the paint order', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's2');
    commands.groupSelection();
    const before = names(store.state.doc);
    select(store, 's0', 's2');
    commands.ungroupSelection();
    expect(names(store.state.doc)).toEqual(before);
  });
});

describe('a group that holds nothing', () => {
  /* Swept in `Store.edit`, not at each of the eight places that remove shapes. A
     group naming nothing shows as an empty row and writes an empty `<g>`. */
  it('goes when its last shape is deleted', () => {
    const { store, commands } = editor();
    select(store, 's0', 's1');
    commands.groupSelection();
    expect(store.state.doc.groups).toHaveLength(1);
    store.edit((s) => {
      s.doc.shapes = s.doc.shapes.filter((sh) => sh.name === 's2');
    });
    expect(store.state.doc.groups ?? []).toHaveLength(0);
  });

  it('takes an empty group above it with it', () => {
    const doc = emptyDoc();
    doc.groups = [
      { id: 'g-outer', name: 'outer', parent: null },
      { id: 'g-inner', name: 'inner', parent: 'g-outer' },
    ];
    pruneGroups(doc);
    expect(doc.groups).toHaveLength(0);
  });

  it('frees a shape whose group has gone rather than leaving a dangling id', () => {
    const doc = emptyDoc();
    const sh = shapeFromPath('M0 0 L10 0 L10 10 Z');
    sh.group = 'g-missing';
    doc.shapes.push(sh);
    doc.groups = [];
    pruneGroups(doc);
    expect(doc.shapes[0].group).toBe(null);
  });

  /* A parent cycle is a bug whichever way it arrives; what matters is that reading
     the chain terminates rather than hanging the page. */
  it('does not hang on a cycle in the parent chain', () => {
    const doc = emptyDoc();
    doc.groups = [
      { id: 'a', name: 'a', parent: 'b' },
      { id: 'b', name: 'b', parent: 'a' },
    ];
    expect(groupChain(doc, 'a').length).toBeLessThanOrEqual(3);
    expect(groupWithin(doc, 'a', 'zzz')).toBe(false);
  });
});

describe('writing and reading groups', () => {
  it('writes a group as one g holding its shapes', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1');
    commands.groupSelection();
    const svg = exportSvg(store.state.doc);
    expect((svg.match(/<g\b/g) ?? [])).toHaveLength(1);
    expect((svg.match(/<\/g>/g) ?? [])).toHaveLength(1);
    // Two paths inside the group, one outside it.
    const inside = svg.slice(svg.indexOf('<g'), svg.indexOf('</g>'));
    expect((inside.match(/<path/g) ?? [])).toHaveLength(2);
  });

  it('writes nested groups nested', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1', 's2');
    commands.groupSelection();
    select(store, 's0', 's1');
    commands.groupSelection();
    const svg = exportSvg(store.state.doc);
    expect((svg.match(/<g\b/g) ?? [])).toHaveLength(2);
    // The inner opens after the outer and closes before it.
    const firstOpen = svg.indexOf('<g');
    const secondOpen = svg.indexOf('<g', firstOpen + 1);
    const firstClose = svg.indexOf('</g>');
    expect(secondOpen).toBeGreaterThan(firstOpen);
    expect(firstClose).toBeGreaterThan(secondOpen);
  });

  /**
   * Every `<g>` the export opens, it closes.
   *
   * Counting opens and checking the order of the first few does not reach the
   * loop that closes whatever is still open when the shapes run out. Found by
   * mutation on 2026-08-21: `for (let i = open.length - 1; i >= 0; i--)` in
   * `exportSvg` narrowed to `i > 0` drops the outermost `</g>`, and every test
   * in this file stayed green while the export wrote XML no parser accepts.
   *
   * The last shape has to be **inside** a group for that loop to run at all,
   * which the two tests above never arrange: the first leaves an ungrouped
   * shape last, so the close happens on the way past it instead.
   */
  const depth = (svg: string): { balanced: boolean; deepest: number } => {
    let d = 0;
    let deepest = 0;
    let balanced = true;
    for (const tag of svg.match(/<\/?g\b/g) ?? []) {
      d += tag === '</g' ? -1 : 1;
      if (d < 0) balanced = false;
      deepest = Math.max(deepest, d);
    }
    return { balanced: balanced && d === 0, deepest };
  };

  it('closes every g when the last shape is inside one', () => {
    const { store, commands } = editor(3);
    // s1 and s2 grouped, so the run reaches the end of the paint order.
    select(store, 's1', 's2');
    commands.groupSelection();
    const svg = exportSvg(store.state.doc);
    expect((svg.match(/<g\b/g) ?? [])).toHaveLength(1);
    expect(depth(svg)).toEqual({ balanced: true, deepest: 1 });
  });

  it('closes both when the last shape is inside a nested pair', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1', 's2');
    commands.groupSelection();
    select(store, 's1', 's2');
    commands.groupSelection();
    const svg = exportSvg(store.state.doc);
    expect(depth(svg)).toEqual({ balanced: true, deepest: 2 });
  });

  it('reads back what it wrote when the last shape is grouped', () => {
    /* The balance check above is about the text. This is about whether a parser
       agrees: an unclosed `<g>` is a file that will not reopen. */
    const { store, commands } = editor(3);
    select(store, 's1', 's2');
    commands.groupSelection();
    const back = importSvg(exportSvg(store.state.doc));
    expect(back.warnings).toEqual([]);
    expect(back.shapes).toHaveLength(3);
    expect(back.groups).toHaveLength(1);
    const held = back.shapes.filter((s) => s.group === back.groups![0].id);
    expect(held).toHaveLength(2);
  });

  it('writes no g at all when nothing is grouped', () => {
    const { store } = editor(2);
    expect(exportSvg(store.state.doc)).not.toContain('<g');
  });

  it('carries the group name as the g id', () => {
    const { store, commands } = editor(2);
    select(store, 's0', 's1');
    commands.groupSelection();
    store.edit((s) => (s.doc.groups![0].name = 'badge'));
    expect(exportSvg(store.state.doc)).toContain('<g id="badge">');
  });

  it('reads a g back as a group', () => {
    const r = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g id="pair"><path d="M0 0 H10 V10 Z"/><path d="M20 0 H30 V10 Z"/></g>
        <path d="M40 0 H50 V10 Z"/>
      </svg>`,
    );
    expect(r.shapes).toHaveLength(3);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].name).toBe('pair');
    expect(r.shapes.filter((sh) => sh.group === r.groups[0].id)).toHaveLength(2);
    expect(r.shapes[2].group).toBeUndefined();
  });

  it('reads nested groups as nested', () => {
    const r = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g id="outer"><g id="inner"><path d="M0 0 H10 V10 Z"/></g><path d="M20 0 H30 V10 Z"/></g>
      </svg>`,
    );
    const outer = r.groups.find((g) => g.name === 'outer')!;
    const inner = r.groups.find((g) => g.name === 'inner')!;
    expect(inner.parent).toBe(outer.id);
    expect(outer.parent).toBe(null);
  });

  /* The outer `<svg>` is not a group. Wrapping the whole drawing in one would put a
     row in the list that nobody made and that ungrouping cannot usefully undo. */
  it('does not make a group out of the root svg', () => {
    const r = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0 H10 V10 Z"/></svg>`,
    );
    expect(r.groups).toHaveLength(0);
  });

  it('drops a g that held nothing readable', () => {
    const r = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
        <g id="empty"><text>hello</text></g><path d="M0 0 H10 V10 Z"/>
      </svg>`,
    );
    expect(r.groups).toHaveLength(0);
  });

  /* A group's transform still lands in the coordinates, per §5. What survives the
     round trip is which shapes belong together, and not a matrix above them. */
  it('bakes a group transform into the shapes and keeps the grouping', () => {
    const r = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g id="moved" transform="translate(10 5)"><path d="M0 0 H10 V10 Z"/><path d="M20 0 H30 V10 Z"/></g>
      </svg>`,
    );
    expect(r.groups).toHaveLength(1);
    expect(r.shapes[0].subpaths[0].nodes[0].pt).toEqual([10, 5]);
    expect(exportSvg({ shapes: r.shapes, groups: r.groups, viewBox: { x: 0, y: 0, w: 100, h: 100 } }))
      .not.toContain('transform');
  });

  it('round-trips a grouped document through export and import', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1');
    commands.groupSelection();
    store.edit((s) => (s.doc.groups![0].name = 'pair'));

    const again = importSvg(exportSvg(store.state.doc));
    expect(again.shapes).toHaveLength(3);
    expect(again.groups).toHaveLength(1);
    expect(again.groups[0].name).toBe('pair');
    expect(again.shapes.filter((sh) => sh.group).length).toBe(2);
  });
});

describe('history', () => {
  it('takes grouping back', () => {
    const { store, commands } = editor();
    select(store, 's0', 's1');
    commands.groupSelection();
    expect(store.state.doc.groups).toHaveLength(1);
    store.undo();
    expect(store.state.doc.groups ?? []).toHaveLength(0);
    expect(store.state.doc.shapes.every((sh) => !sh.group)).toBe(true);
  });

  it('takes the reordering back with it', () => {
    const { store, commands } = editor(3);
    const before = names(store.state.doc);
    select(store, 's0', 's2');
    commands.groupSelection();
    expect(names(store.state.doc)).not.toEqual(before);
    store.undo();
    expect(names(store.state.doc)).toEqual(before);
  });

  it('takes ungrouping back', () => {
    const { store, commands } = editor();
    select(store, 's0', 's1');
    commands.groupSelection();
    const id = store.state.doc.groups![0].id;
    select(store, 's0', 's1');
    commands.ungroupSelection();
    store.undo();
    expect(store.state.doc.groups?.map((g) => g.id)).toEqual([id]);
  });
});

/**
 * Copies, and the invariant they could break.
 *
 * `paste` and `duplicateSelection` both append to the end of `doc.shapes`, and
 * `cloneShape` carries `Shape.group` through -- so a copy of a shape from a group in
 * the middle of the stack would land at the end still claiming to be in that group,
 * with the group's run broken in two. The export would then have to open the same
 * group twice, which is not one group.
 */
describe('a copy of something in a group', () => {
  it('leaves every group in one run after a duplicate', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1');
    commands.groupSelection();
    select(store, 's0');
    expect(commands.duplicateSelection()).toBe(true);
    expect(contiguous(store.state.doc)).toBe(true);
  });

  it('leaves every group in one run after a paste', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1');
    commands.groupSelection();
    select(store, 's0');
    commands.copySelection();
    commands.paste();
    expect(contiguous(store.state.doc)).toBe(true);
  });

  it('writes one g per group however many copies were made', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1');
    commands.groupSelection();
    select(store, 's0');
    commands.duplicateSelection();
    commands.copySelection();
    commands.paste();
    const svg = exportSvg(store.state.doc);
    expect(svg.match(/<g\b/g) ?? []).toHaveLength(1);
    expect(svg.match(/<\/g>/g) ?? []).toHaveLength(1);
  });
});

/**
 * Getting back from a shape to the group it is in.
 *
 * A click on the canvas selects the shape, never the group, which is what makes
 * one shape inside a group nudgeable and is deliberately not Illustrator's
 * default. The cost was that the group had no canvas-side handle at all: the
 * only way to select one was its row in the list.
 *
 * The level is derived from the selection rather than remembered, so these check
 * the same press twice in a row goes two levels out, and that arriving at a
 * selection by hand behaves the same as arriving at it by pressing.
 */
describe('selecting the group a shape is in', () => {
  /** The names of the selected shapes, sorted so the assertion is about the set. */
  const picked = (store: Store): string[] =>
    store.state.doc.shapes
      .filter((sh) => store.state.selection.shapes.has(sh.id))
      .map((sh) => sh.name)
      .sort();

  it('refuses with nothing selected', () => {
    const { commands, said } = editor();
    expect(commands.selectGroup()).toBe(false);
    expect(said()).toEqual({ message: 'Select group needs a shape selected.', ok: false });
  });

  it('refuses when the selection is in no group', () => {
    const { store, commands, said } = editor();
    select(store, 's0');
    expect(commands.selectGroup()).toBe(false);
    expect(picked(store)).toEqual(['s0']);
    expect(said()).toEqual({ message: 'Nothing selected is in a group.', ok: false });
  });

  it('refuses mid-drag, because widening hands the gesture shapes it never took', () => {
    const { store, commands, said } = editor(3, true);
    select(store, 's0', 's1');
    expect(commands.groupSelection()).toBe(true);
    select(store, 's0');
    expect(commands.selectGroup()).toBe(false);
    expect(picked(store)).toEqual(['s0']);
    expect(said()).toEqual({ message: 'Finish the drag first.', ok: false });
  });

  it('widens one shape to the whole group', () => {
    const { store, commands, said } = editor();
    select(store, 's0', 's1');
    commands.groupSelection();
    select(store, 's0');
    expect(commands.selectGroup()).toBe(true);
    expect(picked(store)).toEqual(['s0', 's1']);
    expect(said()).toEqual({ message: 'Selected the group: 2 shapes.', ok: true });
  });

  it('goes one level further out on the next press', () => {
    const { store, commands, said } = editor(3);
    /* Outer first, then a subset of it: that is the only way to nest here.
       `groupSelection` nests when every chosen shape is already in one group
       together, and otherwise puts the new group at the top -- so grouping the
       inner pair first and the three second flattens the pair rather than
       wrapping it. */
    select(store, 's0', 's1', 's2');
    commands.groupSelection();
    select(store, 's0', 's1');
    commands.groupSelection();

    select(store, 's0');
    expect(commands.selectGroup()).toBe(true);
    expect(picked(store)).toEqual(['s0', 's1']);
    expect(commands.selectGroup()).toBe(true);
    expect(picked(store)).toEqual(['s0', 's1', 's2']);
    // And there is nowhere left to go. A different sentence from the refusal
    // above: this one means you are already at the top, not that there is no
    // group to find.
    expect(commands.selectGroup()).toBe(false);
    expect(picked(store)).toEqual(['s0', 's1', 's2']);
    expect(said()).toEqual({ message: 'That is already the whole group.', ok: false });
  });

  /* The level is read off the selection, so how you arrived at it cannot
     matter. A stored level is exactly what would make these two disagree. */
  it('does not care how the selection was arrived at', () => {
    const { store, commands } = editor(3);
    select(store, 's0', 's1', 's2');
    commands.groupSelection();
    select(store, 's0', 's1');
    commands.groupSelection();

    select(store, 's0', 's1');
    expect(commands.selectGroup()).toBe(true);
    expect(picked(store)).toEqual(['s0', 's1', 's2']);
  });

  it('takes no undo step, because it edits nothing', () => {
    const { store, commands } = editor();
    select(store, 's0', 's1');
    commands.groupSelection();
    const before = store.canUndo;
    select(store, 's0');
    commands.selectGroup();
    expect(store.canUndo).toBe(before);
    /* Undoing once has to land on the pre-group document, not on a selection
       change that got its own entry. */
    store.undo();
    expect(store.state.doc.groups ?? []).toHaveLength(0);
  });

  it('drops the node selection, which was about the shapes you had', () => {
    const { store, commands } = editor();
    select(store, 's0', 's1');
    commands.groupSelection();
    select(store, 's0');
    store.update((s) => {
      const sh = s.doc.shapes.find((x) => x.name === 's0')!;
      s.selection.nodes.add(sh.subpaths[0].nodes[0].id);
    });
    commands.selectGroup();
    expect(store.state.selection.nodes.size).toBe(0);
  });

  it('says whether it would do anything, for the button', () => {
    const { store, commands } = editor();
    expect(commands.canSelectGroup).toBe(false);
    select(store, 's0', 's1');
    commands.groupSelection();
    select(store, 's0');
    expect(commands.canSelectGroup).toBe(true);
    commands.selectGroup();
    expect(commands.canSelectGroup).toBe(false);
  });
});

/**
 * §49's contiguity, as something the store restores rather than something each
 * operation remembers.
 *
 * The invariant was held by asking every operation that writes `doc.shapes` to
 * preserve it. `groupSelection` did not: grouping a loose shape with one taken
 * from the middle of a group split that group into two runs, and `exportSvg`
 * wrote it as two `<g>` elements under two different ids. These measure the
 * property directly -- for every group, are its shapes an unbroken run -- rather
 * than measuring any one operation's arithmetic.
 */
describe('a group is always one run', () => {
  /**
   * Every group whose shapes are not one unbroken run in paint order.
   *
   * The whole subtree, not the shapes whose `group` names it directly: a nested
   * group's shapes sit *between* its parent's own, which is what one `<g>` per
   * group looks like written out. Counting only direct members calls that
   * correct nesting a break.
   */
  const broken = (doc: Doc): string[] =>
    (doc.groups ?? [])
      .filter((g) => {
        const mine = new Set(shapesInGroup(doc, g.id).map((s) => s.id));
        const ix = doc.shapes.flatMap((s, i) => (mine.has(s.id) ? [i] : []));
        return ix.length > 0 && ix[ix.length - 1] - ix[0] + 1 !== ix.length;
      })
      .map((g) => g.id);

  const four = (): { store: Store; commands: Commands } => {
    const doc = emptyDoc();
    for (const n of ['s0', 's1', 's2', 's3']) doc.shapes.push(shapeFromPath('M0 0 L1 1', n));
    const store = new Store(doc);
    return { store, commands: new Commands(store, () => false) };
  };
  const pick = (store: Store, ...names: string[]): void =>
    store.update((s) => {
      s.selection.shapes.clear();
      for (const n of names) {
        const sh = s.doc.shapes.find((x) => x.name === n);
        if (sh) s.selection.shapes.add(sh.id);
      }
    });

  it('survives grouping a loose shape with one from the middle of a group', () => {
    const { store, commands } = four();
    pick(store, 's1', 's2', 's3');
    commands.groupSelection();
    expect(broken(store.state.doc)).toEqual([]);

    pick(store, 's0', 's2');
    commands.groupSelection();
    expect(broken(store.state.doc)).toEqual([]);
  });

  it('writes one <g> per group, so a round trip keeps the count', () => {
    const { store, commands } = four();
    pick(store, 's1', 's2', 's3');
    commands.groupSelection();
    pick(store, 's0', 's2');
    commands.groupSelection();

    const svg = exportSvg(store.state.doc, { decimals: 3 });
    expect((svg.match(/<g\b/g) ?? []).length).toBe(store.state.doc.groups?.length ?? 0);
  });

  it('survives grouping across a nested group', () => {
    const { store, commands } = four();
    pick(store, 's0', 's1', 's2', 's3');
    commands.groupSelection();
    pick(store, 's1', 's2');
    commands.groupSelection();
    expect(broken(store.state.doc)).toEqual([]);

    pick(store, 's0', 's2');
    commands.groupSelection();
    expect(broken(store.state.doc)).toEqual([]);
  });
});

/**
 * A reorder never loses a shape, whatever shape the group tree is in.
 *
 * `flattenOrders` walks from the root, so a shape under a group whose `parent`
 * names nothing -- or under two groups naming each other -- sat in the map under
 * a key the walk never visited and was dropped from the document, with the
 * operation reporting success. A workspace file can carry both, so this is
 * reachable without any editing mistake.
 */
describe('a reorder is total', () => {
  const withParent = (parent: string): Doc => {
    const doc = emptyDoc();
    for (const n of ['s0', 's1', 's2']) doc.shapes.push(shapeFromPath('M0 0 L1 1', n));
    doc.shapes[0].group = 'g1';
    doc.groups = [{ id: 'g1', name: 'g', parent }];
    return doc;
  };
  const names = (d: Doc): string[] => d.shapes.map((s) => s.name).sort();

  it('keeps every shape when a group points at a group that is not there', () => {
    const doc = withParent('gone');
    reorderShapes(doc, new Set([doc.shapes[1].id]), 'front');
    expect(names(doc)).toEqual(['s0', 's1', 's2']);
  });

  it('keeps every shape when two groups point at each other', () => {
    const doc = withParent('g2');
    doc.groups!.push({ id: 'g2', name: 'h', parent: 'g1' });
    reorderShapes(doc, new Set([doc.shapes[1].id]), 'front');
    expect(names(doc)).toEqual(['s0', 's1', 's2']);
  });
});
