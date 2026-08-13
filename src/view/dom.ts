/**
 * Tiny SVG DOM helpers.
 *
 * The overlay redraws on every pointermove, so the cost that matters is not
 * setting attributes -- it is creating and destroying elements. `Pool` keeps
 * the elements it has already made and hides the surplus instead, which turns
 * a redraw into a run of attribute writes on a stable set of nodes.
 */

export const NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

export function setAttrs(el: Element, attrs: Record<string, string | number>): void {
  for (const k in attrs) {
    const v = String(attrs[k]);
    // Reading before writing avoids invalidating style/layout for no change,
    // which matters when most attributes are unchanged between frames.
    if (el.getAttribute(k) !== v) el.setAttribute(k, v);
  }
}

/** Reusable pool of one element type under one parent. */
export class Pool<K extends keyof SVGElementTagNameMap> {
  private items: SVGElementTagNameMap[K][] = [];
  private used = 0;

  constructor(
    private parent: SVGElement,
    private tag: K,
  ) {}

  /** Start a frame. */
  begin(): void {
    this.used = 0;
  }

  /** Take the next element, creating one only if the pool is exhausted. */
  next(attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
    let el = this.items[this.used];
    if (!el) {
      el = svg(this.tag);
      this.items.push(el);
      this.parent.appendChild(el);
    }
    if (el.getAttribute('display') === 'none') el.removeAttribute('display');
    if (attrs) setAttrs(el, attrs);
    this.used++;
    return el;
  }

  /** Finish a frame, parking anything left over. */
  end(): void {
    for (let i = this.used; i < this.items.length; i++) {
      this.items[i].setAttribute('display', 'none');
    }
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
  }
  for (const c of children) node.append(c);
  return node;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;
