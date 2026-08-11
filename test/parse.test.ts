import { describe, expect, it } from 'vitest';
import { parsePath, tokenize, PathSyntaxError } from '../src/core/parse';
import { serialisePath, formatNumber } from '../src/core/serialise';
import { segmentAsCubic, segmentCount } from '../src/core/types';
import { cubicAt } from '../src/core/bezier';
import type { Pt, Subpath } from '../src/core/types';

/** Sample every segment of every subpath, for geometric comparison. */
function samplePath(sps: Subpath[], per = 16): Pt[] {
  const out: Pt[] = [];
  for (const sp of sps) {
    for (let i = 0; i < segmentCount(sp); i++) {
      const c = segmentAsCubic(sp, i);
      for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per));
    }
  }
  return out;
}

/** Max distance between two paths' sampled outlines. */
function maxDeviation(a: Subpath[], b: Subpath[]): number {
  const pa = samplePath(a);
  const pb = samplePath(b);
  expect(pb.length).toBe(pa.length);
  let worst = 0;
  for (let i = 0; i < pa.length; i++) {
    worst = Math.max(worst, Math.hypot(pa[i][0] - pb[i][0], pa[i][1] - pb[i][1]));
  }
  return worst;
}

describe('tokenizer', () => {
  it('reads implicit linetos after a moveto', () => {
    const t = tokenize('M0 0 10 0 10 10');
    expect(t.map((x) => x.cmd)).toEqual(['M', 'L', 'L']);
  });

  it('reads implicit repeats of other commands', () => {
    const t = tokenize('M0 0 C1 1 2 2 3 3 4 4 5 5 6 6');
    expect(t.map((x) => x.cmd)).toEqual(['M', 'C', 'C']);
  });

  it('reads packed arc flags', () => {
    // The classic trap: `011` is large=0, sweep=1, then x=1.
    const t = tokenize('M0 0a1 1 0 011 1');
    expect(t[1].cmd).toBe('a');
    expect(t[1].args).toEqual([1, 1, 0, 0, 1, 1, 1]);
  });

  it('reads numbers with no separator before a minus sign', () => {
    const t = tokenize('M0 0L-1-1');
    expect(t[1].args).toEqual([-1, -1]);
  });

  it('reads exponent notation', () => {
    const t = tokenize('M0 0L1e2 1.5e-2');
    expect(t[1].args).toEqual([100, 0.015]);
  });

  it('reads numbers with no leading zero', () => {
    const t = tokenize('M.5.5L.25-.75');
    expect(t[0].args).toEqual([0.5, 0.5]);
    expect(t[1].args).toEqual([0.25, -0.75]);
  });

  it('rejects a path that does not start with a moveto', () => {
    expect(() => tokenize('L10 10')).toThrow(PathSyntaxError);
  });
});

