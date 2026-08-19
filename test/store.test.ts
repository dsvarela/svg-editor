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
import type { Backdrop } from '../src/model/store';
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
    // The sharp end of this: a dead button stops Ctrl+Shift+Z working if
    // `checkpoint` clears the redo stack before the mutation gets a chance to
    // say it has nothing to do.
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

describe('the backdrop in history', () => {
  const image = (over: Partial<Backdrop> = {}): Backdrop => ({
    src: 'blob:a',
    name: 'ref.png',
    x: 0,
    y: 0,
    w: 40,
    h: 30,
    naturalW: 400,
    naturalH: 300,
    opacity: 0.5,
    visible: true,
    locked: true,
    ...over,
  });

  it('brings a removed image back, rather than a broken link', () => {
    const s = store();
    s.edit((st) => (st.backdrop = image()));
    s.edit((st) => (st.backdrop = null));

    s.undo();
    expect(s.state.backdrop?.src).toBe('blob:a');
  });

  it('keeps the view switches you set after the edit being undone', () => {
    // Undo is for taking back an edit. Flipping a checkbox back because you
    // happened to press it later is not that, and is why `showGrid` and the
    // camera have never been in the history either.
    const s = store();
    s.edit((st) => (st.backdrop = image({ x: 0 })));
    s.edit((st) => (st.backdrop!.x = 100));
    s.update((st) => {
      st.backdrop!.visible = false;
      st.backdrop!.locked = false;
      st.backdrop!.opacity = 0.9;
    });

    s.undo();
    expect(s.state.backdrop!.x).toBe(0);
    expect(s.state.backdrop!.visible).toBe(false);
    expect(s.state.backdrop!.locked).toBe(false);
    expect(s.state.backdrop!.opacity).toBe(0.9);
  });

  it('does not copy the image into the document', () => {
    const s = store();
    s.edit((st) => (st.backdrop = image()));
    expect(Object.keys(s.state.doc)).not.toContain('backdrop');
  });

  it('holds the bytes for as long as any entry can reach them', () => {
    /* Loading and removing is not enough to reach the branch: `reap` returns
       before it looks at anything, so the "is it still reachable?" guard can be
       deleted and the whole suite still passes. The image has to be on screen
       AND on a discarded redo entry at the moment something is freed, which
       takes an undo and then a fresh edit. */
    const freed: string[] = [];
    const s = store();
    s.onOrphanImage = (src) => freed.push(src);

    s.edit((st) => (st.backdrop = image()));
    s.edit((st) => (st.backdrop = null));
    expect(freed).toEqual([]);

    s.undo();
    expect(s.state.backdrop?.src).toBe('blob:a');
    // The redo entry naming this image is about to be thrown away, while the
    // live state is still displaying it.
    s.edit((st) => (st.doc.shapes[0].name = 'elsewhere'));
    expect(freed).toEqual([]);
    expect(s.state.backdrop?.src).toBe('blob:a');
  });

  it('frees them once a new edit has thrown the redo away', () => {
    const freed: string[] = [];
    const s = store();
    s.onOrphanImage = (src) => freed.push(src);

    s.edit((st) => (st.backdrop = image()));
    s.undo();
    expect(s.state.backdrop).toBeNull();
    expect(freed).toEqual([]);

    // The redo held the only reference left. Taking a different branch is the
    // moment nothing can reach the image again.
    s.edit((st) => (st.doc.shapes[0].name = 'elsewhere'));
    expect(freed).toEqual(['blob:a']);
  });

  it('does not free an image a declined edit puts back', () => {
    // `tryEdit` clears the redo stack before it knows whether there is anything
    // to do, and restores it when there is not. Freeing on the way through
    // would have left that restored entry pointing at nothing.
    const freed: string[] = [];
    const s = store();
    s.onOrphanImage = (src) => freed.push(src);

    s.edit((st) => (st.backdrop = image()));
    s.undo();
    s.tryEdit(() => false);

    expect(freed).toEqual([]);
    s.redo();
    expect(s.state.backdrop?.src).toBe('blob:a');
  });

  it('frees the one an abandoned gesture was holding', () => {
    const freed: string[] = [];
    const s = store();
    s.onOrphanImage = (src) => freed.push(src);

    s.edit((st) => (st.backdrop = image()));
    s.rollback();
    expect(freed).toEqual(['blob:a']);
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

describe('guides in history', () => {
  /* A guide is a decision someone made, which is the whole reason it is stored
     rather than derived like a keyline, and a decision has to be undoable.
     These are the three routes back: undo, redo, and an abandoned gesture. */

  it('takes a placed guide back on undo, and returns it on redo', () => {
    const s = store();
    s.edit((st) => st.guides.push({ axis: 'x', at: 12 }));
    expect(s.state.guides).toHaveLength(1);

    s.undo();
    expect(s.state.guides).toHaveLength(0);

    s.redo();
    expect(s.state.guides).toEqual([{ axis: 'x', at: 12 }]);
  });

  it('snapshots the positions rather than the array', () => {
    /* The store mutates in place, so a snapshot holding the same objects would
       have the undo entry follow the drag it is supposed to undo. Moving a
       guide is exactly that: one array, one object, one number changing on
       every pointermove. */
    const s = store();
    s.edit((st) => st.guides.push({ axis: 'y', at: 5 }));
    s.edit((st) => (st.guides[0].at = 60));
    expect(s.state.guides[0].at).toBe(60);

    s.undo();
    expect(s.state.guides[0].at).toBe(5);
  });

  it('takes back a guide dragged out and abandoned', () => {
    const s = store();
    s.beginBatch();
    s.edit((st) => st.guides.push({ axis: 'x', at: 3 }));
    s.rollback();
    s.endBatch();
    expect(s.state.guides).toHaveLength(0);
  });

  it('leaves the view switches alone, the same as the backdrop does', () => {
    // Undo is for taking back an edit, not for restoring the state of a
    // checkbox you ticked afterwards.
    const s = store();
    s.edit((st) => st.guides.push({ axis: 'x', at: 12 }));
    s.update((st) => (st.showGuides = false));
    s.undo();
    expect(s.state.showGuides).toBe(false);
  });
});

/**
 * A history belongs to a document, and opening a file replaces the document.
 *
 * Snapshots here are whole documents rather than inverse operations, which is
 * what makes this a question at all: an entry taken before a file was opened is
 * a complete drawing, and applying it does not undo the open, it puts the old
 * drawing back over the new one with nothing to explain where it came from.
 */
describe('forgetHistory', () => {
  it('leaves undo with nothing to do', () => {
    const s = store();
    s.edit((st) => st.doc.shapes.push(shapeFromPath('M0 0 L5 5', 'second')));
    expect(s.canUndo).toBe(true);

    s.forgetHistory();
    expect(s.canUndo).toBe(false);
    s.undo();
    expect(s.state.doc.shapes.map((sh) => sh.name).at(-1)).toBe('second');
    expect(s.state.doc.shapes).toHaveLength(2);
  });

  it('leaves redo with nothing to do either', () => {
    const s = store();
    s.edit((st) => st.doc.shapes.push(shapeFromPath('M0 0 L5 5', 'second')));
    s.undo();
    expect(s.canRedo).toBe(true);

    s.forgetHistory();
    expect(s.canRedo).toBe(false);
    s.redo();
    expect(s.state.doc.shapes).toHaveLength(1);
  });

  /* The bytes behind a backdrop are held alive by whichever snapshot can still
     reach one. Dropping every snapshot drops the last reference, and nothing
     else is going to notice that it has. */
  it('frees a backdrop that only the discarded history was holding', () => {
    const s = store();
    const freed: string[] = [];
    s.onOrphanImage = (src) => freed.push(src);
    const image: Backdrop = {
      src: 'blob:gone',
      name: 'ref.png',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      naturalW: 10,
      naturalH: 10,
      opacity: 1,
      visible: true,
      locked: true,
    };
    s.edit((st) => (st.backdrop = image));
    s.edit((st) => (st.backdrop = null));
    expect(freed).toEqual([]);

    s.forgetHistory();
    expect(freed).toEqual(['blob:gone']);
  });

  it('keeps a backdrop the document is still showing', () => {
    const s = store();
    const freed: string[] = [];
    s.onOrphanImage = (src) => freed.push(src);
    s.edit((st) => {
      st.backdrop = {
        src: 'blob:live',
        name: 'ref.png',
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        naturalW: 10,
        naturalH: 10,
        opacity: 1,
        visible: true,
        locked: true,
      };
    });
    s.forgetHistory();
    expect(freed).toEqual([]);
    expect(s.state.backdrop?.src).toBe('blob:live');
  });
});
