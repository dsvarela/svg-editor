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
import { segmentAsCubic, segmentCount, segmentIsLine } from '../src/core/types';
import { cubicAt } from '../src/core/bezier';
import { segmentBend } from '../src/model/ops';
import { clampLooseness } from '../src/core/bend';
import type { Cubic, Doc, NodeContinuity, Shape, Subpath } from '../src/core/types';

const SQUARE = 'M0 0 H40 V40 H0 Z';
/** Open, four nodes, so a segment count is not the node count. */
const ELL = 'M0 0 H40 V40 H80';
/** One cubic, bowed, so a split can be checked for changing the curve. */
const ARC = 'M0 0 C10 -20 30 -20 40 0';

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

/* ------------------------------------------------------------------------ *
 * The methods no test named at all.
 *
 * The 2026-08-21 sweep found 24 of `Commands`' 58 methods with no test caller,
 * carrying 143 of the 249 survivors between them. Six were covered above. What
 * follows is the rest, and it keeps the same three assertions: the document,
 * the boolean, and the sentence.
 * ------------------------------------------------------------------------ */

/**
 * How far the point at `t` of `seg` is from the point at `u` of `curve`.
 *
 * Two curves are compared through their parameters and never through a cloud of
 * samples. A sampled comparison has a floor: `ARC` leaves its first node at
 * three times the handle's length, so 200 samples sit up to 0.167 apart there,
 * and nothing measured against them can resolve better than half of that. That
 * is coarse enough to call a split that visibly moved the curve exact.
 */
const gap = (seg: Cubic, t: number, curve: Cubic, u: number): number => {
  const p = cubicAt(seg, t);
  const q = cubicAt(curve, u);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
};

const sub = (store: Store, name: string): Subpath => named(store.state.doc, name)!.subpaths[0];

describe('inserting a node between two selected nodes', () => {
  it('adds one node to the segment they name and selects it', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    expect(commands.insertInSelection()).toBe(true);

    const sp = sub(store, 'p');
    expect(sp.nodes).toHaveLength(5);
    // Between the two that were picked, at the middle of their segment.
    expect(sp.nodes[2].pt).toEqual([40, 20]);
    expect(store.state.selection.nodes.size).toBe(1);
    expect(store.state.selection.nodes.has(sp.nodes[2].id)).toBe(true);
    expect(said()).toEqual({ message: 'Node inserted, and the curve is unchanged.', ok: true });
  });

  it('leaves the curve where it was, which is what the message claims', () => {
    /* The claim is about geometry, so it is measured rather than trusted: a
       split that moved the curve would still add a node, still return true and
       still say this.

       The two halves are checked against the parameters they came from -- the
       first half's `t` against `t / 2` of the original, the second's against
       `0.5 + t / 2`. That is exact where a sampled comparison is not, and it
       pins the split to the middle at the same time: a split at any other `t`
       fails this while tracing the identical curve. */
    const { store, commands } = editor(withShapes(['p', ARC]));
    const whole = segmentAsCubic(sub(store, 'p'), 0);
    selectNodes(store, 'p', 0, 1);
    expect(commands.insertInSelection()).toBe(true);

    const sp = sub(store, 'p');
    expect(segmentCount(sp)).toBe(2);
    const [first, second] = [segmentAsCubic(sp, 0), segmentAsCubic(sp, 1)];
    for (let k = 0; k <= 40; k++) {
      const t = k / 40;
      expect(gap(first, t, whole, t / 2)).toBeLessThan(1e-9);
      expect(gap(second, t, whole, 0.5 + t / 2)).toBeLessThan(1e-9);
    }
  });

  it('treats the closing segment as a segment like any other', () => {
    // Last node and first are neighbours on a closed path, so the pair that
    // wraps names the closing segment rather than nothing.
    const { store, commands } = editor(withShapes(['p', SQUARE]));
    selectNodes(store, 'p', 0, 3);
    expect(commands.insertInSelection()).toBe(true);
    const sp = sub(store, 'p');
    expect(sp.nodes).toHaveLength(5);
    expect(sp.nodes[4].pt).toEqual([0, 20]);
  });

  it('refuses the same pair on an open path, where they are two ends', () => {
    /* The fixture the `sp.closed` term needs. Nodes 0 and 3 of `ELL` are as far
       apart as nodes 0 and 3 of `SQUARE`; only the flag says whether they touch,
       so a version that dropped it passes the test above and fails this one. */
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 3);
    expect(commands.insertInSelection()).toBe(false);
    expect(sub(store, 'p').nodes).toHaveLength(4);
    expect(said()).toEqual({
      message: 'Those two nodes are not the ends of one segment.',
      ok: false,
    });
  });

  it('refuses two nodes with a third between them', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 2);
    expect(commands.insertInSelection()).toBe(false);
    expect(said()!.message).toBe('Those two nodes are not the ends of one segment.');
  });

  it('refuses anything that is not exactly two nodes', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1);
    expect(commands.insertInSelection()).toBe(false);
    expect(said()).toEqual({
      message: 'Select the two nodes either side of a segment.',
      ok: false,
    });
  });

  it('refuses two nodes on different shapes', () => {
    const { store, commands, said } = editor(withShapes(['a', ELL], ['b', 'M0 60 H40']));
    store.update((s) => {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
      s.selection.nodes.add(named(s.doc, 'a')!.subpaths[0].nodes[0].id);
      s.selection.nodes.add(named(s.doc, 'b')!.subpaths[0].nodes[0].id);
    });
    expect(commands.insertInSelection()).toBe(false);
    expect(said()!.message).toBe('Select the two nodes either side of a segment.');
  });
});

describe('fusing nodes together', () => {
  it('welds a chosen pair and says how far each moved', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    expect(commands.fuseSelection()).toBe(true);

    const sp = sub(store, 'p');
    expect(sp.nodes).toHaveLength(3);
    // The weld lands midway between the two, so each travelled half the chord.
    expect(sp.nodes[1].pt).toEqual([40, 20]);
    expect(said()).toEqual({ message: 'Fused the two nodes. Each moved 20 to meet.', ok: true });
    // Nothing is left selected: the two nodes it named no longer both exist.
    expect(store.state.selection.nodes.size).toBe(0);
  });

  it('says they were already together when the distance is zero', () => {
    // The other branch of the same sentence, which needs a path carrying a
    // zero-length segment to reach.
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H40 H40 V40']));
    selectNodes(store, 'p', 1, 2);
    expect(commands.fuseSelection()).toBe(true);
    expect(said()).toEqual({
      message: 'Fused the two nodes. They were already on the same point.',
      ok: true,
    });
  });

  it('refuses two nodes that are not neighbours', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 2);
    expect(commands.fuseSelection()).toBe(false);
    expect(sub(store, 'p').nodes).toHaveLength(4);
    expect(said()).toEqual({
      message: 'Fuse needs two nodes next to each other along the path.',
      ok: false,
    });
  });

  it('points at Merge ends for the two ends of an open path', () => {
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H40']));
    selectNodes(store, 'p', 0, 1);
    expect(commands.fuseSelection()).toBe(false);
    expect(said()).toEqual({
      message: 'Those are the two ends of the path. Merge ends welds them.',
      ok: false,
    });
  });

  it('refuses a pair on two different paths', () => {
    const { store, commands, said } = editor(withShapes(['a', ELL], ['b', 'M0 60 H40']));
    store.update((s) => {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
      s.selection.nodes.add(named(s.doc, 'a')!.subpaths[0].nodes[0].id);
      s.selection.nodes.add(named(s.doc, 'b')!.subpaths[0].nodes[0].id);
    });
    expect(commands.fuseSelection()).toBe(false);
    expect(said()).toEqual({
      message: 'Fuse works within one path. Those two nodes are on different ones.',
      ok: false,
    });
  });

  it('sweeps a whole shape for zero-length segments, and counts them', () => {
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H40 H40 V40 V40 H0 Z']));
    select(store, 'p');
    expect(commands.fuseSelection()).toBe(true);
    expect(sub(store, 'p').nodes).toHaveLength(4);
    expect(said()).toEqual({ message: 'Fused 2 zero-length segments away.', ok: true });
  });

  it('says segment rather than segments when there is one', () => {
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H40 H40 V40 H0 Z']));
    select(store, 'p');
    expect(commands.fuseSelection()).toBe(true);
    expect(said()!.message).toBe('Fused 1 zero-length segment away.');
  });

  it('says so when a swept shape has nothing degenerate in it', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    expect(commands.fuseSelection()).toBe(false);
    expect(sub(store, 'p').nodes).toHaveLength(4);
    expect(said()).toEqual({ message: 'No two nodes there sit on the same point.', ok: false });
  });

  it('refuses with nothing selected', () => {
    const { commands, said } = editor(withShapes(['p', SQUARE]));
    expect(commands.fuseSelection()).toBe(false);
    expect(said()).toEqual({
      message: 'Select two adjacent nodes, or a shape to sweep.',
      ok: false,
    });
  });
});

