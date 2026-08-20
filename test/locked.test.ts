/**
 * A locked shape takes no pointer, and the lock never reaches a file.
 *
 * Two things are asserted here that the browser cannot: what `isLocked` answers
 * about a group's contents, and that a save carries no trace of a lock. The
 * click-through itself is `lockedShape` in `tools/drive.mjs`, because only a
 * browser resolves a press against overlapping geometry.
 *
 * §66 of `docs/ARCHITECTURE.md` has the argument.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { Commands } from '../src/tools/commands';
import { emptyDoc, isHidden, isLocked, shapeFromPath } from '../src/model/doc';
import { exportSvg } from '../src/io/svg';
import { encode, read, toSession } from '../src/io/session';

/** Three shapes, off the origin, so a group can hold some of them. */
function scene(): Store {
  const doc = emptyDoc();
  doc.shapes.push(
    shapeFromPath('M20 20 L60 20 L60 60 L20 60 Z'),
    shapeFromPath('M80 20 L120 20 L120 60 L80 60 Z'),
    shapeFromPath('M140 20 L180 20 L180 60 L140 60 Z'),
  );
  return new Store(doc);
}

const ids = (s: Store): string[] => s.state.doc.shapes.map((sh) => sh.id);

const findByIdOrThrow = <T extends { id: string }>(all: T[], id: string): T => {
  const got = all.find((x) => x.id === id);
  if (!got) throw new Error(`no ${id}`);
  return got;
};

describe('what counts as locked', () => {
  it('is nothing at all when nothing is locked', () => {
    const s = scene();
    for (const id of ids(s)) expect(isLocked(s.state.doc, s.state.locked, id)).toBe(false);
  });

  it('is the shape whose own id is in the set, and no other', () => {
    const s = scene();
    const [a, b, c] = ids(s);
    s.update((st) => st.locked.add(b));
    expect(isLocked(s.state.doc, s.state.locked, a)).toBe(false);
    expect(isLocked(s.state.doc, s.state.locked, b)).toBe(true);
    expect(isLocked(s.state.doc, s.state.locked, c)).toBe(false);
  });

  it('is every shape under a locked group, without naming any of them', () => {
    /* The point of putting the group's id in the same set. A group holds no
       list of its members, so locking it has to be answered by walking up from
       each shape -- and a shape moved into the group afterwards is locked with
       no second step. */
    const s = scene();
    const cmd = new Commands(s, () => false);
    const [a, b, c] = ids(s);
    s.update((st) => {
      st.selection.shapes.add(a);
      st.selection.shapes.add(b);
    });
    expect(cmd.groupSelection()).toBe(true);
    const g = s.state.doc.groups![0];

    s.update((st) => st.locked.add(g.id));
    expect(isLocked(s.state.doc, s.state.locked, a)).toBe(true);
    expect(isLocked(s.state.doc, s.state.locked, b)).toBe(true);
    expect(isLocked(s.state.doc, s.state.locked, c)).toBe(false);
    // And the group's own id answers too, which is what the list row reads.
    expect(isLocked(s.state.doc, s.state.locked, g.id)).toBe(true);
  });

  it('follows a group inside a group', () => {
    const s = scene();
    const cmd = new Commands(s, () => false);
    const [a, b] = ids(s);
    s.update((st) => {
      st.selection.shapes.add(a);
      st.selection.shapes.add(b);
    });
    cmd.groupSelection();
    s.update((st) => {
      st.selection.shapes.clear();
      st.selection.shapes.add(a);
      st.selection.shapes.add(b);
    });
    cmd.groupSelection();

    /* Read off `parent` rather than off the order they were made in: grouping
       shapes that already share a group puts the new one INSIDE it, so which
       of the two is outermost is the opposite of which was created first. */
    const all = s.state.doc.groups!;
    expect(all).toHaveLength(2);
    const outer = all.find((g) => g.parent === null)!;
    const inner = all.find((g) => g.parent === outer.id)!;

    s.update((st) => st.locked.add(outer.id));
    expect(isLocked(s.state.doc, s.state.locked, a)).toBe(true);
    expect(isLocked(s.state.doc, s.state.locked, inner.id)).toBe(true);
    // And locking the inner one leaves the outer group's row unlocked.
    s.update((st) => {
      st.locked.clear();
      st.locked.add(inner.id);
    });
    expect(isLocked(s.state.doc, s.state.locked, a)).toBe(true);
    expect(isLocked(s.state.doc, s.state.locked, outer.id)).toBe(false);
  });

  it('says no about an id the document does not have', () => {
    const s = scene();
    s.update((st) => st.locked.add('gone'));
    expect(isLocked(s.state.doc, s.state.locked, 'gone-too')).toBe(false);
  });
});

