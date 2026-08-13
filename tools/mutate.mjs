/**
 * Break the source on purpose and report what the suite still calls green.
 *
 * A passing test proves the code passes the test. It does not prove the test
 * would notice the code being wrong, and the difference is invisible until
 * something ships broken. This edits one character of meaning at a time --
 * a `<` into a `<=`, an `&&` into an `||`, a returned `true` into `false` --
 * runs the tests that import the file, and puts the edit back.
 *
 * A mutation the suite catches says nothing. A SURVIVOR is the finding: a
 * change to what the program does that every test agreed with.
 *
 * Not every survivor is a missing test. Some mutations do not change behaviour
 * at all -- a clamp whose bound is unreachable, a guard the caller already
 * ensures -- and those are equivalent mutants, not gaps. Read each one and
 * decide; the tool cannot.
 *
 *   node tools/mutate.mjs src/model/knots.ts
 *   node tools/mutate.mjs src/core --limit 40
 *   node tools/mutate.mjs src --from 200 --limit 100
 *
 * `--from` and `--limit` cut the site list, which is in file and line order and
 * does not move between runs, so a long sweep can be taken in pieces.
 *
 * **Not at the same time as `drive.mjs`.** The mutation is in the working tree
 * while the tests run, and the dev server serves that same tree, so a browser
 * scenario running alongside a sweep loads whichever mutation is live and
 * fails on it. Run one, then the other.
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : Number(args[i + 1]);
};
const from = flag('--from', 0);
const limit = flag('--limit', Infinity);
const targets = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!targets.length) {
  console.error('usage: node tools/mutate.mjs <file or directory> [--from N] [--limit N]');
  process.exit(1);
}

/**
 * What a mutation looks like.
 *
 * Each is a swap between two spellings that both compile and mean different
 * things. Boundaries (`<` against `<=`) and the two boolean operators are here
 * because an off-by-one and a wrong connective are the two mistakes that most
 * often survive a suite: the output moves for some inputs and not for the ones
 * a fixture happens to use.
 *
 * The lookarounds keep the single-character rules off the operators that
 * contain them: `=>`, `>=`, `<=`, `++`, `--` and `->`. A swap that does not
 * parse costs a wasted run rather than a false finding, since a file vitest
 * cannot load fails the suite and scores as caught.
 */
const RULES = [
  { find: /(?<![<>=!])<(?![<=])/g, to: '<=' },
  { find: /(?<![<>=!])>(?![>=])/g, to: '>=' },
  { find: /<=/g, to: '<' },
  { find: />=/g, to: '>' },
  { find: /(?<![&])&&(?![&])/g, to: '||' },
  { find: /(?<![|])\|\|(?![|])/g, to: '&&' },
  { find: /(?<![=!<>])===(?!=)/g, to: '!==' },
  { find: /(?<![=!<>])!==(?!=)/g, to: '===' },
  { find: /\breturn true\b/g, to: 'return false' },
  { find: /\breturn false\b/g, to: 'return true' },
  { find: /(?<![+\w])\+(?![+=])/g, to: '-' },
  { find: /(?<![-\w])-(?![-=>])/g, to: '+' },
];

/** Source files worth breaking: the shipped tree, minus what has no logic. */
function sources(path) {
  const st = statSync(path);
  if (st.isFile()) return path.endsWith('.ts') ? [path] : [];
  return readdirSync(path).flatMap((e) => sources(join(path, e)));
}

/**
 * Lines a mutation may not touch.
 *
 * A comment is not code, and a swap inside one is always a survivor, which
 * would bury the real findings in noise. Whole-line detection only: a `//`
 * inside a string literal costs one skipped line, and missing a mutation is
 * cheaper here than reporting a false one.
 */
const isProse = (line) => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

const files = targets.flatMap(sources).filter((f) => !f.endsWith('.d.ts'));

/** Every place a rule matches, in file and then line order. */
const sites = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, n) => {
    if (isProse(line)) return;
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.find)) {
        sites.push({ file, line: n, col: m.index, was: m[0], now: rule.to });
      }
    }
  });
}

const chosen = sites.slice(from, from === 0 && limit === Infinity ? undefined : from + limit);
console.log(`${sites.length} sites across ${files.length} files; running ${chosen.length}`);

/** Run the tests that import `file`. Returns the exit code and what was said. */
function runSuite(file) {
  const run = spawnSync('npx', ['vitest', 'related', '--run', relative(process.cwd(), file)], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

const reported = (output) => /Test Files\s+\d/.test(output);

/**
 * Did the suite notice?
 *
 * An exit code alone cannot answer this. Vitest exits 1 for a failing test and
 * also for a command line it could not parse, so scoring on the code alone
 * reads the tool's own misuse as every mutation being caught, and reports a
 * clean sweep having measured nothing. The baseline below settles that once:
 * after an unmutated run has produced a summary, the invocation is known good,
 * and a later run that produces none was stopped by the mutation. A mutation
 * that will not parse is caught, and emphatically so.
 */
function suiteCatches(file) {
  const { status, output } = runSuite(file);
  return status !== 0 || !reported(output);
}

/* An unmutated run first, which settles two things at once: that the command
   line is one vitest accepts, and that the tree is green. Either being false
   scores every mutation as caught and reports perfect coverage of a suite that
   measured nothing. */
if (chosen.length) {
  const base = runSuite(chosen[0].file);
  if (!reported(base.output)) {
    console.error(`vitest ran no tests before any mutation:\n${base.output.slice(-1500)}`);
    process.exit(1);
  }
  if (base.status !== 0) {
    console.error('the suite is already failing; fix that before reading anything here');
    process.exit(1);
  }
}

const survivors = [];
let done = 0;

/* The mutation lives in the working tree while the tests run, so an interrupt
   between writing it and putting it back would leave a broken file behind and
   the damage would look like something a person typed. */
let live = null;
const putBack = () => {
  if (live) writeFileSync(live.file, live.original);
  live = null;
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    putBack();
    process.exit(1);
  });
}

for (const site of chosen) {
  const original = readFileSync(site.file, 'utf8');
  const lines = original.split('\n');
  const line = lines[site.line];
  lines[site.line] = line.slice(0, site.col) + site.now + line.slice(site.col + site.was.length);
  live = { file: site.file, original };
  writeFileSync(site.file, lines.join('\n'));
  let caught;
  try {
    caught = suiteCatches(site.file);
  } finally {
    putBack();
  }
  done++;
  if (!caught) {
    survivors.push(site);
    console.log(`SURVIVED  ${site.file}:${site.line + 1}  ${site.was} -> ${site.now}`);
    console.log(`          ${line.trim().slice(0, 100)}`);
  }
  if (done % 10 === 0) console.log(`  ... ${done}/${chosen.length}, ${survivors.length} survivors`);
}

console.log(`\n${survivors.length} survived of ${chosen.length}.`);
if (survivors.length) {
  console.log('Each is a change to what the program does that no test disagreed with.');
}