describe('fitting a selection to the pixel lattice', () => {
  const offGrid = (width: number): Doc => {
    const doc = withShapes(['sq', 'M0 0 H40 V40 H0 Z']);
    doc.shapes[0].style = { ...doc.shapes[0].style, stroke: '#000', strokeWidth: width };
    return doc;
  };

  it('puts a 1-wide stroke on half pixels, where its painted edges are whole', () => {
    const { store, commands, said } = editor(offGrid(1));
    select(store, 'sq');
    expect(commands.fitToPixels()).toBe(true);
    expect(sub(store, 'sq').nodes.map((n) => n.pt)).toEqual([
      [0.5, 0.5],
      [40.5, 0.5],
      [40.5, 40.5],
      [0.5, 40.5],
    ]);
    expect(said()).toEqual({
      message: 'Fitted 4 nodes to half pixels. The furthest moved 0.707.',
      ok: true,
    });
  });

  it('puts a 2-wide stroke on whole pixels instead', () => {
    /* The phase is read from the stroke and not fixed, so the same shape lands
       half a unit away under a different width. A fixture at one width cannot
       tell a computed phase from a hardcoded one. */
    const doc = offGrid(2);
    doc.shapes[0].subpaths[0].nodes.forEach((n) => (n.pt = [n.pt[0] + 0.4, n.pt[1] + 0.4]));
    const { store, commands, said } = editor(doc);
    select(store, 'sq');
    expect(commands.fitToPixels()).toBe(true);
    expect(sub(store, 'sq').nodes[0].pt).toEqual([0, 0]);
    expect(said()!.message).toMatch(/^Fitted 4 nodes to whole pixels\./);
  });

  it('carries handles along, so a curve keeps its shape', () => {
    const doc = withShapes(['c', ARC]);
    doc.shapes[0].style = { ...doc.shapes[0].style, stroke: '#000', strokeWidth: 2 };
    const { store, commands } = editor(doc);
    // Both anchors off the lattice, so both have to move. Only the anchors:
    // the handles stay where they were, which is what makes each reach below a
    // number the fit has to preserve rather than a number it already had.
    store.update((s) => {
      const ns = s.doc.shapes[0].subpaths[0].nodes;
      ns[0].pt = [0.3, 0.3];
      ns[1].pt = [39.7, 0.4];
    });

    const before = sub(store, 'c');
    const reach = (sp: Subpath): number[] => [
      sp.nodes[0].hOut![0] - sp.nodes[0].pt[0],
      sp.nodes[0].hOut![1] - sp.nodes[0].pt[1],
      sp.nodes[1].hIn![0] - sp.nodes[1].pt[0],
      sp.nodes[1].hIn![1] - sp.nodes[1].pt[1],
    ];
    const was = reach(before);

    select(store, 'c');
    expect(commands.fitToPixels()).toBe(true);
    const sp = sub(store, 'c');
    expect(sp.nodes[0].pt).toEqual([0, 0]);
    expect(sp.nodes[1].pt).toEqual([40, 0]);
    // Each handle sits where it sat relative to its own anchor: the anchors
    // moved and the curve was carried, not flattened towards the grid.
    reach(sp).forEach((v, i) => expect(v).toBeCloseTo(was[i], 9));
  });

  it('refuses a selection whose stroke widths disagree', () => {
    const doc = offGrid(1);
    const second = shapeFromPath('M60 0 H100 V40 H60 Z');
    second.name = 'other';
    second.style = { ...second.style, stroke: '#000', strokeWidth: 2 };
    doc.shapes.push(second);
    const { store, commands, said } = editor(doc);
    select(store, 'sq', 'other');
    expect(commands.fitToPixels()).toBe(false);
    expect(sub(store, 'sq').nodes[0].pt).toEqual([0, 0]);
    expect(said()).toEqual({
      message:
        'Those shapes have different stroke widths, so no one lattice fits them all. Fit them one at a time.',
      ok: false,
    });
  });

  it('refuses with nothing selected', () => {
    const { commands, said } = editor(offGrid(1));
    expect(commands.fitToPixels()).toBe(false);
    expect(said()).toEqual({ message: 'Select a shape, or some of its nodes, to fit.', ok: false });
  });

  it('says so when everything is already on the lattice', () => {
    const doc = offGrid(1);
    doc.shapes[0].subpaths[0].nodes.forEach((n) => (n.pt = [n.pt[0] + 0.5, n.pt[1] + 0.5]));
    const { store, commands, said } = editor(doc);
    select(store, 'sq');
    expect(commands.fitToPixels()).toBe(false);
    expect(said()).toEqual({ message: 'Already on the pixel grid. Nothing to move.', ok: false });
  });
});

describe('clearing the guides', () => {
  it('removes them all in one step and counts what went', () => {
    const { store, commands, said } = editor(emptyDoc());
    commands.addGuideAt('x', 10);
    commands.addGuideAt('y', 20);
    expect(commands.clearGuides()).toBe(true);
    expect(store.state.guides).toHaveLength(0);
    expect(said()).toEqual({ message: 'Removed 2 guides.', ok: true });
  });

  it('says guide rather than guides when there is one', () => {
    const { commands, said } = editor(emptyDoc());
    commands.addGuideAt('x', 10);
    expect(commands.clearGuides()).toBe(true);
    expect(said()!.message).toBe('Removed 1 guide.');
  });

  it('refuses with no guides, and says nothing rather than Removed 0', () => {
    const { commands, said } = editor(emptyDoc());
    expect(commands.clearGuides()).toBe(false);
    expect(said()).toBe(null);
  });
});

describe('where the angle rays come from', () => {
  it('pins them to the middle of the selection and turns angle snap on', () => {
    const { store, commands, said } = editor(withShapes(['sq', SQUARE]));
    select(store, 'sq');
    expect(commands.setAngleOrigin()).toBe(true);
    expect(store.state.angleOrigin).toEqual([20, 20]);
    expect(store.state.snapToAngles).toBe(true);
    expect(said()).toEqual({ message: 'Angles from 20, 20.', ok: true });
  });

  it('takes the middle of the box and not the first node', () => {
    /* `SQUARE` starts at the origin, so a centre computed as `(x0 + x1) / 2`
       and one computed as `x0` differ by 20 there and by nothing at all if the
       fixture were symmetric about zero. This one is placed away from both. */
    const { store, commands } = editor(withShapes(['r', 'M10 30 H50 V70 H10 Z']));
    select(store, 'r');
    commands.setAngleOrigin();
    expect(store.state.angleOrigin).toEqual([30, 50]);
  });

  it('refuses with nothing selected and leaves the old origin alone', () => {
    const { store, commands, said } = editor(withShapes(['sq', SQUARE]));
    store.update((s) => (s.angleOrigin = [7, 7]));
    expect(commands.setAngleOrigin()).toBe(false);
    expect(store.state.angleOrigin).toEqual([7, 7]);
    expect(said()).toEqual({ message: 'Select something to put the origin on.', ok: false });
  });

  it('goes back to the gesture when cleared', () => {
    const { store, commands, said } = editor(withShapes(['sq', SQUARE]));
    select(store, 'sq');
    commands.setAngleOrigin();
    commands.clearAngleOrigin();
    expect(store.state.angleOrigin).toBe(null);
    expect(said()).toEqual({ message: 'Angles from wherever a gesture starts.', ok: true });
  });
});

