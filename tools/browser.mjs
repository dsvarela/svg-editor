/**
 * Which browser the driving tools use, in one place.
 *
 * `drive.mjs`, `touch.mjs` and `keys.mjs` all want the same engine, the same
 * executable and the same launch flags. One fact in three files is one fact
 * that breaks in three places.
 *
 * **Playwright drives its own builds, not the browser you installed.** A stock
 * Firefox has no Juggler protocol compiled in, so `executablePath` pointed at
 * `/usr/bin/firefox` cannot launch and reports only that the process died. The
 * build `playwright-core install firefox` puts under `~/.cache/ms-playwright`
 * is the one that works, and is what this reaches by default. A Chromium-family
 * browser is the exception: it speaks CDP wherever it came from, so
 * `BROWSER_PATH` points at a system Chrome or Edge.
 *
 *   BROWSER=firefox|chromium|webkit   which engine, default firefox
 *   BROWSER_PATH=/usr/bin/…           a system Chromium-family binary
 *   APP_URL=http://localhost:5177/    when the dev server is not on 5173
 */

import { chromium, firefox, webkit } from 'playwright-core';

const ENGINES = { chromium, firefox, webkit };

/* `APP_URL` rather than `URL`, which is a global class. A string under that
   name shadows it in every module that imports this, so `new URL(…)` becomes a
   confusing failure in a file that never mentioned this one. */
export const APP_URL = process.env.APP_URL ?? 'http://localhost:5173/';

const ENGINE = process.env.BROWSER ?? 'firefox';

/**
 * Launch, with the flags that engine understands and no others.
 *
 * `--no-sandbox` and `--disable-gpu` are Chromium's. Firefox takes a `-` prefix
 * and a different vocabulary, and passing it a Chromium flag is a launch that
 * fails for a reason the message does not give.
 *
 * Throws rather than exiting. The three callers are all command-line tools that
 * would exit anyway, but a function whose type says it returns a browser and
 * instead kills the process leaves nothing for a caller that wants to try
 * another engine, and no way to test this one. Node prints the message and
 * exits non-zero on an unhandled rejection, so the failure is still loud.
 */
export async function launch(extra = {}) {
  const engine = ENGINES[ENGINE];
  if (!engine) {
    throw new Error(`BROWSER=${ENGINE} is not one of ${Object.keys(ENGINES).join(', ')}`);
  }
  const opts = { headless: true, ...extra };
  if (ENGINE === 'chromium') {
    opts.args = ['--no-sandbox', '--disable-gpu', ...(extra.args ?? [])];
    if (process.env.BROWSER_PATH) opts.executablePath = process.env.BROWSER_PATH;
  }
  try {
    return await engine.launch(opts);
  } catch (e) {
    throw new Error(
      `could not launch ${ENGINE}: ${String(e).split('\n')[0]}\n` +
        `install it with: node node_modules/playwright-core/cli.js install ${ENGINE}`,
    );
  }
}
