import { describe, expect, it } from 'vitest';
import { parsePath } from '../src/core/parse';
import { serialisePath } from '../src/core/serialise';
import { cubicAt, projectToCubic } from '../src/core/bezier';
import { about, flipX, rotate, scale, translate } from '../src/core/affine';
import { cloneNode, continuityOf, makeNode, segmentAsCubic, segmentCount } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';
import {
  breakAt,
  connectEnds,
  mergeEnds,
  deleteNode,
  latentHandle,
  moveAnchor,
  moveHandle,
  reshapeSegment,
  reverseSubpath,
  setContinuity,
  setSegmentCurved,
  snap,
  splitSegment,
  transformShape,
  alignNodes,
  distributeNodes,
  slidingParent,
  slideNodeTo,
} from '../src/model/ops';
import {
  roundCorner,
} from '../src/model/corner';
import { emptyDoc, shapeFromPath, shapeBBox, selectedNodes, emptySelection } from '../src/model/doc';
import type { NodeRef } from '../src/model/doc';
import type {
  AlignMode,
} from '../src/model/ops';
import type { Doc } from '../src/core/types';
import { KAPPA } from '../src/core/primitives';
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
    expect(continuityOf(sp.nodes[1])).toBe('cusp');
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
    expect(continuityOf(sp.nodes[1])).toBe('cusp');

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

