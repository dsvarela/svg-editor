/**
 * The `Commands` layer, which is the layer the buttons and the keys actually
 * run.
 *
 * **Every operation here already had its geometry tested somewhere else.**
 * `offsetSubpath` has 92 mutation sites and a file of its own; `strokeOutline`
 * has a describe block in `test/offset.test.ts`; `reduceToCount` and `keepOnly`
 * are covered in `test/simplify.test.ts`. What none of them covered is the
 * method that reads the selection, decides whether the operation applies, edits
 * the store and says what happened -- and that method is what ships. `code`
 * rule 13: the tested layer was not the shipped one.
 *
 * The sweep of `2026-08-21b` put a number on it. 249 of `commands.ts`'s 427
 * mutation sites survived, and 143 of those sit in the 24 methods no test
 * named at all. Six of those methods are here, chosen by consequence: the five
 * that change geometry, and the guard that decides where a finished trace lands.
 *
 * Three things are asserted for each, because the survivors fell into exactly
 * three classes:
 *
 * - the document afterwards, which is the only one anything used to check;
 * - **the boolean the method returns**, which 64 of the 249 survivors sat on;
 * - **the sentence it writes**, which another 29 sat inside. A `+` between two
 *   message fragments mutated to `-` yields `NaN`, and nothing disagreed.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { Commands } from '../src/tools/commands';
import { emptyDoc, findShape, shapeFromPath } from '../src/model/doc';
import type { Doc, Shape } from '../src/core/types';

const SQUARE = 'M0 0 H40 V40 H0 Z';

/** A store, its commands, and whatever the last message was. */
function editor(doc: Doc): {
  store: Store;
  commands: Commands;
  said: () => { message: string; ok: boolean } | null;
} {
  const store = new Store(doc);
  const commands = new Commands(store, () => false);
  let last: { message: string; ok: boolean } | null = null;
  commands.onMessage = (message, ok) => (last = { message, ok });
  return { store, commands, said: () => last };
}

function withShapes(...paths: [string, string][]): Doc {
  const doc = emptyDoc();
  for (const [name, d] of paths) {
    const sh = shapeFromPath(d);
    sh.name = name;
    doc.shapes.push(sh);
  }
  return doc;
}

const select = (store: Store, ...names: string[]): void =>
  store.update((s) => {
    s.selection.shapes.clear();
    s.selection.nodes.clear();
    for (const sh of s.doc.shapes) if (names.includes(sh.name)) s.selection.shapes.add(sh.id);
  });

const selectNodes = (store: Store, name: string, ...at: number[]): void =>
  store.update((s) => {
    s.selection.shapes.clear();
    s.selection.nodes.clear();
    const sh = s.doc.shapes.find((x) => x.name === name)!;
    for (const i of at) s.selection.nodes.add(sh.subpaths[0].nodes[i].id);
  });

const named = (doc: Doc, name: string): Shape | undefined =>
  doc.shapes.find((sh) => sh.name === name);

