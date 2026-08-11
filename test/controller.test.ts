/**
 * @vitest-environment jsdom
 *
 * Interaction tests. jsdom has no SVG layout engine, so `getScreenCTM` and
 * `getBoundingClientRect` are stubbed with a fixed, known mapping -- that is
 * enough to drive real pointer events through the controller and assert what
 * happens to the document.
 *
 * These exist because a crash reached the browser that no unit test could have
 * caught: the pen tool held a shape id across events, and undo deleted the
 * shape underneath it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Canvas } from '../src/view/canvas';
import { Controller } from '../src/tools/controller';
import { Store } from '../src/model/store';
import { emptyDoc, shapeFromPath } from '../src/model/doc';
import { continuityOf } from '../src/core/types';

/** Document units per screen pixel in the stubbed mapping. */
const SCALE = 0.1;
const WIDTH = 800;
const HEIGHT = 600;

/** Minimal stand-ins: jsdom ships neither DOMMatrix nor DOMPoint. */
class FakeMatrix {
  constructor(
    public a: number,
    public b: number,
    public c: number,
    public d: number,
    public e: number,
    public f: number,
  ) {}
  inverse(): FakeMatrix {
    const det = this.a * this.d - this.b * this.c;
    return new FakeMatrix(
      this.d / det,
      -this.b / det,
      -this.c / det,
      this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det,
    );
  }
}

class FakePoint {
  constructor(
    public x: number,
    public y: number,
  ) {}
  matrixTransform(m: FakeMatrix): FakePoint {
    return new FakePoint(m.a * this.x + m.c * this.y + m.e, m.b * this.x + m.d * this.y + m.f);
  }
}

function stubSvgLayout(): void {
  vi.stubGlobal('DOMPoint', FakePoint);
  // A plain scale mapping: doc = client * SCALE.
  Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', {
    configurable: true,
    value: () => new FakeMatrix(1 / SCALE, 0, 0, 1 / SCALE, 0, 0),
  });
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0, y: 0, left: 0, top: 0, right: WIDTH, bottom: HEIGHT,
      width: WIDTH, height: HEIGHT, toJSON: () => ({}),
    }),
  });
  // jsdom implements neither pointer capture nor rAF timing we care about.
  Element.prototype.setPointerCapture = (): void => {};
  Element.prototype.releasePointerCapture = (): void => {};
  Element.prototype.hasPointerCapture = (): boolean => false;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
}

interface Harness {
  store: Store;
  canvas: Canvas;
  controller: Controller;
  down(doc: [number, number], target?: Element, opts?: PointerEventInit): void;
  move(doc: [number, number]): void;
  up(): void;
  key(key: string, opts?: KeyboardEventInit): void;
  anchorEl(shape: string, sp: number, i: number): Element;
}

function harness(pathData?: string): Harness {
  stubSvgLayout();
  const root = document.createElement('div');
  document.body.append(root);

  const doc = emptyDoc();
  doc.viewBox = { x: 0, y: 0, w: WIDTH * SCALE, h: HEIGHT * SCALE };
  if (pathData) doc.shapes.push(shapeFromPath(pathData));

  const store = new Store(doc);
  const canvas = new Canvas(root);
  const controller = new Controller(store, canvas);
  controller.render();

  const ev = (type: string, doc: [number, number], target: Element, opts: PointerEventInit = {}): void => {
    const e = new MouseEvent(type, {
      clientX: doc[0] / SCALE,
      clientY: doc[1] / SCALE,
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'button', { value: opts.button ?? 0 });
    target.dispatchEvent(e);
  };

  return {
    store,
    canvas,
    controller,
    down: (p, target, opts) => ev('pointerdown', p, target ?? canvas.overlay, opts),
    move: (p) => ev('pointermove', p, canvas.overlay),
    up: () => ev('pointerup', [0, 0], canvas.overlay),
    key: (key, opts = {}) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts })),
    anchorEl: (shape, sp, i) => {
      controller.render();
      const el = canvas.overlay.querySelector(
        `[data-hit="anchor"][data-shape="${shape}"][data-sp="${sp}"][data-i="${i}"]`,
      );
      if (!el) throw new Error(`no anchor element for ${shape}/${sp}/${i}`);
      return el;
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('select tool', () => {
  it('selects an anchor from the overlay hit target', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.down([0, 0], h.anchorEl(id, 0, 0));
    expect([...h.store.state.selection.nodes]).toEqual([`${id}/0/0`]);
    h.up();
  });

  it('drags an anchor to a new position', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => (s.snapToGrid = false));

    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.move([5, 7]);
    h.up();

    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([5, 7]);
  });

  it('collapses a drag into a single undo step', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => (s.snapToGrid = false));

    h.down([0, 0], h.anchorEl(id, 0, 0));
    for (let i = 1; i <= 10; i++) h.move([i, i]);
    h.up();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([10, 10]);

    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([0, 0]);
    expect(h.store.canUndo).toBe(false);
  });

  it('snaps a dragged anchor to the grid', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.snapToGrid = true;
      s.gridStep = 5;
      s.snapToPoints = false;
    });

    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.move([6.4, 8.9]);
    h.up();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([5, 10]);
  });

  it('clears the selection when the background is clicked', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.up();
    expect(h.store.state.selection.nodes.size).toBe(1);

    h.down([50, 50]);
    h.up();
    expect(h.store.state.selection.nodes.size).toBe(0);
  });

  it('marquee-selects the nodes inside it', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    h.down([-5, -5]);
    h.move([25, 5]);
    h.up();
    // (0,0) and (20,0) are inside; (20,20) is not.
    expect(h.store.state.selection.nodes.size).toBe(2);
  });

  it('deletes selected nodes with the Delete key', () => {
    const h = harness('M0 0 L20 0 L20 20 L0 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.up();
    h.key('Delete');
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes).toHaveLength(3);
  });
});

