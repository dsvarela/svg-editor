/**
 * `Subpath[]` -> SVG path data.
 *
 * The model has no commands in it, so this file re-derives them. That inversion
 * is the whole point: the user manipulates nodes, and the shortest correct
 * spelling is chosen at the last possible moment.
 *
 * It also means we can emit *better* data than the model strictly holds. A
 * straight segment becomes `L`, or `H`/`V` when it is axis-aligned. A cubic
 * that happens to be a degree-elevated quadratic becomes `Q` (4 numbers rather
 * than 6). A cubic whose first control mirrors its predecessor's second becomes
 * `S` (4 rather than 6). Every one of these is exact -- the rendered shape is
 * identical, only the spelling is shorter.
 */

import { cubicAsQuad } from './bezier';
import { segmentAsCubic, segmentCount, segmentIsLine,
  endNodeIndex,
  PATH_DECIMALS,
} from './types';
import type { Pt, Subpath } from './types';

export interface SerialiseOptions {
  /** Maximum digits after the decimal point. */
  decimals?: number;
  /** Strip optional separators and leading zeros, and use relative commands when shorter. */
  minify?: boolean;
  /** Emit `Q`/`S` shorthands where they are exact. */
  shorthands?: boolean;
}

/**
 * Format a number to at most `d` decimals, dropping trailing zeros and, when
 * minifying, the leading zero of values below 1 (`0.5` -> `.5`).
 * Adapted from svg-path-editor's `formatNumber` (Apache-2.0).
 */
export function formatNumber(v: number, d: number, minify = false): string {
  let s = v.toFixed(d);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  if (minify) s = s.replace(/^(-?)0\./, '$1.');
  return s;
}

interface Cmd {
  letter: string;
  args: number[];
  /**
   * The node this command arrives at, when it arrives at one.
   *
   * Carried so the writer can say where in the text each node ended up. `Z`
   * arrives nowhere new -- it closes back onto a node an earlier command
   * already placed -- so it has none.
   */
  at?: { sp: number; i: number };
}

/**
 * Where one node's command sits in the emitted text.
 *
 * Half-open character offsets, `[start, end)`, into exactly the string
 * `serialisePath` returned. Any later edit to that string invalidates them,
 * which is why they are handed back rather than stored.
 */
export interface Mark {
  sp: number;
  i: number;
  start: number;
  end: number;
}

/**
 * Join commands with the fewest characters that still parse.
 *
 * A separator is unnecessary before a token that cannot merge with the one
 * before it: anything starting with `-`, or a `.`-leading token following a
 * token that has no decimal point of its own.
 */
