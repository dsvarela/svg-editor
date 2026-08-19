/**
 * How far the interface is from being usable by a finger.
 *
 * The target is 44 px, the minimum in Apple's and Google's guidance. A count is
 * evidence only if its method is repeatable, so this is the method.
 *
 * Counts every control a person can press, across the toolbar, the status strip
 * and all three inspector tabs. A control is the element that takes the press:
 * for a checkbox in a `<label>` that is the label, not the 13 px box.
 *
 * Three ways such a sweep undercounts, silently rather than failing:
 *
 * - **Collapsed groups** are `hidden` and have no box, so all are opened first.
 * - **Disabled controls** are laid out at their enabled size, so they count.
 * - **Colliding keys**, since the sweep dedupes. See the key below.
 *
 * Run with the dev server up. `APP_URL` moves it.
 */

import { launch, APP_URL } from './browser.mjs';

const MIN = 44;

const browser = await launch();
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
await page.goto(APP_URL, { waitUntil: 'networkidle' });
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

/* An exit code, for the same reason `keys.mjs` has one: it printed a count and
   exited 0 whatever the count said. The figure that matters is the second one --
   the controls actually enabled with an empty selection -- because a disabled
   control is laid out at the size it will have when it is enabled, and one that
   is never rendered in this state was never measured. */
if (liveSmall.length) process.exitCode = 1;
