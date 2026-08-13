/**
 * Where the snap lattice has to sit for a stroke to land on whole pixels.
 *
 * A stroke is painted centred on its path, so its painted edges sit at
 * `x ± w/2` and both are whole numbers exactly when
 *
 *     x ≡ w/2  (mod 1)
 *
 * Half-integers for a width of 1 or 3, integers for 2 or 4, zero phase for a
 * shape with no stroke at all. That is the ordinary lattice shifted by a
 * **phase**, not a second kind of snapping, which is why `snap` takes one
 * optional argument and nothing else had to change.
 *
 * **One phase is in force at a time, and both callers read it from here.** The
 * phase belongs to a shape's stroke width, so shapes of different widths want
 * different lattices. §9's rule is that every drawn gridline is a position the
 * pointer can land on, and a grid drawn unshifted while the tools snap shifted
 * breaks that in the least visible way there is: half a pixel, on a lattice
 * nobody would think to check. `phaseInForce` is called by the snapper and by
 * the grid renderer, so there is nothing for them to keep in sync.
 *
 * `docs/ARCHITECTURE.md` §25 has the rest: why a mixed-width selection returns
 * `null` instead of choosing a lattice, and why a fractional width can only
 * ever align one of its two edges.
 */

import { findShape, parseNodeKey } from './doc';
import type { Selection } from './doc';
import type { Doc, Style } from '../core/types';

/** The lattice phase a single style wants, in document units, always in [0, 1). */
export function phaseOf(style: Style): number {
  // `Number.isFinite` and not just `> 0`: an infinite width gives `Infinity % 1`
  // of NaN, which breaks the [0, 1) contract above and renders as `offset NaN`.
  if (style.stroke === 'none' || !(style.strokeWidth > 0) || !Number.isFinite(style.strokeWidth)) {
    return 0;
  }
  /* `half` is strictly positive by the guard above, so `half % 1` is already in
     [0, 1) and never -0. No need to fold it through `((x % 1) + 1) % 1`: that
     guards a negative zero no reachable input here can produce. */
  return (style.strokeWidth / 2) % 1;
}

/**
 * The one phase in force, or `null` when the selection cannot agree on one.
 *
 * `null` is a real answer rather than a failure: two shapes with widths 1 and 2
 * want lattices half a unit apart, and there is no third lattice that serves
 * both. The caller falls back to the plain grid and says so, which is honest;
 * silently fitting one of them and not the other would not be.
 */
export function phaseInForce(doc: Doc, selection: Selection, pending: Style): number | null {
  const styles: Style[] = [];
  for (const id of selection.shapes) {
    const shape = findShape(doc, id);
    if (shape) styles.push(shape.style);
  }
  for (const key of selection.nodes) {
    const shape = findShape(doc, parseNodeKey(key).shape);
    if (shape) styles.push(shape.style);
  }

  // Nothing selected means nothing to fit yet, so the phase describes what the
  // next shape drawn will need. That is what makes the pen land correctly on
  // the first click rather than on the second.
  if (!styles.length) return phaseOf(pending);

  const first = phaseOf(styles[0]);
  return styles.every((st) => Math.abs(phaseOf(st) - first) < 1e-9) ? first : null;
}

/**
 * How the phase reads in the status line.
 *
 * Named cases rather than a number, because "0.5" tells nobody anything and
 * "half-pixel" is the thing icon people already say to each other.
 */
export function phaseLabel(phase: number | null): string {
  if (phase === null) return 'mixed widths';
  if (phase === 0) return 'whole pixels';
  if (Math.abs(phase - 0.5) < 1e-9) return 'half pixels';
  return `offset ${+phase.toFixed(3)}`;
}
