/**
 * Guides: straight lines you place, and then aim at.
 *
 * The grid is a lattice you are given and keylines are a set of proportions you
 * are given. A guide is neither: it is one line, at a position someone chose,
 * for a reason only they know. That difference is the whole design.
 *
 * **A guide is axis-aligned and infinite.** Not a segment with ends, because an
 * end is a decision nobody asked to make and a thing to have to line up later;
 * and not an angled line, because a ruler cannot produce one and an angled guide
 * wants a whole placement interface of its own. `axis` names the coordinate the
 * guide holds fixed, which is the reading that stays true when you say it out
 * loud: an `x` guide fixes x, and so it is drawn as a vertical line.
 *
 * **It is stored, and therefore undoable.** This is where guides part company
 * with keylines: a keyline is a function of the page, so it is derived every
 * frame and there is nothing to undo. A guide is a decision. Storing it means
 * `Ctrl+Z` has to take it back, which is what puts guides in the history
 * alongside the backdrop rather than in the view switches alongside the grid.
 * They stay out of `Doc` for the two reasons the backdrop does: the export is
 * built from the model, so a guide the model does not carry cannot leak into a
 * file, and Apply in the source box replaces the document wholesale, which would
 * throw them away as a side effect of editing the path text.
 */

import type { Pt } from '../core/types';

/** The coordinate a guide holds fixed. `x` is a vertical line. */
export type GuideAxis = 'x' | 'y';

export interface Guide {
  axis: GuideAxis;
  at: number;
}

/**
 * How close two guides on the same axis have to be to count as the same one.
 *
 * In document units, which is right here rather than in pixels: this is asking
 * whether the drawing carries two guides, not whether you can see a gap. Two
 * lines a millionth apart are one line badly stored, and dragging a guide onto
 * another one is how you get them.
 */
const SAME = 1e-9;

/**
 * Add a guide, or report that there is already one there.
 *
 * Returns `false` without touching the list when the position is taken, so a
 * caller using `tryEdit` records no undo step for a drop that changed nothing.
 * A non-finite position is refused for the same reason: it is reachable by
 * typing, and a guide at `NaN` is a line that draws nowhere and snaps to
 * everything.
 */
export function addGuide(list: Guide[], g: Guide): boolean {
  if (!Number.isFinite(g.at)) return false;
  if (list.some((o) => o.axis === g.axis && Math.abs(o.at - g.at) <= SAME)) return false;
  list.push({ axis: g.axis, at: g.at });
  return true;
}

/** Move the guide at `i`, or report that nothing changed. */
export function moveGuide(list: Guide[], i: number, at: number): boolean {
  const g = list[i];
  if (!g || !Number.isFinite(at) || at === g.at) return false;
  g.at = at;
  return true;
}

/**
 * Once a drag is over, drop the guide at `i` if it landed on another one.
 *
 * Deliberately not part of `moveGuide`. Removing it mid-drag would splice the
 * list under the gesture that is holding an index into it, so the drag would
 * carry on moving whichever guide inherited the index -- and passing over
 * another guide is a thing a drag does on its way somewhere else, not a
 * decision. Two in one place is allowed while the pointer is down and settled
 * on release, which is the only moment the answer is known.
 */
export function settleGuide(list: Guide[], i: number): boolean {
  const g = list[i];
  if (!g) return false;
  if (!list.some((o, j) => j !== i && o.axis === g.axis && Math.abs(o.at - g.at) <= SAME)) {
    return false;
  }
  list.splice(i, 1);
  return true;
}

export function removeGuide(list: Guide[], i: number): boolean {
  if (!list[i]) return false;
  list.splice(i, 1);
  return true;
}

/** The nearest guide line within `reach`, and where on it the pointer projects. */
export function nearestGuideLine(
  list: Guide[],
  p: Pt,
  reach: number,
): { pt: Pt; d: number; i: number } | null {
  let best = reach;
  let hit: { pt: Pt; d: number; i: number } | null = null;
  list.forEach((g, i) => {
    const d = Math.abs((g.axis === 'x' ? p[0] : p[1]) - g.at);
    if (d < best) {
      best = d;
      hit = { pt: g.axis === 'x' ? [g.at, p[1]] : [p[0], g.at], d, i };
    }
  });
  return hit;
}

/**
 * The nearest crossing of two guides within `reach`.
 *
 * Two guides that cross make a point, and a point is 0-D, so this belongs in
 * the vertex tier rather than the line tier -- that is `resolveSnap`'s rule
 * applied rather than an exception carved out for guides. It is also the thing
 * guides are most useful for: a pair of them is how you place a node exactly
 * twice, in two different drawings.
 *
 * Quadratic in the number of guides, which is fine for the number of guides
 * anyone places and would not be for a lattice. That asymmetry is why the grid
 * is not implemented this way.
 */
export function nearestGuideCross(list: Guide[], p: Pt, reach: number): { pt: Pt; d: number } | null {
  let best = reach;
  let hit: { pt: Pt; d: number } | null = null;
  for (const a of list) {
    if (a.axis !== 'x') continue;
    const dx = a.at - p[0];
    if (Math.abs(dx) >= best) continue;
    for (const b of list) {
      if (b.axis !== 'y') continue;
      const d = Math.hypot(dx, b.at - p[1]);
      if (d < best) {
        best = d;
        hit = { pt: [a.at, b.at], d };
      }
    }
  }
  return hit;
}
