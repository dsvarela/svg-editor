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
import { docBBox, emptyDoc, emptySelection, makeShape, shapeBBox, shapeFromPath } from '../src/model/doc';
import { serialisePath } from '../src/core/serialise';
import { exportSvg } from '../src/io/svg';
import { cubicAt } from '../src/core/bezier';
import { continuityOf, makeNode, segmentAsCubic, segmentCount } from '../src/core/types';

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
  move(doc: [number, number], opts?: PointerEventInit): void;
  up(): void;
  key(key: string, opts?: KeyboardEventInit): void;
  anchorEl(shape: string, sp: number, i: number): Element;
  outlineEl(shape: string): Element;
  /** A transform handle, with the document point at its centre. */
  gripEl(hit: 'scale' | 'rotate', part: string): { el: Element; at: [number, number] };
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
    move: (p, opts) => ev('pointermove', p, canvas.overlay, opts),
    up: () => ev('pointerup', [0, 0], canvas.overlay),
    key: (key, opts = {}) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts })),
    outlineEl: (shape) => {
      controller.render();
      const el = canvas.overlay.querySelector(`[data-hit="outline"][data-shape="${shape}"]`);
      if (!el) throw new Error(`no outline element for ${shape}`);
      return el;
    },
    gripEl: (hit, part) => {
      controller.render();
      const el = canvas.overlay.querySelector(`[data-hit="${hit}"][data-part="${part}"]`);
      if (!el || el.getAttribute('display') === 'none') {
        throw new Error(`no ${hit} handle for ${part}`);
      }
      const num = (name: string): number => Number(el.getAttribute(name));
      return { el, at: [num('x') + num('width') / 2, num('y') + num('height') / 2] };
    },
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

/**
 * Dense samples along every segment of the first shape, in order.
 *
 * For asking "did the drawing move?" rather than "did the node list change?".
 * The two are not the same question: a break rewrites the node list by design,
 * and the whole point is that the curve underneath it does not move.
 */
function samplePath(h: Harness, per = 16): [number, number][] {
  const out: [number, number][] = [];
  for (const sp of h.store.state.doc.shapes[0].subpaths) {
    for (let i = 0; i < segmentCount(sp); i++) {
      const c = segmentAsCubic(sp, i);
      for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per) as [number, number]);
    }
  }
  return out;
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

describe('combine', () => {
  /** Two 20x20 squares overlapping in a 10x10 corner, as separate shapes. */
  function twoSquares(): Harness {
    const h = harness('M0 0 H20 V20 H0 Z');
    h.store.state.doc.shapes.push(shapeFromPath('M10 10 H30 V30 H10 Z'));
    h.store.state.doc.shapes[0].name = 'lower';
    h.store.state.doc.shapes[1].name = 'upper';
    return h;
  }

  const selectAll = (h: Harness): void =>
    h.store.update((s) => {
      for (const sh of s.doc.shapes) s.selection.shapes.add(sh.id);
    });

  it('refuses with fewer than two shapes selected', () => {
    const h = twoSquares();
    h.store.update((s) => s.selection.shapes.add(s.doc.shapes[0].id));
    const r = h.controller.booleanSelection('unite');
    expect(r.ok).toBe(false);
    // Crucially, the document is untouched rather than half-combined.
    expect(h.store.state.doc.shapes).toHaveLength(2);
  });

  it('replaces both operands with one shape', () => {
    const h = twoSquares();
    selectAll(h);
    expect(h.controller.booleanSelection('unite').ok).toBe(true);
    expect(h.store.state.doc.shapes).toHaveLength(1);
  });

  it('keeps the first shape identity, so the result inherits its style', () => {
    const h = twoSquares();
    const first = h.store.state.doc.shapes[0];
    const id = first.id;
    first.style.fill = '#ff0000';
    selectAll(h);
    h.controller.booleanSelection('unite');

    const out = h.store.state.doc.shapes[0];
    expect(out.id).toBe(id);
    expect(out.name).toBe('lower');
    expect(out.style.fill).toBe('#ff0000');
    // And it is what stays selected, so the next operation has a target.
    expect([...h.store.state.selection.shapes]).toEqual([id]);
  });

  it('subtracts the later shapes from the first, not the reverse', () => {
    const h = twoSquares();
    selectAll(h);
    h.controller.booleanSelection('subtract');

    // Area alone cannot tell the two directions apart -- both leave 300. The
    // extent can: lower-minus-upper occupies 0..20, the reverse 10..30.
    const box = shapeBBox(h.store.state.doc.shapes[0])!;
    expect([box.x0, box.y0, box.x1, box.y1]).toEqual([0, 0, 20, 20]);
  });

  it('is one undo step', () => {
    const h = twoSquares();
    selectAll(h);
    h.controller.booleanSelection('unite');
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(2);
  });

  it('leaves the document alone when the result is empty', () => {
    const h = harness('M0 0 H10 V10 H0 Z');
    h.store.state.doc.shapes.push(shapeFromPath('M100 100 H110 V110 H100 Z'));
    selectAll(h);

    // Two disjoint squares have no intersection at all.
    const r = h.controller.booleanSelection('intersect');
    expect(r.ok).toBe(false);
    expect(h.store.state.doc.shapes).toHaveLength(2);
    expect(h.store.canUndo).toBe(false);
  });
});

