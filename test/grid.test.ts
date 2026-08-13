/**
 * @vitest-environment jsdom
 *
 * The grid you see must be the grid you snap to.
 *
 * These exist because the two are computed by different code. If the canvas
 * draws an adaptive decade step derived from zoom while the tools snap to the
 * user's fixed step, the visible lattice and the reachable one differ at most
 * zoom levels, and nothing announces it. The contract asserted here is
 * one-directional and exact -- *every drawn line is a snap position*.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gridDisplayFor, rulerTicksFor } from '../src/view/viewport';
import { Canvas } from '../src/view/canvas';
import { Store } from '../src/model/store';
import { emptyDoc } from '../src/model/doc';
import type { ViewBox } from '../src/core/types';

const WIDTH = 800;
const MIN_PX = 9;

/** A camera `w` units wide, aspect ignored -- only the x axis drives the step. */
const cam = (w: number, x = 0, y = 0): ViewBox => ({ x, y, w, h: (w * 600) / WIDTH });

/** Zooms spanning six orders of magnitude, plus awkward non-round widths. */
const WIDTHS = [
  0.05, 0.1, 0.37, 1, 2.5, 8, 10, 33, 80, 100, 250, 1000, 4096, 10_000, 123_456, 1_000_000,
];
const STEPS = [0.05, 0.1, 0.25, 0.3, 1, 2, 2.5, 5, 10];

describe('gridDisplayFor', () => {
  it('always draws a whole multiple of the snap step', () => {
    for (const step of STEPS) {
      for (const w of WIDTHS) {
        const g = gridDisplayFor(step, cam(w), WIDTH, MIN_PX)!;
        expect(g).not.toBeNull();
        // The multiplier is what makes every line snappable. A fractional one
        // would put lines between snap positions, which is the old bug.
        expect(g.multiple).toBe(Math.round(g.multiple));
        expect(g.step / step).toBeCloseTo(g.multiple, 9);
      }
    }
  });

  it('never subdivides below the snap step', () => {
    // Zooming in far enough that a single snap step is enormous on screen must
    // leave the grid sparse rather than inventing lines you cannot land on.
    for (const step of STEPS) {
      const g = gridDisplayFor(step, cam(step / 1000), WIDTH, MIN_PX)!;
      expect(g.multiple).toBe(1);
      expect(g.step).toBeCloseTo(step, 12);
    }
  });

  it('keeps lines at least minPx apart, which is why it thins at all', () => {
    for (const step of STEPS) {
      for (const w of WIDTHS) {
        const g = gridDisplayFor(step, cam(w), WIDTH, MIN_PX)!;
        const px = (g.step / w) * WIDTH;
        // Multiple 1 is the floor: below it we would have to break the contract
        // above, and a sparse-but-honest grid is the better trade.
        if (g.multiple > 1) expect(px).toBeGreaterThanOrEqual(MIN_PX - 1e-9);
      }
    }
  });

  it('is monotonic: zooming out never gives a finer grid', () => {
    for (const step of STEPS) {
      let prev = 0;
      for (const w of WIDTHS) {
        const g = gridDisplayFor(step, cam(w), WIDTH, MIN_PX)!;
        expect(g.step).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = g.step;
      }
    }
  });

  it('picks tidy multipliers rather than arbitrary ones', () => {
    const seen = new Set<number>();
    for (const w of WIDTHS) seen.add(gridDisplayFor(1, cam(w), WIDTH, MIN_PX)!.multiple);
    for (const m of seen) {
      const mantissa = m / Math.pow(10, Math.floor(Math.log10(m) + 1e-12));
      expect([1, 2, 5]).toContain(Math.round(mantissa));
    }
  });

  it('declines to draw anything when there is no lattice', () => {
    // Step 0 is how the UI turns snapping off. There is then no honest grid.
    expect(gridDisplayFor(0, cam(80), WIDTH)).toBeNull();
    expect(gridDisplayFor(-1, cam(80), WIDTH)).toBeNull();
    // Before first layout the element has no width, so nothing can be sized.
    expect(gridDisplayFor(1, cam(80), 0)).toBeNull();
  });
});

/* ------------------------------------------------------- through the canvas */

function canvasHarness() {
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0, y: 0, left: 0, top: 0, right: WIDTH, bottom: 600,
      width: WIDTH, height: 600, toJSON: () => ({}),
    }),
  });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 0; });

  const root = document.createElement('div');
  document.body.append(root);
  const doc = emptyDoc();
  const store = new Store(doc);
  const canvas = new Canvas(root);
  return { store, canvas, root };
}

