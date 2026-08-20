/**
 * Corners: measuring one, replacing it with an arc, and reading that arc back.
 *
 * A corner is a cusp. Whether the segments either side are straight decides how
 * the arc is found, never whether there is one to find, and the two cases are
 * both here so that the canvas widget and the rail button cannot disagree about
 * which corners are roundable.
 *
 * §23 of `docs/ARCHITECTURE.md` has the construction and §48 the recovery.
 */

import {
  cubicAt,
  cubicDerivAt,
  cubicLength,
  cubicOver,
  cubicSecondDerivAt,
  cubicUnitTangent,
  reverseCubic,
  splitCubic,
} from '../core/bezier';
import { arcHandle } from '../core/primitives';
import {
  clonePt,
  endNodeIndex,
  makeNode,
  MEET,
  nextNodeId,
  SAME_PLACE,
  segmentAsCubic,
  segmentIsLine,
} from '../core/types';
import type { Cubic, PathNode, Pt, Subpath } from '../core/types';

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
/** Straight-line distance between two points. */
const chord = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Why a corner could not be rounded, or `null` when it was. Named reasons
 * rather than a bare `false`: each one is something the caller can act on.
 */
export type RoundRefusal = 'end' | 'straight' | 'tiny';

export interface RoundResult {
  /** The radius actually used, which may be smaller than the one asked for. */
  radius: number;
  /** True when the sides were too short for the radius requested. */
  clamped: boolean;
}

/**
 * A corner that could be rounded, measured.
 *
 * `u` and `v` are the unit tangents leaving the corner, `alpha` the interior
 * angle between them. `sides` holds those two directions as the curves they
 * actually are, in the same order, each running from the corner outward, and
 * `lines` says which of them is straight.
 */
export interface Corner {
  at: Pt;
  u: Pt;
  v: Pt;
  alpha: number;
  /** The two sides, as cubics leaving the corner. `[0]` runs back toward the previous node. */
  sides: [Cubic, Cubic];
  /** Whether each side is a straight line, in `sides` order. */
  lines: [boolean, boolean];
  /** How much of each side there is to cut into, in `sides` order. */
  lengths: [number, number];
}

/** A straight cubic whose parameter moves at a constant speed along it. */
const evenLine = (a: Pt, b: Pt): Cubic => [
  clonePt(a),
  [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
  [a[0] + (b[0] - a[0]) * (2 / 3), a[1] + (b[1] - a[1]) * (2 / 3)],
  clonePt(b),
];

/**
 * A control point read back as a handle, or `null` where it sits on its anchor.
 *
 * The inverse of what `segmentAsCubic` does on the way out, so a segment taken
 * apart and put back keeps the model's own answer to "is this a line".
 */
const handleOrNull = (h: Pt, anchor: Pt): Pt | null =>
  Math.hypot(h[0] - anchor[0], h[1] - anchor[1]) <= SAME_PLACE ? null : clonePt(h);

/** The unsigned angle between two vectors. */
const turnBetween = (a: Pt, b: Pt): number =>
  Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));

/**
 * The two sides of the corner at `i`, as cubics leaving it.
 *
 * A straight segment is respaced so its parameter moves evenly. The model
 * stores a line with both controls on the anchors, which leaves the derivative
 * zero at each end, and the solver below reads a tangent exactly there. Same
 * line, same endpoints, a parameter that moves.
 */
function cornerSides(sp: Subpath, i: number): { sides: [Cubic, Cubic]; lines: [boolean, boolean] } {
  const n = sp.nodes.length;
  const prevI = (i - 1 + n) % n;
  const here = sp.nodes[i].pt;
  const lines: [boolean, boolean] = [segmentIsLine(sp, prevI), segmentIsLine(sp, i)];
  return {
    sides: [
      lines[0] ? evenLine(here, sp.nodes[prevI].pt) : reverseCubic(segmentAsCubic(sp, prevI)),
      lines[1] ? evenLine(here, sp.nodes[endNodeIndex(sp, i)].pt) : segmentAsCubic(sp, i),
    ],
    lines,
  };
}