describe('deleting a selection', () => {
  const selectAllNodes = (h: Harness): void =>
    h.store.update((s) => {
      for (const sh of s.doc.shapes) {
        sh.subpaths.forEach((sp, spI) =>
          sp.nodes.forEach((_, i) => s.selection.nodes.add(`${sh.id}/${spI}/${i}`)),
        );
      }
    });

  it('removes a closed shape when every node is selected', () => {
    // The reported bug: the marquee selected all four, delete left three.
    const h = harness('M0 0 H20 V20 H0 Z');
    selectAllNodes(h);
    expect(h.store.state.selection.nodes.size).toBe(4);

    h.controller.deleteSelection();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('removes an open path when every node is selected', () => {
    const h = harness('M0 0 L20 0 L20 20');
    selectAllNodes(h);
    h.controller.deleteSelection();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('clears several shapes at once', () => {
    const h = harness('M0 0 H20 V20 H0 Z');
    h.store.state.doc.shapes.push(shapeFromPath('M40 40 L60 40 L60 60 Z'));
    selectAllNodes(h);
    h.controller.deleteSelection();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('drops only the fully-selected subpath of a multi-subpath shape', () => {
    const h = harness('M0 0 H20 V20 H0 Z M40 40 H60 V60 H40 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      for (let i = 0; i < 4; i++) s.selection.nodes.add(`${id}/1/${i}`);
    });

    h.controller.deleteSelection();
    const sh = h.store.state.doc.shapes[0];
    expect(sh.subpaths).toHaveLength(1);
    expect(sh.subpaths[0].nodes[0].pt).toEqual([0, 0]);
  });

  it('deletes a partial selection in full, keeping the rest', () => {
    // Two of four on a square. Both go; the square becomes a two-node closed
    // subpath, which draws as a line. The old floor deleted one and kept one.
    const h = harness('M0 0 H20 V20 H0 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(`${id}/0/0`);
      s.selection.nodes.add(`${id}/0/1`);
    });

    const r = h.controller.deleteSelection();
    expect(r).toEqual({ deleted: 2, blocked: 0 });
    const sp = h.store.state.doc.shapes[0].subpaths[0];
    expect(sp.nodes).toHaveLength(2);
    // The two survivors, unmoved.
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [20, 20],
      [0, 20],
    ]);
  });

  it('reduces a three-node closed path instead of refusing', () => {
    // The reported case: a closed loop of three was exactly at the old floor,
    // so it could not be reduced at all.
    const h = harness('M0 0 L20 0 L10 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${id}/0/2`));

    const r = h.controller.deleteSelection();
    expect(r).toEqual({ deleted: 1, blocked: 0 });
    const sp = h.store.state.doc.shapes[0].subpaths[0];
    expect(sp.nodes).toHaveLength(2);
    // Straight segments both ways round: what is left draws as a line.
    expect(sp.nodes.every((n) => n.hIn === null && n.hOut === null)).toBe(true);
  });

  it('never refuses, whatever it is pointed at', () => {
    for (const d of ['M0 0 L20 0 L10 20 Z', 'M0 0 L20 0', 'M0 0 C5 5 15 5 20 0 Z']) {
      const h = harness(d);
      const id = h.store.state.doc.shapes[0].id;
      // Delete node 0 repeatedly until the shape is gone. It must always
      // terminate, which it cannot if any deletion is refused.
      for (let guard = 0; guard < 10 && h.store.state.doc.shapes.length; guard++) {
        h.store.update((s) => {
          s.selection.nodes.clear();
          s.selection.nodes.add(`${id}/0/0`);
        });
        expect(h.controller.deleteSelection().blocked).toBe(0);
      }
      expect(h.store.state.doc.shapes).toHaveLength(0);
    }
  });

  it('stays silent -- there is nothing left to explain away', () => {
    const h = harness('M0 0 H20 V20 H0 Z');
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);
    selectAllNodes(h);
    h.controller.deleteSelection();
    expect(said).toHaveLength(0);
  });

  it('leaves a pen stroke in progress alone', () => {
    // A one-node subpath is the pen mid-stroke -- the parser never produces one,
    // so it is built here the way the pen does. The old prune dropped every
    // subpath under two nodes across the whole document, so deleting a node in
    // one shape swept up an unrelated stroke someone was still drawing.
    const h = harness('M0 0 H20 V20 H0 Z');
    const square = h.store.state.doc.shapes[0].id;
    h.store.state.doc.shapes.push(makeShape([{ nodes: [makeNode([50, 50])], closed: false }], 'pen'));

    h.store.update((s) => {
      for (let i = 0; i < 4; i++) s.selection.nodes.add(`${square}/0/${i}`);
    });
    h.controller.deleteSelection();

    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([50, 50]);
  });

  it('is one undo step, whole shape or not', () => {
    const h = harness('M0 0 H20 V20 H0 Z');
    selectAllNodes(h);
    h.controller.deleteSelection();
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes).toHaveLength(4);
  });
});

describe('breaking a path', () => {
  const select = (h: Harness, i: number): void =>
    h.store.update((s) => {
      s.selection.nodes.clear();
      s.selection.nodes.add(`${h.store.state.doc.shapes[0].id}/0/${i}`);
    });

  it('splits an open path into two at an interior node', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    select(h, 1);
    expect(h.controller.breakAtSelection()).toBe(true);

    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(2);
    expect(sps[0].nodes.map((n) => n.pt)).toEqual([[0, 0], [10, 0]]);
    expect(sps[1].nodes.map((n) => n.pt)).toEqual([[10, 0], [20, 0], [30, 0]]);
    expect(sps.every((sp) => !sp.closed)).toBe(true);
  });

  it('opens a closed path at the chosen node', () => {
    const h = harness('M0 0 L20 0 L20 20 L0 20 Z');
    select(h, 2);
    h.controller.breakAtSelection();

    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(1);
    expect(sps[0].closed).toBe(false);
    // Starts and ends at the broken node, which is duplicated.
    expect(sps[0].nodes.map((n) => n.pt)).toEqual([
      [20, 20], [0, 20], [0, 0], [20, 0], [20, 20],
    ]);
  });

  it('moves nothing — the drawing is identical either side of a break', () => {
    // Break is the lossless counterpart to delete. Sampling both curves is the
    // check that matters; comparing node lists would pass even if a handle had
    // been dropped, since the anchors would still line up.
    const h = harness('M0 0 C10 -20 30 20 40 0 C50 -20 70 20 80 0');
    const before = samplePath(h);
    select(h, 1);
    h.controller.breakAtSelection();
    const after = samplePath(h);

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1])).toBeLessThan(1e-9);
    }
  });

  it('refuses at an endpoint, where there is no second side', () => {
    const h = harness('M0 0 L10 0 L20 0');
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);

    select(h, 0);
    expect(h.controller.breakAtSelection()).toBe(false);
    select(h, 2);
    expect(h.controller.breakAtSelection()).toBe(false);
    expect(said).toHaveLength(2);
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(1);
  });

  it('needs exactly one node', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    h.store.update((s) => {
      const id = s.doc.shapes[0].id;
      s.selection.nodes.add(`${id}/0/1`);
      s.selection.nodes.add(`${id}/0/2`);
    });
    expect(h.controller.breakAtSelection()).toBe(false);
  });

  it('is one undo step', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    select(h, 1);
    h.controller.breakAtSelection();
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(1);
  });

  it('round-trips through the serialiser as two subpaths', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    select(h, 1);
    h.controller.breakAtSelection();
    const d = serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 3 });
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).not.toContain('Z');
  });
});

describe('delete mode: split', () => {
  const splitHarness = (d: string): Harness => {
    const h = harness(d);
    h.store.update((s) => (s.deleteMode = 'split'));
    return h;
  };
  const select = (h: Harness, ...idx: number[]): void =>
    h.store.update((s) => {
      const id = s.doc.shapes[0].id;
      for (const i of idx) s.selection.nodes.add(`${id}/0/${i}`);
    });

  it('leaves two ends where a middle node was', () => {
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0 L40 0');
    select(h, 2);
    h.controller.deleteSelection();

    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(2);
    expect(sps[0].nodes.map((n) => n.pt)).toEqual([[0, 0], [10, 0]]);
    expect(sps[1].nodes.map((n) => n.pt)).toEqual([[30, 0], [40, 0]]);
  });

  it('opens a closed path rather than keeping it closed', () => {
    // The three-node loop: one node out and what is left is a plain line, which
    // is exactly what fusing would not give you.
    const h = splitHarness('M0 0 L20 0 L10 20 Z');
    select(h, 2);
    h.controller.deleteSelection();

    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(1);
    expect(sps[0].closed).toBe(false);
    expect(sps[0].nodes.map((n) => n.pt)).toEqual([[0, 0], [20, 0]]);
  });

  it('does not move any surviving segment', () => {
    // The whole point of split: nothing is rebuilt, so the curves that remain
    // are bit-for-bit the ones that were there. Fusing cannot promise this.
    const h = splitHarness('M0 0 C10 -20 30 20 40 0 C50 -20 70 20 80 0 C90 -20 110 20 120 0');
    const before = samplePath(h);
    const firstSegment = before.slice(0, 17);

    select(h, 2);
    h.controller.deleteSelection();
    const after = samplePath(h);

    for (let i = 0; i < firstSegment.length; i++) {
      expect(Math.hypot(after[i][0] - firstSegment[i][0], after[i][1] - firstSegment[i][1]))
        .toBeLessThan(1e-12);
    }
  });

  it('drops fragments too small to be a path', () => {
    // Removing node 1 of four leaves node 0 alone on its side. One node has no
    // segments, so there is nothing to keep.
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0');
    select(h, 1);
    h.controller.deleteSelection();

    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(1);
    expect(sps[0].nodes.map((n) => n.pt)).toEqual([[20, 0], [30, 0]]);
  });

  it('handles several cuts in one go', () => {
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0 L40 0 L50 0 L60 0');
    select(h, 2, 4);
    h.controller.deleteSelection();

    // Nodes at x = 0 10 20 30 40 50 60; cutting at 20 and 40 leaves runs of
    // [0 10], [30] and [50 60]. The middle one is a single node, so it goes.
    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps.map((sp) => sp.nodes.map((n) => n.pt[0]))).toEqual([
      [0, 10],
      [50, 60],
    ]);
  });

  it('still removes the shape when everything is selected', () => {
    const h = splitHarness('M0 0 H20 V20 H0 Z');
    h.store.update((s) => {
      const id = s.doc.shapes[0].id;
      for (let i = 0; i < 4; i++) s.selection.nodes.add(`${id}/0/${i}`);
    });
    h.controller.deleteSelection();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('is one undo step even when it produces several subpaths', () => {
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0 L40 0');
    select(h, 2);
    h.controller.deleteSelection();
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(2);

    h.store.undo();
    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(1);
    expect(sps[0].nodes).toHaveLength(5);
  });

  it('leaves the mode alone — it is a preference, not a one-shot', () => {
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0 L40 0');
    select(h, 2);
    h.controller.deleteSelection();
    expect(h.store.state.deleteMode).toBe('split');
  });

  it('fuse is still the default', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0 L40 0');
    expect(h.store.state.deleteMode).toBe('fuse');
    select(h, 2);
    h.controller.deleteSelection();
    // One subpath, still connected end to end.
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes).toHaveLength(4);
  });
});

