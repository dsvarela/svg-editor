import { describe, expect, it } from 'vitest';
/* `?raw` rather than `node:fs`, so the sources arrive through the bundler the
   rest of the suite already runs under and the project stays free of Node type
   definitions it otherwise has no use for. */
import src from '../src/main.ts?raw';
import css from '../src/ui/styles.css?raw';
import html from '../index.html?raw';

/* Three status messages were written with `class="st warn"` against a
   stylesheet that defines `.st.err` and `.st.ok` and nothing else, so they
   rendered in the strip's default ink and said nothing by colour. Nothing
   failed: an unmatched class is silent in CSS and invisible to the type
   checker. This reads both files and compares the two lists, which is the only
   place the mismatch is detectable before someone looks at the screen.
   `st` carries a font utility as well as a tone, so a class counts as defined
   whether the stylesheet names it under `.st` or on its own. */

/** Every class written beside `st`, from anywhere it can be written. */
function classesWritten(): Set<string> {
  const found = new Set<string>();
  for (const [, rest] of src.matchAll(/'st ([\w -]+)'/g)) {
    for (const c of rest.trim().split(/\s+/)) found.add(c);
  }
  for (const [, rest] of html.matchAll(/class="st ([\w -]+)"/g)) {
    for (const c of rest.trim().split(/\s+/)) found.add(c);
  }
  return found;
}

/**
 * Classes a `class="st ..."` element can actually match.
 *
 * Only two forms qualify: a rule scoped to `.st`, and a rule on the class
 * alone. A class defined only in some other compound does not count, and
 * insisting on that is the whole point -- the stylesheet holds `.gval.warn`,
 * so a rule that accepted a class defined anywhere would have passed the bug
 * this file exists to catch.
 */
const defined = new Set([
  ...[...css.matchAll(/\.st\.([\w-]+)/g)].map((m) => m[1]),
  ...[...css.matchAll(/(?:^|[\s,>+~{])\.([a-zA-Z][\w-]*)(?![\w-]*\.)/gm)].map((m) => m[1]),
]);

describe('the status line writes classes the stylesheet defines', () => {
  it('has a rule for every class', () => {
    expect([...classesWritten()].filter((c) => !defined.has(c))).toEqual([]);
  });

  it('reads both files, so an empty list cannot pass this file', () => {
    expect([...classesWritten()].sort()).toEqual(['err', 'mono', 'ok']);
  });

  it('does not accept a class defined only inside another compound', () => {
    expect(css).toContain('.gval.warn');
    expect(defined.has('warn')).toBe(false);
  });
});
