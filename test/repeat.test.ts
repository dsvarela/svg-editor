/**
 * Doing the last transform again.
 *
 * Cheap precisely because §5 bakes transforms into coordinates: the last matrix
 * is the whole of what has to be remembered, and applying it again is the same
 * call. What the tests are about is which matrix gets remembered, since a
 * gesture and the matrix that came out of it are not always the same thing.
 *
 * Measured on coordinates rather than on the stored matrix. Asserting that
 * `lastTransform` holds `[1,0,0,1,20,0]` would pass with the apply deleted, so
 * it would be green whether or not repeating a transform repeats anything. The
 * "Testing philosophy" section of `docs/ARCHITECTURE.md` has the rule.
 *
 * **The label is asserted too, and it is not decoration.** `Again: rotate 90°`
 * is the only thing that says which of two indistinguishable repeats you are
 * about to get, and every branch of the ternary that builds it was a mutation
 * survivor while nothing read a message here.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { Commands } from '../src/tools/commands';
import { emptyDoc, shapeFromPath } from '../src/model/doc';

/** One 10-wide square at the origin, selected. */
function editor(
  d = 'M0 0 L10 0 L10 10 L0 10 Z',
  busy = false,
): { store: Store; commands: Commands; said: () => { message: string; ok: boolean } | null } {
  const doc = emptyDoc();
  doc.viewBox = { x: 0, y: 0, w: 100, h: 100 };
  doc.shapes.push(shapeFromPath(d, 'box'));
  const store = new Store(doc);
  store.update((s) => s.selection.shapes.add(s.doc.shapes[0].id));
  const commands = new Commands(store, () => busy);
  let last: { message: string; ok: boolean } | null = null;
  commands.onMessage = (message, ok) => (last = { message, ok });
  return { store, commands, said: () => last };
}