describe('the ellipse and rectangle tools', () => {
  const draw = (h: Harness, tool: 'ellipse' | 'rect', a: [number, number], b: [number, number], opts: PointerEventInit = {}) => {
    h.store.update((s) => (s.tool = tool));
    h.down(a);
    h.move(b, opts);
    h.up();
  };

  it('draws an ellipse inscribed in the drag box', () => {
    const h = harness();
    draw(h, 'ellipse', [10, 10], [30, 20]);

    const sp = h.store.state.doc.shapes[0].subpaths[0];
    expect(sp.closed).toBe(true);
    // Four nodes on the axes of the box: the box is 10..30 by 10..20.
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [30, 15],
      [20, 20],
      [10, 15],
      [20, 10],
    ]);
  });

  it('is round, not merely four-cornered', () => {
    const h = harness();
    draw(h, 'ellipse', [0, 0], [20, 20]);
    // Measured the way the primitive tests do: every sample sits on r = 10.
    for (const p of samplePath(h, 24)) {
      expect(Math.hypot(p[0] - 10, p[1] - 10)).toBeCloseTo(10, 2);
    }
  });

  it('constrains to a circle with Shift, taking the smaller span', () => {
    const h = harness();
    draw(h, 'ellipse', [0, 0], [30, 10], { shiftKey: true });

    const pts = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt);
    // Square box 0..10, so both radii are 5.
    expect(pts).toEqual([
      [10, 5],
      [5, 10],
      [0, 5],
      [5, 0],
    ]);
  });

  it('draws from the centre with Alt', () => {
    const h = harness();
    draw(h, 'ellipse', [20, 20], [30, 25], { altKey: true });

    const pts = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt);
    // The press point is the centre: radii 10 and 5 about (20, 20).
    expect(pts).toEqual([
      [30, 20],
      [20, 25],
      [10, 20],
      [20, 15],
    ]);
  });

  it('leaves nothing behind when the drag never had any area', () => {
    const h = harness();
    h.store.update((s) => (s.tool = 'ellipse'));
    h.down([12, 12]);
    h.move([12, 12]);
    h.up();

    expect(h.store.state.doc.shapes).toHaveLength(0);
    // And no history entry either: there is nothing to undo back to.
    expect(h.store.canUndo).toBe(false);
  });

  it('draws a rectangle as four nodes with no handles at all', () => {
    const h = harness();
    draw(h, 'rect', [4, 6], [14, 12]);

    const sp = h.store.state.doc.shapes[0].subpaths[0];
    expect(sp.nodes.map((n) => n.pt)).toEqual([
      [4, 6],
      [14, 6],
      [14, 12],
      [4, 12],
    ]);
    for (const n of sp.nodes) {
      expect(n.hIn).toBeNull();
      expect(n.hOut).toBeNull();
    }
  });

  it('rounds the corners when the radius is set', () => {
    const h = harness();
    h.store.update((s) => (s.cornerRadius = 2));
    draw(h, 'rect', [0, 0], [20, 10]);

    const sp = h.store.state.doc.shapes[0].subpaths[0];
    expect(sp.nodes).toHaveLength(8);
    expect(sp.nodes[0].pt).toEqual([2, 0]);
    expect(sp.nodes[1].pt).toEqual([18, 0]);
  });

  it('is one undo step however many moves the drag took', () => {
    const h = harness();
    h.store.update((s) => (s.tool = 'ellipse'));
    h.down([0, 0]);
    for (let i = 1; i <= 6; i++) h.move([i * 4, i * 3]);
    h.up();

    expect(h.store.state.doc.shapes).toHaveLength(1);
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('keeps the tool, so several can be drawn in a row', () => {
    const h = harness();
    draw(h, 'rect', [0, 0], [10, 10]);
    draw(h, 'rect', [20, 0], [30, 10]);
    expect(h.store.state.tool).toBe('rect');
    expect(h.store.state.doc.shapes).toHaveLength(2);
  });

  it('selects what it just drew', () => {
    const h = harness();
    draw(h, 'ellipse', [0, 0], [10, 10]);
    const id = h.store.state.doc.shapes[0].id;
    expect([...h.store.state.selection.shapes]).toEqual([id]);
  });
});

describe('circularising', () => {
  it('makes a selected near-circle exact', () => {
    // A square's four corners fit a circle exactly, so this is the clearest
    // case: it becomes the circumscribed circle and every node is on it.
    const h = harness('M0 -10 L10 0 L0 10 L-10 0 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.shapes.add(id));

    expect(h.controller.circulariseSelection()).toBe(true);

    for (const p of samplePath(h, 24)) {
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 1);
    }
  });

  it('works from a node selection, taking the whole contour with it', () => {
    const h = harness('M0 -10 L10 0 L0 10 L-10 0 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${id}/0/1`));

    expect(h.controller.circulariseSelection()).toBe(true);
    // Every node moved onto the circle, not just the selected one.
    for (const n of h.store.state.doc.shapes[0].subpaths[0].nodes) {
      expect(Math.hypot(n.pt[0], n.pt[1])).toBeCloseTo(10, 6);
    }
  });

  it('refuses a straight line and says so', () => {
    const h = harness('M0 0 L10 10 L20 20');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.shapes.add(id));

    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);
    expect(h.controller.circulariseSelection()).toBe(false);
    expect(said.join(' ')).toMatch(/collinear/i);
  });

  it('refuses with nothing selected', () => {
    const h = harness('M0 -10 L10 0 L0 10 L-10 0 Z');
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);
    expect(h.controller.circulariseSelection()).toBe(false);
    expect(said.join(' ')).toMatch(/select/i);
  });

  it('is one undo step', () => {
    const h = harness('M0 -10 L10 0 L0 10 L-10 0 Z');
    const before = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));
    h.controller.circulariseSelection();
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt])).toEqual(before);
  });
});

