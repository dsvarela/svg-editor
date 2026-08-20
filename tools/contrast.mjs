#!/usr/bin/env node
/**
 * The one floor in `design` that is arithmetic. Rule 1, over a project's own
 * declared colours.
 *
 * **A copy, and it is here so the check can run.** The original lives in the
 * `handbook` repository beside this one, which is private, so CI has no copy of
 * it and the gate could not run at all: it failed on a missing file rather than
 * on a colour, which is a gate reporting nothing while looking like it reports
 * something. `tools/docs.mjs` is here for the same reason.
 *
 * What that costs is drift. A change to the handbook's version does not reach
 * this one, and nothing will say so. Copy it across when the handbook's
 * changes.
 *
 * ## What it reaches, and what it cannot
 *
 * A contrast ratio is decidable, so these are errors rather than warnings. What
 * is not decidable is which two colours a person actually sees together, and no
 * amount of parsing settles it: a token pair is only a pair because a layout put
 * them there. So the project says which pairs exist and what each one is, in a
 * ten-line file, and this computes the rest.
 *
 * That division is the whole design. A tool that guessed the pairs would report
 * every token against every other token, which on a 40-token palette is 1560
 * rows and no findings.
 *
 * ## The pairs file
 *
 * One pair per line: a foreground, the backgrounds it sits on, and what it is.
 * `#` comments and blank lines are ignored.
 *
 *     ink        panel, panel-2     text
 *     ink-3      panel              text
 *     accent     panel              boundary
 *     line-soft  panel              decoration
 *
 * | Role | Floor | What it means |
 * | --- | --- | --- |
 * | `text` | 4.5:1 | body text, WCAG 1.4.3 |
 * | `large` | 3:1 | 24 px, or 19 px bold and above |
 * | `boundary` | 3:1 | icons, borders, focus rings, chart lines, WCAG 1.4.11 |
 * | `decoration` | none | reported, never failed |
 *
 * `decoration` exists so a pair can be declared as deliberately exempt. A pair
 * nobody has classified is invisible to this tool, and a pair marked
 * `decoration` is a decision somebody wrote down.
 *
 * ## Themes
 *
 * A palette that has a dark mode has two answers per pair, and the second one is
 * where the failures hide, because it is the one nobody screenshots. Every block
 * that declares custom properties becomes a layer over the base, and each layer
 * is checked separately.
 *
 * ## What was tried and dropped
 *
 * Inferring the pairs from the stylesheet, by matching `color` and
 * `background-color` within one rule. It finds the pairs written literally in
 * one selector and misses every pair made by an element sitting inside another,
 * which is most of them. Reporting a tenth of the pairs while looking complete
 * is worse than reporting none.
 *
 * usage: contrast.mjs <tokens-file> <pairs-file>
 *        contrast.mjs src/ui/styles.css design-pairs.txt
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const [tokensPath, pairsPath] = argv;
/* Exactly two, and no flags. A third argument or a misspelled flag is refused
   rather than dropped: this takes no options, so anything else on the line is
   somebody expecting behaviour it does not have. */
const stray = argv.filter((a) => a.startsWith('-'));
if (stray.length) {
  console.error(`unknown flag: ${stray.join(', ')}. This takes no flags.`);
  console.error('usage: contrast.mjs <tokens-file> <pairs-file>');
  process.exit(2);
}
if (!tokensPath || !pairsPath || argv.length > 2) {
  console.error('usage: contrast.mjs <tokens-file> <pairs-file>');
  process.exit(2);
}

/* ---- colour ------------------------------------------------------------- */

/** `#abc`, `#aabbcc`, `#aabbccdd` and Dart's `0xFFAABBCC` all reach this. */
function parseColour(raw) {
  const s = String(raw).trim();
  let hex = null;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) hex = s.slice(1);
  else if (/^0x[0-9a-f]{8}$/i.test(s)) hex = s.slice(4); // Dart is AARRGGBB
  if (!hex) return null;
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  if (hex.length === 8) hex = hex.slice(0, 6); // alpha dropped, see below
  if (hex.length !== 6) return null;
  const n = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return n.some(Number.isNaN) ? null : n;
}

/**
 * Relative luminance, per WCAG 2.x.
 *
 * Alpha is dropped rather than composited. A translucent foreground has a
 * contrast that depends on what is behind it at that pixel, which the
 * stylesheet does not say, so compositing it here would invent a number. A
 * translucent pair wants a measurement on the rendered page instead.
 */
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---- tokens ------------------------------------------------------------- */

/**
 * Every declaration block that sets a custom property, as a layer.
 *
 * Brace-counted rather than parsed. A stylesheet is only being read for
 * `--name: value` pairs and the selector they sit under, and a real parser buys
 * nothing this needs. `@media` wrappers contribute their condition to the layer
 * name, which is what separates a dark override from the base.
 */
