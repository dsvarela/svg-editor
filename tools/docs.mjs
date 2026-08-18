#!/usr/bin/env node
/**
 * The checks on the documentation that a machine can settle.
 *
 * Two of them: the tell sweep from `docs/STYLE.md`, and every link in the docs
 * tree.
 *
 * **Errors** exit non-zero and need no judgement: a link resolves or it does
 * not. **Warnings** need a person, because every banned word has a legitimate
 * sense, and failing the build on those trains everyone to pass `--force`.
 *
 * **The word list is parsed out of STYLE.md**, the document people read; a copy
 * here drifted within the hour. An empty parse is a hard failure, since
 * reformatting that section breaks it.
 *
 * Not checked: the status-line rules, which need the call graph, and external
 * URLs, because a checker that makes network calls fails on a train.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/**
 * Text a user reads, per STYLE.md's scope section.
 *
 * `docs/ARCHITECTURE.md`, `docs/reviews/` and `docs/SHOPPING-LIST.md` are
 * exempt from the em-dash rule and say so in STYLE.md, so they are not walked.
 * Source files are here for their string literals; comments are developer text
 * and are stripped before the check.
 */
const SCOPE = ['README.md', 'index.html', 'docs/README.md', 'docs/STYLE.md', 'docs/manual', 'src'];

const STYLE = 'docs/STYLE.md';

/**
 * The banned vocabulary, taken from STYLE.md's "Vocabulary" bullets.
 *
 * Each bullet is `- Category: word, word, phrase.`, so the category is dropped
 * and the rest split on commas. Quoted entries are chatbot phrases and keep
 * their internal punctuation.
 */
function bannedFromStyle() {
  const lines = read(STYLE).split('\n');
  const start = lines.findIndex((l) => l.startsWith('**Vocabulary**'));
  if (start < 0) return [];
  const words = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('**')) break; // the next subheading ends the section
    const m = /^- [^:]+:\s*(.+)$/.exec(line);
    if (!m) continue;
    for (const raw of m[1].split(',')) {
      const w = raw.trim().replace(/[.”"“]/g, '').replace(/^'|'$/g, '');
      if (w) words.push(w);
    }
  }
  return words;
}

/**
 * The "Never" column of STYLE.md's terminology table, checked in the manual.
 *
 * `path data` is matched in lower case only, and never on a line naming the
 * **Path data** button. The concept is the source; the control that switches
 * between the two source formats is called Path data because that is what it
 * says on screen, and the manual has to use the name the reader can see.
 */
const WRONG_TERM = {
  'control point': 'handle',
  vertex: 'node',
  'anchor point': 'node',
  subpath: 'path',
  contour: 'path',
  'rubber band': 'marquee',
  'box select': 'marquee',
};

function walk(path) {
  if (!statSync(join(ROOT, path)).isDirectory()) return [path];
  return readdirSync(join(ROOT, path)).flatMap((name) => walk(join(path, name)));
}