describe('parser', () => {
  it('builds one node per corner of a closed triangle', () => {
    const sp = parsePath('M0 0 L10 0 L5 10 Z');
    expect(sp).toHaveLength(1);
    expect(sp[0].closed).toBe(true);
    expect(sp[0].nodes).toHaveLength(3);
    expect(segmentCount(sp[0])).toBe(3);
  });

  it('drops a redundant final node before Z', () => {
    // Explicitly returning to the start should not leave a duplicate anchor.
    const sp = parsePath('M0 0 L10 0 L5 10 L0 0 Z');
    expect(sp[0].nodes).toHaveLength(3);
  });

  it('splits multiple subpaths', () => {
    const sp = parsePath('M0 0 L10 0 Z M20 20 L30 20 L30 30 Z');
    expect(sp).toHaveLength(2);
    expect(sp[1].nodes).toHaveLength(3);
  });

  it('records straight segments as null handles, not collapsed controls', () => {
    const sp = parsePath('M0 0 L10 0');
    expect(sp[0].nodes[0].hOut).toBeNull();
    expect(sp[0].nodes[1].hIn).toBeNull();
  });

  it('recognises a degenerate cubic as a line', () => {
    const sp = parsePath('M0 0 C0 0 10 0 10 0');
    expect(sp[0].nodes[0].hOut).toBeNull();
    expect(sp[0].nodes[1].hIn).toBeNull();
  });

  it('keeps a real cubic curved', () => {
    const sp = parsePath('M0 0 C0 5 10 5 10 0');
    expect(sp[0].nodes[0].hOut).toEqual([0, 5]);
    expect(sp[0].nodes[1].hIn).toEqual([10, 5]);
  });

  it('reflects S off the preceding cubic', () => {
    const sp = parsePath('M0 0 C0 5 5 5 5 0 S10 -5 10 0');
    // Previous c2 was (5,5) and the shared anchor is (5,0), so the reflected
    // first control of the second segment must be (5,-5).
    expect(sp[0].nodes[1].hOut).toEqual([5, -5]);
  });

  it('treats S with no preceding cubic as starting from the current point', () => {
    const sp = parsePath('M0 0 S5 5 10 0');
    expect(sp[0].nodes[0].hOut).toEqual([0, 0]);
  });

  it('elevates Q to an equivalent cubic', () => {
    const sp = parsePath('M0 0 Q5 10 10 0');
    // c1 = p0 + 2/3 (q - p0), c2 = p2 + 2/3 (q - p2)
    expect(sp[0].nodes[0].hOut![0]).toBeCloseTo(10 / 3, 12);
    expect(sp[0].nodes[0].hOut![1]).toBeCloseTo(20 / 3, 12);
    expect(sp[0].nodes[1].hIn![0]).toBeCloseTo(20 / 3, 12);
    expect(sp[0].nodes[1].hIn![1]).toBeCloseTo(20 / 3, 12);
  });

  it('reflects T off the preceding quadratic', () => {
    const a = parsePath('M0 0 Q5 10 10 0 T20 0');
    const b = parsePath('M0 0 Q5 10 10 0 Q15 -10 20 0');
    expect(maxDeviation(a, b)).toBeLessThan(1e-9);
  });

  it('handles relative commands', () => {
    const a = parsePath('m10 10 l10 0 l0 10 z');
    const b = parsePath('M10 10 L20 10 L20 20 Z');
    expect(maxDeviation(a, b)).toBeLessThan(1e-9);
  });

  it('starts a new subpath at the origin after Z', () => {
    const sp = parsePath('M5 5 L10 5 Z L20 20');
    expect(sp).toHaveLength(2);
    expect(sp[1].nodes[0].pt).toEqual([5, 5]);
  });
});

describe('arcs', () => {
  it('approximates a unit circle to better than 3e-4', () => {
    // Two half-arcs forming a unit circle centred at the origin.
    const sp = parsePath('M-1 0 A1 1 0 0 1 1 0 A1 1 0 0 1 -1 0 Z');
    let worst = 0;
    for (const p of samplePath(sp, 64)) {
      worst = Math.max(worst, Math.abs(Math.hypot(p[0], p[1]) - 1));
    }
    expect(worst).toBeLessThan(3e-4);
  });

  it('splits a large-arc sweep into multiple cubics', () => {
    const sp = parsePath('M-1 0 A1 1 0 1 1 1 0');
    // A 180 degree sweep needs two <=90 degree cubics.
    expect(segmentCount(sp[0])).toBe(2);
  });

  it('honours the sweep flag', () => {
    const up = samplePath(parsePath('M-1 0 A1 1 0 0 1 1 0'), 8);
    const down = samplePath(parsePath('M-1 0 A1 1 0 0 0 1 0'), 8);
    const midUp = up[Math.floor(up.length / 2)];
    const midDown = down[Math.floor(down.length / 2)];
    expect(Math.sign(midUp[1])).toBe(-Math.sign(midDown[1]));
  });

  it('scales up radii that are too small to span the endpoints', () => {
    // rx=ry=1 cannot reach from (0,0) to (10,0); the spec says grow them.
    const sp = parsePath('M0 0 A1 1 0 0 1 10 0');
    const pts = samplePath(sp, 16);
    expect(pts[pts.length - 1][0]).toBeCloseTo(10, 6);
    expect(pts[pts.length - 1][1]).toBeCloseTo(0, 6);
  });

  it('drops an arc whose endpoints coincide', () => {
    const sp = parsePath('M5 5 A1 1 0 0 1 5 5');
    expect(sp).toHaveLength(0);
  });

  it('treats a zero radius as a straight line', () => {
    const sp = parsePath('M0 0 A0 0 0 0 1 10 0');
    expect(segmentCount(sp[0])).toBe(1);
    expect(sp[0].nodes[0].hOut).toBeNull();
  });
});

