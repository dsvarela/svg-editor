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
 * Run it with the dev server up: `node tools/touch.mjs`.
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// The source drawer is a panel of its own and its controls count too.
await page.click('#toggleSrc');
await page.waitForTimeout(260);

const seen = new Map();
const sweep = async () => {
  const found = await page.evaluate((min) => {
    const out = [];
    const els = document.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    for (const el of els) {
      if (el.disabled) continue;
      // The pressable thing, not the styled thing: a checkbox in a label is
      // pressed by clicking the label.
      const target = el.closest('label') ?? el;
      const r = target.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const key = el.id || `${el.tagName}.${el.className}:${el.getAttribute('data-v') ?? el.getAttribute('data-al') ?? ''}`;
      out.push({ key, w: +r.width.toFixed(1), h: +r.height.toFixed(1), small: r.width < min || r.height < min });
    }
    return out;
  }, MIN);
  for (const f of found) if (!seen.has(f.key)) seen.set(f.key, f);
};

await sweep();
for (const tab of ['#tab-node', '#tab-doc', '#tab-shape']) {
  await page.click(tab);
  await page.waitForTimeout(140);
  await sweep();
}

const all = [...seen.values()];
const small = all.filter((c) => c.small);
console.log(`${small.length} of ${all.length} controls are under ${MIN} px on at least one axis`);
const worst = small.slice().sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h)).slice(0, 8);
for (const c of worst) console.log(`  ${String(Math.min(c.w, c.h)).padStart(6)} px   ${c.key}`);

await browser.close();