describe('where a missing handle would sit', () => {
  /* Two nodes is the smallest subpath that has a segment, and `deleteNode`
     produces one whenever a ring of three loses a node -- so the floor below
     which there is no neighbour to point at is one node, not two. */
  it('answers on the smallest subpath that has a segment', () => {
    const open = parsePath('M4 6 L34 6')[0];
    expect(latentHandle(open, 0, 'out')).toEqual([14, 6]);
    expect(latentHandle(open, 1, 'in')).toEqual([24, 6]);
    expect(latentHandle(open, 0, 'in')).toBeNull();
    expect(latentHandle(open, 1, 'out')).toBeNull();
  });

  it('wraps on a closed pair, where both sides lead to the same neighbour', () => {
    const ring = parsePath('M4 6 L34 6 Z')[0];
    expect(latentHandle(ring, 0, 'out')).toEqual([14, 6]);
    expect(latentHandle(ring, 0, 'in')).toEqual([14, 6]);
  });

  it('has nothing to point at when a subpath is down to one node', () => {
    const lone = parsePath('M4 6 L34 6')[0];
    lone.nodes.length = 1;
    expect(latentHandle(lone, 0, 'out')).toBeNull();
    expect(latentHandle(lone, 0, 'in')).toBeNull();
    lone.closed = true;
    expect(latentHandle(lone, 0, 'out')).toBeNull();
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
    setContinuity(sp, 1, 'cusp');
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes[1].hOut).toBeNull();
    expect(continuityOf(sp.nodes[1])).toBe('cusp');
  });

  it('gives a corner handles rather than declining', () => {
    // Leaving a handle-less node alone reads as a dead button: the node stays
    // a corner and nothing on screen moves.
    const sp = parsePath('M0 0 L10 0 L20 10 L30 10')[0];
    expect(continuityOf(sp.nodes[1])).toBe('cusp');

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
    /* The fixture matters. A path like `M0 0 C5 0 10 5 10 10` gives node 0 an
       outgoing handle already, so the branch that materialises one is never
       entered and the test cannot fail on the defect it names. Two straight
       segments reach the branch, and the assertion that hOut stays null is what
       goes red if the handle is assigned before the decline, which would leave
       a straight segment carrying a handle while reporting no change. */
    const sp = parsePath('M0 0 L10 10 L20 0')[0];
    const before = serialisePath([sp]);

    expect(setContinuity(sp, 0, 'smooth')).toBe(false);
    expect(sp.nodes[0].hIn).toBeNull();
    expect(sp.nodes[0].hOut).toBeNull();
    expect(continuityOf(sp.nodes[0])).toBe('cusp');
    // Nothing about the path changed, not even its spelling.
    expect(serialisePath([sp])).toBe(before);
  });

  it('reports whether it changed anything, so a dead click costs no history', () => {
    const sp = parsePath('M0 0 L10 0 L10 10')[0];
    expect(setContinuity(sp, 1, 'smooth')).toBe(true);
    // Asking for the same thing twice is a no-op the second time.
    expect(setContinuity(sp, 1, 'smooth')).toBe(false);
    // A corner that is already a corner has nothing to remove.
    expect(setContinuity(sp, 0, 'cusp')).toBe(false);
  });

  it('moves the drawing when it materialises handles, and says so', () => {
    /* A latent handle sits on its own chord, which reads as leaving the drawing
       alone, but it is then rotated to the averaged direction and that pulls it
       off. Pinning the real figure is what stops the harmless-sounding version
       being written down again. */
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
    // Subdividing a rectangle's edge must not quietly make it a curve. Split
    // off the midpoint, which is the one parameter a line's two candidate
    // parameterisations agree on: at 0.5 this passes either way.
    const sp = square();
    splitSegment(sp, 0, 0.3);
    expect(sp.nodes[1].pt).toEqual([3, 0]);
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes[1].hOut).toBeNull();
    expect(serialisePath([sp])).toBe('M 0 0 H 3 H 10 V 10 H 0 Z');
  });

  /* One `t`, one point, whatever the segment is made of.
     `splitSegment` and `segmentAsCubic` are the two functions that turn a
     parameter into a position, and every gesture that puts a node on an
     outline reads one and writes the other: `nearestOnPath` projects against
     the cubic, `splitSegment` inserts at the parameter it returns. While the
     two disagreed on straight segments a double-click landed its node up to
     19 units from the pointer on a 200-unit line, with the hover marker
     drawn at the right place throughout, because the marker is the projected
     point and the node is the parameter. §69. */
  it.each([0.1, 0.25, 0.37, 0.5, 0.75, 0.9])(
    'puts the node where the segment says t = %f is, straight or curved',
    (t) => {
      for (const sp of [square(), curve()]) {
        const before = segmentAsCubic(sp, 0);
        const want = cubicAt(before, t);
        const i = splitSegment(sp, 0, t);
        expect(sp.nodes[i].pt[0]).toBeCloseTo(want[0], 9);
        expect(sp.nodes[i].pt[1]).toBeCloseTo(want[1], 9);
      }
    },
  );

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
    // A ring of three sits exactly at the floor any minimum-size rule would
    // impose, so such a rule makes it irreducible. A floor that refuses is
    // worse than the degenerate shapes it protects against, because a refusal
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

  it('clears the handle facing the end that was removed, at either end', () => {
    // The new end has no segment beyond it, and a handle there would make
    // `segmentIsLine` disagree with the fact that nothing is drawn past it.
    const head = parsePath('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0')[0];
    expect(deleteNode(head, 0)).toBe(true);
    expect(head.nodes[0].pt).toEqual([10, 0]);
    expect(head.nodes[0].hIn).toBeNull();
    expect(head.nodes[0].hOut).not.toBeNull();

    const tail = parsePath('M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0')[0];
    expect(deleteNode(tail, 2)).toBe(true);
    expect(tail.nodes[1].pt).toEqual([10, 0]);
    expect(tail.nodes[1].hOut).toBeNull();
    expect(tail.nodes[1].hIn).not.toBeNull();
  });

  it('refuses an index the subpath does not have, and changes nothing', () => {
    // The caller loops over a selection and reads the answer to decide whether
    // to record an undo entry, so a refusal has to be both reported and true.
    const sp = parsePath('M0 0 C0 10 10 10 10 0 L20 0')[0];
    const before = JSON.stringify(sp);
    for (const i of [-1, 3, 99]) expect(deleteNode(sp, i)).toBe(false);
    expect(JSON.stringify(sp)).toBe(before);
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

describe('roundCorner', () => {
  /** A 40 by 20 rectangle. Node 1 is the corner at (40, 0). */
  const rect = (): Subpath => parsePath('M0 0 L40 0 L40 20 L0 20 Z')[0];

  it('replaces the corner with two nodes at the tangent points', () => {
    const sp = rect();
    const r = roundCorner(sp, 1, 6) as { radius: number; clamped: boolean };
    expect(r.radius).toBeCloseTo(6, 9);
    expect(r.clamped).toBe(false);
    expect(sp.nodes.length).toBe(5);

    // A right angle, so the tangent points sit exactly `r` back along each side.
    expect(sp.nodes[1].pt[0]).toBeCloseTo(34, 9);
    expect(sp.nodes[1].pt[1]).toBeCloseTo(0, 9);
    expect(sp.nodes[2].pt[0]).toBeCloseTo(40, 9);
    expect(sp.nodes[2].pt[1]).toBeCloseTo(6, 9);
  });

  it('leaves the sides straight and meets them without a kink', () => {
    // The whole point of a fillet. The model calls a node with one handle a
    // corner, so tangency has to be measured rather than read off continuity.
    const sp = rect();
    roundCorner(sp, 1, 6);

    expect(sp.nodes[0].hOut).toBeNull();
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes[2].hOut).toBeNull();

    const along = (from: Pt, to: Pt): Pt => {
      const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
      return [(to[0] - from[0]) / d, (to[1] - from[1]) / d];
    };
    const incoming = along(sp.nodes[0].pt, sp.nodes[1].pt);
    const leaving = along(sp.nodes[1].pt, sp.nodes[1].hOut!);
    expect(leaving[0]).toBeCloseTo(incoming[0], 9);
    expect(leaving[1]).toBeCloseTo(incoming[1], 9);
  });

  it('draws an arc of the radius it reports', () => {
    const sp = rect();
    const r = roundCorner(sp, 1, 6) as { radius: number };
    // For a right angle the centre is one radius in from each side.
    const centre: Pt = [34, 6];
    /* Not exact, and cannot be: a cubic is not a circular arc. The bound is the
       one this editor states everywhere else, about 0.027 % of the radius for
       a quarter turn. Measured here at 0.0272 %, which is what "about" was
       covering; the point of the test is that the fillet is inside the bound
       rather than merely close to the circle. */
    for (const p of sample({ nodes: [sp.nodes[1], sp.nodes[2]], closed: false }, 32)) {
      const off = Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - r.radius);
      expect(off / r.radius).toBeLessThan(2.8e-4);
    }
  });

  it('clamps a radius the sides cannot hold, and says so', () => {
    const sp = rect();
    const r = roundCorner(sp, 2, 999) as { radius: number; clamped: boolean };
    expect(r.clamped).toBe(true);
    // The short side is 20, so the cut is 20 and the radius follows from it.
    expect(r.radius).toBeCloseTo(20, 9);

    /* The arc starts exactly where the previous node already is, so that node is
       reused rather than duplicated. Asserting the duplicate here -- `nodes[2]`
       at `[40, 0]` while `nodes[1]` is also `[40, 0]` -- is how a defect gets a
       test written around it. */
    expect(sp.nodes.length).toBe(4);
    expect(sp.nodes[1].pt).toEqual([40, 0]);
    expect(sp.nodes[1].hOut).not.toBeNull();
    expect(sp.nodes[2].pt).toEqual([20, 20]);
  });

  it('never leaves two anchors on the same point', () => {
    /* Two routes to a coincident pair: the clamp, and two fillets meeting in the
       middle of the side they share. A zero-length segment reaches the exported
       path and cannot be simplified away afterwards, because a zero chord leaves
       the fitter with no tangent to work from. */
    for (const radius of [4, 9.5, 10, 10.5, 40, 999]) {
      const sp = rect();
      for (const i of [3, 2, 1, 0]) roundCorner(sp, i, radius);
      for (let i = 0; i < sp.nodes.length; i++) {
        const a = sp.nodes[i].pt;
        const b = sp.nodes[(i + 1) % sp.nodes.length].pt;
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(1e-9);
      }
    }
  });

  it('makes a stadium when the fillets exactly fill the short sides', () => {
    // 40 by 20 at radius 10: each short side is consumed by its two arcs, which
    // meet at its midpoint and share that node.
    const sp = rect();
    for (const i of [3, 2, 1, 0]) roundCorner(sp, i, 10);
    expect(sp.nodes.length).toBe(6);
    const ys = sp.nodes.map((n) => n.pt[1]);
    expect(Math.min(...ys)).toBeCloseTo(0, 9);
    expect(Math.max(...ys)).toBeCloseTo(20, 9);
  });

  it('rounds every corner of a rectangle when applied to each', () => {
    const sp = rect();
    // Descending, because rounding a corner shifts every index after it.
    for (const i of [3, 2, 1, 0]) roundCorner(sp, i, 5);
    expect(sp.nodes.length).toBe(8);
    expect(sp.closed).toBe(true);

    const xs = sp.nodes.map((n) => n.pt[0]);
    const ys = sp.nodes.map((n) => n.pt[1]);
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
    expect(Math.max(...xs)).toBeCloseTo(40, 9);
    expect(Math.min(...ys)).toBeCloseTo(0, 9);
    expect(Math.max(...ys)).toBeCloseTo(20, 9);
  });

  it('refuses what it cannot do, and says which', () => {
    const open = parsePath('M0 0 L40 0 L40 20')[0];
    expect(roundCorner(open, 0, 5)).toBe('end');
    expect(roundCorner(open, 2, 5)).toBe('end');

    const flat = parsePath('M0 0 L20 0 L40 0 L40 20 Z')[0];
    expect(roundCorner(flat, 1, 5)).toBe('straight');

    expect(roundCorner(rect(), 1, 0)).toBe('tiny');
    expect(roundCorner(rect(), 1, -3)).toBe('tiny');
  });

  it('draws the same arc as a quarter circle built from KAPPA', () => {
    /* The independent construction. `roundCorner` derives its handle from
       `arcHandle(r, pi - alpha)`, so checking it against another call of the
       same function would prove only that the function is deterministic. This
       builds the 40 by 20 rectangle at radius 5 out of the circle constant
       directly, node by node, and asks whether the two outlines coincide.

       It used to compare against `rectSubpath(0, 0, 40, 20, 5)`, which was the
       rectangle tool's own radius. That tool no longer rounds anything, so the
       second route had to be written out rather than borrowed. */
    const k = 5 * KAPPA;
    const drawn: Subpath = {
      closed: true,
      nodes: [
        [5, 0], [35, 0], [40, 5], [40, 15], [35, 20], [5, 20], [0, 15], [0, 5],
      ].map((pt) => makeNode(pt as Pt)),
    };
    drawn.nodes[0].hIn = [5 - k, 0];
    drawn.nodes[1].hOut = [35 + k, 0];
    drawn.nodes[2].hIn = [40, 5 - k];
    drawn.nodes[3].hOut = [40, 15 + k];
    drawn.nodes[4].hIn = [35 + k, 20];
    drawn.nodes[5].hOut = [5 - k, 20];
    drawn.nodes[6].hIn = [0, 15 + k];
    drawn.nodes[7].hOut = [0, 5 - k];

    const sp = rect();
    for (const i of [3, 2, 1, 0]) roundCorner(sp, i, 5);

    expect(sp.nodes.length).toBe(drawn.nodes.length);
    for (const p of sample(sp, 24)) {
      const near = sample(drawn, 96).some(
        (q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.02,
      );
      expect(near).toBe(true);
    }
  });
});

/**
 * Reversing a path changes its direction and nothing else.
 *
 * "Nothing else" is the whole claim, and it is not what a `d` string will tell
 * you: reversing rewrites every command, so comparing text proves nothing. The
 * check that means something is to sample the curve itself and find the same
 * points coming back the other way.
 */
describe('reverse', () => {
  /**
   * Points along a subpath, `per` samples per segment, **endpoints included**.
   *
   * Inclusive because that is what makes the comparison exact. Sampling
   * `t = 0 .. (per-1)/per` leaves out the far end of every segment, and the
   * reversed path then samples the far ends and misses the near ones, so the
   * two lists come out as each other's reverse shifted by one and the helper
   * fails on an off-by-one of its own making.
   */
  const walk = (sp: Subpath, per = 16): Pt[] => {
    const out: Pt[] = [];
    for (let seg = 0; seg < segmentCount(sp); seg++) {
      const c = segmentAsCubic(sp, seg);
      for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per));
    }
    return out;
  };

  const near = (a: Pt[], b: Pt[]): void => {
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i][0]).toBeCloseTo(b[i][0], 9);
      expect(a[i][1]).toBeCloseTo(b[i][1], 9);
    }
  };

  it('draws the identical open curve, backwards', () => {
    const sp = parsePath('M 0 0 C 4 10 16 10 20 0 L 30 6')[0];
    const before = walk(sp);
    reverseSubpath(sp);
    near(walk(sp), [...before].reverse());
  });

  it('draws the identical closed curve, backwards, from the same start node', () => {
    /* Asymmetric on purpose. A shape that is its own mirror would let a reverse
       that lost the handles pass: every wrong answer would still land on the
       same points. */
    const sp = parsePath('M 0 0 C 2 8 14 12 20 4 L 24 -6 C 12 -10 4 -8 0 0 Z')[0];
    const before = walk(sp);
    const start = [...sp.nodes[0].pt] as Pt;
    reverseSubpath(sp);

    expect(sp.nodes[0].pt, 'a ring should keep its start node').toEqual(start);
    /* A ring reversed and re-rooted traverses the same points backwards, and
       where in the loop the traversal begins is not part of the claim -- so
       this looks for a rotation rather than asserting one. Finding none is the
       failure. */
    const flipped = [...walk(sp)].reverse();
    const n = before.length;
    const rotations = [];
    for (let r = 0; r < n; r++) {
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        const a = before[i];
        const b = flipped[(i + r) % n];
        ok = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9;
      }
      if (ok) rotations.push(r);
    }
    expect(rotations.length, 'the reversed ring is not the same ring backwards').toBeGreaterThan(0);
  });

  it('is its own inverse', () => {
    const sp = parsePath('M 0 0 C 4 10 16 10 20 0 L 30 6')[0];
    const before = serialisePath([sp], { decimals: 9 });
    reverseSubpath(sp);
    expect(serialisePath([sp], { decimals: 9 })).not.toBe(before);
    reverseSubpath(sp);
    expect(serialisePath([sp], { decimals: 9 })).toBe(before);
  });

  it('swaps each node\'s handles rather than keeping them where they were', () => {
    // The one-line summary of what reversing a node means, pinned directly:
    // `hOut` governs the segment leaving a node and `hIn` the one arriving.
    const sp = parsePath('M 0 0 C 3 7 11 13 20 0')[0];
    const firstOut = sp.nodes[0].hOut;
    const lastIn = sp.nodes[1].hIn;
    reverseSubpath(sp);
    expect(sp.nodes[0].hOut).toEqual(lastIn);
    expect(sp.nodes[1].hIn).toEqual(firstOut);
  });

  it('leaves a one-node subpath alone', () => {
    const sp: Subpath = { nodes: [makeNode([3, 4])], closed: false };
    reverseSubpath(sp);
    expect(sp.nodes.length).toBe(1);
    expect(sp.nodes[0].pt).toEqual([3, 4]);
  });
});