describe('a press that never becomes a drag', () => {
  it('leaves the redo stack alone', () => {
    /* Every drag used to checkpoint on pointerdown, before it knew whether the
       gesture would change anything, and `checkpoint` clears the redo stack. So
       one stray click on a node threw away everything you could have redone.
       This is the failure `tryEdit` was written to stop, applied to buttons and
       never to drags. The checkpoint now happens on the first real mutation. */
    const h = harness('M10 10 L40 10 L40 30 Z');
    h.store.edit((s) => (s.doc.shapes[0].name = 'edited'));
    h.store.undo();
    expect(h.store.canRedo).toBe(true);

    const id = h.store.state.doc.shapes[0].id;
    h.down([10, 10], h.anchorEl(id, 0, 0));
    h.up();

    expect(h.store.canRedo).toBe(true);
    expect(h.store.canUndo).toBe(false);
  });

  it('records nothing at all, so the next undo is the real one', () => {
    const h = harness('M10 10 L40 10 L40 30 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.edit((s) => (s.doc.shapes[0].name = 'first'));

    h.down([10, 10], h.anchorEl(id, 0, 0));
    h.up();
    h.down([40, 10], h.anchorEl(id, 0, 1));
    h.up();

    h.store.undo();
    expect(h.store.state.doc.shapes[0].name).not.toBe('first');
  });

  it('still records one entry when the drag does move something', () => {
    const h = harness('M10 10 L40 10 L40 30 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => (s.snapToGrid = false));

    h.down([10, 10], h.anchorEl(id, 0, 0));
    h.move([15, 12]);
    h.move([20, 14]);
    h.up();

    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).not.toEqual([10, 10]);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([10, 10]);
    expect(h.store.canUndo).toBe(false);
  });
});

describe('rounding corners', () => {
  const square = (): Harness => harness('M0 0 L40 0 L40 40 L0 40 Z');
  const ids = (h: Harness): string => h.store.state.doc.shapes[0].id;

  it('rounds several corners at once, working from the last index back', () => {
    /* Each rounded corner turns one node into two, so every index after it
       shifts. Ascending order rounds the wrong points from the second one on,
       and the failure is quiet: you still get eight nodes. */
    const h = square();
    const id = ids(h);
    h.store.update((s) => {
      s.selection.nodes.add(`${id}/0/0`);
      s.selection.nodes.add(`${id}/0/1`);
      s.selection.nodes.add(`${id}/0/2`);
      s.selection.nodes.add(`${id}/0/3`);
    });

    expect(h.controller.roundSelection(8)).toBe(true);
    const nodes = h.store.state.doc.shapes[0].subpaths[0].nodes;
    expect(nodes.length).toBe(8);
    // Every node sits 8 units in from a corner along one side, never on one.
    for (const n of nodes) {
      const onCorner = [0, 40].includes(n.pt[0]) && [0, 40].includes(n.pt[1]);
      expect(onCorner).toBe(false);
    }
  });

  it('is one undo step and drops the selection', () => {
    const h = square();
    const id = ids(h);
    h.store.update((s) => s.selection.nodes.add(`${id}/0/1`));

    h.controller.roundSelection(6);
    expect(h.store.state.selection.nodes.size).toBe(0);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.length).toBe(4);
    expect(h.store.canUndo).toBe(false);
  });

  it('explains a refusal instead of doing nothing quietly', () => {
    const h = harness('M0 0 L40 0 C50 10 50 30 40 40 L0 40 Z');
    const id = ids(h);
    h.store.update((s) => s.selection.nodes.add(`${id}/0/1`));
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);

    expect(h.controller.roundSelection(5)).toBe(false);
    expect(said.join(' ')).toMatch(/straight segment on both sides/i);
    expect(h.store.canUndo).toBe(false);
  });

  it('refuses a radius of zero and an empty selection', () => {
    const h = square();
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);

    expect(h.controller.roundSelection(0)).toBe(false);
    expect(said.join(' ')).toMatch(/above zero/i);

    said.length = 0;
    expect(h.controller.roundSelection(5)).toBe(false);
    expect(said.join(' ')).toMatch(/select/i);
  });

  it('says when the radius was cut down to fit', () => {
    const h = harness('M0 0 L40 0 L40 6 L0 6 Z');
    const id = ids(h);
    h.store.update((s) => s.selection.nodes.add(`${id}/0/1`));
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);

    expect(h.controller.roundSelection(30)).toBe(true);
    expect(said.join(' ')).toMatch(/clamped/i);
  });
});

