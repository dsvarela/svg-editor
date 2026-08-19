/**
 * Drive the editor in a real browser.
 *
 *   node tools/drive.mjs <scenario> [--headed] [--out shot.png]
 *   node tools/drive.mjs --list
 *
 * The browser is whatever `tools/browser.mjs` resolves, Firefox by default.
 * Console messages and page errors are captured and printed -- that is how the
 * pen-tool crash was first spotted.
 */

import { launch, APP_URL } from './browser.mjs';
import zlib from 'node:zlib';

/* Which browser, and where the app is, live in `tools/browser.mjs`, which says
   why. */

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
    await laidOut(page); // the drawer animates, and the canvas re-fits
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
  await laidOut(page);
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
  await settle(page);
  /* Open every group in the panel that just appeared. Groups collapse now, and
     a control inside a shut one is genuinely not there -- `hidden` keeps it out
     of the hit test and out of the tab order, which is the point. A person
     opens the group they want; a scenario asking for a control by id has said
     which group it wants by saying which control. */
  await page.evaluate((id) => {
    for (const h of document.querySelectorAll(`#panel-${id} button.glabel`)) {
      if (h.getAttribute('aria-expanded') !== 'true') h.click();
    }
  }, name);
  await settle(page);
}

/**
 * Press Ctrl+Z, meaning the editor's undo, from nowhere in particular.
 *
 * The blur is what makes it mean that unambiguously. `Ctrl`+`Z` does reach the
 * document from a number field, and from anything you type text into it belongs
 * to the text -- so a scenario pressing it with focus wherever the last step left
 * it is asserting on whichever of the two that happened to be. Blurring first
 * asks for the one this helper is named after. `undoFromField` is where the split
 * itself is under test.
 */
async function undo(page) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press('Control+z');
  await settle(page);
}

/**
 * The document's own counters, as three numbers.
 *
 * Read out of the status strip because that is where the app publishes them,
 * so a scenario asserting on these is asserting on something a person can see.
 * The separators are non-breaking, which is why this matches digits and a word
 * rather than splitting on punctuation.
 */
async function counts(page) {
  const text = await page.textContent('#stats');
  const read = (word) => {
    const m = new RegExp(`(\\d+)\\s+${word}`).exec(text);
    return m ? Number(m[1]) : null;
  };
  /* `saw` goes into every message asserted against these, because a `null` here
     means the strip did not read as a strip, and that is a different failure
     from the wrong number of shapes. A run of this failed once in CI, was not
     reproducible, and could not be diagnosed afterwards: `check` replaces the
     result with its error, so the text that would have said which of the two it
     was had already been thrown away. */
  const saw = ` (#stats reads ${JSON.stringify(text)})`;
  return { shapes: read('shapes?'), nodes: read('nodes?'), segments: read('segments?'), text, saw };
}

/**
 * Wait for a control to gain the tooltip that describes it, and return its id.
 *
 * The tooltip opens on a delay the app owns, so a frame is too early. Throws on
 * timeout, which fails the scenario exactly as an assertion on the missing
 * attribute would.
 */
const describedBy = async (page, selector) => {
  await page.waitForFunction(
    (sel) => !!document.querySelector(sel)?.getAttribute('aria-describedby'),
    selector,
  );
  return page.getAttribute(selector, 'aria-describedby');
};

/** Wait until the backdrop's size is known, which is a decode, not a frame. */
const backdropRead = (page) =>
  page.waitForFunction(() => /\d+ . \d+ px/.test(document.querySelector('#traceinfo')?.textContent ?? ''));

/** Wait until the tracer has finished, which is a worker, not a frame. */
const traced = (page) =>
  page.waitForFunction(() => !/^Tracing/.test(document.querySelector('#status')?.textContent ?? ''));

/**
 * Wait for the editor to have drawn whatever the last action asked for.
 *
 * The controller renders one `requestAnimationFrame` after a store
 * notification, so two frames is past any render the event scheduled.
 *
 * **Never a fixed sleep**: a guess about how long a machine takes is either
 * slower than it needs to be or shorter than the thing it waits for.
 *
 * Not enough where the work continues off the event -- a worker, a file read,
 * an image decode. Those wait on their own result.
 */
const settle = (page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );

/**
 * Wait for the canvas to stop resizing.
 *
 * The panels animate, so opening or closing one leaves the canvas moving for
 * several frames after the render that started it. Anything converting document
 * coordinates to client pixels reads that box, and a scenario that clicks
 * mid-transition aims at where the canvas was.
 *
 * Polled rather than waiting for `transitionend`, which does not fire for a
 * property whose value did not change -- and a panel toggle that leaves the
 * canvas width alone is exactly the case that would hang.
 */
async function laidOut(page) {
  const box = () => page.locator('#canvas').boundingBox();
  let last = null;
  for (let i = 0; i < 40; i++) {
    const now = await box();
    if (last && Math.round(now.width) === last.w && Math.round(now.height) === last.h) return;
    last = { w: Math.round(now.width), h: Math.round(now.height) };
    await page.waitForTimeout(25);
  }
}

/**
 * The path data the canvas drew for a shape, by its position in the artwork.
 *
 * What reached the DOM, which is the thing a person is looking at. The source
 * box is not that: it rewrites itself only while the drawer is open, so
 * reading `#src` with the drawer shut returns the empty string for every
 * document and an assertion on it holds no matter what the editor did.
 */
const drawnPath = (page, index = 0) =>
  page.getAttribute(`.artwork path:nth-child(${index + 1})`, 'd');