const box = (store: Store): { x: number; y: number; w: number; h: number } => {
  const pts = store.state.doc.shapes.flatMap((sh) =>
    sh.subpaths.flatMap((sp) => sp.nodes.map((n) => n.pt)),
  );
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

describe('repeat with nothing to repeat', () => {
  it('refuses before anything has been transformed', () => {
    const { commands, said } = editor();
    expect(commands.repeatTransform()).toBe(false);
    expect(commands.canRepeatTransform).toBe(false);
    expect(said()).toEqual({
      message: 'Nothing to repeat: move, rotate or scale something first.',
      ok: false,
    });
  });

  it('refuses with nothing selected, even after a transform', () => {
    const { store, commands, said } = editor();
    commands.nudge([5, 0]);
    store.update((s) => {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
    });
    expect(commands.canRepeatTransform).toBe(false);
    expect(commands.repeatTransform()).toBe(false);
    /* A different sentence from the one above, and the difference is the whole
       point: there is something to repeat and nothing to repeat it onto. Both
       refusals return the same `false`. */
    expect(said()).toEqual({ message: 'Repeat needs something selected.', ok: false });
  });

  it('refuses mid-drag, from the button as well as the key', () => {
    // The guard the method's own comment argues for: the button had none, so
    // one operation was refused from the keyboard and allowed from the panel.
    const { store, commands, said } = editor('M0 0 L10 0 L10 10 L0 10 Z', true);
    commands.nudge([5, 0]);
    expect(commands.repeatTransform()).toBe(false);
    expect(box(store).x).toBe(5);
    expect(said()).toEqual({ message: 'Finish the drag first.', ok: false });
  });
});

describe('what gets remembered', () => {
  it('a nudge, so a row can be built by repeating it', () => {
    const { store, commands, said } = editor();
    commands.nudge([20, 0]);
    expect(box(store).x).toBe(20);
    expect(commands.repeatTransform()).toBe(true);
    expect(box(store).x).toBe(40);
    expect(said()).toEqual({ message: 'Again: move 20, 0.', ok: true });
    commands.repeatTransform();
    expect(box(store).x).toBe(60);
  });

  it('a rotate about the selection centre', () => {
    const { store, commands, said } = editor('M0 0 L20 0 L20 10 L0 10 Z');
    commands.applyTransform('rotate', 90);
    const once = box(store);
    // A 20 by 10 turned a quarter is 10 by 20, about the same centre.
    expect(once.w).toBeCloseTo(10, 9);
    expect(once.h).toBeCloseTo(20, 9);
    commands.repeatTransform();
    const twice = box(store);
    expect(twice.w).toBeCloseTo(20, 9);
    expect(twice.h).toBeCloseTo(10, 9);
    expect(said()).toEqual({ message: 'Again: rotate 90°.', ok: true });
  });

  it('a scale, which compounds rather than repeating a size', () => {
    const { store, commands, said } = editor();
    commands.applyTransform('scale', 2);
    expect(box(store).w).toBeCloseTo(20, 9);
    commands.repeatTransform();
    expect(box(store).w).toBeCloseTo(40, 9);
    expect(said()).toEqual({ message: 'Again: scale 2.', ok: true });
  });

  /* The matrix, not the gesture. `set width to 40` on a 20-wide selection makes
     a doubling, and the doubling is what a repeat applies -- so the second
     press gives 80 rather than setting it to 40 again. That is a real
     difference and the label is what tells you which one you have. */
  it('a typed width as the scaling it produced, not as the number typed', () => {
    const { store, commands } = editor();
    commands.setSelectionBound('w', 20);
    expect(box(store).w).toBeCloseTo(20, 9);
    commands.repeatTransform();
    expect(box(store).w).toBeCloseTo(40, 9);
    expect(store.state.lastTransform?.what).toBe('set width to 20');
  });

  it('a flip', () => {
    const { store, commands, said } = editor('M0 0 L30 0 L30 10 L0 10 Z');
    // Asymmetric, so a flip is visible in the coordinates.
    store.edit((s) => (s.doc.shapes[0].subpaths[0].nodes[1].pt = [30, 4]));
    const before = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    commands.applyTransform('flipH');
    const flipped = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    expect(flipped).not.toEqual(before);
    commands.repeatTransform();
    /* Which flip, named. The two are one character apart in the source and
       produce the same box, so the label is the only thing that separates
       `Again: flip across the vertical` from its partner below. */
    expect(said()).toEqual({ message: 'Again: flip across the vertical.', ok: true });
    // Twice is where it started, which no single flip could produce.
    const back = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    back.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(before[i][0], 9);
      expect(p[1]).toBeCloseTo(before[i][1], 9);
    });
  });

  /**
   * The other flip, which nothing measured at all.
   *
   * `flipY` returning the identity passed all 1110 tests: `flipH` had two and
   * its symmetric partner had none. Found by `tools/mutate.mjs` and confirmed
   * by breaking it by hand.
   *
   * Asserted as a mirror rather than as "the coordinates changed", because an
   * identity changes nothing and an identity is what was there. Every node's y
   * before and after has to sum to the same number, which is twice whatever
   * line it was mirrored about -- true without this test knowing which line
   * that is. And x untouched, which is what makes it the vertical one.
   */
  it('a flip the other way, which is the half nothing measured', () => {
    const { store, commands, said } = editor('M0 0 L30 0 L30 10 L0 10 Z');
    store.edit((s) => (s.doc.shapes[0].subpaths[0].nodes[1].pt = [30, 4]));
    const before = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    commands.applyTransform('flipV');
    const flipped = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);

    const sums = flipped.map((p, i) => p[1] + before[i][1]);
    expect(Math.max(...sums) - Math.min(...sums)).toBeLessThan(1e-9);
    expect(flipped.map((p) => p[0])).toEqual(before.map((p) => p[0]));
    expect(flipped.map((p) => p[1])).not.toEqual(before.map((p) => p[1]));

    commands.repeatTransform();
    expect(said()).toEqual({ message: 'Again: flip across the horizontal.', ok: true });
  });
});