function layers(raw) {
  // Comments first, or every selector arrives with the prose above it attached.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = new Map();
  const stack = [];
  let i = 0;
  let head = '';

  while (i < css.length) {
    const c = css[i];
    if (c === '{') {
      stack.push(head.trim().replace(/\s+/g, ' '));
      head = '';
      i++;
      continue;
    }
    if (c === '}') {
      stack.pop();
      head = '';
      i++;
      continue;
    }
    if (c === ';' && stack.length) {
      const m = head.match(/(--[\w-]+)\s*:\s*([^;]+)$/);
      if (m) {
        const name = stack.filter((s) => !s.startsWith('@') || /prefers|data-|\[/.test(s)).join(' ') || ':root';
        if (!out.has(name)) out.set(name, {});
        out.get(name)[m[1].slice(2)] = m[2].trim();
      }
      head = '';
      i++;
      continue;
    }
    head += c;
    i++;
  }
  return out;
}

/** Dart and anything else spelling `NAME = 0xFFAABBCC` or `NAME: #aabbcc`. */
function flatTokens(text) {
  const out = {};
  for (const m of text.matchAll(/\b([A-Za-z][\w-]*)\s*[:=]\s*(?:Color\()?\s*(#[0-9a-fA-F]{3,8}|0x[0-9a-fA-F]{8})/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Follow `var(--x)` and plain aliases until a colour or nothing. */
function resolve(tokens, name, seen = new Set()) {
  if (seen.has(name)) return null; // a cycle is a bug in the stylesheet, not here
  seen.add(name);
  const raw = tokens[name];
  if (raw === undefined) return null;
  const direct = parseColour(raw);
  if (direct) return direct;
  const ref = raw.match(/var\(\s*--([\w-]+)/) ?? raw.match(/^([\w-]+)$/);
  return ref ? resolve(tokens, ref[1], seen) : null;
}

/* ---- pairs -------------------------------------------------------------- */

const FLOOR = { text: 4.5, large: 3, boundary: 3, decoration: 0 };

function readPairs(text) {
  const out = [];
  text.split('\n').forEach((line, n) => {
    const t = line.replace(/#.*$/, '').trim();
    if (!t) return;
    const m = t.match(/^(\S+)\s+(.+?)\s+(text|large|boundary|decoration)$/);
    if (!m) {
      console.error(`  ${pairsPath}:${n + 1}  cannot read this line: ${t}`);
      console.error('    wanted: <foreground> <background[, background]> <text|large|boundary|decoration>');
      process.exitCode = 2;
      return;
    }
    for (const bg of m[2].split(',').map((s) => s.trim()).filter(Boolean)) {
      out.push({ fg: m[1], bg, role: m[3], at: n + 1 });
    }
  });
  return out;
}

/* ---- run ---------------------------------------------------------------- */

const source = readFileSync(tokensPath, 'utf8');
const isCss = /\.(css|scss|less)$/.test(tokensPath);
const themes = isCss ? layers(source) : new Map([['default', flatTokens(source)]]);
const pairs = readPairs(readFileSync(pairsPath, 'utf8'));
if (process.exitCode === 2) process.exit(2);

if (!themes.size) {
  console.error(`no colour declarations found in ${tokensPath}`);
  process.exit(2);
}

/* The first block that declares anything is the base, and every later block is
   an override on top of it. A dark theme usually restates only what changes, so
   checking it on its own reports half its pairs as missing. */
const [baseName, base] = [...themes][0];

/* A block that sets no colour is not a theme. `.app.no-rail` and a coarse-pointer
   override change widths, inherit every colour, and would otherwise repeat the
   base theme's findings under a different name.

   Then collapse the layers that resolve to the same palette. A stylesheet that
   supports both `prefers-color-scheme` and an explicit toggle declares each
   theme twice on purpose, and reporting each finding twice is how a real list
   becomes one nobody reads. */
const used = new Set(pairs.flatMap((p) => [p.fg, p.bg]));
const palettes = new Map();
for (const [name, own] of themes) {
  const tokens = name === baseName ? base : { ...base, ...own };
  if (name !== baseName && !Object.keys(own).some((k) => used.has(k) && parseColour(own[k]))) continue;
  const key = [...used].map((t) => JSON.stringify(resolve(tokens, t))).join('|');
  if (palettes.has(key)) palettes.get(key).names.push(name);
  else palettes.set(key, { names: [name], tokens });
}

const rows = [];
let failed = 0;
let missing = 0;

for (const { names, tokens } of palettes.values()) {
  const name = names.join(' = ');
  for (const p of pairs) {
    const fg = resolve(tokens, p.fg);
    const bg = resolve(tokens, p.bg);
    if (!fg || !bg) {
      if (names[0] === baseName) {
        rows.push(`  ?     ${name}\n        \`${p.fg}\` on \`${p.bg}\`: ${!fg ? p.fg : p.bg} is not a colour this file declares`);
        missing++;
      }
      continue;
    }
    const r = ratio(fg, bg);
    const floor = FLOOR[p.role];
    const ok = r >= floor;
    if (!ok) failed++;
    if (!ok || p.role === 'decoration') {
      rows.push(
        `  ${ok ? 'note ' : 'FAIL '} ${name}\n` +
          `        \`${p.fg}\` on \`${p.bg}\` is ${r.toFixed(2)}:1, ${p.role} wants ${floor}:1` +
          (p.role === 'decoration' ? ' (exempt by declaration)' : ''),
      );
    }
  }
}

const checked = pairs.length * palettes.size;
console.log(rows.length ? rows.join('\n') + '\n' : '');
console.log(
  `${pairs.length} pairs across ${palettes.size} palette${palettes.size === 1 ? '' : 's'} ` +
    `(${[...palettes.values()].map((p) => p.names[0]).join(', ')}), ${checked} checks. ` +
    `${failed} below floor, ${missing} undeclared.`,
);
if (!failed && !missing) console.log('Every declared pair clears its floor.');

process.exit(failed || missing ? 1 : 0);