/** Canvas-relative click helper: takes document coords, converts via the page. */
async function mk(page) {
  const box = await page.locator('#canvas').boundingBox();

  /**
   * Document coords -> client pixels, asked of the page itself.
   *
   * Rounded to whole pixels, because a browser delivers whole pixels. Firefox
   * truncates a fractional pointer coordinate and Chromium keeps it, so asking
   * for 656.887 puts the pointer in a different place on each engine and every
   * assertion about sub-pixel geometry inherits the difference. Rounding here
   * makes the number this returns the number the page will actually see, which
   * is what lets `toDoc` invert it.
   */
  const toClient = async (doc) =>
    page.evaluate(([x, y]) => {
      const svg = document.querySelector('.overlay');
      const m = svg.getScreenCTM();
      const p = new DOMPoint(x, y).matrixTransform(m);
      return [Math.round(p.x), Math.round(p.y)];
    }, doc);

  /**
   * Client pixels -> document coords: where a pointer at that pixel really is.
   *
   * For the scenarios that check where a gesture landed to better than a pixel.
   * The point asked for and the point delivered differ by up to half a pixel,
   * so an expectation computed from the first is wrong by that much, and a
   * tolerance loose enough to absorb it stops distinguishing anything.
   */
  const toDoc = async (client) =>
    page.evaluate(([x, y]) => {
      const svg = document.querySelector('.overlay');
      const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
      return [p.x, p.y];
    }, client);

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
    await settle(page);
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

  return { box, toClient, toDoc, click, drag, showCanvas };
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
  async smoke(page, check) {
    const c = await counts(page);
    /* The starting document, which every other scenario builds on. If this is
       not what loaded then no reading taken after it means what it says. */
    check(c.shapes === 1, `loaded ${c.shapes} shapes, expected 1${c.saw}`);
    check(c.nodes === 8, `loaded ${c.nodes} nodes, expected 8${c.saw}`);
    check(c.segments === 8, `${c.segments} segments across 8 nodes, so it is not closed${c.saw}`);
    return c;
  },

  /**
   * The reported session: draw a polygon with the pen, close it by clicking the
   * first node, then keep clicking -- which starts a second shape.
   */
  async penPolygon(page, check) {
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

    const c = await counts(page);
    /* Two shapes on top of the one that was loaded: the closed polygon, and
       the one the click after the close began. Five nodes and two, and the
       polygon closing rather than adding a sixth is the whole point -- a close
       that stamped another node would read as 16 here. */
    check(c.shapes === 3, `${c.shapes} shapes, expected the loaded one plus two`);
    check(c.nodes === 15, `${c.nodes} nodes, expected 8 + 5 + 2`);
    check(c.segments === 14, `${c.segments} segments: the polygon did not close`);
    return c;
  },

  /** Same, but with small accidental drags on each click. */
  async penWithDrags(page, check) {
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

    const c = await counts(page);
    /* A small drag on a pen click pulls a handle; it does not place a second
       node. Five clicks that each wobbled are still five nodes, and 18 here
       would mean each drag had stamped one of its own. */
    check(c.shapes === 2, `${c.shapes} shapes, expected the loaded one plus one`);
    check(c.nodes === 13, `${c.nodes} nodes, expected 8 + 5`);
    return c;
  },

  /** Select a node and pull a hollow ghost handle out into a curve. */
  async latentHandle(page, check) {
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
    await settle(page);
    const ghosts = await page.locator('.handle-dot.latent').count();
    const solid = await page.locator('.handle-dot:not(.latent)').count();
    await drag([46.67, 20], [46, 12]);
    await settle(page);
    const solidAfter = await page.locator('.handle-dot:not(.latent)').count();

    /* A selected node on a straight run offers two hollow handles and no solid
       ones: nothing to grab yet, and something to pull. Pulling one makes that
       one real and leaves its partner hollow. */
    check(ghosts === 2, `${ghosts} ghost handles offered, expected two`);
    check(solid === 0, `${solid} solid handles before anything was pulled`);
    check(solidAfter === 1, `${solidAfter} solid handles after pulling one`);
    return { ghostsBefore: ghosts, solidBefore: solid, solidAfter, ...(await counts(page)) };
  },

  /** Undo past a pen shape then keep drawing -- the old crash. */
  async penUndo(page, check) {
    const { click } = await mk(page);
    await page.click('#tool button[data-v="pen"]');
    await click([20, 20]);
    await click([50, 20]);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await click([30, 40]);
    await click([60, 40]);

    const c = await counts(page);
    /* Three undos take back more than the two clicks placed, so the shape they
       started goes with them and the pair drawn afterwards is a new one. An
       undo that stopped short would leave 3 shapes here, and one that ran on
       into the loaded document would leave 1. */
    check(c.shapes === 2, `${c.shapes} shapes, expected the loaded one plus one`);
    check(c.nodes === 10, `${c.nodes} nodes, expected 8 + 2`);
    return c;
  },

  /**
   * A point is a point: no type is chosen, the handles decide.
   *
   * Draws a node with mirrored handles, drags one (the other should follow),
   * then Alt-drags it (the other should not), and reads the inspector's
   * continuity badge at each step.
   */
  async continuity(page, check) {
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
    await settle(page);
    const asDrawn = { badge: await badge(), d: await page.inputValue('#src') };

    // Plain drag of the outgoing handle: the incoming one should mirror it.
    await drag([50, 20], [62, 26]);
    await settle(page);
    const mirrored = { badge: await badge(), d: await page.inputValue('#src') };

    // Alt-drag the same handle: the far one should now stay where it is.
    await drag([62, 26], [64, 46], 8, 'Alt');
    await settle(page);
    const broken = { badge: await badge(), d: await page.inputValue('#src') };

    /* The badge is derived from where the handles are and never stored, so
       these three readings are the whole claim: a dragged handle carries its
       partner until Alt says otherwise. */
    check(asDrawn.badge === 'Symm', `drawn with mirrored handles, badge reads ${asDrawn.badge}`);
    check(mirrored.badge === 'Symm', `after a plain drag the badge reads ${mirrored.badge}`);
    check(broken.badge === 'Cusp', `after an Alt drag the badge reads ${broken.badge}`);
    return { asDrawn, mirrored, broken };
  },

  /** Select two neighbouring nodes and bend the segment between them. */
  async bend(page, check) {
    const { click, drag } = await mk(page);
    await page.click('#tool button[data-v="pen"]');
    for (const p of [[20, 20], [60, 20], [60, 50]]) await click(p);
    await page.keyboard.press('Escape');
    await page.click('#tool button[data-v="select"]');
    await click([20, 20]);
    await page.keyboard.down('Shift');
    await click([60, 20]);
    await page.keyboard.up('Shift');
    await settle(page);

    const before = {
      info: await page.textContent('#bendinfo'),
      angle: await page.inputValue('#bendAngle'),
      controls: await page.locator('.bend-dot').count(),
    };
    /* Two adjacent anchors selected name one segment between them, so there is
       exactly one control to aim at. Two would mean the segments trailing off
       either end had been included. */
    check(before.controls === 1, `${before.controls} bend controls for one segment`);
    check(Number(before.angle) === 0, `a straight segment reports ${before.angle}° of bend`);
    // The bend control sits at the curve midpoint, which for a flat segment is
    // the chord midpoint.
    await drag([40, 20], [40, 8]);
    await settle(page);
    const dragged = {
      angle: await page.inputValue('#bendAngle'),
      loose: await page.inputValue('#bendLoose'),
      d: await drawnPath(page, 1),
    };
    check(Number(dragged.angle) < -40, `dragging the control bent the segment to ${dragged.angle}°`);
    check(/[CS]/.test(dragged.d), `the bent segment is still drawn straight: ${dragged.d}`);

    await tab(page, 'node');
    await page.fill('#bendAngle', '45');
    await page.keyboard.press('Enter');
    await settle(page);
    const typed = { angle: await page.inputValue('#bendAngle'), d: await drawnPath(page, 1) };
    check(typed.angle === '45', `typing 45 left the field reading ${typed.angle}`);
    check(typed.d !== dragged.d, 'typing an angle redrew nothing');

    await page.click('#bendFlat');
    await settle(page);
    const flattened = { angle: await page.inputValue('#bendAngle'), d: await drawnPath(page, 1) };
    check(Number(flattened.angle) === 0, `flatten left the angle at ${flattened.angle}`);
    check(!/[CS]/.test(flattened.d), `flatten left a curve behind: ${flattened.d}`);
    return { before, dragged, typed, flattened };
  },

  /** Paste a real multi-element icon and Apply it. */
  async pasteIcon(page, check) {
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill('#src', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect x="2" y="4" width="20" height="16" rx="3" fill="none" stroke="#2563d8" stroke-width="1.5"/>
  <circle cx="8" cy="10" r="2" fill="#e8a54b" stroke="none"/>
  <path d="M4 18 L10 12 L14 16 L17 13 L20 16" fill="none" stroke="#2563d8" stroke-width="1.5"/>
</svg>`);
    await page.click('#apply');
    await settle(page);
    const shapes = await page.locator('#shapelist li').allTextContents();
    const stats = await page.textContent('#stats');
    const status = await page.textContent('#status');
    const roundTrip = await page.inputValue('#src');

    /* Three elements in, three shapes out, and the round trip writes three
       paths back. Concatenating the elements into one `d` on the way in keeps
       every curve and loses the boundaries, so the drawing looks right and the
       Shapes list holds one entry -- which is why the count and the list are
       both read here and the geometry is not. */
    check(/3 shapes/.test(stats), `imported as "${stats}"`);
    check(status === 'Imported 3 shapes.', `status reads "${status}"`);
    check(shapes.length === 3, `the Shapes list holds ${shapes.length} entries`);
    check((roundTrip.match(/<path /g) ?? []).length === 3, 'the export did not write three paths');
    check(/viewBox="0 0 24 24"/.test(roundTrip), 'the icon viewBox did not survive the round trip');
    return { stats, status, shapes, roundTrip };
  },

  /** Apply the source box with two shapes present. */
  async applyTwoShapes(page, check) {
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
    await settle(page);
    const afterUnscoped = await page.textContent('#stats');
    const hintUnscoped = await page.textContent('#srchint');

    // Now with one shape selected, `d` mode should touch only that shape.
    /* Forgotten first, because a reload is not a reset any more: the session is
       written to storage as you work and read back on load, so this would open
       on the three shapes above rather than on the starter. §59.
       The editor's own button rather than `localStorage.clear()`, which does not
       hold: the page flushes the session on `pagehide`, so a reload writes it
       straight back over anything the harness removed. Forgetting latches. */
    await page.evaluate(() => document.querySelector('#forgetSession').click());
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#tool button[data-v="pen"]');
    const mk2 = await mk(page);
    for (const p of [[20, 20], [40, 20], [40, 40]]) await mk2.click(p);
    await page.keyboard.press('Escape');
    await page.click('#shapelist li:nth-child(2)');
    await settle(page);
    const scopedBefore = await page.textContent('#stats');
    const scopedHint = await page.textContent('#srchint');
    /* After the drawer opens, not before. The box only rewrites itself while
       it is showing, so reading it shut returns the empty string whatever is
       selected, and an assertion on that would hold for every document. */
    await openSource(page);
    const shown = await page.inputValue('#src');
    await page.fill('#src', 'M 20 20 L 45 20 L 45 45 L 20 45 Z');
    await page.click('#apply');
    await settle(page);
    const scopedAfter = await page.textContent('#stats');
    const scopedStatus = await page.textContent('#status');

    /* Apply means two different things and says which in the hint. With
       nothing selected it replaces the document, so three shapes become the
       one the box described. With a shape selected it rewrites that shape and
       leaves the other alone, so the count does not move. */
    check(/3 shapes/.test(before), `drew ${before}`);
    check(/1 shape\b/.test(afterUnscoped), `an unscoped Apply left ${afterUnscoped}`);
    check(hintUnscoped === 'Apply replaces the document.', `hint reads "${hintUnscoped}"`);
    check(scopedHint === 'Apply updates shape-2 only.', `scoped hint reads "${scopedHint}"`);
    check(shown === 'M 20 20 H 40 V 40', `the box showed "${shown}" for the selected shape`);
    check(/2 shapes/.test(scopedAfter), `a scoped Apply left ${scopedAfter}`);
    check(scopedStatus === 'Updated shape-2.', `status reads "${scopedStatus}"`);
    return {
      before, afterUnscoped, hintUnscoped,
      scopedBefore, scopedHint, shownForSelected: shown,
      scopedAfter, scopedStatus,
    };
  },

  /** Combine two overlapping squares, one operation at a time, undoing between. */
  async combine(page, check) {
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
    await settle(page);

    const selectBoth = async () => {
      await page.click('#shapelist li:nth-child(1)');
      await page.click('#shapelist li:nth-child(2)', { modifiers: ['Shift'] });
      await settle(page);
    };

    // With nothing selected the buttons must be unreachable, not merely inert.
    const disabledWhenIdle = await page.isDisabled('[data-bool="unite"]');
    await selectBoth();
    const enabledWithTwo = await page.isEnabled('[data-bool="unite"]');

    const runs = {};
    for (const op of ['unite', 'subtract', 'intersect', 'exclude']) {
      await selectBoth();
      await page.click(`[data-bool="${op}"]`);
      await settle(page);
      runs[op] = {
        status: await page.textContent('#status'),
        stats: await page.textContent('#stats'),
        // The survivor must keep the FIRST operand's fill (#2563d8), not the
        // second's (#e8a54b) and not a default.
        fill: await page.getAttribute('.artwork path', 'fill'),
        shapes: await page.locator('#shapelist li').allTextContents(),
        d: await page.getAttribute('.artwork path', 'd'),
        /* Enclosed area, sampled at the centre of every unit square, which is
           exact for these axis-aligned integer polygons. `isPointInFill` is the
           browser's own answer with the fill rule applied, so an `exclude` that
           came out as one ring rather than two reads differently here. A `d`
           string cannot say this: four operations that all produced the same
           shape would still have four different strings if the contours were
           ordered differently. */
        area: await page.evaluate(() => {
          const p = document.querySelector('.artwork path');
          let n = 0;
          for (let x = 0.5; x < 40; x++) {
            for (let y = 0.5; y < 40; y++) if (p.isPointInFill(new DOMPoint(x, y))) n++;
          }
          return n;
        }),
      };
      await page.keyboard.press('Control+z');
      await settle(page);
      runs[op].afterUndo = await page.textContent('#stats');
    }

    check(disabledWhenIdle, 'the boolean buttons are reachable with nothing selected');
    check(enabledWithTwo, 'the boolean buttons stayed disabled with two shapes selected');

    /* Two 20 by 20 squares overlapping in a 10 by 10 corner. Each operation has
       one area and no two share it, so this is the whole claim in four numbers:
       400 + 400 - 100 united, 400 - 100 subtracted, the overlap intersected,
       and the union less the overlap excluded. */
    const WANT = { unite: 700, subtract: 300, intersect: 100, exclude: 600 };
    for (const [op, want] of Object.entries(WANT)) {
      const r = runs[op];
      check(r.area === want, `${op} enclosed ${r.area} square units, want ${want}`);
      check(
        r.fill === '#2563d8',
        `${op} kept ${r.fill}, so the survivor did not take the first operand's fill`,
      );
      check(r.status === `${op[0].toUpperCase()}${op.slice(1)}: 2 shapes → 1 path.`, `${op} said "${r.status}"`);
      check(r.shapes.length === 1, `${op} left ${r.shapes.length} shapes in the list`);
      check(/2 shapes/.test(r.afterUndo), `undoing ${op} left "${r.afterUndo}"`);
    }

    /* The same four operations one level down, between the paths of one shape.
       §64. Only a browser can show this half: the operands are chosen by
       opening a shape's row and clicking the paths inside it, and which of the
       two readings a selection asks for is decided from that selection.

       **Even-odd, and that is what makes the areas measurements.** Under
       nonzero, two overlapping contours already render as their union, so the
       area after Unite is the area before it and the check passed whether or
       not the operation ran. Under even-odd the overlap is a hole to start
       with, and three of the four results are a different number from the
       starting picture. */
    const fixture = async () => {
      await openSource(page);
      await page.click('#srcmode button[data-v="svg"]');
      await page.fill(
        '#src',
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40">
  <path d="M0 0 H20 V20 H0 Z M10 10 H30 V30 H10 Z M60 5 H70 V15 H60 Z" fill="#2563d8" fill-rule="evenodd"/>
</svg>`,
      );
      await page.click('#apply');
      await closeSource(page);
      await tab(page, 'shape');
      await settle(page);
    };
    const enclosed = () =>
      page.evaluate(() => {
        const p = document.querySelector('.artwork path');
        let n = 0;
        for (let x = 0.5; x < 80; x++) {
          for (let y = 0.5; y < 40; y++) if (p.isPointInFill(new DOMPoint(x, y))) n++;
        }
        return n;
      });

    await fixture();
    check(await page.isDisabled('[data-bool="unite"]'), 'Unite was live with nothing selected');

    /* The picture before any of them: two 20 by 20 squares overlapping in a
       10 by 10 corner, drawn even-odd so that corner is a hole, plus a loose
       10 by 10 square that is never an operand. 600 + 100. */
    const startArea = await enclosed();
    check(startArea === 700, `the even-odd fixture encloses ${startArea} square units, want 700`);

    /* Three of the four are a different number from that. Exclude is not, and
       cannot be: even-odd rendering of two overlapping contours IS the
       symmetric difference, so the operation changes the geometry and not the
       picture. Its row count is what carries it, and it is named here rather
       than left to look like the others. */
    const WITHIN = { unite: 800, subtract: 400, intersect: 200, exclude: 700 };
    const within = {};
    let withinStatus = '';
    let header = '';
    for (const [op, want] of Object.entries(WITHIN)) {
      await fixture();
      // Open the shape to reach its paths, which is what makes them selectable.
      await page.click('#shapelist li.shape > .twist');
      await settle(page);
      const paths = await page.locator('#shapelist li.path').count();
      check(paths === 3, `the shape opened to ${paths} path rows, want 3`);

      await page.click('#shapelist li.path:nth-child(1)');
      await settle(page);
      check(await page.isDisabled(`[data-bool="${op}"]`), `${op} was live on one path`);
      await page.click('#shapelist li.path:nth-child(2)', { modifiers: ['Shift'] });
      await settle(page);
      check(
        !(await page.isDisabled(`[data-bool="${op}"]`)),
        `${op} stayed dead on two paths of one shape`,
      );
      header = (await page.textContent('#boolinfo')).trim();
      check(header === 'paths of one shape', `the Combine header says "${header}"`);

      await page.click(`[data-bool="${op}"]`);
      await settle(page);
      withinStatus = (await page.textContent('#status')).trim();
      const name = `${op[0].toUpperCase()}${op.slice(1)}`;
      check(
        new RegExp(`^${name}: 2 paths of `).test(withinStatus),
        `${op} on two paths said "${withinStatus}"`,
      );
      const shapeRows = await page.locator('#shapelist li.shape').count();
      check(shapeRows === 1, `${op} on two paths of one shape left ${shapeRows} shapes`);

      /* Sampled rather than compared as a `d` string, because a string cannot
         say whether a region survived: the loose square was not an operand and
         has to be exactly where it was. */
      within[op] = await enclosed();
      check(within[op] === want, `${op} within one shape encloses ${within[op]}, want ${want}`);

      /* Two operands become one path, so the row count falls by one whatever
         the areas say. This is the whole of what separates Exclude from having
         done nothing. Counted rather than re-opened: which shapes are open is
         not in the store, so the disclosure survives the edit. */
      const after = await page.locator('#shapelist li.path').count();
      check(after === 2, `${op} left ${after} path rows, want 2`);

      await page.keyboard.press('Control+z');
      await settle(page);
      const backTo3 = await page.locator('#shapelist li.path').count();
      check(backTo3 === 3, `undo after ${op} left ${backTo3} path rows, want 3`);
    }

    return { disabledWhenIdle, enabledWithTwo, runs, startArea, within, withinStatus };
  },

  /**
   * The reported gesture: marquee everything, press Delete.
   *
   * Three nodes survive if the per-node floor that stops a path degenerating
   * under single-node edits is also allowed to apply to "delete all of them".
   */
  async marqueeDelete(page, check) {
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
    await settle(page);
    const far = await strokeMidDrag();
    for (let i = 0; i < 12; i++) await page.click('#zoomin');
    await settle(page);
    if (Math.abs(near - far) > 0.01) {
      throw new Error(`marquee stroke is ${near}px near and ${far}px far; it must not scale`);
    }
    await page.click('#fit');
    await settle(page);

    // The starter shape lives inside 20..68 x 12..52; sweep well past it.
    await drag([8, 9], [79, 55]);
    await settle(page);
    const selected = await page.textContent('#selinfo');
    const anchorsSelected = await page.locator('.anchor.selected').count();
    const marqueeStroke = { near, far };

    await page.click('#del');
    await settle(page);
    const afterButton = await page.textContent('#stats');

    // And again through the key, which is a separate entry point.
    await page.keyboard.press('Control+z');
    await settle(page);
    await drag([8, 9], [79, 55]);
    await page.keyboard.press('Delete');
    await settle(page);

    const afterKey = await page.textContent('#stats');

    /* A sweep past the whole shape takes all eight of its anchors, and both
       ways of asking then clear the document. The button and the key are
       separate entry points, so a fix that reached one of them leaves the
       other reading 1 shape here. */
    check(anchorsSelected === 8, `${anchorsSelected} anchors caught by a sweep past the shape`);
    check(/0 shapes/.test(afterButton), `the Delete button left ${afterButton}`);
    check(/0 shapes/.test(afterKey), `the Delete key left ${afterKey}`);
    return {
      selected,
      anchorsSelected,
      marqueeStroke,
      afterButton,
      afterKey,
      status: await page.textContent('#status'),
    };
  },

  /**
   * A three-node closed loop: the smallest case the old floor refused outright.
   * Deleting a node must reduce it, and breaking must open it.
   */
  async smallClosedPath(page, check) {
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
      await settle(page);
      // Filling the source box scrolled it into view and the canvas off screen.
      await showCanvas();
    };

    await load();
    const start = await page.textContent('#stats');

    // Delete one of the three, which a per-node floor would refuse.
    await click([20, 45]);
    await settle(page);
    await page.click('#del');
    await settle(page);
    const afterDelete = {
      stats: await page.textContent('#stats'),
      d: await page.getAttribute('.artwork path', 'd'),
    };

    // Break the same loop open at a node instead of deleting one.
    await load();
    await click([45, 12]);
    await settle(page);
    await tab(page, 'node');
    await page.click('#breakPath');
    await settle(page);

    const afterBreak = await page.getAttribute('.artwork path', 'd');
    const breakStatus = await page.textContent('#status');

    /* A closed triangle is the smallest thing delete can act on without
       destroying it: three nodes go to two and the path stays closed, which is
       the `Z`. Breaking at a node opens it, and an open path has no `Z` to
       write -- if one survives here the break did nothing and the status line
       is lying. */
    check(/3 nodes/.test(start), `started from ${start}`);
    check(/2 nodes/.test(afterDelete.stats), `delete left ${afterDelete.stats}`);
    check(/Z\s*$/.test(afterDelete.d.trim()), `delete opened the path: ${afterDelete.d}`);
    check(!/Z/.test(afterBreak), `break left the path closed: ${afterBreak}`);
    check(breakStatus === 'Opened the path at that node.', `status reads "${breakStatus}"`);
    return { start, afterDelete, afterBreak, breakStatus };
  },

  /** The same delete, both ways round, on the same path. */
  async deleteModes(page, check) {
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
      await settle(page);
      await showCanvas();
    };

    const run = async (mode) => {
      await load();
      // The Delete controls live in the Node tab, and a control in a tab you
      // cannot see is not there: `hidden` keeps it out of the hit test, so the
      // click below would wait thirty seconds for a visibility that never
      // comes, so the tab has to be switched first.
      await tab(page, 'node');
      await page.click(`#delmode button[data-dm="${mode}"]`);
      await settle(page);
      await click([40, 30]);
      await settle(page);
      const selected = await page.textContent('#nodeinfo');
      await page.click('#del');
      await settle(page);
      return {
        pressed: await page.getAttribute(`#delmode button[data-dm="${mode}"]`, 'aria-pressed'),
        selected,
        stats: await page.textContent('#stats'),
        d: await page.getAttribute('.artwork path', 'd'),
      };
    };

    const fuse = await run('fuse');
    const split = await run('split');

    /* Both modes remove the same two nodes and disagree about what to leave
       behind. Fuse keeps one run through the gap; Split leaves two, which is
       the second `M`. The node counts match, so only the topology tells them
       apart and only the drawn path shows it. */
    check(fuse.selected === '0/2' && split.selected === '0/2', 'the two runs did not delete the same nodes');
    check((fuse.d.match(/M/g) ?? []).length === 1, `fuse left ${fuse.d}`);
    check((split.d.match(/M/g) ?? []).length === 2, `split left ${split.d}`);
    check(/3 segments/.test(fuse.stats), `fuse left ${fuse.stats}`);
    check(/2 segments/.test(split.stats), `split left ${split.stats}`);
    return { fuse, split };
  },

  /**
   * The two draw tools, renaming, and the tooltips.
   *
   * Drawing is the one thing here that cannot be checked without a browser:
   * the shape's size comes from a pointer drag through a real hit-tested
   * overlay, and the modifier keys are read off the live event.
   */
  async primitives(page, check) {
    const { drag } = await mk(page);

    /* The drawn size of a path, asked of the browser rather than parsed out of
       the `d`. Splitting the numbers into x/y pairs looks obvious and is wrong
       the moment an `H` or a `V` appears, which is what a rectangle emits:
       pairing the numbers reads a 24x25 rect as 65x65 and fails on its own
       arithmetic. `getBBox` is also the measure that matters,
       being the shape as drawn, curves included. */
    const extent = (selector) =>
      page.$eval(selector, (el) => {
        const b = el.getBBox();
        return [b.width, b.height];
      });

    // Clear the starter so the shape list is easy to talk about. By key,
    // because the Delete button is behind the Touch buttons setting.
    await page.click('#shapelist li:nth-child(1)');
    await page.keyboard.press('Delete');
    await settle(page);

    // A circle: Shift takes the smaller span of the drag.
    await page.click('#tool button[data-v="ellipse"]');
    await drag([20, 15], [50, 55], 10, 'Shift');
    await settle(page);
    const circle = {
      stats: await page.textContent('#stats'),
      d: await page.getAttribute('.artwork path', 'd'),
    };
    // Shift took the smaller span of a 30x40 drag, so both sides are 30.
    const [cw, ch] = await extent('.artwork path');
    check(Math.abs(cw - ch) < 0.01, `Shift did not constrain: ${cw} x ${ch}`);
    check(Math.abs(cw - 30) < 0.5, `expected a 30-unit circle, got ${cw}`);
    check(/^M[^A-Z]*C/.test(circle.d), 'an ellipse should be cubics, not lines');

    /* A rectangle, which is four straight sides and nothing else. The tool
       carried a corner radius of its own until it was taken out: it applied
       only while drawing, no other tool read it, and Round does the same arc on
       any path afterwards. So a curve in this `d` is a defect now. */
    await page.click('#tool button[data-v="rect"]');
    await drag([56, 15], [80, 40]);
    await settle(page);
    const rect = {
      shapes: await page.locator('#shapelist li').allTextContents(),
      d: await page.getAttribute('.artwork path:nth-child(2)', 'd'),
    };
    check(rect.shapes.length === 2, `expected 2 shapes, got ${rect.shapes.length}`);
    check(!/C/.test(rect.d), `a drawn rectangle should have no curves in it: ${rect.d}`);
    check(/[HVL]/.test(rect.d), `no straight sides: ${rect.d}`);
    const [rw, rh] = await extent('.artwork path:nth-child(2)');
    check(Math.abs(rw - 24) < 0.5 && Math.abs(rh - 25) < 0.5, `rect is ${rw} x ${rh}, want 24 x 25`);

    /* A polygon and a star. Both are ordinary paths from the moment they exist,
       which is the claim the two tools above already make good on, so what only
       a browser can show is that the panel's numbers reach the generator: the
       corner count, the star toggle and the inner ratio are three controls and
       a drag, and every one of them was correct in the unit tests. */
    await tab(page, 'shape');
    await page.fill('#polyCorners', '6');
    await settle(page);
    check(
      /6 sides/.test((await page.textContent('#polyinfo')).trim()),
      `the polygon header says "${await page.textContent('#polyinfo')}"`,
    );
    check(await page.locator('#polyRatioRow').isHidden(), 'the star ratio is showing for a polygon');

    await page.click('#tool button[data-v="poly"]');
    await drag([10, 40], [40, 55]);
    await settle(page);
    const hex = await page.getAttribute('.artwork path:nth-child(3)', 'd');
    /* Six points and the close, counted as commands that place one: `M`, `L`,
       `H` and `V` each do, and which of the three a side gets depends on
       whether it happens to be axis-aligned. Not one curve, because Round needs
       straight sides on both edges of a node. */
    check((hex.match(/[MLHVZ]/g) ?? []).length === 7, `the hexagon reads "${hex}"`);
    check(!/[CQA]/.test(hex), `a polygon should have no curves in it: ${hex}`);
    /* Inscribed in the drag's box, not filling it. A hexagon with a point at
       the top has its widest vertices 30° off vertical, so a 30-wide drag gives
       a 30·cos(30°) = 25.98 wide shape and the full 15 of height. The same is
       true in Inkscape, and it is the reason this is measured against the
       arithmetic rather than against the drag. */
    const [hw, hh] = await extent('.artwork path:nth-child(3)');
    const want = 30 * Math.cos(Math.PI / 6);
    check(
      Math.abs(hw - want) < 0.6 && Math.abs(hh - 15) < 0.6,
      `hexagon is ${hw} x ${hh}, want ${want.toFixed(2)} x 15`,
    );

    await page.click('#polyKind button[data-pk="star"]');
    await settle(page);
    check(await page.locator('#polyRatioRow').isVisible(), 'the star ratio stayed hidden under Star');
    check(
      /6-point star/.test((await page.textContent('#polyinfo')).trim()),
      `the star header says "${await page.textContent('#polyinfo')}"`,
    );
    // By key this time, which is the other half of the tool being reachable.
    await page.click('#tool button[data-v="select"]');
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('n');
    check(
      (await page.getAttribute('#tool button[data-v="poly"]', 'aria-pressed')) === 'true',
      'pressing n did not select the polygon tool',
    );
    await drag([50, 40], [80, 55]);
    await settle(page);
    const star = await page.getAttribute('.artwork path:nth-child(4)', 'd');
    // Twice the corners, because a star alternates out and in.
    check((star.match(/[MLHVZ]/g) ?? []).length === 13, `the star reads "${star}"`);
    /* The ratio is a live control, so a tighter one has to reach the geometry.
       Measured as the shortest distance from the centre to any node, which is
       the waist: the star's extent barely moves, so a bounding box would report
       the same shape for 38% and 15%. */
    const waist = async (sel) =>
      page.$eval(sel, (el) => {
        const b = el.getBBox();
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        const nums = (el.getAttribute('d').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        let least = Infinity;
        for (let i = 0; i + 1 < nums.length; i += 2) {
          least = Math.min(least, Math.hypot(nums[i] - cx, nums[i + 1] - cy));
        }
        return least;
      });
    const fat = await waist('.artwork path:nth-child(4)');
    await page.fill('#polyRatio', '15');
    await settle(page);
    await drag([50, 40], [80, 55]);
    await settle(page);
    const thin = await waist('.artwork path:nth-child(5)');
    check(thin < fat * 0.6, `the ratio did not reach the shape: waist went ${fat} to ${thin}`);

    // The keyboard reaches the tools too.
    await page.keyboard.press('e');
    const toolAfterKey = await page.getAttribute('#tool button[data-v="ellipse"]', 'aria-pressed');
    check(toolAfterKey === 'true', 'pressing e did not select the ellipse tool');
    // ...but Ctrl+E belongs to the source drawer, and must not switch the tool
    // as a silent side effect of opening it.
    await page.click('#tool button[data-v="select"]');
    await page.keyboard.press('Control+e');
    await settle(page);
    const toolAfterCtrlE = await page.getAttribute('#tool button[data-v="select"]', 'aria-pressed');
    check(toolAfterCtrlE === 'true', 'Ctrl+E switched the tool as well as opening the drawer');
    await page.keyboard.press('Control+e');
    await settle(page);

    // Rename, which is what the exported id carries.
    await page.dblclick('#shapelist li:nth-child(1) .nm');
    await page.fill('#shapelist .rename', 'outer ring');
    await page.keyboard.press('Enter');
    await settle(page);
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    const renamed = {
      status: await page.textContent('#status'),
      listed: await page.textContent('#shapelist li:nth-child(1)'),
      exported: (await page.inputValue('#src')).includes('id="outer-ring"'),
    };

    check(renamed.exported, 'the renamed shape did not reach the exported id');
    check(/outer ring/.test(renamed.listed), `the list still reads ${renamed.listed}`);

    // Tooltips: the toolbar is icons, so the labels have to come from hovering.
    await page.hover('#fit');
    // On the app's own delay, not on a frame.
    await page.waitForSelector('.tip.on');
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
    await page.waitForSelector('.tip kbd');
    const cap = {
      kbd: await page.locator('.tip kbd').count(),
      key: await page.textContent('.tip kbd').catch(() => null),
    };
    check(cap.kbd === 1, 'the shortcut did not render as a key cap');
    check(cap.key === 'E', `key cap reads ${cap.key}, want E`);

    return { circle, rect, toolAfterKey, toolAfterCtrlE, renamed, tip, cap };
  },

  /**
   * The backdrop: a raster to trace over that is not part of the drawing.
   *
   * Needs a real browser twice over. The file arrives through a file input and
   * an object URL, neither of which exists in jsdom, and the thing worth
   * proving is that it renders *under* the artwork and never reaches the
   * export.
   */
  async backdrop(page, check) {

    await tab(page, 'doc');

    // A 4x3 PNG, red. Its aspect ratio is what the fit has to preserve.
    const buffer = png(4, 3, () => [224, 32, 32, 255]);
    await page.setInputFiles('#backFile', { name: 'trace.png', mimeType: 'image/png', buffer });
    await settle(page);

    /* That the bytes decode into the pixels they claim, which is what the
       attribute checks below cannot show.

       The far corner rather than the size, and rather than whether `decode()`
       resolved. A truncated PNG keeps its width and height, because they come
       from the header and the header is the part a truncation leaves alone --
       and the two engines disagree about the rest. Firefox rejects the image
       whole; Chromium decodes what arrived, reports 4 by 3, paints the first
       row and leaves the other two transparent. The last pixel is the one
       reading that catches both. */
    const corner = await page.$eval('.backdrop', async (el) => {
      const img = new Image();
      img.src = el.getAttribute('href') ?? el.getAttribute('xlink:href');
      try {
        await img.decode();
      } catch (e) {
        return String(e);
      }
      const c = document.createElement('canvas');
      [c.width, c.height] = [img.naturalWidth, img.naturalHeight];
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(c.width - 1, c.height - 1, 1, 1).data;
      return [c.width, c.height, ...px];
    });
    check(
      JSON.stringify(corner) === JSON.stringify([4, 3, 224, 32, 32, 255]),
      `the backdrop's last pixel reads ${JSON.stringify(corner)}, want [4,3,224,32,32,255]`,
    );

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
    await settle(page);
    const exported = await page.inputValue('#src');
    check(!/<image|base64|blob:/.test(exported), 'the backdrop leaked into the export');
    await closeSource(page);

    // Opacity and visibility are live.
    await page.fill('#backOpacity', '20');
    await page.dispatchEvent('#backOpacity', 'input');
    await settle(page);
    const dimmed = await page.getAttribute('.backdrop', 'opacity');
    check(Math.abs(+dimmed - 0.2) < 1e-6, `opacity did not follow the field: ${dimmed}`);

    await page.uncheck('#backShow');
    await settle(page);
    check((await page.getAttribute('.backdrop', 'display')) === 'none', 'hiding it did nothing');
    await page.check('#backShow');
    await settle(page);

    // Unlocked, a canvas drag moves it instead of marquee-selecting.
    const before = await page.$eval('.backdrop', (el) => +el.getAttribute('x'));
    await page.uncheck('#backLock');
    await settle(page);
    const { drag } = await mk(page);
    // Left of the starter shape, which spans 20..68 x 12..52, and inside the view.
    await drag([8, 45], [18, 45]);
    await settle(page);
    const after = await page.$eval('.backdrop', (el) => +el.getAttribute('x'));
    check(after > before, `unlocked drag left x at ${after}`);
    check((await page.locator('.anchor.selected').count()) === 0, 'the unlocked drag also selected nodes');

    await page.click('#backClear');
    await settle(page);
    const gone = await page.getAttribute('.backdrop', 'display');
    check(gone === 'none', 'Remove left the backdrop on screen');

    /* Removing is an edit, so it comes back. The interesting half is that the
       object URL behind it has to still resolve: freeing the bytes when the
       image left the screen would restore an <image> pointing at nothing, which
       looks identical to a working undo until you look at the canvas. */
    await page.keyboard.press('Control+z');
    await settle(page);
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
    await settle(page);
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
   * Rounding corners: by the radius field, and by dragging one control.
   *
   * The rectangle tool used to carry a radius of its own that applied only
   * while drawing, and that no other tool read. This is the one route now, and
   * it works on anything with two straight sides.
   */
  async roundCorners(page, check) {
    const { click } = await mk(page);

    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', 'M20 16 L64 16 L64 48 L20 48 Z');
    await page.click('#apply');
    await settle(page);
    await closeSource(page);

    // Nothing selected, so no transform box stands between the pointer and the
    // corner nodes.
    await page.keyboard.press('Escape');
    await settle(page);

    // Two adjacent corners, selected on the canvas.
    await click([64, 16]);
    await click([64, 48], 'Shift');
    await settle(page);

    await tab(page, 'node');
    await page.fill('#roundR', '6');
    await page.click('#roundCorner');
    await settle(page);

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

    /* One control, dragged, with the whole shape selected: every corner rounds.
       Dragged far past the limit on purpose, so the radius clamps to what the
       shortest side allows and the expectation does not depend on the zoom. A
       44 by 32 rectangle with all four corners at 16 is a stadium: the two short
       sides are consumed entirely and each pair of arcs shares a node, which is
       6 nodes. Rounding only the grabbed corner leaves 5. */
    await page.keyboard.press('Escape');
    await settle(page);
    // The shape list lives in the Shape tab, and the radius field is in Node.
    await tab(page, 'shape');
    await page.click('#shapelist li:nth-child(1)');
    await settle(page);

    const dot = await page.locator('.corner-dot[data-i="1"]').boundingBox();
    check(!!dot, 'a selected shape drew no corner control');
    const cx = dot.x + dot.width / 2;
    const cy = dot.y + dot.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Into the shape along the bisector of that corner: left and down.
    for (let i = 1; i <= 8; i++) await page.mouse.move(cx - 10 * i, cy + 10 * i);
    await page.mouse.up();
    await settle(page);

    const dragged = await page.textContent('#stats');
    check(/6 nodes/.test(dragged), `dragging one corner of a selected shape: "${dragged}"`);
    /* At the limit the arcs meet on the sides they share, the tangent points
       land on the neighbours, and there is no corner left for the control to
       come back on. That is worth a sentence, or it reads as the control
       breaking. */
    const said = await page.textContent('#status');
    check(/uses the sides up/.test(said), `dragging to the limit said "${said}"`);
    const stadium = await page.getAttribute('.artwork path', 'd');
    check(!/64 16/.test(stadium), `the grabbed corner is still sharp: ${stadium}`);
    check(!/20 48/.test(stadium), `the far corner was left sharp: ${stadium}`);

    return { stats, status, d, dragged };
  },

  /**
   * Fusing nodes, both readings of it.
   *
   * The defect this closes is invisible on screen: two anchors on the same point
   * draw exactly like one. So every check here is against something that can be
   * read back — the node count, the exported `d`, and whether Simplify will
   * touch the path at all, which a zero-length segment prevents outright.
   */
  async fuse(page, check) {
    const { click, drag } = await mk(page);

    // A square carrying a duplicate anchor at [64, 16], as an import would.
    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', 'M20 16 L64 16 L64 16 L64 48 L20 48 Z');
    await page.click('#apply');
    await settle(page);
    await closeSource(page);
    await page.keyboard.press('Escape');
    await settle(page);

    const before = await page.textContent('#stats');
    check(/5 nodes/.test(before), `the duplicate anchor did not survive the parse: "${before}"`);

    /* The sweep reading: more than two nodes selected, so Fuse looks for
       zero-length segments rather than welding a chosen pair. Marquee from
       outside the shape. */
    await drag([8, 6], [76, 58]);
    await settle(page);
    await tab(page, 'node');
    await page.click('#fuseNodes');
    await settle(page);

    const swept = await page.textContent('#stats');
    const sweptStatus = await page.textContent('#status');
    check(/4 nodes/.test(swept), `after the sweep: "${swept}"`);
    check(/Fused 1 zero-length segment away/.test(sweptStatus), `status says "${sweptStatus}"`);

    /* The point of the repair, and the half a node count cannot show: the path
       is simplifiable again. A zero chord gives the fitter no tangent, so a
       single duplicate anchor makes the whole path refuse. */
    const d = await page.getAttribute('.artwork path', 'd');
    check(!/64\s+16\s+L\s*64\s+16/.test(d), `the duplicate anchor is still exported: ${d}`);

    await undo(page);
    check(/5 nodes/.test(await page.textContent('#stats')), 'undo did not put the duplicate back');
    await page.click('#fuseNodes');
    await settle(page);

    // The pair reading: exactly two adjacent nodes, welded at their midpoint.
    await page.keyboard.press('Escape');
    await settle(page);
    await click([20, 16]);
    await click([64, 16], 'Shift');
    await settle(page);
    await page.click('#fuseNodes');
    await settle(page);

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
    await settle(page);
    await closeSource(page);
    await page.keyboard.press('Escape');
    await click([10, 10]);
    await click([30, 30], 'Shift');
    await settle(page);
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
  async trace(page, check) {

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
    await backdropRead(page);

    const info = await page.textContent('#traceinfo');
    check(info === '64 × 64 px', `trace readout says "${info}"`);

    const before = await page.$$eval('.artwork path', (els) => els.length);
    await page.click('#traceGo');
    await traced(page);

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
   * Reverse, from the button and from the keyboard.
   *
   * The model op is covered by unit tests. What is only checkable here is the
   * two entry points, button and key, and the one property a person would check
   * first: the drawing does not move.
   */
  async reverse(page, check) {

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60">
  <path d="M10 40 C 20 10 40 10 50 30 L 70 20" fill="none" stroke="#2563d8"/>
</svg>`,
    );
    await page.click('#apply');
    await settle(page);
    await closeSource(page);

    const shot = async () => {
      const el = await page.$('.artwork path');
      return {
        d: await el.getAttribute('d'),
        box: await page.$eval('.artwork path', (p) => {
          const b = p.getBBox();
          return [+b.x.toFixed(4), +b.y.toFixed(4), +b.width.toFixed(4), +b.height.toFixed(4)];
        }),
      };
    };

    await page.click('#shapelist li:nth-child(1)');
    await settle(page);
    const before = await shot();

    await page.click('#reverse');
    await settle(page);
    const after = await shot();
    check(after.d !== before.d, 'the path data did not change, so nothing was reversed');
    check(
      JSON.stringify(after.box) === JSON.stringify(before.box),
      `the drawing moved: ${JSON.stringify(before.box)} became ${JSON.stringify(after.box)}`,
    );
    const said = await page.textContent('#status');
    check(/Reversed 1 subpath\b/.test(said), `status says "${said}"`);

    // Shift+R is the same operation, so it puts the path back exactly.
    await page.keyboard.press('Shift+R');
    await settle(page);
    const back = await shot();
    check(back.d === before.d, `Shift+R gave "${back.d}", want "${before.d}"`);

    // And one undo undoes one reverse, not both.
    await undo(page);
    const undone = await shot();
    check(undone.d === after.d, 'undo did not step back exactly one reverse');

    return { before: before.d, after: after.d };
  },

  /**
   * The source box catches up on everything that happened while it was shut.
   *
   * Rewriting it is a full serialisation of the document. Running that on every
   * notification whether or not anybody can see it costs 56 ms per pointermove
   * on a traced document, to update a textarea of `height: 0`. It is skipped
   * while the drawer is closed, which is only correct if opening the drawer
   * refreshes it. Nothing else checks that: with the catch-up
   * removed, every existing scenario still passed, because they all open the
   * drawer before they edit.
   */
  async sourceDeferred(page, check) {
    const { drag } = await mk(page);

    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    const before = await page.inputValue('#src');
    await closeSource(page);

    // An edit with nobody watching the box: a rectangle dragged on the canvas.
    await page.click('#tool button[data-v="rect"]');
    await drag([12, 12], [40, 34], 8);
    await settle(page);
    const shapes = await page.$$eval('.artwork path', (els) => els.length);
    check(shapes >= 2, `the drag added no shape: ${shapes} paths`);

    await openSource(page);
    const after = await page.inputValue('#src');
    check(after !== before, 'the source box still shows what it showed before the edit');
    /* The box scopes to a single selected shape, and drawing one selects it, so
       what it should now show is the rectangle's own path data -- taken from
       the canvas rather than written out here, so this compares the box against
       the drawing rather than against my arithmetic. */
    const drawn = await page.$$eval('.artwork path', (els) => els.map((e) => e.getAttribute('d')));
    check(
      drawn.includes(after),
      `the box shows "${after.slice(0, 60)}", which is not any shape on the canvas`,
    );
    // The character count beside it is written by the same path, so a refresh
    // that updated one and not the other would leave them disagreeing.
    const said = await page.textContent('#srcinfo');
    check(said === `${after.length} chars`, `readout says "${said}" for ${after.length} characters`);

    /* Revert. A failed Apply changes nothing, and the box only rewrites itself
       when the document changes, so without this unparseable text sits there
       with no way back to what the document actually says. */
    const shapesNow = () => page.$$eval('.artwork path', (els) => els.map((e) => e.getAttribute('d')));
    const untouched = await shapesNow();

    /* Two ways to fail, and neither may touch the drawing. `@` cannot be parsed
       at all. `M 0 0` parses perfectly and draws nothing, which is the one that
       empties the selected shape and reports "Updated" if it gets through. */
    for (const bad of ['M 0 0 L @', 'M 0 0']) {
      await page.fill('#src', bad);
      await page.click('#apply');
      await settle(page);
      const cls = await page.getAttribute('#status', 'class');
      check(/err/.test(cls ?? ''), `"${bad}" was accepted: status is "${cls}"`);
      check(
        JSON.stringify(await shapesNow()) === JSON.stringify(untouched),
        `"${bad}" changed the drawing`,
      );
      check(
        (await page.inputValue('#src')) === bad,
        `a failed Apply threw away what was typed, and the offset in its own error with it`,
      );
    }
    const failed = await page.textContent('#status');
    await page.click('#revertSrc');
    await settle(page);
    check(
      (await page.inputValue('#src')) === after,
      `Revert gave "${await page.inputValue('#src')}", want "${after}"`,
    );

    return { before: before.length, after: after.length, shapes, failed };
  },

  /**
   * The trace does not freeze the page, and still works when it has to.
   *
   * Only measurable here: the unit tests call `traceImage` directly, which is
   * the thing that blocks, and a worker has no meaning in jsdom. What this
   * asserts is that the page keeps painting while a trace runs -- and then,
   * with `Worker` taken away, that the same picture still traces on the main
   * thread, slowly. The second run is what makes the first assertion mean
   * something: if the frame count were measuring anything other than the
   * worker, both runs would score alike.
   */
  async traceWorker(page, check) {

    await tab(page, 'doc');

    /* 400 by 400 of gradient and grain: a picture with enough boundary in it to
       take a few hundred milliseconds, which is long enough for the difference
       between blocking and not to be several dozen frames. Deterministic, so
       the timing is the only thing that varies between runs. */
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const buffer = png(400, 400, (x, y) => [
      (x / 400) * 200 + rnd() * 40,
      (y / 400) * 180 + rnd() * 40,
      128 + Math.cos(x / 30) * 60 + rnd() * 40,
      255,
    ]);
    await page.setInputFiles('#backFile', { name: 'photo.png', mimeType: 'image/png', buffer });
    await settle(page);

    /**
     * Click Trace, and measure the longest the main thread was blocked.
     *
     * A timer measuring its own lateness, never animation frames and never
     * `longtask` entries. Frame gaps lie in headless Chromium: with no
     * compositor the frame callbacks are not scheduled against real vsync, so a
     * thread demonstrably blocked for 1 152 ms reports a longest gap of 17 ms.
     * `longtask` is a Chromium entry type, absent from Firefox's
     * `supportedEntryTypes`, and `observe` ignores a type it does not know
     * rather than refusing it. An observer for it on Firefox therefore reads
     * 0 ms for every run, and two runs of 0 ms distinguish nothing.
     *
     * A 10 ms interval cannot run while the thread is blocked, so the gap
     * between two of its fires is how long it was held. That is the claim being
     * made, it needs no API beyond `setInterval`, and it reads the same on both
     * engines. The idle floor is the interval plus scheduling jitter, around
     * 11 ms measured.
     */
    const run = async () => {
      const before = await page.$$eval('.artwork path', (els) => els.length);
      await page.evaluate(() => {
        clearInterval(window.__tick);
        window.__gap = 0;
        window.__last = performance.now();
        window.__tick = setInterval(() => {
          const now = performance.now();
          window.__gap = Math.max(window.__gap, now - window.__last);
          window.__last = now;
        }, 10);
        document.querySelector('#status').textContent = '';
      });
      const started = Date.now();
      await page.click('#traceGo', { noWaitAfter: true });
      await page.waitForFunction(
        () => /^Traced/.test(document.querySelector('#status')?.textContent ?? ''),
        null,
        { timeout: 120000 },
      );
      const ms = Date.now() - started;
      /* `Traced …` is written in the same task that commits the shapes, and the
         controller renders one `requestAnimationFrame` after the store
         notification -- so when the status appears the render has not run, and
         reading the gap here would leave out the most expensive block of the
         lot. Two frames, which is what `settle` waits. */
      await settle(page);
      const block = await page.evaluate(() => {
        clearInterval(window.__tick);
        return Math.round(window.__gap);
      });
      const after = await page.$$eval('.artwork path', (els) => els.length);
      return {
        ms,
        block,
        added: after - before,
        stats: await page.textContent('#stats'),
        status: await page.textContent('#status'),
      };
    };

    const worker = await run();
    check(worker.added > 0, 'the worker run added no shapes');
    /* A responsiveness bound, and nothing more. The block is not zero even with
       the worker, and cannot be: committing the shapes, serialising them and
       rendering 3695 paths are all main-thread work. What it no longer contains
       is the walk.

       450 ms against 274, 310 and 353 measured over three runs on Firefox. Do
       not read this as the check that the worker is being used -- it is not,
       and the fallback lands at 470 to 530 on the same machine, which is only
       just the other side of it. That discrimination is the difference check
       below, which compares the two runs instead of trusting one number. */
    check(worker.block < 450, `${worker.block} ms of blocked thread during a ${worker.ms} ms trace`);

    /* The overlay stops drawing markers rather than putting one on each of
       23 000 nodes, and says so where the node count is. Checked here because
       the readout is written from `controller.onRender`, and whether that fires
       late enough to have an answer is only true in a browser. */
    check(
      /markers off/.test(worker.stats),
      `${worker.added} traced shapes and the readout still claims markers: "${worker.stats}"`,
    );
    await undo(page);

    /* Take `Worker` away and trace the same picture. `traceOffThread` returns
       null when one cannot be constructed -- which is what a `worker-src`
       policy forbidding `blob:` looks like from the inside -- and the tracer
       runs here instead. */
    await page.evaluate(() => {
      window.__blocked = 0;
      window.Worker = function () {
        window.__blocked++;
        throw new Error('worker-src blocked');
      };
    });
    const fallback = await run();
    const blocked = await page.evaluate(() => window.__blocked);
    check(blocked > 0, 'the fallback run never tried to build a worker, so it proves nothing');
    check(fallback.added === worker.added, `fallback added ${fallback.added}, worker added ${worker.added}`);
    check(fallback.status === worker.status, `fallback says "${fallback.status}"`);
    /* A difference rather than a ratio. Both runs pay the same commit and
       render on this thread; only the walk moves. So what separates them is a
       fixed few hundred milliseconds of walk, not a multiple, and asserting a
       multiple would tighten as the shared cost falls. */
    check(
      fallback.block - worker.block > 100,
      `the fallback blocked ${fallback.block} ms against the worker's ${worker.block}, so this is not measuring the worker`,
    );
    await undo(page);

    return { worker, fallback };
  },

  /**
   * The snap priority order, driven by an actual pointer.
   *
   * The rule is unit-tested against a document. What is only here is that the
   * reach is measured in screen pixels, so it has to survive a real camera, and
   * that the readout names the tier that actually answered.
   */
  async snapOrder(page, check) {
    const { drag, toClient } = await mk(page);

    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    /* Two separate shapes: a box to snap TO, and a lone segment to drag. The
       box's top edge is at y = 16.5, deliberately OFF the grid, so "landed on
       the outline" and "landed on the grid" are different numbers. With it at a
       whole 16 the final check below passed whichever tier had answered. */
    await page.fill('#src', 'M20 16.5 L60 16.5 L60 48 L20 48 Z M12 56 L16 60');
    await page.click('#apply');
    await settle(page);
    await closeSource(page);
    await page.keyboard.press('Escape');
    await settle(page);

    /* Both halves of the readout, joined for these checks. The tier's name is a
       separate element from the coordinates now -- it sits to their left, so
       that a tier coming into reach cannot shove the digits sideways while
       somebody is reading them. */
    const hover = async (doc) => {
      const c = await toClient(doc);
      await page.mouse.move(c[0], c[1]);
      await settle(page);
      const xy = await page.textContent('#cursor');
      const kind = await page.textContent('#snapkind');
      return kind ? `${xy} · ${kind}` : xy;
    };

    // Middle of the square's top edge: no corner in reach, so the 1-D tier.
    const onEdge = await hover([40, 16.7]);
    check(/on an outline/.test(onEdge), `mid-edge readout says "${onEdge}"`);
    check(/16\.5/.test(onEdge), `mid-edge readout is not on the edge: "${onEdge}"`);

    // Near a corner, where the vertex and both its sides all have a claim.
    const onCorner = await hover([20.3, 16.8]);
    check(/on a node/.test(onCorner), `near-corner readout says "${onCorner}"`);
    check(/^20\.?0*, 16\.?0*\b/.test(onCorner), `near-corner readout is not at the corner: "${onCorner}"`);

    // Out in the open: neither tier, so the readout is a plain position.
    const nowhere = await hover([76, 8]);
    check(!/on a/.test(nowhere), `empty-canvas readout says "${nowhere}"`);

    /* And the coordinates stay put while all that changes. Right-aligning them
       in a box that grows with its own contents slides the digits sideways on
       every pointermove that brings a tier into reach -- by up to 199 px, while
       somebody is reading them. Only a browser can answer this: it is a
       question about layout. */
    const digitsAt = () => page.$eval('#cursor', (el) => Math.round(el.getBoundingClientRect().left));
    const plainAt = await digitsAt();
    await hover([40, 16.7]);
    const claimedAt = await digitsAt();
    check(
      plainAt === claimedAt,
      `the coordinates moved ${claimedAt - plainAt} px when a snap tier came into reach`,
    );

    /* The scenario's headline claim, and the one it did not actually make.
       Reach is REACH_PX scaled by the camera, so at this zoom it is well under
       one document unit; replacing it with a bare `8` -- sixteen times larger --
       passed every assertion here, because nothing was ever placed between the
       two distances. This point is 3 units from the edge: inside a reach of 8
       document units and far outside the true one. */
    const justBeyond = await hover([40, 19.5]);
    check(!/on an outline/.test(justBeyond),
      `an outline 3 units away claimed the pointer, so reach is not in screen pixels: "${justBeyond}"`);

    /* And the half that matters: dragging a node onto an outline lands it ON
       the outline, not on the nearest gridline. The edge is at y = 16.5 and the
       nearest gridline is 17, so the two answers are a visible half unit apart. */
    await drag([12, 56], [40, 16.7]);
    await settle(page);
    const d = await page.getAttribute('.artwork path', 'd');
    const moved = d.match(/M\s*([\d.]+)\s+([\d.]+)\s+L/);
    check(!!moved, `could not read the dragged node back: ${d}`);
    check(Math.abs(+moved[2] - 16.5) < 1e-6, `landed at y=${moved[2]}, want the outline at 16.5`);

    // With outline snapping off, the same drag goes to the grid instead.
    await undo(page);
    await tab(page, 'doc');
    await page.click('#snapBoundary');
    await settle(page);
    await drag([12, 56], [40, 16.7]);
    await settle(page);
    const d2 = await page.getAttribute('.artwork path', 'd');
    const g = d2.match(/M\s*([\d.]+)\s+([\d.]+)\s+L/);
    check(Math.abs(+g[2] - 17) < 1e-6, `off-boundary drag landed at y=${g[2]}, want the grid at 17`);
    const readout = await hover([40, 16.7]);
    check(!/on an outline/.test(readout), `outline snap still offered when off: "${readout}"`);

    return { onEdge, onCorner, nowhere, landed: moved[2] };
  },

  /**
   * Pixel fit, and the one thing only a browser can check.
   *
   * The arithmetic is unit-tested. What is not is whether the grid you *see* is
   * the lattice you snap to: §9's defect, back at half a pixel and much harder
   * to spot by eye. So this reads the drawn gridlines out of the overlay and
   * compares them against where a dragged node actually landed.
   */
  async pixelFit(page, check) {
    const { drag } = await mk(page);

    await tab(page, 'doc');
    // Zoom in far enough that every snap position is drawn, or the comparison
    // below is against a thinned lattice and proves less than it looks.
    await page.fill('#gridStep', '1');
    await settle(page);

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
    await settle(page);
    await tab(page, 'doc');
    await page.click('#pixelFit');
    await settle(page);

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
    await settle(page);
    await closeSource(page);
    await page.keyboard.press('Escape');
    await settle(page);

    await drag([20, 20], [30.2, 28.4]);
    await settle(page);
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
    await settle(page);
    await page.click('#fitPixels');
    await settle(page);
    const fitted = await page.getAttribute('.artwork path', 'd');
    const nums = [...fitted.matchAll(/-?[\d.]+/g)].map((m) => +m[0]);
    check(
      nums.every((v) => Math.abs(Math.abs(v - Math.round(v)) - 0.5) < 1e-6),
      `fit to pixels left coordinates off the lattice: ${fitted}`,
    );

    // Turning it off puts the drawn grid back where it was.
    await page.click('#pixelFit');
    await settle(page);
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
  async style(page, check) {
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
    await settle(page);
    const undoAfterDefault = await page.isDisabled('#undo');
    check(undoAfterDefault, 'choosing a colour for later landed on the undo stack');

    await page.click('#tool button[data-v="rect"]');
    await drag([10, 10], [40, 34]);
    await page.click('#tool button[data-v="select"]');
    await settle(page);
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
    await settle(page);
    await page.fill('#fillColour', '#ff0000');
    await settle(page);
    const painted = await page.getAttribute('.artwork path', 'fill');
    check(painted === '#ff0000', `the canvas painted ${painted}`);

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    check(/fill="#ff0000"/.test(await page.inputValue('#src')), 'the export kept the old fill');
    await closeSource(page);

    // `none` is a value the picker cannot hold, so the tick box holds it.
    await page.check('#fillNone');
    await settle(page);
    check((await page.getAttribute('.artwork path', 'fill')) === 'none', 'ticking none left a fill');
    /* The picker stays usable while none is ticked, and using it is what clears
       it. Disabling it meant filling an unfilled shape took two steps, the first
       of which committed a colour nobody chose. */
    check(!(await page.isDisabled('#fillColour')), 'the picker went dead with none ticked');
    await page.fill('#fillColour', '#00aa44');
    await settle(page);
    check((await page.getAttribute('.artwork path', 'fill')) === '#00aa44', 'picking a colour did not clear none');
    check(!(await page.isChecked('#fillNone')), 'the none tick survived a colour being picked');

    await undo(page);
    await undo(page);
    check((await page.getAttribute('.artwork path', 'fill')) === '#ff0000', 'undo did not bring the fill back');

    /* Opacity is typed as a percentage and stored as SVG's 0 to 1, so both
       numbers have to be looked at: the attribute the canvas draws with, and
       the one the export writes. A field that read the model back in the units
       it was typed in would agree with itself and with nothing else. */
    await page.fill('#opacity', '40');
    await settle(page);
    const drawnOpacity = await page.getAttribute('.artwork path', 'opacity');
    check(Math.abs(+drawnOpacity - 0.4) < 1e-9, `the canvas drew opacity ${drawnOpacity}`);
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    check(/opacity="0.4"/.test(await page.inputValue('#src')), 'the export left the opacity out');
    await closeSource(page);
    /* Back to opaque has to take the attribute back to 1, not leave the last
       value on the element: the canvas sets attributes rather than rebuilding
       the node, so a value only written below 1 would stick. */
    await page.fill('#opacity', '100');
    await settle(page);
    const backToOpaque = await page.getAttribute('.artwork path', 'opacity');
    check(+backToOpaque === 1, `back at 100% the canvas still says ${backToOpaque}`);
    await openSource(page);
    check(!/opacity=/.test(await page.inputValue('#src')), 'an opaque shape exported an opacity attribute');
    await closeSource(page);

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
  async canvasFrame(page, check) {

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
    await settle(page);
    check((await page.getAttribute('.doc-edge', 'width')) === '120', 'the frame ignored the field');
    await undo(page);
    check((await page.getAttribute('.doc-edge', 'width')) === '88', 'undo did not restore the canvas');

    /* Fit. The starter shape spans 20..68 by 12..52, so with a grid step of one
       the page should land on exactly that. */
    await page.click('#vbFit');
    await settle(page);
    const fitted = await page.$eval('.doc-edge', (el) => [
      +el.getAttribute('x'), +el.getAttribute('y'),
      +el.getAttribute('width'), +el.getAttribute('height'),
    ]);
    check(String(fitted) === '20,12,48,40', `fitted to ${fitted}, want 20,12,48,40`);

    // And that is what the file says, which was the whole complaint.
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    const svgText = await page.inputValue('#src');
    check(/viewBox="20 12 48 40"/.test(svgText), `export says ${svgText.slice(0, 90)}`);
    await closeSource(page);

    // Drawing outside the page is allowed, and says so where the fix lives.
    check((await page.textContent('#canvasinfo')) === '', 'it claims to spill before anything does');
    await page.fill('#vbw', '10');
    await page.dispatchEvent('#vbw', 'input');
    await settle(page);
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
  async transform(page, check) {
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
    await settle(page);

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
    await settle(page);
    const scaled = await bbox();
    check(Math.abs(scaled.x - start.x) < 0.01, `x moved from ${start.x} to ${scaled.x}`);
    check(Math.abs(scaled.y - start.y) < 0.01, `y moved from ${start.y} to ${scaled.y}`);
    check(Math.abs(scaled.h - start.h) < 0.01, `height changed to ${scaled.h}`);
    check(Math.abs(scaled.w - (start.w - 24)) < 0.01, `width is ${scaled.w}, want ${start.w - 24}`);

    // One entry, however many moves the drag was made of.
    await page.keyboard.press('Control+z');
    await settle(page);
    const back = await bbox();
    check(Math.abs(back.w - start.w) < 1e-6, `undo left the width at ${back.w}`);
    check((await page.evaluate(() => document.querySelector('.artwork path').getAttribute('d'))).length > 0, 'the shape survived');

    // Alt scales about the centre: both edges move, the middle does not.
    const centreBefore = start.x + start.w / 2;
    await drag(await at('.thandle[data-part="se"]'), [se[0] - 12, se[1]], 8, 'Alt');
    await settle(page);
    const alt = await bbox();
    check(
      Math.abs(alt.x + alt.w / 2 - centreBefore) < 0.01,
      `centre moved from ${centreBefore} to ${alt.x + alt.w / 2}`,
    );
    check(alt.w < start.w, `Alt-drag did not shrink it: ${alt.w}`);
    await page.keyboard.press('Control+z');
    await settle(page);

    // Shift keeps the ratio. Dragging inwards is the case that does nothing at
    // all if the constrained factor is taken as the larger of the two.
    const ratio = start.w / start.h;
    await drag(await at('.thandle[data-part="se"]'), [se[0] - 12, se[1]], 8, 'Shift');
    await settle(page);
    const kept = await bbox();
    check(Math.abs(kept.w / kept.h - ratio) < 0.01, `ratio went from ${ratio} to ${kept.w / kept.h}`);
    check(kept.w < start.w, `Shift-drag inwards did nothing: ${kept.w}`);
    await page.keyboard.press('Control+z');
    await settle(page);

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
    await settle(page);

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
    await settle(page);
    const turned = await bbox();
    const status = await page.textContent('#status');
    check(/Rotated -90°/.test(status), `status says "${status}"`);
    check(Math.abs(turned.w - start.h) < 0.02, `width is ${turned.w}, want the old height ${start.h}`);
    check(Math.abs(turned.h - start.w) < 0.02, `height is ${turned.h}, want the old width ${start.w}`);
    await page.keyboard.press('Control+z');
    await settle(page);

    /* Repeat, which is the drag half of it: a matrix built from a gesture
       rather than from a typed number, which no unit test can reach. Rotate,
       then repeat, and a quarter turn twice is a half turn -- back to the
       starting extents, which no single quarter turn produces. */
    await drag(ne, to, 10, 'Shift');
    await settle(page);
    const repeatWhat = (await page.textContent('#repeatinfo')).trim();
    check(/rotate/.test(repeatWhat), `after a rotate drag the readout says "${repeatWhat}"`);
    check(!(await page.isDisabled('#repeatTransform')), 'Repeat was dead after a rotate drag');
    await page.click('#repeatTransform');
    await settle(page);
    const halfTurn = await bbox();
    check(
      Math.abs(halfTurn.w - start.w) < 0.05 && Math.abs(halfTurn.h - start.h) < 0.05,
      `two quarter turns gave ${halfTurn.w} × ${halfTurn.h}, want ${start.w} × ${start.h}`,
    );
    /* Undo takes back the repeat and not the memory of it: what you did is a
       different question from what you were about to do again. */
    await page.keyboard.press('Control+z');
    await settle(page);
    check(!(await page.isDisabled('#repeatTransform')), 'undo forgot what to repeat');
    await page.keyboard.press('Control+z');
    await settle(page);

    /* The question the padding exists to answer. A rectangle's corner node sits
       exactly on the bounding box, so an unpadded handle would be on top of it
       and would take every click aimed at the node. */
    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', 'M20 20 L60 20 L60 50 L20 50 Z');
    await page.click('#apply');
    await settle(page);
    await closeSource(page);
    /* Repeat by key, on a drag that moved the selection rather than rotating
       it. On this rectangle rather than the starter, because "drag the body"
       means pressing the outline -- the hit target is a wide invisible stroke
       along the path, not the filled interior -- and the middle of a straight
       top edge is a point that is certainly on it -- a quarter along rather
       than at the midpoint, where the segment's bend dot sits and takes the
       press. The blur is so Shift+T reaches the document and not the shape
       list. */
    await drag([30, 20], [40, 20]);
    await settle(page);
    const movedOnce = await bbox();
    check(Math.abs(movedOnce.x - 30) < 0.05, `the move drag put x at ${movedOnce.x}, want 30`);
    const repeatMove = (await page.textContent('#repeatinfo')).trim();
    check(/^move 10, 0$/.test(repeatMove), `after a move drag the readout says "${repeatMove}"`);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Shift+T');
    await settle(page);
    check(Math.abs((await bbox()).x - 40) < 0.05, `repeat put x at ${(await bbox()).x}, want 40`);
    /* Undo takes back the repeat and not the memory of it: what you did is a
       different question from what you were about to do again. */
    await page.keyboard.press('Control+z');
    await settle(page);
    check(!(await page.isDisabled('#repeatTransform')), 'undo forgot what to repeat');
    await page.keyboard.press('Control+z');
    await settle(page);
    check(Math.abs((await bbox()).x - 20) < 0.05, 'two undos did not put the rectangle back');

    await page.click('#shapelist li');
    await settle(page);

    await click([20, 20]);
    await settle(page);
    // `:visible`, because the anchor pool keeps retired elements around with
    // whatever class they last had; counting those reports the node count of
    // the shape before this one.
    const selected = await page.locator('.anchor.selected:visible').count();
    check(selected === 1, `clicking the corner node selected ${selected} nodes, want 1`);

    // And the box goes away entirely for a tool that owns the canvas.
    await page.keyboard.press('p');
    await settle(page);
    const withPen = await page.locator('.thandle:visible').count();
    check(withPen === 0, `${withPen} handles still showing under the pen`);

    /* --- what Repeat is given after a scale that was snapped ---------------- */

    /* The move handler snaps the delta before building the matrix. The release
       handler used to rebuild one from the raw pointer, so the document scaled
       by the snapped factor and `Repeat` held the unsnapped one, compounding on
       every press.

       Measured as a ratio against a ratio, because the two are equal whatever
       box the factor was taken from and whatever the grid rounded to. An
       expectation computed from the numbers here would be a second
       implementation of `scaleMatrix` and would agree with the wrong answer as
       readily as with the right one. */
    await page.keyboard.press('v');
    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await page.fill('#src', 'M20 20 L60 20 L60 50 L20 50 Z');
    await page.click('#apply');
    await settle(page);
    await closeSource(page);

    await tab(page, 'doc');
    await page.fill('#gridStep', '8');
    await page.press('#gridStep', 'Enter');
    await page.check('#snapGrid');
    await settle(page);
    await tab(page, 'shape');
    await page.click('#shapelist li.shape');
    await settle(page);

    const w0 = (await bbox()).w;
    // Six, with a step of eight: a delta the grid has to move, so the snapped
    // and unsnapped factors differ.
    const grip = await at('.thandle[data-part="se"]');
    await drag(grip, [grip[0] - 6, grip[1]]);
    await settle(page);
    const w1 = (await bbox()).w;
    /* The snap is on the corner's position, not on the delta: a right edge
       aimed at 54 lands on the grid line at 56. That is what proves the snap
       engaged, and 54 is what the release handler used to remember. */
    const edge = 20 + w1;
    check(Math.abs(edge - 56) < 0.05, `the snapped drag put the right edge at ${edge}, want the grid line at 56`);

    await page.click('#repeatTransform');
    await settle(page);
    const w2 = (await bbox()).w;
    check(
      Math.abs(w2 / w1 - w1 / w0) < 0.002,
      `the drag scaled by ${w1 / w0} and Repeat scaled by ${w2 / w1}`,
    );

    /* A press on a grip that never moves is not a gesture, and must leave
       `Repeat` holding what it had. Recording an identity matrix destroyed it,
       and the readout is no way to see that: it says "scale" either way. So the
       matrix is measured by using it -- Repeat after the bare click has to
       scale by the same factor again, and an identity leaves the width alone. */
    const still = await at('.thandle[data-part="se"]');
    await click(still);
    await settle(page);
    await page.click('#repeatTransform');
    await settle(page);
    const w3 = (await bbox()).w;
    check(
      Math.abs(w3 / w2 - w1 / w0) < 0.002,
      `after a bare click on a grip, Repeat scaled by ${w3 / w2} rather than ${w1 / w0}`,
    );

    return { start, scaled, turned, status, snapped: { w0, w1, w2 } };
  },

  /**
   * Simplify, end to end: the tolerance field, the button, and the drawing.
   *
   * The fitting itself is covered by unit tests. What only a browser can show
   * is that the tolerance follows the document it is opened on, and that the
   * shape on screen after the refit is still the shape that was there.
   */
  async simplify(page, check) {

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
    await settle(page);
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
    await settle(page);
    /* Redraw is off by default now, and this scenario is about the refit: a
       40-node ring holds real shape at every node, so removal alone leaves
       most of them. Ticking it is the whole point of the checkbox. */
    await page.check('#simplifyRedraw');
    await page.click('#simplify');
    await settle(page);

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
    await settle(page);
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
  async chrome(page, check) {
    const canvasBox = async () => {
      const b = await page.locator('#canvas').boundingBox();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    };
    /** Whether a collapsed panel can still be reached by Tab. */
    const reachable = (sel) =>
      page.$eval(sel, (el) => {
        const focusable = el.querySelectorAll('button, textarea, input, select, a[href]');
        // `inert` is inherited, so asking the container answers for all of them.
        return !el.inert && focusable.length > 0;
      });

    // Measured, not asserted from a literal. A hard-coded
    // `{rail: true, source: false}` returned as though it were an observation
    // is something no production change could ever contradict.
    const opened = {
      rail: (await page.getAttribute('#toggleRail', 'aria-pressed')) === 'true',
      source: (await page.getAttribute('#toggleSrc', 'aria-pressed')) === 'true',
    };
    check(opened.rail === true, 'the inspector should start open');
    check(opened.source === false, 'the source drawer should start closed');
    check(!(await reachable('#sourcepanel')), 'the closed drawer is still in the tab order');

    const both = await canvasBox();

    await page.click('#toggleSrc');
    await laidOut(page);
    const withSource = await canvasBox();
    check(await reachable('#sourcepanel'), 'the open drawer is not reachable by Tab');

    await page.click('#toggleRail');
    await laidOut(page);
    const noRail = await canvasBox();
    check(!(await reachable('#rail')), 'the collapsed inspector is still in the tab order');

    await page.click('#toggleSrc');
    await laidOut(page);
    const bare = await canvasBox();

    // Keyboard is the other way in, and must land in the same state.
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Control+e');
    await laidOut(page);
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
    const described = await describedBy(page, '#fit');
    check(!!described, 'a shown tooltip does not describe its control');
    check(
      (await page.getAttribute(`#${described}`, 'aria-hidden')) === 'false',
      'the tooltip is hidden from the accessibility tree while shown',
    );

    /* The same, for a checkbox inside a wrapping `<label>`. Put the description
       on the label as a `title` and the tooltip describes the words while the
       checkbox is announced with a name and nothing else, so a person using a
       screen reader cannot find out what "Pixel fit" does. Focus rather than
       hover, because focus is the case a keyboard has. */
    await tab(page, 'doc');
    await page.focus('#pixelFit');
    await settle(page);
    const onControl = await page.getAttribute('#pixelFit', 'aria-describedby');
    check(!!onControl, 'a focused checkbox is not described by its tooltip');

    /* The same, for a control the panel has to scroll to reach. Focusing one
       below the fold scrolls the rail, and a scroll handler that hides tooltips
       kills the one focus is about to show, so tabbing through a panel describes
       only what was already on screen. Whether `#pixelFit` above is on screen
       depends on the window, so that check passes or fails by luck; this one
       forces the scroll. */
    await page.evaluate(() => {
      document.querySelector('#panel-doc').scrollTop = 0;
      document.activeElement instanceof HTMLElement && document.activeElement.blur();
    });
    await settle(page);
    const far = '#backPick';
    const moved = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const box = el.getBoundingClientRect();
      return box.bottom > window.innerHeight || box.top < 0;
    }, far);
    await page.focus(far);
    await settle(page);
    const afterScroll = await page.getAttribute(far, 'aria-describedby');
    check(
      !!afterScroll,
      `focusing ${far} (off screen: ${moved}) left it undescribed: the scroll hid its tooltip`,
    );
    const onLabel = await page.$eval('#pixelFit', (el) =>
      el.closest('label').hasAttribute('aria-describedby'),
    );
    check(!onLabel, 'the description is on the label rather than the control');

    /* And hovering the words, which is most of the target and the only part a
       mouse is likely to hit. The title lives on the input now, so this only
       works because the tooltip resolves a label to its control. */
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await settle(page);
    /* Cleared first, and asserted cleared. Without this the check below passed
       on the description left behind by the focus above -- it was measuring
       nothing, and said so only when the code it was meant to guard was
       removed and it kept passing. */
    check(
      !(await page.getAttribute('#pixelFit', 'aria-describedby')),
      'the description outlives the focus that showed it',
    );
    await page.hover('label:has(#pixelFit)');
    check(
      !!(await describedBy(page, '#pixelFit')),
      'hovering the label shows nothing, so the words are not part of the control',
    );

    // Leave it inverted, so the screenshot shows the other half of the palette.
    // `settle`: a theme swap repaints and resizes nothing.
    await page.click('#theme');
    await settle(page);

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
  async gridHonesty(page, check) {
    await tab(page, 'doc');
    /* Returns what the grid drew at a step and a zoom, so the assertions below
       can compare readings taken at different ones. */
    const atStep = async (step, zoomOuts) => {
      await page.fill('#gridStep', String(step));
      await page.dispatchEvent('#gridStep', 'input');
      for (let i = 0; i < zoomOuts; i++) await page.click('#zoomout');
      await settle(page);

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
    out.step1 = await atStep(1, 0);
    out.step1_zoomedOut = await atStep(1, 6);
    await page.click('#fit');
    out.step0_3 = await atStep(0.3, 0);
    out.step0_3_zoomedOut = await atStep(0.3, 5);
    await page.click('#fit');
    out.step2_5 = await atStep(2.5, 2);

    /* Every drawn line is a snap position. `offLattice` was being measured at
       each step and returned unread, which is the whole claim of this scenario
       sitting in the output where nothing could disagree with it. Zooming out
       is allowed to draw fewer lines and never a different lattice, so the
       zoomed-out readings are held to the same rule as the others. */
    for (const [when, r] of Object.entries(out)) {
      check(r.lines > 0, `no grid lines drawn at ${when}`);
      check(r.offLattice.length === 0, `${when} drew lines off the lattice at ${r.offLattice.join(', ')}`);
      check(r.readout.length > 0, `the grid readout is empty at ${when}`);
    }
    check(out.step1_zoomedOut.lines <= out.step1.lines, 'zooming out drew more lines, not fewer');
    return out;
  },

  /**
   * The live measurement in the status strip.
   *
   * The jsdom tests cover `controller.measure()` returning the right numbers.
   * They cannot cover whether the strip shows them. The slot carries `hidden`,
   * and `.rd` sets `display: flex`, which beats that attribute on specificity
   * -- so the slot stayed on screen through every test that never consulted a
   * real stylesheet. This is the check that would have caught it.
   *
   * Read mid-drag, which `mk`'s `drag` cannot do because it releases at the
   * end, so the press and the moves are spelled out here.
   */
  async measureReadout(page, check) {
    const { toClient } = await mk(page);

    /* Both the attribute and the computed style. Either alone is passable for
       the wrong reason: `hidden` was set correctly the whole time it was
       displaying anyway. */
    const shown = () =>
      page.evaluate(() => {
        const el = document.querySelector('#measure');
        return {
          hidden: el.hidden,
          display: getComputedStyle(el).display,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        };
      });

    const out = { idle: await shown() };

    await page.click('#tool button[data-v="rect"]');
    const a = await toClient([20, 20]);
    const b = await toClient([60, 40]);
    await page.mouse.move(a[0], a[1]);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(a[0] + ((b[0] - a[0]) * i) / 6, a[1] + ((b[1] - a[1]) * i) / 6);
    }
    await settle(page);
    // 40 wide and 20 tall. The diagonal is 44.7, and reading that here would
    // mean the box and vector cases had been confused.
    out.duringCreate = await shown();

    await page.mouse.up();
    await settle(page);
    out.afterRelease = await shown();

    /* Now a move, which is the other shape of measurement. On the top edge of
       the rectangle, not inside it: the shape has no fill, so a press in the
       middle hits nothing and sweeps a marquee instead, which reports a 15 by 0
       box: a true reading of the wrong gesture.

       And at x = 30 rather than the middle of the edge, because the shape is
       selected and its scale handles sit at the corners and edge midpoints.
       The midpoint press started a transform, which is silent by design, so
       the readout was correctly empty for a gesture this was not testing. */
    await page.click('#tool button[data-v="select"]');
    const c = await toClient([30, 20]);
    const d = await toClient([45, 20]);
    await page.mouse.move(c[0], c[1]);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(c[0] + ((d[0] - c[0]) * i) / 6, c[1]);
    }
    await settle(page);
    // Straight right: 15 units at 0 degrees.
    out.duringMove = await shown();
    await page.mouse.up();
    await settle(page);
    out.afterMove = await shown();

    /* `display` as well as `hidden`, because `.rd` sets `display: flex` and
       beats the attribute on specificity: the slot carried `hidden` correctly
       the whole time it was on screen, so the attribute alone passes for a
       document that shows the readout permanently.

       The two live readings are the sizes named above: 40 by 20 rather than
       the 44.7 diagonal, which is the box and vector cases being confused, and
       15 at 0 degrees for a move straight to the right. */
    for (const [when, r] of [['idle', out.idle], ['afterRelease', out.afterRelease], ['afterMove', out.afterMove]]) {
      check(r.hidden === true, `the readout is not marked hidden when ${when}`);
      check(r.display === 'none', `the readout still displays ${r.display} when ${when}`);
    }
    for (const [when, r] of [['duringCreate', out.duringCreate], ['duringMove', out.duringMove]]) {
      check(r.hidden === false, `the readout is marked hidden during ${when}`);
      check(r.display !== 'none', `the readout is not displayed during ${when}`);
    }
    check(/40\.000 . 20\.000/.test(out.duringCreate.text), `drawing read "${out.duringCreate.text}"`);
    check(/15\.000 at 0/.test(out.duringMove.text), `moving read "${out.duringMove.text}"`);
    return out;
  },

  /**
   * Make one shape, and whether the hole is real.
   *
   * The jsdom tests prove the two paths end up in one shape untouched. They
   * cannot prove the browser then draws a hole, because that is the renderer
   * applying `fill-rule` and jsdom has no renderer. `isPointInFill` is the
   * browser's own answer to "is this point painted", fill rule included, so it
   * measures the thing rather than a proxy for it.
   */
  async makeOneShape(page, check) {
    /* Set through the source drawer rather than drawn, for the reason
       `combine` does the same: the document boots with a starter shape and a
       camera fitted to it, so a drawn square lands in a scene that already has
       something in it and the corners of a marquee fall outside the view. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <rect x="10" y="10" width="40" height="40" fill="#2563d8"/>
  <rect x="20" y="20" width="20" height="20" fill="#e8a54b"/>
</svg>`,
    );
    await page.click('#apply');
    await tab(page, 'doc');
    await page.check('#filled');
    await tab(page, 'shape');
    await settle(page);

    /* `isPointInFill` is the browser answering "is this point painted", with
       the fill rule applied. Counting subpaths would only prove the document,
       which the jsdom tests already do. */
    const painted = () =>
      page.evaluate(() => {
        const paths = [...document.querySelectorAll('.artwork path')];
        const at = (x, y) => paths.some((p) => p.isPointInFill(new DOMPoint(x, y)));
        return {
          paths: paths.length,
          // Dead centre, inside the inner square. This is where a hole goes.
          centre: at(30, 30),
          // Between the two squares, painted under either rule. The control:
          // without it, a shape that vanished entirely would read as a hole.
          between: at(14, 14),
          rules: [...new Set(paths.map((p) => getComputedStyle(p).fillRule))],
        };
      });

    const out = { start: await painted() };

    // With nothing selected the button must be unreachable, not merely inert.
    out.disabledWhenIdle = await page.isDisabled('#makeone');

    await page.click('#shapelist li:nth-child(1)');
    await page.click('#shapelist li:nth-child(2)', { modifiers: ['Shift'] });
    await settle(page);
    out.enabledWithTwo = !(await page.isDisabled('#makeone'));

    await page.click('#makeone');
    await settle(page);
    out.message = (await page.textContent('#status')).trim();
    check(/now holds 2 paths\./.test(out.message), `Make one shape said "${out.message}"`);
    // One path element now, and no hole: nonzero fills both squares.
    out.nonzero = await painted();

    await page.click('button[data-fr="evenodd"]');
    await settle(page);
    // Same geometry, same element. Only the middle changed.
    out.evenodd = await painted();

    out.combined = await page.inputValue('#src');

    /* Back out again. The button's enabled state is the part worth checking
       here: it does not follow the selection count like the booleans do, it
       follows whether anything selected holds more than one path. */
    out.splitEnabled = !(await page.isDisabled('#splitshape'));
    await page.click('#splitshape');
    await settle(page);
    out.splitMessage = (await page.textContent('#status')).trim();
    check(/2 shapes/.test(out.splitMessage), `Split into shapes said "${out.splitMessage}"`);
    // Two elements again, and the hole is gone: an inner path in its own
    // shape is a filled shape, whatever the rule says.
    out.afterSplit = await painted();
    // Nothing left to split, so the button goes back even though both new
    // shapes are selected.
    out.splitEnabledAfter = !(await page.isDisabled('#splitshape'));
    out.d = await page.inputValue('#src');

    check(out.start.paths === 2 && out.start.centre, 'the two squares did not start as two filled paths');
    check(out.disabledWhenIdle, 'Make one shape is reachable with nothing selected');
    check(out.enabledWithTwo, 'Make one shape stayed disabled with two shapes selected');

    /* The hole, which is the whole scenario. Same geometry and the same element
       in both readings: only the rule changed, so `centre` going false is the
       renderer applying `evenodd` and nothing else it could be. `between` is
       the control -- it is painted under either rule, so a shape that vanished
       cannot pass for a hole. */
    check(out.nonzero.paths === 1, `Make one shape left ${out.nonzero.paths} paths`);
    check(out.nonzero.centre, 'nonzero punched a hole, which is the rule it is not');
    check(out.evenodd.centre === false, 'evenodd painted the middle, so there is no hole');
    check(out.nonzero.between && out.evenodd.between, 'the shape between the squares is unpainted under one of the rules');
    check(out.evenodd.rules.join() === 'evenodd', `the element reads fill-rule ${out.evenodd.rules.join()}`);

    check(out.splitEnabled, 'Split was disabled on a shape holding two paths');
    check(out.afterSplit.paths === 2, `Split left ${out.afterSplit.paths} paths`);
    // An inner path in its own shape is a filled shape, whatever the rule says.
    check(out.afterSplit.centre, 'the hole survived the split');
    check(out.splitEnabledAfter === false, 'Split stayed enabled with nothing left to split');

    return out;
  },

  /**
   * Within 0, on the gesture that found the bug.
   *
   * Double-clicking an outline splits a segment, which adds a node that says
   * nothing: the two halves still trace the curve their parent traced. The old
   * Simplify could not see that, because it resampled and refitted rather than
   * asking whether a node was removable, so the answer to "put it back" was a
   * different shape. Within 0 is the fix, and the assertion is the exported `d`:
   * not a smaller node count, not a similar outline, the same string.
   *
   * Only a browser can run this. The insertion is a double-click at a client
   * pixel, and where that lands on the document is the camera's answer.
   */
  async simplifyWithinZero(page, check) {
    const nodes = async () => +/(\d+) nodes/.exec(await page.textContent('#stats'))[1];

    // Read the starter as path data, then give the canvas its space back.
    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await closeSource(page);
    const before = (await page.inputValue('#src')).trim();
    const nodesIn = await nodes();
    check(nodesIn === 8, `the starter shape has ${nodesIn} nodes, not 8`);

    /* Where to double-click, asked of the drawing rather than guessed. A point
       near an existing anchor selects it instead of splitting anything, and a
       hard-coded coordinate that drifts onto one turns this scenario into a
       silent no-op that still passes the "d unchanged" test. So: sample the
       outline, keep only the samples far from every anchor, and spread the four
       picks along the path. */
    const spots = await page.evaluate(() => {
      const path = document.querySelector('.artwork path');
      const m = document.querySelector('.overlay').getScreenCTM();
      const total = path.getTotalLength();
      const anchors = [...document.querySelectorAll('.overlay .n')].map((el) => {
        const r = el.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      });
      const near = (p) => Math.min(...anchors.map(([x, y]) => Math.hypot(p[0] - x, p[1] - y)));
      const samples = [];
      for (let i = 0; i < 400; i++) {
        const at = path.getPointAtLength((i / 400) * total);
        const c = new DOMPoint(at.x, at.y).matrixTransform(m);
        samples.push({ client: [c.x, c.y], clear: 0 });
      }
      for (const s of samples) s.clear = near(s.client);
      const picked = [];
      for (const s of samples.sort((a, b) => b.clear - a.clear)) {
        if (s.clear < 30) break;
        if (picked.every((p) => Math.hypot(p.client[0] - s.client[0], p.client[1] - s.client[1]) > 60)) {
          picked.push(s);
        }
        if (picked.length === 4) break;
      }
      return picked.map((p) => p.client);
    });
    check(spots.length === 4, `found ${spots.length} places on the outline clear of an anchor, wanted 4`);

    for (const [i, [x, y]] of spots.entries()) {
      const was = await nodes();
      await page.mouse.dblclick(x, y);
      await settle(page);
      const now = await nodes();
      check(now === was + 1, `double-click ${i + 1} took the count from ${was} to ${now}`);
    }
    const added = await nodes();

    // Within 0 is a real setting, not a refusal, and Redraw has nothing to do
    // at it: nothing is being refitted, so the checkbox says so by greying out.
    await page.click('#shapelist li');
    await settle(page);
    await page.fill('#simplifyTol', '0');
    await page.dispatchEvent('#simplifyTol', 'input');
    await settle(page);
    const redrawDisabled = await page.isDisabled('#simplifyRedraw');
    check(redrawDisabled, 'Redraw curves stayed enabled at Within 0');

    await page.click('#simplify');
    await settle(page);
    const status = (await page.textContent('#status')).trim();
    const after = await nodes();
    check(after === nodesIn, `Within 0 left ${after} nodes, not the ${nodesIn} it started with`);

    /* The whole claim. Four nodes went in and four came out, and the file is
       byte-for-byte what it was: the removal is exact, not merely close. */
    const d = (await page.inputValue('#src')).trim();
    check(d === before, `the path changed:\n  before ${before}\n  after  ${d}`);

    // One edit. Undo brings back all four, not the last one.
    await undo(page);
    const undone = await nodes();
    check(undone === added, `undo restored ${undone} nodes, not ${added}`);

    return { nodesIn, added, after, redrawDisabled, status, unchanged: d === before };
  },

  /**
   * The keyline grid: drawn, measured, snapped to, and never exported.
   *
   * The arithmetic is unit-tested. What only a browser can show is that the
   * lines reach the DOM at the coordinates the model computed, that the
   * checkbox actually removes them, and that a pointer near a keyline lands on
   * it -- which goes through the camera, the hit tolerance in screen pixels and
   * the snapper, none of which jsdom exercises together.
   */
  async keylines(page, check) {
    const { toClient, click } = await mk(page);

    /* A square page of 240, so the grid is the page and every keyline lands on
       a whole number: live 200, square 180, circle 200, rectangles 160 by 200.
       The starter document is 88 by 64, where the grid inscribes on 64 and the
       readout fills with two-decimal numbers nobody can check by eye.

       Applied through the source drawer with a frame drawn on the page edge,
       rather than by typing into the Canvas fields, because the camera does not
       follow the page -- resizing the canvas is deliberately not a request to
       move the view -- and `Fit` fits the drawing. With nothing drawn out
       there, the whole grid stays off screen and every pointer coordinate below
       lands somewhere the overlay never sees. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
        '<path d="M0 0 H240 V240 H0 Z" fill="none" stroke="#888"/></svg>',
    );
    await page.click('#apply');
    await settle(page);
    await closeSource(page);
    await page.click('#fit');
    await settle(page);
    await tab(page, 'doc');

    const drawn = () =>
      page.evaluate(() => {
        const one = (sel) => {
          const el = document.querySelector(sel);
          const d = el.getAttribute('d') ?? '';
          if (!d) return { d: '', box: null };
          const b = el.getBBox();
          return { d, box: { x: b.x, y: b.y, w: b.width, h: b.height } };
        };
        return { live: one('.keyline-live'), shapes: one('.keyline') };
      });

    const off = await drawn();
    check(!off.live.d && !off.shapes.d, 'keylines were drawn before the checkbox was ticked');

    await page.check('#showKeylines');
    await settle(page);
    const on = await drawn();
    check(!!on.live.d && !!on.shapes.d, 'ticking the box drew nothing');

    /* The published numbers, measured off the DOM rather than recomputed. On a
       240 grid: live 200, circle 200, square 180, rectangles 160 by 200 -- so
       the four keylines together span the circle's 200 and sit centred. */
    const near = (a, b, what) => check(Math.abs(a - b) < 0.02, `${what}: ${a}, wanted ${b}`);
    near(on.live.box.w, 200, 'live width');
    near(on.live.box.h, 200, 'live height');
    near(on.live.box.x, 20, 'live left');
    near(on.shapes.box.w, 200, 'keyline span');
    near(on.shapes.box.x, 20, 'keyline left');

    const info = (await page.textContent('#keylineinfo')).trim();
    check(
      /240 grid/.test(info) && /circle 200/.test(info) && /square 180/.test(info),
      `the readout says "${info}"`,
    );

    /* Snapping. The square keyline's left edge is at x = 30, and the pointer
       goes to 30.6, 120.9 -- which is nearer a gridline than the edge, so a
       landing on 30 is the tier rule and not a coincidence. Drawn with the pen
       so the placed node is the snapped point.

       The status line names what claimed it. A keyline answers the same tier
       a real outline does -- there is no fourth tier -- but the readout says
       which of them it was, because `on an outline` with no outline there is a
       true statement about the rule and a false one about the drawing. */
    await page.click('#tool button[data-v="pen"]');
    const c = await toClient([30.6, 120.9]);
    await page.mouse.move(c[0], c[1]);
    await settle(page);
    const snapkind = (await page.textContent('#snapkind')).trim();
    check(snapkind === 'on a keyline', `hovering a keyline reported "${snapkind}"`);

    await click([30.6, 120.9]);
    await settle(page);
    /* A second node, well clear of every keyline. One node is not a path the
       editor will keep, so with a single click Escape leaves nothing behind and
       the check below reads the frame instead and fails on the wrong thing. */
    await click([100, 235]);
    await settle(page);
    await page.keyboard.press('Escape');
    await settle(page);

    const placed = await page.evaluate(() => {
      const path = document.querySelectorAll('.artwork path');
      const m = /M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(path[path.length - 1].getAttribute('d'));
      return m ? [+m[1], +m[2]] : null;
    });
    check(placed !== null, 'the pen placed nothing');
    near(placed[0], 30, 'the placed node landed off the keyline');

    /* And the guarantee that makes this safe: keylines come from the viewBox
       and are never in the model, so the export cannot carry one. Checking the
       source text is the honest version -- the renderer could be doing anything
       and the file is what leaves the editor. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    const svg = await page.inputValue('#src');
    check(!/keyline/i.test(svg), 'the exported SVG mentions a keyline');
    // Two paths: the frame and the pen's line. A keyline that had leaked into
    // the model would be a third, and counting is what catches it.
    const paths = (svg.match(/<path/g) ?? []).length;
    check(paths === 2, `the export carries ${paths} paths, not the 2 that were drawn`);
    await closeSource(page);

    // Unticking takes them away again, which is the other half of a checkbox.
    await page.uncheck('#showKeylines');
    await settle(page);
    const gone = await drawn();
    check(!gone.live.d && !gone.shapes.d, 'unticking left the keylines drawn');

    return { info, live: on.live.box, shapes: on.shapes.box, snapkind, placed, paths };
  },

  /**
   * Rulers and guides: the gesture, the snap, and the way back out.
   *
   * Everything here needs a browser. A guide is dragged out of a strip that is
   * laid out by CSS grid, tracked through a pointer capture on an element that
   * is not the overlay, and dropped somewhere measured against the stage's box.
   * The unit tests own the list and the priority order; this owns the parts
   * where the page itself has to be right.
   */
  async guides(page, check) {
    const { toClient, click } = await mk(page);
    /* Counted on the `display` attribute, not with `:visible` and not by
       counting elements. Two traps, one after the other: the overlay pools its
       elements, so a removed guide leaves its `<line>` in the DOM with its last
       coordinates still on it -- which reported two guides after one had been
       dropped, with the app right the whole time. And Playwright's `:visible`
       wants a non-empty box, which a vertical line never has. */
    const count = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('.guide')].filter(
            (el) => el.getAttribute('display') !== 'none',
          ).length,
      );
    const positions = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.guide')].filter((el) => el.getAttribute('display') !== 'none').map((el) => {
          const x1 = +el.getAttribute('x1');
          const y1 = +el.getAttribute('y1');
          return x1 === +el.getAttribute('x2') ? ['x', x1] : ['y', y1];
        }),
      );

    await tab(page, 'doc');
    check((await count()) === 0, 'the document started with guides');

    await page.check('#showRulers');
    await settle(page);

    /* The layout, measured rather than assumed. An `<svg>` with a viewBox is a
       replaced element with an intrinsic aspect ratio, and `align-self:
       stretch` does not apply to one: left to itself the horizontal ruler took
       its height from that ratio and drew a 550 px strip down the middle of the
       drawing. Nothing in a unit test can see that. */
    const boxes = await page.evaluate(() => {
      const b = (s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      return { canvas: b('#canvas'), h: b('#rulerH'), v: b('#rulerV'), stage: b('#stage') };
    });
    check(boxes.h.h < 40, `the horizontal ruler is ${boxes.h.h} px tall`);
    check(boxes.v.w < 40, `the vertical ruler is ${boxes.v.w} px wide`);
    // The rulers take their space from the drawing rather than floating over
    // it, which is the rule every panel here follows.
    check(
      Math.abs(boxes.stage.h - (boxes.canvas.h - boxes.h.h)) < 2,
      `the stage is ${boxes.stage.h} of the canvas's ${boxes.canvas.h}, with a ${boxes.h.h} ruler`,
    );

    // Drag a horizontal guide out of the top ruler, down to y = 30.
    const to = await toClient([44, 30]);
    await page.mouse.move(boxes.h.x + boxes.h.w / 2, boxes.h.y + boxes.h.h / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(boxes.h.x + boxes.h.w / 2, boxes.h.y + ((to[1] - boxes.h.y) * i) / 8);
    }
    await page.mouse.up();
    await settle(page);
    check((await count()) === 1, `dragging out of the ruler left ${await count()} guides`);
    const first = (await positions())[0];
    check(first[0] === 'y' && Math.abs(first[1] - 30) < 0.001, `it landed at ${first}`);

    // And a vertical one out of the left ruler, which is the other axis and
    // the case a copy-pasted handler gets wrong.
    const to2 = await toClient([30, 32]);
    await page.mouse.move(boxes.v.x + boxes.v.w / 2, boxes.v.y + boxes.v.h / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(boxes.v.x + ((to2[0] - boxes.v.x) * i) / 8, boxes.v.y + boxes.v.h / 2);
    }
    await page.mouse.up();
    await settle(page);
    check((await count()) === 2, `the vertical drag left ${await count()} guides`);

    // The ruler is labelled, and both strips are.
    const nums = await page.evaluate(() => ({
      h: document.querySelectorAll('#rulerH .num').length,
      v: document.querySelectorAll('#rulerV .num').length,
    }));
    check(nums.h > 2 && nums.v > 2, `ruler labels: ${JSON.stringify(nums)}`);

    /* Both rulers label on lines the grid actually drew, which is the claim
       the borrowed step exists to make. Checked at six zoom levels rather than
       one: the 1-2-5 ladder quantises, so a ruler computing its spacing from
       the wrong axis agrees with the grid at most zooms and parts from it at a
       few. One reading would have passed over exactly that.

       `rulers.ts` has no unit test -- it is DOM and measurement all the way
       down -- so this is the only thing standing under it. */
    const spacing = () =>
      page.evaluate(() => {
        const labels = (sel) =>
          [...document.querySelectorAll(sel)].map((e) => +e.textContent).sort((a, b) => a - b);
        const gaps = (v) => [...new Set(v.slice(1).map((n, i) => +(n - v[i]).toFixed(6)))];
        const d = document.querySelector('.grid-major').getAttribute('d') ?? '';
        const vert = [...d.matchAll(/M(-?[\d.]+) -?[\d.]+V/g)].map((m) => +m[1]).sort((a, b) => a - b);
        const horz = [...d.matchAll(/M-?[\d.]+ (-?[\d.]+)H/g)].map((m) => +m[1]).sort((a, b) => a - b);
        return {
          hLabels: gaps(labels('#rulerH .num')),
          vLabels: gaps(labels('#rulerV .num')),
          gridX: gaps(vert),
          gridY: gaps(horz),
        };
      });

    const zooms = [];
    for (let z = 0; z < 6; z++) {
      const m = await spacing();
      const one = (a) => (a.length === 1 ? a[0] : null);
      const hl = one(m.hLabels);
      const vl = one(m.vLabels);
      const gx = one(m.gridX);
      const gy = one(m.gridY);
      check(
        hl !== null && gx !== null && Math.abs(hl - gx) < 1e-6,
        `zoom ${z}: the top ruler labels every ${hl} and the grid draws every ${gx}`,
      );
      check(
        vl !== null && gy !== null && Math.abs(vl - gy) < 1e-6,
        `zoom ${z}: the left ruler labels every ${vl} and the grid draws every ${gy}`,
      );
      zooms.push(hl);
      await page.click('#zoomout');
      await settle(page);
    }
    for (let z = 0; z < 6; z++) {
      await page.click('#zoomin');
      await settle(page);
    }

    /* The crossing. Aim a pen click a third of a unit off both guides, from
       which the vertex tier should return the crossing exactly. The readout
       names the crossing rather than the tier: two guides meeting is a
       different thing from a node, and both are 0-D. */
    await page.click('#tool button[data-v="pen"]');
    const near = await toClient([30.3, 30.3]);
    await page.mouse.move(near[0], near[1]);
    await settle(page);
    const snapkind = (await page.textContent('#snapkind')).trim();
    check(snapkind === 'where guides cross', `hovering the crossing reported "${snapkind}"`);

    await click([30.3, 30.3]);
    await settle(page);
    await click([70, 55]);
    await settle(page);
    await page.keyboard.press('Escape');
    await settle(page);

    const placed = await page.evaluate(() => {
      const all = document.querySelectorAll('.artwork path');
      const m = /M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(all[all.length - 1].getAttribute('d'));
      return m ? [+m[1], +m[2]] : null;
    });
    check(placed !== null, 'the pen placed nothing');
    check(
      Math.abs(placed[0] - 30) < 0.001 && Math.abs(placed[1] - 30) < 0.001,
      `the node landed at ${placed}, not on the crossing`,
    );

    /* Locked guides stop being draggable but keep snapping, which is the
       distinction the two checkboxes exist to make. */
    await page.click('#tool button[data-v="select"]');
    await page.check('#guidesLocked');
    await settle(page);
    const lockedHits = await page.evaluate(
      () =>
        getComputedStyle(
          [...document.querySelectorAll('.guide-hit')].find(
            (el) => el.getAttribute('display') !== 'none',
          ),
        ).pointerEvents,
    );
    check(lockedHits === 'none', `locked guides still take a press: ${lockedHits}`);
    await page.uncheck('#guidesLocked');
    await settle(page);

    // Drag one off the canvas, which is how you put a guide away.
    const on = await toClient([30, 40]);
    await page.mouse.move(on[0], on[1]);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(on[0] - ((on[0] - (boxes.v.x + 2)) * i) / 6, on[1]);
    }
    await page.mouse.up();
    await settle(page);
    const afterDrop = await count();
    check(afterDrop === 1, `dropping a guide on the ruler left ${afterDrop}`);
    const dropMsg = (await page.textContent('#status')).trim();
    check(/^Guide removed\./.test(dropMsg), `dropping a guide on the ruler said "${dropMsg}"`);

    // And it is one undo step, not one per pointermove.
    await undo(page);
    check((await count()) === 2, `undo left ${await count()} guides`);

    // Clear takes the rest, in one step of its own.
    await page.click('#guideClear');
    await settle(page);
    check((await count()) === 0, `Clear guides left ${await count()}`);
    const clearMsg = (await page.textContent('#status')).trim();
    check(/^Removed 2 guides\./.test(clearMsg), `Clear guides said "${clearMsg}"`);
    await undo(page);
    check((await count()) === 2, `undoing Clear left ${await count()}`);

    /* And the guarantee: a guide is not in the document, so it cannot be in
       the file. Checked on the text that leaves the editor. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    const svg = await page.inputValue('#src');
    check(!/guide/i.test(svg), 'the exported SVG mentions a guide');
    await closeSource(page);

    return { boxes, nums, zooms, snapkind, placed, dropMsg, clearMsg };
  },

  /**
   * Smart guides: the line appears, the drag holds to it, both go away.
   *
   * The arithmetic is unit-tested against boxes. What needs a browser is that
   * the boxes handed in are the right ones -- the selection's at the press and
   * every other shape's -- and that the line is drawn where the alignment says
   * and removed when the drag ends.
   */
  async smartGuides(page, check) {
    const { toClient } = await mk(page);

    /* Two rectangles, one above the other. The upper one's left edge is at 10.5,
       deliberately off the grid. At 10 the grid lands the drag on the alignment
       by itself, and the scenario then passes with the whole feature removed. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 64">' +
        '<path d="M10.5 10 H30.5 V26 H10.5 Z" fill="none" stroke="#888"/>' +
        '<path d="M50 40 H70 V52 H50 Z" fill="none" stroke="#2563d8"/></svg>',
    );
    await page.click('#apply');
    await settle(page);
    await closeSource(page);

    const lines = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.smart')]
          .filter((e) => e.getAttribute('display') !== 'none')
          .map((e) => ({
            cls: e.getAttribute('class'),
            x1: +e.getAttribute('x1'),
            y1: +e.getAttribute('y1'),
            x2: +e.getAttribute('x2'),
            y2: +e.getAttribute('y2'),
          })),
      );

    check((await lines()).length === 0, 'alignment lines were drawn before any drag');

    /* Drag the lower rectangle by its top edge to within 0.2 of the upper
       one's left edge. Grabbed on the edge, not the middle: the shapes have no
       fill, so a press inside one hits nothing and sweeps a marquee.

       The pointer asks for a left edge at 10.7. The grid would give 11 and the
       alignment gives 10.5, so the three answers are all different and the
       assertion below can only be satisfied one way. */
    const from = await toClient([60, 40]);
    const to = await toClient([20.7, 40]);
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 10, from[1]);
    }
    await settle(page);

    const live = await lines();
    check(live.length === 1, `${live.length} alignment lines, wanted 1`);
    const l = live[0];
    check(/edge/.test(l.cls), `the line reads as "${l.cls}", not an edge`);
    check(l.x1 === 10.5 && l.x2 === 10.5, `the line sits at x = ${l.x1}, not 10.5`);
    /* And it spans both boxes, top of the upper one to bottom of the lower.
       A line covering only the shape being dragged would say nothing about
       what it had lined up with. */
    check(l.y1 === 10 && l.y2 === 52, `the line spans ${l.y1} to ${l.y2}, not 10 to 52`);

    await page.mouse.up();
    await settle(page);
    check((await lines()).length === 0, 'the alignment line outlived the drag');

    /* The drag was held to the alignment, not merely decorated with it: the
       pointer asked for 10.4 and the shape is at 10. */
    await openSource(page);
    const svg = await page.inputValue('#src');
    const moved = /M\s*(-?[\d.]+)\s+(-?[\d.]+)\s+H/g;
    const xs = [...svg.matchAll(moved)].map((m) => +m[1]);
    check(xs.length === 2, `expected two rectangles in the export, found ${xs.length}`);
    check(xs[1] === 10.5, `the dragged rectangle landed at x = ${xs[1]}, not 10.5`);
    await closeSource(page);

    // And the switch turns it off, which is the other half of a checkbox.
    await tab(page, 'doc');
    await page.uncheck('#smartGuides');
    await settle(page);
    const from2 = await toClient([20.5, 40]);
    const to2 = await toClient([40.7, 40]);
    await page.mouse.move(from2[0], from2[1]);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(from2[0] + ((to2[0] - from2[0]) * i) / 6, from2[1]);
    }
    await settle(page);
    const off = await lines();
    await page.mouse.up();
    check(off.length === 0, `${off.length} alignment lines with the switch off`);

    return { live, xs };
  },

  /**
   * Angular snap: rays, and the pointer held to one.
   *
   * The maths is unit-tested. What needs a browser is the implicit origin --
   * the rays come from wherever the gesture started, which means the pen's last
   * node -- and that the readout names what claimed the pointer rather than the
   * tier it belongs to.
   */
  async angles(page, check) {
    const { toClient, toDoc, click } = await mk(page);
    const rays = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('.ray')].filter(
            (e) => e.getAttribute('display') !== 'none',
          ).length,
      );

    await tab(page, 'doc');
    check((await rays()) === 0, 'rays were drawn before angular snap was on');
    await page.check('#snapAngles');
    await settle(page);
    /* Still none: the switch is on but nothing is being drawn and no origin has
       been set, so there is nothing to radiate from. Drawing a fan from a point
       nobody chose would be worse than drawing none. */
    check((await rays()) === 0, `${await rays()} rays with no origin and no gesture`);

    // The pen's last node becomes the origin, which is the implicit case.
    await page.click('#tool button[data-v="pen"]');
    await click([30, 30]);
    await settle(page);
    const fan = await rays();
    check(fan === 8, `${fan} rays at 45 degrees, wanted 8`);

    /* Aim 0.6 off the 45 degree ray and 0.4 off the lattice, so the two tiers
       want different answers and the ray has to win by rule rather than by
       being nearer. */
    const near = await toClient([50, 49.4]);
    await page.mouse.move(near[0], near[1]);
    await settle(page);
    const kind = (await page.textContent('#snapkind')).trim();
    check(kind === 'on an angle', `hovering a ray reported "${kind}"`);

    await click([50, 49.4]);
    await settle(page);
    await page.keyboard.press('Escape');
    await settle(page);

    const placed = await page.evaluate(() => {
      const all = document.querySelectorAll('.artwork path');
      const d = all[all.length - 1].getAttribute('d');
      const m = /L\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(d);
      return m ? [+m[1], +m[2]] : null;
    });
    check(placed !== null, 'the pen placed no second node');
    /* On the diagonal from (30, 30), which the grid alone would never give: it
       would have rounded to (50, 49), and the two coordinates would differ.

       Where on the diagonal is the pointer's own position projected onto it,
       and the pointer sits at whole pixel `near` rather than at the 50, 49.4
       asked for. So the expectation is computed from where the pointer is. The
       point 50, 49.4 projects to 49.7, and a constant of 49.7 here is only
       right on an engine that delivers a fractional pointer coordinate. */
    const at = await toDoc(near);
    const want = 30 + (at[0] - 30 + (at[1] - 30)) / 2;
    check(
      Math.abs(placed[0] - placed[1]) < 1e-6 && Math.abs(placed[0] - want) < 0.01,
      `the node landed at ${placed}, want ${want.toFixed(6)} on both axes`,
    );

    // A pinned origin, which is the explicit case, and it survives the gesture
    // ending: the rays stay because the origin is no longer borrowed.
    await page.click('#tool button[data-v="select"]');
    // The shape list lives in another tab, and a control in a tab you cannot
    // see is genuinely not there: `hidden` keeps it out of the hit test.
    await tab(page, 'shape');
    await page.click('#shapelist li');
    await settle(page);
    await tab(page, 'doc');
    await page.click('#angleFromSel');
    await settle(page);
    const pinned = await rays();
    check(pinned === 8, `${pinned} rays after pinning the origin`);
    const info = (await page.textContent('#angleinfo')).trim();
    check(/every 45° from/.test(info), `the readout says "${info}"`);

    await page.click('#angleClear');
    await settle(page);
    check((await rays()) === 0, 'freeing the origin left the rays drawn');

    return { fan, kind, placed, info };
  },

  /**
   * Snap where two outlines cross.
   *
   * The solver is unit-tested against curves. What a browser adds is that the
   * crossing is found through the whole stack -- camera, reach in screen
   * pixels, the tier order -- and that it beats the outline it sits on, which
   * is the case the feature exists for.
   */
  async crossings(page, check) {
    const { toClient, click } = await mk(page);

    /* Two straight runs crossing at (44.5, 32.5), deliberately off the grid:
       on a whole number the lattice would land on the crossing by itself and
       this scenario would pass with the feature removed. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 64">' +
        '<path d="M24.5 12.5 L64.5 52.5" fill="none" stroke="#888"/>' +
        '<path d="M24.5 52.5 L64.5 12.5" fill="none" stroke="#888"/></svg>',
    );
    await page.click('#apply');
    await settle(page);
    await closeSource(page);
    await tab(page, 'doc');

    // Off by default: it is the one target that is computed rather than looked
    // up, so it is not something you pay for without asking.
    /* Aimed 0.28 along the first diagonal from the crossing, so the pointer is
       exactly ON that outline and 0.28 from the crossing. Distance alone would
       give the outline every time; only the tier order gives the crossing. */
    const near = await toClient([44.7, 32.7]);
    await page.mouse.move(near[0], near[1]);
    await settle(page);
    const before = (await page.textContent('#snapkind')).trim();
    check(before !== 'where outlines cross', `crossings claimed the pointer while off: "${before}"`);

    await page.check('#snapCross');
    await settle(page);
    await page.mouse.move(near[0] + 1, near[1]);
    await page.mouse.move(near[0], near[1]);
    await settle(page);
    const after = (await page.textContent('#snapkind')).trim();
    check(after === 'where outlines cross', `hovering the crossing reported "${after}"`);

    // And the pointer lands on it.
    await page.click('#tool button[data-v="pen"]');
    await click([44.7, 32.7]);
    await settle(page);
    await click([80, 60]);
    await settle(page);
    await page.keyboard.press('Escape');
    await settle(page);

    const placed = await page.evaluate(() => {
      const all = document.querySelectorAll('.artwork path');
      const m = /M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(all[all.length - 1].getAttribute('d'));
      return m ? [+m[1], +m[2]] : null;
    });
    check(placed !== null, 'the pen placed nothing');
    check(
      Math.abs(placed[0] - 44.5) < 0.01 && Math.abs(placed[1] - 32.5) < 0.01,
      `the node landed at ${placed}, not on the crossing at 44.5, 32.5`,
    );

    return { before, after, placed };
  },

  /**
   * Auto-smooth nodes, end to end.
   *
   * The model tests own the derivation and the controller tests own the sweep.
   * What is left for a browser is the button: that it reads back as pressed,
   * that the fourth reading takes precedence over the smooth one it would
   * otherwise light up as, and that the export carries no trace of it.
   */
  async autoSmooth(page, check) {
    const { click, drag } = await mk(page);

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 64">' +
        '<path d="M20 40 L44 40 L68 40" fill="none" stroke="#2563d8"/></svg>',
    );
    await page.click('#apply');
    await settle(page);
    await closeSource(page);

    await click([44, 40]);
    await settle(page);
    await tab(page, 'node');

    const pressed = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#ntype button')]
          .filter((b) => b.getAttribute('aria-pressed') === 'true')
          .map((b) => b.getAttribute('data-v')),
      );
    check(JSON.stringify(await pressed()) === '["cusp"]', `starts as ${await pressed()}`);

    /* The in and out fields are filled either way, because a missing handle is
       shown where it would go. Nothing on the panel said which, so two
       identically drawn shapes differed for an invisible reason and Round
       refused one of them. */
    const ghosts = () => page.locator('#hix.ghost, #hiy.ghost, #hox.ghost, #hoy.ghost').count();
    check((await ghosts()) === 4, `a node with no handles ghosts ${await ghosts()} of 4 fields`);
    check(await page.isVisible('#handlewhy'), 'nothing said the handles were not there');

    await page.click('#ntype button[data-v="auto"]');
    await settle(page);
    check((await ghosts()) === 0, `after Auto, ${await ghosts()} fields still read as latent`);
    check(!(await page.isVisible('#handlewhy')), 'the latent note outlived the latent handles');
    /* Exactly one button lit, and it is Auto. An auto node is collinear by
       construction, so a display reading the handles alone would light Smooth
       as well and leave two buttons pressed at once. */
    const now = await pressed();
    check(JSON.stringify(now) === '["auto"]', `after Auto the pressed buttons are ${now}`);

    // Drag the right-hand node up. The middle one should re-aim itself, which
    // is the whole feature and is only visible in what gets drawn.
    const dEl = () => page.$eval('.artwork path', (el) => el.getAttribute('d'));
    const before = await dEl();
    await drag([68, 40], [68, 26]);
    await settle(page);
    const after = await dEl();
    check(before !== after, 'dragging the neighbour changed nothing');

    /* Both of the middle node's handles lie on the chord between its
       neighbours, so the two control points and the anchor are collinear. Read
       off the overlay rather than out of the path text, which the serialiser is
       free to spell with `S` and other shorthands. */
    await click([44, 40]);
    await settle(page);
    const trio = await page.evaluate(() => {
      const at = (hit) => {
        const el = document.querySelector(`[data-hit="${hit}"][data-sp="0"][data-i="1"]`);
        if (!el) return null;
        return el.tagName === 'rect'
          ? [+el.getAttribute('x') + +el.getAttribute('width') / 2, +el.getAttribute('y') + +el.getAttribute('height') / 2]
          : [+el.getAttribute('cx'), +el.getAttribute('cy')];
      };
      return { anchor: at('anchor'), inH: at('in'), outH: at('out') };
    });
    check(trio.anchor && trio.inH && trio.outH, `the overlay is missing part of the node: ${JSON.stringify(trio)}`);
    const cross =
      (trio.inH[0] - trio.anchor[0]) * (trio.outH[1] - trio.anchor[1]) -
      (trio.inH[1] - trio.anchor[1]) * (trio.outH[0] - trio.anchor[0]);
    check(Math.abs(cross) < 0.02, `the handles are not collinear: cross product ${cross}`);
    // And they went somewhere: a pair of handles collapsed onto the anchor is
    // collinear too, and says nothing.
    check(
      Math.hypot(trio.outH[0] - trio.anchor[0], trio.outH[1] - trio.anchor[1]) > 1,
      'the outgoing handle has no length',
    );
    /* And they FOLLOWED. Handles left where they started are still collinear,
       still have length, and are wrong -- so without this the scenario passed
       with the whole sweep removed. The chord now slopes, so a handle still
       lying flat is one that never re-derived. */
    check(
      Math.abs(trio.outH[1] - trio.anchor[1]) > 0.5,
      `the handles stayed flat at y = ${trio.outH[1]}, so nothing re-derived`,
    );

    await openSource(page);
    await page.click('#srcmode button[data-v="d"]');
    await settle(page);
    const d = await page.inputValue('#src');
    check(!/auto/i.test(d), 'the export mentions auto');
    await closeSource(page);

    // And pressing it again hands control back without moving anything.
    await page.click('#ntype button[data-v="auto"]');
    await settle(page);
    check(JSON.stringify(await pressed()) !== '["auto"]', 'Auto stayed pressed after a second press');
    check((await dEl()) === after, 'handing control back moved the drawing');

    return { now, before, after };
  },

  /**
   * Find in source: select a node, land the cursor on its command.
   *
   * Only a browser has a textarea with a selection in it. The offsets come from
   * the serialiser and are true of exactly the string it produced, so what this
   * checks is that the string in the box is that string and the range picks out
   * the right command.
   */
  async findInSource(page, check) {
    const { click } = await mk(page);

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 64">' +
        '<path d="M10 10 H40 V30 L20 44 Z" fill="none" stroke="#2563d8"/></svg>',
    );
    await page.click('#apply');
    await settle(page);
    await closeSource(page);

    // The third node, at (40, 30): the one the `V` command draws to.
    await click([40, 30]);
    await settle(page);
    await tab(page, 'node');
    await page.click('#findSrc');
    await settle(page);

    const got = await page.evaluate(() => {
      const el = document.querySelector('#src');
      return {
        mode: document.querySelector('#srcmode [aria-pressed="true"]')?.getAttribute('data-v'),
        open: document.querySelector('#app').classList.contains('src-open'),
        text: el.value,
        picked: el.value.slice(el.selectionStart, el.selectionEnd),
        focused: document.activeElement === el,
      };
    });

    // It forces path data, because the offsets are only true of that string.
    check(got.mode === 'd', `the source is in ${got.mode} mode`);
    check(got.open, 'the source drawer stayed shut');
    check(got.focused, 'the source box did not take focus');
    check(got.picked === 'V 30', `it selected "${got.picked}", not the V command`);
    const status = (await page.textContent('#status')).trim();
    check(/V/.test(status) && /0\/2/.test(status), `the status line says "${status}"`);

    /* A second node, to prove the range is computed rather than the first
       command being selected whatever you click. The `H` draws to (40, 10). */
    await closeSource(page);
    await click([40, 10]);
    await settle(page);
    await page.click('#findSrc');
    await settle(page);
    const second = await page.evaluate(() => {
      const el = document.querySelector('#src');
      return el.value.slice(el.selectionStart, el.selectionEnd);
    });
    check(second === 'H 40', `the second node selected "${second}"`);

    return { picked: got.picked, second, text: got.text };
  },

  /**
   * The saved-styles palette: save, apply, rename, delete.
   *
   * The state is a plain array and the interesting behaviour is all in the
   * panel -- whether applying one actually reaches the selected shape, and
   * whether the highlight lets go when the style stops matching.
   */
  async palette(page, check) {
    const { click } = await mk(page);
    const swatches = () => page.locator('#palette button').count();
    const lit = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('#palette button')].filter(
            (b) => b.getAttribute('aria-selected') === 'true',
          ).length,
      );

    await tab(page, 'shape');
    check((await swatches()) === 0, 'the palette started with something in it');

    // Save the style the panel is showing, with a width nobody else has.
    await page.fill('#strokeWidth', '3');
    await page.dispatchEvent('#strokeWidth', 'input');
    await settle(page);
    await page.click('#paletteSave');
    await settle(page);
    check((await swatches()) === 1, `${await swatches()} swatches after saving one`);
    check((await lit()) === 1, 'the saved swatch is not highlighted');

    /* Saving the same values twice keeps one swatch. Two identical entries
       under two names is a palette that cannot tell you anything. */
    await page.click('#paletteSave');
    await settle(page);
    check((await swatches()) === 1, `saving twice left ${await swatches()} swatches`);

    // Change the style by hand: the highlight has to let go, or it would be
    // claiming the shape has a style it does not.
    await page.fill('#strokeWidth', '1');
    await page.dispatchEvent('#strokeWidth', 'input');
    await settle(page);
    check((await lit()) === 0, 'the swatch stayed lit after the style changed');

    // Apply it to a real shape and check the export, not the panel.
    await click([44, 12]);
    await settle(page);
    await page.click('#palette button');
    await settle(page);
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    const svg = await page.inputValue('#src');
    check(/stroke-width="3"/.test(svg), `the shape did not take the saved width: ${svg.slice(0, 240)}`);
    await closeSource(page);

    // Rename, which is what makes it a *named* style.
    await page.dblclick('#palette button');
    await settle(page);
    await page.fill('#palette .rename', 'outline');
    await page.keyboard.press('Enter');
    await settle(page);
    const name = (await page.textContent('#palette button')).trim();
    check(name === 'outline', `the swatch is called "${name}"`);

    await page.click('#paletteDrop');
    await settle(page);
    check((await swatches()) === 0, `Delete style left ${await swatches()} swatches`);

    /* The key does what the button does. A swatch is a selected thing, and
       Delete is what removes a selected thing everywhere else here. */
    await page.click('#paletteSave');
    await settle(page);
    check((await swatches()) === 1, 'the second save did not land');
    await page.click('#palette button');
    await settle(page);
    await page.locator('#palette').press('Delete');
    await settle(page);
    check((await swatches()) === 0, `the Delete key left ${await swatches()} swatches`);

    return { name };
  },

  /**
   * Editing a node without ever using the pointer.
   *
   * `tools/keys.mjs` reports that every live control is reachable by Tab. What
   * it cannot see is whether those controls act on a selection only a click can
   * make, which would leave the Node panel pointer-only however tabbable its
   * buttons are. So this drives the whole route: pick a shape from the list,
   * walk to a node, extend, insert, and check the drawing changed.
   */
  async keyboardNodes(page, check) {
    const info = async () => (await page.textContent('#nodeinfo')).trim();
    const count = async () => +/(\d+) nodes/.exec(await page.textContent('#stats'))[1];

    const started = await count();
    await tab(page, 'shape');
    await page.click('#shapelist li');
    // Blur it, so the keys below are the editor's and not the list's own.
    await page.evaluate(() => document.activeElement.blur());
    await settle(page);

    await page.keyboard.press(']');
    await settle(page);
    check((await info()) === '0/0', `the first press selected ${await info()}`);

    await page.keyboard.press(']');
    await page.keyboard.press(']');
    await settle(page);
    check((await info()) === '0/2', `three presses reached ${await info()}`);

    await page.keyboard.press('[');
    await settle(page);
    check((await info()) === '0/1', `stepping back reached ${await info()}`);

    /* Shift extends. The browser reports the shifted character, so this arrives
       as a brace and never as a bracket. Bind the bracket alone and Shift steps
       instead of extending, leaving one node selected. */
    await page.keyboard.press('Shift+BracketRight');
    await settle(page);
    check((await info()) === '2 selected', `extending gave ${await info()}`);

    await page.keyboard.press('Shift+I');
    await settle(page);
    check((await count()) === started + 1, `insert left ${await count()} nodes, not ${started + 1}`);
    const status = (await page.textContent('#status')).trim();
    check(/inserted/.test(status), `the status line says "${status}"`);

    /* And the geometry did not move, which is what makes inserting safe. A
       `DOMRect` does not survive being returned from `$eval` -- its fields are
       on the prototype, so it arrives as `{}` -- so the numbers are pulled out
       inside the page. */
    const box = () =>
      page.$eval('.artwork path', (el) => {
        const b = el.getBBox();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      });
    const one = await box();
    await undo(page);
    const two = await box();
    check(
      Math.abs(one.w - two.w) < 0.01 && Math.abs(one.h - two.h) < 0.01,
      `inserting changed the drawing: ${JSON.stringify([one, two])}`,
    );

    // The same two operations have buttons, which is the mobile rule as much as
    // the keyboard one.
    await tab(page, 'node');
    /* Escape first: undo restores the selection along with the geometry, so
       after it there are still two nodes selected and Insert node is correctly
       live. Checking it there asserted the opposite of the truth. */
    await page.keyboard.press('Escape');
    await settle(page);
    const wired = await page.evaluate(() => ({
      step: !!document.querySelector('#nextNode'),
      insert: !!document.querySelector('#insertNode'),
      insertOff: document.querySelector('#insertNode').disabled,
    }));
    check(wired.step && wired.insert, 'the buttons are missing');
    check(wired.insertOff, 'Insert node is live with nothing selected');

    return { started, status };
  },

  /**
   * Offset path: a parallel shape beside the original.
   *
   * The geometry is measured in the unit tests. What a browser adds is that the
   * result reaches the document as a second shape with the first still there,
   * and that its size is what a parallel path of that distance should be.
   */
  async offsetPath(page, check) {

    /* A circle, because its offset has a size you can check by eye and by
       arithmetic: radius 20 offset by 5 is radius 25. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 64">' +
        '<path d="M64 32 C64 43.05 55.05 52 44 52 C32.95 52 24 43.05 24 32 ' +
        'C24 20.95 32.95 12 44 12 C55.05 12 64 20.95 64 32 Z" fill="none" stroke="#2563d8"/></svg>',
    );
    await page.click('#apply');
    await settle(page);
    await closeSource(page);

    await tab(page, 'shape');
    await page.click('#shapelist li');
    await settle(page);

    const boxes = () =>
      page.$$eval('.artwork path', (els) =>
        els.map((el) => {
          const b = el.getBBox();
          return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) };
        }),
      );
    const before = await boxes();
    check(before.length === 1, `${before.length} shapes before offsetting`);

    await page.fill('#offsetBy', '5');
    await page.dispatchEvent('#offsetBy', 'input');
    await page.click('#offsetGo');
    await settle(page);

    const after = await boxes();
    check(after.length === 2, `${after.length} shapes after offsetting, wanted 2`);
    // The original is untouched: an offset is a companion, not a replacement.
    check(
      Math.abs(after[0].w - before[0].w) < 0.01 && Math.abs(after[0].h - before[0].h) < 0.01,
      `the original changed size: ${JSON.stringify([before[0], after[0]])}`,
    );
    // And the new one is ten wider and ten taller, being five out all round.
    check(
      Math.abs(after[1].w - (before[0].w + 10)) < 0.2 && Math.abs(after[1].h - (before[0].h + 10)) < 0.2,
      `the offset is ${after[1].w} by ${after[1].h}, wanted ${before[0].w + 10} by ${before[0].h + 10}`,
    );

    const status = (await page.textContent('#status')).trim();
    check(/Offset 1 shape/.test(status), `the status line says "${status}"`);

    // Negative goes the other way, from the same original.
    await tab(page, 'shape');
    await page.click('#shapelist li');
    await settle(page);
    await page.fill('#offsetBy', '-6');
    await page.dispatchEvent('#offsetBy', 'input');
    await page.click('#offsetGo');
    await settle(page);
    const three = await boxes();
    check(three.length === 3, `${three.length} shapes after the second offset`);
    check(
      Math.abs(three[2].w - (before[0].w - 12)) < 0.3,
      `the inward offset is ${three[2].w} wide, wanted ${before[0].w - 12}`,
    );

    // One undo step per press, not one per subpath.
    await undo(page);
    check((await boxes()).length === 2, 'undo did not take back the whole offset');

    return { before: before[0], after, status };
  },

  /**
   * The work survives a reload, and a workspace file survives a round trip.
   *
   * The reader is unit-tested against strings it writes itself. What only a
   * browser has is the reload: `localStorage`, a second page load, and a wiring
   * order that decides whether fourteen checkboxes agree with the state they
   * were restored from. Every one of those was correct in the unit tests and
   * could still have been wrong here.
   *
   * The id collision is the failure worth catching. Both counters start at zero
   * on a fresh page, so a restored document brings ids the editor is about to
   * hand out again, and the first symptom is not an error -- it is one click
   * selecting two shapes.
   */
  async session(page, check) {
    const out = {};
    const dir = process.env.SCRATCH ?? '/tmp';
    const { writeFileSync } = await import('node:fs');
    /* Nothing is cleared here, and nothing needs to be: every run gets a fresh
       browser context. A `localStorage.clear()` stood here and could not have
       done the job it looked like it was doing anyway, because the page writes
       the session back on `pagehide` (§59). **Forget saved work** is what holds
       across a reload, and it is the wrong tool here: it latches, and this
       scenario goes on to check that the work is being saved. */

    /* Distinctive in four different parts of the state, because each one is
       restored by a different line and three of them would have gone unnoticed
       behind the drawing coming back. */
    await tab(page, 'doc');
    await page.fill('#guideAt', '33');
    await page.click('#guideAddV');
    await page.check('#showKeylines');
    await page.fill('#decimals', '1');
    await settle(page);

    await page.click('#tool button[data-v="rect"]');
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(820, 470);
    await page.mouse.up();
    await settle(page);

    /* Moved off the fit, which is the only way the camera check can fail: the
       rectangle was drawn inside the starter's own bounds, so a startup `fit`
       would land on exactly the camera this scenario had and prove nothing. */
    await page.click('#zoomin');
    await page.click('#zoomin');
    await settle(page);

    const read = async () => ({
      stats: (await page.textContent('#stats')).trim(),
      guides: (await page.textContent('#guideinfo')).trim(),
      keylines: await page.isChecked('#showKeylines'),
      decimals: await page.inputValue('#decimals'),
      d: await page.$eval('.artwork path:last-child', (el) => el.getAttribute('d')),
      camera: (await page.textContent('#zoomval')).trim(),
    });
    out.before = await read();
    check(/2 shapes/.test(out.before.stats), `before the reload: "${out.before.stats}"`);

    /* The write is on a timer, so this waits for the entry rather than for a
       number of milliseconds. The key is the storage module's, spelled out
       here on purpose: a scenario that read it from the page would agree with
       whatever the page did, including nothing.

       Waited on the CONTENT and not on the key. Any earlier write satisfies
       "the entry exists", so the reload could happen before the guide and the
       rectangle had been saved and the checks below would be reading a copy
       from a moment nobody asked about. The guide at 33 is the first thing this
       scenario did. */
    await page.waitForFunction(() =>
      /"axis":"x","at":33/.test(localStorage.getItem('path.session.v1') ?? ''),
    );

    await page.reload({ waitUntil: 'networkidle' });
    await settle(page);
    await tab(page, 'doc');
    out.after = await read();

    check(out.after.stats === out.before.stats, `after the reload: "${out.after.stats}"`);
    check(out.after.d === out.before.d, `the rectangle came back as "${out.after.d}"`);
    check(out.after.guides === out.before.guides, `the guides read "${out.after.guides}"`);
    check(out.after.keylines === true, 'Keylines came back off');
    check(out.after.decimals === '1', `Decimals came back as ${out.after.decimals}`);
    /* The camera is the one piece a `fit` on startup would have thrown away,
       and it is set by a gesture rather than by a control, so nothing else
       would notice it going. */
    check(out.after.camera === out.before.camera, `the zoom reads ${out.after.camera}, was ${out.before.camera}`);
    out.opening = (await page.textContent('#status')).trim();
    check(/Picked up where you left off/.test(out.opening), `the page opened saying "${out.opening}"`);

    /* An id the restored document already holds must not be handed out again.
       The symptom is not an exception: `resolveNodes` walks every shape, so one
       id naming two shapes is one row's click selecting both of them. */
    await page.click('#tool button[data-v="rect"]');
    await page.mouse.move(400, 560);
    await page.mouse.down();
    await page.mouse.move(500, 640);
    await page.mouse.up();
    await settle(page);
    check(/3 shapes/.test(await page.textContent('#stats')), 'the third rectangle was not drawn');
    await tab(page, 'shape');
    /* Cleared first: what was just drawn is selected, so a collision would be
       invisible behind the selection the draw left. */
    await page.keyboard.press('Escape');
    await settle(page);
    await page.click('#shapelist li.shape:last-child');
    await settle(page);
    const picked = await page.$$eval('#shapelist li.shape[aria-selected="true"]', (els) => els.length);
    check(picked === 1, `clicking one row selected ${picked} shapes, so an id names two of them`);

    /* --- the workspace file, which is the same bytes written somewhere else - */
    await page.evaluate(() => {
      const made = URL.createObjectURL.bind(URL);
      window.__blobs = [];
      URL.createObjectURL = (b) => {
        window.__blobs.push(b);
        return made(b);
      };
    });
    await tab(page, 'doc');
    await page.click('#saveWorkspace');
    await page.waitForFunction(() => window.__blobs.length > 0);
    const text = await page.evaluate(() => window.__blobs[window.__blobs.length - 1].text());
    out.workspaceBytes = text.length;
    check(text.length > 200, `the workspace file is ${text.length} bytes`);

    // Something to lose, so opening it back has an observable answer.
    await page.click('#guideClear');
    await settle(page);
    check(/none/.test(await page.textContent('#guideinfo')), 'Clear guides left one behind');

    /* And something a CONTROL shows, moved the other way after the save. Without
       this the field and the readout agree whatever the open does, and the two
       checks below cannot fail -- which is how they were first written. */
    const savedGrid = await page.inputValue('#gridStep');
    await page.fill('#gridStep', savedGrid === '9' ? '3' : '9');
    await page.press('#gridStep', 'Enter');
    await settle(page);
    check(
      (await page.inputValue('#gridStep')) !== savedGrid,
      'the grid step did not move, so reopening proves nothing about the controls',
    );

    const wfile = `${dir}/drive-workspace.json`;
    writeFileSync(wfile, text);
    await page.setInputFiles('#workspaceFile', wfile);
    await settle(page);
    out.opened = (await page.textContent('#status')).trim();
    check(/^Opened drive-workspace\.json/.test(out.opened), `opening it said "${out.opened}"`);
    check(
      (await page.textContent('#guideinfo')).trim() === out.before.guides,
      'the guide did not come back with the workspace',
    );
    check(/3 shapes/.test(await page.textContent('#stats')), 'the workspace opened the wrong drawing');

    /* The controls, which are the half of a session nothing was re-reading. A
       checkbox is set once at bind time and never again, because a checkbox is
       normally the only thing that writes what it displays -- and a workspace
       writes all 28 view fields at once. 22 controls were left describing the
       session that had just been replaced, and two of those were worse than
       cosmetic: a box shown ticked over a store that said false makes the first
       press do nothing, and a restored `touchButtons` puts the touch row on
       screen with its own box unticked.

       Measured against the READOUTS, which the subscriber does rewrite. The two
       disagreeing is the defect stated exactly: the panel showing one thing and
       the drawing obeying another. */
    out.controls = await page.evaluate(() => ({
      showGrid: document.querySelector('#showGrid').checked,
      gridField: document.querySelector('#gridStep').value,
      gridReadout: document.querySelector('#gridval').textContent.trim(),
      decimalsField: document.querySelector('#decimals').value,
    }));
    check(
      out.controls.gridField === out.controls.gridReadout,
      `the grid field says ${JSON.stringify(out.controls.gridField)} and the readout ` +
        `beside it says ${JSON.stringify(out.controls.gridReadout)}`,
    );

    /* The file name, written only inside the store subscriber. Assigned after
       the apply, the notification carried the previous name and the panel named
       the wrong file until some later unrelated edit. */
    check(
      (await page.textContent('#fileinfo')).trim() === 'drive-workspace.json',
      `after opening it, the panel names "${(await page.textContent('#fileinfo')).trim()}"`,
    );

    // A file that is not one is refused by name, and changes nothing.
    const bad = `${dir}/drive-workspace-bad.json`;
    writeFileSync(bad, '{"version":1,"doc":{"shapes":"no"}}');
    await page.setInputFiles('#workspaceFile', bad);
    await settle(page);
    out.refused = (await page.textContent('#status')).trim();
    check(/is not a workspace this build can open/.test(out.refused), `the refusal reads "${out.refused}"`);
    check(/3 shapes/.test(await page.textContent('#stats')), 'a refused workspace emptied the document');

    /* A workspace whose shapes interleave a group. §49's contiguity is restored
       by `Store.edit` after every edit -- and a restore is not an edit, so a
       file like this stayed broken until some later edit happened to fix it,
       and an export taken in between wrote one group as two `<g>` under two
       ids. Built from the bytes this editor just wrote, so the version and the
       schema are its own and only the order is hostile. */
    const doc = JSON.parse(text);
    doc.doc.groups = [{ id: 'g-split', name: 'split', parent: null }];
    doc.doc.shapes[0].group = 'g-split';
    doc.doc.shapes[2].group = 'g-split';
    const interleaved = `${dir}/drive-interleaved.json`;
    writeFileSync(interleaved, JSON.stringify(doc));
    await page.setInputFiles('#workspaceFile', interleaved);
    await settle(page);
    check(/3 shapes/.test(await page.textContent('#stats')), 'the interleaved workspace did not open');

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    const exported = await page.inputValue('#src');
    await closeSource(page);
    out.groupsInExport = (exported.match(/<g\b/g) ?? []).length;
    check(
      out.groupsInExport === 1,
      `a restored workspace exported one group as ${out.groupsInExport} <g> elements`,
    );

    /* --- forgetting, which has to survive the next reload to mean anything -- */
    await page.click('#forgetSession');
    await settle(page);
    check(
      (await page.textContent('#autosaveinfo')).trim() === 'stopped',
      'Forget saved work left the readout saying it was still saving',
    );
    await page.reload({ waitUntil: 'networkidle' });
    await settle(page);
    out.fresh = (await page.textContent('#stats')).trim();
    check(/1 shape/.test(out.fresh), `after forgetting and reloading: "${out.fresh}"`);

    /* --- a session this build cannot read, which must not be destroyed ------ */

    /* Planted behind a Forget, because the running page is saving: without the
       latch its own flush on the way out would write over the entry between the
       `setItem` below and the reload that is supposed to find it. */
    const UNREAD = '{"version":9999,"doc":{"shapes":[]}}';
    await tab(page, 'doc');
    await page.click('#forgetSession');
    await page.evaluate((text) => localStorage.setItem('path.session.v1', text), UNREAD);
    await page.reload({ waitUntil: 'networkidle' });
    await settle(page);
    await tab(page, 'doc');
    out.unread = {
      status: (await page.textContent('#status')).trim(),
      info: (await page.textContent('#autosaveinfo')).trim(),
      why: (await page.textContent('#autosavewhy')).trim(),
    };
    check(/could not be read/.test(out.unread.status), `an unreadable session opened saying "${out.unread.status}"`);
    check(out.unread.info === 'not saving', `an unreadable session left the readout at "${out.unread.info}"`);
    check(
      /could not read/.test(out.unread.why) && /Forget saved work/.test(out.unread.why),
      `the reason reads "${out.unread.why}" and does not name the way out`,
    );

    /* The whole point: the bytes are still there afterwards. Driven through a
       reload rather than a wait, because `pagehide` flushes the autosave -- so
       this is the strongest attempt to overwrite the entry that the editor ever
       makes, and it happens at a moment the harness can name. */
    await page.click('#tool button[data-v="rect"]');
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(700, 400);
    await page.mouse.up();
    await settle(page);
    /* The precondition, without which this measures nothing: if the rectangle
       never landed, the store never notified, `sessions.schedule` was never
       called, and the flush on the way out has nothing pending -- so the bytes
       survive whether or not anything protects them. */
    check(
      /2 shapes/.test(await page.textContent('#stats')),
      'the rectangle over the unreadable session was not drawn, so nothing tried to save',
    );
    await page.reload({ waitUntil: 'networkidle' });
    await settle(page);
    out.keptUnread = await page.evaluate(() => localStorage.getItem('path.session.v1'));
    check(
      out.keptUnread === UNREAD,
      `drawing over an unreadable session replaced it with ${JSON.stringify(out.keptUnread)}`,
    );

    // And Forget is the way out it was told to offer.
    await tab(page, 'doc');
    await page.click('#forgetSession');
    await settle(page);
    check(
      (await page.evaluate(() => localStorage.getItem('path.session.v1'))) === null,
      'Forget saved work left the unreadable session in place',
    );

    /* A browser that refuses storage, which is the case the shopping-list entry
       was mostly about: opened from `file://` Chromium gives the page an opaque
       origin and every access throws. Faked here rather than served from a real
       `file://` URL, because the engine that does this is not the one these
       scenarios run on -- what is being checked is that the editor says so
       instead of showing a reassuring readout with nothing behind it.
       Last, because an init script stays for every later navigation. */
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('SecurityError: storage is not available');
        },
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await settle(page);
    await tab(page, 'doc');
    check(/1 shape/.test(await page.textContent('#stats')), 'a blocked storage did not start clean');
    out.blocked = {
      info: (await page.textContent('#autosaveinfo')).trim(),
      why: (await page.textContent('#autosavewhy')).trim(),
    };
    check(out.blocked.info === 'not saving', `a blocked storage reads "${out.blocked.info}"`);
    check(
      /will not let a page opened from a file keep anything/.test(out.blocked.why),
      `the reason reads "${out.blocked.why}"`,
    );

    return out;
  },

  /**
   * Add an SVG file to the document.
   *
   * The importer is unit-tested against text. What only a browser has is a file
   * input, and what only this can show is that the file's contents reach the
   * same importer a paste does -- group transforms baked, one undo step --
   * rather than a second path that drifts from it.
   *
   * It adds rather than replaces, and keeps the page it was given: a file is
   * something you brought to a drawing you are already working on.
   */
  async importFile(page, check) {
    const dir = process.env.SCRATCH ?? '/tmp';
    const { writeFileSync } = await import('node:fs');

    /* A file with the things a hand-typed path does not have: a nested
       transform, a primitive that is not a path, and a viewBox of its own. */
    const file = `${dir}/drive-import.svg`;
    writeFileSync(
      file,
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">' +
        '<g transform="translate(10 5) scale(2)">' +
        '<rect x="0" y="0" width="20" height="10" fill="#e04" stroke="none"/>' +
        '<path d="M0 15 q10 -10 20 0" fill="none" stroke="#08a" stroke-width="2"/>' +
        '</g><circle cx="80" cy="40" r="6" fill="#0a5"/></svg>',
    );

    await tab(page, 'doc');
    const started = (await page.textContent('#stats')).trim();
    check(/1 shape/.test(started), `the starter document reads "${started}"`);

    await page.setInputFiles('#importFile', file);
    await settle(page);

    const stats = (await page.textContent('#stats')).trim();
    // Three from the file, on top of the starter that was already there.
    check(/4 shapes/.test(stats), `after adding: "${stats}"`);
    // The document's own page, not the file's 100 by 50.
    check(/88 × 64/.test(stats), `the canvas reads "${stats}"`);
    const info = (await page.textContent('#fileinfo')).trim();
    check(/drive-import\.svg/.test(info), `the panel header says "${info}"`);

    /* The group transform is baked, which is the thing that separates reading a
       file from displaying one: the rect is 20 wide inside a scale(2) inside a
       translate(10 5), so it arrives 40 wide at x = 10. */
    const first = await page.$eval('.artwork path:nth-child(2)', (el) => el.getAttribute('d'));
    check(/^M 10 5 H 50 V 25/.test(first), `the rect came in as "${first}"`);
    // And a primitive that was never a path is one now.
    const all = await page.$$eval('.artwork path', (els) => els.length);
    check(all === 4, `${all} paths drawn`);
    // What arrived is selected, because moving it is the next thing anyone does.
    const picked = await page.$$eval('#shapelist li.shape[aria-selected="true"]', (els) => els.length);
    check(picked === 3, `${picked} shape rows are selected, want the three that arrived`);

    // One undo step, not one per shape.
    await undo(page);
    check(/1 shape/.test(await page.textContent('#stats')), 'undo did not take the whole import back');

    // A file that draws nothing is refused, and says so rather than emptying
    // the document.
    const empty = `${dir}/drive-import-empty.svg`;
    writeFileSync(empty, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0"/></svg>');
    await page.setInputFiles('#importFile', empty);
    await settle(page);
    const refused = (await page.textContent('#status')).trim();
    check(/draws nothing/.test(refused), `the refusal reads "${refused}"`);
    check(/1 shape/.test(await page.textContent('#stats')), 'the refused import changed the document');
    check(
      /drive-import\.svg/.test((await page.textContent('#fileinfo')).trim()),
      'a refused file took the name of the one that worked',
    );

    /* Dropping one on the canvas is the same operation. `image/svg+xml` starts
       with `image/`, so the drop used to hand the one format this program can
       open to the backdrop, which traces pictures it cannot edit. */
    const { readFileSync } = await import('node:fs');
    await page.evaluate(
      ([text, name]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], name, { type: 'image/svg+xml' }));
        document
          .querySelector('#stage')
          .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [readFileSync(file, 'utf8'), 'dropped.svg'],
    );
    await settle(page);
    /* The drop reads the file through a promise, so there is nothing to settle
       on. Bounded and swallowed: a drop that never lands should fail on the
       check below, which says what happened, rather than on a 30-second
       timeout, which says only that something did not. */
    await page
      .waitForFunction(() => /4 shapes/.test(document.querySelector('#stats').textContent), null, {
        timeout: 4000,
      })
      .catch(() => {});

    const dropped = (await page.textContent('#stats')).trim();
    check(/4 shapes/.test(dropped), `after dropping an SVG: "${dropped}"`);
    const backdrop = (await page.textContent('#backinfo')).trim();
    check(/none/.test(backdrop), `the dropped SVG became a backdrop: "${backdrop}"`);

    /* And the other half, without which the check above is satisfied by a drop
       that never reaches the backdrop at all. `#backinfo` reads "none" before
       any of this, so "still none" proves the SVG went the right way only if a
       raster proves the other way exists. */
    const raster = png(6, 4, (x) => (x < 3 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    await page.evaluate(
      ([bytes, name]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
        document
          .querySelector('#stage')
          .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      [[...raster], 'dropped.png'],
    );
    await page
      .waitForFunction(() => !/none/.test(document.querySelector('#backinfo').textContent), null, {
        timeout: 4000,
      })
      .catch(() => {});
    const rasterInfo = (await page.textContent('#backinfo')).trim();
    check(/dropped\.png/.test(rasterInfo), `dropping a PNG left the backdrop reading "${rasterInfo}"`);
    // And it did not also arrive as shapes, which is the mirror of the check above.
    check(
      /4 shapes/.test((await page.textContent('#stats')).trim()),
      `the dropped PNG was imported as geometry: "${(await page.textContent('#stats')).trim()}"`,
    );

    return { stats, info, first, dropped, rasterInfo };
  },

  /**
   * Copy, cut, paste and duplicate, and the identity each of them has to mint.
   *
   * The unit tests assert that no two nodes in the document share an id. This
   * asserts the symptom that made it matter, which only a real drag can show:
   * grab one node of a copy and exactly one path must move. When the copy
   * answered to the original's ids, both did.
   *
   * The keys and the buttons are both driven, because they are two wirings of one
   * operation and either can be connected to the wrong thing.
   */
  async clipboard(page, check) {
    const paths = () =>
      page.evaluate(() => [...document.querySelectorAll('.artwork path')].map((p) => p.getAttribute('d')));
    const status = async () => (await page.textContent('#status')).trim();
    const out = {};

    /** Drag the first anchor on screen, and report how many paths changed. */
    const dragOneAnchor = async () => {
      await page.keyboard.press('v');
      await settle(page);
      const at = await page.evaluate(() => {
        const el = document.querySelector('.overlay [data-hit="anchor"]');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      check(!!at, 'no anchor was on screen to drag');
      const before = await paths();
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + 36, at.y + 36, { steps: 5 });
      await page.mouse.up();
      await settle(page);
      const after = await paths();
      return before.filter((d, i) => d !== after[i]).length;
    };

    await tab(page, 'shape');
    await page.click('#shapelist li:nth-child(1)');
    await settle(page);

    // Duplicate first, because that is where the identity collision was found.
    await page.keyboard.press('Control+d');
    await settle(page);
    check((await paths()).length === 2, 'Duplicate did not add a shape');
    const movedByDuplicate = await dragOneAnchor();
    check(
      movedByDuplicate === 1,
      `dragging one anchor moved ${movedByDuplicate} paths, so the duplicate shares node ids with its original`,
    );
    out.movedByDuplicate = movedByDuplicate;

    // Copy and paste, by key.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.click('#shapelist li:nth-child(1)');
    await settle(page);
    const beforePaste = (await paths()).length;
    await page.keyboard.press('Control+c');
    out.copyMessage = await status();
    check(/^Copied 1 shape/.test(out.copyMessage), `copy said "${out.copyMessage}"`);
    await page.keyboard.press('Control+v');
    await settle(page);
    out.pasteMessage = await status();
    check((await paths()).length === beforePaste + 1, 'Ctrl+V did not add a shape');
    const movedByPaste = await dragOneAnchor();
    check(movedByPaste === 1, `dragging one anchor moved ${movedByPaste} paths after a paste`);

    /* A second paste has to land somewhere else. Two copies at one position look
       like one copy, and the second is then only findable in the shape list. */
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    const lastBefore = (await paths()).at(-1);
    await page.keyboard.press('Control+v');
    await settle(page);
    const lastAfter = (await paths()).at(-1);
    check(lastAfter !== lastBefore, 'a second paste landed exactly on the first');

    // Cut removes what it copied, and what it copied is still pasteable.
    await page.click('#shapelist li:nth-child(1)');
    await settle(page);
    const beforeCut = (await paths()).length;
    await page.keyboard.press('Control+x');
    await settle(page);
    out.cutMessage = await status();
    check((await paths()).length === beforeCut - 1, 'Ctrl+X did not remove the shape');
    await page.keyboard.press('Control+v');
    await settle(page);
    check((await paths()).length === beforeCut, 'a cut shape could not be pasted back');

    /* The buttons, which are the other half of the wiring. They are hidden on a
       mouse, so this turns them on the way a person on a phone gets them: the
       setting, not a class poked into the page.

       The "hidden" half is asked ON THE TAB THAT HOLDS THEM. It was asked from
       the Document tab, where the whole Shape panel is `hidden` and every
       control in it is invisible whatever the setting says, so it passed with
       the rule deleted and the rule was unmeasured in both directions. */
    await tab(page, 'shape');
    await settle(page);
    check(
      !(await page.isVisible('#copySel')),
      'the clipboard buttons are on screen with Touch buttons off',
    );
    await tab(page, 'doc');
    await page.check('#touchButtons');
    await settle(page);
    await tab(page, 'shape');
    check(await page.isVisible('#copySel'), 'Touch buttons did not bring the Copy button back');

    await page.click('#shapelist li:nth-child(1)');
    await settle(page);
    check(!(await page.isDisabled('#copySel')), 'Copy is disabled with a shape selected');
    await page.click('#copySel');
    out.copyButtonMessage = await status();
    check(/^Copied/.test(out.copyButtonMessage), `the Copy button said "${out.copyButtonMessage}"`);
    const beforeButton = (await paths()).length;
    await page.click('#pasteSel');
    await settle(page);
    check((await paths()).length === beforeButton + 1, 'the Paste button added nothing');

    // Copy is offered only when there is something to copy.
    await page.keyboard.press('Escape');
    await settle(page);
    check(await page.isDisabled('#copySel'), 'Copy stayed live with nothing selected');
    check(await page.isDisabled('#cutSel'), 'Cut stayed live with nothing selected');
    /* Paste stays live on purpose: copying raises no store notification, so a
       Paste derived from the clipboard would be greyed out until the next
       unrelated edit. It refuses in words instead. */
    check(!(await page.isDisabled('#pasteSel')), 'Paste was greyed out, which nothing keeps in sync');

    // Two adjacent nodes copy as the piece of path between them.
    await page.click('#shapelist li:nth-child(1)');
    await settle(page);
    const anchors = await page.evaluate(() => {
      const id = document.querySelector('#shapelist li').getAttribute('data-id');
      return [...document.querySelectorAll(`.overlay [data-hit="anchor"][data-shape="${id}"]`)]
        .slice(0, 2)
        .map((e) => {
          const b = e.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        });
    });
    check(anchors.length === 2, 'could not find two anchors of the first shape');
    await page.mouse.click(anchors[0].x, anchors[0].y);
    await page.keyboard.down('Shift');
    await page.mouse.click(anchors[1].x, anchors[1].y);
    await page.keyboard.up('Shift');
    await settle(page);
    const beforeNodeCopy = (await paths()).length;
    await page.keyboard.press('Control+c');
    out.nodeCopyMessage = await status();
    check(
      /piece of path/.test(out.nodeCopyMessage),
      `copying two nodes said "${out.nodeCopyMessage}"`,
    );
    await page.keyboard.press('Control+v');
    await settle(page);
    check((await paths()).length === beforeNodeCopy + 1, 'pasting a piece of path added nothing');
    const piece = (await paths()).at(-1);
    /* One segment, so one command after the `M`. A closed piece, or the whole
       outline, would carry more -- and copying the outline is exactly what a
       widened selection would have done. */
    out.piece = piece;
    check(!/[Zz]/.test(piece), `the copied piece closed itself: ${piece}`);
    check(
      piece.trim().split(/(?=[A-Za-z])/).length === 2,
      `the copied piece is not one segment: ${piece}`,
    );

    return out;
  },

  /**
   * Groups: made, shown, selected as one, written as a `<g>`, and read back.
   *
   * A group carries no transform, per §5, so there is no coordinate space to check.
   * What needs a browser is the rest: the list is a tree of real nested elements, a
   * group's row takes a press meant for it rather than for the shapes inside it, and
   * the `<g>` has to come out of the source drawer the app actually writes.
   *
   * §49 of `docs/ARCHITECTURE.md` has the argument.
   */
  async groups(page, check) {
    const rows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#shapelist li')].map((li) => ({
          kind: li.className,
          level: li.getAttribute('aria-level'),
          group: li.getAttribute('data-group'),
          selected: li.getAttribute('aria-selected') === 'true',
          expanded: li.getAttribute('aria-expanded'),
        })),
      );
    const out = {};

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path id="a" d="M5 5 H20 V20 Z" fill="#2563d8"/>
  <path id="b" d="M30 5 H45 V20 Z" fill="#e8a54b"/>
  <path id="c" d="M55 5 H70 V20 Z" fill="#3aa856"/>