function writeCommands(cmds: Cmd[], decimals: number, minify: boolean, marks?: Mark[]): string {
  if (!minify) {
    let out = '';
    for (const c of cmds) {
      if (out) out += ' ';
      const start = out.length;
      out += c.args.length
        ? `${c.letter} ${c.args.map((a) => formatNumber(a, decimals)).join(' ')}`
        : c.letter;
      if (c.at && marks) marks.push({ ...c.at, start, end: out.length });
    }
    return out;
  }

  let out = '';
  let prevToken = '';
  let prevLetter = '';

  for (const c of cmds) {
    const started = out.length;
    // An implicit repeat of the previous command can drop the letter entirely,
    // and a moveto implies lineto for its repeats.
    const implied = prevLetter === c.letter && c.args.length > 0 && c.letter !== 'M' && c.letter !== 'm';
    if (!implied) {
      out += c.letter;
      prevToken = '';
    }
    prevLetter = c.letter === 'M' ? 'L' : c.letter === 'm' ? 'l' : c.letter;

    for (const a of c.args) {
      const t = formatNumber(a, decimals, true);
      // `-` always self-delimits. A `.`-leading token self-delimits too, but
      // only when the token before it already contains a `.`: `.5` after `.5`
      // reads as two numbers, whereas `.5` after `1` would merge into `1.5`.
      const needsSep =
        prevToken !== '' &&
        (t.startsWith('.') ? !prevToken.includes('.') : !t.startsWith('-'));
      if (needsSep) out += ' ';
      out += t;
      prevToken = t;
    }
    if (c.at && marks) marks.push({ ...c.at, start: started, end: out.length });
  }
  return out;
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

/** Serialise one subpath. `spIndex` only labels the commands; it changes nothing. */
function serialiseSubpath(
  sp: Subpath,
  opts: Required<SerialiseOptions>,
  eps: number,
  spIndex = 0,
): Cmd[] {
  const { minify, shorthands } = opts;
  const cmds: Cmd[] = [];
  const nSeg = segmentCount(sp);

  // `H`/`V` are only valid if the coordinates match in the OUTPUT, so compare
  // rounded values. Note this rounds for comparison only -- the geometry itself
  // stays exact, which matters because `cubicAsQuad` amplifies any error in a
  // control point by 1.5x and would stop recognising quadratics entirely.
  // Same rule as the pen in `preferRelative`: round with the emitter, so the
  // comparison agrees with the text that will actually be written.
  const qv = (v: number): number => parseFloat(formatNumber(v, opts.decimals));

  const start = sp.nodes[0].pt;
  cmds.push({ letter: 'M', args: [start[0], start[1]], at: { sp: spIndex, i: 0 } });

  let cur: Pt = [start[0], start[1]];
  /** Second control of the previous emitted cubic, for `S` detection. */
  let prevC2: Pt | null = null;

  for (let i = 0; i < nSeg; i++) {
    const isLast = i === nSeg - 1;
    const c = segmentAsCubic(sp, i);
    const end = c[3];
    /* Which node this command arrives at. On the closing segment of a closed
       path that is node 0, which the `M` already placed -- so the mark for the
       node people would point at is the `M`, and this one loses the race by
       being written later. It is never emitted anyway when the closing segment
       is straight, since `Z` draws it. */
    const at = { sp: spIndex, i: endNodeIndex(sp, i) };

    if (segmentIsLine(sp, i)) {
      // A closing straight segment needs no command at all -- `Z` draws it.
      if (sp.closed && isLast) break;

      if (qv(end[1]) === qv(cur[1])) {
        cmds.push({ letter: 'H', args: [end[0]], at });
      } else if (qv(end[0]) === qv(cur[0])) {
        cmds.push({ letter: 'V', args: [end[1]], at });
      } else {
        cmds.push({ letter: 'L', args: [end[0], end[1]], at });
      }
      prevC2 = null;
    } else {
      const q = shorthands ? cubicAsQuad(c, eps) : null;
      if (q) {
        cmds.push({ letter: 'Q', args: [q[0], q[1], end[0], end[1]], at });
        prevC2 = null;
      } else {
        const mirrored =
          shorthands &&
          prevC2 !== null &&
          near(c[1][0], 2 * cur[0] - prevC2[0], eps) &&
          near(c[1][1], 2 * cur[1] - prevC2[1], eps);
        if (mirrored) {
          cmds.push({ letter: 'S', args: [c[2][0], c[2][1], end[0], end[1]], at });
        } else {
          cmds.push({ letter: 'C', args: [c[1][0], c[1][1], c[2][0], c[2][1], end[0], end[1]], at });
        }
        prevC2 = [c[2][0], c[2][1]];
      }
    }
    cur = [end[0], end[1]];
  }

  if (sp.closed) cmds.push({ letter: 'Z', args: [] });

  return minify ? preferRelative(cmds, opts.decimals) : cmds;
}

/**
 * Rewrite each command in relative form and keep whichever spelling is shorter.
 *
 * Relative usually wins on dense artwork (small deltas, fewer digits) and loses
 * on sparse artwork, so measuring beats guessing.
 *
 * Deltas are taken against the position a *parser* will hold after reading the
 * rounded output, not against the ideal position. Otherwise each relative
 * command banks its own rounding error and a long path walks away from where it
 * should be -- invisible in a unit test with three segments, obvious on a map
 * outline with three thousand.
 */
function preferRelative(cmds: Cmd[], decimals: number): Cmd[] {
  // Round via the emitter itself, not an equivalent-looking `Math.round(v*f)/f`.
  // `toFixed` and scaled `Math.round` disagree on values whose binary form sits
  // just under a half-way point, and a pen that believes a different number
  // than the text encodes drifts by a whole grid step each time they diverge.
  const round = (v: number): number => parseFloat(formatNumber(v, decimals));

  const out: Cmd[] = [];
  /**
   * Where a parser of the emitted text will believe the pen is.
   *
   * From the origin, and only within this subpath: the caller runs this over
   * one subpath's commands at a time, so a `Z` is always the last of them and
   * the first `M` is always measured from nothing. That costs a few characters
   * on a document of many subpaths, each of which spells its opening move in
   * full, and it is what keeps this pass unable to carry a rounding error from
   * one subpath into the next.
   *
   * It also means a `Z` has nothing after it to move: the subpath origin this
   * used to restore the pen to was written by every `M` and read by nobody.
   */
  let pen: Pt = [0, 0];

  for (const c of cmds) {
    if (c.letter === 'Z') {
      out.push(c);
      continue;
    }

    const rel: number[] = c.args.slice();
    if (c.letter === 'H') {
      rel[0] = round(rel[0] - pen[0]);
    } else if (c.letter === 'V') {
      rel[0] = round(rel[0] - pen[1]);
    } else {
      for (let i = 0; i < rel.length; i += 2) {
        rel[i] = round(rel[i] - pen[0]);
        rel[i + 1] = round(rel[i + 1] - pen[1]);
      }
    }

    const cost = (a: number[]): number =>
      a.reduce((n, v) => n + formatNumber(v, decimals, true).length + 1, 0);

    const useRel = cost(rel) < cost(c.args);
    out.push(useRel ? { letter: c.letter.toLowerCase(), args: rel, ...(c.at ? { at: c.at } : {}) } : c);

    // Advance the pen exactly as a parser would, given the spelling chosen --
    // including the rounding the absolute form will undergo on the way out.
    if (c.letter === 'H') {
      pen = [useRel ? round(pen[0] + rel[0]) : round(c.args[0]), pen[1]];
    } else if (c.letter === 'V') {
      pen = [pen[0], useRel ? round(pen[1] + rel[0]) : round(c.args[0])];
    } else {
      const n = c.args.length;
      pen = useRel
        ? [round(pen[0] + rel[n - 2]), round(pen[1] + rel[n - 1])]
        : [round(c.args[n - 2]), round(c.args[n - 1])];
    }
  }
  return out;
}


/**
 * Serialise subpaths to a `d` attribute value.
 *
 * `marks`, when given, is filled with where each node's command landed. An
 * out-parameter rather than a second return value, so every render and every
 * export pays nothing for a feature only the source drawer uses. §36.
 */
export function serialisePath(
  subpaths: Subpath[],
  options: SerialiseOptions = {},
  marks?: Mark[],
): string {
  const opts: Required<SerialiseOptions> = {
    decimals: options.decimals ?? PATH_DECIMALS,
    minify: options.minify ?? false,
    shorthands: options.shorthands ?? true,
  };
  // Treat anything below half the last retained digit as equal, so shorthand
  // detection is not defeated by noise the output would round away anyway.
  const eps = Math.pow(10, -opts.decimals) / 2;

  /* Indexed before filtering, so a subpath too short to emit does not shift
     the numbers of the ones after it: the marks address the model, and the
     model still has it. */
  const cmds = subpaths.flatMap((sp, spI) =>
    sp.nodes.length >= 2 ? serialiseSubpath(sp, opts, eps, spI) : [],
  );

  return writeCommands(cmds, opts.decimals, opts.minify, marks);
}