describe('typing a node’s coordinates', () => {
  it('moves the axis it was given and leaves the other one', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1);
    commands.setNodeCoord('anchor', 0, 12);
    expect(sub(store, 'p').nodes[1].pt).toEqual([12, 0]);
    commands.setNodeCoord('anchor', 1, 5);
    expect(sub(store, 'p').nodes[1].pt).toEqual([12, 5]);
  });

  it('creates a handle that does not exist yet', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    expect(sub(store, 'p').nodes[1].hOut).toBe(null);
    selectNodes(store, 'p', 1);
    commands.setNodeCoord('out', 1, -10);
    const h = sub(store, 'p').nodes[1].hOut;
    expect(h).not.toBe(null);
    // The axis asked for is the one typed; the other comes from where the
    // hollow ghost already sat.
    expect(h![1]).toBe(-10);
  });

  it('ignores a value that is not a number', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1);
    commands.setNodeCoord('anchor', 0, Number.NaN);
    expect(sub(store, 'p').nodes[1].pt).toEqual([40, 0]);
  });

  it('does nothing unless exactly one node is selected', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    commands.setNodeCoord('anchor', 0, 12);
    expect(sub(store, 'p').nodes[1].pt).toEqual([40, 0]);
    expect(sub(store, 'p').nodes[2].pt).toEqual([40, 40]);
  });
});

describe('what the inspector counts', () => {
  it('counts a whole shape’s nodes when the shape is what is selected', () => {
    const { store, commands } = editor(withShapes(['a', SQUARE], ['b', ELL]));
    select(store, 'a');
    expect(commands.selectionCount()).toBe(4);
    select(store, 'a', 'b');
    expect(commands.selectionCount()).toBe(8);
  });

  it('counts a shape and one of its own nodes once, not twice', () => {
    /* The two branches answer by different routes -- a sum for shapes alone, a
       deduped list once a node is named -- and this is the case that separates
       them. A fixture selecting only shapes, or only nodes, cannot. */
    const { store, commands } = editor(withShapes(['a', SQUARE]));
    store.update((s) => {
      s.selection.shapes.add(s.doc.shapes[0].id);
      s.selection.nodes.add(s.doc.shapes[0].subpaths[0].nodes[0].id);
    });
    expect(commands.selectionCount()).toBe(4);
  });

  it('names the single selected node, and nothing when there are two', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 2);
    const one = commands.singleSelectedNode();
    expect(one?.node.pt).toEqual([40, 40]);
    expect(one?.ref.i).toBe(2);
    selectNodes(store, 'p', 1, 2);
    expect(commands.singleSelectedNode()).toBe(null);
  });

  it('counts nodes and segments over the whole drawing', () => {
    /* Closed and open together, because a closed subpath has as many segments
       as nodes and an open one has one fewer. With only closed shapes the two
       counts agree and either could stand in for the other. */
    const { commands } = editor(withShapes(['sq', SQUARE], ['l', ELL]));
    expect(commands.countNodes()).toBe(8);
    expect(commands.countSegments()).toBe(7);
  });
});

describe('the active segment and its bend', () => {
  it('names the one segment both of whose ends are selected', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    expect(commands.activeSegment()).toMatchObject({ sp: 0, seg: 1 });
  });

  it('names nothing when two segments qualify', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 1, 2);
    expect(commands.activeSegment()).toBe(null);
  });

  it('names nothing for a single node, which is half a segment', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1);
    expect(commands.activeSegment()).toBe(null);
  });

  it('sets the bend it is given, and reads it back', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 1);
    commands.setActiveBend({ angle: 30, looseness: 1.2 });
    const bend = segmentBend(sub(store, 'p'), 0);
    expect(bend!.angle).toBeCloseTo(30, 6);
    expect(bend!.looseness).toBeCloseTo(1.2, 6);
  });

  it('does nothing when no one segment is active', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 1, 2);
    commands.setActiveBend({ angle: 30, looseness: 1.2 });
    expect(segmentIsLine(sub(store, 'p'), 0)).toBe(true);
  });

  it('nudges the angle and holds looseness at the floor', () => {
    /* A straight segment reads as angle 0, looseness 1, so a nudge of -5 asks
       for -4 and must arrive at the floor instead. The floor is module-private
       on purpose; what is asserted here is that this method goes through the
       clamp rather than writing the sum. */
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 1);
    commands.adjustBend(15, -5);
    const bend = segmentBend(sub(store, 'p'), 0);
    expect(bend!.angle).toBeCloseTo(15, 6);
    expect(bend!.looseness).toBeCloseTo(clampLooseness(1 - 5), 9);
  });

  it('leaves bend mode by making the two handles genuinely unequal', () => {
    /* Away from the origin on purpose. The handle is written as
       `pt + (hOut - pt) * 1.001`, and at `pt = [0, 0]` that is
       `0 + (h - 0)` -- indistinguishable from `0 + (h + 0)`, so the subtraction
       inside the brackets can be flipped and nothing moves. Every fixture in
       this file starts at the origin, which is exactly the shape §Testing
       philosophy warns about. */
    const { store, commands } = editor(withShapes(['p', 'M17 23 H57 V63 H97']));
    selectNodes(store, 'p', 0, 1);
    commands.setActiveBend({ angle: 30, looseness: 1 });
    expect(segmentBend(sub(store, 'p'), 0)).not.toBe(null);
    const before = sub(store, 'p').nodes[0].hOut!.slice() as [number, number];

    commands.freeActiveSegment();
    expect(segmentBend(sub(store, 'p'), 0)).toBe(null);
    expect(segmentIsLine(sub(store, 'p'), 0)).toBe(false);

    /* And how far it moved, which is the half that matters. The method's whole
       argument is that a tenth of a percent is below what the eye can see and
       above what `bendOf` calls symmetric, so "the bend is gone" is true of any
       displacement at all and says nothing about this one. */
    const after = sub(store, 'p').nodes[0].hOut!;
    const anchor = sub(store, 'p').nodes[0].pt;
    const reach = Math.hypot(before[0] - anchor[0], before[1] - anchor[1]);
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1]);
    expect(moved).toBeCloseTo(reach * 0.001, 9);
  });

  it('does not leave bend mode on a segment that was never in it', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    // Free handles: an `hOut` with no matching `hIn` is not a bend.
    store.edit((s) => (s.doc.shapes[0].subpaths[0].nodes[1].hOut = [50, 10]));
    const before = sub(store, 'p').nodes[1].hOut!.slice();
    commands.freeActiveSegment();
    expect(sub(store, 'p').nodes[1].hOut).toEqual(before);
  });
});

