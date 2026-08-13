/**
 * Smart guides: which alignment a drag has found.
 *
 * The arithmetic is small; what is worth testing is which of the nine
 * candidates per axis wins, that the two axes are decided independently, and
 * that the drawn line reaches both boxes. Each of those is a decision, and each
 * of them can be got wrong in a way that still produces a plausible line.
 */

import { describe, expect, it } from 'vitest';
import { alignmentsFor, shiftBox } from '../src/model/smart';
import type { Box } from '../src/core/bezier';

const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 });

/** A 10 by 10 static square at the origin, for the edges 0 and 10, centre 5. */
const STATIC = box(0, 0, 10, 10);

describe('finding an alignment', () => {
  it('lines a left edge up with a left edge', () => {
    const a = alignmentsFor(box(0.4, 40, 10.4, 50), [STATIC], 1);
    expect(a.x).not.toBeNull();
    expect(a.x!.shift).toBeCloseTo(-0.4, 10);
    expect(a.x!.at).toBe(0);
    expect(a.x!.kind).toBe('edge');
  });

  it('lines a left edge up with a right edge, which is the other useful one', () => {
    // Butting one shape against another: the moving box's left meets the
    // static box's right. A version comparing only like with like misses it.
    const a = alignmentsFor(box(10.3, 40, 20.3, 50), [STATIC], 1);
    expect(a.x!.shift).toBeCloseTo(-0.3, 10);
    expect(a.x!.at).toBe(10);
  });

  it('finds a centre against a centre', () => {
    // Moving box 4 wide, centred at 5.2: its centre wants the static centre 5.
    const a = alignmentsFor(box(3.2, 40, 7.2, 50), [STATIC], 1);
    expect(a.x!.shift).toBeCloseTo(-0.2, 10);
    expect(a.x!.kind).toBe('centre');
  });

  it('takes the nearest candidate, not the first one it finds', () => {
    /* Left edge 0.9 away, right edge 0.7 away, centre 0.1 away. Iteration puts
       edges first, so a version that stopped at the first match within reach
       would take one nine times worse. */
    const a = alignmentsFor(box(0.9, 40, 9.3, 50), [STATIC], 1);
    expect(a.x!.kind).toBe('centre');
    expect(Math.abs(a.x!.shift)).toBeCloseTo(0.1, 10);
  });

  it('settles a tie the same way every time', () => {
    /* Left edge to left edge is 0.2 away and right edge to right edge is the
       same 0.2 -- except that in binary it is 0.19999999999999929, so a strict
       comparison handed the line to the right edge and the answer depended on
       which decimals were exact. */
    const a = alignmentsFor(box(0.2, 40, 10.2, 50), [STATIC], 1);
    expect(a.x!.at).toBe(0);
  });

  it('decides the two axes independently', () => {
    /* One shape to line up with on x and a different one on y. Returning a
       single best match would silently drop one of them, and the drag would
       hold to one alignment while visibly sitting on another. */
    const other = box(100, 20, 120, 30);
    const a = alignmentsFor(box(0.2, 20.3, 10.2, 30.3), [STATIC, other], 1);
    expect(a.x!.at).toBe(0);
    expect(a.y!.at).toBe(20);
  });

  it('reports nothing on an axis with nothing in reach', () => {
    const a = alignmentsFor(box(40, 0.2, 50, 10.2), [STATIC], 1);
    expect(a.x).toBeNull();
    expect(a.y).not.toBeNull();
  });

  it('reports nothing at all when reach is zero', () => {
    // Reachable: the reach is screen pixels times the scale, and a degenerate
    // camera makes it zero. An exact match must not sneak through on `<= 0`.
    const a = alignmentsFor(STATIC, [STATIC], 0);
    expect(a).toEqual({ x: null, y: null });
  });
});

describe('the line that gets drawn', () => {
  it('spans both boxes, so it says what lined up with what', () => {
    /* A line covering only the moving box would leave you guessing which of
       four shapes it had agreed with. */
    const a = alignmentsFor(box(0.2, 40, 10.2, 60), [STATIC], 1);
    expect(a.x!.from).toBe(0);
    expect(a.x!.to).toBe(60);
  });

  it('spans the same when the static box is the further one', () => {
    const far = box(0, 90, 10, 100);
    const a = alignmentsFor(box(0.2, 10, 10.2, 20), [far], 1);
    expect(a.x!.from).toBe(10);
    expect(a.x!.to).toBe(100);
  });
});

describe('applying it', () => {
  it('moves a box by the shift it was given', () => {
    expect(shiftBox(box(1, 2, 3, 4), 10, 20)).toEqual(box(11, 22, 13, 24));
  });
});
