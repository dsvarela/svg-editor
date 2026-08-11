import { describe, expect, it } from 'vitest';
import { parsePath } from '../src/core/parse';
import { serialisePath } from '../src/core/serialise';
import { cubicAt, projectToCubic } from '../src/core/bezier';
import { about, flipX, rotate, scale, translate } from '../src/core/affine';
import { cloneNode, continuityOf, segmentAsCubic, segmentCount } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';
import {
  breakAt,
  connectEnds,
  mergeEnds,
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

  it('gives a corner handles rather than declining', () => {
    // The old behaviour was to leave a handle-less node alone, which read as a
    // dead button: the node stayed a corner and nothing on screen moved.
    const sp = parsePath('M0 0 L10 0 L20 10 L30 10')[0];
    expect(continuityOf(sp.nodes[1])).toBe('corner');

    setContinuity(sp, 1, 'smooth');

    expect(sp.nodes[1].hIn).not.toBeNull();
    expect(sp.nodes[1].hOut).not.toBeNull();
    expect(continuityOf(sp.nodes[1])).toBe('smooth');
  });

  it('does not move the drawing when the sides are already in line', () => {
    // A straight segment whose far handle sits on the chord is still that exact
    // straight line, so materialising one changes the spelling and nothing else.
    const sp = parsePath('M0 0 L10 0 C15 0 20 5 20 10')[0];
    setContinuity(sp, 1, 'smooth');

    expect(continuityOf(sp.nodes[1])).toBe('smooth');
    expect(sp.nodes[1].hOut).toEqual([15, 0]);
    // On the chord from node 0 to node 1, so segment 0 is still the same line.
    const hIn = sp.nodes[1].hIn!;
    expect(hIn[1]).toBeCloseTo(0, 12);
    expect(hIn[0]).toBeGreaterThan(0);
    expect(hIn[0]).toBeLessThan(10);
  });

  it('declines at the end of an open path without touching it', () => {
    /* The fixture matters. This used to start `M0 0 C5 0 10 5 10 10`, which
       gives node 0 an outgoing handle already -- so the branch that
       materialises one was never entered and the test could not fail on the
       defect it named. With two straight segments the branch is reached, and
       the assertion that hOut stays null is what goes red: the old code
       assigned it and *then* declined, leaving a straight segment carrying a
       handle and reporting that nothing had happened. */
    const sp = parsePath('M0 0 L10 10 L20 0')[0];
    const before = serialisePath([sp]);

    expect(setContinuity(sp, 0, 'smooth')).toBe(false);
    expect(sp.nodes[0].hIn).toBeNull();
    expect(sp.nodes[0].hOut).toBeNull();
    expect(continuityOf(sp.nodes[0])).toBe('corner');
    // Nothing about the path changed, not even its spelling.
    expect(serialisePath([sp])).toBe(before);
  });

  it('reports whether it changed anything, so a dead click costs no history', () => {
    const sp = parsePath('M0 0 L10 0 L10 10')[0];
    expect(setContinuity(sp, 1, 'smooth')).toBe(true);
    // Asking for the same thing twice is a no-op the second time.
    expect(setContinuity(sp, 1, 'smooth')).toBe(false);
    // A corner that is already a corner has nothing to remove.
    expect(setContinuity(sp, 0, 'corner')).toBe(false);
  });

  it('moves the drawing when it materialises handles, and says so', () => {
    /* The invariant record used to claim this did not move the drawing, on the
       reasoning that a latent handle sits on its own chord. It does -- and is
       then rotated to the averaged direction, which pulls it off. Pinning the
       real figure means the claim cannot drift back. */
    const sp = parsePath('M0 0 L10 0 L10 10')[0];
    const before = segmentAsCubic(sp, 0);
    setContinuity(sp, 1, 'smooth');
    const after = segmentAsCubic(sp, 0);

    let worst = 0;
    for (let k = 0; k <= 32; k++) {
      const a = cubicAt(before, k / 32);
      const b = cubicAt(after, k / 32);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    expect(worst).toBeGreaterThan(1);
    expect(worst).toBeLessThan(2);
  });

  it('lands on symmetric, not smooth, when the two chords are equal', () => {
    // Which makes the documented corner -> smooth -> symmetric cycle a
    // two-state toggle on a square. Recorded rather than fixed: the handles are
    // where `smooth` puts them, and equal chords make them equal lengths.
    const sp = parsePath('M0 0 L10 0 L10 10')[0];
    setContinuity(sp, 1, 'smooth');
    expect(continuityOf(sp.nodes[1])).toBe('symmetric');
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

  it('reduces a three-node ring to two, rather than refusing', () => {
    // This used to return false. A ring of three was exactly at the old floor,
    // so it could not be reduced at all -- and a floor that refuses is worse
    // than the degenerate shapes it was protecting against, because a refusal
    // is invisible and the shapes are not.
    const sp = parsePath('M0 0 L10 0 L5 10 Z')[0];
    expect(deleteNode(sp, 0)).toBe(true);
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [10, 0],
      [5, 10],
    ]);
    // Still closed: two straight segments between the same pair of points,
    // which is what draws as a plain line.
    expect(sp.closed).toBe(true);
  });

  it('never refuses a valid index, however small the subpath gets', () => {
    for (const d of ['M0 0 L10 0 L5 10 Z', 'M0 0 C2 8 8 8 10 0 Z', 'M0 0 L10 0']) {
      const sp = parsePath(d)[0];
      let guard = 0;
      while (sp.nodes.length && guard++ < 10) expect(deleteNode(sp, 0)).toBe(true);
      expect(sp.nodes).toHaveLength(0);
    }
  });

  it('drops the closed flag once a subpath is down to one node', () => {
    // A single node cannot be closed -- there is nothing to close onto -- and
    // leaving the flag set would make `segmentCount` claim a segment that does
    // not exist.
    const sp = parsePath('M0 0 L10 0 L5 10 Z')[0];
    deleteNode(sp, 0);
    deleteNode(sp, 0);
    expect(sp.nodes).toHaveLength(1);
    expect(sp.closed).toBe(false);
    expect(segmentCount(sp)).toBe(0);
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

describe('breaking', () => {
  /** Dense samples along every segment, in order, for "did the drawing move?". */
  const trace = (sps: Subpath[], per = 16): Pt[] => {
    const out: Pt[] = [];
    for (const sp of sps) {
      for (let i = 0; i < segmentCount(sp); i++) {
        const c = segmentAsCubic(sp, i);
        for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per));
      }
    }
    return out;
  };

  const maxDrift = (a: Pt[], b: Pt[]): number => {
    if (a.length !== b.length) return Infinity;
    let worst = 0;
    for (let i = 0; i < a.length; i++) {
      worst = Math.max(worst, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
    }
    return worst;
  };

  it('is lossless where deleting is not', () => {
    // The contrast is the reason both operations exist. `deleteNode` fuses two
    // cubics into one, which cannot be exact across an inflection; `breakAt`
    // removes a join instead of a point, so nothing moves at all.
    const d = 'M0 0 C10 -20 30 20 40 0 C50 -20 70 20 80 0';

    const broken = parsePath(d);
    const before = trace(broken);
    const pieces = breakAt(broken[0], 1)!;
    expect(maxDrift(trace(pieces), before)).toBeLessThan(1e-9);

    const deleted = parsePath(d);
    deleteNode(deleted[0], 1);
    expect(maxDrift(trace(deleted), before)).toBeGreaterThan(1);
  });

  it('duplicates the node so both ends sit where it was', () => {
    const sp = parsePath('M0 0 L10 0 L20 0 L30 0')[0];
    const [head, tail] = breakAt(sp, 1)!;
    expect(head.nodes[head.nodes.length - 1].pt).toEqual([10, 0]);
    expect(tail.nodes[0].pt).toEqual([10, 0]);
    // Total node count grows by exactly one.
    expect(head.nodes.length + tail.nodes.length).toBe(sp.nodes.length + 1);
  });

  it('clears only the handle facing the side that was cut away', () => {
    const sp = parsePath('M0 0 C5 -10 15 -10 20 0 C25 10 35 10 40 0')[0];
    const [head, tail] = breakAt(sp, 1)!;
    const cut = head.nodes[head.nodes.length - 1];
    expect(cut.hOut).toBeNull();
    expect(cut.hIn).not.toBeNull();
    expect(tail.nodes[0].hIn).toBeNull();
    expect(tail.nodes[0].hOut).not.toBeNull();
  });

  it('opens a closed subpath in place rather than splitting it', () => {
    const sp = parsePath('M0 0 L20 0 L20 20 L0 20 Z')[0];
    const pieces = breakAt(sp, 1)!;
    expect(pieces).toHaveLength(1);
    expect(pieces[0].closed).toBe(false);
    expect(pieces[0].nodes[0].pt).toEqual([20, 0]);
    expect(pieces[0].nodes[pieces[0].nodes.length - 1].pt).toEqual([20, 0]);
    // A closed ring of n has n segments; the opened path of n+1 nodes has n too.
    expect(segmentCount(pieces[0])).toBe(segmentCount(sp));
  });

  it('does not alias the original nodes', () => {
    // The pieces replace the subpath in the document, so sharing node objects
    // with it would make a later edit write through to the undo snapshot.
    const sp = parsePath('M0 0 L10 0 L20 0 L30 0')[0];
    const [head] = breakAt(sp, 1)!;
    head.nodes[0].pt[0] = 999;
    expect(sp.nodes[0].pt[0]).toBe(0);
  });

  it('returns null at an endpoint, where there is no second side', () => {
    const sp = parsePath('M0 0 L10 0 L20 0')[0];
    expect(breakAt(sp, 0)).toBeNull();
    expect(breakAt(sp, 2)).toBeNull();
    expect(breakAt(sp, 7)).toBeNull();
  });
});

describe('mergeEnds', () => {
  /* The inverse of breakAt. The case that has to be exactly lossless is undoing
     a break, where the two ends are already coincident and nothing should move
     at all. */
  it('undoes a break exactly', () => {
    const sp = parsePath('M0 0 C10 0 20 10 20 20 C20 30 30 40 40 40')[0];
    const before = sample(sp, 32);

    // Node 1 is the middle one; 2 ends the path and has nothing to split off.
    const pieces = breakAt(sp, 1)!;
    expect(pieces).toHaveLength(2);
    const rejoined = mergeEnds({ sp: pieces[0], i: pieces[0].nodes.length - 1 }, { sp: pieces[1], i: 0 })!;

    expect(rejoined.nodes).toHaveLength(sp.nodes.length);
    sample(rejoined, 32).forEach((p, i) => {
      expect(p[0]).toBeCloseTo(before[i][0], 9);
      expect(p[1]).toBeCloseTo(before[i][1], 9);
    });
  });

  it('meets in the middle when the ends are apart', () => {
    const a = parsePath('M0 0 L10 0')[0];
    const b = parsePath('M20 0 L30 0')[0];
    const j = mergeEnds({ sp: a, i: 1 }, { sp: b, i: 0 })!;
    expect(j.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [15, 0],
      [30, 0],
    ]);
  });

  it('reverses whichever path is facing the wrong way', () => {
    // Both selected ends are the paths' first nodes, so `a` has to be flipped.
    const a = parsePath('M10 0 L0 0')[0];
    const b = parsePath('M20 0 L30 0')[0];
    const j = mergeEnds({ sp: a, i: 0 }, { sp: b, i: 0 })!;
    expect(j.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [15, 0],
      [30, 0],
    ]);
  });

  it('keeps the handle facing away from the joint', () => {
    const a = parsePath('M0 0 C5 -8 10 -8 10 0')[0];
    const b = parsePath('M10 0 C10 8 15 8 20 0')[0];
    const j = mergeEnds({ sp: a, i: 1 }, { sp: b, i: 0 })!;
    const weld = j.nodes[1];
    // The incoming handle came from `a`, the outgoing one from `b`.
    expect(weld.hIn).toEqual([10, -8]);
    expect(weld.hOut).toEqual([10, 8]);
  });

  it('closes a path when both ends belong to it', () => {
    const sp = parsePath('M0 0 L10 0 L10 10 L0.4 0.4')[0];
    const j = mergeEnds({ sp, i: 0 }, { sp, i: 3 })!;
    expect(j.closed).toBe(true);
    expect(j.nodes).toHaveLength(3);
    // The two ends met in the middle rather than one winning.
    expect(j.nodes[0].pt).toEqual([0.2, 0.2]);
  });

  it('refuses a node that is not a free end', () => {
    const sp = parsePath('M0 0 L10 0 L10 10')[0];
    const other = parsePath('M20 0 L30 0')[0];
    // Middle node.
    expect(mergeEnds({ sp, i: 1 }, { sp: other, i: 0 })).toBeNull();
    // Same node twice.
    expect(mergeEnds({ sp, i: 0 }, { sp, i: 0 })).toBeNull();
    // A closed path has no free ends at all.
    const ring = parsePath('M0 0 L10 0 L10 10 Z')[0];
    expect(mergeEnds({ sp: ring, i: 0 }, { sp: other, i: 0 })).toBeNull();
  });

  it('refuses to close a two-node path, which would leave one node', () => {
    const sp = parsePath('M0 0 L10 0')[0];
    expect(mergeEnds({ sp, i: 0 }, { sp, i: 1 })).toBeNull();
  });
});

describe('connectEnds', () => {
  /* The other half of the pair, and the one the word "join" actually suggests:
     draw the line that is missing and move nothing. A single operation covering
     both was wrong in the way names usually are -- it did the destructive one. */
  it('spans the gap without moving either end', () => {
    const a = parsePath('M0 0 L10 0')[0];
    const b = parsePath('M20 0 L30 0')[0];
    const j = connectEnds({ sp: a, i: 1 }, { sp: b, i: 0 })!;
    expect(j.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ]);
    expect(j.closed).toBe(false);
  });

  it('leaves the new segment straight', () => {
    // Free for the same reason a rectangle's sides are straight: the last node
    // of an open path has no outgoing handle and the first has no incoming one.
    const a = parsePath('M0 0 C5 -8 10 -8 10 0')[0];
    const b = parsePath('M20 0 C20 8 25 8 30 0')[0];
    const j = connectEnds({ sp: a, i: 1 }, { sp: b, i: 0 })!;
    expect(j.nodes[1].hOut).toBeNull();
    expect(j.nodes[2].hIn).toBeNull();
    // And the curves either side are untouched.
    expect(j.nodes[1].hIn).toEqual([10, -8]);
    expect(j.nodes[2].hOut).toEqual([20, 8]);
  });

  it('closes a path without losing a node, unlike merge', () => {
    const forConnect = parsePath('M0 0 L10 0 L10 10')[0];
    const forMerge = parsePath('M0 0 L10 0 L10 10')[0];

    const c = connectEnds({ sp: forConnect, i: 0 }, { sp: forConnect, i: 2 })!;
    expect(c.closed).toBe(true);
    expect(c.nodes).toHaveLength(3);
    expect(c.nodes[0].pt).toEqual([0, 0]);

    const m = mergeEnds({ sp: forMerge, i: 0 }, { sp: forMerge, i: 2 })!;
    expect(m.closed).toBe(true);
    expect(m.nodes).toHaveLength(2);
  });

  it('reverses whichever path faces the wrong way', () => {
    const a = parsePath('M10 0 L0 0')[0];
    const b = parsePath('M20 0 L30 0')[0];
    const j = connectEnds({ sp: a, i: 0 }, { sp: b, i: 0 })!;
    expect(j.nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ]);
  });

  it('refuses anything that is not two free ends', () => {
    const sp = parsePath('M0 0 L10 0 L10 10')[0];
    const other = parsePath('M20 0 L30 0')[0];
    expect(connectEnds({ sp, i: 1 }, { sp: other, i: 0 })).toBeNull();
    expect(connectEnds({ sp, i: 0 }, { sp, i: 0 })).toBeNull();
  });
});
