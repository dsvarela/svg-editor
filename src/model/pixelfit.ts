/**
 * Where the snap lattice has to sit for a stroke to land on whole pixels.
 *
 * A stroke is painted centred on its path, so a one-unit stroke whose centreline
 * sits at x = 10 covers 9.5 to 10.5: half of one pixel column and half of the
 * next, which renders as two columns of grey rather than one of black. That is
 * the entire reason icon work is fiddly, and snapping anchors to integers makes
 * it worse rather than better, because integers are exactly the wrong place for
 * an odd-width stroke to be.
 *
 * The condition is one line. The painted edges sit at `x ± w/2`, so both are
 * whole numbers exactly when
 *
 *     x ≡ w/2  (mod 1)
 *
 * which for a width of 1 means half-integers, for a width of 2 means integers,
 * and for 3 means half-integers again. So this is not a different kind of
 * snapping: it is the same lattice, shifted by a **phase**.
 *
 * A shape with no stroke has its edges at the path itself, so its phase is zero
 * and the ordinary grid was right all along.
 *
 * **A fractional stroke width can only have one edge aligned.** The two edges
 * are `w` apart, so unless `w` is a whole number no position puts both on whole
 * pixels, from any lattice. The phase aligns the leading edge and the trailing
 * one falls where it falls. Nothing can do better, and a stroke of width 1.5 was
 * never going to be crisp.
 *
 * The phase depends on the shape's stroke width, which means different shapes
 * want different lattices and no single grid can serve them all. Rather than
 * inventing a per-shape lattice the drawn grid could not show — the exact defect
 * §9 exists to prevent — one phase is in force at a time, taken from what is
 * selected, and both the snapper and the grid renderer read it from here.
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
     [0, 1) and never -0. An earlier version folded it through `((x % 1) + 1) % 1`
     to avoid a negative zero that no reachable input can produce. */
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