describe('style', () => {
  it('restyles the selected shapes in one undo step', () => {
    const h = harness('M0 0 L10 0 L10 10 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.shapes.add(id));

    h.controller.setStyle({ fill: '#ff0000' });
    h.controller.setStyle({ strokeWidth: 3 });
    expect(h.store.state.doc.shapes[0].style.fill).toBe('#ff0000');
    expect(h.store.state.doc.shapes[0].style.strokeWidth).toBe(3);

    h.store.undo();
    expect(h.store.state.doc.shapes[0].style.strokeWidth).not.toBe(3);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].style.fill).not.toBe('#ff0000');
  });

  it('follows a node selection to the shape that owns it', () => {
    // Style is a property of the whole path in SVG, so there is no smaller
    // thing a node selection could change.
    const h = harness('M0 0 L10 0 L10 10 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${id}/0/1`));

    h.controller.setStyle({ stroke: '#00ff00' });
    expect(h.store.state.doc.shapes[0].style.stroke).toBe('#00ff00');
  });

  it('sets what the next shape will look like when nothing is selected', () => {
    const h = harness('M0 0 L10 0 L10 10 Z');
    h.controller.setStyle({ fill: '#0000ff', strokeWidth: 2 });

    // A statement about the future, so it is not an edit and records nothing.
    expect(h.store.canUndo).toBe(false);
    expect(h.store.state.doc.shapes[0].style.fill).not.toBe('#0000ff');
    expect(h.store.state.style.fill).toBe('#0000ff');
  });

  it('gives a newly drawn shape the style that was chosen for it', () => {
    const h = harness();
    h.controller.setStyle({ fill: '#123456', strokeWidth: 4 });

    h.store.update((s) => (s.tool = 'rect'));
    h.down([10, 10]);
    h.move([40, 30]);
    h.up();

    const style = h.store.state.doc.shapes[0].style;
    expect(style.fill).toBe('#123456');
    expect(style.strokeWidth).toBe(4);
  });

  it('records nothing when the selection already looks like that', () => {
    const h = harness('M0 0 L10 0 L10 10 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.shapes.add(id));
    const was = h.store.state.doc.shapes[0].style.stroke;

    expect(h.controller.setStyle({ stroke: was })).toBe(false);
    expect(h.store.canUndo).toBe(false);
  });
});

describe('fitting the canvas to the drawing', () => {
  it('wraps the drawing, rounded outwards to whole grid steps', () => {
    // The shape a user pasted to report this: a drawing in the corner of a
    // canvas nobody chose, exported with a viewBox four times its size.
    const h = harness('M2.8 1 L19.4 1 L19.4 39.3 L2.8 39.3 Z');
    h.store.update((s) => (s.gridStep = 1));

    expect(h.controller.fitCanvasToDrawing()).toBe(true);
    expect(h.store.state.doc.viewBox).toEqual({ x: 2, y: 1, w: 18, h: 39 });
  });

  it('grows the box rather than cropping, whatever the step', () => {
    const h = harness('M2.8 1.2 L19.4 1.2 L19.4 39.3 L2.8 39.3 Z');
    h.store.update((s) => (s.gridStep = 5));
    h.controller.fitCanvasToDrawing();

    const vb = h.store.state.doc.viewBox;
    const b = docBBox(h.store.state.doc)!;
    expect(vb.x).toBeLessThanOrEqual(b.x0);
    expect(vb.y).toBeLessThanOrEqual(b.y0);
    expect(vb.x + vb.w).toBeGreaterThanOrEqual(b.x1);
    expect(vb.y + vb.h).toBeGreaterThanOrEqual(b.y1);
  });

  it('uses the exact extent when there is no grid', () => {
    const h = harness('M2.5 1.5 L19.5 1.5 L19.5 38.5 L2.5 38.5 Z');
    h.store.update((s) => (s.gridStep = 0));
    h.controller.fitCanvasToDrawing();
    expect(h.store.state.doc.viewBox).toEqual({ x: 2.5, y: 1.5, w: 17, h: 37 });
  });

  it('gives a flat drawing a page it can be seen on', () => {
    const h = harness('M4 10 L20 10');
    h.store.update((s) => (s.gridStep = 1));
    h.controller.fitCanvasToDrawing();
    expect(h.store.state.doc.viewBox.h).toBeGreaterThan(0);
  });

  it('declines an empty document, and one that already fits', () => {
    const empty = harness();
    const said: string[] = [];
    empty.controller.onMessage = (m) => said.push(m);
    expect(empty.controller.fitCanvasToDrawing()).toBe(false);
    expect(said.join(' ')).toMatch(/nothing drawn/i);

    const h = harness('M0 0 L10 0 L10 10 L0 10 Z');
    h.store.update((s) => (s.gridStep = 1));
    h.controller.fitCanvasToDrawing();
    expect(h.controller.fitCanvasToDrawing()).toBe(false);
    expect(h.store.canUndo).toBe(true);
  });

  it('is one undo step', () => {
    const h = harness('M2 2 L20 2 L20 30 Z');
    const before = { ...h.store.state.doc.viewBox };
    h.controller.fitCanvasToDrawing();
    expect(h.store.state.doc.viewBox).not.toEqual(before);
    h.store.undo();
    expect(h.store.state.doc.viewBox).toEqual(before);
    // One entry, not two. Its siblings in the simplify and rounding blocks
    // assert this and this one did not, so a stray checkpoint went unnoticed.
    expect(h.store.canUndo).toBe(false);
  });
});

describe('the transform box', () => {
  /** A 40x20 rectangle, selected whole. */
  const rect = (): Harness => {
    const h = harness('M10 5 L50 5 L50 25 L10 25 Z');
    h.store.update((s) => {
      s.selection.shapes.add(s.doc.shapes[0].id);
      s.snapToGrid = false;
    });
    return h;
  };
  const bounds = (h: Harness): [number, number, number, number] => {
    const xs = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt[0]);
    const ys = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };

  it('appears for a selection and not for a bare node', () => {
    const h = rect();
    expect(() => h.gripEl('scale', 'se')).not.toThrow();

    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection = emptySelection();
      s.selection.nodes.add(`${id}/0/0`);
    });
    // One node has no extent, so there is nothing to scale it against.
    expect(() => h.gripEl('scale', 'se')).toThrow();
  });

  it('does not move anything when the handle is grabbed and not dragged', () => {
    /* The handles are drawn outside the true bounds, so the pointer starts
       several pixels away from the corner it is dragging. Without recording
       that difference at the press, the first move would snap the corner to
       the pointer and the shape would jump before it moved. */
    const h = rect();
    const grip = h.gripEl('scale', 'se');
    const before = bounds(h);

    h.down(grip.at, grip.el);
    h.move(grip.at);
    h.up();

    expect(bounds(h)).toEqual(before);
  });

  it('scales about the opposite corner', () => {
    const h = rect();
    const grip = h.gripEl('scale', 'se');
    h.down(grip.at, grip.el);
    h.move([grip.at[0] - 20, grip.at[1]]);
    h.up();

    const [x0, y0, x1, y1] = bounds(h);
    expect(x0).toBeCloseTo(10, 6);
    expect(y0).toBeCloseTo(5, 6);
    expect(x1).toBeCloseTo(30, 6);
    // The east-west drag left the height alone, exactly.
    expect(y1).toBe(25);
  });

  it('holds the centre with Alt', () => {
    const h = rect();
    const grip = h.gripEl('scale', 'se');
    h.down(grip.at, grip.el, { altKey: true });
    h.move([grip.at[0] - 10, grip.at[1]], { altKey: true });
    h.up();

    const [x0, , x1] = bounds(h);
    expect((x0 + x1) / 2).toBeCloseTo(30, 6);
  });

  it('is one undo step, whatever the drag was made of', () => {
    const h = rect();
    const before = bounds(h);
    const grip = h.gripEl('scale', 'se');
    h.down(grip.at, grip.el);
    h.move([grip.at[0] - 5, grip.at[1]]);
    h.move([grip.at[0] - 10, grip.at[1]]);
    h.move([grip.at[0] - 15, grip.at[1]]);
    h.up();
    expect(bounds(h)).not.toEqual(before);

    h.store.undo();
    expect(bounds(h)).toEqual(before);
    expect(h.store.canUndo).toBe(false);
  });

  it('recomputes from the original rather than stacking frame on frame', () => {
    // Out and back again. Composing each frame onto the last would leave the
    // shape a rounding error away from where it started; recomputing from a
    // copy makes the end state depend only on where the pointer stopped.
    const h = rect();
    const before = bounds(h);
    const grip = h.gripEl('scale', 'se');
    h.down(grip.at, grip.el);
    for (const dx of [-15, -30, -8, 12, 0]) h.move([grip.at[0] + dx, grip.at[1]]);
    h.up();
    expect(bounds(h)).toEqual(before);
  });

  it('abandons the drag on Escape', () => {
    const h = rect();
    const before = bounds(h);
    const grip = h.gripEl('scale', 'se');
    h.down(grip.at, grip.el);
    h.move([grip.at[0] - 20, grip.at[1]]);
    h.key('Escape');

    expect(bounds(h)).toEqual(before);
    expect(h.store.canRedo).toBe(false);
  });

  it('snaps the corner to the grid, not the pointer', () => {
    const h = rect();
    h.store.update((s) => {
      s.snapToGrid = true;
      s.gridStep = 5;
    });
    const grip = h.gripEl('scale', 'se');
    h.down(grip.at, grip.el);
    h.move([grip.at[0] - 17.4, grip.at[1] - 2.2]);
    h.up();

    const [, , x1, y1] = bounds(h);
    expect(x1).toBeCloseTo(35, 6);
    expect(y1).toBeCloseTo(25, 6);
  });

  it('rotates about the centre, taking the handles with it', () => {
    const h = rect();
    const grip = h.gripEl('rotate', 'ne');
    const centre: [number, number] = [30, 15];
    const r = Math.hypot(grip.at[0] - centre[0], grip.at[1] - centre[1]);
    const a = Math.atan2(grip.at[1] - centre[1], grip.at[0] - centre[0]) + Math.PI / 2;

    h.down(grip.at, grip.el);
    h.move([centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)]);
    h.up();

    // A quarter turn about the centre swaps the extents of a rectangle.
    const [x0, y0, x1, y1] = bounds(h);
    expect(x1 - x0).toBeCloseTo(20, 6);
    expect(y1 - y0).toBeCloseTo(40, 6);
    expect((x0 + x1) / 2).toBeCloseTo(centre[0], 6);
  });

  it('moves only the selected nodes when the selection is nodes', () => {
    const h = rect();
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection = emptySelection();
      s.selection.nodes.add(`${id}/0/0`);
      s.selection.nodes.add(`${id}/0/1`);
    });
    const grip = h.gripEl('scale', 'e');
    h.down(grip.at, grip.el);
    h.move([grip.at[0] + 40, grip.at[1]]);
    h.up();

    const nodes = h.store.state.doc.shapes[0].subpaths[0].nodes;
    expect(nodes[1].pt[0]).toBeGreaterThan(50);
    // The two that were not selected stayed exactly where they were.
    expect(nodes[2].pt).toEqual([50, 25]);
    expect(nodes[3].pt).toEqual([10, 25]);
  });
});

