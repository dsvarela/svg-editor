/**
 * SVG path data -> `Subpath[]`.
 *
 * The tokenizer is adapted from Yann Armelin's svg-path-editor
 * (https://github.com/Yqnn/svg-path-editor, `src/lib/path-parser.ts`,
 * Apache-2.0). Its grammar table is a faithful reading of the SVG 1.1 BNF and
 * gets right the two things hand-rolled path parsers almost always get wrong:
 *
 *   1. Implicit command repetition, including `M x y x y` meaning an `M`
 *      followed by an implicit `L` -- not a second `M`.
 *   2. Arc flags are single characters, so `a1 1 0 011 1` is
 *      rx=1 ry=1 rot=0 large=0 sweep=1 x=1 y=1 -- not five separate numbers.
 *      Matching flags with a general number regex silently mis-parses any
 *      minified path containing arcs.
 *
 * Changed here: the original does `path.slice(cursor).match(re)` on every
 * token, allocating a fresh substring each time -- quadratic on long paths, and
 * map or font data reaches hundreds of kilobytes. Sticky regexes with
 * `lastIndex` match in place instead.
 *
 * Everything downstream of `parse()` is ours: rather than instantiating a class
 * per command, we resolve shorthands, elevate quadratics, flatten arcs, and emit
 * plain nodes.
 */

import { cubicIsLine, quadToCubic } from './bezier';
import { arcToCubics } from './arc';
import type { Cubic, PathNode, Pt, Subpath } from './types';

/* --------------------------------------------------------------- tokenize */

const RE_COMMAND = /[\t\n\f\r ]*([MLHVZCSQTAmlhvzcsqta])[\t\n\f\r ]*/y;
const RE_NUMBER = /[+-]?(?:(?:[0-9]*\.[0-9]+)|(?:[0-9]+\.)|(?:[0-9]+))(?:[eE][+-]?[0-9]+)?/y;
const RE_FLAG = /[01]/y;
const RE_COMMA_WSP = /(?:[\t\n\f\r ]+,?[\t\n\f\r ]*)|(?:,[\t\n\f\r ]*)/y;

/** `n` = number, `f` = single-character arc flag. */
const GRAMMAR: Record<string, string> = {
  M: 'nn',
  L: 'nn',
  H: 'n',
  V: 'n',
  Z: '',
  C: 'nnnnnn',
  S: 'nnnn',
  Q: 'nnnn',
  T: 'nn',
  A: 'nnnffnn',
};

export interface Token {
  /** Command letter, case preserved so relative/absolute survives to the parser. */
  cmd: string;
  args: number[];
}

export class PathSyntaxError extends Error {
  constructor(
    message: string,
    public readonly offset: number,
  ) {
    super(message);
    this.name = 'PathSyntaxError';
  }
}

function matchAt(re: RegExp, s: string, at: number): string | null {
  re.lastIndex = at;
  const m = re.exec(s);
  return m ? m[0] : null;
}

export function tokenize(path: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < path.length) {
    RE_COMMAND.lastIndex = cursor;
    const cm = RE_COMMAND.exec(path);
    if (!cm) {
      // Trailing whitespace is fine; anything else is not.
      if (path.slice(cursor).trim() === '') break;
      throw new PathSyntaxError(`Unexpected character '${path[cursor]}'`, cursor);
    }
    if (tokens.length === 0 && cm[1].toUpperCase() !== 'M') {
      throw new PathSyntaxError('Path must begin with a moveto command', cursor);
    }

    let cmd = cm[1];
    cursor = RE_COMMAND.lastIndex;

    const spec = GRAMMAR[cmd.toUpperCase()];
    if (spec === '') {
      tokens.push({ cmd, args: [] });
      continue;
    }

    // Repeat the argument group until it stops matching: that is how implicit
    // command repetition works in path data.
    for (;;) {
      const args: number[] = [];
      let ok = true;

      for (let i = 0; i < spec.length; i++) {
        const text = matchAt(spec[i] === 'f' ? RE_FLAG : RE_NUMBER, path, cursor);
        if (text === null) {
          if (i === 0 && args.length === 0) {
            ok = false;
            break;
          }
          throw new PathSyntaxError(`Expected a number for '${cmd}'`, cursor);
        }
        args.push(parseFloat(text));
        cursor += text.length;
        const ws = matchAt(RE_COMMA_WSP, path, cursor);
        if (ws !== null) cursor += ws.length;
      }

      if (!ok) break;
      tokens.push({ cmd, args });

      // After an explicit moveto, further coordinate pairs are linetos.
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
    }
  }

  return tokens;
}

/* ------------------------------------------------------------------ parse */

const node = (pt: Pt): PathNode => ({ pt, hIn: null, hOut: null });

/**
 * Accumulates nodes for one subpath, welding each new segment onto the
 * previous node's outgoing handle.
 */
class SubpathBuilder {
  nodes: PathNode[] = [];
  closed = false;

  constructor(start: Pt) {
    this.nodes.push(node(start));
  }

  private last(): PathNode {
    return this.nodes[this.nodes.length - 1];
  }

  lineTo(p: Pt): void {
    this.last().hOut = null;
    this.nodes.push(node(p));
  }

