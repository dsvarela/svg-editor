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
 * `--apply N` makes mutation N and stops, which is how a survivor gets read.
 * The report says a test did not disagree; it cannot say whether anything
 * changed, and only one of those is a missing test. Put the file back with
 * `git checkout` when you have looked.
 *
 * **Not at the same time as `drive.mjs`.** The mutation is in the working tree
 * while the tests run, and the dev server serves that same tree, so a browser
 * scenario running alongside a sweep loads whichever mutation is live and
 * fails on it. Run one, then the other.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : Number(args[i + 1]);
};
const from = flag('--from', 0);
const limit = flag('--limit', Infinity);

/**
 * Which tests get to disagree with a mutation.
 *
 * By default the ones that import the mutated file, which is the honest
 * question: would this project's suite notice? Naming test files instead asks
 * a narrower one -- would THESE notice -- and a survivor then means only that
 * they did not, which is worth knowing when the file under review has a suite
 * of its own. It is also the difference between minutes and hours, because
 * `related` pulls in every slow neighbour on every single mutation.
 */
const testsIdx = args.indexOf('--tests');
const only = testsIdx >= 0 ? args[testsIdx + 1].split(',') : null;
/* The value that follows a flag is not a target. Taken only where the flag is
   actually present: `indexOf` returns -1 for a missing one, and reading the
   element after that is the first argument, which is the target itself. */
const flagValues = new Set(
  ['--from', '--limit', '--tests', '--apply']
    .map((f) => args.indexOf(f))
    .filter((i) => i >= 0)
    .map((i) => args[i + 1]),
);
const targets = args.filter((a) => !a.startsWith('--') && !flagValues.has(a));
if (!targets.length) {
  console.error(
    'usage: node tools/mutate.mjs <file or directory> [--from N] [--limit N] [--tests a,b]',
  );
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
console.log(
  `${sites.length} sites across ${files.length} files; running ${chosen.length}` +
    (only ? `, against ${only.join(' ')} only` : ''),
);

/* `--limit 0` lists rather than runs, which is how a caller finds the index of
   the region it wants and turns it into a `--from`. The order is stable, so an
   index means the same thing on the next run. */
if (!chosen.length) {
  sites.forEach((s, i) => console.log(`${i}\t${s.file}:${s.line + 1}\t${s.was} -> ${s.now}`));
  process.exit(0);
}

/** Run the tests that may disagree with a mutation in `file`. */
function runSuite(file) {
  const argv = only ? ['vitest', 'run', ...only] : ['vitest', 'related', '--run', relative(process.cwd(), file)];
  const run = spawnSync('npx', argv, { encoding: 'utf8', timeout: 180_000 });
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
/**
 * Put the file back even if this process never gets to.
 *
 * The mutation lives in the working tree while the tests run, so a sweep that
 * dies mid-run leaves a broken source file behind, and the damage reads as
 * something a person typed. A signal handler is not enough on its own: the
 * test run is synchronous, so the event loop is blocked for all but a sliver
 * of each iteration and a signal arriving during one is never delivered --
 * which is how `offset.ts` came back from an interrupted sweep with a `-`
 * turned into a `+`.
 *
 * So the original is on disk before the mutation is, and the next run restores
 * from it. That survives a kill this process cannot catch at all.
 */
const PENDING = join(tmpdir(), 'svg-editor-mutate-pending.json');
if (existsSync(PENDING)) {
  const held = JSON.parse(readFileSync(PENDING, 'utf8'));
  /* Still running means this is a second sweep, not a crashed one, and two of
     them share one working tree: each would read the other's mutation as the
     file it is about to restore, and the survivors of both would be nonsense.
     `process.kill(pid, 0)` asks whether a process is there without signalling
     it. */
  let running = false;
  try {
    process.kill(held.pid, 0);
    running = true;
  } catch {
    running = false;
  }
  if (running) {
    console.error(`another sweep is running (pid ${held.pid}); one working tree, one sweep`);
    process.exit(1);
  }
  writeFileSync(held.file, held.original);
  rmSync(PENDING);
  console.log(`put back ${held.file}, left mutated by an earlier run`);
}


/**
 * Make one mutation, recording what it replaced.
 *
 * The record goes to disk before the file does, so an interrupted run is put
 * back by the next one -- see the PENDING block above. `--apply` and the sweep
 * both come through here, which is what keeps a hand-applied mutation under the
 * same safety net as a swept one.
 */
function mutate(site) {
  const original = readFileSync(site.file, 'utf8');
  const lines = original.split('\n');
  const line = lines[site.line];
  lines[site.line] = line.slice(0, site.col) + site.now + line.slice(site.col + site.was.length);
  writeFileSync(PENDING, JSON.stringify({ file: site.file, original, pid: process.pid }));
  writeFileSync(site.file, lines.join('\n'));
  return { file: site.file, original, line };
}

/* One mutation, left in the tree for a person to look at. A survivor says no
   test disagreed, which is two different findings wearing one word: a missing
   test, or a mutation that changed nothing to disagree with. Reading the code
   rarely settles which; running the thing does. */
const applyIdx = flag('--apply', -1);
if (applyIdx >= 0) {
  const site = sites[applyIdx];
  if (!site) {
    console.error(`no site ${applyIdx}; there are ${sites.length}`);
    process.exit(1);
  }
  const { line } = mutate(site);
  console.log(`${site.file}:${site.line + 1}  ${site.was} -> ${site.now}\n  ${line.trim()}`);
  process.exit(0);
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


let live = null;
const putBack = () => {
  if (live) {
    writeFileSync(live.file, live.original);
    if (existsSync(PENDING)) rmSync(PENDING);
  }
  live = null;
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    putBack();
    process.exit(1);
  });
}

/* Numbered, because the number is what a reader does something with: a survivor
   is a question -- missing test, or nothing to disagree with -- and `--apply`
   answers it. Without it, two identical mutations on one line report the same
   two words and neither can be told from the other. */
for (const [k, site] of chosen.entries()) {
  const index = from + k;
  const { original, line } = mutate(site);
  live = { file: site.file, original };
  let caught;
  try {
    caught = suiteCatches(site.file);
  } finally {
    putBack();
  }
  done++;
  if (!caught) {
    survivors.push(site);
    console.log(`SURVIVED  ${index}\t${site.file}:${site.line + 1}  ${site.was} -> ${site.now}`);
    console.log(`          ${line.trim().slice(0, 100)}`);
  }
  if (done % 10 === 0) console.log(`  ... ${done}/${chosen.length}, ${survivors.length} survivors`);
}

console.log(`\n${survivors.length} survived of ${chosen.length}.`);
if (survivors.length) {
  console.log('Each is a change to what the program does that no test disagreed with.');
  console.log(`Read one with: node tools/mutate.mjs ${targets[0]} --apply <number>`);
}