describe('sliding a node along the curve it splits', () => {
  /** A cubic split in two, which is the shape a slid node lives on. */
  const split = (): { store: Store; commands: Commands; arc: Cubic } => {
    const e = editor(withShapes(['p', ARC]));
    const arc = segmentAsCubic(e.store.state.doc.shapes[0].subpaths[0], 0);
    selectNodes(e.store, 'p', 0, 1);
    e.commands.insertInSelection();
    return { store: e.store, commands: e.commands, arc };
  };

  it('names the middle node’s parent curve', () => {
    const { store, commands } = split();
    selectNodes(store, 'p', 1);
    expect(commands.activeSlide()?.ref.i).toBe(1);
  });

  it('names nothing for an end of an open path', () => {
    const { store, commands } = split();
    selectNodes(store, 'p', 0);
    expect(commands.activeSlide()).toBe(null);
  });

  it('names nothing for a whole shape or for two nodes', () => {
    const { store, commands } = split();
    select(store, 'p');
    expect(commands.activeSlide()).toBe(null);
    selectNodes(store, 'p', 0, 1);
    expect(commands.activeSlide()).toBe(null);
  });

  it('puts the node where the percentage says, on the curve it came from', () => {
    /* Against the parent's own parameter, not against a cloud of samples. The
       node splits `ARC` in two and the split was exact, so the curve it slides
       along is `ARC` and 25% of it is `cubicAt(arc, 0.25)` to float error. A
       sampled comparison would accept anything within about 0.04 of that. */
    const { store, commands, arc } = split();
    selectNodes(store, 'p', 1);
    commands.slideActiveTo(25);

    const moved = sub(store, 'p').nodes[1].pt;
    const want = cubicAt(arc, 0.25);
    expect(Math.hypot(moved[0] - want[0], moved[1] - want[1])).toBeLessThan(1e-6);
    // And a quarter along rather than the half it was split at.
    expect(moved[0]).toBeLessThan(20);
  });

  it('holds the node clear of the end it was sent to', () => {
    /* Zero percent is a node on top of its neighbour, which is the zero-length
       segment nothing can simplify again. `clampSlide` is what stops it, and it
       is the same margin the drag obeys. */
    const { store, commands } = split();
    selectNodes(store, 'p', 1);
    commands.slideActiveTo(0);
    const sp = sub(store, 'p');
    const gap = Math.hypot(sp.nodes[1].pt[0] - sp.nodes[0].pt[0], sp.nodes[1].pt[1] - sp.nodes[0].pt[1]);
    expect(gap).toBeGreaterThan(0);
  });

  it('does nothing when nothing can slide', () => {
    const { store, commands } = split();
    selectNodes(store, 'p', 0);
    const before = sub(store, 'p').nodes[0].pt.slice();
    commands.slideActiveTo(50);
    expect(sub(store, 'p').nodes[0].pt).toEqual(before);
  });
});

describe('curving and straightening the selected segments', () => {
  it('curves only the segment whose two ends are both selected', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    commands.setSelectedSegmentsCurved(true);

    const sp = sub(store, 'p');
    expect(segmentIsLine(sp, 1)).toBe(false);
    // The segments trailing off either end have one selected node each, which
    // is not enough to say which segment was meant.
    expect(segmentIsLine(sp, 0)).toBe(true);
    expect(segmentIsLine(sp, 2)).toBe(true);
  });

  it('straightens the same segment back', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    commands.setSelectedSegmentsCurved(true);
    commands.setSelectedSegmentsCurved(false);
    expect(segmentIsLine(sub(store, 'p'), 1)).toBe(true);
  });

  it('curves every segment of a shape that is selected whole', () => {
    const { store, commands } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    commands.setSelectedSegmentsCurved(true);
    const sp = sub(store, 'p');
    expect([0, 1, 2, 3].every((i) => !segmentIsLine(sp, i))).toBe(true);
  });

  it('does nothing with no nodes named', () => {
    const { store, commands } = editor(withShapes(['p', ELL]));
    commands.setSelectedSegmentsCurved(true);
    expect(segmentIsLine(sub(store, 'p'), 1)).toBe(true);
  });
});

describe('tracing the backdrop', () => {
  /** Two flat colours side by side, which is what this tracer is for. */
  const raster = (): { data: number[]; width: number; height: number } => {
    const w = 12;
    const h = 12;
    const data: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) data.push(x < 6 ? 255 : 0, 0, x < 6 ? 0 : 255, 255);
    }
    return { data, width: w, height: h };
  };

  const withBackdrop = (): ReturnType<typeof editor> => {
    const e = editor(emptyDoc());
    e.store.update((s) => {
      s.backdrop = {
        src: 'data:,',
        name: 'ref.png',
        x: 4,
        y: 8,
        w: 24,
        h: 24,
        naturalW: 12,
        naturalH: 12,
        opacity: 1,
        visible: true,
        locked: true,
      };
    });
    return e;
  };

  it('traces the image into shapes at the backdrop’s placement', () => {
    const { store, commands, said } = withBackdrop();
    expect(commands.traceBackdrop(raster(), { colours: 4, tolerance: 1, minPoints: 4 })).toBe(true);

    expect(store.state.doc.shapes.length).toBeGreaterThan(0);
    expect(said()!.ok).toBe(true);
    expect(said()!.message).toMatch(/^Traced \d+ colours? into \d+ paths?: \d+ nodes fitted to \d+\.$/);

    /* The placement it traced into is the backdrop's, not the image's pixel
       box. A tracer wired to the raster's own 12 by 12 would put every shape in
       the top-left corner, and every assertion about shape count would pass. */
    const xs = store.state.doc.shapes.flatMap((sh) =>
      sh.subpaths.flatMap((sp) => sp.nodes.map((n) => n.pt[0])),
    );
    const ys = store.state.doc.shapes.flatMap((sh) =>
      sh.subpaths.flatMap((sp) => sp.nodes.map((n) => n.pt[1])),
    );
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(4 - 1e-6);
    expect(Math.max(...xs)).toBeLessThanOrEqual(28 + 1e-6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(8 - 1e-6);
    expect(Math.max(...ys)).toBeLessThanOrEqual(32 + 1e-6);
  });

  it('refuses with no backdrop loaded', () => {
    const { store, commands, said } = editor(emptyDoc());
    expect(commands.traceBackdrop(raster(), { colours: 4, tolerance: 1, minPoints: 4 })).toBe(false);
    expect(store.state.doc.shapes).toHaveLength(0);
    expect(said()).toEqual({ message: 'Load an image in the Backdrop panel first.', ok: false });
  });

  it('says so when every region fell below the noise floor', () => {
    const { store, commands, said } = withBackdrop();
    expect(commands.traceBackdrop(raster(), { colours: 4, tolerance: 1, minPoints: 9999 })).toBe(
      false,
    );
    expect(store.state.doc.shapes).toHaveLength(0);
    expect(said()!.message).toMatch(/noise floor/);
  });
});

/* ------------------------------------------------------------------------ *
 * The sentences.
 *
 * 29 of the 249 survivors sat inside a message and 64 on the boolean beside
 * one, because the tests that ran these methods read the document alone. What
 * a refusal SAYS is the whole of what separates two refusals that both return
 * `false` and both leave the drawing exactly as it was.
 *
 * `scratchpad/msgcheck.mjs` in the review of 2026-08-21c is what found them:
 * it lists every string this class writes and greps `test/` for it. 42 of 105
 * were asserted by nothing.
 * ------------------------------------------------------------------------ */

describe('placing a guide by number', () => {
  it('places one and turns the guides on', () => {
    const { store, commands, said } = editor(emptyDoc());
    store.update((s) => (s.showGuides = false));
    expect(commands.addGuideAt('x', 12.5)).toBe(true);
    expect(store.state.guides).toEqual([{ axis: 'x', at: 12.5 }]);
    // Placing one you cannot see would be the same as not placing it.
    expect(store.state.showGuides).toBe(true);
    expect(said()).toEqual({ message: 'Guide at x = 12.5.', ok: true });
  });

  it('refuses a second guide on the same line, and says which line', () => {
    const { store, commands, said } = editor(emptyDoc());
    commands.addGuideAt('y', 40);
    expect(commands.addGuideAt('y', 40)).toBe(false);
    expect(store.state.guides).toHaveLength(1);
    expect(said()).toEqual({ message: 'There is already a guide at y = 40.', ok: false });
    // The same number on the other axis is a different line.
    expect(commands.addGuideAt('x', 40)).toBe(true);
  });
});

