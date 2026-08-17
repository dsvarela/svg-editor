/**
 * Which browser the three driving tools use, in one place.
 *
 * `drive.mjs`, `touch.mjs` and `keys.mjs` each spelled out the engine, the
 * executable path and the launch flags. Three copies of one fact, and the day
 * the machine's browser changed, all three broke separately.
 *
 * **Playwright drives its own builds, not the browser you installed.** A stock
 * Firefox has no Juggler protocol compiled in, so `executablePath` pointed at
 * `/usr/bin/firefox` fails to launch and says only that the process died. What
 * works is the build `playwright-core install firefox` puts under
 * `~/.cache/ms-playwright`, which is what this reaches by default. The exception
 * is a Chromium-family browser, which speaks CDP wherever it came from, so
 * `BROWSER_PATH` still points at a system Chrome or Edge.
 *
 *   BROWSER=firefox|chromium|webkit   which engine, default firefox
 *   BROWSER_PATH=/usr/bin/…           a system Chromium-family binary
 *   APP_URL=http://localhost:5177/    when the dev server is not on 5173
 */

import { chromium, firefox, webkit } from 'playwright-core';

const ENGINES = { chromium, firefox, webkit };

export const URL = process.env.APP_URL ?? 'http://localhost:5173/';
export const ENGINE = process.env.BROWSER ?? 'firefox';

/**
 * Launch, with the flags that engine understands and no others.
 *
 * `--no-sandbox` and `--disable-gpu` are Chromium's. Firefox takes a `-` prefix
 * and a different vocabulary, and passing it a Chromium flag is a launch that
 * fails for a reason the message does not give.
 */
export async function launch(extra = {}) {
  const engine = ENGINES[ENGINE];
  if (!engine) {
    console.error(`BROWSER=${ENGINE} is not one of ${Object.keys(ENGINES).join(', ')}`);
    process.exit(2);
  }
  const opts = { headless: true, ...extra };
  if (ENGINE === 'chromium') {
    opts.args = ['--no-sandbox', '--disable-gpu', ...(extra.args ?? [])];
    if (process.env.BROWSER_PATH) opts.executablePath = process.env.BROWSER_PATH;
  }
  try {
    return await engine.launch(opts);
  } catch (e) {
    console.error(`could not launch ${ENGINE}: ${String(e).split('\n')[0]}`);
    console.error(`install it with: node node_modules/playwright-core/cli.js install ${ENGINE}`);
    process.exit(2);
  }
}