describe('offsetting a selection', () => {
  it('adds a shape and leaves the original alone', () => {
    const { store, commands, said } = editor(withShapes(['sq', SQUARE]));
    select(store, 'sq');
    const before = named(store.state.doc, 'sq')!.subpaths[0].nodes.length;

    expect(commands.offsetSelection(4)).toBe(true);
    expect(store.state.doc.shapes).toHaveLength(2);
    // The original is untouched: an offset is a pair, not a replacement.
    expect(named(store.state.doc, 'sq')!.subpaths[0].nodes).toHaveLength(before);
    expect(named(store.state.doc, 'sq offset')).toBeDefined();
    // And the new shape is what is selected, because it is what you just made.
    expect(store.state.selection.shapes.size).toBe(1);
    expect(store.state.selection.shapes.has(named(store.state.doc, 'sq offset')!.id)).toBe(true);
    expect(said()).toEqual({ message: 'Offset 1 shape by 4.', ok: true });
  });

  it('says shapes rather than shape when there is more than one', () => {
    // The plural ternary in the message. Nothing read a message before, so
    // `made.length === 1` inverted was a survivor.
    const { store, commands, said } = editor(withShapes(['a', SQUARE], ['b', 'M60 0 H100 V40 H60 Z']));
    select(store, 'a', 'b');
    expect(commands.offsetSelection(4)).toBe(true);
    expect(said()!.message).toBe('Offset 2 shapes by 4.');
  });

  it('refuses an offset of zero, which is the shape you already have', () => {
    /* The message and not only the refusal. Offsetting by zero fails a second
       time further down -- `offsetSubpath` returns nothing to add -- so the
       shape count and the `false` are the same whichever guard caught it, and
       only the sentence says which one did. */
    const { store, commands, said } = editor(withShapes(['sq', SQUARE]));
    select(store, 'sq');
    expect(commands.offsetSelection(0)).toBe(false);
    expect(store.state.doc.shapes).toHaveLength(1);
    expect(said()).toEqual({
      message: 'Offset by how far? Zero is the shape you already have.',
      ok: false,
    });
  });

  it('refuses a distance that is not a number', () => {
    const { store, commands, said } = editor(withShapes(['sq', SQUARE]));
    select(store, 'sq');
    expect(commands.offsetSelection(Number.NaN)).toBe(false);
    expect(said()!.message).toMatch(/^Offset by how far\?/);
  });

  it('refuses with nothing selected, and says so rather than saying nothing', () => {
    const { commands, said } = editor(withShapes(['sq', SQUARE]));
    expect(commands.offsetSelection(4)).toBe(false);
    expect(said()).toEqual({ message: 'Select a shape to offset.', ok: false });
  });
});

