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
import zlib from 'node:zlib';

const EDGE = '/usr/bin/microsoft-edge';
const URL = process.env.APP_URL ?? 'http://localhost:5173/';

const args = process.argv.slice(2);
const scenarioName = args.find((a) => !a.startsWith('--')) ?? 'smoke';
const headed = args.includes('--headed');
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : `/tmp/drive-${scenarioName}.png`;

/**
 * Open the source drawer, which is closed on load.
 *
 * Reading `#src` works either way -- `inputValue` does not check visibility,
 * and the box is kept current whether or not anyone can see it -- but filling
 * it or pressing Apply needs the drawer actually open.
 */
async function openSource(page) {
  if ((await page.getAttribute('#toggleSrc', 'aria-pressed')) !== 'true') {
    await page.click('#toggleSrc');
    await page.waitForTimeout(220); // the drawer animates, and the canvas re-fits
  }
}

/**
 * Close the source drawer, and wait for the canvas to settle.
 *
 * Closing it gives the space back to the canvas, which re-fits the camera, so a
 * document coordinate converted to client pixels before the animation finishes
 * points somewhere else by the time the mouse gets there. A click issued
 * immediately after this lands on the wrong thing, and the scenario reports that
 * selecting a node did nothing.
 */
async function closeSource(page) {
  await page.click('#closeSrc');
  await page.waitForTimeout(240);
}

/**
 * Show one of the inspector's tabs.
 *
 * The rail is three tabbed panels, and a control in a tab you cannot see is
 * genuinely not there: `hidden` keeps it out of the tab order and out of the
 * hit test, so Playwright waits for a visibility that never arrives. Scenarios
 * say which tab they want, the same as a person would.
 */
async function tab(page, name) {
  await page.click(`#tab-${name}`);
  await page.waitForTimeout(80);
}

/**
 * Press Ctrl+Z, meaning the editor's undo.
 *
 * The controller ignores single keystrokes while a text field has focus, so the
 * browser's own text undo answers instead. That is not a hypothetical: filling a
 * number field and pressing Ctrl+Z restores the field's text, which fires
 * `input`, which sets the value back through the app -- a scenario asserting on
 * the result passes without the editor's history being touched at all.
 */