/**
 * Reshaping a segment by dragging a point on it.
 *
 * The defining property is geometric, so it is measured geometrically: after
 * the call, the curve passes through the target at the parameter that was
 * dragged. Comparing handle coordinates against numbers computed by hand would
 * pass for whatever the code happens to do.
 */
describe('reshapeSegment', () => {
  /** An asymmetric curve: unequal handles, pointing different ways. */
  const skewed = (): Subpath => parsePath('M0 0 C 5 12 25 -4 30 0')[0];

  it('puts the curve through the target at the parameter dragged', () => {
    for (const t of [0.15, 0.35, 0.5, 0.72, 0.9]) {
      const sp = skewed();
      const target: Pt = [12, 18];
      reshapeSegment(sp, 0, t, target);
      const at = cubicAt(segmentAsCubic(sp, 0), t);
      expect(at[0]).toBeCloseTo(target[0], 9);
      expect(at[1]).toBeCloseTo(target[1], 9);
    }
  });

  it('leaves both endpoints exactly where they were', () => {
    const sp = skewed();
    const a: Pt = [...sp.nodes[0].pt];
    const b: Pt = [...sp.nodes[1].pt];
    reshapeSegment(sp, 0, 0.5, [12, 18]);
    expect(sp.nodes[0].pt).toEqual(a);
    expect(sp.nodes[1].pt).toEqual(b);
  });

  it('moves the handles the least the displacement allows', () => {
    /* The least-norm solution splits the work in the ratio b1 : b2, so at
       t = 0.25 the near control does three times the work of the far one.
       Any other split would also put the curve through the point, which is
       why this is asserted separately from the property above. */
    const sp = skewed();
    const before = segmentAsCubic(sp, 0);
    const t = 0.25;
    reshapeSegment(sp, 0, t, [10, 20]);
    const after = segmentAsCubic(sp, 0);

    const d1 = Math.hypot(after[1][0] - before[1][0], after[1][1] - before[1][1]);
    const d2 = Math.hypot(after[2][0] - before[2][0], after[2][1] - before[2][1]);
    const u = 1 - t;
    expect(d1 / d2).toBeCloseTo((3 * u * u * t) / (3 * u * t * t), 9);
  });

  it('turns a straight segment into a curve through the point', () => {
    const sp = parsePath('M0 0 L30 0')[0];
    expect(sp.nodes[0].hOut).toBeNull();
    reshapeSegment(sp, 0, 0.5, [15, 10]);
    const at = cubicAt(segmentAsCubic(sp, 0), 0.5);
    expect(at[0]).toBeCloseTo(15, 9);
    expect(at[1]).toBeCloseTo(10, 9);
  });

  it('clamps a parameter at the ends rather than dividing by zero', () => {
    /* No handle can move the point at t = 0: it is the endpoint. The honest
       answer is to act on the nearest parameter that can be moved, not to
       emit Infinity into the document. */
    for (const t of [0, 1, -3, 4]) {
      const sp = skewed();
      reshapeSegment(sp, 0, t, [12, 18]);
      for (const n of sp.nodes) {
        for (const h of [n.hIn, n.hOut]) {
          if (h) expect(Number.isFinite(h[0]) && Number.isFinite(h[1])).toBe(true);
        }
      }
    }
  });

  it('keeps a smooth join smooth on the far side of the node', () => {
    // Two segments meeting smoothly at node 1. Reshaping the first must carry
    // the neighbour round, which is what going through `moveHandle` buys.
    const sp = parsePath('M0 0 C 10 -10 20 -10 30 0 C 40 10 50 10 60 0')[0];
    expect(continuityOf(sp.nodes[1])).not.toBe('cusp');
    reshapeSegment(sp, 0, 0.5, [15, -18]);
    expect(continuityOf(sp.nodes[1])).not.toBe('cusp');
  });
});