describe('what breaking a path says', () => {
  it('names the two pieces when the path was open', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1);
    expect(commands.breakAtSelection()).toBe(true);
    expect(sub(store, 'p').nodes).toHaveLength(2);
    expect(named(store.state.doc, 'p')!.subpaths).toHaveLength(2);
    expect(said()).toEqual({ message: 'Broke the path into two.', ok: true });
  });

  it('refuses a node that is already an end', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0);
    expect(commands.breakAtSelection()).toBe(false);
    expect(named(store.state.doc, 'p')!.subpaths).toHaveLength(1);
    expect(said()).toEqual({ message: 'That node already ends the path.', ok: false });
  });

  it('refuses anything but exactly one node', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    expect(commands.breakAtSelection()).toBe(false);
    expect(said()).toEqual({ message: 'Break needs exactly one node selected.', ok: false });
  });
});

describe('what joining two ends says', () => {
  /** Two open paths whose near ends are a short way apart. */
  const twoEnds = (): Doc => withShapes(['a', 'M0 0 H20'], ['b', 'M30 0 H50']);

  const pickEnds = (store: Store): void =>
    store.update((s) => {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
      s.selection.nodes.add(named(s.doc, 'a')!.subpaths[0].nodes[1].id);
      s.selection.nodes.add(named(s.doc, 'b')!.subpaths[0].nodes[0].id);
    });

  it('names the segment it drew when connecting', () => {
    const { store, commands, said } = editor(twoEnds());
    pickEnds(store);
    expect(commands.joinSelection('connect')).toBe(true);
    expect(store.state.doc.shapes).toHaveLength(1);
    expect(said()).toEqual({ message: 'Connected the two ends with a segment.', ok: true });
  });

  it('names the weld when merging, which is the other operation', () => {
    /* Same selection, same `true`, one shape either way. The two differ by a
       node -- connect keeps both ends, merge makes them one -- and by the
       sentence, which is what tells you which button you pressed. */
    const { store, commands, said } = editor(twoEnds());
    pickEnds(store);
    expect(commands.joinSelection('merge')).toBe(true);
    expect(said()).toEqual({ message: 'Merged the two ends into one node.', ok: true });
    expect(named(store.state.doc, 'a')!.subpaths[0].nodes).toHaveLength(3);
  });

  it('says the path closed when both ends are its own', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 3);
    expect(commands.joinSelection('connect')).toBe(true);
    expect(sub(store, 'p').closed).toBe(true);
    expect(said()).toEqual({ message: 'Closed the path.', ok: true });
  });

  it('refuses to close a path with too few nodes to draw one', () => {
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H20']));
    selectNodes(store, 'p', 0, 1);
    expect(commands.joinSelection('merge')).toBe(false);
    expect(sub(store, 'p').closed).toBe(false);
    expect(said()).toEqual({ message: 'That path is too short to close.', ok: false });
  });

  it('names the verb the caller asked for when the count is wrong', () => {
    // One method, two buttons. The refusal has to name the one that was pressed.
    const { store, commands, said } = editor(twoEnds());
    selectNodes(store, 'a', 0);
    expect(commands.joinSelection('merge')).toBe(false);
    expect(said()!.message).toBe('Merge needs exactly two nodes selected.');
    expect(commands.joinSelection('connect')).toBe(false);
    expect(said()!.message).toBe('Connect needs exactly two nodes selected.');
  });

  it('refuses two nodes that are not free ends', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1, 2);
    expect(commands.joinSelection('connect')).toBe(false);
    expect(said()!.message).toBe(
      'Connect needs two free ends. Both nodes have to start or finish an open path.',
    );
  });

  it('refuses a pair where only one of the two is a free end', () => {
    /* The fixture the `||` in that guard needs. With two interior nodes the
       test above passes under `&&` as well, because both halves are true; only
       a mixed pair separates "either is not an end" from "neither is". */
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0, 2);
    expect(commands.joinSelection('connect')).toBe(false);
    expect(named(store.state.doc, 'p')!.subpaths[0].closed).toBe(false);
    expect(said()!.message).toBe(
      'Connect needs two free ends. Both nodes have to start or finish an open path.',
    );
  });
});

describe('what simplify and keep say', () => {
  it('refuses a tolerance that is not a number', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    expect(commands.simplifySelection(Number.NaN)).toBe(false);
    expect(said()).toEqual({
      message: 'Within has to be a number, and not a negative one.',
      ok: false,
    });
    expect(commands.simplifySelection(-1)).toBe(false);
  });

  it('tells you to raise Within when a positive tolerance gave up nothing', () => {
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H40']));
    select(store, 'p');
    expect(commands.simplifySelection(0.5)).toBe(false);
    expect(said()).toEqual({
      message: 'Nothing to simplify. Raise Within to give up more of the shape.',
      ok: false,
    });
  });

  it('says something different at a tolerance of zero', () => {
    /* Zero is not a refusal, it is "move nothing", so the sentence has to
       explain that every node is load-bearing rather than that nothing fitted.
       Both branches return `false` and leave the path alone. */
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H40']));
    select(store, 'p');
    expect(commands.simplifySelection(0)).toBe(false);
    expect(said()).toEqual({
      message: 'Every node here is carrying the shape. Raise Within to remove some anyway.',
      ok: false,
    });
  });

  it('refuses fewer than two nodes to keep', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    selectNodes(store, 'p', 0);
    expect(commands.keepSelectedNodes()).toBe(false);
    expect(said()).toEqual({
      message: 'Select the nodes to keep. Two is the fewest a path can have.',
      ok: false,
    });
  });

  it('says nothing else could go when the selection is the whole path', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    selectNodes(store, 'p', 0, 1, 2, 3);
    expect(commands.keepSelectedNodes()).toBe(false);
    expect(sub(store, 'p').nodes).toHaveLength(4);
    expect(said()).toEqual({ message: 'Nothing else could go.', ok: false });
  });
});

describe('what rounding, reversing and ordering say', () => {
  it('refuses a radius of zero or less', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    expect(commands.roundSelection(0)).toBe(false);
    expect(said()).toEqual({ message: 'Round needs a radius above zero.', ok: false });
    expect(commands.roundSelection(-3)).toBe(false);
  });

  it('refuses to round with nothing selected', () => {
    const { commands, said } = editor(withShapes(['p', SQUARE]));
    expect(commands.roundSelection(4)).toBe(false);
    expect(said()).toEqual({
      message: 'Select a shape, or some of its nodes, to round.',
      ok: false,
    });
  });

  it('counts the subpaths it reversed', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    const first = sub(store, 'p').nodes[0].pt;
    expect(commands.reverseSelection()).toBe(true);
    // Turned round: the node after the first is the one that used to be last.
    expect(sub(store, 'p').nodes[0].pt).toEqual(first);
    expect(sub(store, 'p').nodes[1].pt).toEqual([0, 40]);
    expect(said()).toEqual({ message: 'Reversed 1 subpath.', ok: true });
  });

  it('says subpaths rather than subpath for more than one', () => {
    const { store, commands, said } = editor(withShapes(['a', SQUARE], ['b', ELL]));
    select(store, 'a', 'b');
    expect(commands.reverseSelection()).toBe(true);
    expect(said()!.message).toBe('Reversed 2 subpaths.');
  });

  it('refuses to reverse with nothing selected', () => {
    const { commands, said } = editor(withShapes(['p', SQUARE]));
    expect(commands.reverseSelection()).toBe(false);
    expect(said()).toEqual({ message: 'Select a shape or some nodes to reverse.', ok: false });
  });

  it('refuses to reorder with nothing selected', () => {
    const { commands, said } = editor(withShapes(['p', SQUARE]));
    expect(commands.reorderSelection('front')).toBe(false);
    expect(said()).toEqual({ message: 'Order needs a shape selected.', ok: false });
  });
});

