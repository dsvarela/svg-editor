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
import { emptyDoc, makeShape, shapeBBox, shapeFromPath } from '../src/model/doc';
import { serialisePath } from '../src/core/serialise';
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
