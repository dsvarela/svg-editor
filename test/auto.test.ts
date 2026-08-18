/**
 * Auto-smooth nodes.
 *
 * The construction is small, so the tests are mostly about what happens to the
 * flag: when it can be set, what cancels it, and what happens when the node it
 * describes stops having the neighbours it needs. A stale `auto` is the failure
 * that would look like a rendering bug rather than a model one.
 */

import { describe, expect, it } from 'vitest';
import { autoHandles, canBeAuto, reflowAuto, reflowDoc, setAuto } from '../src/model/auto';
import { moveAnchor } from '../src/model/ops';
import { emptyDoc, shapeFromPath } from '../src/model/doc';
import { cloneSubpath, continuityOf } from '../src/core/types';
import type { Subpath } from '../src/core/types';

const path = (d: string): Subpath => shapeFromPath(d).subpaths[0];

/** Three nodes in a line, evenly spaced: the simplest thing with a middle. */
const run = (): Subpath => path('M0 0 L10 0 L20 0');

describe('what can be auto', () => {
  it('needs a neighbour on each side', () => {
    const sp = run();
    expect(canBeAuto(sp, 0)).toBe(false);
    expect(canBeAuto(sp, 1)).toBe(true);
    expect(canBeAuto(sp, 2)).toBe(false);
  });

  it('can be any node of a closed path, since every one has two', () => {
    const sp = path('M0 0 L10 0 L10 10 Z');
    expect([0, 1, 2].every((i) => canBeAuto(sp, i))).toBe(true);
  });

  it('refuses a path too short to have a middle', () => {
    expect(canBeAuto(path('M0 0 L10 0'), 0)).toBe(false);
  });
});

describe('the handles it derives', () => {
  it('puts them on the chord between the neighbours, so the node is smooth', () => {
    const sp = path('M0 0 L10 6 L20 0');
    setAuto(sp, 1, true);
    expect(continuityOf(sp.nodes[1])).not.toBe('cusp');
    // Both handles lie on the line through the neighbours, which is horizontal
    // here: the chord from (0, 0) to (20, 0).
    expect(sp.nodes[1].hIn![1]).toBeCloseTo(6, 9);
    expect(sp.nodes[1].hOut![1]).toBeCloseTo(6, 9);
  });

  it('reaches a third of the way to each neighbour, separately', () => {
    /* Separately is the point: on an uneven run a single averaged length puts a
       bulge on the short side. Neighbours at 3 and at 30 from the node. */
    const sp = path('M0 0 L3 0 L33 0');
    setAuto(sp, 1, true);
    const n = sp.nodes[1];
    expect(Math.hypot(n.pt[0] - n.hIn![0], n.pt[1] - n.hIn![1])).toBeCloseTo(1, 9);
    expect(Math.hypot(n.hOut![0] - n.pt[0], n.hOut![1] - n.pt[1])).toBeCloseTo(10, 9);
  });

  it('gives nothing when the neighbours are in the same place', () => {
    // No chord means no direction. Dividing by zero here would put NaN in the
    // document, which every later operation would carry.
    const sp = path('M5 5 L10 0 L5 5');
    expect(autoHandles(sp, 1)).toBeNull();
  });
});

describe('re-deriving', () => {
  it('follows a neighbour that moved', () => {
    const sp = path('M0 0 L10 0 L20 0');
    setAuto(sp, 1, true);
    const before = [...sp.nodes[1].hOut!];

    moveAnchor(sp, 2, [20, 20]);
    reflowAuto(sp);
    expect(sp.nodes[1].hOut).not.toEqual(before);
    // Still on the chord, which now runs from (0, 0) to (20, 20).
    const n = sp.nodes[1];
    expect(n.hOut![0] - n.pt[0]).toBeCloseTo(n.hOut![1] - n.pt[1], 9);
  });

  it('leaves every other node alone', () => {
    const sp = path('M0 0 L10 0 L20 0');
    setAuto(sp, 1, true);
    const copy = cloneSubpath(sp);
    moveAnchor(sp, 2, [20, 20]);
    reflowAuto(sp);
    expect(sp.nodes[0]).toEqual(copy.nodes[0]);
  });

  it('reports whether anything moved, so a caller can decline to record an edit', () => {
    const sp = path('M0 0 L10 0 L20 0');
    setAuto(sp, 1, true);
    expect(reflowAuto(sp)).toBe(false);
    moveAnchor(sp, 0, [0, 5]);
    expect(reflowAuto(sp)).toBe(true);
  });

  it('drops the flag when the node stops having two neighbours', () => {
    /* Delete the node past it and the auto node becomes an end. Leaving the
       flag would park a dormant instruction on it, to fire the moment a
       neighbour reappeared -- long after anyone would connect the two. */
    const sp = path('M0 0 L10 0 L20 0');
    setAuto(sp, 1, true);
    sp.nodes.splice(2, 1);
    reflowAuto(sp);
    expect(sp.nodes[1].auto).toBeUndefined();
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes[1].hOut).toBeNull();
  });

  it('sweeps a whole document', () => {
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath('M0 0 L10 0 L20 0'));
    setAuto(doc.shapes[0].subpaths[0], 1, true);
    moveAnchor(doc.shapes[0].subpaths[0], 0, [0, 9]);
    expect(reflowDoc(doc)).toBe(true);
    expect(reflowDoc(doc)).toBe(false);
  });
});

describe('turning it off', () => {
  it('keeps the handles where they are', () => {
    /* The whole point of the flag being separate from the geometry: what you
       had is what you carry on editing. */
    const sp = path('M0 0 L10 6 L20 0');
    setAuto(sp, 1, true);
    const held = [[...sp.nodes[1].hIn!], [...sp.nodes[1].hOut!]];
    setAuto(sp, 1, false);
    expect(sp.nodes[1].auto).toBeUndefined();
    expect([sp.nodes[1].hIn, sp.nodes[1].hOut]).toEqual(held);
  });

  it('stops it following the neighbours', () => {
    const sp = path('M0 0 L10 6 L20 0');
    setAuto(sp, 1, true);
    setAuto(sp, 1, false);
    const held = [...sp.nodes[1].hOut!];
    moveAnchor(sp, 2, [20, 40]);
    reflowAuto(sp);
    expect(sp.nodes[1].hOut).toEqual(held);
  });

  it('reports no change when there was nothing to turn off', () => {
    expect(setAuto(run(), 1, false)).toBe(false);
  });
});

describe('the flag survives what it should', () => {
  it('is carried by a clone, so history keeps it', () => {
    const sp = path('M0 0 L10 6 L20 0');
    setAuto(sp, 1, true);
    expect(cloneSubpath(sp).nodes[1].auto).toBe(true);
    // And absent on the others rather than present and false, which would put
    // a key on every node in the document.
    expect('auto' in cloneSubpath(sp).nodes[0]).toBe(false);
  });
});
