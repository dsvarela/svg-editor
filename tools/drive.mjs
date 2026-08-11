/**
 * Drive the editor in a real browser.
 *
 *   node tools/drive.mjs <scenario> [--headed] [--out shot.png]
 *
 * Uses playwright-core against the system Edge (Chromium), so no browser
 * download is needed. Console messages and page errors are captured and
 * printed -- that is how the pen-tool crash was first spotted.
 */

import { chromium } from 'playwright-core';

const EDGE = '/usr/bin/microsoft-edge';
const URL = process.env.APP_URL ?? 'http://localhost:5173/';

const args = process.argv.slice(2);
const scenarioName = args.find((a) => !a.startsWith('--')) ?? 'smoke';
const headed = args.includes('--headed');
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : `/tmp/drive-${scenarioName}.png`;

/** Canvas-relative click helper: takes document coords, converts via the page. */
async function mk(page) {
  const box = await page.locator('#canvas').boundingBox();

  /** Document coords -> client pixels, asked of the page itself. */
  const toClient = async (doc) =>
    page.evaluate(([x, y]) => {
      const svg = document.querySelector('.overlay');
      const m = svg.getScreenCTM();
      const p = new DOMPoint(x, y).matrixTransform(m);
      return [p.x, p.y];
    }, doc);

  /**
   * Guard against the harness lying to itself.
   *
   * A document coordinate outside the current camera converts to a client point
   * beyond the canvas -- and `page.mouse` will happily click whatever is there,
   * which during development meant silently pressing "Rotate +90°" on the rail
   * and blaming the editor for the result.
   */
  const assertInside = async ([cx, cy], doc) => {
    const b = await page.locator('#canvas').boundingBox();
    if (cx < b.x || cx > b.x + b.width || cy < b.y || cy > b.y + b.height) {
      throw new Error(
        `doc point [${doc}] maps to client [${cx.toFixed(0)},${cy.toFixed(0)}], ` +
          `outside the canvas [${b.x.toFixed(0)},${b.y.toFixed(0)} ` +
          `${b.width.toFixed(0)}x${b.height.toFixed(0)}]`,
      );
    }
  };

  const click = async (doc) => {
    const c = await toClient(doc);
    await assertInside(c, doc);
    await page.mouse.move(c[0], c[1]);
    await page.mouse.down();
    await page.mouse.up();
  };

  const drag = async (from, to, steps = 8, modifier = null) => {
    const a = await toClient(from);
    const bb = await toClient(to);
    await assertInside(a, from);
    await assertInside(bb, to);
    const [ax, ay] = a;
    const [bx, by] = bb;
    await page.mouse.move(ax, ay);
    // Held across the press, because the controller samples the modifier when
    // the drag begins rather than on every move.
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(ax + ((bx - ax) * i) / steps, ay + ((by - ay) * i) / steps);
    }
    await page.mouse.up();
    if (modifier) await page.keyboard.up(modifier);
  };

  return { box, toClient, click, drag };
}

