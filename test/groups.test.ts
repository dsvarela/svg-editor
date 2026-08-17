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
import { exportSvg, importSvg } from '../src/io/svg';
import type { Doc } from '../src/core/types';

function editor(count = 3): { store: Store; commands: Commands } {
  const doc = emptyDoc();
  for (let i = 0; i < count; i++) {
    const sh = shapeFromPath(`M${i * 20} 0 L${i * 20 + 10} 0 L${i * 20 + 10} 10 Z`);
    sh.name = `s${i}`;
    doc.shapes.push(sh);
  }
  const store = new Store(doc);
  return { store, commands: new Commands(store, () => false) };
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
    const { store, commands } = editor();
    expect(commands.groupSelection()).toBe(false);
    select(store, 's0');
    expect(commands.groupSelection()).toBe(false);
    expect(store.state.doc.groups ?? []).toHaveLength(0);
  });

  it('puts the selected shapes in one group', () => {
    const { store, commands } = editor();
    select(store, 's0', 's1');
    expect(commands.groupSelection()).toBe(true);
    const doc = store.state.doc;
    expect(doc.groups).toHaveLength(1);
    expect(shapesInGroup(doc, doc.groups![0].id).map((sh) => sh.name)).toEqual(['s0', 's1']);
    expect(contiguous(doc)).toBe(true);
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
    const { store, commands } = editor();
    select(store, 's0', 's1');
    commands.groupSelection();
    expect(commands.ungroupSelection()).toBe(true);
    expect(store.state.doc.groups ?? []).toHaveLength(0);
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
    const { store, commands } = editor();
    select(store, 's0', 's1');
    expect(commands.ungroupSelection()).toBe(false);
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