describe('what fitting the canvas says', () => {
  it('gives the new canvas in the units the drawing is in', () => {
    const doc = withShapes(['p', 'M10 10 H50 V30 H10 Z']);
    doc.viewBox = { x: 0, y: 0, w: 200, h: 200 };
    const { store, commands, said } = editor(doc);
    expect(commands.fitCanvasToDrawing()).toBe(true);
    const vb = store.state.doc.viewBox;
    expect(vb.w).toBeGreaterThan(0);
    expect(said()!.ok).toBe(true);
    expect(said()!.message).toBe(
      `Canvas is now ${vb.w} × ${vb.h} at ${vb.x}, ${vb.y}.`,
    );
  });

  it('says the canvas already fits when it does', () => {
    const doc = withShapes(['p', 'M10 10 H50 V30 H10 Z']);
    doc.viewBox = { x: 0, y: 0, w: 200, h: 200 };
    const { store, commands, said } = editor(doc);
    commands.fitCanvasToDrawing();
    const vb = { ...store.state.doc.viewBox };
    expect(commands.fitCanvasToDrawing()).toBe(false);
    expect(store.state.doc.viewBox).toEqual(vb);
    expect(said()).toEqual({ message: 'The canvas already fits the drawing.', ok: false });
  });

  it('says so with nothing drawn', () => {
    const { commands, said } = editor(emptyDoc());
    expect(commands.fitCanvasToDrawing()).toBe(false);
    expect(said()).toEqual({
      message: 'Nothing drawn yet, so there is nothing to fit the canvas to.',
      ok: false,
    });
  });
});

describe('what arranging says when it cannot', () => {
  it('asks for two shapes to align to each other and one to align to the canvas', () => {
    /* Two different floors behind one `false`, and the sentence is what says
       which one you hit. Aligning one shape to the canvas is a real operation;
       aligning one shape to itself is not. */
    const { store, commands, said } = editor(withShapes(['a', SQUARE]));
    select(store, 'a');
    expect(commands.alignShapes('left', 'selection')).toBe(false);
    expect(said()).toEqual({ message: 'Align needs two shapes selected.', ok: false });

    expect(commands.alignShapes('left', 'canvas')).toBe(true);

    store.update((s) => s.selection.shapes.clear());
    expect(commands.alignShapes('left', 'canvas')).toBe(false);
    expect(said()).toEqual({ message: 'Align needs a shape selected.', ok: false });
  });

  it('asks for three shapes to distribute and two to space', () => {
    const { store, commands, said } = editor(withShapes(['a', SQUARE], ['b', 'M60 0 H100 V40 Z']));
    select(store, 'a', 'b');
    expect(commands.distributeShapes('left', 'selection')).toBe(false);
    expect(said()).toEqual({ message: 'Distribute needs three shapes selected.', ok: false });

    select(store, 'a');
    expect(commands.spaceShapes('h', 'selection', 10)).toBe(false);
    expect(said()).toEqual({ message: 'Spacing needs two shapes selected.', ok: false });
  });
});

describe('what continuity says when it changes nothing', () => {
  it('explains that symmetric is already smooth', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1);
    commands.setSelectedContinuity('symmetric');
    commands.setSelectedContinuity('smooth');
    expect(said()).toEqual({
      message: 'Already smooth. Symmetric is smooth with equal handle lengths; drag one to differ.',
      ok: true,
    });
  });

  it('explains that an end of a path has only one handle', () => {
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 0);
    commands.setSelectedContinuity('smooth');
    expect(said()).toEqual({
      message: 'That node ends the path. There is no second handle to line up with.',
      ok: false,
    });
  });

  it.each([
    ['cusp', 'Already a cusp.'],
    ['smooth', 'Already smooth.'],
    ['symmetric', 'Already symmetric.'],
  ] as [NodeContinuity, string][])('names %s when the node already is', (kind, message) => {
    /* All three words of the ternary. One of them tested is one branch tested,
       and the other two can then say anything at all.

       `smooth` needs the awkward fixture: setting it on a bare node produces
       equal handles, which reads back as symmetric and lands in the sentence
       above rather than this one. So one handle is stretched first, which is
       smooth and not symmetric, and is what the word actually names. */
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 1);
    commands.setSelectedContinuity(kind);
    if (kind === 'smooth') {
      store.edit((st) => {
        const n = st.doc.shapes[0].subpaths[0].nodes[1];
        n.hOut = [n.pt[0] + (n.hOut![0] - n.pt[0]) * 2, n.pt[1] + (n.hOut![1] - n.pt[1]) * 2];
      });
    }
    commands.setSelectedContinuity(kind);
    expect(said()).toEqual({ message, ok: true });
  });

  it('explains the far end of the path as well as the near one', () => {
    /* `r.i === 0 || r.i === sp.nodes.length - 1` is two ends, and a fixture at
       node 0 leaves the second half of it saying whatever it likes. */
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    selectNodes(store, 'p', 3);
    commands.setSelectedContinuity('smooth');
    expect(said()).toEqual({
      message: 'That node ends the path. There is no second handle to line up with.',
      ok: false,
    });
  });
});

describe('what copy and cut say when they cannot', () => {
  it('asks for a run rather than a lone node', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    selectNodes(store, 'p', 0);
    expect(commands.copySelection()).toBe(false);
    expect(said()).toEqual({
      message: 'Copy needs two nodes next to each other on a path, or a whole shape.',
      ok: false,
    });
  });

  it('takes the shape away and leaves it on the clipboard', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    expect(commands.cutSelection()).toBe(true);
    expect(store.state.doc.shapes).toHaveLength(0);
    expect(commands.canPaste).toBe(true);
    expect(said()).toEqual({ message: 'Cut.', ok: true });
  });

  it('refuses a cut for the same reason a copy is refused', () => {
    // Cut is copy then delete, so a copy that cannot happen stops it first and
    // the sentence is the copy's, not a second one saying the same thing.
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    selectNodes(store, 'p', 0);
    expect(commands.cutSelection()).toBe(false);
    expect(store.state.doc.shapes).toHaveLength(1);
    expect(said()!.message).toMatch(/^Copy needs two nodes/);
  });

  /* `Copied, but nothing could be removed.` is deliberately not tested, because
     nothing can reach it. It needs `deleteSelection` to report zero deleted
     after a copy succeeded, and `deleteNode` refuses only an index outside the
     array -- which `selectedRefs` cannot hand it, since every ref it returns is
     a position it just read. §Class 6 of `docs/reviews/2026-08-21c.md`. */
});

