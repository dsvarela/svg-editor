import { describe, expect, it } from 'vitest';
import { parsePath } from '../src/core/parse';
import { serialisePath } from '../src/core/serialise';
import { cubicAt, projectToCubic } from '../src/core/bezier';
import { about, flipX, rotate, scale, translate } from '../src/core/affine';
import { cloneNode, continuityOf, segmentAsCubic, segmentCount } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';
import {
  deleteNode,
  moveAnchor,
  moveHandle,
  reverseSubpath,
  setContinuity,
  setSegmentCurved,
  snap,
  splitSegment,
  transformShape,
} from '../src/model/ops';
import { emptyDoc, shapeFromPath, shapeBBox } from '../src/model/doc';
import { Store } from '../src/model/store';

function sample(sp: Subpath, per = 24): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < segmentCount(sp); i++) {
    const c = segmentAsCubic(sp, i);
    for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per));
  }
  return out;
}

/**
 * Largest distance from any of `pts` to the *curve* `sp`.
 *
 * Comparing two point sets directly does not work here: splitting a segment
 * redistributes where the samples land, so nearest-neighbour distance reports a
 * large error for a curve that has not moved at all. Projecting onto the actual
 * curve measures the shape rather than the sampling.
 */
function deviation(pts: Pt[], sp: Subpath): number {
  let worst = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < segmentCount(sp); i++) {
      // Far more search than the editor uses at interaction time. The default
      // (24 coarse, 20 refine) resolves to about 1e-6, which is ample for
      // clicking but would mask a real error in an exactness claim.
      best = Math.min(best, projectToCubic(segmentAsCubic(sp, i), p, 200, 90).d);
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

/**
 * Largest index-wise distance between two sample runs.
 *
 * Valid only when the two paths share a parameterisation. Affine transforms do
 * -- they move control points and nothing else -- so this measures them exactly,
 * where `deviation` would bottom out at its projection tolerance of ~1e-6.
 */
function pointwise(a: Pt[], b: Pt[]): number {
  expect(b.length).toBe(a.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return worst;
}

const curve = (): Subpath => parsePath('M0 0 C0 20 40 20 40 0 C40 -20 80 -20 80 0')[0];
const square = (): Subpath => parsePath('M0 0 L10 0 L10 10 L0 10 Z')[0];

describe('moving', () => {
  it('carries both handles when an anchor moves', () => {
    const sp = curve();
    moveAnchor(sp, 1, [45, 5]);
    expect(sp.nodes[1].hIn).toEqual([45, 25]);
    expect(sp.nodes[1].hOut).toEqual([45, -15]);
  });

  it('leaves a corner node free to break its tangent', () => {
    // Node 1's handles are at different angles, so nothing is being maintained.
    const sp = parsePath('M0 0 C0 20 40 20 40 0 C60 -20 80 -20 80 0')[0];
    expect(continuityOf(sp.nodes[1])).toBe('corner');
    moveHandle(sp, 1, 'out', [40, 30]);
    expect(sp.nodes[1].hIn).toEqual([40, 20]);
  });

  it('keeps a smooth node collinear but preserves the other length', () => {
    const sp = curve();
    sp.nodes[1].hIn = [40, 10]; // collinear with hOut, but half its length
    expect(continuityOf(sp.nodes[1])).toBe('smooth');

    moveHandle(sp, 1, 'out', [50, -10]);

    const n = sp.nodes[1];
    const vIn = [n.hIn![0] - n.pt[0], n.hIn![1] - n.pt[1]];
    const vOut = [n.hOut![0] - n.pt[0], n.hOut![1] - n.pt[1]];
    // Collinear and opposed: the cross product vanishes, the dot is negative.
    expect(Math.abs(vIn[0] * vOut[1] - vIn[1] * vOut[0])).toBeLessThan(1e-9);
    expect(vIn[0] * vOut[0] + vIn[1] * vOut[1]).toBeLessThan(0);
    expect(Math.hypot(vIn[0], vIn[1])).toBeCloseTo(10, 9);
  });

  it('mirrors a node whose handles are already mirrored, without being told', () => {
    const sp = curve();
    expect(continuityOf(sp.nodes[1])).toBe('symmetric');

    moveHandle(sp, 1, 'out', [50, -10]);
    const n = sp.nodes[1];
    expect(n.hIn![0]).toBeCloseTo(2 * n.pt[0] - n.hOut![0], 9);
    expect(n.hIn![1]).toBeCloseTo(2 * n.pt[1] - n.hOut![1], 9);
    // Self-maintaining: mirroring produces exactly equal lengths, so the next
    // move reads the same relation rather than degrading into `smooth`.
    expect(continuityOf(n)).toBe('symmetric');
  });

  it('breaks the pair on demand, and it stays broken afterwards', () => {
    const sp = curve();
    moveHandle(sp, 1, 'out', [50, -10], true);
    expect(sp.nodes[1].hIn).toEqual([40, 20]);
    expect(continuityOf(sp.nodes[1])).toBe('corner');

    // No break flag this time: the node is a corner now, so it stays one.
    moveHandle(sp, 1, 'out', [55, -12]);
    expect(sp.nodes[1].hIn).toEqual([40, 20]);
  });

  it('does not curve a straight neighbour when dragging the other handle', () => {
    // Node 1's incoming side is a line; pulling its outgoing handle must not
    // invent a control point on the straight side.
    const sp = parsePath('M0 0 L10 0 C15 0 20 5 20 10')[0];
    moveHandle(sp, 1, 'out', [15, -5]);
    expect(sp.nodes[1].hIn).toBeNull();
  });
});

describe('forcing a continuity', () => {
  it('makes a corner smooth by averaging the two directions', () => {
    const sp = parsePath('M0 0 C0 20 40 20 40 0 C60 -20 80 -20 80 0')[0];
    setContinuity(sp, 1, 'smooth');
    expect(continuityOf(sp.nodes[1])).toBe('smooth');
    // Lengths are what they were; only the directions moved.
    const n = sp.nodes[1];
    expect(Math.hypot(n.hIn![0] - n.pt[0], n.hIn![1] - n.pt[1])).toBeCloseTo(20, 9);
    expect(Math.hypot(n.hOut![0] - n.pt[0], n.hOut![1] - n.pt[1])).toBeCloseTo(Math.hypot(20, 20), 9);
  });

  it('does not depend on which handle is called "out"', () => {
    const d = 'M0 0 C0 20 40 20 40 0 C60 -20 80 -20 80 0';
    const forward = parsePath(d)[0];
    const backward = parsePath(d)[0];
    reverseSubpath(backward); // same join, arrived at from the other side

    setContinuity(forward, 1, 'smooth');
    setContinuity(backward, 1, 'smooth');

    const f = forward.nodes[1];
    const b = backward.nodes[1];
    expect(b.pt).toEqual(f.pt);
    // Reversal swaps in for out, so `b`'s outgoing handle is `f`'s incoming
    // one. The tangent LINE both nodes settle on must be the same either way,
    // which averaging the two directions guarantees and adopting one does not.
    const vf = [f.hOut![0] - f.pt[0], f.hOut![1] - f.pt[1]];
    const vb = [b.pt[0] - b.hOut![0], b.pt[1] - b.hOut![1]];
    expect(Math.abs(vf[0] * vb[1] - vf[1] * vb[0])).toBeLessThan(1e-9);
  });

  it('equalises lengths for symmetric, keeping the average', () => {
    const sp = curve();
    sp.nodes[1].hIn = [40, 10];
    setContinuity(sp, 1, 'symmetric');
    const n = sp.nodes[1];
    expect(Math.hypot(n.hIn![0] - n.pt[0], n.hIn![1] - n.pt[1])).toBeCloseTo(15, 9);
    expect(Math.hypot(n.hOut![0] - n.pt[0], n.hOut![1] - n.pt[1])).toBeCloseTo(15, 9);
  });

  it('makes a corner by removing the handles outright', () => {
    // The honest reading: with no stored flag, a node is only a corner because
    // of where its handles are, so "make corner" has to move something.
    const sp = curve();
    setContinuity(sp, 1, 'corner');
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes[1].hOut).toBeNull();
    expect(continuityOf(sp.nodes[1])).toBe('corner');
  });

  it('leaves a node with a straight side alone', () => {
    const sp = parsePath('M0 0 L10 0 C15 0 20 5 20 10')[0];
    const before = { ...sp.nodes[1] };
    setContinuity(sp, 1, 'smooth');
    expect(sp.nodes[1].hIn).toBe(before.hIn);
    expect(sp.nodes[1].hOut).toEqual(before.hOut);
  });

  it('is idempotent', () => {
    const sp = parsePath('M0 0 C0 20 40 20 40 0 C60 -20 80 -20 80 0')[0];
    setContinuity(sp, 1, 'smooth');
    const once = cloneNode(sp.nodes[1]);
    setContinuity(sp, 1, 'smooth');
    // Not an exact comparison: re-normalising an already-unit vector shifts the
    // last bit or two. What matters is that repeating the command does not walk
    // the handles anywhere, which a 1e-12 bound establishes and byte equality
    // would fail on for reasons that have nothing to do with the behaviour.
    const n = sp.nodes[1];
    for (const k of ['hIn', 'hOut'] as const) {
      expect(Math.hypot(n[k]![0] - once[k]![0], n[k]![1] - once[k]![1])).toBeLessThan(1e-12);
    }
  });
});

describe('splitting', () => {
  it('inserts a node without changing the drawn shape', () => {
    const sp = curve();
    const before = sample(sp);
    const orig = segmentAsCubic(sp, 0);
    const i = splitSegment(sp, 0, 0.37);
    expect(i).toBe(1);
    expect(sp.nodes).toHaveLength(4);
    // The new anchor must sit exactly on the original curve at t.
    expect(sp.nodes[1].pt[0]).toBeCloseTo(cubicAt(orig, 0.37)[0], 9);
    expect(sp.nodes[1].pt[1]).toBeCloseTo(cubicAt(orig, 0.37)[1], 9);
    expect(deviation(before, sp)).toBeLessThan(1e-9);
  });

  it('keeps a split line straight', () => {
    // Subdividing a rectangle's edge must not quietly make it a curve.
    const sp = square();
    splitSegment(sp, 0, 0.5);
    expect(sp.nodes[1].pt).toEqual([5, 0]);
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes[1].hOut).toBeNull();
    expect(serialisePath([sp])).toBe('M 0 0 H 5 H 10 V 10 H 0 Z');
  });

  it('splits the closing segment of a ring', () => {
    const sp = parsePath('M0 0 C10 -10 30 -10 40 0 C30 10 10 10 0 0 Z')[0];
    const before = sample(sp);
    splitSegment(sp, segmentCount(sp) - 1, 0.5);
    expect(deviation(before, sp)).toBeLessThan(1e-9);
  });
});

