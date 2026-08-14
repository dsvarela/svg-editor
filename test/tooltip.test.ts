/**
 * @vitest-environment jsdom
 *
 * The tooltip's rules about when it appears, when it goes, and where it lands.
 *
 * `tooltip.ts` records six behaviours in its comments that were each once
 * wrong. Three of them the browser scenarios already check: the native `title`
 * is adopted so both tooltips cannot show at once, a shortcut in parentheses
 * becomes a key cap, and a `<label>` resolves to its control so a screen reader
 * gets the description. The three here had nothing.
 *
 * They are here rather than in a scenario because each needs a window of a
 * chosen size and a rect of a chosen shape. A real browser can be asked for one
 * viewport per run; jsdom can be asked for a different one per test, which is
 * what a clamp needs to be measured against at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The tooltip's own constants, which it does not export. Kept in step by `lands within the window`. */
const GAP = 8;
const DELAY = 110;

const rects = new WeakMap<Element, DOMRect>();

const rect = (x: number, y: number, w: number, h: number): DOMRect =>
  ({
    x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h,
    toJSON: () => ({}),
  }) as DOMRect;

/** Give one element a box. Everything without one measures as a point at the origin. */
function boxOf(el: Element, x: number, y: number, w: number, h: number): void {
  rects.set(el, rect(x, y, w, h));
}

/**
 * How big the tooltip measures.
 *
 * Set by id rather than by element, because the layer does not exist until the
 * first `show` creates it -- and `place` measures it in that same call, so
 * there is no moment in between to hand it a box.
 */
let tipSize = { w: 0, h: 0 };

function viewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

/** The translate the tooltip was placed at, in the order `place` writes them. */
function placedAt(): { x: number; y: number } {
  const t = document.querySelector('#tip-layer') as HTMLElement;
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(t.style.transform);
  if (!m) throw new Error(`not placed: ${t.style.transform}`);
  return { x: +m[1], y: +m[2] };
}

const tipIsOn = (): boolean => !!document.querySelector('#tip-layer.on');

/**
 * A fresh module per test.
 *
 * `tooltip.ts` keeps the layer, the timer and the `installed` guard in module
 * state, so a second test in the same module would inherit the first one's
 * tooltip and its listeners.
 */
async function mount(): Promise<{ button: HTMLButtonElement; other: HTMLButtonElement }> {
  vi.resetModules();
  document.body.innerHTML = '';

  const button = document.createElement('button');
  button.id = 'subject';
  button.setAttribute('title', 'Fit the document to the canvas');
  const other = document.createElement('button');
  other.id = 'elsewhere';
  document.body.append(button, other);

  const { installTooltips } = await import('../src/ui/tooltip');
  installTooltips();
  return { button, other };
}

/** Hover an element and let the tooltip's own delay run out. */
function hover(el: Element): void {
  el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  vi.advanceTimersByTime(DELAY);
}

beforeEach(() => {
  vi.useFakeTimers();
  viewport(1000, 800);
  tipSize = { w: 0, h: 0 };
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      if (this.id === 'tip-layer') return rect(0, 0, tipSize.w, tipSize.h);
      return rects.get(this) ?? rect(0, 0, 0, 0);
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('where it lands', () => {
  /* A tall tip above a control near the top of a short window went off the top
     of the screen: only x was clamped. Measured as a coordinate rather than as
     a screenshot, because "off the top" is `y < GAP` and nothing else. */
  it('stays on screen when the control is near the top of a short window', async () => {
    const { button } = await mount();
    viewport(1000, 300);
    // Below the halfway line of a 300px window, so the tip is placed above it,
    // and taller than the room there is above it.
    boxOf(button, 400, 160, 40, 24);
    tipSize = { w: 200, h: 200 };
    hover(button);

    expect(tipIsOn()).toBe(true);
    expect(placedAt().y).toBeGreaterThanOrEqual(GAP);
  });

  it('stays on screen when the control is at the right edge', async () => {
    const { button } = await mount();
    boxOf(button, 980, 10, 20, 20);
    tipSize = { w: 240, h: 30 };
    hover(button);

    expect(placedAt().x).toBeLessThanOrEqual(1000 - 240 - GAP);
    expect(placedAt().x).toBeGreaterThanOrEqual(GAP);
  });
});

describe('what dismisses it', () => {
  /* `pointerout` fired anywhere used to close whatever was open, so moving the
     mouse across the canvas closed a tooltip the keyboard had opened on the
     far side of the window. */
  it('ignores a pointer leaving something else entirely', async () => {
    const { button, other } = await mount();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(0);
    expect(tipIsOn()).toBe(true);

    other.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    expect(tipIsOn()).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('tip-layer');
  });

  it('goes when the pointer leaves the element it describes', async () => {
    const { button } = await mount();
    hover(button);
    expect(tipIsOn()).toBe(true);

    button.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    expect(tipIsOn()).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });

  it('stays while the pointer moves within the element it describes', async () => {
    const { button } = await mount();
    const inner = document.createElement('span');
    button.append(inner);
    hover(button);

    const e = new MouseEvent('pointerout', { bubbles: true });
    Object.defineProperty(e, 'relatedTarget', { value: inner });
    inner.dispatchEvent(e);
    expect(tipIsOn()).toBe(true);
  });

  it('goes on Escape and on a press', async () => {
    const { button } = await mount();
    hover(button);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tipIsOn()).toBe(false);

    hover(button);
    expect(tipIsOn()).toBe(true);
    document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(tipIsOn()).toBe(false);
  });
});

describe('a scroll', () => {
  /* §38: the two kinds want opposite things. The focus half is checked in the
     browser, where a real panel really scrolls; the hover half is not, because
     nothing there scrolls under a stationary pointer. */
  it('takes a hover tooltip away', async () => {
    const { button } = await mount();
    boxOf(button, 400, 100, 40, 24);
    hover(button);
    expect(tipIsOn()).toBe(true);

    window.dispatchEvent(new Event('scroll'));
    expect(tipIsOn()).toBe(false);
  });

  it('carries a focus tooltip with it', async () => {
    const { button } = await mount();
    boxOf(button, 400, 100, 40, 24);
    button.focus();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(0);
    expect(tipIsOn()).toBe(true);
    const before = placedAt();

    boxOf(button, 400, 40, 40, 24);
    window.dispatchEvent(new Event('scroll'));
    expect(tipIsOn()).toBe(true);
    expect(placedAt().y).not.toBe(before.y);
  });
});

describe('how long it waits', () => {
  it('shows at once on focus, because focus is deliberate', async () => {
    const { button } = await mount();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(0);
    expect(tipIsOn()).toBe(true);
  });

  it('waits on hover, because the pointer may be passing through', async () => {
    const { button } = await mount();
    button.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(DELAY - 1);
    expect(tipIsOn()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(tipIsOn()).toBe(true);
  });
});