async function undo(page) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
}

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

    /* The second way the harness can lie to itself: the point is inside the
       canvas, but the canvas is scrolled out of the viewport. Typing into the
       source box does exactly that -- it scrolls itself into view and pushes
       the canvas off the top. `page.mouse` will happily move to a negative
       coordinate the browser delivers to nothing at all, and the scenario then
       reports that clicking a node did not select it, as if the editor were at
       fault. It cost half an hour once; it costs an exception now. */
    const vp = page.viewportSize();
    if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) {
      throw new Error(
        `doc point [${doc}] maps to client [${cx.toFixed(0)},${cy.toFixed(0)}], ` +
          `outside the ${vp.width}x${vp.height} viewport — the canvas is scrolled ` +
          `off screen, call showCanvas() first`,
      );
    }
  };

  /** Bring the canvas back into view after something scrolled the page. */
  const showCanvas = async () => {
    await page.evaluate(() => document.querySelector('#canvas').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(60);
  };

  const click = async (doc, modifier = null) => {
    const c = await toClient(doc);
    await assertInside(c, doc);
    await page.mouse.move(c[0], c[1]);
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.down();
    await page.mouse.up();
    if (modifier) await page.keyboard.up(modifier);
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

  return { box, toClient, click, drag, showCanvas };
}

/**
 * Write an RGBA raster as a PNG.
 *
 * Thirty lines beats a fixture file: a trace scenario needs a picture with a
 * shape in it, and one checked into the repo would be a binary nobody can read
 * in a diff and nobody can adjust without a paint program. `pixel(x, y)` returns
 * `[r, g, b, a]`.
 */
function png(width, height, pixel) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }

  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tagged = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(tagged));
    return Buffer.concat([len, tagged, sum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
      page
        .locator('#ntype button[aria-pressed="true"]')
        .first()
        .textContent()
        // The button wraps a glyph as well as its label, so the text arrives
        // padded with the markup's own newlines.
        .then((t) => t?.trim() ?? null)
        .catch(() => null);

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

    await tab(page, 'node');
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
    await openSource(page);
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
    await openSource(page);
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
    await openSource(page);
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

  /** Combine two overlapping squares, one operation at a time, undoing between. */
  async combine(page) {
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <rect x="0" y="0" width="20" height="20" fill="#2563d8"/>
  <rect x="10" y="10" width="20" height="20" fill="#e8a54b"/>
</svg>`,
    );
    await page.click('#apply');
    // Fills must actually render, or the style-inheritance check below reads
    // `none` for every result and proves nothing.
    await tab(page, 'doc');
    await page.check('#filled');
    await tab(page, 'shape');
    await page.waitForTimeout(200);

    const selectBoth = async () => {
      await page.click('#shapelist li:nth-child(1)');
      await page.click('#shapelist li:nth-child(2)', { modifiers: ['Shift'] });
      await page.waitForTimeout(80);
    };

    // With nothing selected the buttons must be unreachable, not merely inert.
    const disabledWhenIdle = await page.isDisabled('[data-bool="unite"]');
    await selectBoth();
    const enabledWithTwo = await page.isEnabled('[data-bool="unite"]');

    const runs = {};
    for (const op of ['unite', 'subtract', 'intersect', 'exclude']) {
      await selectBoth();
      await page.click(`[data-bool="${op}"]`);
      await page.waitForTimeout(150);
      runs[op] = {
        status: await page.textContent('#status'),
        stats: await page.textContent('#stats'),
        // The survivor must keep the FIRST operand's fill (#2563d8), not the
        // second's (#e8a54b) and not a default.
        fill: await page.getAttribute('.artwork path', 'fill'),
        shapes: await page.locator('#shapelist li').allTextContents(),
        d: await page.getAttribute('.artwork path', 'd'),
      };
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(120);
      runs[op].afterUndo = await page.textContent('#stats');
    }

    return { disabledWhenIdle, enabledWithTwo, runs };
  },

  /**
   * The reported gesture: marquee everything, press Delete.
   *
   * Three nodes used to survive, because the per-node floor that stops a path
   * degenerating under single-node edits also applied to "delete all of them".
   */
  async marqueeDelete(page) {
    const { drag } = await mk(page);

    /* The marquee's stroke must be the same thickness at every zoom. It was
       not: `box()` multiplied the width by document-units-per-pixel on an
       element that already carries `vector-effect: non-scaling-stroke`, so the
       width was scaled twice and the rubber band grew into a picket fence when
       zoomed out. Measured rather than eyeballed, at both ends of the range. */
    const strokeMidDrag = async () => {
      const b = await page.locator('#canvas').boundingBox();
      await page.mouse.move(b.x + 120, b.y + 120);
      await page.mouse.down();
      await page.mouse.move(b.x + 520, b.y + 420, { steps: 3 });
      const px = await page.$eval('.marquee', (el) => {
        const cs = getComputedStyle(el);
        const w = parseFloat(cs.strokeWidth);
        return cs.vectorEffect === 'non-scaling-stroke' ? w : w * el.getScreenCTM().a;
      });
      await page.mouse.up();
      return px;
    };

    const near = await strokeMidDrag();
    for (let i = 0; i < 12; i++) await page.click('#zoomout');
    await page.waitForTimeout(200);
    const far = await strokeMidDrag();
    for (let i = 0; i < 12; i++) await page.click('#zoomin');
    await page.waitForTimeout(200);
    if (Math.abs(near - far) > 0.01) {
      throw new Error(`marquee stroke is ${near}px near and ${far}px far; it must not scale`);
    }
    await page.click('#fit');
    await page.waitForTimeout(150);

    // The starter shape lives inside 20..68 x 12..52; sweep well past it.
    await drag([8, 9], [79, 55]);
    await page.waitForTimeout(120);
    const selected = await page.textContent('#selinfo');
    const anchorsSelected = await page.locator('.anchor.selected').count();
    const marqueeStroke = { near, far };

    await page.click('#del');
    await page.waitForTimeout(150);
    const afterButton = await page.textContent('#stats');

    // And again through the key, which is a separate entry point.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(120);
    await drag([8, 9], [79, 55]);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);

    return {
      selected,
      anchorsSelected,
      marqueeStroke,
      afterButton,
      afterKey: await page.textContent('#stats'),
      status: await page.textContent('#status'),
    };
  },

  /**
   * A three-node closed loop: the smallest case the old floor refused outright.
   * Deleting a node must reduce it, and breaking must open it.
   */
  async smallClosedPath(page) {
    const { click, showCanvas } = await mk(page);
    const load = async () => {
      await openSource(page);
      await page.click('#srcmode button[data-v="svg"]');
      await page.fill(
        '#src',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60">
  <path d="M20 45 C10 20 60 40 45 12 C40 5 25 50 55 30 Z" fill="none" stroke="#2563d8"/>
</svg>`,
      );
      await page.click('#apply');
      await page.waitForTimeout(200);
      // Filling the source box scrolled it into view and the canvas off screen.
      await showCanvas();
    };

    await load();
    const start = await page.textContent('#stats');

    // Delete one of the three, which the floor used to refuse.
    await click([20, 45]);
    await page.waitForTimeout(120);
    await page.click('#del');
    await page.waitForTimeout(150);
    const afterDelete = {
      stats: await page.textContent('#stats'),
      d: await page.getAttribute('.artwork path', 'd'),
    };

    // Break the same loop open at a node instead of deleting one.
    await load();
    await click([45, 12]);
    await page.waitForTimeout(120);
    await tab(page, 'node');
    await page.click('#breakPath');
    await page.waitForTimeout(150);

    return {
      start,
      afterDelete,
      afterBreak: await page.getAttribute('.artwork path', 'd'),
      breakStatus: await page.textContent('#status'),
    };
  },

  /** The same delete, both ways round, on the same path. */
  async deleteModes(page) {
    const { click, showCanvas } = await mk(page);

    const load = async () => {
      await openSource(page);
      await page.click('#srcmode button[data-v="svg"]');
      await page.fill(
        '#src',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60">
  <path d="M10 30 L25 15 L40 30 L55 15 L70 30" fill="none" stroke="#2563d8"/>
</svg>`,
      );
      await page.click('#apply');
      await page.waitForTimeout(200);
      await showCanvas();
    };

    const run = async (mode) => {
      await load();
      await page.click(`#delmode button[data-dm="${mode}"]`);
      await page.waitForTimeout(80);
      await click([40, 30]);
      await page.waitForTimeout(120);
      const selected = await page.textContent('#nodeinfo');
      await page.click('#del');
      await page.waitForTimeout(150);
      return {
        pressed: await page.getAttribute(`#delmode button[data-dm="${mode}"]`, 'aria-pressed'),
        selected,
        stats: await page.textContent('#stats'),
        d: await page.getAttribute('.artwork path', 'd'),
      };
    };

    return { fuse: await run('fuse'), split: await run('split') };
  },

  /**
   * The two draw tools, circularise, renaming, and the tooltips.
   *
   * Drawing is the one thing here that cannot be checked without a browser:
   * the shape's size comes from a pointer drag through a real hit-tested
   * overlay, and the modifier keys are read off the live event.
   */
  async primitives(page) {
    const { drag } = await mk(page);

    /* This scenario used to read every value off the page and return it, with
       nothing compared against anything. That is not a check: break
       Shift-constrain, the corner radius, the `e` shortcut or circularise, and
       it still exited 0 while printing a plausible-looking blob. A scenario
       that cannot fail reports green while measuring nothing, which is worse
       than not having it. */
    const check = (ok, what) => {
      if (!ok) throw new Error(`primitives: ${what}`);
    };
    /* The drawn size of a path, asked of the browser rather than parsed out of
       the `d`. Splitting the numbers into x/y pairs looks obvious and is wrong
       the moment an `H` or a `V` appears, which is exactly what a rounded
       rectangle emits -- the first version of this check reported a 24x25 rect
       as 65x65 and failed on its own arithmetic. `getBBox` is also the measure
       that matters: it is the shape as drawn, curves included. */
    const extent = (selector) =>
      page.$eval(selector, (el) => {
        const b = el.getBBox();
        return [b.width, b.height];
      });

    // Clear the starter so the shape list is easy to talk about.
    await page.click('#shapelist li:nth-child(1)');
    await page.click('#delShape');
    await page.waitForTimeout(80);

    // A circle: Shift takes the smaller span of the drag.
    await page.click('#tool button[data-v="ellipse"]');
    await drag([20, 15], [50, 55], 10, 'Shift');
    await page.waitForTimeout(120);
    const circle = {
      stats: await page.textContent('#stats'),
      d: await page.getAttribute('.artwork path', 'd'),
    };
    // Shift took the smaller span of a 30x40 drag, so both sides are 30.
    const [cw, ch] = await extent('.artwork path');
    check(Math.abs(cw - ch) < 0.01, `Shift did not constrain: ${cw} x ${ch}`);
    check(Math.abs(cw - 30) < 0.5, `expected a 30-unit circle, got ${cw}`);
    check(/^M[^A-Z]*C/.test(circle.d), 'an ellipse should be cubics, not lines');

    // A rounded rectangle, radius set in the rail.
    await page.fill('#cornerRadius', '3');
    await page.dispatchEvent('#cornerRadius', 'input');
    await page.click('#tool button[data-v="rect"]');
    await drag([56, 15], [80, 40]);
    await page.waitForTimeout(120);
    const rounded = {
      shapes: await page.locator('#shapelist li').allTextContents(),
      d: await page.getAttribute('.artwork path:nth-child(2)', 'd'),
    };
    check(rounded.shapes.length === 2, `expected 2 shapes, got ${rounded.shapes.length}`);
    // A rounded rectangle is arcs at the corners and straight sides between,
    // so it must contain both -- all-C means the sides bowed, no C means the
    // radius was dropped on the floor.
    check(/C/.test(rounded.d), 'no curves: the corner radius was ignored');
    check(/[HVL]/.test(rounded.d), 'no straight sides: the rectangle is all curve');
    const [rw, rh] = await extent('.artwork path:nth-child(2)');
    check(Math.abs(rw - 24) < 0.5 && Math.abs(rh - 25) < 0.5, `rect is ${rw} x ${rh}, want 24 x 25`);

    // The keyboard reaches the tools too.
    await page.keyboard.press('e');
    const toolAfterKey = await page.getAttribute('#tool button[data-v="ellipse"]', 'aria-pressed');
    check(toolAfterKey === 'true', 'pressing e did not select the ellipse tool');
    // ...but Ctrl+E belongs to the source drawer, and used to switch the tool
    // as a silent side effect of opening it.
    await page.click('#tool button[data-v="select"]');
    await page.keyboard.press('Control+e');
    await page.waitForTimeout(120);
    const toolAfterCtrlE = await page.getAttribute('#tool button[data-v="select"]', 'aria-pressed');
    check(toolAfterCtrlE === 'true', 'Ctrl+E switched the tool as well as opening the drawer');
    await page.keyboard.press('Control+e');
    await page.waitForTimeout(120);

    // Circularise: pull one node of the circle well off, then put it back.
    await page.click('#shapelist li:nth-child(1)');
    await page.waitForTimeout(80);
    await drag([50, 30], [57, 30]);
    await page.waitForTimeout(120);
    const dented = await page.getAttribute('.artwork path', 'd');
    await page.click('#shapelist li:nth-child(1)');
    await page.click('#circularise');
    await page.waitForTimeout(150);
    const fixed = {
      status: await page.textContent('#status'),
      d: await page.getAttribute('.artwork path', 'd'),
    };
    // These two were captured a few lines apart and never compared, so a
    // circularise that did nothing at all read as a pass.
    check(dented !== fixed.d, 'circularise left the dented path exactly as it was');
    check(/Circularised 1 path/.test(fixed.status), `unexpected status: ${fixed.status}`);
    const [fw, fh] = await extent('.artwork path');
    check(Math.abs(fw - fh) < 0.6, `circularised shape is not round: ${fw} x ${fh}`);

    // Rename, which is what the exported id carries.
    await page.dblclick('#shapelist li:nth-child(1) .nm');
    await page.fill('#shapelist .rename', 'outer ring');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.waitForTimeout(120);
    const renamed = {
      status: await page.textContent('#status'),
      listed: await page.textContent('#shapelist li:nth-child(1)'),
      exported: (await page.inputValue('#src')).includes('id="outer-ring"'),
    };

    check(renamed.exported, 'the renamed shape did not reach the exported id');
    check(/outer ring/.test(renamed.listed), `the list still reads ${renamed.listed}`);

    // Tooltips: the toolbar is icons, so the labels have to come from hovering.
    await page.hover('#fit');
    await page.waitForTimeout(320);
    const tip = {
      text: await page.textContent('.tip'),
      shown: await page.locator('.tip.on').count(),
      // The native tooltip must be gone, or both appear at once.
      titleLeft: await page.getAttribute('#fit', 'title'),
    };
    check(tip.shown === 1, 'no tooltip appeared on hover');
    check(tip.titleLeft === null, 'the native title survived, so both tooltips show');

    /* The key cap is the one part of the tooltip the commit singled out, and
       hovering `#fit` -- whose title has no parenthesis -- never exercised it.
       Hover something that has one. */
    await page.hover('#tool button[data-v="ellipse"]');
    await page.waitForTimeout(320);
    const cap = {
      kbd: await page.locator('.tip kbd').count(),
      key: await page.textContent('.tip kbd').catch(() => null),
    };
    check(cap.kbd === 1, 'the shortcut did not render as a key cap');
    check(cap.key === 'E', `key cap reads ${cap.key}, want E`);

    return { circle, rounded, toolAfterKey, toolAfterCtrlE, dented, fixed, renamed, tip, cap };
  },

  /**
   * The backdrop: a raster to trace over that is not part of the drawing.
   *
   * Needs a real browser twice over. The file arrives through a file input and
   * an object URL, neither of which exists in jsdom, and the thing worth
   * proving is that it renders *under* the artwork and never reaches the
   * export.
   */
  async backdrop(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`backdrop: ${what}`);
    };

    await tab(page, 'doc');

    // A 4x3 PNG, red, small enough to inline. Its aspect ratio is what the fit
    // has to preserve.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFElEQVR4nGP8z8Dwn4GKgImahg0dAwB5UgH9lUqlNwAAAABJRU5ErkJggg==';
    await page.setInputFiles('#backFile', {
      name: 'trace.png',
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    });
    await page.waitForTimeout(250);

    const placed = await page.$eval('.backdrop', (el) => ({
      x: +el.getAttribute('x'),
      y: +el.getAttribute('y'),
      w: +el.getAttribute('width'),
      h: +el.getAttribute('height'),
      opacity: +el.getAttribute('opacity'),
      hidden: el.getAttribute('display') === 'none',
    }));
    check(!placed.hidden, 'the backdrop did not appear');
    check(Math.abs(placed.w / placed.h - 4 / 3) < 0.01, `aspect is ${placed.w}x${placed.h}, want 4:3`);
    check(placed.opacity === 0.5, `opacity is ${placed.opacity}, want 0.5`);

    // Under the artwork, which is the entire point of a tracing reference.
    const first = await page.$eval('.artwork', (el) => el.firstElementChild.tagName.toLowerCase());
    check(first === 'image', `the artwork's first child is <${first}>, so the backdrop is not behind`);

    // It is workspace state, so the shape list and the export never see it.
    const shapes = await page.locator('#shapelist li').count();
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.waitForTimeout(150);
    const exported = await page.inputValue('#src');
    check(!/<image|base64|blob:/.test(exported), 'the backdrop leaked into the export');
    await closeSource(page);

    // Opacity and visibility are live.
    await page.fill('#backOpacity', '20');
    await page.dispatchEvent('#backOpacity', 'input');
    await page.waitForTimeout(120);
    const dimmed = await page.getAttribute('.backdrop', 'opacity');
    check(Math.abs(+dimmed - 0.2) < 1e-6, `opacity did not follow the field: ${dimmed}`);

    await page.uncheck('#backShow');
    await page.waitForTimeout(120);
    check((await page.getAttribute('.backdrop', 'display')) === 'none', 'hiding it did nothing');
    await page.check('#backShow');
    await page.waitForTimeout(120);

    // Unlocked, a canvas drag moves it instead of marquee-selecting.
    const before = await page.$eval('.backdrop', (el) => +el.getAttribute('x'));
    await page.uncheck('#backLock');
    await page.waitForTimeout(120);
    const { drag } = await mk(page);
    // Left of the starter shape, which spans 20..68 x 12..52, and inside the view.
    await drag([8, 45], [18, 45]);
    await page.waitForTimeout(150);
    const after = await page.$eval('.backdrop', (el) => +el.getAttribute('x'));
    check(after > before, `unlocked drag left x at ${after}`);
    check((await page.locator('.anchor.selected').count()) === 0, 'the unlocked drag also selected nodes');

    await page.click('#backClear');
    await page.waitForTimeout(150);
    const gone = await page.getAttribute('.backdrop', 'display');
    check(gone === 'none', 'Remove left the backdrop on screen');

    /* Removing is an edit, so it comes back. The interesting half is that the
       object URL behind it has to still resolve: freeing the bytes when the
       image left the screen would restore an <image> pointing at nothing, which
       looks identical to a working undo until you look at the canvas. */
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const restored = await page.$eval('.backdrop', (el) => ({
      display: el.getAttribute('display'),
      href: el.getAttribute('href') ?? el.getAttribute('xlink:href'),
    }));
    check(restored.display !== 'none', 'undo did not bring the backdrop back');
    const bytes = await page.evaluate(async (url) => {
      try {
        return (await (await fetch(url)).blob()).size;
      } catch {
        return -1;
      }
    }, restored.href);
    check(bytes > 0, `the restored image URL no longer resolves (${bytes})`);

    // One more takes back the drag, which was one entry however many moves it
    // was made of.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const rewound = await page.$eval('.backdrop', (el) => +el.getAttribute('x'));
    check(Math.abs(rewound - before) < 1e-6, `undoing the drag left x at ${rewound}, want ${before}`);

    return {
      placed,
      shapesWhileLoaded: shapes,
      movedBy: +(after - before).toFixed(3),
      restoredBytes: bytes,
      exportedLength: exported.length,
    };
  },

  /**
   * Rounding a corner that already exists, from the Node tab.
   *
   * The rectangle tool has had a corner radius since the primitives landed, and
   * it only ever applied while drawing. This is the same arc, afterwards, on
   * anything with two straight sides.
   */
  async roundCorners(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`roundCorners: ${what}`);
    };
    const { click } = await mk(page);

    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', 'M20 16 L64 16 L64 48 L20 48 Z');
    await page.click('#apply');
    await page.waitForTimeout(200);
    await closeSource(page);

    // Nothing selected, so no transform box stands between the pointer and the
    // corner nodes.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);

    // Two adjacent corners, selected on the canvas.
    await click([64, 16]);
    await click([64, 48], 'Shift');
    await page.waitForTimeout(120);

    await tab(page, 'node');
    await page.fill('#roundR', '6');
    await page.click('#roundCorner');
    await page.waitForTimeout(200);

    const stats = await page.textContent('#stats');
    check(/6 nodes/.test(stats), `after rounding two corners: "${stats}"`);
    const status = await page.textContent('#status');
    check(/Rounded 2 corners/.test(status), `status says "${status}"`);

    /* The corners are gone from the outline and the sides are still straight,
       which is what a fillet has to leave behind. */
    const d = await page.getAttribute('.artwork path', 'd');
    check(!/64 16/.test(d), `the sharp corner survived: ${d}`);
    check(/C /.test(d), `no arc was drawn: ${d}`);

    await undo(page);
    check(/4 nodes/.test(await page.textContent('#stats')), 'undo did not restore the square');

    return { stats, status, d };
  },

  /**
   * Fusing nodes, both readings of it.
   *
   * The defect this closes is invisible on screen: two anchors on the same point
   * draw exactly like one. So every check here is against something that can be
   * read back — the node count, the exported `d`, and whether Simplify will
   * touch the path at all, which is what a zero-length segment used to prevent.
   */
  async fuse(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`fuse: ${what}`);
    };
    const { click, drag } = await mk(page);

    // A square carrying a duplicate anchor at [64, 16], as an import would.
    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', 'M20 16 L64 16 L64 16 L64 48 L20 48 Z');
    await page.click('#apply');
    await page.waitForTimeout(200);
    await closeSource(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);

    const before = await page.textContent('#stats');
    check(/5 nodes/.test(before), `the duplicate anchor did not survive the parse: "${before}"`);

    /* The sweep reading: more than two nodes selected, so Fuse looks for
       zero-length segments rather than welding a chosen pair. Marquee from
       outside the shape. */
    await drag([8, 6], [76, 58]);
    await page.waitForTimeout(120);
    await tab(page, 'node');
    await page.click('#fuseNodes');
    await page.waitForTimeout(200);

    const swept = await page.textContent('#stats');
    const sweptStatus = await page.textContent('#status');
    check(/4 nodes/.test(swept), `after the sweep: "${swept}"`);
    check(/Fused 1 zero-length segment away/.test(sweptStatus), `status says "${sweptStatus}"`);

    /* The point of the repair, and the half a node count cannot show: the path
       is simplifiable again. A zero chord gives the fitter no tangent, so one
       duplicate anchor used to make the whole path refuse. */
    const d = await page.getAttribute('.artwork path', 'd');
    check(!/64\s+16\s+L\s*64\s+16/.test(d), `the duplicate anchor is still exported: ${d}`);

    await undo(page);
    check(/5 nodes/.test(await page.textContent('#stats')), 'undo did not put the duplicate back');
    await page.click('#fuseNodes');
    await page.waitForTimeout(200);

    // The pair reading: exactly two adjacent nodes, welded at their midpoint.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
    await click([20, 16]);
    await click([64, 16], 'Shift');
    await page.waitForTimeout(120);
    await page.click('#fuseNodes');
    await page.waitForTimeout(200);

    const pairStatus = await page.textContent('#status');
    check(/Fused the two nodes/.test(pairStatus), `pair status says "${pairStatus}"`);
    check(/3 nodes/.test(await page.textContent('#stats')), 'the pair did not become one node');
    const welded = await page.getAttribute('.artwork path', 'd');
    check(/42\b/.test(welded), `the survivor is not at the midpoint x=42: ${welded}`);

    /* Two free ends are the one case Fuse declines, because that is what Merge
       is for, and declining has to leave the document alone. */
    await openSource(page);
    await page.fill('#src', 'M10 10 L30 10 L30 30');
    await page.click('#apply');
    await page.waitForTimeout(200);
    await closeSource(page);
    await page.keyboard.press('Escape');
    await click([10, 10]);
    await click([30, 30], 'Shift');
    await page.waitForTimeout(120);
    const ends = await page.isDisabled('#fuseNodes');
    check(ends, 'Fuse offered itself for two free ends, which is Merge');

    return { before, swept, sweptStatus, pairStatus, d: welded };
  },

  /**
   * Auto-trace, end to end from a real PNG.
   *
   * The unit tests feed `traceImage` a plain object and never touch a canvas.
   * Everything between a file on disk and shapes in the document is only here:
   * decoding, `getImageData`, the backdrop's placement, and the undo step.
   */
  async trace(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`trace: ${what}`);
    };

    await tab(page, 'doc');

    /* A 64x64 picture with three flat colours and a hole: a red disc on a
       transparent ground, with a blue square punched through the middle of it.
       Transparent, so the background is a palette entry that paints nothing and
       has to be dropped rather than exported. */
    const buffer = png(64, 64, (x, y) => {
      const d = Math.hypot(x - 31.5, y - 31.5);
      if (x >= 24 && x < 40 && y >= 24 && y < 40) return [0, 0, 255, 255];
      return d < 26 ? [255, 0, 0, 255] : [0, 0, 0, 0];
    });
    await page.setInputFiles('#backFile', { name: 'icon.png', mimeType: 'image/png', buffer });
    await page.waitForTimeout(300);

    const info = await page.textContent('#traceinfo');
    check(info === '64 × 64 px', `trace readout says "${info}"`);

    const before = await page.$$eval('.artwork path', (els) => els.length);
    await page.click('#traceGo');
    await page.waitForTimeout(600);

    const status = await page.textContent('#status');
    check(/^Traced 2 colours into 3 paths/.test(status), `status says "${status}"`);

    const after = await page.$$eval('.artwork path', (els) => els.length);
    check(after === before + 2, `${after - before} shapes added, want 2`);

    /* The shapes carry the picture's own colours, and the transparent ground is
       not among them. */
    const fills = await page.$$eval('.artwork path', (els) =>
      els.map((el) => el.getAttribute('fill')),
    );
    check(fills.includes('#ff0000'), `no red shape: ${fills}`);
    check(fills.includes('#0000ff'), `no blue shape: ${fills}`);

    // The disc keeps its hole, as a second subpath under even-odd.
    const red = await page.$$eval('.artwork path', (els) => {
      const el = els.find((e) => e.getAttribute('fill') === '#ff0000');
      return { d: el.getAttribute('d'), rule: el.getAttribute('fill-rule') };
    });
    check((red.d.match(/M/g) ?? []).length === 2, `the disc has no hole: ${red.d}`);
    check(red.rule === 'evenodd', `fill-rule is ${red.rule}`);

    /* Traced onto the backdrop, not beside it. The disc fills most of a
       reference that was fitted into the page, so its box should sit inside the
       backdrop's and cover the bulk of it. */
    const place = await page.$eval('.backdrop', (el) => ({
      x: +el.getAttribute('x'),
      y: +el.getAttribute('y'),
      w: +el.getAttribute('width'),
      h: +el.getAttribute('height'),
    }));
    const box = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.artwork path')].find(
        (e) => e.getAttribute('fill') === '#ff0000',
      );
      const b = el.getBBox();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    check(box.x >= place.x - 0.5 && box.y >= place.y - 0.5, `traced at [${box.x},${box.y}], backdrop at [${place.x},${place.y}]`);
    check(box.w > place.w * 0.7, `traced disc is ${box.w} wide against a ${place.w} backdrop`);

    // The reference survives the trace, which is what makes comparing possible.
    const stillThere = await page.$eval('.backdrop', (el) => el.getAttribute('display') !== 'none');
    check(stillThere, 'tracing consumed the backdrop');

    // One undo step, however many shapes it added.
    await undo(page);
    const undone = await page.$$eval('.artwork path', (els) => els.length);
    check(undone === before, `undo left ${undone} paths, want ${before}`);

    return { status, fills, box, place, holes: (red.d.match(/M/g) ?? []).length };
  },

  /**
   * Pixel fit, and the one thing only a browser can check.
   *
   * The arithmetic is unit-tested. What is not is whether the grid you *see* is
   * the lattice you snap to: §9's defect, back at half a pixel and much harder
   * to spot by eye. So this reads the drawn gridlines out of the overlay and
   * compares them against where a dragged node actually landed.
   */
  async pixelFit(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`pixelFit: ${what}`);
    };
    const { drag } = await mk(page);

    await tab(page, 'doc');
    // Zoom in far enough that every snap position is drawn, or the comparison
    // below is against a thinned lattice and proves less than it looks.
    await page.fill('#gridStep', '1');
    await page.waitForTimeout(120);

    /* x of every vertical gridline, from the overlay's own `d`. Both paths:
       every fifth line is major and lives in the other element, so reading only
       `.grid-minor` reports a lattice with holes in it and the comparison below
       fails for a node that landed correctly. */
    const verticals = async () =>
      page.evaluate(() =>
        ['.grid-minor', '.grid-major']
          .flatMap((sel) => [
            ...(document.querySelector(sel)?.getAttribute('d') ?? '').matchAll(
              /M(-?[\d.]+) [-\d.]+V/g,
            ),
          ])
          .map((m) => +m[1])
          .sort((a, b) => a - b),
      );

    const plain = await verticals();
    check(plain.length > 3, `only ${plain.length} vertical gridlines to compare against`);
    check(plain.every((x) => Math.abs(x - Math.round(x)) < 1e-6), `plain grid is off-integer: ${plain.slice(0, 4)}`);

    // A one-unit stroke: the case where whole coordinates are the wrong answer.
    await tab(page, 'shape');
    await page.fill('#strokeWidth', '1');
    await page.waitForTimeout(120);
    await tab(page, 'doc');
    await page.click('#pixelFit');
    await page.waitForTimeout(150);

    const shifted = await verticals();
    check(
      shifted.every((x) => Math.abs(Math.abs(x - Math.round(x)) - 0.5) < 1e-6),
      `pixel fit did not move the drawn grid onto half-integers: ${shifted.slice(0, 4)}`,
    );
    const readout = await page.textContent('#gridreadout');
    check(/half pixels/.test(readout), `grid readout says "${readout}"`);

    /* And the half that matters: a node dragged with the switch on lands on the
       lattice that is drawn, not the one that was drawn before. */
    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', 'M20 20 L60 20 L60 44 Z');
    await page.click('#apply');
    await page.waitForTimeout(200);
    await closeSource(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);

    await drag([20, 20], [30.2, 28.4]);
    await page.waitForTimeout(200);
    const d = await page.getAttribute('.artwork path', 'd');
    const first = d.match(/M\s*(-?[\d.]+)\s+(-?[\d.]+)/);
    const landed = [+first[1], +first[2]];
    check(
      landed.every((v) => Math.abs(Math.abs(v - Math.round(v)) - 0.5) < 1e-6),
      `the dragged node landed at [${landed}], which is not on the drawn lattice`,
    );
    /* Against the lattice drawn *now*: applying source re-fits the camera, so
       the set captured before it names a different span of the same lattice. */
    const onScreen = await verticals();
    check(
      onScreen.includes(landed[0]),
      `x=${landed[0]} is not one of the drawn gridlines ${onScreen.slice(0, 6)}`,
    );

    // Fit selection moves what is already there onto the same lattice.
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(120);
    await page.click('#fitPixels');
    await page.waitForTimeout(200);
    const fitted = await page.getAttribute('.artwork path', 'd');
    const nums = [...fitted.matchAll(/-?[\d.]+/g)].map((m) => +m[0]);
    check(
      nums.every((v) => Math.abs(Math.abs(v - Math.round(v)) - 0.5) < 1e-6),
      `fit to pixels left coordinates off the lattice: ${fitted}`,
    );

    // Turning it off puts the drawn grid back where it was.
    await page.click('#pixelFit');
    await page.waitForTimeout(150);
    const back = await verticals();
    check(back.every((x) => Math.abs(x - Math.round(x)) < 1e-6), `grid stayed shifted: ${back.slice(0, 4)}`);

    return { plain: plain.slice(0, 4), shifted: shifted.slice(0, 4), landed, fitted, readout };
  },

  /**
   * Fill, stroke and width, and the tabs they live behind.
   *
   * Browser-only twice over: `<input type="color">` has no jsdom implementation
   * worth testing against, and the tabs are the thing that decides whether a
   * control exists at all as far as a pointer is concerned.
   */
  async style(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`style: ${what}`);
    };
    const { drag } = await mk(page);

    // Shape is the tab you land on, and the style controls are in it.
    check(await page.locator('#fillColour').isVisible(), 'the style controls are not on the first tab');
    check(!(await page.locator('#bendFlat').isVisible()), 'a node control is showing on the shape tab');

    /* Nothing selected: the panel describes the next shape rather than an
       existing one, and says so. */
    check(
      (await page.textContent('#styleinfo')) === 'for new shapes',
      `header says "${await page.textContent('#styleinfo')}"`,
    );
    await page.fill('#strokeWidth', '3');
    await page.waitForTimeout(120);
    const undoAfterDefault = await page.isDisabled('#undo');
    check(undoAfterDefault, 'choosing a colour for later landed on the undo stack');

    await page.click('#tool button[data-v="rect"]');
    await drag([10, 10], [40, 34]);
    await page.click('#tool button[data-v="select"]');
    await page.waitForTimeout(150);
    const drawnWidth = await page.evaluate(
      () => document.querySelectorAll('.artwork path')[1]?.getAttribute('stroke-width'),
    );
    // Widths are multiplied by the zoom on screen, so compare the ratio.
    const perUnit = await page.evaluate(
      () => document.querySelectorAll('.artwork path')[0]?.getAttribute('stroke-width'),
    );
    check(Math.abs(+drawnWidth / +perUnit - 3) < 0.01, `new shape drew at ${drawnWidth} not 3x ${perUnit}`);

    // Restyle a selection: the canvas, the swatch and the file all follow.
    await page.click('#shapelist li:nth-child(1)');
    await page.waitForTimeout(120);
    await page.fill('#fillColour', '#ff0000');
    await page.waitForTimeout(150);
    const painted = await page.getAttribute('.artwork path', 'fill');
    check(painted === '#ff0000', `the canvas painted ${painted}`);

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.waitForTimeout(200);
    check(/fill="#ff0000"/.test(await page.inputValue('#src')), 'the export kept the old fill');
    await closeSource(page);

    // `none` is a value the picker cannot hold, so the tick box holds it.
    await page.check('#fillNone');
    await page.waitForTimeout(150);
    check((await page.getAttribute('.artwork path', 'fill')) === 'none', 'ticking none left a fill');
    /* The picker stays usable while none is ticked, and using it is what clears
       it. Disabling it meant filling an unfilled shape took two steps, the first
       of which committed a colour nobody chose. */
    check(!(await page.isDisabled('#fillColour')), 'the picker went dead with none ticked');
    await page.fill('#fillColour', '#00aa44');
    await page.waitForTimeout(150);
    check((await page.getAttribute('.artwork path', 'fill')) === '#00aa44', 'picking a colour did not clear none');
    check(!(await page.isChecked('#fillNone')), 'the none tick survived a colour being picked');

    await undo(page);
    await undo(page);
    check((await page.getAttribute('.artwork path', 'fill')) === '#ff0000', 'undo did not bring the fill back');

    // And the tabs move.
    await tab(page, 'node');
    check(await page.locator('#bendFlat').isVisible(), 'the node tab did not open');
    check(!(await page.locator('#fillColour').isVisible()), 'the shape tab is still showing');
    check(
      (await page.getAttribute('#tab-node', 'aria-selected')) === 'true' &&
        (await page.getAttribute('#tab-shape', 'aria-selected')) === 'false',
      'the tabs disagree with what is on screen',
    );

    return { drawnWidth: +drawnWidth / +perUnit, painted };
  },

  /**
   * The document's canvas: drawn on screen, editable, and what gets exported.
   *
   * The complaint that prompted it was that the `viewBox` "does not update at
   * all, with anything" and the drawing did not fill it. Both were true and the
   * second was a symptom: nothing on screen said where the page was, so there
   * was no way to notice you were drawing in a corner of it.
   */
  async canvasFrame(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`canvasFrame: ${what}`);
    };

    await tab(page, 'doc');

    // Drawn, at the viewBox, with everything outside it dimmed.
    const edge = await page.$eval('.doc-edge', (el) => ({
      x: +el.getAttribute('x'),
      y: +el.getAttribute('y'),
      w: +el.getAttribute('width'),
      h: +el.getAttribute('height'),
    }));
    check(edge.x === 0 && edge.y === 0 && edge.w === 88 && edge.h === 64, `edge is ${JSON.stringify(edge)}`);
    const shade = await page.getAttribute('.doc-shade', 'd');
    check(/M0 0H88V64H0Z$/.test(shade), `the shade has no document-shaped hole: ${shade}`);
    // Filled overlay chrome that took clicks would break every other scenario.
    const blocks = await page.evaluate(() =>
      getComputedStyle(document.querySelector('.doc-shade')).pointerEvents,
    );
    check(blocks === 'none', `the shade takes pointer events (${blocks})`);

    const readout = await page.textContent('#stats');
    check(/^88 × 64 ·/.test(readout), `the readout says "${readout}"`);

    // The numbers are live, and typing one moves the frame.
    check((await page.inputValue('#vbw')) === '88', 'the width field disagrees with the document');
    await page.fill('#vbw', '120');
    await page.dispatchEvent('#vbw', 'input');
    await page.waitForTimeout(150);
    check((await page.getAttribute('.doc-edge', 'width')) === '120', 'the frame ignored the field');
    await undo(page);
    check((await page.getAttribute('.doc-edge', 'width')) === '88', 'undo did not restore the canvas');

    /* Fit. The starter shape spans 20..68 by 12..52, so with a grid step of one
       the page should land on exactly that. */
    await page.click('#vbFit');
    await page.waitForTimeout(200);
    const fitted = await page.$eval('.doc-edge', (el) => [
      +el.getAttribute('x'), +el.getAttribute('y'),
      +el.getAttribute('width'), +el.getAttribute('height'),
    ]);
    check(String(fitted) === '20,12,48,40', `fitted to ${fitted}, want 20,12,48,40`);

    // And that is what the file says, which was the whole complaint.
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.waitForTimeout(200);
    const svgText = await page.inputValue('#src');
    check(/viewBox="20 12 48 40"/.test(svgText), `export says ${svgText.slice(0, 90)}`);
    await closeSource(page);

    // Drawing outside the page is allowed, and says so where the fix lives.
    check((await page.textContent('#canvasinfo')) === '', 'it claims to spill before anything does');
    await page.fill('#vbw', '10');
    await page.dispatchEvent('#vbw', 'input');
    await page.waitForTimeout(200);
    const warn = await page.textContent('#canvasinfo');
    check(/outside/.test(warn), `no warning with the drawing outside: "${warn}"`);

    return { edge, fitted, warn };
  },

  /**
   * The transform box: eight scale handles, four rotation zones.
   *
   * This one is browser-only in every part. The handles are DOM elements, the
   * hit test is `e.target`, and the question that matters most cannot be asked
   * of geometry at all: a shape's own nodes sit on its bounding box, so does
   * clicking the corner of a rectangle still select the node, or does the
   * handle drawn near it swallow the click.
   */
  async transform(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`transform: ${what}`);
    };
    const { drag, click } = await mk(page);

    const bbox = () =>
      page.$eval('.artwork path', (el) => {
        const b = el.getBBox();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      });
    /** Centre of a handle, in document units, read off the element itself. */
    const at = (sel) =>
      page.$eval(sel, (el) => [
        +el.getAttribute('x') + +el.getAttribute('width') / 2,
        +el.getAttribute('y') + +el.getAttribute('height') / 2,
      ]);

    await page.click('#shapelist li');
    await page.waitForTimeout(150);

    check((await page.locator('.thandle:visible').count()) === 8, 'want eight scale handles');
    check((await page.locator('.rotor').count()) === 4, 'want four rotation zones');

    /* The handles are drawn outside the true bounds on purpose. If the padding
       ever goes, this is where it shows: the box would sit exactly on the
       shape's extremes. */
    const start = await bbox();
    const se = await at('.thandle[data-part="se"]');
    check(
      se[0] > start.x + start.w && se[1] > start.y + start.h,
      `the south-east handle is at [${se}], inside the bounds`,
    );

    // Scale: drag the south-east handle 24 units left. The north-west corner is
    // the anchor, so it must not move, and the height must not either.
    await drag(se, [se[0] - 24, se[1]]);
    await page.waitForTimeout(150);
    const scaled = await bbox();
    check(Math.abs(scaled.x - start.x) < 0.01, `x moved from ${start.x} to ${scaled.x}`);
    check(Math.abs(scaled.y - start.y) < 0.01, `y moved from ${start.y} to ${scaled.y}`);
    check(Math.abs(scaled.h - start.h) < 0.01, `height changed to ${scaled.h}`);
    check(Math.abs(scaled.w - (start.w - 24)) < 0.01, `width is ${scaled.w}, want ${start.w - 24}`);

    // One entry, however many moves the drag was made of.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);
    const back = await bbox();
    check(Math.abs(back.w - start.w) < 1e-6, `undo left the width at ${back.w}`);
    check((await page.evaluate(() => document.querySelector('.artwork path').getAttribute('d'))).length > 0, 'the shape survived');

    // Alt scales about the centre: both edges move, the middle does not.
    const centreBefore = start.x + start.w / 2;
    await drag(await at('.thandle[data-part="se"]'), [se[0] - 12, se[1]], 8, 'Alt');
    await page.waitForTimeout(150);
    const alt = await bbox();
    check(
      Math.abs(alt.x + alt.w / 2 - centreBefore) < 0.01,
      `centre moved from ${centreBefore} to ${alt.x + alt.w / 2}`,
    );
    check(alt.w < start.w, `Alt-drag did not shrink it: ${alt.w}`);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);

    // Shift keeps the ratio. Dragging inwards is the case that used to do
    // nothing at all, when the constrained factor was the larger of the two.
    const ratio = start.w / start.h;
    await drag(await at('.thandle[data-part="se"]'), [se[0] - 12, se[1]], 8, 'Shift');
    await page.waitForTimeout(150);
    const kept = await bbox();
    check(Math.abs(kept.w / kept.h - ratio) < 0.01, `ratio went from ${ratio} to ${kept.w / kept.h}`);
    check(kept.w < start.w, `Shift-drag inwards did nothing: ${kept.w}`);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);

    /* Rotate a quarter turn from the north-east corner's ring. Not from its
       centre: the scale handle sits there and is in front, which is the whole
       arrangement. Rotation is the ring around it, so the press goes near the
       zone's outer corner. Shift snaps the turn to fifteen degrees, so ninety
       is reachable exactly, and a quarter turn about the centre has to swap the
       two extents. */
    /* Zoom out first. Fitted to the window, this document fills the canvas top
       to bottom, and a quarter turn swings the corner a few pixels past the
       edge, where the harness rightly refuses to click. */
    await page.click('#zoomout');
    await page.waitForTimeout(150);

    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    const ne = await page.$eval('.rotor[data-part="ne"]', (el) => [
      +el.getAttribute('x') + +el.getAttribute('width') * 0.88,
      +el.getAttribute('y') + +el.getAttribute('height') * 0.12,
    ]);
    const r = Math.hypot(ne[0] - cx, ne[1] - cy);
    const a0 = Math.atan2(ne[1] - cy, ne[0] - cx);
    // Anticlockwise, because the clockwise landing point is a few pixels below
    // the canvas and the harness refuses to click what it cannot see.
    const to = [cx + r * Math.cos(a0 - Math.PI / 2), cy + r * Math.sin(a0 - Math.PI / 2)];
    await drag(ne, to, 10, 'Shift');
    await page.waitForTimeout(150);
    const turned = await bbox();
    const status = await page.textContent('#status');
    check(/Rotated -90°/.test(status), `status says "${status}"`);
    check(Math.abs(turned.w - start.h) < 0.02, `width is ${turned.w}, want the old height ${start.h}`);
    check(Math.abs(turned.h - start.w) < 0.02, `height is ${turned.h}, want the old width ${start.w}`);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);

    /* The question the padding exists to answer. A rectangle's corner node sits
       exactly on the bounding box, so an unpadded handle would be on top of it
       and would take every click aimed at the node. */
    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', 'M20 20 L60 20 L60 50 L20 50 Z');
    await page.click('#apply');
    await page.waitForTimeout(200);
    await closeSource(page);
    await page.click('#shapelist li');
    await page.waitForTimeout(150);

    await click([20, 20]);
    await page.waitForTimeout(150);
    // `:visible`, because the anchor pool keeps retired elements around with
    // whatever class they last had; counting those reports the node count of
    // the shape before this one.
    const selected = await page.locator('.anchor.selected:visible').count();
    check(selected === 1, `clicking the corner node selected ${selected} nodes, want 1`);

    // And the box goes away entirely for a tool that owns the canvas.
    await page.keyboard.press('p');
    await page.waitForTimeout(150);
    const withPen = await page.locator('.thandle:visible').count();
    check(withPen === 0, `${withPen} handles still showing under the pen`);

    return { start, scaled, turned, status };
  },

  /**
   * Simplify, end to end: the tolerance field, the button, and the drawing.
   *
   * The fitting itself is covered by unit tests. What only a browser can show
   * is that the tolerance follows the document it is opened on, and that the
   * shape on screen after the refit is still the shape that was there.
   */
  async simplify(page) {
    const check = (ok, what) => {
      if (!ok) throw new Error(`simplify: ${what}`);
    };

    // A forty-sided ring: what a trace or an imported polyline looks like.
    const n = 40;
    const r = 24;
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return `${(44 + r * Math.cos(a)).toFixed(3)} ${(32 + r * Math.sin(a)).toFixed(3)}`;
    });
    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', `M${pts[0]} ${pts.slice(1).map((p) => `L${p}`).join(' ')} Z`);
    await page.click('#apply');
    await page.waitForTimeout(200);
    await closeSource(page);

    const nodesIn = await page.textContent('#stats');
    check(/40 nodes/.test(nodesIn), `applying the dense ring gave "${nodesIn}"`);

    // A tolerance baked in at build time is wrong for every document but one,
    // so it is derived from this one's size.
    const tol = +(await page.inputValue('#simplifyTol'));
    check(tol > 0 && tol < 1, `tolerance defaulted to ${tol} on an 88x64 document`);

    const box = async () =>
      page.$eval('.artwork path', (el) => {
        const b = el.getBBox();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      });
    const before = await box();

    await page.click('#shapelist li');
    await page.waitForTimeout(120);
    await page.click('#simplify');
    await page.waitForTimeout(250);

    const status = await page.textContent('#status');
    const nodesOut = await page.textContent('#stats');
    const kept = +/(\d+) nodes/.exec(nodesOut)[1];
    check(kept < 40 && kept >= 4, `left ${kept} nodes`);

    // The ring is still a ring of the same size. A refit that quietly collapsed
    // it would also have passed the node count.
    const after = await box();
    const slack = tol * 2;
    for (const k of ['x', 'y', 'w', 'h']) {
      check(Math.abs(after[k] - before[k]) < slack, `${k} moved from ${before[k]} to ${after[k]}`);
    }

    // And it is one edit, not one per node.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    check(/40 nodes/.test(await page.textContent('#stats')), 'undo did not restore all forty nodes');

    return { tol, kept, status, before, after };
  },

  /**
   * The chrome contract: the canvas gets everything the panels are not using,
   * and the page itself never scrolls.
   *
   * Worth a scenario because both are invisible until they break -- a stray
   * margin or a min-height turns the window into a scrolling document again,
   * and every click coordinate in every other scenario shifts with it.
   */
  async chrome(page) {
    const canvasBox = async () => {
      const b = await page.locator('#canvas').boundingBox();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    };
    const settle = () => page.waitForTimeout(260);
    const check = (ok, what) => {
      if (!ok) throw new Error(`chrome: ${what}`);
    };
    /** Whether a collapsed panel can still be reached by Tab. */
    const reachable = (sel) =>
      page.$eval(sel, (el) => {
        const focusable = el.querySelectorAll('button, textarea, input, select, a[href]');
        // `inert` is inherited, so asking the container answers for all of them.
        return !el.inert && focusable.length > 0;
      });

    // Measured, not asserted from a literal. This used to be a hard-coded
    // `{rail: true, source: false}` returned as though it were an observation,
    // which no production change could ever contradict.
    const opened = {
      rail: (await page.getAttribute('#toggleRail', 'aria-pressed')) === 'true',
      source: (await page.getAttribute('#toggleSrc', 'aria-pressed')) === 'true',
    };
    check(opened.rail === true, 'the inspector should start open');
    check(opened.source === false, 'the source drawer should start closed');
    check(!(await reachable('#sourcepanel')), 'the closed drawer is still in the tab order');

    const both = await canvasBox();

    await page.click('#toggleSrc');
    await settle();
    const withSource = await canvasBox();
    check(await reachable('#sourcepanel'), 'the open drawer is not reachable by Tab');

    await page.click('#toggleRail');
    await settle();
    const noRail = await canvasBox();
    check(!(await reachable('#rail')), 'the collapsed inspector is still in the tab order');

    await page.click('#toggleSrc');
    await settle();
    const bare = await canvasBox();

    // Keyboard is the other way in, and must land in the same state.
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+e');
    await settle();
    const viaKeys = await canvasBox();

    const scroll = await page.evaluate(() => ({
      page: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      body: document.body.scrollHeight - document.body.clientHeight,
    }));
    /* Both README and ARCHITECTURE claimed this scenario asserted the page never
       scrolls. It printed two numbers and compared neither. */
    check(scroll.page <= 0, `the page scrolls by ${scroll.page}px`);
    check(scroll.body <= 0, `the body scrolls by ${scroll.body}px`);

    // A tooltip has to describe the control it belongs to, or a screen reader
    // gets nothing: `adopt()` removes the title and this is what replaces it.
    await page.hover('#fit');
    await page.waitForTimeout(320);
    const described = await page.getAttribute('#fit', 'aria-describedby');
    check(!!described, 'a shown tooltip does not describe its control');
    check(
      (await page.getAttribute(`#${described}`, 'aria-hidden')) === 'false',
      'the tooltip is hidden from the accessibility tree while shown',
    );

    // Leave it inverted, so the screenshot shows the other half of the palette.
    await page.click('#theme');
    await settle();

    return {
      opened,
      both,
      withSource,
      noRail,
      bare,
      viaKeys,
      described,
      widensWhenRailCloses: noRail.w > withSource.w,
      tallensWhenSourceCloses: bare.h > noRail.h,
      keysMatchButtons: viaKeys.w === both.w && viaKeys.h === withSource.h,
      pageScroll: scroll,
    };
  },

  /**
   * The grid contract, checked against a real layout engine: every line drawn
   * must sit on a snap position.
   */
  async gridHonesty(page) {
    await tab(page, 'doc');
    const check = async (step, zoomOuts) => {
      await page.fill('#gridStep', String(step));
      await page.dispatchEvent('#gridStep', 'input');
      for (let i = 0; i < zoomOuts; i++) await page.click('#zoomout');
      await page.waitForTimeout(120);

      const r = await page.evaluate((s) => {
        const xs = [];
        for (const cls of ['grid-minor', 'grid-major']) {
          const d = document.querySelector(`.${cls}`)?.getAttribute('d') ?? '';
          for (const m of d.matchAll(/M(-?[\d.e-]+) [-\d.e]+V/g)) xs.push(Number(m[1]));
        }
        const offLattice = xs.filter((x) => Math.abs(x / s - Math.round(x / s)) > 1e-6);
        return { lines: xs.length, offLattice: offLattice.slice(0, 5), readout: null };
      }, step);
      r.readout = await page.textContent('#gridval');
      return r;
    };

    const out = {};
    out.step1 = await check(1, 0);
    out.step1_zoomedOut = await check(1, 6);
    await page.click('#fit');
    out.step0_3 = await check(0.3, 0);
    out.step0_3_zoomedOut = await check(0.3, 5);
    await page.click('#fit');
    out.step2_5 = await check(2.5, 2);
    return out;
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
/* The window shape decides how much of the document is on screen: the camera is
   fitted to the canvas box, so a squarer canvas shows a narrower span of x and
   the scenarios' coordinates start falling outside it. This is sized so the
   canvas keeps an aspect near 1.65 with the inspector open, which is what the
   hard-coded document coordinates below assume. */
const page = await browser.newPage({ viewport: { width: 1600, height: 860 } });

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