describe('turning a stroke into a path', () => {
  /* The one operation in this file with no test anywhere and no browser
     scenario either: `strokeOutline`'s geometry is measured in
     `test/offset.test.ts`, and every line of the method that calls it was dark
     in both suites. */

  const stroked = (width: number, stroke = '#f00'): Doc => {
    const doc = withShapes(['line', 'M0 0 H40']);
    doc.shapes[0].style = { ...doc.shapes[0].style, stroke, strokeWidth: width, fill: 'none' };
    return doc;
  };

  it('replaces the path with its outline and moves the colour to the fill', () => {
    const { store, commands, said } = editor(stroked(6));
    select(store, 'line');
    expect(commands.strokeToPath('butt')).toBe(true);

    const sh = named(store.state.doc, 'line')!;
    // An outline of an open path is one closed contour around it.
    expect(sh.subpaths.every((sp) => sp.closed)).toBe(true);
    expect(sh.style.fill).toBe('#f00');
    expect(sh.style.stroke).toBe('none');
    expect(sh.style.fillRule).toBe('evenodd');
    expect(said()).toEqual({ message: 'Outlined 1 shape.', ok: true });
  });

  it('outlines at the shape’s own width, so a 6 stroke is 6 across', () => {
    /* The width comes from the style and not from an argument, which is the
       whole of §40. Measured across the middle of the line, where the caps
       cannot reach. */
    const { store, commands } = editor(stroked(6));
    select(store, 'line');
    commands.strokeToPath('butt');
    const ys = named(store.state.doc, 'line')!.subpaths.flatMap((sp) => sp.nodes.map((n) => n.pt[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(6, 6);
  });

  it('refuses a shape with no stroke rather than skipping it', () => {
    const { store, commands, said } = editor(stroked(6, 'none'));
    select(store, 'line');
    expect(commands.strokeToPath()).toBe(false);
    expect(named(store.state.doc, 'line')!.subpaths[0].closed).toBe(false);
    expect(said()).toEqual({
      message: 'That shape has no stroke to turn into a path.',
      ok: false,
    });
  });

  it('refuses a stroke of no width for the same reason', () => {
    /* The second half of `stroke === 'none' || !(strokeWidth > 0)`, which no
       fixture reached, so the disjunction was decided by one clause only. The
       message again, because a width of zero also fails further down and the
       `false` alone cannot say which guard answered. */
    const { store, commands, said } = editor(stroked(0));
    select(store, 'line');
    expect(commands.strokeToPath()).toBe(false);
    expect(said()).toEqual({
      message: 'That shape has no stroke to turn into a path.',
      ok: false,
    });
  });

  it('refuses with nothing selected, and says so', () => {
    const { commands, said } = editor(stroked(6));
    expect(commands.strokeToPath()).toBe(false);
    expect(said()).toEqual({ message: 'Select a shape to outline.', ok: false });
  });
});

describe('reducing a path to a node count', () => {
  /** A closed polygon through `n` points on a circle: every node a corner. */
  const polygon = (n: number, r = 50): string => {
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return `${(r * Math.cos(a)).toFixed(4)} ${(r * Math.sin(a)).toFixed(4)}`;
    });
    return `M${pts.join('L')}Z`;
  };

  it('keeps the number asked for and says how far the drawing moved', () => {
    const { store, commands, said } = editor(withShapes(['ring', polygon(24)]));
    select(store, 'ring');
    expect(commands.simplifyToCount(8)).toBe(true);
    expect(named(store.state.doc, 'ring')!.subpaths[0].nodes).toHaveLength(8);
    expect(said()!.ok).toBe(true);
    expect(said()!.message).toMatch(/^Kept 8 of 24 nodes across 1 path\. Nothing moved further than /);
  });

  it('refuses fewer than two, which is fewer than a path can have', () => {
    const { store, commands, said } = editor(withShapes(['ring', polygon(24)]));
    select(store, 'ring');
    expect(commands.simplifyToCount(1)).toBe(false);
    expect(named(store.state.doc, 'ring')!.subpaths[0].nodes).toHaveLength(24);
    expect(said()!.ok).toBe(false);
  });

  it('accepts two, which is the bound itself and not one past it', () => {
    /**
     * The boundary. `target < 2` and `target <= 2` differ on exactly this
     * value, and a fixture at 1 or at 8 cannot see the difference.
     *
     * On an open path, because two is reachable there and not on a closed one:
     * a ring reduced to two nodes is not a ring, so `reduceToCount` floors it
     * at three, the same floor `keepSelectedNodes` states out loud. The message
     * says "two is the fewest a path can have", which is true of the argument
     * this guard checks rather than of every path it may be given.
     */
    const open = 'M0 0 L10 1 L20 -1 L30 2 L40 0 L50 3';
    const { store, commands } = editor(withShapes(['zig', open]));
    select(store, 'zig');
    expect(commands.simplifyToCount(2)).toBe(true);
    expect(named(store.state.doc, 'zig')!.subpaths[0].nodes).toHaveLength(2);
  });

  it('refuses with nothing selected, and says so', () => {
    const { commands, said } = editor(withShapes(['ring', polygon(24)]));
    expect(commands.simplifyToCount(8)).toBe(false);
    expect(said()).toEqual({
      message: 'Select a shape, or some of its nodes, first.',
      ok: false,
    });
  });

  it('declines a path already at or below the count, without editing it', () => {
    const { store, commands, said } = editor(withShapes(['ring', polygon(6)]));
    select(store, 'ring');
    expect(commands.simplifyToCount(10)).toBe(false);
    expect(named(store.state.doc, 'ring')!.subpaths[0].nodes).toHaveLength(6);
    expect(said()).toEqual({
      message: 'Those paths are already at or below that many nodes.',
      ok: false,
    });
    // And nothing entered the history, so Ctrl+Z does not undo a no-op.
    expect(store.canUndo).toBe(false);
  });

  it('keeps exactly the nodes chosen and drops the rest', () => {
    const { store, commands, said } = editor(withShapes(['ring', polygon(12)]));
    const doc = store.state.doc;
    const keep = [0, 3, 6, 9];
    const wanted = keep.map((i) => findShape(doc, doc.shapes[0].id)!.subpaths[0].nodes[i].pt);
    selectNodes(store, 'ring', ...keep);

    expect(commands.keepSelectedNodes()).toBe(true);
    const after = named(store.state.doc, 'ring')!.subpaths[0].nodes.map((n) => n.pt);
    expect(after).toHaveLength(4);
    /* The positions, not the count. A run that kept four arbitrary nodes would
       satisfy a count and be a different drawing. */
    for (const p of wanted) {
      expect(after.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9)).toBe(true);
    }
    // The whole sentence, including its plural: `paths === 1` inverted is a
    // change to what a person reads and nothing else here would notice.
    expect(said()!.message).toMatch(/^Kept 4 of 12 nodes across 1 path\. Nothing moved further than /);
  });

  it('refuses to leave a closed path fewer than three nodes', () => {
    const { store, commands, said } = editor(withShapes(['ring', polygon(12)]));
    selectNodes(store, 'ring', 0, 5);
    expect(commands.keepSelectedNodes()).toBe(false);
    expect(named(store.state.doc, 'ring')!.subpaths[0].nodes).toHaveLength(12);
    expect(said()).toEqual({
      message: 'A closed path needs three nodes kept, and an open one two.',
      ok: false,
    });
  });

  it('accepts exactly three on a closed path, which is the bound itself', () => {
    // `keep.size < 3` and `keep.size <= 3` differ on this value alone, and the
    // two cases above sit at 2 and at 4.
    const { store, commands } = editor(withShapes(['ring', polygon(12)]));
    selectNodes(store, 'ring', 0, 4, 8);
    expect(commands.keepSelectedNodes()).toBe(true);
    expect(named(store.state.doc, 'ring')!.subpaths[0].nodes).toHaveLength(3);
  });

  it('refuses a single node, which is not a selection to keep', () => {
    const { store, commands, said } = editor(withShapes(['ring', polygon(12)]));
    selectNodes(store, 'ring', 4);
    expect(commands.keepSelectedNodes()).toBe(false);
    expect(said()!.ok).toBe(false);
  });
});

