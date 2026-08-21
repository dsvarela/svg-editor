/**
 * The two rulers, and the guides they produce.
 *
 * A ruler does two things and the second one is the reason it exists here. It
 * says where the camera is in document coordinates, which the grid readout and
 * the pointer coordinates only half answer; and it is the surface you drag a
 * guide out of, which is the one gesture in this editor with nowhere else to
 * live.
 *
 * Drawn in screen pixels rather than document units, unlike everything in the
 * overlay. A ruler is furniture: its ticks are 4 px long at every zoom and its
 * numbers stay the same size, so a viewBox in document units would need every
 * length divided back out again. The conversion the other way -- document
 * coordinate to pixel along the strip -- is one multiply, and it is the only
 * arithmetic here.
 */

import { setAttrs, svg } from './dom';
import { rulerTicksFor } from './viewport';
import type { ViewBox } from '../core/types';

/** Tick length in pixels, and how much longer a labelled one is. */
const TICK = 4;
const LABEL_TICK = 7;

export class Rulers {
  private hTicks: SVGPathElement;
  private vTicks: SVGPathElement;
  private hNums: SVGGElement;
  private vNums: SVGGElement;
  private hAt: SVGLineElement;
  private vAt: SVGLineElement;

  constructor(
    readonly h: SVGSVGElement,
    readonly v: SVGSVGElement,
  ) {
    this.hTicks = svg('path', { class: 'tick' });
    this.vTicks = svg('path', { class: 'tick' });
    this.hNums = svg('g');
    this.vNums = svg('g');
    this.hAt = svg('line', { class: 'at' });
    this.vAt = svg('line', { class: 'at' });
    h.append(this.hTicks, this.hNums, this.hAt);
    v.append(this.vTicks, this.vNums, this.vAt);
  }

  /**
   * Redraw both strips.
   *
   * `at` is the pointer in document coordinates, or null when it is not over
   * the canvas. The mark it leaves is what makes a ruler worth the space: the
   * coordinate readout says where the pointer is as a number, and this says
   * where it is against the drawing.
   */
  render(camera: ViewBox, snapStep: number, at: [number, number] | null): void {
    const hb = this.h.getBoundingClientRect();
    const vb = this.v.getBoundingClientRect();
    // The strips run along the stage, so the along-axis length is the stage's,
    // and the across-axis is the ruler's own thickness.
    this.paint(this.h, this.hTicks, this.hNums, this.hAt, 'x', camera, snapStep, hb.width, hb.height, at?.[0] ?? null);
    this.paint(this.v, this.vTicks, this.vNums, this.vAt, 'y', camera, snapStep, vb.height, vb.width, at?.[1] ?? null);
  }

  private paint(
    root: SVGSVGElement,
    ticks: SVGPathElement,
    nums: SVGGElement,
    mark: SVGLineElement,
    axis: 'x' | 'y',
    camera: ViewBox,
    snapStep: number,
    along: number,
    across: number,
    at: number | null,
  ): void {
    // A viewBox in pixels, so everything below is drawn in the units it is
    // measured in and nothing has to be divided by the zoom.
    setAttrs(root, {
      viewBox: axis === 'x' ? `0 0 ${along} ${across}` : `0 0 ${across} ${along}`,
      preserveAspectRatio: 'none',
    });

    const span = axis === 'x' ? camera.w : camera.h;
    const origin = axis === 'x' ? camera.x : camera.y;
    const perDoc = along > 0 && span > 0 ? along / span : 0;
    const toPx = (v: number): number => (v - origin) * perDoc;

    const t = perDoc > 0 ? rulerTicksFor(snapStep, span, along) : null;
    if (!t) {
      ticks.setAttribute('d', '');
      nums.replaceChildren();
      mark.setAttribute('display', 'none');
      return;
    }

    /* Indexed by whole multiples of the step rather than accumulated, for the
       reason the grid does the same: `i % labelEvery` is then exact integer
       arithmetic and the labelled ticks cannot drift off the origin at odd
       zoom levels. */
    const i0 = Math.ceil(origin / t.step);
    const i1 = Math.floor((origin + span) / t.step);
    const d: string[] = [];
    const labels: SVGElement[] = [];

    // A cap on a ruler that has gone wrong, not a limit on a legitimate one:
    // `rulerTicksFor` keeps ticks at least 9 px apart, so a 4000 px strip can
    // hold about 440.
    for (let i = i0; i <= i1 && d.length < 2000; i++) {
      const v = i * t.step;
      const px = toPx(v);
      const labelled = i % t.labelEvery === 0;
      const len = labelled ? LABEL_TICK : TICK;
      d.push(
        axis === 'x'
          ? `M${px.toFixed(2)} ${across}V${across - len}`
          : `M${across} ${px.toFixed(2)}H${across - len}`,
      );
      if (!labelled) continue;

      /* Rounded to the step's own precision, which `rulerTicksFor` works out
         beside the step it chose. A camera at an awkward zoom puts the label at
         12.000000000000002, and a ruler that cannot spell its own numbers is
         worse than no ruler. */
      const text = svg('text', { class: 'num' }) as SVGTextElement;
      text.textContent = v.toFixed(t.decimals);
      if (axis === 'x') {
        setAttrs(text, { x: px + 2, y: across - LABEL_TICK - 2 });
      } else {
        /* Rotated a quarter turn, so a vertical ruler reads bottom-to-top the
           way every other editor's does. Written as a transform about the
           label's own position rather than a rotated ruler, so the ticks stay
           axis-aligned and crisp. */
        setAttrs(text, {
          x: 0,
          y: 0,
          transform: `translate(${across - LABEL_TICK - 2} ${px + 2}) rotate(-90)`,
        });
      }
      labels.push(text);
    }

    ticks.setAttribute('d', d.join(''));
    nums.replaceChildren(...labels);

    if (at === null) {
      mark.setAttribute('display', 'none');
      return;
    }
    const px = toPx(at);
    mark.removeAttribute('display');
    setAttrs(
      mark,
      axis === 'x'
        ? { x1: px, y1: 0, x2: px, y2: across }
        : { x1: 0, y1: px, x2: across, y2: px },
    );
  }
}
