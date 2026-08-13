/**
 * How far the interface is from being usable by a finger.
 *
 * The target is 44 px, the touch target minimum in both Apple's and Google's
 * guidance. A count of how many controls miss it is only evidence if the method
 * behind it is written down and repeatable, so this is the method, and the
 * number it prints is the only one worth quoting.
 *
 * What it counts: every control a person can press, in the toolbar, the status
 * strip and all three inspector tabs. A control is the element that takes the
 * press -- for a checkbox inside a `<label>` that is the label, since clicking
 * the words toggles the box, and measuring the 13 px box would report a target
 * nobody has to hit.
 *
 * Three things a sweep like this gets wrong unless it is careful, all of which
 * silently undercount rather than fail:
 *
 * - *Collapsed groups.* Every group except Style, Node and Shapes starts shut,
 *   and a shut group is `hidden`, so its controls have no box at all. Open
 *   every group in every tab before measuring, or the markup's 166 controls
 *   report as 37.
 * - *Disabled controls.* 55 of the 166 are disabled with nothing selected, and
 *   a disabled button is laid out at exactly the size it will have when it is
 *   enabled. Counting only the enabled ones measures the state of the document
 *   rather than the size of the interface. They are counted, and reported
 *   separately so the two numbers stay legible.
 * - *Colliding keys.* The sweep dedupes, so two controls that hash alike are
 *   counted once. See the key below for what has to go into it.
 *
 * Run it with the dev server up: `node tools/touch.mjs`, or
 * `APP_URL=http://localhost:5177/ node tools/touch.mjs` when it is not on the
 * first port Vite tries.
 */

import { chromium } from 'playwright-core';

const EDGE = process.env.BROWSER_PATH ?? '/usr/bin/microsoft-edge';
const URL = process.env.APP_URL ?? 'http://localhost:5173/';
const MIN = 44;

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
});
/* `--coarse` measures what a finger gets rather than what a mouse gets. It is
   the same page under `hasTouch`, which is what makes `pointer: coarse` match,
   so the two runs together say whether sizing up for touch cost the desktop
   anything. */
const coarse = process.argv.includes('--coarse');
const page = await browser.newPage({
  viewport: coarse ? { width: 390, height: 844 } : { width: 1400, height: 900 },
  hasTouch: coarse,
  isMobile: coarse,
});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// The source drawer is a panel of its own and its controls count too.
await page.click('#toggleSrc');
await page.waitForTimeout(260);

/** Open every shut group in the tab on screen. A shut one hides its controls. */
const openGroups = async () => {
  const opened = await page.evaluate(() => {
    let n = 0;
    for (const head of document.querySelectorAll('button.glabel')) {
      if (head.getAttribute('aria-expanded') === 'true') continue;
      if (!head.getBoundingClientRect().width) continue; // in a tab that is not on screen
      head.click();
      n++;
    }
    return n;
  });
  if (opened) await page.waitForTimeout(120);
};

const seen = new Map();
const sweep = async () => {
  const found = await page.evaluate((min) => {
    const out = [];
    const els = document.querySelectorAll(
      'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    /* A listbox is focusable as one element and pressed one row at a time, so
       the rows are the targets and the box around them is not. */
    const rows = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    for (const el of [...els, ...rows]) {
      if (el.getAttribute('role') === 'listbox') continue;
      // The pressable thing, not the styled thing: a checkbox in a label is
      // pressed by clicking the label.
      const target = el.closest('label') ?? el;
      const r = target.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      /* Distinct per control, since the sweep dedupes on it. Id, class and data
         attributes are not enough on their own: two buttons carrying none of
         them hash alike and are counted once, which is how a pair of new
         status-strip buttons can leave the total unmoved. What separates them
         is what a person reads on them, so the label is in the key too.
         Anything still colliding is genuinely one control in two places. */
      const label = (
        el.getAttribute('aria-label') ??
        el.getAttribute('title') ??
        el.textContent ??
        ''
      )
        .trim()
        .slice(0, 24);
      const data = [...el.attributes]
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => a.value)
        .join('/');
      const key = el.id || `${el.tagName}.${el.className}:${data}:${label}`;
      out.push({
        key,
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        off: !!el.disabled,
        small: r.width < min || r.height < min,
      });
    }
    return out;
  }, MIN);
  for (const f of found) if (!seen.has(f.key)) seen.set(f.key, f);
};

await openGroups();
await sweep();
for (const tab of ['#tab-node', '#tab-doc', '#tab-shape']) {
  await page.click(tab);
  await page.waitForTimeout(140);
  await openGroups();
  await sweep();
}

const all = [...seen.values()];
const small = all.filter((c) => c.small);
const live = all.filter((c) => !c.off);
const liveSmall = live.filter((c) => c.small);

console.log(`${small.length} of ${all.length} controls are under ${MIN} px on at least one axis`);
console.log(
  `${liveSmall.length} of ${live.length} counting only the ones enabled with an empty selection`,
);
const worst = small
  .slice()
  .sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h))
  .slice(0, 12);
for (const c of worst) {
  console.log(`  ${String(Math.min(c.w, c.h)).padStart(6)} px   ${c.key}${c.off ? '  (off)' : ''}`);
}

await browser.close();
