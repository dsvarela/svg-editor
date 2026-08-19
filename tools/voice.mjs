#!/usr/bin/env node
/**
 * Refuse an engine's own exception text in a string a person reads.
 *
 * `docs/STYLE.md` governs the status line, and a browser's exception message is
 * not written to it: it differs by engine, it is not a sentence, and it names
 * internals. The rule was recorded in ARCHITECTURE §53 when one such message
 * was rewritten, and four more were sitting in the same file at the time --
 * which is the argument for a check rather than a fifth rewrite.
 *
 * Deliberately narrow. It looks for a thrown value reaching a user-facing call,
 * not for every mention of an error: `reasonFor` in `main.ts` is the one place
 * allowed to read an exception, and it only ever reads this project's own.
 *
 * Exits 1 on a hit, so CI fails rather than printing something nobody reads.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where an exception's text may be read.
 */
const ALLOWED = new Set([
  'src/core/parse.ts',
  /* A `postMessage` payload is a data channel, not a sentence. The worker packs
     its reason so the main thread can put it on the console, where a developer
     and the browser harness both look; what a person reads is written at the
     call site. */
  'src/model/trace.worker.ts',
]);

/** Every `.ts` file under a directory. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const hits = [];
for (const file of walk('src')) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.trimStart();
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
    /* Read anywhere, not only on a line that also calls `say`. The sink is
       usually somewhere else: `const msg = (err as Error).message` and a
       `say(msg)` four lines down is how four of these were written, and a
       line-scoped check saw none of them. */
    const reads =
      /\b(err|error)\b[^;]*\.message\b/.test(code) ||
      /String\(\s*(err|error)\b/.test(code) ||
      /\$\{\s*(err|error)\s*\}/.test(code);
    if (!reads) return;
    if (ALLOWED.has(file)) return;
    hits.push(`${file}:${i + 1}  ${code}`);
  });
}

for (const hit of hits) console.error(`an exception's own text, unguarded: ${hit}`);
console.log(
  `${hits.length} place${hits.length === 1 ? '' : 's'} read an exception's text outside ` +
    `${[...ALLOWED].join(' and ')}.`,
);
if (hits.length) process.exitCode = 1;