/**
 * Measure the corner at node `i`, or say why there is not one.
 *
 * **A corner is a cusp, whatever its sides are made of.** What decides is
 * whether the path changes direction here, which is `alpha`, and not whether
 * the segments either side happen to be straight. Two curves meeting at an
 * angle is a corner to everyone who draws one, and it is the tangents that say
 * so.
 *
 * Shared with `roundCorner` rather than restated in it, because the widget on the
 * canvas and the button in the rail have to agree about which corners are
 * roundable and about what radius a given tangent point means. Two answers to
 * that would be two answers to "why did nothing happen".
 */
export function cornerAt(sp: Subpath, i: number): Corner | RoundRefusal {
  const n = sp.nodes.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) return 'tiny';
  if (!sp.closed && (i === 0 || i === n - 1)) return 'end';
  if (n < 3) return 'tiny';

  const { sides, lines } = cornerSides(sp, i);
  const u = cubicUnitTangent(sides[0], 0);
  const v = cubicUnitTangent(sides[1], 0);
  if (!u || !v) return 'tiny';

  // Interior angle at the corner, between the two tangents leaving it.
  const cos = Math.min(1, Math.max(-1, u[0] * v[0] + u[1] * v[1]));
  const alpha = Math.acos(cos);
  /* Nothing to round where the path runs smoothly through, and nothing sensible
     to do where it folds back on itself. A smooth node has its two tangents
     exactly opposed, which is what puts `alpha` at pi. */
  if (alpha > Math.PI - 1e-6 || alpha < 1e-6) return 'straight';

  const lengths: [number, number] = [
    lines[0] ? chord(sides[0][3], sides[0][0]) : cubicLength(sides[0]),
    lines[1] ? chord(sides[1][3], sides[1][0]) : cubicLength(sides[1]),
  ];
  if (lengths[0] < 1e-9 || lengths[1] < 1e-9) return 'tiny';

  return { at: clonePt(sp.nodes[i].pt), u, v, alpha, sides, lines, lengths };
}

/**
 * Solve `[c0 c1] step = -f` for the step, or `null` where the columns are parallel.
 *
 * The one piece of algebra both Newton solves here need, written once so a sign
 * cannot be right in the corner and wrong in its undo.
 */
function step2(c0: Pt, c1: Pt, f: Pt): Pt | null {
  const det = c0[0] * c1[1] - c1[0] * c0[1];
  if (Math.abs(det) < 1e-14) return null;
  return [(-f[0] * c1[1] + c1[0] * f[1]) / det, (-c0[0] * f[1] + f[0] * c0[1]) / det];
}

/**
 * A radius and a cut distance are one relation, and it is stated here.
 *
 * True of straight sides only: two lines touch a circle the same distance out
 * along each, so either number gives the other. Against a curve the touch point
 * is solved for rather than measured out, and these are the seed for that.
 */
const cutForRadius = (c: Corner, r: number): number => r / Math.tan(c.alpha / 2);
const radiusForCut = (c: Corner, cut: number): number => cut * Math.tan(c.alpha / 2);

/** Where an arc of a given radius touches the two sides of a corner. */
interface Tangency {
  /** Parameter on each side, in `sides` order. */
  s: [number, number];
  /** The two touch points, in the same order. */
  at: [Pt, Pt];
  /** The arc's centre. */
  centre: Pt;
}

/** Parameter at arc distance `d` from the start of `b`, clamped to the curve. */
function paramAtDistance(b: Cubic, d: number, steps = 32): number {
  if (!(d > 0)) return 0;
  let acc = 0;
  let prev = cubicAt(b, 0);
  for (let k = 1; k <= steps; k++) {
    const q = cubicAt(b, k / steps);
    const seg = Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    prev = q;
    if (seg <= 0) continue;
    if (acc + seg >= d) return (k - 1 + (d - acc) / seg) / steps;
    acc += seg;
  }
  return 1;
}

