/**
 * Auto-smooth nodes: handles that re-derive themselves from the neighbours.
 *
 * **The model's only stored node state, against §6.** The exception is that
 * `auto` is an instruction about the future rather than a claim about the
 * geometry, so no arrangement of control points can express it and nothing can
 * disagree with it. Never exported; a file has no way to say it. §35.
 */

import type { Doc, Pt, Subpath } from '../core/types';

/**
 * How much of the way to each neighbour a handle reaches.
 *
 * A third is the value that makes three evenly spaced nodes reproduce a
 * circular arc almost exactly, and it is what a Catmull-Rom spline converted to
 * Beziers uses. Shorter looks slack; longer overshoots and puts a bulge between
 * every pair of nodes.
 */
const REACH = 1 / 3;

/** The neighbours of node `i`, wrapping on a closed path. `null` where there is none. */
function around(sp: Subpath, i: number): { before: Pt | null; after: Pt | null } {
  const n = sp.nodes.length;
  if (sp.closed) {
    return { before: sp.nodes[(i - 1 + n) % n].pt, after: sp.nodes[(i + 1) % n].pt };
  }
  return { before: i > 0 ? sp.nodes[i - 1].pt : null, after: i < n - 1 ? sp.nodes[i + 1].pt : null };
}

/**
 * Whether a node can be auto at all.
 *
 * It needs a neighbour on each side to average, so the two ends of an open path
 * cannot be: there is nothing on the outside to aim away from, and inventing a
 * direction from one side would be a guess rather than a derivation. The same
 * reason `setContinuity` declines to smooth them.
 */
export function canBeAuto(sp: Subpath, i: number): boolean {
  if (sp.nodes.length < 3) return false;
  const { before, after } = around(sp, i);
  return before !== null && after !== null;
}

/**
 * The handle pair a node's neighbours imply, or null if it has no two.
 *
 * Direction comes from the chord between the neighbours, which is what makes
 * the node smooth by construction: both handles lie on one line through the
 * anchor. Length is a third of the distance to each neighbour *separately*, so
 * an evenly spaced run gets an even curve and an uneven one does not get a
 * bulge on its short side.
 */
export function autoHandles(sp: Subpath, i: number): { hIn: Pt; hOut: Pt } | null {
  if (!canBeAuto(sp, i)) return null;
  const { before, after } = around(sp, i);
  const p = sp.nodes[i].pt;
  const dx = after![0] - before![0];
  const dy = after![1] - before![1];
  const len = Math.hypot(dx, dy);

  /* Neighbours in the same place leave no direction to take. Falling back to
     no handles keeps the node valid rather than dividing by zero, and the
     straight segments it produces are the honest reading of the input. */
  if (len < 1e-12) return null;

  const ux = dx / len;
  const uy = dy / len;
  const back = Math.hypot(p[0] - before![0], p[1] - before![1]) * REACH;
  const fwd = Math.hypot(after![0] - p[0], after![1] - p[1]) * REACH;
  return {
    hIn: [p[0] - ux * back, p[1] - uy * back],
    hOut: [p[0] + ux * fwd, p[1] + uy * fwd],
  };
}

/**
 * Recompute every auto node in the subpath.
 *
 * A whole-subpath sweep rather than a targeted update of the node that moved
 * and its two neighbours. Every operation that could invalidate an auto node --
 * moving one, deleting one, inserting one, reversing the path, baking a
 * transform, applying a boolean -- would otherwise need to work out which
 * indices it disturbed, and getting that wrong leaves a stale handle that looks
 * like a rendering bug. The sweep is one pass over nodes that are already being
 * walked to redraw.
 *
 * Returns whether anything moved, so a caller can decline to record an edit.
 */
export function reflowAuto(sp: Subpath): boolean {
  let changed = false;
  sp.nodes.forEach((n, i) => {
    if (!n.auto) return;
    const h = autoHandles(sp, i);
    if (!h) {
      /* It stopped being able to be auto: a node was deleted either side of it,
         or the path was opened. The flag goes with the ability, so it does not
         sit there dormant waiting to fire when a neighbour reappears. */
      if (n.hIn || n.hOut) changed = true;
      n.hIn = null;
      n.hOut = null;
      delete n.auto;
      return;
    }
    if (!same(n.hIn, h.hIn) || !same(n.hOut, h.hOut)) changed = true;
    n.hIn = h.hIn;
    n.hOut = h.hOut;
  });
  return changed;
}

const same = (a: Pt | null, b: Pt): boolean => !!a && a[0] === b[0] && a[1] === b[1];

/**
 * Turn auto on or off for one node.
 *
 * Turning it off keeps the handles where they are. That is the whole point of
 * the switch being separate from the geometry: what you had is what you get to
 * carry on editing, and the only thing that changed is that it stops moving on
 * its own.
 */
export function setAuto(sp: Subpath, i: number, on: boolean): boolean {
  const n = sp.nodes[i];
  if (!n) return false;
  if (!on) {
    if (!n.auto) return false;
    delete n.auto;
    return true;
  }
  if (!canBeAuto(sp, i)) return false;
  const h = autoHandles(sp, i);
  if (!h) return false;
  const was = n.auto === true && same(n.hIn, h.hIn) && same(n.hOut, h.hOut);
  n.auto = true;
  n.hIn = h.hIn;
  n.hOut = h.hOut;
  return !was;
}

/** The sweep, over a whole document. See `reflowAuto`. */
export function reflowDoc(doc: Doc): boolean {
  let changed = false;
  for (const shape of doc.shapes) {
    for (const sp of shape.subpaths) if (reflowAuto(sp)) changed = true;
  }
  return changed;
}
