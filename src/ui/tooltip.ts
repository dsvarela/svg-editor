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
const TIP_ID = 'tip-layer';

let tip: HTMLDivElement | null = null;
let timer = 0;
let current: HTMLElement | null = null;
/**
 * Whether the thing showing is showing because of focus or because of a hover.
 *
 * They want opposite things when the page scrolls. A hover tooltip is anchored
 * to something the pointer was over, and after a scroll the pointer is over
 * something else, so it goes. A focus tooltip is anchored to the focused
 * element, which is still focused and still correct, so it follows.
 */
let byFocus = false;
/* Five of the six listeners below are named functions, which the DOM dedupes on
   a repeat call; the keydown one was an arrow and leaked one per call. Guarding
   the whole thing is simpler than remembering which is which. */
let installed = false;

/** The adopted text, which is where every reader gets it from once adopted. */
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
    tip.id = TIP_ID;
    tip.setAttribute('role', 'tooltip');
    // Hidden from the accessibility tree until it describes something. A
    // permanently exposed `role="tooltip"` node holding the last thing anyone
    // hovered is worse than no tooltip: it is read out attached to nothing.
    tip.setAttribute('aria-hidden', 'true');
    document.body.append(tip);
  }
  return tip;
}

function hide(): void {
  clearTimeout(timer);
  // Removing `title` took away each control's accessible description and put
  // nothing back, so a screen reader lost the modifier hints entirely. The
  // description is restored by pointing the control at the live tip while it is
  // shown, and released again here.
  current?.removeAttribute('aria-describedby');
  current = null;
  if (tip) {
    tip.classList.remove('on');
    tip.setAttribute('aria-hidden', 'true');
  }
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
  t.setAttribute('aria-hidden', 'false');
  el.setAttribute('aria-describedby', TIP_ID);
  place(el);
}

/** Put the tooltip beside its element. Split out so a scroll can redo it. */
function place(el: HTMLElement): void {
  const t = host();
  const r = el.getBoundingClientRect();
  const box = t.getBoundingClientRect();
  const below = r.top < window.innerHeight / 2;

  const x = Math.max(
    GAP,
    Math.min(r.left + r.width / 2 - box.width / 2, window.innerWidth - box.width - GAP),
  );
  // Clamped on both axes. Only x was, so a tall tip above a control near the
  // top of a short window went off the top of the screen.
  const y = Math.max(
    GAP,
    Math.min(below ? r.bottom + GAP : r.top - box.height - GAP, window.innerHeight - box.height - GAP),
  );

  t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

/**
 * Which element a tooltip is about.
 *
 * Normally the nearest ancestor carrying a title. The exception is a label and
 * its control, which are one thing to a person and two to the DOM: a title on
 * either belongs to the **control**, because that is what takes focus and what
 * `aria-describedby` has to be set on for a screen reader to read the
 * description out. A title on the wrapping `<label>` alone described the words
 * next to the checkbox and left the checkbox itself with a name and nothing
 * else -- so the only explanation of what "Pixel fit" means was available to a
 * mouse and to nobody else.
 *
 * Resolving through the label also means hovering the words still works once
 * the title has moved onto the input, which is where it belongs.
 */
function tipTarget(from: HTMLElement): HTMLElement | null {
  const control = from.closest('label')?.control as HTMLElement | null | undefined;
  if (control && (control.hasAttribute('title') || control.hasAttribute('data-tip'))) {
    return control;
  }
  return from.closest<HTMLElement>('[title], [data-tip]');
}

/**
 * A scroll moved the page under the tooltip.
 *
 * Hiding outright is what this used to do, and it broke the keyboard case
 * outright: focusing a control that is below the fold scrolls the panel to
 * bring it into view, and that scroll arrived before the tooltip's own timer
 * fired -- so tabbing through a panel showed a tooltip for whatever happened to
 * be on screen already and nothing for anything else. Which is most of it.
 *
 * A focus tooltip follows instead, because its anchor is still focused and
 * still where the description belongs.
 */
function onScroll(): void {
  if (byFocus && current && current === document.activeElement) {
    if (tip?.classList.contains('on')) place(current);
    return;
  }
  hide();
}

function over(e: Event): void {
  const from = e.target as HTMLElement | null;
  const el = from ? tipTarget(from) : null;
  if (!el || el === current) return;
  hide();
  current = el;
  // Focus is deliberate, so it shows at once; a hover might just be the pointer
  // crossing the strip on its way somewhere else.
  byFocus = e.type === 'focusin';
  const wait = byFocus ? 0 : DELAY;
  timer = window.setTimeout(() => show(el), wait);
}

function out(e: Event): void {
  // Only the element being described can dismiss its own tooltip. This fired on
  // any pointerout anywhere, so moving the mouse across the canvas closed a
  // tooltip that the keyboard had opened on the far side of the window.
  const from = e.target as Node | null;
  if (!current || !from || !current.contains(from)) return;
  const to = (e as PointerEvent).relatedTarget as Node | null;
  if (to && current.contains(to)) return;
  hide();
}

/** Start listening. Safe to call more than once. */
export function installTooltips(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerover', over);
  document.addEventListener('pointerout', out);
  document.addEventListener('focusin', over);
  document.addEventListener('focusout', hide);
  // Anything that moves the page or starts an interaction invalidates the
  // position, and a tooltip left hanging over the canvas is worse than none.
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
}