describe('the last of the sentences', () => {
  it('refuses a node count below two', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    expect(commands.simplifyToCount(1)).toBe(false);
    expect(sub(store, 'p').nodes).toHaveLength(4);
    expect(said()).toEqual({
      message: 'Keep how many? Two is the fewest a path can have.',
      ok: false,
    });
  });

  it('reports what a simplify gave up and how far it moved', () => {
    /* The success sentence, which is three numbers: how many paths, the node
       count either side, and the worst displacement. Nothing read it, so the
       `+` joining its two halves was a survivor and would have shipped `NaN`. */
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 L10 0.2 L20 0 L30 0.2 L40 0']));
    select(store, 'p');
    expect(commands.simplifySelection(1)).toBe(true);
    const left = sub(store, 'p').nodes.length;
    expect(left).toBeLessThan(5);
    expect(said()!.ok).toBe(true);
    expect(said()!.message).toBe(
      `Simplified 1 path: 5 nodes to ${left}. Nothing moved further than 0.2.`,
    );
  });

  it('says a second round at the same radius changed nothing, and calls it a success', () => {
    /* Not a refusal: every corner it was asked to cut is already cut. The `true`
       and the sentence go together, and the branch below it says the opposite
       with the same `done === 0`. */
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    expect(commands.roundSelection(5)).toBe(true);
    const after = sub(store, 'p').nodes.length;

    select(store, 'p');
    expect(commands.roundSelection(5)).toBe(true);
    expect(sub(store, 'p').nodes).toHaveLength(after);
    expect(said()).toEqual({ message: 'Already rounded to r 5.', ok: true });
  });

  it('refuses to land a trace mid-drag', () => {
    const store = new Store(emptyDoc());
    const commands = new Commands(store, () => true);
    let last: { message: string; ok: boolean } | null = null;
    commands.onMessage = (message, ok) => (last = { message, ok });
    store.update((s) => {
      s.backdrop = {
        src: 'data:,', name: 'ref.png', x: 0, y: 0, w: 20, h: 10,
        naturalW: 40, naturalH: 20, opacity: 1, visible: true, locked: true,
      };
    });
    const r = { shapes: [shapeFromPath('M0 0 H5 V5 H0 Z')], paths: 1, nodesBefore: 8, nodesAfter: 4, colours: 1 };
    expect(commands.applyTrace(r, { x: 0, y: 0, w: 20, h: 10 })).toBe(false);
    expect(store.state.doc.shapes).toHaveLength(0);
    expect(last).toEqual({ message: 'Finish the drag first, then trace.', ok: false });
  });

  it('refuses to fuse a path with nothing left to fuse into', () => {
    // A closed path of two nodes: neither is an end, they are adjacent, and
    // welding them would leave one node, which draws nothing.
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H40 Z']));
    selectNodes(store, 'p', 0, 1);
    expect(commands.fuseSelection()).toBe(false);
    expect(sub(store, 'p').nodes).toHaveLength(2);
    expect(said()).toEqual({
      message: 'That path is too short to fuse. Two nodes is the least that draws.',
      ok: false,
    });
  });

  it('says so when an offset produced nothing', () => {
    /* Inside a small shape by more than its own half-width: every subpath
       collapses, so there is nothing to add. A different sentence from the
       zero-distance refusal above, and the same `false`. */
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H4 V4 H0 Z']));
    select(store, 'p');
    expect(commands.offsetSelection(-20)).toBe(false);
    expect(store.state.doc.shapes).toHaveLength(1);
    expect(said()).toEqual({ message: 'Nothing there could be offset.', ok: false });
  });
});

describe('the branches that cannot be reached, and the one that can', () => {
  /**
   * Five of this class's 105 sentences are asserted by nothing, because nothing
   * can reach them: each guards an assumption about another module rather than
   * about the caller, and the guards it would have to get past are the same
   * ones the method already applies. A mutation survivor at any of the five is
   * explained rather than open. `docs/reviews/2026-08-21c.md` lists them with
   * the mechanism for each.
   */

  it('says an outline came apart when the stroke is wider than the shape', () => {
    // The sixth, which is reachable: offsetting inward by half of 40 collapses
    // a 6-wide square, so there is no inner contour to make a band from.
    const doc = withShapes(['sq', 'M0 0 H6 V6 H0 Z']);
    doc.shapes[0].style = { ...doc.shapes[0].style, stroke: '#f00', strokeWidth: 40 };
    const { store, commands, said } = editor(doc);
    select(store, 'sq');
    expect(commands.strokeToPath('butt')).toBe(false);
    expect(named(store.state.doc, 'sq')!.subpaths).toHaveLength(1);
    expect(said()).toEqual({
      message: 'That outline comes apart; nothing was changed.',
      ok: false,
    });
  });

  it('names the noise floor exactly, not just in passing', () => {
    const { store, commands, said } = editor(emptyDoc());
    store.update((s) => {
      s.backdrop = {
        src: 'data:,', name: 'ref.png', x: 0, y: 0, w: 20, h: 10,
        naturalW: 40, naturalH: 20, opacity: 1, visible: true, locked: true,
      };
    });
    const empty = { shapes: [], paths: 0, nodesBefore: 0, nodesAfter: 0, colours: 0 };
    expect(commands.applyTrace(empty, { x: 0, y: 0, w: 20, h: 10 })).toBe(false);
    expect(said()).toEqual({
      message: 'Nothing to trace. Every region was smaller than the noise floor.',
      ok: false,
    });
  });
});

/* ------------------------------------------------------------------------ *
 * The survivors that were real.
 *
 * Reading the 98 that came through the sweep of 2026-08-21c sorted them in
 * two. Most are guards on lookups that cannot fail, and no test can reach
 * those. The rest are these: arithmetic and sentences that nothing had ever
 * exercised, each found by a mutation nothing disagreed with.
 * ------------------------------------------------------------------------ */

describe('the arithmetic nothing had checked', () => {
  it('nudges along both axes, not only the one a test happened to use', () => {
    /* `moveAnchor(sp, i, [pt[0] + d[0], pt[1] + d[1]])` is two additions, and
       `repeat.test.ts` nudges by `[20, 0]`, which pins the first and leaves the
       second free to be a subtraction. */
    const { store, commands } = editor(withShapes(['p', SQUARE]));
    select(store, 'p');
    commands.nudge([3, 7]);
    expect(sub(store, 'p').nodes[0].pt).toEqual([3, 7]);
    commands.nudge([-1, -2]);
    expect(sub(store, 'p').nodes[0].pt).toEqual([2, 5]);
  });

  it('turns the whole drawing about the average of its points when nothing is selected', () => {
    /* The branch with no selection box, which averages every node instead.
       Both halves of that average were survivors, because every other test of
       `applyTransform` has something selected and takes the other branch.

       A triangle and a square, so the two shapes contribute 3 nodes and 4. The
       average of the points and the centre of the bounding box then differ,
       and a fixture of two rectangles cannot tell those apart however
       asymmetrically it is placed. */
    const { store, commands } = editor(withShapes(['a', 'M0 0 H10 V10 Z'], ['b', 'M50 0 H60 V10 H50 Z']));
    const all = (): [number, number][] =>
      store.state.doc.shapes.flatMap((sh) =>
        sh.subpaths.flatMap((sp) => sp.nodes.map((n) => [n.pt[0], n.pt[1]] as [number, number])),
      );
    const before = all();
    const cx = before.reduce((a, p) => a + p[0], 0) / before.length;
    const cy = before.reduce((a, p) => a + p[1], 0) / before.length;
    expect(cx).not.toBeCloseTo(30, 6); // and so not the box centre either

    commands.applyTransform('rotate', 180);
    // A half turn about a point sends p to 2c - p, node for node.
    all().forEach((p, i) => {
      expect(p[0]).toBeCloseTo(2 * cx - before[i][0], 6);
      expect(p[1]).toBeCloseTo(2 * cy - before[i][1], 6);
    });
  });

  it('falls back to a step of one when the grid is off', () => {
    /* `s.gridStep || 1` in two places. With the grid at its default of 1 the
       fallback and the value agree, so only a grid of 0 separates them -- and
       a duplicate that lands exactly under its original is the symptom §46
       exists to prevent being invisible. */
    const { store, commands } = editor(withShapes(['p', SQUARE]));
    store.update((s) => (s.gridStep = 0));
    select(store, 'p');
    expect(commands.duplicateSelection()).toBe(true);

    const copy = store.state.doc.shapes[1];
    expect(copy.subpaths[0].nodes[0].pt).toEqual([2, 2]);
  });

  it('fits to a lattice of one when the grid is off', () => {
    // `s.gridStep > 0 ? s.gridStep : 1`, which is the same fallback again and
    // reads 0 rather than 1 if the comparison is loosened.
    const doc = withShapes(['sq', 'M0.3 0.3 H40.3 V40.3 H0.3 Z']);
    doc.shapes[0].style = { ...doc.shapes[0].style, stroke: '#000', strokeWidth: 2 };
    const { store, commands } = editor(doc);
    store.update((s) => (s.gridStep = 0));
    select(store, 'sq');
    expect(commands.fitToPixels()).toBe(true);
    expect(sub(store, 'sq').nodes[0].pt).toEqual([0, 0]);
  });
});

