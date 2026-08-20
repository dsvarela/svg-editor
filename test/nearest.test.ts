/**
 * The bounding-box reject inside `nearestOnPath` must never change the answer.
 *
 * It exists for speed: a cubic lies inside the box of its four control points,
 * so a segment whose box is further away than the best distance so far cannot
 * win, and skipping it saves 44 evaluations. That is the whole contract, and it
 * is a contract about two functions agreeing rather than about any one input:
 * the fast answer must equal the answer you get by projecting onto every
 * segment and taking the smallest.
 *
 * Stated that way it is checkable by sweeping points, which is what this does.
 * A hand-written fixture puts the pointer near a segment or far from every
 * segment, and the reject only shows itself in the band between: outside a
 * segment's box, but within reach of it. A sweep crosses that band whatever the
 * shapes are. Of six mutations tried on the reject and on the bound it reads,
 * four turn this file red and two cannot: `>` to `>=` on a boundary a point
 * could not win from, and `||` to `&&`, which only makes the reject reject
 * less. `docs/reviews/2026-08-19d.md` has both.
 */

import { describe, expect, it } from 'vitest';
import { projectToCubic } from '../src/core/bezier';
import { segmentAsCubic, segmentCount } from '../src/core/types';
import type { Doc, Pt } from '../src/core/types';
import {
  nearestOnPath,
} from '../src/model/ops';
import type {
  PathHit,
} from '../src/model/ops';
import { emptyDoc, shapeFromPath } from '../src/model/doc';

/**
 * The definition, with no rejection: project onto every segment, keep the best.
 *
 * Deliberately not a second copy of the optimised loop. It reads every segment
 * unconditionally, so the two can only agree when the reject is discarding
 * segments that were going to lose anyway.
 */
function exhaustive(
  doc: Doc,
  p: Pt,
  maxDist: number,
  allow?: (shape: string, sp: number, seg: number) => boolean,
): PathHit | null {
  let best: PathHit | null = null;
  for (const shape of doc.shapes) {
    shape.subpaths.forEach((sp, spI) => {
      for (let seg = 0; seg < segmentCount(sp); seg++) {
        if (allow && !allow(shape.id, spI, seg)) continue;
        const pr = projectToCubic(segmentAsCubic(sp, seg), p);
        if (pr.d < (best?.d ?? maxDist)) {
          best = { shape: shape.id, sp: spI, seg, t: pr.t, d: pr.d, pt: pr.pt };
        }
      }
    });
  }
  return best;
}

/**
 * Shapes with boxes that overlap, nest and stand apart, none at the origin.
 *
 * Overlap matters: a segment can only be wrongly rejected while some other
 * segment has already set a smaller `reach`, so the sweep needs regions where
 * more than one segment is a candidate.
 */
function scene(): Doc {
  const doc = emptyDoc();
  doc.shapes.push(shapeFromPath('M20 20 C20 60 80 60 80 20 C80 -10 130 -10 130 25'));
  doc.shapes.push(shapeFromPath('M45 5 L110 5 L110 70 L45 70 Z'));
  doc.shapes.push(shapeFromPath('M150 40 L160 45 L152 58 Z'));
  doc.shapes.push(shapeFromPath('M-30 -20 C-30 10 10 10 10 -20 Z'));
  return doc;
}

/** A grid over the scene and well beyond it, on deliberately unround steps. */
function sweep(): Pt[] {
  const out: Pt[] = [];
  for (let x = -55; x <= 185; x += 7.3) for (let y = -45; y <= 95; y += 6.7) out.push([x, y]);
  return out;
}

const describeHit = (h: PathHit | null): string =>
  h ? `${h.shape}/${h.sp}/${h.seg} d=${h.d.toFixed(9)}` : 'none';

describe('the reject changes nothing', () => {
  const doc = scene();
  const points = sweep();

  it.each([2, 9, 40, 1e9])('agrees with projecting every segment, maxDist %i', (maxDist) => {
    let checked = 0;
    for (const p of points) {
      const fast = nearestOnPath(doc, p, maxDist);
      const slow = exhaustive(doc, p, maxDist);
      // `describeHit` rather than the objects, so a failure names the point and
      // the segment instead of printing two hit records.
      expect(`${p} -> ${describeHit(fast)}`).toBe(`${p} -> ${describeHit(slow)}`);
      if (fast) checked++;
    }
    /* A sweep that found nothing would agree with an exhaustive search that
       also found nothing, and prove none of this. */
    expect(checked).toBeGreaterThan(points.length / 20);
  });

  it('agrees when a filter has already taken the nearest segments away', () => {
    // What snapping does: a node being dragged sits on its own two segments, so
    // they are excluded and the winner comes from further off. That is the case
    // where `reach` stays large across many segments.
    const allow = (shape: string, _sp: number, seg: number): boolean =>
      !(shape === doc.shapes[1].id && seg < 2);
    let found = 0;
    for (const p of points) {
      const fast = nearestOnPath(doc, p, 25, allow);
      expect(describeHit(fast)).toBe(describeHit(exhaustive(doc, p, 25, allow)));
      if (fast) found++;
    }
    expect(found).toBeGreaterThan(0);
  });

  it('finds a segment whose box the point sits outside of', () => {
    /* The band the reject exists for, named directly: a point beyond the end of
       a horizontal segment, so outside its box on x, but nearer to it than
       `maxDist`. Without the margin the box test would drop it. */
    const one = emptyDoc();
    one.shapes.push(shapeFromPath('M40 40 L80 40'));
    const hit = nearestOnPath(one, [86, 41], 10);
    expect(hit).not.toBeNull();
    expect(hit?.d).toBeCloseTo(Math.hypot(6, 1), 6);
    // And past the margin it is gone, which is what `maxDist` means.
    expect(nearestOnPath(one, [95, 41], 10)).toBeNull();
  });

  it('reports nothing rather than the nearest thing beyond maxDist', () => {
    for (const p of [[-400, -400], [900, 900], [400, 30]] as Pt[]) {
      expect(nearestOnPath(doc, p, 12)).toBeNull();
    }
  });
});
