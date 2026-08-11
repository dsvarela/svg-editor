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

  return { box, toClient, click, drag, showCanvas };
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
    await page.check('#filled');
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

    // The starter shape lives inside 20..68 x 12..52; sweep well past it.
    await drag([8, 9], [79, 55]);
    await page.waitForTimeout(120);
    const selected = await page.textContent('#selinfo');
    const anchorsSelected = await page.locator('.anchor.selected').count();

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
    check(/Circularised 1 contour/.test(fixed.status), `unexpected status: ${fixed.status}`);
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

    const opened = { rail: true, source: false };
    const both = await canvasBox();

    await page.click('#toggleSrc');
    await settle();
    const withSource = await canvasBox();

    await page.click('#toggleRail');
    await settle();
    const noRail = await canvasBox();

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