describe('the sentences whose numbers nothing had checked', () => {
  it('counts the corners a round could not cut', () => {
    /* `Skipped n.` is a sum across three refusal reasons, and it was never
       read. A closed square has four corners and refuses none, so the sum is
       zero there and any arithmetic at all produces the same sentence. An OPEN
       path is the fixture that reaches it: its two end nodes have one segment
       each and no corner to cut, so two are rounded and two are refused. */
    const { store, commands, said } = editor(withShapes(['p', ELL]));
    select(store, 'p');
    expect(commands.roundSelection(5)).toBe(true);
    expect(said()!.message).toBe('Rounded 2 corners to r 5. Skipped 2.');
  });

  it('says nothing about skipping when nothing was skipped', () => {
    const { store, commands, said } = editor(withShapes(['p', 'M0 0 H40 V40 H0 Z']));
    select(store, 'p');
    expect(commands.roundSelection(5)).toBe(true);
    expect(said()!.message).toBe('Rounded 4 corners to r 5.');
  });

  it('says corner rather than corners for one', () => {
    const { store, commands, said } = editor(withShapes(['p', SQUARE]));
    selectNodes(store, 'p', 0);
    expect(commands.roundSelection(5)).toBe(true);
    expect(said()!.message).toBe('Rounded 1 corner to r 5.');
  });

  it('names the fill rule the surviving shape kept', () => {
    /* `keep.style.fillRule === 'evenodd' ? 'Even-odd' : 'Nonzero'`, and every
       fixture until now used the default, which is the other branch. */
    const doc = withShapes(['a', SQUARE], ['b', 'M10 10 H30 V30 H10 Z']);
    doc.shapes[0].style = { ...doc.shapes[0].style, fillRule: 'evenodd' };
    const { store, commands } = editor(doc);
    select(store, 'a', 'b');
    const r = commands.makeOneShape();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/The rule is Even-odd\.$/);
  });

  it('warns when the shapes it merged did not look alike', () => {
    /* Three style fields joined by `||`. A fixture differing in all three
       passes with any one of them deleted, so each is varied on its own. */
    const differing = (patch: Record<string, unknown>): string => {
      const doc = withShapes(['a', SQUARE], ['b', 'M10 10 H30 V30 H10 Z']);
      doc.shapes[1].style = { ...doc.shapes[1].style, ...patch };
      const { store, commands } = editor(doc);
      select(store, 'a', 'b');
      return commands.makeOneShape().message;
    };
    expect(differing({ fill: '#f00' })).toContain('The other colours are gone');
    expect(differing({ stroke: '#0f0' })).toContain('The other colours are gone');
    expect(differing({ strokeWidth: 9 })).toContain('The other colours are gone');
    // And the quiet sentence when they agree, which is the other branch.
    expect(differing({})).not.toContain('The other colours are gone');
  });

  it('counts the paths a boolean produced, singular and plural', () => {
    const two = editor(withShapes(['a', 'M0 0 H10 V10 H0 Z'], ['b', 'M20 0 H30 V10 H20 Z']));
    select(two.store, 'a', 'b');
    // Disjoint, so a union keeps both regions and the plural is reachable.
    expect(two.commands.booleanSelection('unite').message).toMatch(/2 shapes → 2 paths\.$/);

    const one = editor(withShapes(['a', 'M0 0 H20 V20 H0 Z'], ['b', 'M10 10 H30 V30 H10 Z']));
    select(one.store, 'a', 'b');
    expect(one.commands.booleanSelection('unite').message).toMatch(/2 shapes → 1 path\.$/);
  });

  it('counts what a split produced, from one shape and from more', () => {
    /* `from + made` against `made + 1`: with one shape holding two paths the
       two spellings agree at 2, so the fixture needs two shapes. */
    const one = editor(withShapes(['a', 'M0 0 H10 V10 H0 Z M20 0 H30 V10 H20 Z']));
    select(one.store, 'a');
    expect(one.commands.splitShapes().message).toBe('a split into 2 shapes.');

    const two = editor(
      withShapes(['a', 'M0 0 H10 V10 H0 Z M20 0 H30 V10 H20 Z'], ['b', 'M0 20 H10 V30 H0 Z M20 20 H30 V30 H20 Z']),
    );
    select(two.store, 'a', 'b');
    expect(two.commands.splitShapes().message).toBe('2 shapes split into 4.');
  });
});

describe('what the buttons are enabled from', () => {
  it('offers Group at two shapes and not at one', () => {
    const { store, commands } = editor(withShapes(['a', SQUARE], ['b', 'M60 0 H100 V40 Z']));
    expect(commands.canGroup).toBe(false);
    select(store, 'a');
    expect(commands.canGroup).toBe(false);
    select(store, 'a', 'b');
    expect(commands.canGroup).toBe(true);
  });

  it('offers Ungroup only when something selected is in a group', () => {
    const { store, commands } = editor(withShapes(['a', SQUARE], ['b', 'M60 0 H100 V40 Z']));
    select(store, 'a', 'b');
    expect(commands.canUngroup).toBe(false);
    commands.groupSelection();
    expect(commands.canUngroup).toBe(true);

    /* A shape outside the group, selected on its own. The `&&` reads "selected
       AND grouped"; loosened to `||` it answers true for any selection at all,
       and a fixture where everything is grouped cannot tell. */
    const loose = shapeFromPath('M200 0 H210 V10 Z');
    loose.name = 'c';
    store.edit((s) => s.doc.shapes.push(loose));
    select(store, 'c');
    expect(commands.canUngroup).toBe(false);
  });

  it('spaces at a typed gap, and evenly when the gap is not a number', () => {
    /* `gap !== null && Number.isFinite(gap) ? gap : null`. Passing null and
       passing NaN both mean "space them evenly", and nothing had passed
       either, so the guard could be inverted without a test noticing. */
    const three = (): ReturnType<typeof editor> => {
      const e = editor(
        withShapes(['a', 'M0 0 H10 V10 H0 Z'], ['b', 'M15 0 H25 V10 H15 Z'], ['c', 'M90 0 H100 V10 H90 Z']),
      );
      select(e.store, 'a', 'b', 'c');
      return e;
    };
    const lefts = (store: Store): number[] =>
      store.state.doc.shapes.map((sh) => Math.min(...sh.subpaths[0].nodes.map((n) => n.pt[0])));

    const typed = three();
    expect(typed.commands.spaceShapes('h', 'selection', 5)).toBe(true);
    expect(lefts(typed.store)).toEqual([0, 15, 30]);

    const even = three();
    expect(even.commands.spaceShapes('h', 'selection', Number.NaN)).toBe(true);
    // Evenly across the span the three already occupied, not at a gap of NaN.
    expect(lefts(even.store).every((v) => Number.isFinite(v))).toBe(true);
    expect(lefts(even.store)).toEqual([0, 45, 90]);
  });
});