describe('serialiser', () => {
  const roundTrip = (d: string, opts = {}): string => serialisePath(parsePath(d), opts);

  it('emits L for straight segments', () => {
    expect(roundTrip('M0 0 L10 5')).toBe('M 0 0 L 10 5');
  });

  it('degrades axis-aligned lines to H and V', () => {
    expect(roundTrip('M0 0 L10 0 L10 10')).toBe('M 0 0 H 10 V 10');
  });

  it('omits the closing line, leaving it to Z', () => {
    expect(roundTrip('M0 0 L10 0 L5 10 Z')).toBe('M 0 0 H 10 L 5 10 Z');
  });

  it('recovers Q from an elevated cubic', () => {
    expect(roundTrip('M0 0 Q5 10 10 0')).toBe('M 0 0 Q 5 10 10 0');
  });

  it('recovers S when the control mirrors its predecessor', () => {
    expect(roundTrip('M0 0 C0 5 5 5 5 0 S10 -5 10 0')).toBe('M 0 0 C 0 5 5 5 5 0 S 10 -5 10 0');
  });

  it('falls back to C when no shorthand is exact', () => {
    expect(roundTrip('M0 0 C1 9 9 9 10 0')).toBe('M 0 0 C 1 9 9 9 10 0');
  });

  it('can be told not to use shorthands', () => {
    expect(roundTrip('M0 0 Q5 10 10 0', { shorthands: false })).toBe(
      'M 0 0 C 3.333 6.667 6.667 6.667 10 0',
    );
  });

  it('round-trips geometry through parse -> serialise -> parse', () => {
    const cases = [
      'M0 0 L10 0 L10 10 L0 10 Z',
      'M0 0 C0 5 10 5 10 0 S20 -5 20 0',
      'M0 0 Q5 10 10 0 T20 0',
      'M-1 0 A1 1 0 0 1 1 0 A1 1 0 0 1 -1 0 Z',
      'm10 10 l10 0 l0 10 z m20 20 l5 5',
      'M0 0 H10 V10 H0 Z',
      'M0 0 A5 3 45 1 0 10 10 L20 20 Z',
    ];
    for (const d of cases) {
      const first = parsePath(d);
      const again = parsePath(serialisePath(first, { decimals: 9 }));
      expect(maxDeviation(first, again), d).toBeLessThan(1e-7);
    }
  });

  it('minifies without changing geometry', () => {
    const d = 'M0 0 C0 5 10 5 10 0 S20 -5 20 0 L30 0 Z';
    const full = parsePath(d);
    const min = serialisePath(full, { minify: true, decimals: 6 });
    expect(maxDeviation(full, parsePath(min))).toBeLessThan(1e-5);
    expect(min.length).toBeLessThan(serialisePath(full, { decimals: 6 }).length);
  });

  it('strips leading zeros and elides an implied lineto when minifying', () => {
    // `M` followed by another coordinate pair is an implicit `L`, so the letter
    // goes; `.5.5` is unambiguous because the greedy number match stops at the
    // second `.`.
    const min = serialisePath(parsePath('M0.5 0.5 L0.25 -0.75'), { minify: true });
    expect(min).toBe('M.5.5.25-.75');
    // Whatever we elide must still parse back to the same geometry.
    expect(maxDeviation(parsePath('M0.5 0.5 L0.25 -0.75'), parsePath(min))).toBeLessThan(1e-9);
  });

  it('keeps a separator where tokens would otherwise merge', () => {
    // `1` then `.5` must not become `1.5`.
    const min = serialisePath(parsePath('M1 0.5 L2 0.25'), { minify: true });
    expect(maxDeviation(parsePath('M1 0.5 L2 0.25'), parsePath(min))).toBeLessThan(1e-9);
  });

  it('does not drift along a long path of relative commands', () => {
    // 2000 segments at coarse precision: naive relative output banks a rounding
    // error per command and walks away from the true position.
    let d = 'M0 0';
    for (let i = 1; i <= 2000; i++) d += ` L${(i * 0.017).toFixed(6)} ${(i * 0.013).toFixed(6)}`;
    const ideal = parsePath(d);
    const min = serialisePath(ideal, { minify: true, decimals: 2 });
    const back = parsePath(min);
    // Every point must stay within half a grid step of where it belongs.
    expect(maxDeviation(ideal, back)).toBeLessThan(0.01);
  });
});

describe('number formatting', () => {
  it('drops trailing zeros', () => {
    expect(serialisePath(parsePath('M1.500 2.000 L3 4'))).toBe('M 1.5 2 L 3 4');
  });

  it('never emits negative zero', () => {
    expect(formatNumber(-0.0001, 2)).toBe('0');
    expect(formatNumber(-0, 3)).toBe('0');
  });

  it('collapses to V when rounding makes x equal', () => {
    // At 2 decimals, x = -0.0001 rounds to 0, matching the current point, so
    // the shorter spelling is correct rather than a bug.
    expect(serialisePath(parsePath('M0 0 L-0.0001 5'), { decimals: 2 })).toBe('M 0 0 V 5');
  });
});