describe('simplify', () => {
  /** A dense circle of straight segments, the shape an import or a trace gives. */
  const dense = (n = 40, r = 50): string => {
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return `${r * Math.cos(a)} ${r * Math.sin(a)}`;
    });
    return `M${pts[0]} ${pts.slice(1).map((p) => `L${p}`).join(' ')} Z`;
  };

  it('refits a selected shape with fewer nodes', () => {
    const h = harness(dense());
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);

    expect(h.controller.simplifySelection(1)).toBe(true);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.length).toBeLessThan(40);
    expect(said.join(' ')).toMatch(/40 nodes to/);
  });

  it('is one undo step, and puts every node back', () => {
    const h = harness(dense());
    const before = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));

    h.controller.simplifySelection(1);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt])).toEqual(before);
    expect(h.store.canUndo).toBe(false);
  });

  it('clears the selection, because node 7 is now somewhere else', () => {
    const h = harness(dense());
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${id}/0/7`));

    h.controller.simplifySelection(1);
    expect(h.store.state.selection.nodes.size).toBe(0);
    expect(h.store.state.selection.shapes.size).toBe(0);
  });

  it('records nothing when there is nothing to gain', () => {
    const h = harness('M0 0 L10 0 L10 10 L0 10 Z');
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);

    expect(h.controller.simplifySelection(1)).toBe(false);
    expect(h.store.canUndo).toBe(false);
    expect(said.join(' ')).toMatch(/nothing to simplify/i);
  });

  it('refuses a tolerance of zero rather than reporting nothing to do', () => {
    const h = harness(dense());
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);

    expect(h.controller.simplifySelection(0)).toBe(false);
    expect(said.join(' ')).toMatch(/above zero/i);
  });

  it('refuses with nothing selected', () => {
    const h = harness(dense());
    const said: string[] = [];
    h.controller.onMessage = (m) => said.push(m);
    expect(h.controller.simplifySelection(1)).toBe(false);
    expect(said.join(' ')).toMatch(/select/i);
  });
});

describe('dragging more than one shape', () => {
  /** Two separate squares, well apart. */
  function two(): Harness {
    const h = harness('M0 0 L10 0 L10 10 L0 10 Z');
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M30 0 L40 0 L40 10 L30 10 Z')));
    return h;
  }

  it('moves every selected shape when one of their outlines is dragged', () => {
    const h = two();
    const [a, b] = h.store.state.doc.shapes.map((s) => s.id);
    h.store.update((s) => {
      s.selection.shapes.add(a);
      s.selection.shapes.add(b);
    });

    h.down([5, 0], h.outlineEl(a));
    h.move([5, 20]);
    h.up();

    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([0, 20]);
    expect(h.store.state.doc.shapes[1].subpaths[0].nodes[0].pt).toEqual([30, 20]);
  });

  it('does not throw away a node selection to grab one shape', () => {
    // The marquee selects nodes rather than shapes, so grabbing an outline used
    // to clear the lot and move the one shape underneath the pointer.
    const h = two();
    h.down([-5, -5]);
    h.move([45, 15]);
    h.up();
    expect(h.store.state.selection.nodes.size).toBe(8);

    const a = h.store.state.doc.shapes[0].id;
    h.down([5, 0], h.outlineEl(a));
    h.move([5, 20]);
    h.up();

    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([0, 20]);
    expect(h.store.state.doc.shapes[1].subpaths[0].nodes[0].pt).toEqual([30, 20]);
  });

  it('moves the whole shape when only some of its nodes are selected', () => {
    /* The fix above read "any of this shape's nodes are selected" as "the user
       means the nodes", which is true of a marquee and false of one clicked
       vertex -- so grabbing the outline tore that corner off and left the shape
       where it was. The test above cannot see it, because a marquee selects
       every node and the two readings agree there. */
    const h = two();
    const a = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${a}/0/0`));

    h.down([5, 0], h.outlineEl(a));
    h.move([5, 20]);
    h.up();

    const pts = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt);
    expect(pts).toEqual([
      [0, 20],
      [10, 20],
      [10, 30],
      [0, 30],
    ]);
  });

  it('snaps the translation, not each node, so proportions survive', () => {
    // Nodes deliberately off the lattice. Snapping their positions would pull
    // them onto it and deform the shape; snapping the displacement keeps every
    // relative offset and still lands a whole number of grid steps.
    const h = harness('M0.3 0.4 L10.3 0.4 L10.3 10.4 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.snapToGrid = true;
      s.gridStep = 5;
      s.selection.shapes.add(id);
    });

    h.down([5, 0], h.outlineEl(id));
    h.move([11.2, 6.1]);
    h.up();

    // The press was at x = 5, so the displacement is 6.2 across and 6.1 down,
    // which rounds to 5 and 5 at a step of 5. The fractional offsets survive.
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt)).toEqual([
      [5.3, 5.4],
      [15.3, 5.4],
      [15.3, 15.4],
    ]);
  });
});