</svg>`,
    );
    await page.click('#apply');
    await closeSource(page);
    await tab(page, 'shape');
    await settle(page);

    const flat = await rows();
    check(flat.length === 3, `three shapes drew ${flat.length} rows`);
    check(
      flat.every((x) => x.kind === 'shape' && x.level === '1'),
      'a document with no groups drew something other than three plain shape rows',
    );
    check(await page.isDisabled('#groupShapes'), 'Group was live with nothing selected');

    await page.click('#shapelist li.shape:nth-child(1)');
    await settle(page);
    check(await page.isDisabled('#groupShapes'), 'Group was live with one shape selected');
    await page.click('#shapelist li.shape:nth-child(2)', { modifiers: ['Shift'] });
    await settle(page);
    check(!(await page.isDisabled('#groupShapes')), 'Group was dead with two shapes selected');

    await page.click('#groupShapes');
    await settle(page);
    out.message = (await page.textContent('#status')).trim();
    check(/^Grouped 2 shapes\b/.test(out.message), `Group said "${out.message}"`);
    const grouped = await rows();
    out.rows = grouped.map((x) => `${x.kind}${x.level}`);
    check(grouped.length === 4, `grouping two of three drew ${grouped.length} rows, not 4`);
    check(grouped[0].kind === 'group', 'the group did not come first, where its shapes were');
    check(
      grouped[1].level === '2' && grouped[2].level === '2',
      'the grouped shapes are not a level down from the group',
    );
    check(grouped[3].level === '1', 'the ungrouped shape was drawn inside the group');
    /* Open on first sight. Shut would mean grouping two shapes made them vanish from
       the list, which reads as having lost them rather than as having grouped them. */
    check(grouped[0].expanded === 'true', 'a group nobody had seen yet was drawn shut');

    /* A group's row holds every row inside it, so a press on the group's own line has
       to be told from a press on a shape in it. Reading `data-id` first would give
       the group's press to whichever shape it contains. */
    await page.click('#shapelist li.shape');
    await settle(page);
    const one = await rows();
    check(!one[0].selected, 'selecting one shape of a group lit the group as well');
    check(one[1].selected && !one[2].selected, 'selecting one shape of a group lit both');

    await page.click('#shapelist li.group');
    await settle(page);
    const whole = await rows();
    check(whole[0].selected, 'pressing the group row did not select it');
    check(whole[1].selected && whole[2].selected, 'the group row did not select its shapes');
    check(!whole[3].selected, 'the group row selected a shape outside it');
    out.selinfo = (await page.textContent('#selinfo')).trim();
    check(/2 shapes/.test(out.selinfo), `the readout says ${JSON.stringify(out.selinfo)}`);

    /* Select group, which is the way back from a shape to the group it is in.
       Driven from the canvas, because the list already had this: clicking the
       group's row selects it, and the gap was that a click on the drawing could
       only ever reach the shape. The blur is so the key goes to the document
       rather than to the list that was last focused. */
    await page.click('#shapelist li.shape');
    await settle(page);
    check(!(await page.isDisabled('#selectGroup')), 'Select group was dead on a shape inside a group');
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Shift+G');
    await settle(page);
    const widened = await rows();
    check(widened[0].selected, 'Shift+G did not select the group');
    check(widened[1].selected && widened[2].selected, 'Shift+G left one of the group behind');
    check(!widened[3].selected, 'Shift+G reached a shape outside the group');
    out.selectGroup = (await page.textContent('#status')).trim();
    check(/Selected the group/.test(out.selectGroup), `Select group said "${out.selectGroup}"`);
    /* Nowhere further out, so the button goes dead rather than reporting a
       success that changed nothing. */
    check(await page.isDisabled('#selectGroup'), 'Select group stayed live on the outermost group');
    /* The loose shape, named by its level rather than by its position: the rows
       nest, so `nth-child` counts inside whichever list its parent is. */
    await page.click('#shapelist li.shape[aria-level="1"]');
    await settle(page);
    check(await page.isDisabled('#selectGroup'), 'Select group was live on a shape in no group');

    await page.click('#shapelist li.group');
    await settle(page);

    // Shut it: the rows inside go, and the group's own row stays.
    await page.click('#shapelist li.group > .twist');
    await settle(page);
    const shut = await rows();
    out.shut = shut.map((x) => x.kind);
    check(shut.length === 2, `a shut group left ${shut.length} rows, not 2`);
    check(shut[0].expanded === 'false', 'the group did not read as shut');
    await page.click('#shapelist li.group > .twist');
    await settle(page);
    check((await rows()).length === 4, 'opening the group again did not bring its rows back');

    // The `<g>` the app writes.
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await settle(page);
    const svg = await page.inputValue('#src');
    out.svg = svg;
    check((svg.match(/<g\b/g) ?? []).length === 1, `the export holds ${(svg.match(/<g\b/g) ?? []).length} <g>`);
    check(/<g id="group-of-2">/.test(svg), 'the group name did not become the <g> id');
    const inside = svg.slice(svg.indexOf('<g'), svg.indexOf('</g>'));
    check((inside.match(/<path/g) ?? []).length === 2, 'the <g> does not hold exactly its two paths');
    check(!/transform/.test(svg), 'a group wrote a transform, which §5 refuses');
    await closeSource(page);
    await settle(page);

    /* Read back. This is the round trip that was impossible before: `<g>` was
       flattened on import, so grouping made anywhere else did not survive. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill('#src', svg);
    await page.click('#apply');
    await closeSource(page);
    await settle(page);
    const reread = await rows();
    out.reread = reread.map((x) => `${x.kind}${x.level}`);
    check(
      reread.filter((x) => x.kind === 'group').length === 1,
      `re-importing the export gave ${reread.filter((x) => x.kind === 'group').length} groups`,
    );
    check(reread.length === 4, `the round trip drew ${reread.length} rows, not 4`);

    // Ungroup by key, and the group goes.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.click('#shapelist li.group');
    await settle(page);
    await page.keyboard.press('Control+Shift+g');
    await settle(page);
    const ungrouped = await rows();
    out.ungroupMessage = (await page.textContent('#status')).trim();
    check(/^Ungrouped\b/.test(out.ungroupMessage), `Ungroup said "${out.ungroupMessage}"`);
    check(
      ungrouped.every((x) => x.kind === 'shape'),
      'ungrouping left a group row behind',
    );
    check(ungrouped.length === 3, `ungrouping left ${ungrouped.length} rows, not 3`);

    // Ctrl+G is the other half of the pair.
    await page.click('#shapelist li.shape:nth-child(1)');
    await page.click('#shapelist li.shape:nth-child(2)', { modifiers: ['Shift'] });
    await settle(page);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Control+g');
    await settle(page);
    check(
      (await rows()).some((x) => x.kind === 'group'),
      'Ctrl+G did not group',
    );

    /* Deleting the shapes takes the group with them. Swept in `Store.edit`, so it
       holds for every one of the routes that removes a shape and not only this one. */
    await page.click('#shapelist li.group');
    await settle(page);
    await page.keyboard.press('Delete');
    await settle(page);
    const left = await rows();
    out.afterDelete = left.map((x) => x.kind);
    check(left.length === 1 && left[0].kind === 'shape', `deleting a group's shapes left ${JSON.stringify(out.afterDelete)}`);

    return out;
  },

  /**
   * The drawing as pixels: the four previews, and a PNG read back byte by byte.
   *
   * The only way to know a PNG is a PNG is to look at one, and nothing short of
   * a browser can make one here -- the raster comes from the browser decoding an
   * SVG and encoding a canvas. So the blob the button hands to the download is
   * intercepted on its way out and its header is read: the eight-byte signature,
   * then the width and height out of the IHDR chunk.
   *
   * A silently blank or wrongly sized PNG is the failure worth catching. The
   * download succeeds either way, and nobody looks at the file until later.
   */
  async png(page, check) {
    const out = {};

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <path d="M10 10 H40 V40 H10 Z" fill="#2563d8"/>
</svg>`,
    );
    await page.click('#apply');
    await closeSource(page);
    await tab(page, 'doc');
    await settle(page);

    /* The previews are `<img>` elements pointed at a data URI of the document.
       Asserted on the `src` rather than on anything drawn, because whether the
       browser rasterised it is the browser's business and the URI is what this
       editor is responsible for. */
    out.previews = await page.evaluate(() =>
      ['#prev16', '#prev24', '#prev32', '#prev48'].map((id) => {
        const el = document.querySelector(id);
        return { w: el.width, src: el.getAttribute('src')?.slice(0, 33) ?? '' };
      }),
    );
    check(
      out.previews.every((p) => p.src === 'data:image/svg+xml;charset=utf-8,'),
      `a preview is not pointed at an SVG data URI: ${JSON.stringify(out.previews)}`,
    );
    check(
      JSON.stringify(out.previews.map((p) => p.w)) === JSON.stringify([16, 24, 32, 48]),
      `the previews are ${JSON.stringify(out.previews.map((p) => p.w))} px wide`,
    );
    /* That the preview holds THIS document, not any document. It looked for
       `#2563d8`, which is `defaultStyle().stroke` and therefore present in
       every drawing this editor makes, including the starter -- so a preview
       frozen at the first document it ever serialised passed. The viewBox is
       what separates them: the starter's is `0 0 88 64` and this fixture sets
       its own. */
    out.previewUri = await page.evaluate(() =>
      decodeURIComponent(document.querySelector('#prev32').getAttribute('src')),
    );
    check(
      /viewBox="0 0 100 50"/.test(out.previewUri),
      `the preview is not of this document: ${JSON.stringify(out.previewUri.slice(0, 120))}`,
    );

    /* Shut the group and open it again. Opening rendered NOTHING until some
       unrelated notification arrived, because the catch-up listener was
       registered before the one that opens the group and read `aria-expanded`
       from before the press. Shutting rendered instead, which is the same two
       listeners in the same order. Measured by emptying the `src` first, so a
       preview left over from before the press cannot pass for one drawn now. */
    const previewHead = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.ghead .glabel')].find(
        (el) => el.querySelector('span')?.textContent === 'Preview',
      );
      b.click();
      return b.getAttribute('aria-expanded');
    });
    check(previewHead === 'false', `pressing the Preview header left it ${previewHead}`);
    await settle(page);
    await page.evaluate(() => document.querySelector('#prev32').removeAttribute('src'));
    await page.evaluate(() =>
      [...document.querySelectorAll('.ghead .glabel')]
        .find((el) => el.querySelector('span')?.textContent === 'Preview')
        .click(),
    );
    await settle(page);
    out.reopened = await page.evaluate(() => document.querySelector('#prev32').getAttribute('src'));
    check(
      typeof out.reopened === 'string' && out.reopened.startsWith('data:image/svg+xml'),
      `reopening the Preview group drew ${JSON.stringify(out.reopened)}`,
    );

    /* And that it FOLLOWS the document. A preview built once and never repointed
       satisfies everything above. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 33 22">' +
        '<path d="M0 0 H33 V22 H0 Z" fill="#0a5" stroke="none"/></svg>',
    );
    await page.click('#apply');
    await settle(page);
    out.previewAfter = await page.evaluate(() =>
      decodeURIComponent(document.querySelector('#prev32').getAttribute('src')),
    );
    check(
      /viewBox="0 0 33 22"/.test(out.previewAfter),
      `the preview did not follow the document: ${JSON.stringify(out.previewAfter.slice(0, 120))}`,
    );

    // Back to the fixture, so the PNG assertions below measure what they name.
    await undo(page);
    await settle(page);
    check(
      /viewBox="0 0 100 50"/.test(
        await page.evaluate(() =>
          decodeURIComponent(document.querySelector('#prev32').getAttribute('src')),
        ),
      ),
      'undoing the second document did not put the preview back',
    );

    /* Keep the blob the button makes. `revokeObjectURL` runs immediately after
       the click, which frees the URL and not the blob, so this reference stays
       readable. */
    await page.evaluate(() => {
      const made = URL.createObjectURL.bind(URL);
      window.__blobs = [];
      URL.createObjectURL = (b) => {
        window.__blobs.push(b);
        return made(b);
      };
    });

    await page.fill('#pngWidth', '200');
    await page.click('#downloadPng');
    await page.waitForFunction(() => window.__blobs.length > 0);
    /* The status line is written from inside the promise, so waiting for it is
       waiting for the encode rather than for a frame. */
    await page.waitForFunction(() => /^(Saved|No PNG)/.test(document.querySelector('#status').textContent));
    out.message = (await page.textContent('#status')).trim();

    out.header = await page.evaluate(async () => {
      const blob = window.__blobs[window.__blobs.length - 1];
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      return {
        type: blob.type,
        size: blob.size,
        signature: [...bytes.slice(0, 8)].join(' '),
        chunk: String.fromCharCode(...bytes.slice(12, 16)),
        width: view.getUint32(16),
        height: view.getUint32(20),
      };
    });

    check(out.header.type === 'image/png', `the blob is ${out.header.type}, not image/png`);
    check(
      out.header.signature === '137 80 78 71 13 10 26 10',
      `the bytes do not start with the PNG signature: ${out.header.signature}`,
    );
    check(out.header.chunk === 'IHDR', `the first chunk is ${out.header.chunk}, not IHDR`);
    // 200 wide, and half that tall because the canvas is 100 by 50.
    check(
      out.header.width === 200 && out.header.height === 100,
      `the PNG is ${out.header.width} x ${out.header.height}, not 200 x 100`,
    );
    check(out.header.size > 100, `the PNG is ${out.header.size} bytes, which is too few to hold one`);

    /* A well-formed PNG of nothing has a valid header too, so the header alone
       cannot tell a working export from one that rasterised a blank page. Read
       the pixels back: the fixture is a blue square on a transparent field, so
       the count has to be somewhere strictly between none and all of them. */
    out.pixels = await page.evaluate(async () => {
      const blob = window.__blobs[window.__blobs.length - 1];
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      let blue = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue;
        opaque++;
        if (data[i] === 0x25 && data[i + 1] === 0x63 && data[i + 2] === 0xd8) blue++;
      }
      return { total: data.length / 4, opaque, blue };
    });
    check(
      out.pixels.opaque > 0,
      'every pixel of the PNG is transparent, so the drawing did not reach it',
    );
    check(
      out.pixels.opaque < out.pixels.total,
      'every pixel of the PNG is opaque, so the background is not transparent',
    );
    /* 30 by 30 document units of fill, plus the 1-unit stroke the import gives a
       path with a fill and no stroke, which is centred on the outline and so
       adds half a unit all round: 31 by 31 units. The canvas is 100 by 50 and
       the PNG is 200 by 100, so the scale is 2 and the square is 62 by 62
       pixels. The margin is for the antialiased edge, which is a pixel wide. */
    check(
      Math.abs(out.pixels.opaque - 62 * 62) < 260,
      `the square covers ${out.pixels.opaque} pixels, not about ${62 * 62}`,
    );

    // A width of nothing is refused rather than producing a canvas of no pixels.
    await page.fill('#pngWidth', '0');
    await page.click('#downloadPng');
    await settle(page);
    out.refused = (await page.textContent('#status')).trim();
    check(/at least one pixel/.test(out.refused), `a width of 0 said ${JSON.stringify(out.refused)}`);

    /* And a width past the ceiling. `max` on a number input constrains its
       spinner and nothing else, so this arrived at the canvas and asked the
       browser for 300 megapixels. Filled rather than typed, which is exactly
       how a paste gets past the spinner. */
    await page.fill('#pngWidth', '20000');
    await page.click('#downloadPng');
    await settle(page);
    out.tooWide = (await page.textContent('#status')).trim();
    check(/8192 pixels wide at most/.test(out.tooWide), `a width of 20000 said ${JSON.stringify(out.tooWide)}`);
    // Refused before anything is drawn: the message is the refusal, not a report
    // of a render that happened first.
    check(!/Drawing/.test(out.tooWide), `a width of 20000 started a render: ${JSON.stringify(out.tooWide)}`);

    return out;
  },

  /**
   * The selection's box as four fields: read, typed, and refused.
   *
   * The unit tests own the arithmetic. What needs a browser is that the fields
   * track the selection without being told, that a value typed and committed
   * reaches the drawing, and that they show the box the canvas is drawing its
   * handles on rather than a second reading of it.
   */
  async selectionBounds(page, check) {
    const fields = () =>
      page.evaluate(() =>
        ['#selX', '#selY', '#selW', '#selH'].map((id) => {
          const el = document.querySelector(id);
          return { value: el.value, disabled: el.disabled };
        }),
      );
    const out = {};

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M10 20 H40 V60 H10 Z" fill="#2563d8"/>
  <path d="M70 70 H90 V90 H70 Z" fill="#e8a54b"/>
</svg>`,
    );
    await page.click('#apply');
    await closeSource(page);
    await tab(page, 'shape');
    await settle(page);

    out.empty = await fields();
    check(
      out.empty.every((f) => f.disabled && f.value === ''),
      `with nothing selected the fields read ${JSON.stringify(out.empty)}`,
    );

    await page.click('#shapelist li.shape:nth-child(1)');
    await settle(page);
    out.selected = (await fields()).map((f) => f.value);
    check(
      JSON.stringify(out.selected) === JSON.stringify(['10', '20', '30', '40']),
      `selecting the first shape read ${JSON.stringify(out.selected)}`,
    );

    /* Typed and committed. `fill` then `Enter`, because a number field fires no
       change event until it loses focus and nothing else here would blur it. */
    await page.fill('#selX', '55');
    await page.press('#selX', 'Enter');
    await settle(page);
    out.movedD = await drawnPath(page, 0);
    check(/M 55 20/.test(out.movedD), `typing X gave ${out.movedD}`);

    await page.fill('#selW', '60');
    await page.press('#selW', 'Enter');
    await settle(page);
    out.wide = (await fields()).map((f) => f.value);
    check(
      JSON.stringify(out.wide) === JSON.stringify(['55', '20', '60', '40']),
      `typing a width of 60 left the fields at ${JSON.stringify(out.wide)}`,
    );

    // Refused, with the field put back to what the drawing actually says.
    await page.fill('#selW', '0');
    await page.press('#selW', 'Enter');
    await settle(page);
    out.refused = (await fields()).map((f) => f.value);
    out.refusedMessage = (await page.textContent('#status')).trim();
    check(
      /greater than zero/.test(out.refusedMessage),
      `a width of 0 said "${out.refusedMessage}"`,
    );
    check(
      JSON.stringify(out.refused) === JSON.stringify(out.wide),
      `a width of 0 was accepted: the fields read ${JSON.stringify(out.refused)}`,
    );

    // Two undos: the width, then the move. Nothing for the refusal.
    await undo(page);
    await undo(page);
    out.undone = (await fields()).map((f) => f.value);
    check(
      JSON.stringify(out.undone) === JSON.stringify(['10', '20', '30', '40']),
      `two undos left the fields at ${JSON.stringify(out.undone)}`,
    );

    // The fields follow the selection with nobody pressing anything in them.
    await page.click('#shapelist li.shape:nth-child(2)');
    await settle(page);
    out.other = (await fields()).map((f) => f.value);
    check(
      JSON.stringify(out.other) === JSON.stringify(['70', '70', '20', '20']),
      `selecting the second shape read ${JSON.stringify(out.other)}`,
    );

    /* A number typed and then abandoned by pressing the canvas.

       `change` fires on blur, and moving focus is the DEFAULT ACTION of a
       pointerdown, so it lands after every pointerdown listener has run. The
       controller therefore replaced the selection first and the typed number
       went to whatever was pressed: a second shape resized mid-gesture, and the
       shape the field described untouched. Measured on both shapes' `d`,
       because the field values afterwards look right either way. */
    await page.click('#shapelist li.shape[aria-level="1"]');
    await settle(page);
    const dOf = () => page.evaluate(() =>
      [...document.querySelectorAll('.artwork path')].map((p) => p.getAttribute('d')));
    out.beforeStray = await dOf();

    await page.fill('#selW', '55');
    const box = await page.locator('.artwork path').nth(1).boundingBox();
    await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    await page.mouse.down();
    await page.mouse.up();
    await settle(page);
    out.afterStray = await dOf();
    /* Both halves. The width has to REACH the shape the field described --
       without the flush it was dropped entirely, with `Nothing is selected.`,
       because the press had already cleared the selection -- and the shape that
       was pressed has to be untouched, which is the other way the same race
       lands. One without the other passes on the bug. */
    check(
      /H 65 /.test(out.afterStray[0]),
      `the typed width never reached the shape it was typed for: ` +
        `${JSON.stringify(out.beforeStray[0])} -> ${JSON.stringify(out.afterStray[0])}`,
    );
    check(
      out.afterStray[1] === out.beforeStray[1],
      `pressing the second shape applied the width typed for the first: it went ` +
        `${JSON.stringify(out.beforeStray[1])} -> ${JSON.stringify(out.afterStray[1])}`,
    );

    return out;
  },

  /**
   * Paint order: the four buttons, the two chords, dragging a row, and the list
   * that shows all four.
   *
   * Measured on the order of the `<path>` elements in the artwork, which is what
   * decides what covers what. The shape list is asserted alongside it because the
   * list *is* the paint order shown, and the two disagreeing would mean the panel
   * is lying about the drawing.
   *
   * §49 keeps a group's shapes contiguous, so the last part checks that a shape
   * sent forward past a group clears the whole run rather than landing inside it.
   */
  async zorder(page, check) {
    const painted = () =>
      page.evaluate(() => [...document.querySelectorAll('.artwork path')].map((p) => p.getAttribute('fill')));
    const listed = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#shapelist li')].map((li) => li.className),
      );
    const out = {};

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M10 10 H50 V50 H10 Z" fill="#111111"/>
  <path d="M20 20 H60 V60 H20 Z" fill="#222222"/>
  <path d="M30 30 H70 V70 H30 Z" fill="#333333"/>
</svg>`,
    );
    await page.click('#apply');
    await closeSource(page);

    /* The four buttons are behind the touch setting, because dragging a row does
       what they do and both of them repeat `Ctrl+[`. They still have to work, so
       this turns them on the way a phone gets them. */
    /* Asked on the Shape tab, which is where these live. From the Document tab
       the whole panel is `hidden`, so every control in it is invisible whatever
       the setting says and this passed with the rule deleted. */
    await tab(page, 'shape');
    await settle(page);
    check(!(await page.isVisible('#orderForward')), 'the order tiles are on screen with Touch buttons off');
    await tab(page, 'doc');
    await page.check('#touchButtons');
    await settle(page);
    await tab(page, 'shape');
    await settle(page);

    out.start = await painted();
    check(
      JSON.stringify(out.start) === JSON.stringify(['#111111', '#222222', '#333333']),
      `the fixture painted ${JSON.stringify(out.start)}`,
    );
    check(await page.isDisabled('#orderForward'), 'Forward was live with nothing selected');

    await page.click('#shapelist li.shape:nth-child(1)');
    await settle(page);
    check(!(await page.isDisabled('#orderForward')), 'Forward was dead with a shape selected');

    await page.click('#orderForward');
    await settle(page);
    out.forward = await painted();
    check(
      JSON.stringify(out.forward) === JSON.stringify(['#222222', '#111111', '#333333']),
      `one step forward painted ${JSON.stringify(out.forward)}`,
    );

    await page.click('#orderFront');
    await settle(page);
    out.front = await painted();
    check(
      out.front[2] === '#111111',
      `To front left the shape at ${out.front.indexOf('#111111')} of 3`,
    );

    await undo(page);
    await undo(page);
    check(
      JSON.stringify(await painted()) === JSON.stringify(out.start),
      'two undos did not put the paint order back',
    );

    /* A press with nowhere to go declines, and a decline must not cost an undo
       entry: pressing a dead-end button five times would otherwise take five
       presses of Ctrl+Z, none of which appear to do anything.

       Probed with two presses of To back. The first moves the shape and the
       second can only decline, so one undo has to return the order to what it was
       before the first. An undo entry for the refusal would leave it as it is. */
    await page.click('#shapelist li.shape:nth-child(3)');
    await settle(page);
    await page.click('#orderBack');
    await settle(page);
    const sunk = await painted();
    check(sunk[0] === '#333333', `To back left the shape at ${sunk.indexOf('#333333')} of 3`);
    await page.click('#orderBack');
    await settle(page);
    check(
      JSON.stringify(await painted()) === JSON.stringify(sunk),
      'a second To back moved a shape that was already at the back',
    );
    await undo(page);
    out.afterDeclinedUndo = await painted();
    check(
      JSON.stringify(out.afterDeclinedUndo) === JSON.stringify(out.start),
      `one undo after a refused To back gave ${JSON.stringify(out.afterDeclinedUndo)}`,
    );

    // The chords, which are Illustrator's and Photoshop's. Back to the shape at
    // the rear, since the last block left a different one selected.
    await page.click('#shapelist li.shape:nth-child(1)');
    await settle(page);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Control+BracketRight');
    await settle(page);
    check(
      JSON.stringify(await painted()) === JSON.stringify(out.forward),
      'Ctrl+] did not bring the shape forward',
    );
    await page.keyboard.press('Control+Shift+BracketRight');
    await settle(page);
    out.chordFront = await painted();
    check(out.chordFront[2] === '#111111', 'Ctrl+Shift+] did not bring the shape to the front');

    /* Dragging a row, which is the same reordering with the destination named
       rather than stepped. Here rather than after the grouping below, because
       these three rows are the plain case: siblings of one list, no group in
       the way of the arithmetic. */
    await undo(page);
    await undo(page);
    await settle(page);
    out.beforeDrag = await painted();

    const rowBox = (n) => page.locator(`#shapelist > li.shape:nth-child(${n})`).boundingBox();
    const first = await rowBox(1);
    const last = await rowBox(3);
    check(!!first && !!last, 'the list is not three loose rows');

    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    // Past the last row's midpoint, which is the gap after it: the end of the
    // list, which is the front of the paint order.
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(
        first.x + first.width / 2,
        first.y + ((last.y + last.height - first.y) * i) / 6,
      );
    }
    const line = await page.locator('.dropline').count();
    check(line === 1, 'no drop line was drawn while dragging a row');
    await page.mouse.up();
    await settle(page);

    out.dragged = await painted();
    check(
      out.dragged[2] === out.beforeDrag[0],
      `dragging the back row to the end of the list painted ${JSON.stringify(out.dragged)}`,
    );
    check((await page.locator('.dropline').count()) === 0, 'the drop line outlived the drag');

    /* The end of the list is where `dropShapes` lands anything it cannot place,
       so a drag aimed there passes whether the destination was computed or
       guessed. The middle is the only destination that tells the two apart:
       moving the back row up by one gives BAC, and the fallback gives BCA. */
    await undo(page);
    await settle(page);
    const middleFrom = await rowBox(1);
    const middleTo = await rowBox(2);
    await page.mouse.move(middleFrom.x + middleFrom.width / 2, middleFrom.y + middleFrom.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 4; i++) {
      await page.mouse.move(
        middleFrom.x + middleFrom.width / 2,
        middleFrom.y + ((middleTo.y + middleTo.height - middleFrom.y) * i) / 4,
      );
    }
    await page.mouse.up();
    await settle(page);
    out.draggedMiddle = await painted();
    check(
      JSON.stringify(out.draggedMiddle) ===
        JSON.stringify([out.beforeDrag[1], out.beforeDrag[0], out.beforeDrag[2]]),
      `dragging the back row up one place painted ${JSON.stringify(out.draggedMiddle)}`,
    );
    await undo(page);
    await settle(page);
    check(
      JSON.stringify(await painted()) === JSON.stringify(out.beforeDrag),
      'one undo did not take the middle drag back',
    );

    // And back to the state the checks below were written against.
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(
        first.x + first.width / 2,
        first.y + ((last.y + last.height - first.y) * i) / 6,
      );
    }
    await page.mouse.up();
    await settle(page);

    // One undo step: the drag must not leave a selection change behind it that
    // a second undo would have to take back as well.
    await undo(page);
    await settle(page);
    check(
      JSON.stringify(await painted()) === JSON.stringify(out.beforeDrag),
      'one undo did not take the drag back',
    );

    /* A drag that goes nowhere. Four pixels is past the slop that starts a drag
       and nowhere near another row, and it sent the row to the FRONT of the
       paint order in one undoable step that looked like a real reorder: the
       nearest gap to a barely-moved press is the row's own top edge, `dropShapes`
       looks that key up among the rows that are staying and does not find it,
       and the not-found fallback was the end of the list.

       Measured as the paint order and as the undo stack together, because the
       order alone cannot tell "moved back to where it was" from "did not move",
       and only the second is right. */
    check(
      !(await page.isDisabled('#redo')),
      'the undo above left nothing to redo, so the redo probe below measures nothing',
    );
    /* Pressed near the row's top edge, so that four pixels down leaves that edge
       the nearest gap. Pressed at the middle instead, the nearest gap is the
       next row's top, `before` names a row that is staying, and the drop is a
       correct no-op whether or not any of this is fixed. */
    const midRow = await rowBox(1);
    await page.mouse.move(midRow.x + midRow.width / 2, midRow.y + 3);
    await page.mouse.down();
    /* Seven, not four. `ROW_SLOP` is 4 and the guard is `< ROW_SLOP`, so a
       four-pixel move starts the drag by one unit of margin: raise the slop, or
       have the browser coalesce a move, and the press never becomes a drag at
       all -- at which point both assertions below pass with the defect fully
       restored. Seven is past the slop with room, and still well above the
       row's midpoint, which is what makes its own top edge the nearest gap. */
    await page.mouse.move(midRow.x + midRow.width / 2, midRow.y + 10);
    await page.mouse.up();
    await settle(page);
    out.afterTinyDrag = await painted();
    check(
      JSON.stringify(out.afterTinyDrag) === JSON.stringify(out.beforeDrag),
      `a four-pixel row drag repainted the order as ${JSON.stringify(out.afterTinyDrag)}`,
    );
    check(
      !(await page.isDisabled('#redo')),
      'a four-pixel row drag cleared the redo stack, so it filed an edit',
    );


    /* A drag with nowhere to go draws no line. Selecting a whole group and
       pressing a row inside it lifts every sibling in that group's own list, so
       there is nothing left for them to travel past; `dropShapes` declined and
       the line had followed the pointer the whole way, promising a move no
       position could have produced. */
    await page.click('#shapelist li.shape:nth-child(2)');
    await page.click('#shapelist li.shape:nth-child(3)', { modifiers: ['Shift'] });
    await settle(page);
    await page.click('#groupShapes');
    await settle(page);
    const inner = await page.locator('#shapelist li.group li.shape').first().boundingBox();
    check(!!inner, 'the group did not draw its shapes as nested rows');
    await page.mouse.move(inner.x + inner.width / 2, inner.y + inner.height / 2);
    await page.mouse.down();
    await page.mouse.move(inner.x + inner.width / 2, inner.y + inner.height / 2 + 12);
    out.lineInsideWholeGroup = await page.locator('.dropline').count();
    await page.mouse.up();
    await settle(page);
    check(
      out.lineInsideWholeGroup === 0,
      'a drag inside a wholly selected group drew a drop line it could not honour',
    );
    await undo(page);
    await settle(page);

    /* Past a group, not into it. The two remaining shapes are grouped, so the
       shape at the back has to clear both of them in one step or the group's run
       is broken and the export writes two `<g>`. */
    await settle(page);
    await page.click('#shapelist li.shape:nth-child(2)');
    await page.click('#shapelist li.shape:nth-child(3)', { modifiers: ['Shift'] });
    await settle(page);
    await page.click('#groupShapes');
    await settle(page);
    out.grouped = await listed();

    /* The direct child, not `li.shape`, which would also match the two rows
       nested inside the group's own list. */
    await page.click('#shapelist > li.shape');
    await settle(page);
    const before = await painted();
    check(before[0] === '#111111', `the loose shape is not at the back: ${JSON.stringify(before)}`);
    await page.click('#orderForward');
    await settle(page);
    out.pastGroup = await painted();
    check(
      out.pastGroup[2] === '#111111',
      `going forward past a group landed the shape at ${out.pastGroup.indexOf('#111111')} of 3`,
    );

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    const svg = await page.inputValue('#src');
    out.svg = svg;
    check(
      (svg.match(/<g\b/g) ?? []).length === 1,
      `reordering past a group broke its run: the export holds ${(svg.match(/<g\b/g) ?? []).length} <g>`,
    );
    await closeSource(page);

    return out;
  },

  /**
   * Aligning, distributing and spacing whole shapes, against the selection and
   * against the canvas.
   *
   * Measured with `getBBox` on the paths the canvas drew, which is the box the
   * operation claims to be moving and the one a person is looking at. Reading
   * the `d` strings instead would compare coordinates, and coordinates can agree
   * while the drawing is wrong -- a rectangle whose node order starts at the
   * corner being aligned to passes that test without moving.
   *
   * What needs a browser rather than `test/arrange.test.ts`: which buttons are
   * live for which selection, that the frame switch reaches the commands, and
   * that an empty Gap field is a different request from a Gap of nothing.
   */
  async arrange(page, check) {
    /* Boxes in document coordinates, in paint order. `getBBox` is the element's
       own untransformed box, so this is independent of where the camera is. */
    const boxes = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.artwork path')].map((p) => {
          const b = p.getBBox();
          return {
            x: +b.x.toFixed(4),
            y: +b.y.toFixed(4),
            w: +b.width.toFixed(4),
            h: +b.height.toFixed(4),
          };
        }),
      );
    const out = {};

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M10 10 H20 V20 H10 Z" fill="#2563d8"/>
  <path d="M40 30 H60 V40 H40 Z" fill="#e8a54b"/>
  <path d="M70 60 H80 V70 H70 Z" fill="#3aa856"/>