/**
 * Place a circle of radius `r` tangent to both sides, inside the corner.
 *
 * `null` when no such circle sits on both sides within their length, which is
 * the same thing as the radius being too large for this corner.
 *
 * The seed has to stay the answer two straight sides would give. That is what
 * keeps the step count independent of how hard the sides bend, because it is
 * what any pair of sides looks like close enough to a corner. §23.
 */
function tangentCircle(c: Corner, r: number): Tangency | null {
  const [A, B] = c.sides;
  /* Which way each side's normal turns to face the other. Fixed at the corner
     and carried, because reading it again further along would let an inflection
     flip the circle to the outside halfway through the solve. */
  const hand = c.u[0] * c.v[1] - c.u[1] * c.v[0];
  if (Math.abs(hand) < 1e-12) return null;

  /* Where a side puts the centre, and how that centre moves as the touch point
     slides. The normal is a unit vector, so its derivative is the tangent's
     with the part along the tangent taken out. */
  const from = (b: Cubic, s: number, rot: number): { at: Pt; c: Pt; d: Pt } | null => {
    const p = cubicAt(b, s);
    const d1 = cubicDerivAt(b, s);
    const L = Math.hypot(d1[0], d1[1]);
    if (L < 1e-12) return null;
    const d2 = cubicSecondDerivAt(b, s);
    const along = (d1[0] * d2[0] + d1[1] * d2[1]) / (L * L);
    const tx = (d2[0] - d1[0] * along) / L;
    const ty = (d2[1] - d1[1] * along) / L;
    return {
      at: p,
      c: [p[0] + (r * -d1[1] * rot) / L, p[1] + (r * d1[0] * rot) / L],
      d: [d1[0] - r * ty * rot, d1[1] + r * tx * rot],
    };
  };

  const cut = cutForRadius(c, r);
  const seed = (k: 0 | 1): number =>
    c.lines[k] ? Math.min(1, cut / c.lengths[k]) : paramAtDistance(c.sides[k], cut);
  let s = seed(0);
  let t = seed(1);

  const tol = 1e-9 * Math.max(1, r);
  for (let k = 0; k < 40; k++) {
    const ca = from(A, s, Math.sign(hand));
    const cb = from(B, t, -Math.sign(hand));
    if (!ca || !cb) return null;
    const f: Pt = [ca.c[0] - cb.c[0], ca.c[1] - cb.c[1]];
    if (Math.hypot(f[0], f[1]) <= tol) {
      return { s: [s, t], at: [ca.at, cb.at], centre: ca.c };
    }
    const step = step2(ca.d, [-cb.d[0], -cb.d[1]], f);
    if (!step) return null;
    /* Held on the sides rather than let loose. Past either end the cubic keeps
       going as a polynomial but the side has stopped, so a step out there would
       converge on a circle touching geometry that is not in the path. Pinned at
       an end the residual stays large and this refuses, which is exactly the
       radius being too big. */
    s = Math.min(1, Math.max(1e-9, s + step[0]));
    t = Math.min(1, Math.max(1e-9, t + step[1]));
  }
  return null;
}

/** The arc a corner actually gets for a requested radius, clamped to what fits. */
interface Arc extends Tangency {
  radius: number;
  clamped: boolean;
}

/**
 * The largest radius this corner holds, subject to `holds` on where it touches.
 *
 * Bisection is sound here because the relation is monotone: a larger circle
 * always touches further from the corner. §23 has the argument for why there is
 * no formula to use in its place.
 */
