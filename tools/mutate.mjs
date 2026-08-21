/**
 * Break the source on purpose and report what the suite still calls green.
 *
 * A passing test proves the code passes the test, not that the test would
 * notice the code being wrong. This edits one character of meaning at a time,
 * runs the tests that import the file, and puts the edit back.
 *
 * **A survivor is the finding**: a change to what the program does that every
 * test agreed with. Not all are missing tests -- a clamp whose bound is
 * unreachable changes no behaviour -- so read each one.
 *
 *   node tools/mutate.mjs src --from 200 --limit 100
 *
 * `--from` and `--limit` cut the site list, which is in file and line order.
 * `--apply N` makes one mutation and stops; `git checkout` puts it back.
 *
 * **Not at the same time as `drive.mjs`**, which serves the same working tree.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

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

const USAGE = 'usage: node tools/mutate.mjs <file or directory> [--from N] [--limit N] [--tests a,b] [--apply N]';

/* A flag this does not know is refused, not dropped. It matters more here than
   anywhere else in this tree, because this is the one tool that rewrites the
   source: a mistyped flag was silently discarded, the target was still a target,
   and `--list` -- which does not exist, listing is `--limit 0` -- ran a full
   destructive sweep against a tree that had a browser sweep on it. The two
   damages are the ones the file header already warns about, reached by a typo
   rather than by a decision. */
const KNOWN = new Set(['--from', '--limit', '--tests', '--apply']);
const unknown = args.filter((a) => a.startsWith('--') && !KNOWN.has(a));
if (unknown.length) {
  console.error(`unknown flag: ${unknown.join(', ')}. To list the sites rather than run them, --limit 0.`);
  console.error(USAGE);
  process.exit(2);
}
if (!targets.length) {
  console.error(USAGE);
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
  { find: /(?<![<>=!])<(?![<=])/g, to: '<=', boundary: true },
  { find: /(?<![<>=!])>(?![>=])/g, to: '>=', boundary: true },
  { find: /<=/g, to: '<', boundary: true },
  { find: />=/g, to: '>', boundary: true },
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

/** What may precede a `/` that opens a regular expression rather than divides. */
const OPENS_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else',
  'yield', 'await',
]);

/**
 * Which columns of each line are comment, and may not be mutated.
 *
 * A swap inside a comment is always a survivor, which buries the real findings.
 *
 * **Strings, templates and regular expressions are tracked and deliberately not
 * returned.** Tracked because a comment cannot be found without them: `'/*'` is
 * two characters in a string, and a `/` opens a regular expression or divides
 * depending on the token before it. Not skipped because an operator inside one
 * is usually real logic -- a regular expression in a string is a program in a
 * small language. The argument is under "Testing philosophy" in
 * `docs/ARCHITECTURE.md`, and the measurement that refused the skip is in
 * `docs/reviews/2026-08-21b.md`.
 *
 * The interpolation of a template is code and so is the text around it; the
 * distinction only matters for finding a comment that may follow either.
 *
 * **A quote or a slash that does not close on its own line was never one**, so
 * the state is unwound at the newline. What that costs is a comment later on the
 * same line, which is one noise survivor somebody reads and discards.
 */
function commentCols(lines) {
  const cols = lines.map(() => new Set());
  const frames = [];
  let state = 'code';
  let depth = 0;
  let prevChar = '';
  let word = '';
  let inWord = false;
  let inClass = false;

  /* What a `/` here means turns on the token before it, so the last one is
     carried across lines: a regular expression may open on the line after the
     `=` that assigns it. */
  const toCode = (c) => {
    state = 'code';
    prevChar = c;
    word = '';
    inWord = false;
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const mark = (i) => cols[n].add(i);
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const next = line[i + 1] ?? '';

      if (state === 'code') {
        if (c === '/' && next === '/') {
          state = 'lineComment';
          mark(i);
          mark(i + 1);
          i++;
        } else if (c === '/' && next === '*') {
          state = 'block';
          mark(i);
          mark(i + 1);
          i++;
        } else if (c === '/' && (KEYWORDS_BEFORE_REGEX.has(word) || (!word && OPENS_REGEX.has(prevChar)))) {
          state = 'regex';
          inClass = false;
        } else if (c === "'" || c === '"') {
          state = c;
        } else if (c === '`') {
          frames.push(depth);
          state = 'template';
        } else if (c === '{') {
          depth++;
          prevChar = c;
          word = '';
          inWord = false;
        } else if (c === '}' && depth === 0 && frames.length) {
          state = 'template';
        } else if (/[\w$]/.test(c)) {
          word = inWord ? word + c : c;
          inWord = true;
          prevChar = c;
        } else if (/\s/.test(c)) {
          inWord = false;
        } else {
          if (c === '}') depth--;
          prevChar = c;
          word = '';
          inWord = false;
        }
        continue;
      }

      if (state === 'lineComment') {
        mark(i);
        continue;
      }
      if (state === 'block') {
        mark(i);
        if (c === '*' && next === '/') {
          mark(i + 1);
          i++;
          state = 'code';
        }
        continue;
      }
      /* Past here the state is a literal, whose columns are code as far as this
         is concerned. Only its END matters, because that is where a comment can
         start again. */
      if (c === '\\') {
        i++;
        continue;
      }
      if (state === "'" || state === '"') {
        if (c === state) toCode(c);
      } else if (state === 'regex') {
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) toCode(c);
      } else if (c === '`') {
        depth = frames.pop();
        toCode(c);
      } else if (c === '$' && next === '{') {
        i++;
        state = 'code';
        depth = 0;
        prevChar = '';
        word = '';
        inWord = false;
      }
    }

    if (state === 'lineComment') state = 'code';
    else if (state === "'" || state === '"' || state === 'regex') {
      state = 'code';
      prevChar = '';
      word = '';
      inWord = false;
    }
  }
  return cols;
}