</svg>`,
    );
    await page.click('#apply');
    await closeSource(page);
    await tab(page, 'shape');
    await settle(page);

    out.start = await boxes();
    check(out.start.length === 3, `the fixture drew ${out.start.length} paths, not 3`);

    // Nothing selected: every arrange control is dead, and the readout says so.
    check(await page.isDisabled('[data-sal="left"]'), 'Align shapes was live with nothing selected');
    check(await page.isDisabled('[data-sdi="left"]'), 'Distribute was live with nothing selected');
    check(await page.isDisabled('#spaceGap'), 'the Gap field was live with nothing selected');
    check(
      (await page.textContent('#arrangeinfo')).trim() === 'none',
      `the arrange readout says ${JSON.stringify(await page.textContent('#arrangeinfo'))} with nothing selected`,
    );

    // One shape: against the selection there is nothing to align it to.
    await page.click('#shapelist li.shape:nth-child(1)');
    await settle(page);
    check(
      await page.isDisabled('[data-sal="left"]'),
      'Align was live for one shape against the selection',
    );

    /* The same one shape, against the canvas, is the commonest request there is:
       centre this icon. So the switch has to re-enable the buttons. */
    await page.click('#alignTo button[data-to="canvas"]');
    await settle(page);
    check(
      !(await page.isDisabled('[data-sal="left"]')),
      'Align stayed dead for one shape against the canvas',
    );
    await page.click('[data-sal="hcenter"]');
    await page.click('[data-sal="vcenter"]');
    await settle(page);
    const centred = (await boxes())[0];
    out.centred = centred;
    check(
      Math.abs(centred.x + centred.w / 2 - 50) < 1e-6 && Math.abs(centred.y + centred.h / 2 - 50) < 1e-6,
      `centring on the canvas put the shape at ${JSON.stringify(centred)}`,
    );
    check(
      centred.w === out.start[0].w && centred.h === out.start[0].h,
      'aligning changed the size of the shape, so something scaled it',
    );

    await undo(page);
    await undo(page);
    check(
      JSON.stringify(await boxes()) === JSON.stringify(out.start),
      'two undos did not put the two aligns back',
    );

    // All three, back against the selection.
    await page.click('#alignTo button[data-to="selection"]');
    await page.click('#shapelist li.shape:nth-child(2)', { modifiers: ['Shift'] });
    await page.click('#shapelist li.shape:nth-child(3)', { modifiers: ['Shift'] });
    await settle(page);
    check(
      (await page.textContent('#arrangeinfo')).trim() === '3 items',
      `three selected shapes read as ${JSON.stringify(await page.textContent('#arrangeinfo'))}`,
    );
    check(!(await page.isDisabled('[data-sdi="left"]')), 'Distribute was dead with three shapes');

    await page.click('[data-sal="top"]');
    await settle(page);
    const topped = await boxes();
    out.topped = topped;
    check(
      topped.every((b) => Math.abs(b.y - 10) < 1e-6),
      `aligning top left the shapes at ${JSON.stringify(topped.map((b) => b.y))}`,
    );

    /* Distributing centres: the outer two hold still and the middle one moves to
       the midpoint between them. Asserted on the gaps rather than on a position,
       because "evenly spaced" is a statement about differences. */
    await page.click('[data-sdi="hcenter"]');
    await settle(page);
    const spread = await boxes();
    out.spread = spread;
    const mids = spread.map((b) => b.x + b.w / 2).sort((a, b) => a - b);
    check(
      Math.abs(mids[1] - mids[0] - (mids[2] - mids[1])) < 1e-6,
      `distributing centres gave gaps of ${mids[1] - mids[0]} and ${mids[2] - mids[1]}`,
    );

    /* An empty Gap asks for the gap that fills the selection's own box, so the
       outer two stay put. A Gap of 5 packs them from the left edge instead, and
       the two answers have to differ or the field is doing nothing.

       The middle shape is moved off its even spacing FIRST. Without that it
       arrives here already evenly spaced -- the distribute above put it there,
       and with three shapes of equal width even centres and even gaps are the
       same layout -- so both checks below held on the state they inherited and
       the whole `gap === null` branch of `spaceUnits` could be deleted with the
       scenario still green. */
    await page.click('#shapelist li.shape:nth-child(2)');
    await settle(page);
    const midBefore = Number(await page.inputValue('#selX'));
    await page.fill('#selX', String(midBefore + 7));
    await page.press('#selX', 'Enter');
    await settle(page);
    await page.click('#shapelist li.shape:nth-child(1)');
    await page.click('#shapelist li.shape:nth-child(2)', { modifiers: ['Shift'] });
    await page.click('#shapelist li.shape:nth-child(3)', { modifiers: ['Shift'] });
    await settle(page);
    const uneven = (await boxes()).sort((a, b) => a.x - b.x);
    const unevenGaps = uneven.slice(1).map((b, i) => b.x - (uneven[i].x + uneven[i].w));
    check(
      Math.abs(unevenGaps[0] - unevenGaps[1]) > 1e-6,
      `the middle shape did not move off its even spacing: gaps ${JSON.stringify(unevenGaps)}`,
    );

    const before = (await boxes()).sort((a, b) => a.x - b.x);
    await page.click('[data-ssp="h"]');
    await settle(page);
    const evened = (await boxes()).sort((a, b) => a.x - b.x);
    const filled = evened.map((b) => b.x);
    out.filled = filled;
    const evenGaps = evened.slice(1).map((b, i) => b.x - (evened[i].x + evened[i].w));
    out.evenGaps = evenGaps;
    check(
      Math.abs(evened[0].x - before[0].x) < 1e-6 &&
        Math.abs(evened[2].x + evened[2].w - (before[2].x + before[2].w)) < 1e-6,
      `filling the selection moved an outer shape: ${JSON.stringify(filled)}`,
    );
    check(
      Math.abs(evenGaps[0] - evenGaps[1]) < 1e-6 && evenGaps[0] > 0,
      `filling the selection left gaps of ${JSON.stringify(evenGaps)}`,
    );

    await page.fill('#spaceGap', '5');
    await page.click('[data-ssp="h"]');
    await settle(page);
    const run = (await boxes()).sort((a, b) => a.x - b.x);
    const packed = run.map((b) => b.x);
    out.packed = packed;
    const gaps = run.slice(1).map((b, i) => b.x - (run[i].x + run[i].w));
    out.gaps = gaps;
    check(
      gaps.every((g) => Math.abs(g - 5) < 1e-6),
      `packing at a gap of 5 left gaps of ${JSON.stringify(gaps)}`,
    );
    check(
      JSON.stringify(filled) !== JSON.stringify(packed),
      'the Gap field changed nothing: filling the frame and packing at 5 gave the same result',
    );

    return out;
  },

  /**
   * Rounding a corner by dragging it, and un-rounding it by dragging it back.
   *
   * The whole point of the control is that nothing stores a radius: a sharp corner
   * is measured off its two sides, and a rounded one is recovered from the two
   * handles that point at where the corner was. So a rounded corner can be grabbed
   * again, which is the assertion that matters and the one a unit test cannot make
   * -- the control's position is a client pixel, and where that lands on the
   * document is the camera's answer.
   *
   * §48 of `docs/ARCHITECTURE.md` has the argument.
   */
  async cornerWidget(page, check) {
    const d = () => drawnPath(page, 0);
    const out = {};

    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M20 20 L80 20 L80 80 L20 80 Z" fill="#2563d8"/>
</svg>`,
    );
    await page.click('#apply');
    await closeSource(page);
    await tab(page, 'shape');
    await page.click('#shapelist li.shape');
    /* A selection is a render, not a re-layout, and `laidOut` with nothing
       moving is one 25 ms poll: the fixed sleep this harness has none of,
       wearing a condition wait's name. */
    await settle(page);

    const square = await d();
    check(square === 'M 20 20 H 80 V 80 H 20 Z', `the square came out as ${square}`);

    /* Read after a hover and after the layout settles. Moving the pointer over the
       canvas fills the cursor readout, which changes the status strip's height and
       moves the canvas -- so a control position read before the first hover is
       stale by the time a press lands on it. */
    await page.mouse.move(700, 400);
    await laidOut(page);
    await settle(page);

    const controls = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.overlay [data-hit="corner"]')].map((e) => {
          const b = e.getBoundingClientRect();
          return {
            i: Number(e.getAttribute('data-i')),
            rounded: /rounded/.test(e.getAttribute('class') ?? ''),
            x: b.x + b.width / 2,
            y: b.y + b.height / 2,
          };
        }),
      );

    const sharp = await controls();
    out.controls = sharp.length;
    check(sharp.length === 4, `a square offered ${sharp.length} corner controls, not 4`);
    check(
      sharp.every((c) => !c.rounded),
      'a corner with no arc in it was drawn as though it had one',
    );

    /* Clear of the anchor, which is the collision this control was moved to avoid:
       the anchor layer paints in front of the handle layer, so a control sitting on
       the corner is covered by the corner's own anchor and can never be pressed. */
    const anchorAt = await page.evaluate(() => {
      const a = document.querySelector('.overlay [data-hit="anchor"][data-i="0"]');
      const b = a.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
    });
    const first = sharp.find((c) => c.i === 0);
    const gap = Math.hypot(first.x - anchorAt.x, first.y - anchorAt.y);
    out.gapFromAnchor = Math.round(gap);
    check(gap > anchorAt.w, `the control sits ${gap.toFixed(1)} px from a ${anchorAt.w} px anchor`);

    const under = await page.evaluate(([x, y]) => {
      const e = document.elementsFromPoint(x, y)[0];
      return e ? e.getAttribute('data-hit') : null;
    }, [first.x, first.y]);
    check(under === 'corner', `the topmost element at the control is ${JSON.stringify(under)}`);

    // Drag it in along the bisector.
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    await page.mouse.move(first.x + 22, first.y + 22, { steps: 8 });
    out.readout = await page.evaluate(() => {
      const el = document.querySelector('#measure');
      return el.hidden ? null : el.textContent.trim();
    });
    check(
      /radius/.test(out.readout ?? ''),
      `the drag reported ${JSON.stringify(out.readout)} rather than a radius`,
    );
    await page.mouse.up();
    await settle(page);

    const rounded = await d();
    out.rounded = rounded;
    check(rounded !== square, 'dragging the corner control changed nothing');
    check(/C/.test(rounded), `the corner did not become an arc: ${rounded}`);

    // One undo step for the whole drag, however many moves it took.
    await undo(page);
    check((await d()) === square, `undo left ${await d()} rather than the square`);
    await page.keyboard.press('Control+Shift+z');
    await settle(page);
    check((await d()) === rounded, 'redo did not put the rounded corner back');

    /* The control on a corner that already holds an arc. This is what needs the
       radius to be recoverable: there is nowhere it could have been read from. */
    await settle(page);
    const after = await controls();
    const grown = after.find((c) => c.rounded);
    out.roundedControls = after.filter((c) => c.rounded).length;
    check(!!grown, 'a rounded corner offered no control to grab again');

    await page.mouse.move(grown.x, grown.y);
    await page.mouse.down();
    await page.mouse.move(grown.x - 14, grown.y - 14, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    const smaller = await d();
    out.smaller = smaller;
    check(smaller !== rounded, 'dragging a rounded corner back changed nothing');
    check(/C/.test(smaller), `the corner stopped being an arc too early: ${smaller}`);

    /* All the way back to the corner. Exact, because the corner is recovered rather
       than approximated -- so this has to be the square it started as, character for
       character, and not merely something close to it. */
    await laidOut(page);
    const again = (await controls()).find((c) => c.rounded);
    check(!!again, 'the smaller arc offered no control');
    await page.mouse.move(again.x, again.y);
    await page.mouse.down();
    await page.mouse.move(again.x - 90, again.y - 90, { steps: 10 });
    await page.mouse.up();
    await settle(page);
    out.backTo = await d();
    check(
      out.backTo === square,
      `dragging the radius to nothing left ${out.backTo} rather than ${square}`,
    );

    return out;
  },

  /**
   * A shape holding more than one path, and the list saying so.
   *
   * The complaint this answers: two disjoint paths in one shape, with the list
   * showing one row, one name and one number. Nothing about that says a shape
   * holds more than one path, and `Shift`+`K` is undiscoverable if you cannot see
   * that you need it.
   *
   * Driven in a browser because all of it is layout and events: a disclosure that
   * opens, a nested row that takes a press meant for it rather than for the shape
   * it sits inside, and the tree's own arrow keys.
   */
  async shapeTree(page, check) {
    const rows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#shapelist li')].map((li) => ({
          kind: li.className,
          level: li.getAttribute('aria-level'),
          sp: li.getAttribute('data-sp'),
          selected: li.getAttribute('aria-selected'),
          expanded: li.getAttribute('aria-expanded'),
        })),
      );
    const selectedRows = async () =>
      (await rows()).filter((r) => r.selected === 'true').map((r) => `${r.kind}${r.sp ?? ''}`);
    /* The row the tree reports as the keyboard's, resolved through the id rather
       than compared as a string: an `aria-activedescendant` naming an element
       that is not there is exactly as silent as no attribute at all, and only
       the lookup tells the two apart. */
    const activeRow = () =>
      page.evaluate(() => {
        const list = document.querySelector('#shapelist');
        const id = list.getAttribute('aria-activedescendant');
        if (id === null) return null;
        const el = document.getElementById(id);
        if (!el || !list.contains(el)) return { id, kind: 'gone' };
        return { id, kind: el.className, sp: el.getAttribute('data-sp') };
      });
    const out = {};

    /* Two disjoint squares in one shape, which is what `Unite` and `Combine` both
       produce and what an imported `<path>` with two `M` runs already is. */
    await openSource(page);
    await page.click('#srcmode button[data-v="svg"]');
    await page.fill(
      '#src',
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M10 10 H30 V30 H10 Z M60 60 H80 V80 H60 Z" fill="#2563d8"/>
</svg>`,
    );
    await page.click('#apply');
    await closeSource(page);
    await tab(page, 'shape');

    const start = await rows();
    check(start.length === 1, `the list drew ${start.length} rows for one shape`);
    check(start[0].expanded === 'false', 'a shape holding two paths offered nothing to open');
    out.count = (await page.textContent('#shapelist li.shape .ct')).trim();
    check(/2 paths/.test(out.count), `the row reads "${out.count}" rather than a path count`);

    // Open it. Two rows appear, one level down.
    await page.click('#shapelist .twist:not(.none)');
    await settle(page);
    const open = await rows();
    check(open.length === 3, `opening the shape drew ${open.length} rows, not 3`);
    check(
      open.slice(1).every((r) => r.kind === 'path' && r.level === '2'),
      'the paths did not come out as rows one level down',
    );

    /* A press on a path row. The row is nested inside the shape's own `li` and
       carries the same `data-id`, so a handler reading `data-id` first claims it
       for the shape and the path can never be selected at all. */
    await page.click('#shapelist li.path[data-sp="0"]');
    await settle(page);
    out.afterFirstPath = await selectedRows();
    check(
      out.afterFirstPath.join() === 'path0',
      `clicking the first path selected ${JSON.stringify(out.afterFirstPath)}`,
    );

    /* Half the nodes, which is the whole point: a path row selects the nodes of
       one path, and the canvas is where that has to show. */
    const anchors = await page.evaluate(() => ({
      all: document.querySelectorAll('.overlay [data-hit="anchor"]').length,
      lit: document.querySelectorAll('.overlay [data-hit="anchor"].selected').length,
    }));
    out.anchors = anchors;
    check(anchors.all === 8, `the document drew ${anchors.all} anchors, not 8`);
    check(anchors.lit === 4, `selecting one path of two lit ${anchors.lit} of 8 anchors`);

    await page.click('#shapelist li.path[data-sp="1"]');
    await settle(page);
    out.afterSecondPath = await selectedRows();
    check(
      out.afterSecondPath.join() === 'path1',
      `clicking the second path selected ${JSON.stringify(out.afterSecondPath)}`,
    );

    // A path has no name, so a double-click on one must not open a rename.
    await page.evaluate(() =>
      document
        .querySelector('#shapelist li.path')
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    await settle(page);
    check(
      !(await page.$('#shapelist .rename')),
      'double-clicking a path row started a rename of the shape it belongs to',
    );

    /* The arrow keys, which are the only route to a path row without a pointer.
       Shut first, so Right has to open before it can step in. */
    await page.click('#shapelist .twist:not(.none)');
    await settle(page);
    check((await rows()).length === 1, 'the disclosure did not shut again');
    await page.focus('#shapelist');
    await page.keyboard.press('ArrowDown');
    await settle(page);
    check((await selectedRows()).join() === 'shape', 'ArrowDown did not reach the shape row');

    /* The list is one tab stop with arrows moving inside it, so what the arrows
       are on is announced through `aria-activedescendant` or not at all. Read
       after every press that moves the cursor, because an attribute set once and
       left behind names the right row exactly until somebody uses the feature. */
    out.active = await activeRow();
    check(
      out.active?.kind === 'shape',
      `after ArrowDown the tree named ${JSON.stringify(out.active)} rather than the shape row`,
    );

    await page.keyboard.press('ArrowRight');
    await settle(page);
    check((await rows()).length === 3, 'ArrowRight did not open the shape');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    check((await selectedRows()).join() === 'path0', 'a second ArrowRight did not step into the paths');
    const onFirstPath = await activeRow();
    check(
      onFirstPath?.kind === 'path' && onFirstPath.sp === '0',
      `stepping into the paths named ${JSON.stringify(onFirstPath)} rather than the first path row`,
    );
    await page.keyboard.press('ArrowDown');
    await settle(page);
    check((await selectedRows()).join() === 'path1', 'ArrowDown did not walk to the next path');
    const onSecondPath = await activeRow();
    check(
      onSecondPath?.kind === 'path' && onSecondPath.sp === '1',
      `walking to the second path named ${JSON.stringify(onSecondPath)}`,
    );
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    check((await selectedRows()).join() === 'shape', 'ArrowLeft did not step back out to the shape');
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    check((await rows()).length === 1, 'a second ArrowLeft did not shut the shape');

    /* Split is the operation the list now makes findable, and it has to leave two
       shapes with nothing left to open. */
    await page.click('#shapelist li.shape');
    await settle(page);
    await page.click('#splitshape');
    await settle(page);
    const split = await rows();
    out.afterSplit = split.length;
    check(split.length === 2, `Split left ${split.length} rows, not 2`);
    check(
      split.every((r) => r.expanded === null),
      'a shape of one path still offered something to open after Split',
    );

    /* Empty the list. It is drawn by a branch that returns before the selection
       is painted, so a cursor named on the way in outlives every row it could
       name unless that branch clears it too. */
    await page.keyboard.press('Control+a');
    await settle(page);
    await page.click('#del');
    await settle(page);
    check((await rows()).length === 1, 'deleting everything did not leave the empty row');
    out.activeWhenEmpty = await activeRow();
    check(
      out.activeWhenEmpty === null,
      `an empty list still named ${JSON.stringify(out.activeWhenEmpty)} as its active row`,
    );

    return out;
  },

  /**
   * Which of a control and the document owns Ctrl+Z and the clipboard keys.
   *
   * A number field has no edit history of its own, so undo there is the
   * document's. Text does have one, so the source box keeps the chord. Both
   * halves are driven from a real focus, because the rule reads `e.target` and
   * jsdom cannot say what the browser will make the target of a key press.
   */
  async undoFromField(page, check) {
    const drawn = () => drawnPath(page, 0);
    const out = {};

    // An edit to undo, made from the canvas so the field is not involved.
    await page.keyboard.press('v');
    const at = await page.evaluate(() => {
      const b = document.querySelector('.overlay [data-hit="anchor"]').getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.click(at.x, at.y);
    await settle(page);
    const before = await drawn();
    await page.keyboard.press('ArrowRight');
    await settle(page);
    const nudged = await drawn();
    check(nudged !== before, 'the arrow key did not move anything');

    // Ctrl+Z with focus in a spinner reaches the document.
    const field = await page.evaluate(() => {
      const i = [...document.querySelectorAll('input[type="number"]')].find(
        (x) => !x.disabled && x.offsetParent !== null,
      );
      if (!i) return null;
      i.focus();
      return i.id;
    });
    check(!!field, 'no enabled number field was on screen');
    out.field = field;
    await page.keyboard.press('Control+z');
    await settle(page);
    check(
      (await drawn()) === before,
      `Ctrl+Z from #${field} did not undo; the path reads ${await drawn()}`,
    );
    // And focus left, so nothing the field was holding lands afterwards.
    out.focusAfterUndo = await page.evaluate(() => document.activeElement.tagName);
    check(out.focusAfterUndo !== 'INPUT', 'focus stayed in the field after undoing from it');

    /* Ctrl+C in a spinner belongs to the spinner: the document must not change.

       A whole shape is selected first, and that is the whole of what makes this
       measurable. The selection left by the click above is one node, and
       `copySelection` refuses a lone node -- it has no segment -- so Ctrl+C and
       Ctrl+V were no-ops whichever of the two they reached, and this passed with
       the guard deleted. With a shape selected, a paste that reached the
       document adds one and `#stats` says so. */
    await tab(page, 'shape');
    await page.click('#shapelist li.shape');
    await settle(page);
    const canCopy = await page.evaluate(() => document.querySelectorAll('#shapelist li.shape[aria-selected="true"]').length);
    check(canCopy === 1, `the clipboard block starts with ${canCopy} shapes selected, not 1`);
    await page.evaluate(() => {
      const i = [...document.querySelectorAll('input[type="number"]')].find(
        (x) => !x.disabled && x.offsetParent !== null,
      );
      i.focus();
    });
    const heldBefore = await drawn();
    const countBefore = await page.textContent('#stats');
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await settle(page);
    check(
      (await drawn()) === heldBefore && (await page.textContent('#stats')) === countBefore,
      'the clipboard keys reached the document from inside a number field',
    );

    // The source box keeps Ctrl+Z for its own text.
    await openSource(page);
    await page.click('#src');
    await page.keyboard.type(' 0');
    const typed = await page.inputValue('#src');
    const docBefore = await drawn();
    await page.keyboard.press('Control+z');
    await settle(page);
    out.textChanged = (await page.inputValue('#src')) !== typed;
    check(out.textChanged, 'Ctrl+Z in the source box did not undo the typing');
    check((await drawn()) === docBefore, 'Ctrl+Z in the source box undid the document as well');

    return out;
  },
};

