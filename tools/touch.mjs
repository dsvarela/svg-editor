/**
 * How far the interface is from being usable by a finger.
 *
 * `CLAUDE.md` carries a rule that new controls are laid out at 44 px, the touch
 * target minimum in both Apple's and Google's guidance, and it quoted a count
 * as the evidence. The count could not be checked, because the method behind it
 * was never written down. This is the method.
 *
 * What it counts: every control a person can press, in the toolbar, the status
 * strip and all three inspector tabs. A control is the element that takes the
 * press -- for a checkbox inside a `<label>` that is the label, since clicking
 * the words toggles the box, and measuring the 13 px box would report a target
 * nobody has to hit.
 *
 * **Two corrections, 2026-08-13.** The count this reported had drifted away
 * from what it claimed to be:
 *
 * - *Collapsed groups were invisible to it.* Since the rail redesign, every
 *   group except Style, Node and Shapes starts shut, and a shut group is
 *   `hidden`, so its controls have no box and were skipped. The tool reported
 *   37 controls where the markup holds 166. It now opens every group in every
 *   tab before measuring.
 * - *Disabled controls were skipped.* 55 of the 166 are disabled with nothing
 *   selected, and a disabled button is laid out at exactly the size it will
 *   have when it is enabled. Skipping them measured the state of the document
 *   rather than the size of the interface. They are counted, and reported
 *   separately so the two numbers stay legible.
 *
 * Neither number is comparable with any figure recorded before this date. The
 * one in `CLAUDE.md` was replaced rather than adjusted.
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
      const key =
        el.id ||
        `${el.tagName}.${el.className}:${el.getAttribute('data-v') ?? el.getAttribute('data-al') ?? ''}`;
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