/**
 * Aligning and distributing anchors, and the boolean the caller acts on.
 *
 * Both report whether anything moved, so `Commands` can run them under
 * `tryEdit`: three presses of Align top are one arrangement and one entry in
 * the history. Nothing in the suite mentioned either name -- the shape-level
 * commands were tested and the node-level pair shipped on the argument that
 * they were the same shape of change.
 *
 * The return value is the point, and the positions are checked beside it: a
 * function that moved nothing and said `false`, and one that moved everything
 * and said `false`, are the same reading otherwise.
 */
describe('aligning and distributing anchors', () => {
  /** A document of one shape, and refs to all of its nodes in order. */
  const fixture = (d: string): { doc: Doc; refs: NodeRef[] } => {
    const doc = emptyDoc();
    doc.shapes.push(shapeFromPath(d));
    const sh = doc.shapes[0];
    return { doc, refs: sh.subpaths[0].nodes.map((_, i) => ({ shape: sh.id, sp: 0, i })) };
  };
  const ys = (doc: Doc): number[] => doc.shapes[0].subpaths[0].nodes.map((n) => n.pt[1]);
  const xs = (doc: Doc): number[] => doc.shapes[0].subpaths[0].nodes.map((n) => n.pt[0]);

  it('takes every anchor to the top of their common box, and says it moved', () => {
    const { doc, refs } = fixture('M0 4 L10 9 L20 1');
    expect(alignNodes(doc, refs, 'top')).toBe(true);
    expect(ys(doc)).toEqual([1, 1, 1]);
  });

  it('says nothing moved when they are already there, so a second press files nothing', () => {
    const { doc, refs } = fixture('M0 4 L10 9 L20 1');
    alignNodes(doc, refs, 'top');
    expect(alignNodes(doc, refs, 'top')).toBe(false);
    expect(ys(doc)).toEqual([1, 1, 1]);
  });


  it('spaces the middle anchors evenly and leaves the two extremes where they are', () => {
    const { doc, refs } = fixture('M0 0 L3 0 L20 0');
    expect(distributeNodes(doc, refs, 'h')).toBe(true);
    expect(xs(doc)).toEqual([0, 10, 20]);
  });

  it('says nothing moved when the spacing is already even', () => {
    const { doc, refs } = fixture('M0 0 L10 0 L20 0');
    expect(distributeNodes(doc, refs, 'h')).toBe(false);
    expect(xs(doc)).toEqual([0, 10, 20]);
  });


  /* Every mode, not just one. `top` alone leaves `horizontal` false whatever
     the disjunction says, so `left || right || hcenter` narrowed to `&&` made
     every mode vertical and nothing disagreed. And the two centring modes are
     the only place a midpoint is computed, so `(min + max) / 2` could be a
     difference. Found by `tools/mutate.mjs`. */
  it.each([
    ['left', 'x', [0, 0, 0]],
    ['right', 'x', [20, 20, 20]],
    ['hcenter', 'x', [10, 10, 10]],
    ['top', 'y', [1, 1, 1]],
    ['bottom', 'y', [9, 9, 9]],
    ['vcenter', 'y', [5, 5, 5]],
  ])('aligns %s', (mode, axis, want) => {
    const { doc, refs } = fixture('M0 4 L10 9 L20 1');
    expect(alignNodes(doc, refs, mode as AlignMode)).toBe(true);
    expect(axis === 'x' ? xs(doc) : ys(doc)).toEqual(want);
  });

  /* Two is the smallest number of anchors with something to align to, and the
     bound was only ever exercised from above: widened to `<= 2` a pair is
     refused, and every fixture here had three. */
  it('aligns exactly two anchors, which is the smallest that has a common box', () => {
    const { doc, refs } = fixture('M0 4 L10 9');
    expect(alignNodes(doc, refs, 'top')).toBe(true);
    expect(ys(doc)).toEqual([4, 4]);
  });

  /* One anchor, and the answer is the boolean rather than the geometry. This
     test was written, judged unfalsifiable and deleted earlier the same day, on
     the argument that removing the guard leaves the function returning false
     anyway. That is true of removing the guard and false of the mutation the
     tester actually makes, which is to the returned value: `return true` here
     reports a move that did not happen, and `tryEdit` files an entry for it. */
  it('declines one anchor, and says so rather than filing an edit', () => {
    const { doc, refs } = fixture('M0 4 L10 9 L20 1');
    expect(alignNodes(doc, refs.slice(0, 1), 'top')).toBe(false);
    expect(ys(doc)).toEqual([4, 9, 1]);
  });

  it('declines two anchors to distribute, for the same reason', () => {
    const { doc, refs } = fixture('M0 0 L3 0 L20 0');
    expect(distributeNodes(doc, refs.slice(0, 2), 'h')).toBe(false);
    expect(xs(doc)).toEqual([0, 3, 20]);
  });

  /* Anchors arriving in an order that is not their order along the axis, which
     is what the sort is for. Every fixture handed them over already sorted, so
     the comparator could have added the two coordinates instead of subtracting
     them. */
  it('spaces anchors that arrive out of order along the axis', () => {
    const { doc, refs } = fixture('M20 0 L0 0 L3 0');
    expect(distributeNodes(doc, refs, 'h')).toBe(true);
    // Sorted they are 0, 3, 20; the middle one belongs at 10. Read back in
    // node order, which is the order the path declares them.
    expect(xs(doc)).toEqual([20, 0, 10]);
  });

  /* The refs these two are handed come from `selectedNodes`, which is where a
     shape's own nodes and a separate node selection are put together. A node
     that is in both arrives twice unless something says otherwise, and nothing
     in the suite mentioned this function either: `return false` in its dedupe
     inverted to `return true` and the whole suite stayed green. */
  it('is handed each node once when a shape and one of its own nodes are both selected', () => {
    const { doc } = fixture('M0 4 L10 9 L20 1');
    const sh = doc.shapes[0];
    const sel = emptySelection();
    sel.shapes.add(sh.id);
    sel.nodes.add(sh.subpaths[0].nodes[1].id);
    expect(selectedNodes(doc, sel)).toHaveLength(3);
  });
});