/** Comments are developer text. Strip them so only code and literals remain. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BANNED = bannedFromStyle();
if (!BANNED.length) {
  console.error(`Found no vocabulary list in ${STYLE}. Its "**Vocabulary**" section moved or changed shape.`);
  process.exit(2);
}

const files = SCOPE.flatMap(walk).filter((f) => /\.(md|html|ts|css)$/.test(f));

let errors = 0;
let warnings = 0;
const say = (kind, at, what, line) => {
  console.log(`${kind.padEnd(6)} ${at}  ${what}\n       ${line.trim()}`);
  if (kind === 'error') errors++;
  else warnings++;
};

for (const file of files) {
  const code = /\.(ts|css)$/.test(file);
  const raw = read(file);
  const lines = (code ? stripComments(raw) : raw).split('\n');
  const isManual = file.startsWith('docs/manual');
  // STYLE.md states the banned words, and a statement of a rule is not a breach
  // of it. It stays in scope for every other check.
  const definesTheWords = file === STYLE;

  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`;

    if (line.includes('—')) say('error', at, 'em-dash', line);

    // Prose rules stop at the source boundary. A variable named `justify` is not
    // a filler intensifier, and neither is a CSS property.
    if (code) return;

    if (!definesTheWords) {
      for (const word of BANNED) {
        if (new RegExp(`\\b${escape(word)}\\b`, 'i').test(line)) say('warn', at, `"${word}"`, line);
      }
    }

    if (!isManual) return;
    for (const [wrong, right] of Object.entries(WRONG_TERM)) {
      if (new RegExp(`\\b${escape(wrong)}\\b`, 'i').test(line)) {
        say('warn', at, `"${wrong}" should be "${right}"`, line);
      }
    }
    if (/\bpath data\b/.test(line) && !line.includes('**Path data**')) {
      say('warn', at, '"path data" should be "source" unless it names the button', line);
    }
  });
}

/* ---- Links ------------------------------------------------------------- */

/**
 * Every markdown file in the repository, including the ones exempt from the
 * style rules. A dead link in `ARCHITECTURE.md` is still dead.
 */
const MARKDOWN = ['README.md', 'CLAUDE.md', 'docs'].flatMap(walk).filter((f) => f.endsWith('.md'));

/** GitHub's heading slug: lower case, punctuation dropped, spaces hyphenated. */
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');

const anchors = new Map();
function anchorsIn(file) {
  if (!anchors.has(file)) {
    const found = new Set();
    for (const line of read(file).split('\n')) {
      const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (m) found.add(slug(m[1]));
    }
    anchors.set(file, found);
  }
  return anchors.get(file);
}

let links = 0;
for (const file of MARKDOWN) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?|mailto):/.test(target)) continue;
        links++;
        const [path, anchor] = target.split('#');
        const to = path ? normalize(join(dirname(file), path)) : file;
        const at = `${file}:${i + 1}`;
        if (!existsSync(join(ROOT, to))) {
          say('error', at, `broken link to ${target}`, line);
          continue;
        }
        // A directory link resolves to the directory. Only markdown has anchors.
        if (anchor && to.endsWith('.md') && !anchorsIn(to).has(anchor)) {
          say('error', at, `no heading "#${anchor}" in ${to}`, line);
        }
      }
    });
}

/* ---- Section citations -------------------------------------------------- */

/**
 * `ARCHITECTURE.md`'s numbered sections are cited as `§26` from code comments
 * and from every other document. That is a cross-reference system with no
 * mechanism behind it: inserting a section renumbers the ones after it and
 * every citation silently starts pointing one section early. Nothing else in
 * the repository would notice.
 */
const SECTIONS = new Set(
  read('docs/ARCHITECTURE.md')
    .split('\n')
    .flatMap((l) => {
      const m = /^## (\d+)\. /.exec(l);
      return m ? [Number(m[1])] : [];
    }),
);

let citations = 0;
for (const file of [...MARKDOWN, ...files.filter((f) => /\.(ts|css|html)$/.test(f))]) {
  read(file)
    .split('\n')
    .forEach((line, i) => {
      for (const m of line.matchAll(/§ ?(\d+)/g)) {
        citations++;
        if (!SECTIONS.has(Number(m[1]))) {
          say('error', `${file}:${i + 1}`, `ARCHITECTURE.md has no §${m[1]}`, line);
        }
      }
    });
}

console.log(
  `\n${files.length} files swept, ${BANNED.length} banned words, ` +
    `${links} links across ${MARKDOWN.length} documents, ` +
    `${citations} citations into ${SECTIONS.size} sections. ` +
    `${errors} error${errors === 1 ? '' : 's'}, ${warnings} to read.`,
);
if (errors) console.log('Errors block, warnings do not. The em-dash rule and its exemptions are in ' + STYLE + '.');
process.exit(errors ? 1 : 0);