/**
 * The columns of a line holding the `<` and `>` of a type argument.
 *
 * These are not operators, and a swap in one is always a survivor -- the same
 * reason a comment is skipped above, and the same cost: real survivors buried
 * in noise. `new Promise<Blob>(…)` mutated to `Promise<=Blob>` is not the
 * syntax error it looks like. esbuild reads it as `new Promise() <= Blob > (…)`,
 * which parses, so the file loads, nothing observable changes, and it scores as
 * a finding. About a third of this tree's angle brackets are type arguments.
 *
 * Paired by scanning rather than matched by a regular expression, because only
 * the pairing tells `Map<string, Pt[]>` from `a < b && c > d`. A `<` opens one
 * only when an identifier is immediately before it and a type may start
 * immediately after, which is what the spacing this repo is formatted with
 * gives every real comparison. A `;` ends a statement and drops anything still
 * open. Erring toward skipping is deliberate: missing a mutation is cheaper
 * here than reporting one that cannot be a finding.
 */
function typeArgumentCols(line) {
  const cols = new Set();
  const open = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const before = line[i - 1] ?? '';
    const after = line[i + 1] ?? '';
    if (c === '<' && /[A-Za-z0-9_$]/.test(before) && /[A-Za-z_$([{'"]/.test(after)) {
      open.push(i);
    } else if (c === '>' && open.length && before !== '=' && after !== '=') {
      cols.add(open.pop());
      cols.add(i);
    } else if (c === ';') {
      open.length = 0;
    }
  }
  return cols;
}

/**
 * Every name the tree binds to a float tolerance.
 *
 * A tolerance is declared as a literal with a negative exponent, which is what
 * makes it recognisable without a parser: `const SAME_PLACE = 1e-9`. Thirteen
 * names in this tree are one, and none of them is anything else.
 *
 * `INVISIBLE_MOVE` is a tolerance this misses, because it is arithmetic on
 * `PATH_DECIMALS` rather than a literal. Missing one costs a survivor somebody
 * reads and discards, which is the cost this whole idea is trying to lower
 * rather than a new one.
 */
function toleranceNames(root) {
  const names = new Set();
  if (!existsSync(root)) return names;
  const decl = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*-?\d[\d.]*[eE]-\d+\s*;/g;
  for (const file of sources(root)) {
    for (const m of readFileSync(file, 'utf8').matchAll(decl)) names.add(m[1]);
  }
  return names;
}

/**
 * The columns of a line holding an operator whose meaning turns on a float
 * tolerance, which can never be a finding. Skipped for the reason a comment is,
 * and argued under "Testing philosophy" in `docs/ARCHITECTURE.md`.
 *
 * A boundary reads its whole operand, because the bound is usually the epsilon
 * added to something. An additive operator reads only the token beside it: what
 * is skipped is the epsilon being added, not a sum that has one somewhere in it.
 */
function toleranceCols(line, tolerances) {
  const cols = new Set();
  const LIT = /-?\d[\d.]*[eE]-\d+/;
  const hasTol = (text) =>
    LIT.test(text) || [...text.matchAll(/[A-Za-z_$][\w$]*/g)].some((m) => tolerances.has(m[0]));

  /* Where an operand stops. A bracket that closes one this operand never opened
     ends it, which is what keeps `f(a < b)` from reading past the call. */
  const edge = (c) => c === '&' || c === '|' || c === '?' || c === ':' || c === ',' || c === ';';
  const operand = (from, step) => {
    let depth = 0;
    let j = from;
    for (; j >= 0 && j < line.length; j += step) {
      const c = line[j];
      const opens = step < 0 ? ')]}' : '([{';
      const closes = step < 0 ? '([{' : ')]}';
      if (opens.includes(c)) depth++;
      else if (closes.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (edge(c) || '<>=!'.includes(c))) break;
    }
    return step < 0 ? line.slice(j + 1, from + 1) : line.slice(from, j);
  };

  for (const m of line.matchAll(/<=|>=|<|>/g)) {
    if (hasTol(operand(m.index - 1, -1)) || hasTol(operand(m.index + m[0].length, 1))) {
      cols.add(m.index);
    }
  }

  const token = /-?\d[\d.]*(?:[eE][-+]?\d+)?|[A-Za-z_$][\w$]*/;
  for (const m of line.matchAll(/(?<![+\-\w])[+-](?![+\-=>])/g)) {
    const before = line.slice(0, m.index).match(new RegExp(`(${token.source})\\s*$`));
    const after = line.slice(m.index + 1).match(new RegExp(`^\\s*(${token.source})`));
    const tol = (t) => t !== undefined && (LIT.test(t) || tolerances.has(t));
    if (tol(before?.[1]) || tol(after?.[1])) cols.add(m.index);
  }
  return cols;
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
 *
 * **The record says what the file was AND what this tool wrote**, and the
 * restore happens only when the file still holds the second one. Without that
 * check the record is a claim about the tree that nothing keeps true: `--apply`
 * leaves one behind on purpose, and the `git checkout` that puts an applied
 * mutation back does not remove it. The next run then finds a record naming a
 * mutation that is no longer there and overwrites the file from a copy taken
 * before every edit made since. That is not a hypothetical: it ate the
 * `parseTransform` simplification in this session, an hour after the tool's own
 * sweep had pointed at it.
 */
/* Named after the working tree, not after the tool. One record for every
   checkout made this a lock on the machine rather than on the tree: two sweeps
   in two `git worktree` copies would each read the other's record, restore a
   file that belongs to neither, and refuse to start on the "another sweep is
   running" check that is meant to protect one tree. Per tree, that check still
   means what it says and the trees do not see each other. */
const PENDING = join(
  tmpdir(),
  `svg-editor-mutate-${createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12)}.json`,
);
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
  /* A record older than this check names no `mutated`, so nothing can prove the
     file still holds it. Dropped rather than acted on: refusing to restore
     costs one hand-reverted mutation, and restoring wrongly costs whatever was
     written since. */
  const onDisk = existsSync(held.file) ? readFileSync(held.file, 'utf8') : null;
  if (held.mutated === undefined || onDisk !== held.mutated) {
    rmSync(PENDING);
    console.log(
      `ignored a stale record for ${held.file}: it does not hold that mutation any more`,
    );
  } else {
    writeFileSync(held.file, held.original);
    rmSync(PENDING);
    console.log(`put back ${held.file}, left mutated by an earlier run`);
  }
}

/* Recovery runs before a single source file is read, and that ordering is the
   whole of what makes the site list mean anything. Built first, it is a list of
   offsets into a file this block is about to replace: the second `svg.ts` sweep
   in this session collected 161 sites from an edited file, restored a copy five
   lines shorter, and then mutated at every offset past the change in the wrong
   place. It reported 57 survivors and had measured nothing. */

const files = targets.flatMap(sources).filter((f) => !f.endsWith('.d.ts'));

/* Read from the whole of `src`, never from the target: a sweep aimed at one
   file still meets `SAME_PLACE`, which `src/core/types.ts` declares. */
const tolerances = toleranceNames('src');

/** Every place a rule matches, in file and then line order. */
const sites = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const prose = commentCols(lines);
  lines.forEach((line, n) => {
    const types = typeArgumentCols(line);
    const tol = toleranceCols(line, tolerances);
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.find)) {
        if (prose[n].has(m.index)) continue;
        if (types.has(m.index)) continue;
        if (tol.has(m.index)) continue;
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

/**
 * Run the tests that may disagree with a mutation in `file`.
 *
 * The local binary rather than `npx`. `spawnSync`'s timeout signals the process
 * it started, and through `npx` that is `npx`: it dies, vitest below it is
 * orphaned, and its fork workers keep running. One run that hung this way was
 * still holding two cores 26 minutes after its 180-second timeout, which is
 * long enough to skew everything measured afterwards -- the browser sweep that
 * followed failed `traceWorker` on a responsiveness bound and passed on a quiet
 * machine. Spawned directly, the signal reaches vitest, which tears its own
 * pool down.
 */
const VITEST = join('node_modules', '.bin', 'vitest');

function runSuite(file) {
  const argv = only ? ['run', ...only] : ['related', '--run', relative(process.cwd(), file)];
  const run = spawnSync(VITEST, argv, { encoding: 'utf8', timeout: 180_000 });
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
  const mutated = lines.join('\n');
  writeFileSync(
    PENDING,
    JSON.stringify({ file: site.file, original, mutated, pid: process.pid }),
  );
  writeFileSync(site.file, mutated);
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