describe('a gesture always ends', () => {
  it('does not start a second drag while one is live', () => {
    /* The batch was closed by inspecting whichever drag `onUp` found. A second
       pointerdown replaced it, so the first one's batch was never closed --
       after which `checkpoint()` returns early forever and no undo point is
       ever recorded again, silently. Two fingers were enough. */
    const h = harness('M0 0 L10 0 L10 10 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => (s.snapToGrid = false));

    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.down([10, 0], h.anchorEl(id, 0, 1));
    h.move([5, 5]);
    h.up();

    // History still works: this later edit is undoable.
    h.store.edit((s) => (s.doc.shapes[0].name = 'later'));
    expect(h.store.canUndo).toBe(true);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].name).not.toBe('later');
  });

  it('abandons the drag on Escape rather than leaving it running', () => {
    const h = harness('M0 0 L10 0 L10 10 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => (s.snapToGrid = false));
    const before = h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt;

    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.move([5, 5]);
    h.key('Escape');

    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual(before);
    // And the gesture is over: further movement does nothing.
    h.move([9, 9]);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual(before);
    // An abandoned drag is not one Ctrl+Shift+Z from coming back.
    expect(h.store.canRedo).toBe(false);
  });

  it('discards a cancelled primitive instead of committing it', () => {
    const h = harness();
    h.store.update((s) => (s.tool = 'rect'));
    h.down([0, 0]);
    h.move([20, 20]);
    expect(h.store.state.doc.shapes).toHaveLength(1);

    const e = new MouseEvent('pointercancel', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    h.canvas.overlay.dispatchEvent(e);

    // A cancel is the browser taking the gesture away. Routing it to `onUp`
    // committed whatever was half-drawn, which is what Escape refuses to do.
    expect(h.store.state.doc.shapes).toHaveLength(0);
    expect(h.store.canUndo).toBe(false);
  });

  it('does not commit a primitive that was dragged back to nothing', () => {
    const h = harness();
    h.store.update((s) => (s.tool = 'rect'));
    h.down([0, 0]);
    h.move([20, 20]);
    h.move([20, 0]); // zero height
    h.up();

    const [shape] = h.store.state.doc.shapes;
    expect(shape).toBeDefined();
    const ys = shape.subpaths[0].nodes.map((n) => n.pt[1]);
    expect(Math.max(...ys)).toBeGreaterThan(Math.min(...ys));
  });
});

describe('keyboard', () => {
  it('leaves the tool alone when a modifier is held', () => {
    // Ctrl+E belongs to the source drawer and Ctrl+R to the browser. Both used
    // to switch the tool as a silent side effect.
    const h = harness();
    for (const key of ['e', 'r', 'v', 'p']) {
      h.store.update((s) => (s.tool = 'select'));
      h.key(key, { ctrlKey: true });
      expect(h.store.state.tool).toBe('select');
      h.key(key, { metaKey: true });
      expect(h.store.state.tool).toBe('select');
    }
    // Bare, they still work.
    h.key('e');
    expect(h.store.state.tool).toBe('ellipse');
  });

  it('refuses to undo mid-drag, which would pull the checkpoint out', () => {
    const h = harness('M0 0 L10 0 L10 10 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => (s.snapToGrid = false));
    h.store.edit((s) => (s.doc.shapes[0].name = 'earlier'));

    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.move([5, 5]);
    h.key('z', { ctrlKey: true });
    h.key('Escape');

    // The earlier edit is untouched: Escape rolled back its own checkpoint,
    // not somebody else's.
    expect(h.store.state.doc.shapes[0].name).toBe('earlier');
  });
});

describe('joining and resuming a path', () => {
  it('merges two ends of separate shapes into one node', () => {
    const h = harness('M0 0 L10 0');
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M20 0 L30 0')));
    const [a, b] = h.store.state.doc.shapes.map((s) => s.id);
    h.store.update((s) => {
      s.selection.nodes.add(`${a}/0/1`);
      s.selection.nodes.add(`${b}/0/0`);
    });

    expect(h.controller.joinSelection('merge')).toBe(true);
    // One shape left, one path, and the ends met in the middle.
    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [15, 0],
      [30, 0],
    ]);
  });

  it('closes a path when both selected ends belong to it', () => {
    const h = harness('M0 0 L10 0 L10 10');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(`${id}/0/0`);
      s.selection.nodes.add(`${id}/0/2`);
    });

    expect(h.controller.joinSelection('merge')).toBe(true);
    expect(h.store.state.doc.shapes[0].subpaths[0].closed).toBe(true);
  });

  it('refuses a node in the middle of a path, and records no history', () => {
    const h = harness('M0 0 L10 0 L10 10 L20 10');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(`${id}/0/1`);
      s.selection.nodes.add(`${id}/0/3`);
    });

    expect(h.controller.joinSelection('merge')).toBe(false);
    expect(h.store.canUndo).toBe(false);
    expect(h.store.state.doc.shapes[0].subpaths[0].closed).toBe(false);
  });

  it('is one undo step', () => {
    const h = harness('M0 0 L10 0');
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M20 0 L30 0')));
    const [a, b] = h.store.state.doc.shapes.map((s) => s.id);
    h.store.update((s) => {
      s.selection.nodes.add(`${a}/0/1`);
      s.selection.nodes.add(`${b}/0/0`);
    });

    h.controller.joinSelection('merge');
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(2);
    expect(h.store.canUndo).toBe(false);
  });

  it('connects two shapes with a segment, keeping both end nodes', () => {
    const h = harness('M0 0 L10 0');
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M20 0 L30 0')));
    const [a, b] = h.store.state.doc.shapes.map((s) => s.id);
    h.store.update((s) => {
      s.selection.nodes.add(`${a}/0/1`);
      s.selection.nodes.add(`${b}/0/0`);
    });

    expect(h.controller.joinSelection('connect')).toBe(true);
    expect(h.store.state.doc.shapes).toHaveLength(1);
    // Four nodes, not three: nothing was welded and nothing moved.
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ]);
  });

  it('defaults to connect, the reading that does not destroy a node', () => {
    const h = harness('M0 0 L10 0 L10 10');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(`${id}/0/0`);
      s.selection.nodes.add(`${id}/0/2`);
    });

    h.controller.joinSelection();
    const sp = h.store.state.doc.shapes[0].subpaths[0];
    expect(sp.closed).toBe(true);
    expect(sp.nodes).toHaveLength(3);
  });

  it('resumes an existing path instead of starting a new shape', () => {
    /* Without this the pen could only ever start something new: a path put down
       and then let go of could never be extended again. */
    const h = harness('M0 0 L10 0');
    h.store.update((s) => {
      s.tool = 'pen';
      s.snapToGrid = false;
    });

    h.down([10, 0]);
    h.up();
    h.down([20, 5]);
    h.up();

    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt)).toEqual([
      [0, 0],
      [10, 0],
      [20, 5],
    ]);
  });

  it('reverses the path when the far end is the one clicked', () => {
    const h = harness('M0 0 L10 0');
    h.store.update((s) => {
      s.tool = 'pen';
      s.snapToGrid = false;
    });

    h.down([0, 0]);
    h.up();
    h.down([-10, 5]);
    h.up();

    // The pen only appends, so picking up the start flips the path first.
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt)).toEqual([
      [10, 0],
      [0, 0],
      [-10, 5],
    ]);
  });

  it('starts a new shape when the click is nowhere near an end', () => {
    const h = harness('M0 0 L10 0');
    h.store.update((s) => {
      s.tool = 'pen';
      s.snapToGrid = false;
    });

    h.down([40, 40]);
    h.up();
    expect(h.store.state.doc.shapes).toHaveLength(2);
  });
});


describe('navigating the view', () => {
  const wheel = (h: Harness, opts: WheelEventInit): void => {
    h.canvas.overlay.dispatchEvent(
      new WheelEvent('wheel', { clientX: 400, clientY: 300, bubbles: true, cancelable: true, ...opts }),
    );
  };

  it('zooms on a plain wheel', () => {
    const h = harness('M0 0 L20 0');
    const before = h.store.state.camera.w;
    wheel(h, { deltaY: 200 });
    expect(h.store.state.camera.w).toBeGreaterThan(before);
  });

  it('pans sideways on Shift and vertically on Alt, without zooming', () => {
    /* All three modifiers used to zoom, because none was bound. Doing nothing
       different reads as broken rather than unassigned. */
    const h = harness('M0 0 L20 0');
    const start = { ...h.store.state.camera };

    wheel(h, { deltaY: 200, shiftKey: true });
    let cam = h.store.state.camera;
    expect(cam.w).toBe(start.w);
    expect(cam.x).not.toBe(start.x);
    expect(cam.y).toBe(start.y);

    const afterShift = { ...cam };
    wheel(h, { deltaY: 200, altKey: true });
    cam = h.store.state.camera;
    expect(cam.w).toBe(start.w);
    expect(cam.x).toBe(afterShift.x);
    expect(cam.y).not.toBe(afterShift.y);
  });

  it('pans with the hand tool, from a press anywhere', () => {
    const h = harness('M0 0 L20 0');
    h.store.update((s) => (s.tool = 'hand'));
    const before = { ...h.store.state.camera };

    h.down([10, 10]);
    h.move([4, 10]);
    h.up();

    const after = h.store.state.camera;
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.w).toBe(before.w);
    // Panning is a view change, so it leaves no history entry.
    expect(h.store.canUndo).toBe(false);
  });

  it('reaches the hand tool from the keyboard, but not with a modifier', () => {
    const h = harness();
    h.key('h');
    expect(h.store.state.tool).toBe('hand');
    h.store.update((s) => (s.tool = 'select'));
    h.key('h', { ctrlKey: true });
    expect(h.store.state.tool).toBe('select');
  });
});