const scenarios = {
  /** Load and report. */
  async smoke(page) {
    return { stats: await page.textContent('#stats') };
  },

  /**
   * The reported session: draw a polygon with the pen, close it by clicking the
   * first node, then keep clicking -- which starts a second shape.
   */
  async penPolygon(page) {
    const { click } = await mk(page);
    await page.click('#tool button[data-v="pen"]');

    const pts = [
      [30, 12],
      [12, 30],
      [22, 52],
      [46, 52],
      [56, 30],
    ];
    for (const p of pts) await click(p);
    await click(pts[0]); // close
    await click([70, 15]); // starts shape 2
    await click([80, 25]);
    return { stats: await page.textContent('#stats'), d: await page.inputValue('#src') };
  },

  /** Same, but with small accidental drags on each click. */
  async penWithDrags(page) {
    const { drag } = await mk(page);
    await page.click('#tool button[data-v="pen"]');
    const pts = [
      [30, 12],
      [12, 30],
      [22, 52],
      [46, 52],
      [56, 30],
    ];
    for (const p of pts) await drag(p, [p[0] + 3, p[1] + 2]);
    return { stats: await page.textContent('#stats'), d: await page.inputValue('#src') };
  },

  /** Select a node and pull a hollow ghost handle out into a curve. */
  async latentHandle(page) {
    const { click, drag } = await mk(page);
    await page.click('#tool button[data-v="pen"]');
    for (const p of [
      [20, 20],
      [60, 20],
      [60, 50],
    ])
      await click(p);
    await page.click('#tool button[data-v="select"]');
    await click([60, 20]);
    // Rendering is rAF-driven, so a query fired immediately after a click can
    // beat the frame that draws the result.
    await page.waitForTimeout(120);
    const ghosts = await page.locator('.handle-dot.latent').count();
    const solid = await page.locator('.handle-dot:not(.latent)').count();
    await drag([46.67, 20], [46, 12]);
    await page.waitForTimeout(120);
    return {
      ghostsBefore: ghosts,
      solidBefore: solid,
      solidAfter: await page.locator('.handle-dot:not(.latent)').count(),
      stats: await page.textContent('#stats'),
      d: await page.inputValue('#src'),
    };
  },

  /** Undo past a pen shape then keep drawing -- the old crash. */
  async penUndo(page) {
    const { click } = await mk(page);
    await page.click('#tool button[data-v="pen"]');
    await click([20, 20]);
    await click([50, 20]);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await click([30, 40]);
    await click([60, 40]);
    return { stats: await page.textContent('#stats') };
  },

  /**
   * A point is a point: no type is chosen, the handles decide.
   *
   * Draws a node with mirrored handles, drags one (the other should follow),
   * then Alt-drags it (the other should not), and reads the inspector's
   * continuity badge at each step.
   */
  async continuity(page) {
    const { click, drag } = await mk(page);
    const badge = async () =>
      page.locator('#ntype button[aria-pressed="true"]').first().textContent().catch(() => null);

    await page.click('#tool button[data-v="pen"]');
    await click([20, 40]);
    await drag([50, 40], [50, 20]); // pen-drag pulls out a mirrored pair
    await click([80, 40]);
    await page.keyboard.press('Escape');

    await page.click('#tool button[data-v="select"]');
    await click([50, 40]);
    await page.waitForTimeout(120);
    const asDrawn = { badge: await badge(), d: await page.inputValue('#src') };

    // Plain drag of the outgoing handle: the incoming one should mirror it.
    await drag([50, 20], [62, 26]);
    await page.waitForTimeout(120);
    const mirrored = { badge: await badge(), d: await page.inputValue('#src') };

    // Alt-drag the same handle: the far one should now stay where it is.
    await drag([62, 26], [64, 46], 8, 'Alt');
    await page.waitForTimeout(120);
    const broken = { badge: await badge(), d: await page.inputValue('#src') };

    return { asDrawn, mirrored, broken };
  },

  /** Select two neighbouring nodes and bend the segment between them. */
  async bend(page) {
    const { click, drag } = await mk(page);
    await page.click('#tool button[data-v="pen"]');
    for (const p of [[20, 20], [60, 20], [60, 50]]) await click(p);
    await page.keyboard.press('Escape');
    await page.click('#tool button[data-v="select"]');
    await click([20, 20]);
    await page.keyboard.down('Shift');
    await click([60, 20]);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(150);

    const before = {
      info: await page.textContent('#bendinfo'),
      angle: await page.inputValue('#bendAngle'),
      controls: await page.locator('.bend-dot').count(),
    };
    // The bend control sits at the curve midpoint, which for a flat segment is
    // the chord midpoint.
    await drag([40, 20], [40, 8]);
    await page.waitForTimeout(150);
    const dragged = {
      angle: await page.inputValue('#bendAngle'),
      loose: await page.inputValue('#bendLoose'),
      d: await page.inputValue('#src'),
    };

    await page.fill('#bendAngle', '45');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const typed = { angle: await page.inputValue('#bendAngle'), d: await page.inputValue('#src') };

    await page.click('#bendFlat');
    await page.waitForTimeout(150);
    return { before, dragged, typed, flattened: await page.inputValue('#src') };
  },

  /** Paste a real multi-element icon and Apply it. */
  async pasteIcon(page) {
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill('#src', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect x="2" y="4" width="20" height="16" rx="3" fill="none" stroke="#2563d8" stroke-width="1.5"/>
  <circle cx="8" cy="10" r="2" fill="#e8a54b" stroke="none"/>
  <path d="M4 18 L10 12 L14 16 L17 13 L20 16" fill="none" stroke="#2563d8" stroke-width="1.5"/>
</svg>`);
    await page.click('#apply');
    await page.waitForTimeout(200);
    const shapes = await page.locator('#shapelist li').allTextContents();
    return {
      stats: await page.textContent('#stats'),
      status: await page.textContent('#status'),
      shapes,
      roundTrip: await page.inputValue('#src'),
    };
  },

  /** Apply the source box with two shapes present. */
  async applyTwoShapes(page) {
    const { click } = await mk(page);
    await page.click('#tool button[data-v="pen"]');
    for (const p of [
      [20, 20],
      [40, 20],
      [40, 40],
    ])
      await click(p);
    await page.keyboard.press('Escape');
    for (const p of [
      [60, 20],
      [75, 35],
    ])
      await click(p);
    const before = await page.textContent('#stats');
    await page.click('#apply');
    await page.waitForTimeout(150);
    const afterUnscoped = await page.textContent('#stats');
    const hintUnscoped = await page.textContent('#srchint');

    // Now with one shape selected, `d` mode should touch only that shape.
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#tool button[data-v="pen"]');
    const mk2 = await mk(page);
    for (const p of [[20, 20], [40, 20], [40, 40]]) await mk2.click(p);
    await page.keyboard.press('Escape');
    await page.click('#shapelist li:nth-child(2)');
    await page.waitForTimeout(150);
    const scopedBefore = await page.textContent('#stats');
    const scopedHint = await page.textContent('#srchint');
    const shown = await page.inputValue('#src');
    await page.fill('#src', 'M 20 20 L 45 20 L 45 45 L 20 45 Z');
    await page.click('#apply');
    await page.waitForTimeout(150);
    return {
      before, afterUnscoped, hintUnscoped,
      scopedBefore, scopedHint, shownForSelected: shown,
      scopedAfter: await page.textContent('#stats'),
      scopedStatus: await page.textContent('#status'),
    };
  },
};

const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(`unknown scenario '${scenarioName}'. have: ${Object.keys(scenarios).join(', ')}`);
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: !headed,
  args: ['--no-sandbox', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

let result;
try {
  result = await scenario(page);
} catch (err) {
  result = { error: err.message };
}

await page.waitForTimeout(150);
await page.screenshot({ path: out });

/* Structural check straight from the live DOM: does the canvas show exactly
   what the document holds? */
const audit = await page.evaluate(() => {
  const artwork = [...document.querySelectorAll('.artwork path')];
  const anchors = [...document.querySelectorAll('.anchor')].filter(
    (e) => e.getAttribute('display') !== 'none',
  );
  const handles = [...document.querySelectorAll('.handle-dot')].filter(
    (e) => e.getAttribute('display') !== 'none',
  );
  const lines = [...document.querySelectorAll('.handle-line')].filter(
    (e) => e.getAttribute('display') !== 'none',
  );
  const outlines = [...document.querySelectorAll('.outline')].filter(
    (e) => e.getAttribute('display') !== 'none',
  );
  return {
    artworkPaths: artwork.length,
    artworkD: artwork.map((p) => p.getAttribute('d')),
    badD: artwork.filter((p) => /NaN|Infinity|undefined/.test(p.getAttribute('d') ?? '')).length,
    visibleAnchors: anchors.length,
    visibleHandles: handles.length,
    visibleHandleLines: lines.length,
    visibleOutlines: outlines.length,
  };
});

console.log(JSON.stringify({ scenario: scenarioName, result, audit, logs }, null, 2));
console.log(`\nscreenshot -> ${out}`);

await browser.close();