function largestRadius(c: Corner, holds: (t: Tangency) => boolean): number {
  const ok = (r: number): boolean => {
    const t = tangentCircle(c, r);
    return t !== null && holds(t);
  };
  let lo = 0;
  let hi = radiusForCut(c, Math.min(c.lengths[0], c.lengths[1]));
  if (!(hi > 0)) return 0;
  // The straight-sided answer is the right scale to start from; a curved side
  // moves it by a factor, so grow until it stops fitting and bracket from there.
  for (let k = 0; k < 8 && ok(hi); k++) {
    lo = hi;
    hi *= 2;
  }
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** How far along side `k` the touch point sits, measured along the side. */
const cutAlong = (c: Corner, t: Tangency, k: 0 | 1): number =>
  c.lines[k] ? t.s[k] * c.lengths[k] : cubicLength(cubicOver(c.sides[k], 0, t.s[k]));

/**
 * The largest radius a corner can hold before its arc runs off the end of a side.
 */
export function maxCornerRadius(c: Corner): number {
  return radiusWithin(c, c.lengths[0], c.lengths[1]);
}

/**
 * The largest radius whose arc touches each side no further out than its limit.
 *
 * Two lines answer outright, and not as a shortcut for speed: the closed form
 * is exact where a search only converges.
 *
 * The slack on the curved test is the instrument's, not the geometry's. A limit
 * and a cut are both arc lengths measured by flattening, of curves derived
 * along different routes, so a touch point sitting exactly on the end of its
 * side can measure a hair past it and lose a radius that fits.
 */
function radiusWithin(c: Corner, limitA: number, limitB: number): number {
  if (c.lines[0] && c.lines[1]) return radiusForCut(c, Math.min(limitA, limitB));
  const fits = (cut: number, limit: number): boolean => cut <= limit * (1 + 1e-9);
  return largestRadius(
    c,
    (t) => fits(cutAlong(c, t, 0), limitA) && fits(cutAlong(c, t, 1), limitB),
  );
}

/** Fit an arc of at most `radius` into the corner, saying whether it was cut down. */
function fitArc(c: Corner, radius: number): Arc | null {
  if (c.lines[0] && c.lines[1]) {
    /* Clamped as a distance and read back as a radius, rather than the other way
       round. Both are one relation, and the direction matters: the limit is a
       length of side, so clamping there is exact, while clamping the radius and
       converting would land a hair off the side it was meant to reach. */
    const half = c.alpha / 2;
    const reach = Math.min(c.lengths[0], c.lengths[1]);
    let cut = cutForRadius(c, radius);
    const clamped = cut > reach;
    if (clamped) cut = reach;
    const r = radiusForCut(c, cut);
    if (!(r > 1e-9)) return null;
    const bx = c.u[0] + c.v[0];
    const by = c.u[1] + c.v[1];
    const bl = Math.hypot(bx, by);
    if (bl < 1e-12) return null;
    const away = r / Math.sin(half);
    return {
      radius: r,
      clamped,
      s: [cut / c.lengths[0], cut / c.lengths[1]],
      at: [
        [c.at[0] + c.u[0] * cut, c.at[1] + c.u[1] * cut],
        [c.at[0] + c.v[0] * cut, c.at[1] + c.v[1] * cut],
      ],
      centre: [c.at[0] + (bx / bl) * away, c.at[1] + (by / bl) * away],
    };
  }

  const direct = tangentCircle(c, radius);
  if (direct) return { radius, clamped: false, ...direct };
  const held = maxCornerRadius(c);
  if (!(held > 1e-9)) return null;
  const t = tangentCircle(c, held);
  return t ? { radius: held, clamped: true, ...t } : null;
}

/**
 * The largest radius every corner named by `ids` can hold at the same time.
 *
 * `maxCornerRadius` answers for one corner on its own, which stops being the
 * right question the moment its neighbour is rounding too: the two arcs eat the
 * side between them from both ends, so each may have half of it. Rounding a
 * square's four corners without this clamps them one at a time, in whatever
 * order the loop ran, and returns four different radii for one request.
 *
 * Ids rather than indices because rounding splices, and 0 rather than infinity
 * when nothing in the set is a corner, so the caller has one number to test.
 */
export function sharedCornerRadius(sp: Subpath, ids: readonly string[]): number {
  const n = sp.nodes.length;
  const corners = new Map<string, Corner>();
  /* Which of them will actually take an arc, gathered first. Being in the
     selection is not the question: a node in it that is not a corner rounds to
     nothing and so eats none of the side it shares, and halving that side for it
     hands its neighbour half the radius it can have. */
  for (const id of ids) {
    const i = sp.nodes.findIndex((nd) => nd.id === id);
    if (i < 0) continue;
    const c = cornerAt(sp, i);
    if (typeof c !== 'string') corners.set(id, c);
  }

  let max = Infinity;
  for (const [id, c] of corners) {
    const i = sp.nodes.findIndex((nd) => nd.id === id);
    const prev = sp.nodes[(i - 1 + n) % n];
    const next = sp.nodes[(i + 1) % n];
    // How much of each side this corner may take: all of it, or half where the
    // corner at the far end is cutting into the same side.
    const back = c.lengths[0] / (corners.has(prev.id) ? 2 : 1);
    const fwd = c.lengths[1] / (corners.has(next.id) ? 2 : 1);
    max = Math.min(max, radiusWithin(c, back, fwd));
  }
  return Number.isFinite(max) ? max : 0;
}

/**
 * Replace a corner with a circular arc tangent to both of its sides.
 *
 * The node becomes two, one at each tangent point, with a cubic between them.
 *
 * **A side may be curved.** The arc is tangent to whatever is there, found by
 * placing a circle of the radius asked for against both sides at once. What a
 * curved side costs is that the tangent point no longer sits at a distance
 * anyone can write down, so it is solved for rather than measured out, and the
 * side is cut at the point that comes back. §23.
 *
 * The radius is clamped to what the shorter side can hold. Rounding the corners
 * of a rectangle one at a time works because each one sees the sides the
 * previous ones left behind.
 */
export function roundCorner(
  sp: Subpath,
  i: number,
  radius: number,
): RoundResult | RoundRefusal {
  if (!(radius > 0)) return 'tiny';
  const c = cornerAt(sp, i);
  if (typeof c === 'string') return c;
  const arc = fitArc(c, radius);
  if (!arc || !(arc.radius > 1e-9)) return 'tiny';

  const n = sp.nodes.length;
  const prevI = (i - 1 + n) % n;
  const nextI = (i + 1) % n;
  const prev = sp.nodes[prevI];
  const next = sp.nodes[nextI];

  /* What is left of each side once the arc has taken its piece. A straight side
     keeps its handles absent, which is how the model says "line" and what keeps
     a rectangle exporting as one. A curved side is split, and both halves of
     that split are handles somebody has to carry: the near one belongs to the
     neighbour and the far one to the new node. */
  const keptIn = c.lines[0] ? null : splitCubic(segmentAsCubic(sp, prevI), 1 - arc.s[0])[0];
  const keptOut = c.lines[1] ? null : splitCubic(segmentAsCubic(sp, i), arc.s[1])[1];
  const t1: Pt = keptIn ? clonePt(keptIn[3]) : arc.at[0];
  const t2: Pt = keptOut ? clonePt(keptOut[0]) : arc.at[1];

  // The arc turns through the angle its own ends subtend at the centre, which
  // is the exterior angle when both sides are straight and is not otherwise.
  const h = arcHandle(arc.radius, turnBetween(sub(t1, arc.centre), sub(t2, arc.centre)));
  const d1 = cubicUnitTangent(c.sides[0], arc.s[0]);
  const d2 = cubicUnitTangent(c.sides[1], arc.s[1]);
  if (!d1 || !d2) return 'tiny';

  /* A tangent point can land exactly on a neighbour: at the clamp, and where
     two fillets meet on a side they share. The neighbour is reused there, or
     the path carries a zero-length segment and can never be simplified again --
     a zero chord gives the fitter no tangent. §23. */
  const startsAtPrev = Math.hypot(t1[0] - prev.pt[0], t1[1] - prev.pt[1]) <= MEET;
  const endsAtNext = Math.hypot(t2[0] - next.pt[0], t2[1] - next.pt[1]) <= MEET;

  // Travel runs prev -> t1 -> arc -> t2 -> next, so the tangent leaving `t1`
  // points into the corner and the one arriving at `t2` points away from it.
  const first: PathNode = {
    id: nextNodeId(),
    pt: t1,
    hIn: keptIn ? handleOrNull(keptIn[2], keptIn[3]) : null,
    hOut: [t1[0] - d1[0] * h, t1[1] - d1[1] * h],
  };
  const second: PathNode = {
    id: nextNodeId(),
    pt: t2,
    hIn: [t2[0] - d2[0] * h, t2[1] - d2[1] * h],
    hOut: keptOut ? handleOrNull(keptOut[1], keptOut[0]) : null,
  };

  const insert: PathNode[] = [];
  if (startsAtPrev) {
    prev.hOut = first.hOut;
  } else {
    if (keptIn) prev.hOut = handleOrNull(keptIn[1], keptIn[0]);
    insert.push(first);
  }
  if (endsAtNext) {
    next.hIn = second.hIn;
  } else {
    if (keptOut) next.hIn = handleOrNull(keptOut[2], keptOut[3]);
    insert.push(second);
  }
  sp.nodes.splice(i, 1, ...insert);
  return { radius: arc.radius, clamped: arc.clamped };
}

/**
 * A rounded corner, read back off the path.
 *
 * `i` and `j` are the two tangent nodes, `at` the corner they were cut from, and
 * `radius` the one they were cut with. `sides` holds those sides restored to the
 * length they had before the cut, `[0]` arriving at the corner and `[1]` leaving
 * it, and `ends` names the neighbour each one reaches back to.
 */
export interface Fillet {
  i: number;
  j: number;
  at: Pt;
  radius: number;
  sides: [Cubic, Cubic];
  /** The node each side reaches, or -1 where the path ends there. */
  ends: [number, number];
}

/** A fillet's side, run outward from its tangent node toward the corner. */
interface SideRun {
  at: (q: number) => Pt;
  d: (q: number) => Pt;
  /** The side rebuilt whole, with the corner at `q`. */
  whole: (q: number) => Cubic;
  /** Where to start looking: the distance to the crossing the arc's tangents make. */
  seed: number;
  /** The neighbour this side reaches, or -1 where the path ends there. */
  end: number;
  line: boolean;
}

/** Where two sides met before the arc between them cut them apart. */
function crossSides(A: SideRun, B: SideRun): { q: [number, number]; at: Pt } | null {
  let p = A.seed;
  let q = B.seed;
  for (let k = 0; k < 40; k++) {
    const pa = A.at(p);
    const pb = B.at(q);
    const f: Pt = [pa[0] - pb[0], pa[1] - pb[1]];
    if (Math.hypot(f[0], f[1]) <= 1e-10 * (1 + Math.hypot(pa[0], pa[1]))) {
      // Behind either tangent point is some other crossing, not this corner.
      return p > 1e-9 && q > 1e-9 ? { q: [p, q], at: pa } : null;
    }
    const db = B.d(q);
    const s = step2(A.d(p), [-db[0], -db[1]], f);
    if (!s) return null;
    p += s[0];
    q += s[1];
  }
  return null;
}

/**
 * Is the pair of nodes starting at `i` a rounded corner, and if so what of?
 *
 * **Nothing is stored to answer this.** The arc between the two nodes carries
 * its own radius: a circular arc is the one curve whose handles have a fixed
 * length for the angle it turns through, so the radius is read off the geometry
 * and cannot disagree with it.
 *
 * Recovering the *corner* is the harder half, and what it takes depends on the
 * sides. Two straight sides meet where their tangent rays cross, which is one
 * division. A curved side has to be put back: the trimmed piece is an exact
 * restriction of the curve it was cut from, so running that polynomial past its
 * end reproduces what was discarded, and the corner is where the two
 * continuations meet. §48 has the argument.
 */
export function filletAt(sp: Subpath, i: number): Fillet | null {
  const n = sp.nodes.length;
  if (!Number.isInteger(i) || i < 0 || i >= n) return null;
  if (n < 3) return null;
  const j = (i + 1) % n;
  if (!sp.closed && j === 0) return null;

  const a = sp.nodes[i];
  const b = sp.nodes[j];
  // The span between them has to be a curve at all before it can be an arc.
  if (a.hOut === null || b.hIn === null) return null;

  // Direction of travel leaving `a`, and arriving at `b`.
  const da: Pt = [a.hOut[0] - a.pt[0], a.hOut[1] - a.pt[1]];
  const db: Pt = [b.pt[0] - b.hIn[0], b.pt[1] - b.hIn[1]];
  const ha = Math.hypot(da[0], da[1]);
  const hb = Math.hypot(db[0], db[1]);
  if (ha < 1e-9 || hb < 1e-9) return null;
  // Equal handles, which a fillet has by construction and a hand-pulled pair of
  // curves has only by accident.
  if (Math.abs(ha - hb) > 1e-6 * Math.max(ha, hb)) return null;

  const ea: Pt = [da[0] / ha, da[1] / ha];
  const eb: Pt = [db[0] / hb, db[1] / hb];
  // Parallel rays never meet, and a straight run through is not a corner.
  const cross = ea[0] * eb[1] - ea[1] * eb[0];
  if (Math.abs(cross) < 1e-9) return null;

  const w: Pt = [b.pt[0] - a.pt[0], b.pt[1] - a.pt[1]];
  const t = (w[0] * eb[1] - w[1] * eb[0]) / cross;
  if (!(t > 1e-9)) return null; // the crossing is behind `a`, so it is not this arc's
  const meet: Pt = [a.pt[0] + ea[0] * t, a.pt[1] + ea[1] * t];

  const cutA = t;
  const cutB = Math.hypot(b.pt[0] - meet[0], b.pt[1] - meet[1]);
  /* Tangent lengths from one point to one circle are equal, so an arc whose two
     end tangents cross at unequal distances is not one circle's worth of arc. */
  if (Math.abs(cutA - cutB) > 1e-6 * Math.max(cutA, cutB)) return null;

  // The angle the tangent rays make, which is the corner's own only when both
  // sides are straight.
  const cos = Math.min(1, Math.max(-1, -ea[0] * eb[0] + -ea[1] * eb[1]));
  const spread = Math.acos(cos);
  if (spread > Math.PI - 1e-6 || spread < 1e-6) return null;

  const radius = cutA * Math.tan(spread / 2);
  // Circular, not merely tangent: the handle a circular arc through this angle
  // needs is a fixed length, so a pair that misses it is some other curve.
  if (Math.abs(ha - arcHandle(radius, Math.PI - spread)) > 1e-6 * Math.max(ha, 1)) return null;

  /* Both sides are run from their tangent node toward the corner. The arc
     leaves `a` that way already; it arrives at `b` from the corner, so `b`
     looks back along the reverse. */
  const A = filletSide(sp, i, 'in', ea, cutA);
  const B = filletSide(sp, j, 'out', [-eb[0], -eb[1]], cutB);
  if (!A || !B) return null;
  const met = crossSides(A, B);
  if (!met) return null;

  const sides: [Cubic, Cubic] = [A.whole(met.q[0]), B.whole(met.q[1])];
  const fillet: Fillet = {
    i,
    j,
    at: met.at,
    radius,
    sides,
    ends: [A.end, B.end],
  };
  return fillet;
}

/**
 * One side of a candidate fillet, in the direction the corner lies.
 *
 * A straight side is its own extension, so the run is the tangent ray. A curved
 * one is the neighbouring segment carried past its end, which requires the arc
 * to leave along that segment's tangent -- a kink there means the arc is not
 * this curve's fillet, whatever else it is.
 *
 * `e` points from the tangent node toward the corner, for both sides.
 */
function filletSide(
  sp: Subpath,
  at: number,
  which: 'in' | 'out',
  e: Pt,
  cut: number,
): SideRun | null {
  const n = sp.nodes.length;
  const node = sp.nodes[at];
  const segment = which === 'in' ? (at - 1 + n) % n : at;
  const absent = !sp.closed && (which === 'in' ? at === 0 : at === n - 1);
  const end = absent ? -1 : which === 'in' ? segment : endNodeIndex(sp, segment);

  if (absent || segmentIsLine(sp, segment)) {
    const far = end < 0 ? node.pt : sp.nodes[end].pt;
    const on = (q: number): Pt => [node.pt[0] + e[0] * q, node.pt[1] + e[1] * q];
    return {
      at: on,
      d: () => clonePt(e),
      whole: (q) =>
        which === 'in'
          ? [clonePt(far), clonePt(far), on(q), on(q)]
          : [on(q), on(q), clonePt(far), clonePt(far)],
      seed: cut,
      end,
      line: true,
    };
  }

  const c = segmentAsCubic(sp, segment);
  // The corner sits past the end the arc starts at: beyond 1 going forward,
  // before 0 coming back.
  const base = which === 'in' ? 1 : 0;
  const sign = which === 'in' ? 1 : -1;
  const tangent = cubicUnitTangent(c, base);
  if (!tangent) return null;
  // Forward at the far end, backward at the near one, both compared with the
  // direction the arc leaves in.
  const along = sign * (tangent[0] * e[0] + tangent[1] * e[1]);
  if (along < 1 - 1e-9) return null;

  const speed = Math.hypot(...(cubicDerivAt(c, base) as [number, number]));
  return {
    at: (q) => cubicAt(c, base + sign * q),
    d: (q) => {
      const d1 = cubicDerivAt(c, base + sign * q);
      return [sign * d1[0], sign * d1[1]];
    },
    whole: (q) => (which === 'in' ? cubicOver(c, 0, 1 + q) : cubicOver(c, -q, 1)),
    seed: speed > 1e-9 ? cut / speed : cut,
    end,
    line: false,
  };
}


/**
 * How far along the bisector, from the corner, the arc of radius `r` begins.
 *
 * The arc's nearest point to the corner: its centre sits `r / sin(half)` in, and the
 * arc is `r` nearer than that. Paired with `cornerRadiusAtReach`, which is its
 * inverse, so the control drawn on the canvas and the radius a drag means are one
 * relation and not two -- a control that tracked the pointer at some other ratio
 * would slide out from under it.
 */
export const cornerArcReach = (r: number, half: number): number =>
  r <= 0 ? 0 : r / Math.sin(half) - r;

/** The radius whose arc begins `d` from the corner. Zero for anything not positive. */
export const cornerRadiusAtReach = (d: number, half: number): number => {
  const sin = Math.sin(half);
  // `sin` reaches 1 only as the corner opens out flat, which `cornerAt` refuses,
  // so the division is safe for any corner that exists.
  return sin >= 1 || d <= 0 ? 0 : (d * sin) / (1 - sin);
};

/**
 * Put a rounded corner back to the sharp one it was cut from.
 *
 * Returns the index of the node that replaced the pair, or `null` when `i` does
 * not start a fillet. Exact, because `filletAt` recovers the corner rather than
 * approximating it, so unrounding and rounding again at the same radius is the
 * identity on the geometry.
 */
export function unroundCorner(sp: Subpath, i: number): number | null {
  const f = filletAt(sp, i);
  if (!f) return null;
  const [A, B] = f.sides;

  /* The sides come back to the length they had, so the neighbours' handles come
     back with them. A curved side was trimmed at the corner end, which moved the
     handle at the *other* end too, and putting only the corner back would leave
     that trim in the path. Written before the splice, while the indices still
     mean what they meant. */
  if (f.ends[0] >= 0) sp.nodes[f.ends[0]].hOut = handleOrNull(A[1], A[0]);
  if (f.ends[1] >= 0) sp.nodes[f.ends[1]].hIn = handleOrNull(B[2], B[3]);
  const sharp = makeNode(clonePt(f.at), handleOrNull(A[2], A[3]), handleOrNull(B[1], B[0]));

  /* The pair wraps when the first of the two is the last node, and a splice
     cannot remove across the end of an array. Removing the tail and the head
     separately leaves the corner at index 0, which is where the wrap put it. */
  if (f.j === 0) {
    sp.nodes.splice(f.i, 1);
    sp.nodes.splice(0, 1, sharp);
    return 0;
  }
  sp.nodes.splice(f.i, 2, sharp);
  return f.i;
}
