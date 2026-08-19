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
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { Commands } from '../src/tools/commands';
import { emptyDoc, shapeFromPath } from '../src/model/doc';

/** One 10-wide square at the origin, selected. */
function editor(d = 'M0 0 L10 0 L10 10 L0 10 Z'): { store: Store; commands: Commands } {
  const doc = emptyDoc();
  doc.viewBox = { x: 0, y: 0, w: 100, h: 100 };
  doc.shapes.push(shapeFromPath(d, 'box'));
  const store = new Store(doc);
  store.update((s) => s.selection.shapes.add(s.doc.shapes[0].id));
  return { store, commands: new Commands(store, () => false) };
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
    const { commands } = editor();
    expect(commands.repeatTransform()).toBe(false);
    expect(commands.canRepeatTransform).toBe(false);
  });

  it('refuses with nothing selected, even after a transform', () => {
    const { store, commands } = editor();
    commands.nudge([5, 0]);
    store.update((s) => {
      s.selection.shapes.clear();
      s.selection.nodes.clear();
    });
    expect(commands.canRepeatTransform).toBe(false);
    expect(commands.repeatTransform()).toBe(false);
  });
});

describe('what gets remembered', () => {
  it('a nudge, so a row can be built by repeating it', () => {
    const { store, commands } = editor();
    commands.nudge([20, 0]);
    expect(box(store).x).toBe(20);
    expect(commands.repeatTransform()).toBe(true);
    expect(box(store).x).toBe(40);
    commands.repeatTransform();
    expect(box(store).x).toBe(60);
  });

  it('a rotate about the selection centre', () => {
    const { store, commands } = editor('M0 0 L20 0 L20 10 L0 10 Z');
    commands.applyTransform('rotate', 90);
    const once = box(store);
    // A 20 by 10 turned a quarter is 10 by 20, about the same centre.
    expect(once.w).toBeCloseTo(10, 9);
    expect(once.h).toBeCloseTo(20, 9);
    commands.repeatTransform();
    const twice = box(store);
    expect(twice.w).toBeCloseTo(20, 9);
    expect(twice.h).toBeCloseTo(10, 9);
  });

  it('a scale, which compounds rather than repeating a size', () => {
    const { store, commands } = editor();
    commands.applyTransform('scale', 2);
    expect(box(store).w).toBeCloseTo(20, 9);
    commands.repeatTransform();
    expect(box(store).w).toBeCloseTo(40, 9);
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
    const { store, commands } = editor('M0 0 L30 0 L30 10 L0 10 Z');
    // Asymmetric, so a flip is visible in the coordinates.
    store.edit((s) => (s.doc.shapes[0].subpaths[0].nodes[1].pt = [30, 4]));
    const before = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    commands.applyTransform('flipH');
    const flipped = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    expect(flipped).not.toEqual(before);
    commands.repeatTransform();
    // Twice is where it started, which no single flip could produce.
    const back = store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    back.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(before[i][0], 9);
      expect(p[1]).toBeCloseTo(before[i][1], 9);
    });
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