describe('deleting', () => {
  it('undoes a split almost exactly', () => {
    // The guarantee that matters: a node carrying no information should cost
    // almost nothing to remove. The handle rescale is exactly the inverse of a
    // de Casteljau split when the split was even, so this round-trips.
    const sp = curve();
    const before = sample(sp);
    splitSegment(sp, 0, 0.5);
    expect(sp.nodes).toHaveLength(4);
    expect(deleteNode(sp, 1)).toBe(true);
    expect(sp.nodes).toHaveLength(3);
    expect(deviation(before, sp)).toBeLessThan(1e-3);
  });

  it('is lossy when the removed node carried an inflection', () => {
    // Honest bound rather than a flattering one. This curve is an S: node 1 is
    // where it changes direction, so no single cubic can replace two here.
    // Handle rescaling keeps the end tangents and nothing more.
    const sp = curve();
    const before = sample(sp);
    expect(deleteNode(sp, 1)).toBe(true);
    expect(sp.nodes).toHaveLength(2);
    const err = deviation(before, sp);
    expect(err).toBeGreaterThan(1); // genuinely lossy, not silently perfect
    expect(err).toBeLessThan(0.12 * 80); // but bounded, on an 80-unit span
  });

  it('keeps collinear edges straight when fusing them', () => {
    const sp = parsePath('M0 0 L5 0 L10 0 L10 10')[0];
    deleteNode(sp, 1);
    expect(sp.nodes[0].hOut).toBeNull();
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('refuses to reduce a ring below three nodes', () => {
    const sp = parsePath('M0 0 L10 0 L5 10 Z')[0];
    expect(deleteNode(sp, 0)).toBe(false);
    expect(sp.nodes).toHaveLength(3);
  });

  it('shortens an open path when an endpoint goes', () => {
    const sp = parsePath('M0 0 C0 10 10 10 10 0 L20 0')[0];
    expect(deleteNode(sp, 2)).toBe(true);
    expect(sp.nodes).toHaveLength(2);
    expect(sp.nodes[1].hOut).toBeNull();
  });
});

describe('segment type', () => {
  it('round-trips curve -> line -> curve', () => {
    const sp = square();
    setSegmentCurved(sp, 0, true);
    expect(sp.nodes[0].hOut).not.toBeNull();
    expect(sp.nodes[1].hIn).not.toBeNull();
    setSegmentCurved(sp, 0, false);
    expect(sp.nodes[0].hOut).toBeNull();
    expect(sp.nodes[1].hIn).toBeNull();
    expect(serialisePath([sp])).toBe('M 0 0 H 10 V 10 H 0 Z');
  });

  it('emits a curve command once a segment is actually bent', () => {
    const sp = square();
    setSegmentCurved(sp, 0, true);
    moveHandle(sp, 0, 'out', [3, -6]);
    expect(serialisePath([sp])).toContain('C');
  });

  it('seeds handles at the thirds so the line is unchanged at first', () => {
    const sp = square();
    const before = sample(sp);
    setSegmentCurved(sp, 0, true);
    // Controls at the thirds of a chord reproduce that chord exactly.
    expect(sp.nodes[0].hOut![0]).toBeCloseTo(10 / 3, 9);
    expect(sp.nodes[1].hIn![0]).toBeCloseTo(20 / 3, 9);
    expect(deviation(before, sp)).toBeLessThan(1e-9);
  });
});

describe('transforms', () => {
  it('returns to the start after four 90 degree rotations', () => {
    const shape = shapeFromPath('M0 0 C0 20 40 20 40 0 L40 30 Z');
    const before = sample(shape.subpaths[0]);
    const m = about(rotate(90), 10, 10);
    for (let i = 0; i < 4; i++) transformShape(shape, m);
    expect(pointwise(before, sample(shape.subpaths[0]))).toBeLessThan(1e-12);
  });

  it('is an involution for flips', () => {
    // Deliberately asymmetric: a shape symmetric about the flip axis would
    // pass the round-trip while proving nothing about the first flip.
    const shape = shapeFromPath('M0 0 C0 20 40 20 40 0 L30 -12 Z');
    const before = sample(shape.subpaths[0]);
    transformShape(shape, about(flipX(), 20, 0));
    expect(pointwise(before, sample(shape.subpaths[0]))).toBeGreaterThan(1);
    transformShape(shape, about(flipX(), 20, 0));
    expect(pointwise(before, sample(shape.subpaths[0]))).toBeLessThan(1e-12);
  });

  it('transforms arcs with no special case at all', () => {
    // The point of normalising to cubics: an imported arc is just nodes, so a
    // 37 degree rotation needs no ellipse algebra and loses nothing.
    const shape = shapeFromPath('M0 0 A10 6 25 1 1 20 0');
    const before = sample(shape.subpaths[0]);
    const m = about(rotate(37), 5, 5);
    transformShape(shape, m);
    const inv = about(rotate(-37), 5, 5);
    transformShape(shape, inv);
    expect(pointwise(before, sample(shape.subpaths[0]))).toBeLessThan(1e-12);
  });

  it('scales the bounding box proportionally', () => {
    const shape = shapeFromPath('M0 0 L10 0 L10 10 L0 10 Z');
    transformShape(shape, scale(2, 3));
    const b = shapeBBox(shape)!;
    expect(b.x1 - b.x0).toBeCloseTo(20, 9);
    expect(b.y1 - b.y0).toBeCloseTo(30, 9);
  });

  it('translates without distorting', () => {
    const shape = shapeFromPath('M0 0 C0 20 40 20 40 0 Z');
    const before = sample(shape.subpaths[0]);
    transformShape(shape, translate(7, -3));
    const after = sample(shape.subpaths[0]);
    for (let i = 0; i < before.length; i++) {
      expect(after[i][0]).toBeCloseTo(before[i][0] + 7, 9);
      expect(after[i][1]).toBeCloseTo(before[i][1] - 3, 9);
    }
  });
});

describe('reversing', () => {
  /** Segment `i` of `sp`, as a cubic, rounded so exact comparison is safe. */
  const seg = (sp: Subpath, i: number): number[][] =>
    segmentAsCubic(sp, i).map((p) => [+p[0].toFixed(9), +p[1].toFixed(9)]);
  const flip = (c: number[][]): number[][] => [...c].reverse();

  it('turns an open path back to front, segment for segment', () => {
    // Exact rather than sampled: reversal is supposed to be lossless, so
    // asserting to within a projection tolerance would hide a real error.
    const sp = curve();
    const original = [seg(sp, 0), seg(sp, 1)];
    reverseSubpath(sp);

    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [80, 0],
      [40, 0],
      [0, 0],
    ]);
    expect(seg(sp, 0)).toEqual(flip(original[1]));
    expect(seg(sp, 1)).toEqual(flip(original[0]));
  });

  it('turns a ring back to front while keeping its first node', () => {
    const sp = parsePath('M0 0 C10 -10 30 -10 40 0 C30 10 10 10 0 0 Z')[0];
    const original = [seg(sp, 0), seg(sp, 1)];
    const first = [...sp.nodes[0].pt];
    reverseSubpath(sp);

    // Node 0 is unchanged, so the ring is re-rooted rather than rotated.
    expect(sp.nodes[0].pt).toEqual(first);
    expect(segmentCount(sp)).toBe(2);
    expect(seg(sp, 0)).toEqual(flip(original[1]));
    expect(seg(sp, 1)).toEqual(flip(original[0]));
  });

  it('is its own inverse', () => {
    const sp = curve();
    const before = JSON.stringify(sp);
    reverseSubpath(sp);
    reverseSubpath(sp);
    expect(JSON.stringify(sp)).toBe(before);
  });
});

