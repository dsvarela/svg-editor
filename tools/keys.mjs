/**
 * What you cannot do without a mouse.
 *
 * The shopping list says keyboard completeness is "partway" and never says
 * which way. This is the survey: every control the interface offers, and
 * whether a keyboard can reach it -- by Tab, by a shortcut, or not at all.
 *
 * A control counts as reachable when it takes focus in the normal tab order and
 * can be triggered from there. That is the honest bar: a button you can Tab to
 * is usable without a pointer even if it has no shortcut of its own, and a
 * shortcut is a convenience on top. What fails the bar is a control that no
 * amount of tabbing arrives at, or an operation with no control at all.
 *
 * Run with the dev server up: `node tools/keys.mjs`.
 */

import { launch, APP_URL } from './browser.mjs';


const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.click('#toggleSrc');
await page.waitForTimeout(260);

/* Put the editor in a state where things are live. A disabled control is
   legitimately not focusable, so surveying an empty selection reports the whole
   Node panel as unreachable and says nothing. */
await page.click('#shapelist li');
await page.waitForTimeout(150);
await page.evaluate(() => {
  const el = document.querySelector('[data-hit="anchor"]');
  el?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
  el?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 0 }));
});
await page.waitForTimeout(200);

/** Every control the interface has, per panel, with whether it is live. */
const snapshot = () => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, input, select, textarea, [role="option"]')) {
    if (el.type === 'hidden') continue;
    const panel = el.closest('.tabpanel')?.id ?? el.closest('.bar')?.className ?? el.closest('.source')?.className ?? 'other';
    out.push({
      id: el.id || null,
      what: (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().slice(0, 42),
      panel,
      disabled: !!el.disabled || !!el.closest('[hidden]'),
      // A negative tabindex is a deliberate removal from the tab order, which
      // is how a segmented control lets the arrow keys own its buttons.
      tabbable: el.tabIndex >= 0,
    });
  }
  return out;
});

/* Tab all the way round, in each tab of the inspector, and record what got
   focus. Three passes: the tab panels hide each other, and a control inside a
   hidden panel is genuinely not in the order. */
const reached = new Set();
const live = new Map();
for (const which of ['tab-shape', 'tab-node', 'tab-doc']) {
  await page.click(`#${which}`);
  await page.waitForTimeout(120);
  /* Groups collapse, and a shut one hides its controls from the tab order --
     which is the feature, not a fault. A person reaches them by tabbing to the
     header and pressing it, so the survey opens them the same way before
     asking what it can reach. */
  await page.evaluate(() => {
    for (const h of document.querySelectorAll('button.glabel')) {
      if (h.getAttribute('aria-expanded') !== 'true') h.click();
    }
  });
  await page.waitForTimeout(120);
  for (const c of await snapshot()) {
    // A control counts as live if it was enabled in at least one pass.
    if (c.id && (!live.has(c.id) || live.get(c.id).disabled)) live.set(c.id, c);
  }
  /* Put the tab position back at the top of the document, which needs more
     than `document.body.focus()`: the body is not focusable, so that call moves
     nothing and the sweep resumes from wherever the group-opening clicks left
     focus, in the middle of the rail.

     Whether that shows up depends on the engine, which is why it can pass for
     years. Chromium wraps the tab order at the end of the page, so the presses
     below come round to the start regardless; Firefox stops at the last
     element, and everything before the resume point counts as unreachable. A
     temporary `tabindex` makes the body a real focus target, and taking it off
     again leaves the page as it was. */
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  for (let i = 0; i < 260; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName ?? '');
    if (id) reached.add(id);
  }
}

const controls = [...live.values()];
const missed = controls.filter((c) => !c.disabled && !reached.has(c.id));
const dead = controls.filter((c) => c.disabled && !reached.has(c.id));
const byPanel = new Map();
for (const c of missed) byPanel.set(c.panel, [...(byPanel.get(c.panel) ?? []), c]);

console.log(
  `${controls.length} controls with an id. ` +
    `${missed.length} are live and cannot be reached by Tab; ` +
    `${dead.length} were disabled throughout and so were not surveyed.`,
);
for (const [panel, list] of byPanel) {
  console.log(`\n  ${panel}`);
  for (const c of list) console.log(`    ${(c.id ?? '').padEnd(18)} ${c.what}${c.tabbable ? '' : '   [tabindex -1]'}`);
}

await browser.close();

if (dead.length) {
  console.log('\n  not surveyed, disabled throughout (needs a document state this does not set up)');
  for (const c of dead) console.log(`    ${(c.id ?? '').padEnd(18)} ${c.what}`);
}