describe('stepping the node selection', () => {
  /**
   * Both directions, which is what nothing had.
   *
   * The browser suite presses **Next** and never **Previous**, so `by` was only
   * ever 1: the ends of an open path, the wrap on a closed one and the
   * first-node case all had one of their two branches unexercised, and fifteen
   * mutations in this method survived.
   */
  const OPEN = 'M0 0 L10 0 L20 0 L30 0';
  const CLOSED = 'M0 0 L10 0 L10 10 L0 10 Z';

  const at = (store: Store, name: string): number => {
    const sh = named(store.state.doc, name)!;
    return sh.subpaths[0].nodes.findIndex((n) => store.state.selection.nodes.has(n.id));
  };

  it('starts at the first node going forwards and the last going back', () => {
    for (const [by, want] of [
      [1, 0],
      [-1, 3],
    ] as [1 | -1, number][]) {
      const { store, commands } = editor(withShapes(['p', OPEN]));
      select(store, 'p');
      expect(commands.stepNodeSelection(by)).toBe(true);
      expect(at(store, 'p')).toBe(want);
      expect(store.state.selection.nodes.size).toBe(1);
      /* And the shape goes with it. `selectedNodes` widens a selected shape to
         every node in it, so leaving the shape in makes the panel read the
         whole path back: the Node group showed `8 selected` beside a selection
         of one. The browser scenario `keyboardNodes` is what found that, on a
         closed path where the old walk happened to wrap to node 0 and look
         right. */
      expect(store.state.selection.shapes.size).toBe(0);
    }
  });

  it('walks one node at a time in the direction asked for', () => {
    const { store, commands } = editor(withShapes(['p', OPEN]));
    selectNodes(store, 'p', 1);
    expect(commands.stepNodeSelection(1)).toBe(true);
    expect(at(store, 'p')).toBe(2);
    expect(commands.stepNodeSelection(-1)).toBe(true);
    expect(at(store, 'p')).toBe(1);
  });

  it('steps back onto the first node, which is the last legal move', () => {
    /* The bound `next < 0` and not `next <= 0`: index 0 is a node, and the two
       spellings differ on exactly the move that lands there. Both cases above
       stop short of it, one at index 1 and one already at 0. */
    const { store, commands } = editor(withShapes(['p', OPEN]));
    selectNodes(store, 'p', 1);
    expect(commands.stepNodeSelection(-1)).toBe(true);
    expect(at(store, 'p')).toBe(0);
  });

  it('stops at either end of an open path and names which end', () => {
    const { store, commands, said } = editor(withShapes(['p', OPEN]));
    selectNodes(store, 'p', 3);
    expect(commands.stepNodeSelection(1)).toBe(false);
    expect(said()).toEqual({ message: 'That is the last node of the path.', ok: false });
    expect(at(store, 'p')).toBe(3);

    selectNodes(store, 'p', 0);
    expect(commands.stepNodeSelection(-1)).toBe(false);
    expect(said()).toEqual({ message: 'That is the first node of the path.', ok: false });
    expect(at(store, 'p')).toBe(0);
  });

  it('wraps both ways on a closed path, where there is no end to stop at', () => {
    const { store, commands } = editor(withShapes(['p', CLOSED]));
    selectNodes(store, 'p', 3);
    expect(commands.stepNodeSelection(1)).toBe(true);
    expect(at(store, 'p')).toBe(0);
    expect(commands.stepNodeSelection(-1)).toBe(true);
    expect(at(store, 'p')).toBe(3);
  });

  it('refuses with neither a node nor a shape chosen', () => {
    const { commands, said } = editor(withShapes(['p', OPEN]));
    expect(commands.stepNodeSelection(1)).toBe(false);
    expect(said()).toEqual({ message: 'Select a shape or a node first.', ok: false });
  });
});