describe('typing a bound, which is the other way to make a matrix', () => {
  it('refuses a size of zero or less rather than collapsing the shape', () => {
    const { store, commands, said } = editor();
    expect(commands.setSelectionBound('w', 0)).toBe(false);
    expect(box(store).w).toBe(10);
    expect(said()).toEqual({ message: 'A size has to be greater than zero.', ok: false });
  });

  it('refuses to scale an axis the selection has no length along', () => {
    /* A flat selection: dividing by that side sends every point to infinity.
       Named per axis, because a horizontal line has a width to scale and no
       height, and the sentence is the only thing that says which. */
    const { commands, said } = editor('M0 0 L30 0');
    expect(commands.setSelectionBound('h', 20)).toBe(false);
    expect(said()).toEqual({ message: 'This selection has no height to scale.', ok: false });
    expect(commands.setSelectionBound('w', 20)).toBe(true);
  });

  it('refuses with nothing selected', () => {
    const { store, commands, said } = editor();
    store.update((s) => {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
    });
    expect(commands.setSelectionBound('x', 5)).toBe(false);
    expect(said()).toEqual({ message: 'Nothing is selected.', ok: false });
  });

  it('refuses a value that is not a number, and says nothing about it', () => {
    // No sentence here on purpose: an unparsable field is the field's problem,
    // and the status line is not where a half-typed number gets commented on.
    const { store, commands, said } = editor();
    expect(commands.setSelectionBound('x', Number.NaN)).toBe(false);
    expect(box(store).x).toBe(0);
    expect(said()).toBe(null);
  });

  it('labels a moved edge by the axis it moved', () => {
    /* 25 is where the reference point goes, and the reference is the centre
       unless somebody chose otherwise, so a 10-tall box lands with its top at
       20. That is §67: rotate and flip already held the centre, and X and Y
       held the top-left with nothing saying so. */
    const { store, commands, said } = editor();
    expect(commands.setSelectionBound('y', 25)).toBe(true);
    expect(box(store).y).toBeCloseTo(20, 9);
    commands.repeatTransform();
    expect(said()).toEqual({ message: 'Again: move Y to 25.', ok: true });
  });
});

describe('the repeat itself', () => {
  it('applies to whatever is selected now, not to what was transformed', () => {
    const { store, commands } = editor();
    store.edit((s) => s.doc.shapes.push(shapeFromPath('M50 50 L60 50 L60 60 L50 60 Z', 'other')));
    commands.nudge([20, 0]);

    store.update((s) => {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
      s.selection.shapes.add(s.doc.shapes[1].id);
    });
    commands.repeatTransform();

    const first = store.state.doc.shapes[0].subpaths[0].nodes[0].pt;
    const second = store.state.doc.shapes[1].subpaths[0].nodes[0].pt;
    expect(first[0]).toBeCloseTo(20, 9);
    expect(second[0]).toBeCloseTo(70, 9);
  });

  it('is one undo step, and undo does not forget what to repeat', () => {
    const { store, commands } = editor();
    commands.nudge([20, 0]);
    commands.repeatTransform();
    expect(box(store).x).toBeCloseTo(40, 9);
    store.undo();
    expect(box(store).x).toBeCloseTo(20, 9);
    /* Undo takes back what happened. What you were about to do again is a
       different question, so the matrix survives and a second press works. */
    expect(commands.canRepeatTransform).toBe(true);
    commands.repeatTransform();
    expect(box(store).x).toBeCloseTo(40, 9);
  });

  it('does not repeat an operation that is not a transform', () => {
    const { store, commands } = editor();
    commands.nudge([20, 0]);
    const was = store.state.lastTransform?.what;
    commands.setSelectedContinuity('smooth');
    expect(store.state.lastTransform?.what).toBe(was);
  });
});
