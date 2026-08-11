/**
 * Tooltips for everything that carries a `title`.
 *
 * The toolbar is icons now, so the labels have to come from somewhere, and the
 * native tooltip is the wrong instrument: about a second of delay, no styling,
 * and on a dense strip of 26 px buttons it lands over the next button along.
 *
 * The titles already written in the markup stay the source of truth. The first
 * time an element is hovered its `title` is moved to `data-tip` — otherwise the
 * browser would show its own tooltip on top of this one — and it is put back
 * nowhere, because `data-tip` is what everything reads from then on.
 *
 * A trailing parenthesis is pulled out and set as a key cap: "Select (V)"
 * renders the shortcut rather than spelling it out mid-sentence.
 */

const DELAY = 110;
const GAP = 8;

let tip: HTMLDivElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;

/** Elements whose `title` we have already taken over. */
const text = (el: HTMLElement): string => el.getAttribute('data-tip') ?? '';

function adopt(el: HTMLElement): string {
  const title = el.getAttribute('title');
  if (title !== null) {
    el.setAttribute('data-tip', title);
    el.removeAttribute('title');
  }
  return text(el);
}

function host(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  return tip;
}

function hide(): void {
  clearTimeout(timer);
  current = null;
  if (tip) tip.classList.remove('on');
}

function show(el: HTMLElement): void {
  const body = adopt(el);
  if (!body) return;

  const t = host();
  // "Fit the document to the canvas" stays prose; "Select (V)" gets a key cap.
  const m = /^(.*?)\s*\(([^()]{1,14})\)$/.exec(body);
  t.replaceChildren();
  const label = document.createElement('span');
  label.textContent = m ? m[1] : body;
  t.append(label);
  if (m) {
    const key = document.createElement('kbd');
    key.textContent = m[2];
    t.append(key);
  }

  // Measured after the content is in, so the clamp uses the real width.
  t.classList.add('on');
  const r = el.getBoundingClientRect();
  const box = t.getBoundingClientRect();
  const below = r.top < window.innerHeight / 2;

  const x = Math.max(
    GAP,
    Math.min(r.left + r.width / 2 - box.width / 2, window.innerWidth - box.width - GAP),
  );
  const y = below ? r.bottom + GAP : r.top - box.height - GAP;

  t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function over(e: Event): void {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[title], [data-tip]');
  if (!el || el === current) return;
  hide();
  current = el;
  // Focus is deliberate, so it shows at once; a hover might just be the pointer
  // crossing the strip on its way somewhere else.
  const wait = e.type === 'focusin' ? 0 : DELAY;
  timer = window.setTimeout(() => show(el), wait);
}

function out(e: Event): void {
  const to = (e as PointerEvent).relatedTarget as Node | null;
  if (current && to && current.contains(to)) return;
  hide();
}

/** Start listening. Idempotent enough to call once from the wiring. */
export function installTooltips(): void {
  document.addEventListener('pointerover', over);
  document.addEventListener('pointerout', out);
  document.addEventListener('focusin', over);
  document.addEventListener('focusout', hide);
  // Anything that moves the page or starts an interaction invalidates the
  // position, and a tooltip left hanging over the canvas is worse than none.
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
}