describe('a lock is not part of the drawing', () => {
  it('leaves no trace in the exported file', () => {
    /* The whole reason it lives beside the selection rather than on the shape.
       There is no field to remember not to write, so this cannot regress by
       somebody adding one. */
    const s = scene();
    const before = exportSvg(s.state.doc, { decimals: 3 });
    s.update((st) => {
      for (const id of ids(s)) st.locked.add(id);
    });
    expect(exportSvg(s.state.doc, { decimals: 3 })).toBe(before);
    expect(before).not.toMatch(/lock/i);
  });

  it('is not undone, because it is not an edit', () => {
    const s = scene();
    const [a] = ids(s);
    s.update((st) => st.locked.add(a));
    expect(s.canUndo).toBe(false);
  });
});

describe('a lock across a reload', () => {
  it('comes back with the session', () => {
    const s = scene();
    const [a] = ids(s);
    s.update((st) => st.locked.add(a));

    const back = read(encode(toSession(s.state)), toSession(s.state).view);
    expect(typeof back).not.toBe('string');
    if (typeof back === 'string') return;
    expect(back.locked).toEqual([a]);
  });

  it('drops an id the restored document does not have', () => {
    /* A session outlives the document it was written beside: opening a file
       replaces the shapes and keeps the session. An id kept blindly would lock
       whichever shape happened to be given that id next. */
    const s = scene();
    const [a] = ids(s);
    s.update((st) => st.locked.add(a));
    const written = JSON.parse(JSON.stringify(toSession(s.state)));
    written.locked = [a, 'shape-that-was-never-here'];

    const back = read(JSON.stringify(written), toSession(s.state).view);
    expect(typeof back).not.toBe('string');
    if (typeof back === 'string') return;
    expect(back.locked).toEqual([a]);
  });
});

describe('what counts as hidden', () => {
  it('is the shape whose own flag is set, and no other', () => {
    const s = scene();
    const [a, b] = ids(s);
    s.edit((st) => (findByIdOrThrow(st.doc.shapes, b).hidden = true));
    expect(isHidden(s.state.doc, a)).toBe(false);
    expect(isHidden(s.state.doc, b)).toBe(true);
  });

  it('is every shape under a hidden group', () => {
    const s = scene();
    const cmd = new Commands(s, () => false);
    const [a, b, c] = ids(s);
    s.update((st) => {
      st.selection.shapes.add(a);
      st.selection.shapes.add(b);
    });
    expect(cmd.groupSelection()).toBe(true);
    const g = s.state.doc.groups![0];
    s.edit((st) => (st.doc.groups!.find((x) => x.id === g.id)!.hidden = true));

    expect(isHidden(s.state.doc, a)).toBe(true);
    expect(isHidden(s.state.doc, b)).toBe(true);
    expect(isHidden(s.state.doc, c)).toBe(false);
    expect(isHidden(s.state.doc, g.id)).toBe(true);
  });

  /* Where it parts company with the lock: hidden is on the shape, so it is in
     the file and in the history. */
  it('goes into the exported file rather than being dropped from it', () => {
    const s = scene();
    const [a] = ids(s);
    s.edit((st) => (findByIdOrThrow(st.doc.shapes, a).hidden = true));
    const out = exportSvg(s.state.doc, { decimals: 3 });
    expect(out).toContain('display="none"');
    // Still three paths: hiding is not deleting.
    expect(out.match(/<path/g)).toHaveLength(3);
  });

  it('is undone, because it is part of the drawing', () => {
    const s = scene();
    const [a] = ids(s);
    s.edit((st) => (findByIdOrThrow(st.doc.shapes, a).hidden = true));
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(isHidden(s.state.doc, a)).toBe(false);
  });
});