describe('sliding a node along the path it is already on', () => {
  const CURVE = 'M20 60 C 40 10 90 10 110 60';
  const LINE = 'M20 20 L120 90';

  /** The path with a node inserted at `t`, and the shape it had before. */
  const withNode = (d: string, t: number): { sp: Subpath; was: Pt[] } => {
    const sp = parsePath(d)[0];
    const was = sample(sp, 96);
    splitSegment(sp, 0, t);
    return { sp, was };
  };

  /* The case the operation exists for. A node put there by double-clicking is
     a de Casteljau split, so its two segments are one cubic and re-cutting
     that cubic anywhere else leaves the drawing alone. */
  it.each([
    [0.5, 0.2], [0.5, 0.8], [0.3, 0.7], [0.25, 0.26], [0.5, 0.05], [0.1, 0.9],
  ])('moves an inserted node from %f to %f without moving the path', (from, to) => {
    const { sp, was } = withNode(CURVE, from);
    const slide = slidingParent(sp, 1);
    expect(slide).not.toBeNull();
    expect(slide!.stray).toBeLessThan(1e-9);
    expect(slide!.t).toBeCloseTo(from, 6);

    expect(slideNodeTo(sp, 1, slide!.parent, to)).toBe(true);
    expect(deviation(was, sp)).toBeLessThan(1e-9);
    expect(deviation(sample(sp, 96), parsePath(CURVE)[0])).toBeLessThan(1e-9);
    // And it went where it was sent, not merely somewhere on the curve.
    const want = cubicAt(slide!.parent, to);
    expect(sp.nodes[1].pt[0]).toBeCloseTo(want[0], 9);
    expect(sp.nodes[1].pt[1]).toBeCloseTo(want[1], 9);
  });

  /* Two straight segments have a straight parent, so splitting it puts handles
     on the thirds: the same drawing, exported as two `C` commands where it had
     two `L`. The node also stops reading as a corner. */
  it('leaves a straight run straight, and still exporting as lines', () => {
    const { sp } = withNode(LINE, 0.3);
    const slide = slidingParent(sp, 1)!;
    expect(slideNodeTo(sp, 1, slide.parent, 0.75)).toBe(true);
    expect(sp.nodes[1].pt[0]).toBeCloseTo(95, 9);
    expect(sp.nodes[1].pt[1]).toBeCloseTo(72.5, 9);
    expect(sp.nodes[1].hIn).toBeNull();
    expect(sp.nodes[1].hOut).toBeNull();
    expect(sp.nodes[0].hOut).toBeNull();
    expect(sp.nodes[2].hIn).toBeNull();
    expect(serialisePath([sp])).toBe('M 20 20 L 95 72.5 L 120 90');
  });

  /* The property a drag depends on: after a slide the pair is still one cubic,
     so the next slide is exact too. It is not a privilege spent on first use. */
  it('stays exact over four slides in a row', () => {
    const { sp, was } = withNode(CURVE, 0.4);
    for (const to of [0.7, 0.15, 0.85, 0.5]) {
      const slide = slidingParent(sp, 1)!;
      expect(slide.stray).toBeLessThan(1e-9);
      expect(slideNodeTo(sp, 1, slide.parent, to)).toBe(true);
    }
    expect(deviation(was, sp)).toBeLessThan(1e-9);
  });

  it('reports a real cost for a node whose segments are not one cubic', () => {
    const sp = parsePath('M0 0 L40 0 L40 40')[0];
    const slide = slidingParent(sp, 1);
    expect(slide).not.toBeNull();
    expect(slide!.stray).toBeGreaterThan(1);
  });

  it('has nothing to slide along at the end of an open path', () => {
    const sp = parsePath(CURVE)[0];
    splitSegment(sp, 0, 0.5);
    expect(slidingParent(sp, 0)).toBeNull();
    expect(slidingParent(sp, sp.nodes.length - 1)).toBeNull();
  });

  /* The ends are where the neighbours are, and a node on top of a neighbour is
     a zero-length segment nothing can simplify again. §23. */
  it('refuses to put a node at either end of its parent', () => {
    const { sp } = withNode(CURVE, 0.5);
    const slide = slidingParent(sp, 1)!;
    expect(slideNodeTo(sp, 1, slide.parent, 0)).toBe(false);
    expect(slideNodeTo(sp, 1, slide.parent, 1)).toBe(false);
    // The neighbours are the parent's own ends, so there is nothing else to
    // clamp against: 0 and 1 are exactly where they sit.
    expect(slide.parent[0]).toEqual(sp.nodes[0].pt);
    expect(slide.parent[3]).toEqual(sp.nodes[2].pt);
  });

  /* Why a drag reads the parent once at the press.
     Not drift: the first slide turns the pair into a split of the parent, so
     re-reading it on the next frame recovers the same curve and the geometry is
     stable either way. What re-reading loses is the ability to say what the
     gesture has cost. `stray` is measured against the pair as it was found, and
     one frame in, the pair is a perfect split -- so a drag that re-read it
     would report that the path had not moved, having already moved it by the
     figure it reported at the press. */
  it('reports a cost that survives the first frame, which re-reading would not', () => {
    const d = 'M0 0 C 10 -30 30 -30 40 0 C 48 18 70 24 90 20';
    const sp = parsePath(d)[0];
    const atPress = slidingParent(sp, 1)!;
    expect(atPress.stray).toBeGreaterThan(1);

    const was = sample(sp, 96);
    slideNodeTo(sp, 1, atPress.parent, 0.6);
    // The path really did move, by about what was promised.
    const moved = deviation(was, sp);
    expect(moved).toBeGreaterThan(0.5);
    expect(moved).toBeLessThanOrEqual(atPress.stray);
    // And a second reading now calls it free, which is why the drag holds the
    // first one rather than asking again.
    expect(slidingParent(sp, 1)!.stray).toBeLessThan(1e-9);
  });
});
