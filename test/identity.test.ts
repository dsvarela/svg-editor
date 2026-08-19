/**
 * One invariant: no two nodes in a document share an id.
 *
 * A selection holds `PathNode.id`s and `resolveNodes` finds them by walking the
 * whole document, so an id that appears twice is two nodes that can never be
 * selected apart. Dragging one then moves both, which reads as the drawing
 * having a mind of its own rather than as an identity collision.
 *
 * Swept over every operation that puts a copy of a node into the live document,
 * rather than asserted once about one of them: `cloneShape` and `cloneNode`
 * preserve ids on purpose, because that is what makes a selection survive a
 * history snapshot, and the same functions are what an operation reaches for
 * when it needs a second live copy. Nothing about their signatures says which
 * of the two you are doing. §46 of `docs/ARCHITECTURE.md` has the argument.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { Commands } from '../src/tools/commands';
import { dedupeIds, emptyDoc, emptySelection, findShape, nextId, reserveIds, resolveNodes, shapeFromPath } from '../src/model/doc';
import { nodeIdAt } from './helpers';
import { breakAt } from '../src/model/ops';
import type { Doc } from '../src/core/types';

/** Every node id that names more than one node, with how many it names. */
function collisions(doc: Doc): [string, number][] {
  const seen = new Map<string, number>();
  for (const sh of doc.shapes) {
    for (const sp of sh.subpaths) {
      for (const n of sp.nodes) seen.set(n.id, (seen.get(n.id) ?? 0) + 1);
    }
  }
  return [...seen].filter(([, count]) => count > 1);
}

const SQUARE = 'M10 10 L40 10 L40 40 L10 40 Z';
const OPEN = 'M10 10 L40 10 L40 40 L70 40';

function editor(...paths: string[]): { store: Store; commands: Commands } {
  const doc = emptyDoc();
  for (const d of paths) doc.shapes.push(shapeFromPath(d));
  const store = new Store(doc);
  return { store, commands: new Commands(store, () => false) };
}

