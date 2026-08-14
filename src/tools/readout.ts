/**
 * How a number is written into a status line.
 *
 * Named here because the gesture engine, the commands and the wiring all report
 * numbers, and a readout that rounds one way in one of them and another way in
 * the next reads as a bug in the geometry. `docs/STYLE.md` governs the strings
 * these go into.
 */

/** One decimal at most, and no trailing zero to make an angle look measured. */
export const fmt = (v: number): string => (+v.toFixed(1)).toString();

/**
 * A scale factor as a percentage. Whole numbers only: a readout that flickers
 * through 99.7, 100.2, 99.9 while the pointer sits still is harder to read than
 * one that says 100.
 */
export const pct = (k: number): string => `${Math.round(k * 100)} %`;