describe('the backdrop', () => {
  const withBackdrop = (h: Harness, over: Partial<NonNullable<typeof h.store.state.backdrop>> = {}): void => {
    h.store.update((s) => {
      s.backdrop = {
        src: 'blob:test',
        name: 'ref.png',
        x: 0,
        y: 0,
        w: 40,
        h: 30,
        naturalW: 400,
        naturalH: 300,
        opacity: 0.5,
        visible: true,
        locked: true,
        ...over,
      };
    });
  };

  it('leaves the marquee alone while locked', () => {
    /* Asserting only that the image did not move was not enough: making a
       locked backdrop swallow every canvas drag also left it at zero. The
       marquee has to actually happen, so the drag runs over a node. */
    const h = harness('M0 0 L20 0 L20 20 Z');
    withBackdrop(h);
    h.down([-5, -5]);
    h.move([25, 25]);
    h.up();
    expect(h.store.state.backdrop!.x).toBe(0);
    expect(h.store.state.selection.nodes.size).toBeGreaterThan(0);
  });

  it('leaves the marquee alone while hidden, unlocked or not', () => {
    // An unlocked backdrop you cannot see would otherwise eat every drag on
    // empty canvas, with nothing on screen to explain it.
    const h = harness('M0 0 L20 0 L20 20 Z');
    withBackdrop(h, { locked: false, visible: false });
    h.down([-5, -5]);
    h.move([25, 25]);
    h.up();
    expect(h.store.state.backdrop!.x).toBe(0);
    expect(h.store.state.selection.nodes.size).toBeGreaterThan(0);
  });

  it('moves on an empty-canvas drag once unlocked', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    withBackdrop(h, { locked: false });
    h.store.update((s) => (s.snapToGrid = false));

    h.down([50, 50]);
    h.move([56, 53]);
    h.up();

    expect(h.store.state.backdrop!.x).toBeCloseTo(6, 9);
    expect(h.store.state.backdrop!.y).toBeCloseTo(3, 9);
  });

  it('snaps the displacement, not the position', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    // Deliberately off the lattice: the offset has to survive.
    withBackdrop(h, { locked: false, x: 0.3, y: 0.4 });
    h.store.update((s) => {
      s.snapToGrid = true;
      s.gridStep = 5;
    });

    h.down([50, 50]);
    h.move([56.2, 53.1]);
    h.up();

    expect(h.store.state.backdrop!.x).toBeCloseTo(5.3, 9);
    expect(h.store.state.backdrop!.y).toBeCloseTo(5.4, 9);
  });

  it('puts the whole drag on the undo stack as one entry', () => {
    // It used to record nothing at all, on the theory that a backdrop is not
    // part of the drawing. Which is true, and is a statement about the export
    // rather than about whether nudging a reference off by 40 units should be
    // recoverable.
    const h = harness('M0 0 L20 0 L20 20 Z');
    withBackdrop(h, { locked: false });
    h.store.update((s) => (s.snapToGrid = false));

    h.down([50, 50]);
    h.move([55, 55]);
    h.move([60, 60]);
    h.up();
    expect(h.store.state.backdrop!.x).toBeCloseTo(10, 9);

    h.store.undo();
    expect(h.store.state.backdrop!.x).toBeCloseTo(0, 9);
    // Every move fired an update, and all of them belong to one gesture.
    expect(h.store.canUndo).toBe(false);
  });

  it('leaves the drawing alone when the backdrop drag is undone', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    withBackdrop(h, { locked: false });
    const before = h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt.slice();

    h.down([50, 50]);
    h.move([60, 60]);
    h.up();
    h.store.undo();

    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual(before);
  });

  it('abandons the drag on Escape without offering a redo', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    withBackdrop(h, { locked: false });
    h.down([50, 50]);
    h.move([60, 60]);
    h.key('Escape');

    expect(h.store.state.backdrop!.x).toBeCloseTo(0, 9);
    expect(h.store.canRedo).toBe(false);
  });

  it('is not in the document, so it cannot reach the export', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    withBackdrop(h);
    // The export is built from `doc`, and `doc` has no idea a backdrop exists.
    expect(Object.keys(h.store.state.doc)).not.toContain('backdrop');
    expect(exportSvg(h.store.state.doc)).not.toContain('image');
  });
})

describe('the pixel-fit lattice during a gesture', () => {
  /**
   * The defect this exists for. `phase()` read the selection fresh on every
   * snap, and a create drag REPLACES the selection with the shape it just made.
   * So a rectangle drawn while an unstroked shape happened to be selected had
   * its first corner snapped on one lattice and every later corner on another,
   * and came out 20.5 units wide: two edges on whole pixels, two not, which is
   * exactly what §25 exists to prevent. The drawn grid moved with it, leaving
   * the committed corner on no gridline at all.
   */
  const scene = (): Harness => {
    const h = harness('M0 0 L10 0 L10 10 Z');
    h.store.update((s) => {
      s.doc.shapes[0].style = { ...s.doc.shapes[0].style, stroke: 'none', strokeWidth: 1 };
      s.selection.shapes.add(s.doc.shapes[0].id);
      s.style = { ...s.style, stroke: '#000', strokeWidth: 1 };
      s.pixelFit = true;
      s.gridStep = 1;
      s.snapToPoints = false;
      s.snapToBoundary = false;
      s.tool = 'rect';
    });
    return h;
  };

  it('holds one lattice for the whole of a create drag', () => {
    const h = scene();
    h.down([40.2, 40.2]);
    h.move([50.4, 50.4]);
    h.move([60.4, 60.4]);
    h.up();

    const drawn = h.store.state.doc.shapes[1];
    const xs = drawn.subpaths[0].nodes.map((n) => n.pt[0]);
    // Every corner on the same lattice, so every side is a whole number long.
    for (const x of xs) expect(Math.abs(x - Math.floor(x) - 0.5)).toBeLessThan(1e-9);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(20);
  });

  it('draws the grid on the lattice it is snapping to, mid-gesture', () => {
    const h = scene();
    const lines = (): number[] => {
      h.controller.render();
      const d = h.canvas.overlay.querySelector('.grid-minor')?.getAttribute('d') ?? '';
      return [...d.matchAll(/M(-?[\d.]+) [-\d.]+V/g)].map((m) => +m[1]);
    };
    h.down([40.2, 40.2]);
    const during = lines();
    h.move([50.4, 50.4]);
    const later = lines();
    h.up();

    expect(during.length).toBeGreaterThan(2);
    // Half-integers before and after the selection changed under the gesture.
    for (const set of [during, later]) {
      for (const x of set) expect(Math.abs(x - Math.floor(x) - 0.5)).toBeLessThan(1e-9);
    }
  });

  it('goes back to the selection once a drawing tool is put down', () => {
    // The drawing-tool rule applies while a drawing tool is active and not a
    // moment longer: selecting the unstroked shape with Select afterwards has to
    // put the grid back on whole pixels.
    const h = scene();
    h.down([40.2, 40.2]);
    h.move([50.4, 50.4]);
    h.up();
    h.store.update((s) => {
      s.tool = 'select';
      s.selection.shapes.clear();
      s.selection.shapes.add(s.doc.shapes[0].id);
    });
    h.controller.render();
    const d = h.canvas.overlay.querySelector('.grid-minor')?.getAttribute('d') ?? '';
    const xs = [...d.matchAll(/M(-?[\d.]+) [-\d.]+V/g)].map((m) => +m[1]);
    for (const x of xs) expect(x).toBe(Math.round(x));
  });
});