describe('pen tool', () => {
  const penHarness = (): Harness => {
    const h = harness();
    h.store.update((s) => {
      s.tool = 'pen';
      s.snapToGrid = false;
      s.snapToPoints = false;
    });
    return h;
  };

  it('creates a shape on the first click', () => {
    const h = penHarness();
    h.down([10, 10]);
    h.up();
    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([10, 10]);
  });

  it('appends nodes on subsequent clicks', () => {
    const h = penHarness();
    h.down([10, 10]); h.up();
    h.down([30, 10]); h.up();
    h.down([30, 30]); h.up();
    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes).toHaveLength(3);
  });

  it('pulls out symmetric handles when a placed node is dragged', () => {
    const h = penHarness();
    h.down([10, 10]); h.up();
    h.down([30, 10]);
    h.move([36, 10]);
    h.up();

    const n = h.store.state.doc.shapes[0].subpaths[0].nodes[1];
    expect(n.hOut).toEqual([36, 10]);
    expect(n.hIn).toEqual([24, 10]);
    expect(continuityOf(n)).toBe('symmetric');
  });

  it('leaves the very first node without an incoming handle', () => {
    const h = penHarness();
    h.down([10, 10]);
    h.move([16, 14]);
    h.up();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].hIn).toBeNull();
  });

  it('closes the subpath when the first node is clicked again', () => {
    const h = penHarness();
    h.down([10, 10]); h.up();
    h.down([30, 10]); h.up();
    h.down([30, 30]); h.up();
    h.down([10, 10]); h.up();

    const sp = h.store.state.doc.shapes[0].subpaths[0];
    expect(sp.closed).toBe(true);
    expect(sp.nodes).toHaveLength(3);
  });

  it('starts a fresh shape after Escape', () => {
    const h = penHarness();
    // Each path needs two nodes to survive; a lone click is discarded on
    // Escape, which is what `discards a pen path abandoned after one click`
    // covers.
    h.down([10, 10]); h.up();
    h.down([30, 10]); h.up();
    h.key('Escape');
    h.down([40, 40]); h.up();
    h.down([60, 40]); h.up();
    h.key('Escape');

    expect(h.store.state.doc.shapes).toHaveLength(2);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes).toHaveLength(2);
    expect(h.store.state.doc.shapes[1].subpaths[0].nodes).toHaveLength(2);
  });

  /* ------------------------------------------------------------------------
   * Regression: the pen holds a shape id between events, and the shape can be
   * removed underneath it. Each of these crashed with
   * "Cannot read properties of undefined (reading 'subpaths')".
   * ---------------------------------------------------------------------- */

  it('survives undo removing the shape it was drawing', () => {
    const h = penHarness();
    h.down([10, 10]); h.up();
    h.down([30, 10]); h.up();

    h.store.undo();
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(0);

    expect(() => {
      h.down([50, 50]);
      h.up();
    }).not.toThrow();
    expect(h.store.state.doc.shapes).toHaveLength(1);
  });

  it('survives the document being replaced wholesale', () => {
    const h = penHarness();
    h.down([10, 10]); h.up();

    // What the source box's Apply button does.
    h.store.edit((s) => {
      s.doc.shapes = [shapeFromPath('M0 0 L5 5')];
    });

    expect(() => {
      h.down([50, 50]);
      h.up();
    }).not.toThrow();
  });

  it('survives its shape being deleted with the select tool', () => {
    const h = penHarness();
    h.down([10, 10]); h.up();
    h.down([30, 10]); h.up();

    h.store.edit((s) => {
      s.doc.shapes = [];
      s.selection.shapes.clear();
      s.selection.nodes.clear();
    });

    expect(() => {
      h.down([50, 50]);
      h.up();
    }).not.toThrow();
  });

  it('leaves no dangling history batch after recovering', () => {
    const h = penHarness();
    h.down([10, 10]); h.up();
    h.store.undo();

    h.down([50, 50]);
    h.up();
    h.down([70, 70]);
    h.up();

    // Each click must still be its own undo step, not fused by a batch that
    // was opened and never closed during the recovery.
    const before = h.store.state.doc.shapes[0].subpaths[0].nodes.length;
    h.store.undo();
    expect(h.store.state.doc.shapes[0]?.subpaths[0].nodes.length ?? 0).toBe(before - 1);
  });
});

describe('camera', () => {
  it('zooms toward the cursor, keeping that point fixed', () => {
    const h = harness('M0 0 L20 0');
    const before = h.store.state.camera;
    const at: [number, number] = [20, 15];

    h.canvas.overlay.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -200,
        clientX: at[0] / SCALE,
        clientY: at[1] / SCALE,
        bubbles: true,
        cancelable: true,
      }),
    );

    const after = h.store.state.camera;
    expect(after.w).toBeLessThan(before.w);
    // The document point under the cursor must not have moved on screen.
    const fracBefore = (at[0] - before.x) / before.w;
    const fracAfter = (at[0] - after.x) / after.w;
    expect(fracAfter).toBeCloseTo(fracBefore, 9);
  });
});
