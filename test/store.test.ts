/**
 * History.
 *
 * `edit` checkpoints first and asks questions later, which is right for a drag
 * and wrong for a button: an operation that declines still landed an empty
 * entry on the undo stack and threw the redo stack away. `tryEdit` is the
 * structural answer -- one place, rather than a guard at each call site -- and
 * these are the properties it has to have.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { emptyDoc, shapeFromPath } from '../src/model/doc';

const store = (): Store => {
  const doc = emptyDoc();
  doc.shapes.push(shapeFromPath('M0 0 L10 0 L10 10'));
  return new Store(doc);
};

describe('tryEdit', () => {
  it('records nothing when the mutation reports no change', () => {
    const s = store();
    expect(s.canUndo).toBe(false);
    expect(s.tryEdit(() => false)).toBe(false);
    expect(s.canUndo).toBe(false);
  });

  it('records one entry when it does change something', () => {
    const s = store();
    s.tryEdit((st) => {
      st.doc.shapes[0].name = 'renamed';
      return true;
    });
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(s.state.doc.shapes[0].name).not.toBe('renamed');
  });

  it('keeps a pending redo alive across a declined edit', () => {
    // The sharp end of this: a dead button used to make Ctrl+Shift+Z stop
    // working, because `checkpoint` clears the redo stack before the mutation
    // gets a chance to say it has nothing to do.
    const s = store();
    s.edit((st) => (st.doc.shapes[0].name = 'first'));
    s.undo();
    expect(s.canRedo).toBe(true);

    s.tryEdit(() => false);
    expect(s.canRedo).toBe(true);
    s.redo();
    expect(s.state.doc.shapes[0].name).toBe('first');
  });

  it('leaves an open batch as it found it', () => {
    const s = store();
    s.beginBatch();
    s.tryEdit(() => false);
    // The batch has taken no checkpoint, so a real edit inside it still can.
    s.edit((st) => (st.doc.shapes[0].name = 'a'));
    s.endBatch();
    s.undo();
    expect(s.state.doc.shapes[0].name).not.toBe('a');
  });

  it('still collapses a whole batch into one entry', () => {
    const s = store();
    s.beginBatch();
    s.tryEdit((st) => {
      st.doc.shapes[0].name = 'a';
      return true;
    });
    s.tryEdit((st) => {
      st.doc.shapes[0].name = 'b';
      return true;
    });
    s.endBatch();

    s.undo();
    expect(s.state.doc.shapes[0].name).not.toBe('b');
    expect(s.canUndo).toBe(false);
  });
});

describe('rollback', () => {
  it('restores without offering a redo, unlike undo', () => {
    const s = store();
    s.edit((st) => (st.doc.shapes[0].name = 'drawn'));

    s.undo();
    expect(s.canRedo).toBe(true);
    s.redo();

    s.rollback();
    expect(s.state.doc.shapes[0].name).not.toBe('drawn');
    // An abandoned gesture should not come back from a keystroke aimed at
    // something else.
    expect(s.canRedo).toBe(false);
  });

  it('does nothing on an empty history', () => {
    const s = store();
    expect(() => s.rollback()).not.toThrow();
  });
});