  curveTo(c: Cubic): void {
    // A `C` that is geometrically straight becomes a real line, so it
    // round-trips as `L` rather than as six redundant numbers.
    if (cubicIsLine(c)) {
      this.lineTo(c[3]);
      return;
    }
    this.last().hOut = [c[1][0], c[1][1]];
    const n = node([c[3][0], c[3][1]]);
    n.hIn = [c[2][0], c[2][1]];
    this.nodes.push(n);
  }

  /**
   * Close the ring. If the author explicitly returned to the start point
   * before `Z`, that final node is redundant -- fold its incoming handle into
   * node 0 and drop it, so the ring has no duplicate anchor.
   */
  close(): void {
    this.closed = true;
    if (this.nodes.length > 1) {
      const first = this.nodes[0];
      const last = this.last();
      if (Math.abs(first.pt[0] - last.pt[0]) < 1e-9 && Math.abs(first.pt[1] - last.pt[1]) < 1e-9) {
        first.hIn = last.hIn;
        this.nodes.pop();
      }
    }
  }

  finish(): Subpath | null {
    if (this.nodes.length < 2) return null;
    return { nodes: this.nodes, closed: this.closed };
  }
}

/**
 * Parse path data into subpaths.
 *
 * Throws `PathSyntaxError` on malformed input; the caller decides whether to
 * surface that or keep the last good state.
 */
export function parsePath(d: string): Subpath[] {
  const tokens = tokenize(d);
  const out: Subpath[] = [];

  let builder: SubpathBuilder | null = null;
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  /** Second control of the previous cubic, for `S` reflection. */
  let prevCubicC2: Pt | null = null;
  /** Control of the previous quadratic, for `T` reflection. */
  let prevQuadQ: Pt | null = null;

  const flush = (): void => {
    if (!builder) return;
    const sp = builder.finish();
    if (sp) out.push(sp);
    builder = null;
  };

  for (const { cmd, args } of tokens) {
    const rel = cmd >= 'a';
    const upper = cmd.toUpperCase();
    const ox = rel ? cur[0] : 0;
    const oy = rel ? cur[1] : 0;

    switch (upper) {
      case 'M': {
        flush();
        cur = [ox + args[0], oy + args[1]];
        start = [cur[0], cur[1]];
        builder = new SubpathBuilder([cur[0], cur[1]]);
        prevCubicC2 = prevQuadQ = null;
        break;
      }

      case 'L':
      case 'H':
      case 'V': {
        if (!builder) break;
        const p: Pt =
          upper === 'L'
            ? [ox + args[0], oy + args[1]]
            : upper === 'H'
              ? [ox + args[0], cur[1]]
              : [cur[0], oy + args[0]];
        builder.lineTo(p);
        cur = p;
        prevCubicC2 = prevQuadQ = null;
        break;
      }

      case 'C':
      case 'S': {
        if (!builder) break;
        let c1: Pt;
        let c2: Pt;
        let end: Pt;
        if (upper === 'C') {
          c1 = [ox + args[0], oy + args[1]];
          c2 = [ox + args[2], oy + args[3]];
          end = [ox + args[4], oy + args[5]];
        } else {
          // `S` reflects the previous cubic's second control about the current
          // point. With no previous cubic, the reflection is the point itself.
          c1 = prevCubicC2
            ? [2 * cur[0] - prevCubicC2[0], 2 * cur[1] - prevCubicC2[1]]
            : [cur[0], cur[1]];
          c2 = [ox + args[0], oy + args[1]];
          end = [ox + args[2], oy + args[3]];
        }
        builder.curveTo([[cur[0], cur[1]], c1, c2, end]);
        cur = end;
        prevCubicC2 = c2;
        prevQuadQ = null;
        break;
      }

      case 'Q':
      case 'T': {
        if (!builder) break;
        let q: Pt;
        let end: Pt;
        if (upper === 'Q') {
          q = [ox + args[0], oy + args[1]];
          end = [ox + args[2], oy + args[3]];
        } else {
          q = prevQuadQ
            ? [2 * cur[0] - prevQuadQ[0], 2 * cur[1] - prevQuadQ[1]]
            : [cur[0], cur[1]];
          end = [ox + args[0], oy + args[1]];
        }
        const c = quadToCubic(cur, q, end);
        builder.curveTo(c);
        cur = end;
        prevQuadQ = q;
        prevCubicC2 = [c[2][0], c[2][1]];
        break;
      }

      case 'A': {
        if (!builder) break;
        const end: Pt = [ox + args[5], oy + args[6]];
        const cubics = arcToCubics(cur, args[0], args[1], args[2], args[3] !== 0, args[4] !== 0, end);
        for (const c of cubics) builder.curveTo(c);
        cur = end;
        prevCubicC2 = prevQuadQ = null;
        break;
      }

      case 'Z': {
        if (builder) {
          builder.close();
          flush();
        }
        cur = [start[0], start[1]];
        prevCubicC2 = prevQuadQ = null;
        // A drawing command after `Z` with no intervening `M` starts a fresh
        // subpath at the closed subpath's origin.
        builder = new SubpathBuilder([cur[0], cur[1]]);
        break;
      }
    }
  }

  flush();
  return out;
}