describe('breaking a path', () => {
  it('gives the closed path it opened two ends that can be told apart', () => {
    const sp = shapeFromPath(SQUARE).subpaths[0];
    const pieces = breakAt(sp, 1);
    expect(pieces).not.toBeNull();
    const ids = pieces!.flatMap((p) => p.nodes.map((n) => n.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives the two halves of an open path ends that can be told apart', () => {
    const sp = shapeFromPath(OPEN).subpaths[0];
    const pieces = breakAt(sp, 1);
    expect(pieces).not.toBeNull();
    const ids = pieces!.flatMap((p) => p.nodes.map((n) => n.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  /* The invariant said as the symptom rather than as a property, because the
     property can hold while the document is still wrong -- and this is the thing
     a person would report. */
  it('leaves each new end selectable on its own', () => {
    const { store, commands } = editor(SQUARE);
    const doc = store.state.doc;
    store.update((s) => s.selection.nodes.add(nodeIdAt(doc, doc.shapes[0].id, 0, 1)));
    expect(commands.breakAtSelection()).toBe(true);
    expect(collisions(store.state.doc)).toEqual([]);

    // Pick either end and it resolves to exactly one position.
    const opened = store.state.doc.shapes[0].subpaths[0];
    for (const end of [opened.nodes[0], opened.nodes[opened.nodes.length - 1]]) {
      store.update((s) => {
        s.selection.nodes.clear();
        s.selection.nodes.add(end.id);
      });
      expect(resolveNodes(store.state.doc, store.state.selection)).toHaveLength(1);
    }
  });
});

describe('duplicating a shape', () => {
  it('gives the copy nodes of its own', () => {
    const { store, commands } = editor(SQUARE);
    store.update((s) => s.selection.shapes.add(s.doc.shapes[0].id));
    expect(commands.duplicateSelection()).toBe(true);
    expect(store.state.doc.shapes).toHaveLength(2);
    expect(collisions(store.state.doc)).toEqual([]);
  });

  /* The symptom that was reported: click one anchor of the copy and the original
     lit up too, because both answered to the same id. */
  it('leaves a node of the copy selectable without the original', () => {
    const { store, commands } = editor(SQUARE);
    store.update((s) => s.selection.shapes.add(s.doc.shapes[0].id));
    commands.duplicateSelection();
    const copy = store.state.doc.shapes[1];
    store.update((s) => {
      s.selection = { nodes: new Set([copy.subpaths[0].nodes[0].id]), shapes: new Set() };
    });
    const hits = resolveNodes(store.state.doc, store.state.selection);
    expect(hits).toHaveLength(1);
    expect(hits[0].ref.shape).toBe(copy.id);
  });

  it('gives the copy a shape id of its own', () => {
    const { store, commands } = editor(SQUARE);
    store.update((s) => s.selection.shapes.add(s.doc.shapes[0].id));
    commands.duplicateSelection();
    const [a, b] = store.state.doc.shapes;
    expect(a.id).not.toBe(b.id);
  });
});

describe('the clipboard', () => {
  const selectShape = (store: Store): void =>
    store.update((s) => s.selection.shapes.add(s.doc.shapes[0].id));

  const selectNodes = (store: Store, ...indices: number[]): void =>
    store.update((s) => {
      s.selection = emptySelection();
      const id = s.doc.shapes[0].id;
      for (const i of indices) s.selection.nodes.add(nodeIdAt(s.doc, id, 0, i));
    });

  it('refuses a paste before anything has been copied', () => {
    const { commands } = editor(SQUARE);
    expect(commands.canPaste).toBe(false);
    expect(commands.paste()).toBe(false);
  });

  it('pastes a copied shape as a second shape with nodes of its own', () => {
    const { store, commands } = editor(SQUARE);
    selectShape(store);
    expect(commands.copySelection()).toBe(true);
    expect(commands.canPaste).toBe(true);
    expect(commands.paste()).toBe(true);
    expect(store.state.doc.shapes).toHaveLength(2);
    expect(collisions(store.state.doc)).toEqual([]);
  });

  /* The clipboard survives, so the copy can be put back more than once. Undoing
     a paste must not empty it either, which is why it is not in the store. */
  it('keeps what was copied across pastes and across an undo', () => {
    const { store, commands } = editor(SQUARE);
    selectShape(store);
    commands.copySelection();
    commands.paste();
    commands.paste();
    expect(store.state.doc.shapes).toHaveLength(3);
    store.undo();
    expect(store.state.doc.shapes).toHaveLength(2);
    expect(commands.canPaste).toBe(true);
    expect(commands.paste()).toBe(true);
    expect(collisions(store.state.doc)).toEqual([]);
  });

  it('lands each paste clear of the one before it', () => {
    const { store, commands } = editor(SQUARE);
    selectShape(store);
    commands.copySelection();
    commands.paste();
    commands.paste();
    const at = (i: number): number => store.state.doc.shapes[i].subpaths[0].nodes[0].pt[0];
    expect(at(1)).not.toBe(at(0));
    expect(at(2)).not.toBe(at(1));
  });

  /* Copying a shape has to take a snapshot, not a reference: the document goes on
     being edited, and a clipboard that tracked it would paste whatever the shape
     had become rather than what was copied. */
  it('pastes what was copied, not what the original became afterwards', () => {
    const { store, commands } = editor(SQUARE);
    selectShape(store);
    commands.copySelection();
    store.edit((s) => (s.doc.shapes[0].subpaths[0].nodes[0].pt = [99, 99]));
    commands.paste();
    const pasted = store.state.doc.shapes[1].subpaths[0].nodes[0].pt;
    expect(pasted[0]).toBeLessThan(50);
  });

  it('cuts by copying and then removing, leaving the copy pasteable', () => {
    const { store, commands } = editor(SQUARE);
    selectShape(store);
    expect(commands.cutSelection()).toBe(true);
    expect(store.state.doc.shapes).toHaveLength(0);
    expect(commands.paste()).toBe(true);
    expect(store.state.doc.shapes).toHaveLength(1);
  });

  describe('copying nodes rather than shapes', () => {
    it('takes a run of adjacent nodes as one open path', () => {
      const { store, commands } = editor(SQUARE);
      selectNodes(store, 0, 1, 2);
      expect(commands.copySelection()).toBe(true);
      commands.paste();
      expect(store.state.doc.shapes).toHaveLength(2);
      const made = store.state.doc.shapes[1].subpaths;
      expect(made).toHaveLength(1);
      expect(made[0].nodes).toHaveLength(3);
      expect(made[0].closed).toBe(false);
    });

    it('takes two separated runs as two paths', () => {
      const { store, commands } = editor('M0 0 L10 0 L20 0 L30 0 L40 0 L50 0');
      selectNodes(store, 0, 1, 3, 4);
      commands.copySelection();
      commands.paste();
      expect(store.state.doc.shapes).toHaveLength(3);
      for (const sh of store.state.doc.shapes.slice(1)) {
        expect(sh.subpaths[0].nodes).toHaveLength(2);
      }
    });

    /* The wrap, which is the case a run computed on array order gets wrong: these
       three corners are adjacent on the square and straddle index 0. */
    it('wraps a run round the end of a closed path', () => {
      const { store, commands } = editor(SQUARE);
      selectNodes(store, 3, 0, 1);
      commands.copySelection();
      commands.paste();
      const made = store.state.doc.shapes[1].subpaths;
      expect(made).toHaveLength(1);
      expect(made[0].nodes).toHaveLength(3);
    });

    it('keeps a wholly selected closed path closed', () => {
      const { store, commands } = editor(SQUARE);
      selectNodes(store, 0, 1, 2, 3);
      commands.copySelection();
      commands.paste();
      const made = store.state.doc.shapes[1].subpaths[0];
      expect(made.closed).toBe(true);
      expect(made.nodes).toHaveLength(4);
    });

    /* A lone node is a point, and a path of one node draws nothing. Refused
       rather than pasted as an invisible shape. */
    it('refuses a single node, which has no segment to bring', () => {
      const { store, commands } = editor(SQUARE);
      selectNodes(store, 2);
      expect(commands.copySelection()).toBe(false);
      expect(commands.canPaste).toBe(false);
    });
  });
});

/**
 * The same invariant arriving from outside, which is the route nothing covered.
 *
 * Every case above is a copy the editor made. A workspace file is a document
 * somebody else's build wrote, or a hand edit, or a truncated write, and the
 * reader repaired dangling group parents and cycles while accepting two nodes
 * under one id. §46's symptom is the same whichever direction it comes from.
 */
describe('a document from outside', () => {
  it('renames the second node to share an id, keeping the first', () => {
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath(SQUARE), shapeFromPath(SQUARE));
    reserveIds(doc);
    const shared = doc.shapes[0].subpaths[0].nodes[0].id;
    doc.shapes[1].subpaths[0].nodes[2].id = shared;
    expect(collisions(doc)).toHaveLength(1);

    expect(dedupeIds(doc)).toBe(1);
    expect(collisions(doc)).toHaveLength(0);
    expect(doc.shapes[0].subpaths[0].nodes[0].id).toBe(shared);
  });

  it('renames a shape that shares an id, so one row selects one shape', () => {
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath(SQUARE), shapeFromPath(OPEN));
    reserveIds(doc);
    doc.shapes[1].id = doc.shapes[0].id;

    expect(dedupeIds(doc)).toBe(1);
    expect(doc.shapes[1].id).not.toBe(doc.shapes[0].id);
    expect(findShape(doc, doc.shapes[1].id)).toBe(doc.shapes[1]);
  });

  /* The order matters and nothing about the types says so: a repair that ran
     before `reserveIds` would mint an id the document already holds.

     Aimed at the id the counter would hand out NEXT, which is the only form of
     this that can fail. `idSeq` is a module global every earlier test in this
     file has advanced, so a document holding `shape-1` -- or `shape-9000` --
     cannot collide with a fresh mint however wrong the order is, and both of
     those forms passed with `reserveIds` deleted. Asking the counter where it
     is, and then putting that id in the document, is what makes the ordering
     the thing under test. */
  it('mints an id the document does not already hold', () => {
    const at = Number(nextId().split('-')[1]);
    const nextOut = `shape-${at + 1}`;

    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath(SQUARE), shapeFromPath(OPEN), shapeFromPath(OPEN));
    doc.shapes[0].id = 'shared';
    doc.shapes[1].id = 'shared';
    doc.shapes[2].id = nextOut;
    reserveIds(doc);

    expect(dedupeIds(doc)).toBe(1);
    expect(new Set(doc.shapes.map((s) => s.id)).size).toBe(3);
    expect(doc.shapes[1].id).not.toBe(nextOut);
  });

  it('leaves a document that is already well formed alone', () => {
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath(SQUARE), shapeFromPath(OPEN));
    reserveIds(doc);
    const before = doc.shapes.map((s) => [s.id, ...s.subpaths[0].nodes.map((n) => n.id)].join(','));
    expect(dedupeIds(doc)).toBe(0);
    expect(doc.shapes.map((s) => [s.id, ...s.subpaths[0].nodes.map((n) => n.id)].join(','))).toEqual(before);
  });
});