describe('landing a finished trace', () => {
  /**
   * The guard the doc comment above `applyTrace` argues for at length, and that
   * no test had ever reached.
   *
   * A trace runs in a worker for seconds, and the placement it was computed
   * against is passed in. If the backdrop moved in the meantime the shapes
   * belong somewhere else, so the result is dropped. Every mutation of that
   * condition survived: `||` to `&&` means only a backdrop that moved in all
   * four numbers is refused, so a nudge along one axis lands the whole trace in
   * the wrong place with nothing said.
   */
  const withBackdrop = (x: number, y: number) => {
    const { store, commands, said } = editor(emptyDoc());
    store.update((s) => {
      s.backdrop = {
        src: 'blob:fixture',
        name: 'ref.png',
        x,
        y,
        w: 20,
        h: 10,
        naturalW: 40,
        naturalH: 20,
        opacity: 0.5,
        visible: true,
        locked: true,
      };
    });
    return { store, commands, said };
  };

  const result = () => ({
    shapes: [shapeFromPath('M0 0 H5 V5 H0 Z')],
    paths: 1,
    nodesBefore: 8,
    nodesAfter: 4,
    colours: 1,
  });

  it('adds the shapes when the backdrop has not moved', () => {
    const { store, commands, said } = withBackdrop(0, 0);
    expect(commands.applyTrace(result(), { x: 0, y: 0, w: 20, h: 10 })).toBe(true);
    expect(store.state.doc.shapes).toHaveLength(1);
    expect(store.state.selection.shapes.size).toBe(1);
    expect(said()).toEqual({
      message: 'Traced 1 colour into 1 path: 8 nodes fitted to 4.',
      ok: true,
    });
  });

  it.each([
    ['x', { x: 1, y: 0, w: 20, h: 10 }],
    ['y', { x: 0, y: 1, w: 20, h: 10 }],
    ['w', { x: 0, y: 0, w: 21, h: 10 }],
    ['h', { x: 0, y: 0, w: 20, h: 11 }],
  ] as [string, { x: number; y: number; w: number; h: number }][])(
    'drops the trace when the backdrop moved in %s alone',
    (_which, place) => {
      /* One number at a time, which is the point. All four together is the only
         case a conjunction would also refuse, so a fixture that moved the whole
         backdrop could not tell the two spellings apart. */
      const { store, commands, said } = withBackdrop(0, 0);
      expect(commands.applyTrace(result(), place)).toBe(false);
      expect(store.state.doc.shapes).toHaveLength(0);
      expect(said()).toEqual({
        message: 'The backdrop moved while tracing. Nothing was added.',
        ok: false,
      });
    },
  );

  it('drops the trace when the backdrop was removed outright', () => {
    const { store, commands, said } = withBackdrop(0, 0);
    store.update((s) => (s.backdrop = null));
    expect(commands.applyTrace(result(), { x: 0, y: 0, w: 20, h: 10 })).toBe(false);
    expect(store.state.doc.shapes).toHaveLength(0);
    expect(said()).toEqual({
      message: 'The backdrop was removed while tracing. Nothing was added.',
      ok: false,
    });
  });

  it('says so when every region fell below the noise floor', () => {
    const { commands, said } = withBackdrop(0, 0);
    expect(commands.applyTrace({ ...result(), shapes: [] }, { x: 0, y: 0, w: 20, h: 10 })).toBe(
      false,
    );
    expect(said()!.ok).toBe(false);
    expect(said()!.message).toMatch(/noise floor/);
  });
});