/** The x coordinates of every vertical gridline currently drawn. */
function drawnVerticals(root: HTMLElement): number[] {
  const out: number[] = [];
  for (const cls of ['grid-minor', 'grid-major']) {
    const d = root.querySelector(`.${cls}`)?.getAttribute('d') ?? '';
    for (const m of d.matchAll(/M(-?[\d.e-]+) [-\d.e]+V/g)) out.push(Number(m[1]));
  }
  return out;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the rendered grid', () => {
  it('puts every line on a snap position, at every zoom', () => {
    const h = canvasHarness();

    for (const step of [0.25, 0.3, 1, 2.5]) {
      for (const w of [1, 10, 80, 1000, 50_000]) {
        h.store.update((s) => {
          s.gridStep = step;
          s.camera = cam(w, -w / 3, -w / 7); // deliberately off-origin
        });
        h.canvas.setCamera(h.store.state.camera);
        h.canvas.renderOverlay(h.store.state);

        const xs = drawnVerticals(h.root);
        expect(xs.length).toBeGreaterThan(0);
        for (const x of xs) {
          const k = x / step;
          // This is the assertion the whole feature exists for.
          expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('draws nothing but axes when the step is off', () => {
    const h = canvasHarness();
    h.store.update((s) => {
      s.gridStep = 0;
      s.camera = cam(80);
    });
    h.canvas.setCamera(h.store.state.camera);
    h.canvas.renderOverlay(h.store.state);

    expect(h.root.querySelector('.grid-minor')?.getAttribute('d')).toBe('');
    expect(h.root.querySelector('.grid-major')?.getAttribute('d')).toBe('');
    // The axes are coordinates, not a claim about snapping, so they stay.
    expect(h.root.querySelector('.grid-axis')?.getAttribute('d')).toContain('M');
  });

  it('anchors major lines on the origin', () => {
    const h = canvasHarness();
    h.store.update((s) => {
      s.gridStep = 1;
      s.camera = cam(80, -40, -30);
    });
    h.canvas.setCamera(h.store.state.camera);
    h.canvas.renderOverlay(h.store.state);

    const d = h.root.querySelector('.grid-major')?.getAttribute('d') ?? '';
    const xs = [...d.matchAll(/M(-?[\d.e-]+) [-\d.e]+V/g)].map((m) => Number(m[1]));
    expect(xs).toContain(0);
    // A major line off the origin would make the axes look arbitrary.
    const every = gridDisplayFor(1, cam(80), WIDTH)!;
    for (const x of xs) expect(x % (every.step * every.majorEvery)).toBeCloseTo(0, 9);
  });

  it('bounds the line count regardless of how far out you zoom', () => {
    const h = canvasHarness();
    h.store.update((s) => {
      s.gridStep = 0.05;
      s.camera = cam(1e7);
    });
    h.canvas.setCamera(h.store.state.camera);
    h.canvas.renderOverlay(h.store.state);

    // Without the thinning this would be 200 million lines in one `d`.
    expect(drawnVerticals(h.root).length).toBeLessThan(WIDTH / MIN_PX + 2);
  });
});

describe('rulerTicksFor', () => {
  /* A ruler is a measurement scale, not a claim about snapping. That is what
     lets it exist with no grid, and it is also why it borrows the grid's step
     when there is one: numbers along the edge that fall between the lines drawn
     across the canvas would be two scales on one screen. */
  const cam = (w: number): ViewBox => ({ x: 0, y: 0, w, h: w });

  /* A snap step of 3, deliberately. On a step of 1 the grid's answer and the
     bare ladder's agree at every zoom, so a test written at 1 passes whether or
     not the grid is consulted at all. Three is not on the 1-2-5 ladder, so the
     two disagree and the assertion has something to say. */
  it('borrows the grid, so ticks land on lines that are drawn', () => {
    const g = gridDisplayFor(3, cam(100), 1000);
    const t = rulerTicksFor(3, 100, 1000);
    expect(g).not.toBeNull();
    expect(t).toEqual({ step: g!.step, labelEvery: g!.majorEvery });
    // And it is the grid's answer, not the ladder's, which would be 1.
    expect(t!.step).toBe(3);
  });

  it('agrees with the grid after it thins, not just at one zoom', () => {
    // Zoomed out far enough that the grid is drawing every 10th snap position.
    const g = gridDisplayFor(3, cam(4000), 1000);
    const t = rulerTicksFor(3, 4000, 1000);
    expect(g!.multiple).toBeGreaterThan(1);
    expect(t!.step).toBe(g!.step);
    expect(t!.step).toBe(60);
  });

  it('measures each axis against its own span', () => {
    /* The vertical ruler is shorter than the horizontal one and looks at less
       of the document, and the two cancel: both strips tick at the same step,
       because the scale is uniform. A version reading `camera.w` for both was
       out by the aspect ratio, and the ladder hid it at most zooms -- on a 1290
       by 772 stage the first camera width where they part is 129. */
    const scale = 129 / 1290;
    expect(rulerTicksFor(1, 129, 1290)!.step).toBe(rulerTicksFor(1, 772 * scale, 772)!.step);
  });

  it('still ticks when there is no grid at all', () => {
    /* The case that separates the two functions. `gridDisplayFor` returns null
       with no snap step, because there is no honest lattice to draw; a ruler
       has numbers either way, the same position the axes take. */
    expect(gridDisplayFor(0, cam(100), 1000)).toBeNull();
    const t = rulerTicksFor(0, 100, 1000);
    expect(t).not.toBeNull();
    expect(t!.step).toBeGreaterThan(0);
    expect(t!.labelEvery).toBeGreaterThan(1);
  });

  it('keeps ticks apart at the width it is given', () => {
    // The reason for the ladder: at 100 units across 1000 px a tick every 0.1
    // would be one pixel apart and the strip would be a grey bar.
    for (const w of [10, 100, 4000, 1e6]) {
      const t = rulerTicksFor(0, w, 800)!;
      expect((t.step / w) * 800).toBeGreaterThanOrEqual(9);
    }
  });

  it('refuses when there is nothing measured to draw on', () => {
    expect(rulerTicksFor(1, 100, 0)).toBeNull();
    expect(rulerTicksFor(1, 0, 1000)).toBeNull();
  });
});