/* CI runs every scenario, and a list hard-coded in a workflow file would go
   stale the first time one is added here. This is the one place that knows. */
if (args.includes('--list')) {
  console.log(Object.keys(scenarios).join('\n'));
  process.exit(0);
}

/**
 * Refuse a scenario that cannot fail.
 *
 * Thirteen of them read the page, returned what they found, and asserted
 * nothing, so breaking what they exercised still exited 0 and printed a
 * plausible blob. Calling `check` is not proof that a scenario measures the
 * right thing, but never calling it is proof that it measures nothing, and
 * that much a machine can settle. Run by CI ahead of the scenarios themselves.
 */
if (args.includes('--audit')) {
  /* `check(` with nothing but whitespace or an operator in front of it. A word
     boundary is not enough: `page.check('#filled')` ticks a checkbox, it is
     everywhere in this file, and it satisfied `\bcheck\(` -- so two scenarios
     that asserted nothing were counted as asserting something by the check
     written to catch exactly that. */
  const silent = Object.entries(scenarios)
    .filter(([, fn]) => !/(?<![.\w])check\(/.test(fn.toString()))
    .map(([name]) => name);
  for (const name of silent) console.error(`${name} never calls check, so it cannot fail`);
  console.log(`${Object.keys(scenarios).length} scenarios, ${silent.length} of which assert nothing`);
  process.exit(silent.length ? 1 : 0);
}

const scenario = scenarios[scenarioName];
if (!scenario) {
  console.error(`unknown scenario '${scenarioName}'. have: ${Object.keys(scenarios).join(', ')}`);
  process.exit(1);
}

const browser = await launch({ headless: !headed });
/* The window shape decides how much of the document is on screen: the camera is
   fitted to the canvas box, so a squarer canvas shows a narrower span of x and
   the scenarios' coordinates start falling outside it. This is sized so the
   canvas keeps an aspect near 1.65 with the inspector open, which is what the
   hard-coded document coordinates below assume. */
const page = await browser.newPage({ viewport: { width: 1600, height: 860 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

/* `pageerror` is the main thread only, and the tracer runs in a worker. An
   uncaught throw in there fires an `error` event on the `Worker` object and
   nothing else: the app turns that into a rejected promise and a sentence, so
   a worker that died of a real bug and a worker the browser refused to start
   arrive at the harness looking identical. Every worker gets a listener that
   routes it to the console, which is already read for `[error]` at the end of
   this file. Installed before the first navigation, so it is in place for the
   page that runs the scenario. */
await page.addInitScript(() => {
  const Real = window.Worker;
  window.Worker = class extends Real {
    constructor(...args) {
      super(...args);
      this.addEventListener('error', (e) => {
        console.error(`[worker] ${e.message || 'threw with no message'} at ${e.filename || '?'}:${e.lineno ?? '?'}`);
      });
    }
  };
});

await page.goto(APP_URL, { waitUntil: 'networkidle' });
await settle(page);

/* Every inspector group open, before any scenario runs.
 *
 * Groups collapse now, and a shut one keeps its controls out of the hit test
 * and out of the tab order -- which is the feature. A scenario that names a
 * control by id has already said which group it wants, and making each one open
 * its own group first would be thirty edits that test the opening rather than
 * the control. Opening them all here says once what every scenario means.
 *
 * `.click()` works on a hidden button, so the panels that are not showing are
 * covered too. `tab()` opens whatever appeared after this, for anything added
 * to the DOM later. */
await page.evaluate(() => {
  for (const h of document.querySelectorAll('button.glabel')) {
    if (h.getAttribute('aria-expanded') !== 'true') h.click();
  }
});
await settle(page);

/**
 * What a scenario asserts with.
 *
 * Built here because the runner is the only thing that knows which scenario is
 * speaking, so no scenario has to spell its own name into the message.
 *
 * A scenario that only reads the page and returns what it found is not a
 * check: break the thing it exercises and it still exits 0, printing a
 * plausible-looking blob. Every scenario is expected to call this at least
 * once, and `--audit` below refuses the ones that do not.
 */
const check = (ok, what) => {
  if (!ok) throw new Error(`${scenarioName}: ${what}`);
};

let result;
let failure = null;
/* A failed `check` throws, and the screenshot and the audit below are most
   worth having on exactly that run, so the throw is caught rather than left to
   end the process. Catching it is not forgiving it: `failure` carries the
   reason to the exit code at the end of the file. */
try {
  result = await scenario(page, check);
} catch (err) {
  result = { error: err.message };
  failure = err.message;
}

await settle(page);
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

  /* Overlay decoration that takes the press without naming a hit.
   *
   * The controller reads a press whose target has no `data-hit` as the start of
   * a marquee, so decoration painted over a control makes that patch of the
   * control do the opposite of what it should.
   *
   * Document order is paint order in SVG, so "over a control" is "after the
   * first `data-hit`". Anything earlier is under every control on the canvas
   * and can take a press from none of them, which is why the grid is exempt.
   *
   * The question is what an element is, not whether it is getting away with it
   * today: being covered by a wider hit strip is another element's geometry
   * rather than a rule. §54 of `docs/ARCHITECTURE.md` has the argument and what
   * this has caught. */
  const swallow = new Map();
  let overAControl = false;
  for (const el of document.querySelectorAll('.overlay *')) {
    if (el.hasAttribute('data-hit')) {
      overAControl = true;
      continue;
    }
    if (!overAControl) continue;
    /* The browser's own taxonomy rather than a list of tag names kept here. A
       new kind of overlay element is an `SVGGeometryElement` whether or not
       anyone remembers this check exists; a hand-written list of tags would let
       it through and say nothing. A `<g>` is in none of these, which is right:
       it has no geometry and is only ever hit through a child. */
    const drawn =
      el instanceof SVGGeometryElement ||
      el instanceof SVGImageElement ||
      el instanceof SVGTextContentElement ||
      el instanceof SVGUseElement;
    if (!drawn) continue;
    if (el.getAttribute('display') === 'none') continue;
    if (getComputedStyle(el).pointerEvents === 'none') continue;
    const k = el.getAttribute('class') || el.tagName;
    swallow.set(k, (swallow.get(k) ?? 0) + 1);
  }

  /* Every coordinate that reached the DOM, not only the drawing's.
   *
   * This read `.artwork path` alone, so a NaN in the corner widget, the
   * transform box, the smart guides or the marquee was reported by nothing:
   * those are overlay elements, and an SVG element with a broken number in a
   * geometry attribute draws nothing and throws nothing. The whole point of
   * this check is the failure a screenshot is worst at showing, and most of the
   * geometry this editor computes per frame is on the overlay.
   *
   * Swept over the attributes that carry numbers rather than over `d` alone,
   * for the reason the swallow check gives: a hand-kept list of element types
   * lets the next kind through and says nothing. */
  /* `viewBox` and `stroke-width` are the two that matter most and were the two
     missing. The camera writes `viewBox` on both SVG roots from raw template
     interpolation, so a NaN reaching it blanks the entire drawing and the whole
     overlay at once, silently -- the largest blast radius available and exactly
     the failure this check exists for. Every overlay stroke is derived from
     document-units-per-pixel, so a NaN there makes every outline, handle line
     and box edge invisible while the numbers look fine. */
  const NUMERIC = [
    'd', 'viewBox', 'stroke-width', 'opacity',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'width', 'height', 'points', 'transform',
  ];
  const broken = [];
  for (const el of document.querySelectorAll('svg, svg *')) {
    for (const name of NUMERIC) {
      const v = el.getAttribute(name);
      if (v !== null && /NaN|Infinity|undefined/.test(v)) {
        broken.push(`${el.getAttribute('class') || el.tagName}[${name}]`);
      }
    }
  }

  return {
    artworkPaths: artwork.length,
    artworkD: artwork.map((p) => p.getAttribute('d')),
    badD: broken.length,
    badWhere: [...new Set(broken)],
    visibleAnchors: anchors.length,
    visibleHandles: handles.length,
    visibleHandleLines: lines.length,
    visibleOutlines: outlines.length,
    swallowers: [...swallow].map(([cls, n]) => `${n} x .${cls}`),
  };
});

console.log(JSON.stringify({ scenario: scenarioName, result, audit, logs }, null, 2));
console.log(`\nscreenshot -> ${out}`);

await browser.close();

/* The audit runs on every scenario, so it is the one check no scenario has to
   remember to write. A coordinate that reached the DOM as NaN draws nothing and
   throws nothing, which is the failure a screenshot is worst at showing. */
if (audit.badD > 0) {
  failure ??=
    `${audit.badD} attribute(s) reached the DOM holding NaN, Infinity or undefined: ` +
    audit.badWhere.join(', ');
}

if (audit.swallowers.length) {
  failure ??=
    `overlay decoration takes the press without naming a hit, painted over something that does: ` +
    audit.swallowers.join(', ');
}

const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'));
if (errors.length) failure ??= errors[0];

if (failure) {
  console.error(`\nFAIL ${scenarioName}: ${failure}`);
  process.exitCode = 1;
}