describe('snapping', () => {
  it('rounds to the grid step', () => {
    expect(snap([1.4, 2.6], 1)).toEqual([1, 3]);
    expect(snap([1.4, 2.6], 0.5)).toEqual([1.5, 2.5]);
  });

  it('is a no-op when disabled', () => {
    expect(snap([1.4, 2.6], 0)).toEqual([1.4, 2.6]);
  });
});

describe('history', () => {
  const mk = (): Store => {
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath('M0 0 L10 0 L10 10 Z'));
    return new Store(doc);
  };

  it('undoes and redoes a single edit', () => {
    const store = mk();
    const id = store.state.doc.shapes[0].id;
    store.edit((s) => moveAnchor(s.doc.shapes[0].subpaths[0], 0, [5, 5]));
    expect(store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([5, 5]);

    store.undo();
    expect(store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([0, 0]);
    store.redo();
    expect(store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([5, 5]);
    // Undo must not swap the document for a different one.
    expect(store.state.doc.shapes[0].id).toBe(id);
  });

  it('collapses a whole drag into one undo step', () => {
    const store = mk();
    store.beginBatch();
    store.checkpoint();
    for (let i = 1; i <= 20; i++) {
      store.update((s) => moveAnchor(s.doc.shapes[0].subpaths[0], 0, [i, i]));
    }
    store.endBatch();

    expect(store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([20, 20]);
    store.undo();
    expect(store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([0, 0]);
    expect(store.canUndo).toBe(false);
  });

  it('snapshots deeply, so later edits cannot corrupt history', () => {
    const store = mk();
    store.edit((s) => moveAnchor(s.doc.shapes[0].subpaths[0], 0, [5, 5]));
    store.edit((s) => moveAnchor(s.doc.shapes[0].subpaths[0], 1, [99, 99]));
    store.undo();
    store.undo();
    expect(store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([0, 0]);
    expect(store.state.doc.shapes[0].subpaths[0].nodes[1].pt).toEqual([10, 0]);
  });

  it('drops the redo stack once a new edit lands', () => {
    const store = mk();
    store.edit((s) => moveAnchor(s.doc.shapes[0].subpaths[0], 0, [5, 5]));
    store.undo();
    expect(store.canRedo).toBe(true);
    store.edit((s) => moveAnchor(s.doc.shapes[0].subpaths[0], 0, [1, 1]));
    expect(store.canRedo).toBe(false);
  });
});
