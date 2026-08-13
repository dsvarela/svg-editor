/**
 * The path cache must never answer with geometry the document no longer has.
 *
 * A stale `d` is the worst failure this file can have: the canvas would show a
 * shape that is not in the model, every readout would disagree with the screen,
 * and nothing would throw. So these tests are written the same way round as the
 * risk -- one asserts the cache is used at all, and every other one asserts it
 * is *not* used after some change, one kind of change at a time.
 */

import { describe, expect, it } from 'vitest';
import { PathCache } from '../src/view/pathcache';
import { makeNode } from '../src/core/types';
import type { Pt, Subpath } from '../src/core/types';

/**
 * An asymmetric open path of three nodes, the middle one straight on both sides.
 *
 * Three rather than two, because the first node's `hIn` and the last node's
 * `hOut` govern segments an open path does not have: changing them changes the
 * geometry and cannot change the `d`. That is a real distinction and it has its
 * own test below, but it makes for a confusing fixture everywhere else.
 */
const scene = (): Subpath[] => [
  {
    nodes: [
      { pt: [3, 7] as Pt, hIn: null, hOut: [5, 11] as Pt },
      { pt: [17, 23] as Pt, hIn: [13, 19] as Pt, hOut: null },
      { pt: [31, 5] as Pt, hIn: null, hOut: null },
    ],
    closed: false,
  },
];

describe('the path cache', () => {
  it('serialises once for repeated asks about unchanged geometry', () => {
    // The control the rest of the file is measured against: if the cache never
    // hit, every "and now it re-serialises" test below would pass on a cache
    // that had simply been disabled.
    const c = new PathCache();
    const sp = scene();
    const first = c.get('s1', sp);
    expect(c.get('s1', sp)).toBe(first);
    expect(c.get('s1', sp)).toBe(first);
    expect(c.misses).toBe(1);
    expect(c.hits).toBe(2);
  });

  /**
   * Each case mutates the model the way an edit does -- in place, keeping every
   * object identity -- because that is exactly the situation a cache keyed on
   * identity or on a revision flag would get wrong.
   */
  const changes: [string, (sp: Subpath[]) => void][] = [
    ['a node moves', (sp) => (sp[0].nodes[0].pt[0] = 4)],
    ['a node moves by a ten-thousandth', (sp) => (sp[0].nodes[1].pt[1] += 0.0001)],
    ['a handle moves', (sp) => (sp[0].nodes[1].hIn![0] = 12)],
    ['a handle appears', (sp) => (sp[0].nodes[1].hOut = [20, 20])],
    ['a handle is taken away', (sp) => (sp[0].nodes[1].hIn = null)],
    ['a node is added', (sp) => sp[0].nodes.push(makeNode([30, 40]))],
    ['a node is removed', (sp) => sp[0].nodes.pop()],
    ['the subpath closes', (sp) => (sp[0].closed = true)],
    ['a subpath is added', (sp) => sp.push({ nodes: [makeNode([1, 1]), makeNode([2, 9])], closed: false })],
    ['the subpaths swap places', (sp) => sp.reverse()],
  ];

  for (const [what, mutate] of changes) {
    it(`re-serialises when ${what}`, () => {
      const c = new PathCache();
      // A second, differently-shaped subpath, so reversing the order is a real
      // change rather than a no-op on a palindrome.
      const sp = [...scene(), { nodes: [makeNode([50, 1]), makeNode([60, 2])], closed: true }];
      const before = c.get('s1', sp);
      mutate(sp);
      const after = c.get('s1', sp);
      expect(c.misses, 'the cache answered from its own copy').toBe(2);
      expect(after).not.toBe(before);
    });
  }

  it('notices a change that path data cannot express, and says the same thing', () => {
    /* The first node's `hIn` belongs to the segment arriving at it, and an open
       path has none, so moving it is a real change to the model that no `d` can
       show. The cache re-serialises -- it compares geometry, not output -- and
       the answer is identical. Worth pinning: it is the one case where "the
       string did not change" is the correct result rather than a stale one. */
    const c = new PathCache();
    const sp = scene();
    const before = c.get('s1', sp);
    sp[0].nodes[0].hIn = [99, 99];
    const after = c.get('s1', sp);
    expect(c.misses).toBe(2);
    expect(after).toBe(before);
  });

  it('forgets a shape even when as many arrived as left', () => {
    /* Two entries in, two ids kept, and one of them is new: the sizes match and
       the contents do not. `keep` returning early on matching sizes leaves the
       departed shape's entry in the map for ever. Ids are not reused, so that is
       memory rather than staleness, and the shortcut saves only a walk over one
       entry per shape. */
    const c = new PathCache();
    c.get('a', scene());
    c.get('b', scene());
    c.keep(new Set(['a', 'c']));
    c.misses = 0;
    c.get('b', scene());
    expect(c.misses, "'b' was kept despite being gone from the document").toBe(1);
    c.misses = 0;
    c.get('a', scene());
    expect(c.misses, "'a' is still in the document and should still be cached").toBe(0);
  });

  it('re-serialises a shape whose entry was dropped', () => {
    const c = new PathCache();
    const sp = scene();
    c.get('a', sp);
    c.keep(new Set<string>());
    c.misses = 0;
    c.get('a', sp);
    expect(c.misses).toBe(1);
  });
});
