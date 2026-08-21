/** @vitest-environment jsdom */
/**
 * The wiring file, under test for the first time.
 *
 * `src/main.ts` runs at module scope against the real `index.html`, so
 * importing it is starting the application and no unit test could reach it.
 * What makes the import worth doing anyway is `$`: it is
 * `document.querySelector(sel) as T`, so a selector that matches nothing is a
 * `TypeError` at the first listener bound to it, and every selector in the
 * wiring runs on load.
 *
 * **The markup is `index.html` itself**, because a fixture would go stale and
 * pass while the app broke.
 *
 * **This proves the app assembles and says nothing about what is painted.**
 * jsdom lays nothing out, so every box is zero by zero. Geometry stays in
 * `npm run drive`. §76 of `docs/ARCHITECTURE.md` has the argument, the three
 * stubs and the breaks this was watched failing on.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import html from '../index.html?raw';

/* The worker is a Vite import (`?worker&inline`) with no meaning outside a
   build. Tracing is exercised in `test/trace.test.ts` and in the `traceWorker`
   scenario; what matters here is that the module graph resolves. */
vi.mock('../src/model/trace.worker?worker&inline', () => ({
  default: class {
    postMessage(): void {}
    terminate(): void {}
    addEventListener(): void {}
    onmessage: unknown = null;
    onerror: unknown = null;
  },
}));

/** What jsdom does not implement and the app expects to be there. */
function stubBrowser(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  // Only ever handed to an `<a download>` or an `<img src>`, neither of which
  // jsdom fetches.
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};
}

/** `index.html`'s body, without the module script tag that Vite injects. */
const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

describe('the app assembles against its own markup', () => {
  beforeAll(async () => {
    stubBrowser();
    document.body.innerHTML = body;
    /* A stored session would decide half of what is asserted below, and the
       harness that runs this has no say in what a previous run left behind. */
    localStorage.clear();
    await import('../src/main');
  });

  it('imports without throwing, which is what a missing selector does', () => {
    /* The assertion is `beforeAll` having returned. `$` casts a null match to
       the element type, so a renamed id is a TypeError at the first listener
       bound to it, and every one of the wiring's selectors runs on import. */
    expect(document.querySelector('#stage')).not.toBeNull();
  });

  it('draws the starter document into the canvas', () => {
    // Something reached the DOM, so the store, the canvas and the render path
    // are all connected rather than merely constructed.
    const paths = document.querySelectorAll('#stage path');
    expect(paths.length).toBeGreaterThan(0);
  });

  it('leaves no path data holding NaN, Infinity or undefined', () => {
    /* The same check the browser audit runs, applied at load. A wiring defect
       that puts a bad number in a field reaches `d` as the string `NaN`, which
       renders as nothing and reports no error. */
    for (const el of document.querySelectorAll('#stage path')) {
      const d = el.getAttribute('d') ?? '';
      expect(d).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it('answers a toolbar press by changing what the store holds', () => {
    /* A button whose listener was never bound looks identical to one that was,
       until it is pressed. This presses one and reads the consequence rather
       than the button. */
    const pen = document.querySelector<HTMLButtonElement>('#tool button[data-v="pen"]');
    expect(pen).not.toBeNull();
    pen!.click();
    expect(pen!.getAttribute('aria-pressed')).toBe('true');

    const select = document.querySelector<HTMLButtonElement>('#tool button[data-v="select"]');
    select!.click();
    expect(select!.getAttribute('aria-pressed')).toBe('true');
    expect(pen!.getAttribute('aria-pressed')).toBe('false');
  });

  it('says something in the status line when an operation runs', () => {
    /* Placing a guide by number, which is wired straight through and gated by
       nothing. The sentence proves `say` is joined to both
       `Commands.onMessage` and `#status`, and those are two joins no other
       test here can see: one lives in a file nothing imports, and the other is
       an id that exists in the markup and in a string. */
    const at = document.querySelector<HTMLInputElement>('#guideAt');
    expect(at).not.toBeNull();
    at!.value = '15';
    document.querySelector<HTMLButtonElement>('#guideAddV')!.click();

    const status = document.querySelector('#status');
    expect(status?.textContent).toBe('Guide at x = 15.');
    expect(status?.className).toBe('st ok');
  });

  it('greys out an operation that would refuse, rather than letting it refuse', () => {
    /* Group needs two shapes and the starter document has one selected at
       most, so the button is disabled and its refusal is unreachable from a
       press. That is the design, and it is also why the sentence above could
       not be driven through this button. */
    const group = document.querySelector<HTMLButtonElement>('#groupShapes');
    expect(group).not.toBeNull();
    expect(group!.disabled).toBe(true);
  });

  it('puts every operation in the rail behind a control that answers', () => {
    /* Each of these is a button wired by `on(selector, ...)`, and `on` throws
       at import if its selector misses -- so the wiring is already proved by
       the load. What is proved here is the other direction: that the id in the
       markup is the id the handler asked for, which a rename breaks silently
       in exactly one of the two files. */
    for (const id of ['#undo', '#redo', '#del', '#curve', '#straight', '#ungroupShapes', '#selectGroup']) {
      expect(document.querySelector(id), id).not.toBeNull();
    }
  });
});
