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
import { Commands } from '../src/tools/commands';
import { bindKeys } from '../src/tools/keys';
import { Store } from '../src/model/store';
import { docBBox, emptyDoc, emptySelection, makeShape, nodeIdAt, resolveNodes, shapeBBox, shapeFromPath } from '../src/model/doc';
import type { TraceResult } from '../src/model/trace';
import { serialisePath } from '../src/core/serialise';
import { segmentBend, splitSegment } from '../src/model/ops';
import { exportSvg } from '../src/io/svg';
import { cubicAt } from '../src/core/bezier';
import { continuityOf, makeNode, segmentAsCubic, segmentCount } from '../src/core/types';
import { screenToDoc } from '../src/view/viewport';
import keySource from '../src/tools/keys.ts?raw';

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
  commands: Commands;
  down(doc: [number, number], target?: Element, opts?: PointerEventInit): void;
  move(doc: [number, number], opts?: PointerEventInit): void;
  up(): void;
  /** One finger, by id, in client pixels. Two of them are a pinch. */
  touch(type: 'down' | 'move' | 'up', id: number, client: [number, number]): void;
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
  const commands = new Commands(store, () => controller.busy);
  bindKeys(store, controller, commands);
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
    commands,
    down: (p, target, opts) => ev('pointerdown', p, target ?? canvas.overlay, opts),
    move: (p, opts) => ev('pointermove', p, canvas.overlay, opts),
    up: () => ev('pointerup', [0, 0], canvas.overlay),
    touch: (type, id, client) => {
      const e = new MouseEvent(`pointer${type}`, {
        clientX: client[0],
        clientY: client[1],
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(e, 'pointerId', { value: id });
      Object.defineProperty(e, 'pointerType', { value: 'touch' });
      Object.defineProperty(e, 'button', { value: 0 });
      canvas.overlay.dispatchEvent(e);
    },
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
    expect([...h.store.state.selection.nodes]).toEqual([nodeIdAt(h.store.state.doc, id, 0, 0)]);
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
   * The pen holds a shape id between events, and the shape can be removed
   * underneath it. Every route below reaches a dangling id, and the failure is
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
    const r = h.commands.booleanSelection('unite');
    expect(r.ok).toBe(false);
    // Crucially, the document is untouched rather than half-combined.
    expect(h.store.state.doc.shapes).toHaveLength(2);
  });

  it('replaces both operands with one shape', () => {
    const h = twoSquares();
    selectAll(h);
    expect(h.commands.booleanSelection('unite').ok).toBe(true);
    expect(h.store.state.doc.shapes).toHaveLength(1);
  });

  it('keeps the first shape identity, so the result inherits its style', () => {
    const h = twoSquares();
    const first = h.store.state.doc.shapes[0];
    const id = first.id;
    first.style.fill = '#ff0000';
    selectAll(h);
    h.commands.booleanSelection('unite');

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
    h.commands.booleanSelection('subtract');

    // Area alone cannot tell the two directions apart -- both leave 300. The
    // extent can: lower-minus-upper occupies 0..20, the reverse 10..30.
    const box = shapeBBox(h.store.state.doc.shapes[0])!;
    expect([box.x0, box.y0, box.x1, box.y1]).toEqual([0, 0, 20, 20]);
  });

  it('is one undo step', () => {
    const h = twoSquares();
    selectAll(h);
    h.commands.booleanSelection('unite');
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(2);
  });

  it('leaves the document alone when the result is empty', () => {
    const h = harness('M0 0 H10 V10 H0 Z');
    h.store.state.doc.shapes.push(shapeFromPath('M100 100 H110 V110 H100 Z'));
    selectAll(h);

    // Two disjoint squares have no intersection at all.
    const r = h.commands.booleanSelection('intersect');
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
          sp.nodes.forEach((_, i) => s.selection.nodes.add(nodeIdAt(s.doc, sh.id, spI, i))),
        );
      }
    });

  it('removes a closed shape when every node is selected', () => {
    // The reported bug: the marquee selected all four, delete left three.
    const h = harness('M0 0 H20 V20 H0 Z');
    selectAllNodes(h);
    expect(h.store.state.selection.nodes.size).toBe(4);

    h.commands.deleteSelection();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('removes an open path when every node is selected', () => {
    const h = harness('M0 0 L20 0 L20 20');
    selectAllNodes(h);
    h.commands.deleteSelection();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('clears several shapes at once', () => {
    const h = harness('M0 0 H20 V20 H0 Z');
    h.store.state.doc.shapes.push(shapeFromPath('M40 40 L60 40 L60 60 Z'));
    selectAllNodes(h);
    h.commands.deleteSelection();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('drops only the fully-selected subpath of a multi-subpath shape', () => {
    const h = harness('M0 0 H20 V20 H0 Z M40 40 H60 V60 H40 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      for (let i = 0; i < 4; i++) s.selection.nodes.add(nodeIdAt(s.doc, id, 1, i));
    });

    h.commands.deleteSelection();
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
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1));
    });

    const r = h.commands.deleteSelection();
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
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 2)));

    const r = h.commands.deleteSelection();
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
          s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
        });
        expect(h.commands.deleteSelection().blocked).toBe(0);
      }
      expect(h.store.state.doc.shapes).toHaveLength(0);
    }
  });

  it('stays silent -- there is nothing left to explain away', () => {
    const h = harness('M0 0 H20 V20 H0 Z');
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);
    selectAllNodes(h);
    h.commands.deleteSelection();
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
      for (let i = 0; i < 4; i++) s.selection.nodes.add(nodeIdAt(s.doc, square, 0, i));
    });
    h.commands.deleteSelection();

    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([50, 50]);
  });

  it('is one undo step, whole shape or not', () => {
    const h = harness('M0 0 H20 V20 H0 Z');
    selectAllNodes(h);
    h.commands.deleteSelection();
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes).toHaveLength(4);
  });
});

describe('breaking a path', () => {
  const select = (h: Harness, i: number): void =>
    h.store.update((s) => {
      s.selection.nodes.clear();
      s.selection.nodes.add(nodeIdAt(s.doc, h.store.state.doc.shapes[0].id, 0, i));
    });

  it('splits an open path into two at an interior node', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    select(h, 1);
    expect(h.commands.breakAtSelection()).toBe(true);

    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(2);
    expect(sps[0].nodes.map((n) => n.pt)).toEqual([[0, 0], [10, 0]]);
    expect(sps[1].nodes.map((n) => n.pt)).toEqual([[10, 0], [20, 0], [30, 0]]);
    expect(sps.every((sp) => !sp.closed)).toBe(true);
  });

  it('opens a closed path at the chosen node', () => {
    const h = harness('M0 0 L20 0 L20 20 L0 20 Z');
    select(h, 2);
    h.commands.breakAtSelection();

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
    h.commands.breakAtSelection();
    const after = samplePath(h);

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      expect(Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1])).toBeLessThan(1e-9);
    }
  });

  it('refuses at an endpoint, where there is no second side', () => {
    const h = harness('M0 0 L10 0 L20 0');
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);

    select(h, 0);
    expect(h.commands.breakAtSelection()).toBe(false);
    select(h, 2);
    expect(h.commands.breakAtSelection()).toBe(false);
    expect(said).toHaveLength(2);
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(1);
  });

  it('needs exactly one node', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    h.store.update((s) => {
      const id = s.doc.shapes[0].id;
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 2));
    });
    expect(h.commands.breakAtSelection()).toBe(false);
  });

  it('is one undo step', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    select(h, 1);
    h.commands.breakAtSelection();
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(1);
  });

  it('round-trips through the serialiser as two subpaths', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    select(h, 1);
    h.commands.breakAtSelection();
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
      for (const i of idx) s.selection.nodes.add(nodeIdAt(s.doc, id, 0, i));
    });

  it('leaves two ends where a middle node was', () => {
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0 L40 0');
    select(h, 2);
    h.commands.deleteSelection();

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
    h.commands.deleteSelection();

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
    h.commands.deleteSelection();
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
    h.commands.deleteSelection();

    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(1);
    expect(sps[0].nodes.map((n) => n.pt)).toEqual([[20, 0], [30, 0]]);
  });

  it('handles several cuts in one go', () => {
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0 L40 0 L50 0 L60 0');
    select(h, 2, 4);
    h.commands.deleteSelection();

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
      for (let i = 0; i < 4; i++) s.selection.nodes.add(nodeIdAt(s.doc, id, 0, i));
    });
    h.commands.deleteSelection();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('is one undo step even when it produces several subpaths', () => {
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0 L40 0');
    select(h, 2);
    h.commands.deleteSelection();
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(2);

    h.store.undo();
    const sps = h.store.state.doc.shapes[0].subpaths;
    expect(sps).toHaveLength(1);
    expect(sps[0].nodes).toHaveLength(5);
  });

  it('leaves the mode alone — it is a preference, not a one-shot', () => {
    const h = splitHarness('M0 0 L10 0 L20 0 L30 0 L40 0');
    select(h, 2);
    h.commands.deleteSelection();
    expect(h.store.state.deleteMode).toBe('split');
  });

  it('fuse is still the default', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0 L40 0');
    expect(h.store.state.deleteMode).toBe('fuse');
    select(h, 2);
    h.commands.deleteSelection();
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

    expect(h.commands.circulariseSelection()).toBe(true);

    for (const p of samplePath(h, 24)) {
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 1);
    }
  });

  it('works from a node selection, taking the whole contour with it', () => {
    const h = harness('M0 -10 L10 0 L0 10 L-10 0 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1)));

    expect(h.commands.circulariseSelection()).toBe(true);
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
    h.commands.onMessage = (m) => said.push(m);
    expect(h.commands.circulariseSelection()).toBe(false);
    expect(said.join(' ')).toMatch(/collinear/i);
  });

  it('refuses with nothing selected', () => {
    const h = harness('M0 -10 L10 0 L0 10 L-10 0 Z');
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);
    expect(h.commands.circulariseSelection()).toBe(false);
    expect(said.join(' ')).toMatch(/select/i);
  });

  it('is one undo step', () => {
    const h = harness('M0 -10 L10 0 L0 10 L-10 0 Z');
    const before = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));
    h.commands.circulariseSelection();
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt])).toEqual(before);
  });
});

describe('a press that never becomes a drag', () => {
  it('leaves the redo stack alone', () => {
    /* Checkpointing on pointerdown, before the gesture knows whether it will
       change anything, throws the redo stack away on every stray click: that is
       what `checkpoint` does. The checkpoint therefore happens on the first
       real mutation. Same failure `tryEdit` stops for buttons, applied here to
       drags. */
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
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 2));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 3));
    });

    expect(h.commands.roundSelection(8)).toBe(true);
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
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1)));

    h.commands.roundSelection(6);
    expect(h.store.state.selection.nodes.size).toBe(0);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.length).toBe(4);
    expect(h.store.canUndo).toBe(false);
  });

  it('explains a refusal instead of doing nothing quietly', () => {
    const h = harness('M0 0 L40 0 C50 10 50 30 40 40 L0 40 Z');
    const id = ids(h);
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1)));
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);

    expect(h.commands.roundSelection(5)).toBe(false);
    expect(said.join(' ')).toMatch(/straight segment on both sides/i);
    expect(h.store.canUndo).toBe(false);
  });

  it('refuses a radius of zero and an empty selection', () => {
    const h = square();
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);

    expect(h.commands.roundSelection(0)).toBe(false);
    expect(said.join(' ')).toMatch(/above zero/i);

    said.length = 0;
    expect(h.commands.roundSelection(5)).toBe(false);
    expect(said.join(' ')).toMatch(/select/i);
  });

  it('says when the radius was cut down to fit', () => {
    const h = harness('M0 0 L40 0 L40 6 L0 6 Z');
    const id = ids(h);
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1)));
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);

    expect(h.commands.roundSelection(30)).toBe(true);
    expect(said.join(' ')).toMatch(/clamped/i);
  });
});

describe('style', () => {
  it('restyles the selected shapes in one undo step', () => {
    const h = harness('M0 0 L10 0 L10 10 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.shapes.add(id));

    h.commands.setStyle({ fill: '#ff0000' });
    h.commands.setStyle({ strokeWidth: 3 });
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
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1)));

    h.commands.setStyle({ stroke: '#00ff00' });
    expect(h.store.state.doc.shapes[0].style.stroke).toBe('#00ff00');
  });

  it('sets what the next shape will look like when nothing is selected', () => {
    const h = harness('M0 0 L10 0 L10 10 Z');
    h.commands.setStyle({ fill: '#0000ff', strokeWidth: 2 });

    // A statement about the future, so it is not an edit and records nothing.
    expect(h.store.canUndo).toBe(false);
    expect(h.store.state.doc.shapes[0].style.fill).not.toBe('#0000ff');
    expect(h.store.state.style.fill).toBe('#0000ff');
  });

  it('gives a newly drawn shape the style that was chosen for it', () => {
    const h = harness();
    h.commands.setStyle({ fill: '#123456', strokeWidth: 4 });

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

    expect(h.commands.setStyle({ stroke: was })).toBe(false);
    expect(h.store.canUndo).toBe(false);
  });
});

describe('fitting the canvas to the drawing', () => {
  it('wraps the drawing, rounded outwards to whole grid steps', () => {
    // The shape a user pasted to report this: a drawing in the corner of a
    // canvas nobody chose, exported with a viewBox four times its size.
    const h = harness('M2.8 1 L19.4 1 L19.4 39.3 L2.8 39.3 Z');
    h.store.update((s) => (s.gridStep = 1));

    expect(h.commands.fitCanvasToDrawing()).toBe(true);
    expect(h.store.state.doc.viewBox).toEqual({ x: 2, y: 1, w: 18, h: 39 });
  });

  it('grows the box rather than cropping, whatever the step', () => {
    const h = harness('M2.8 1.2 L19.4 1.2 L19.4 39.3 L2.8 39.3 Z');
    h.store.update((s) => (s.gridStep = 5));
    h.commands.fitCanvasToDrawing();

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
    h.commands.fitCanvasToDrawing();
    expect(h.store.state.doc.viewBox).toEqual({ x: 2.5, y: 1.5, w: 17, h: 37 });
  });

  it('gives a flat drawing a page it can be seen on', () => {
    const h = harness('M4 10 L20 10');
    h.store.update((s) => (s.gridStep = 1));
    h.commands.fitCanvasToDrawing();
    expect(h.store.state.doc.viewBox.h).toBeGreaterThan(0);
  });

  it('declines an empty document, and one that already fits', () => {
    const empty = harness();
    const said: string[] = [];
    empty.commands.onMessage = (m) => said.push(m);
    expect(empty.commands.fitCanvasToDrawing()).toBe(false);
    expect(said.join(' ')).toMatch(/nothing drawn/i);

    const h = harness('M0 0 L10 0 L10 10 L0 10 Z');
    h.store.update((s) => (s.gridStep = 1));
    h.commands.fitCanvasToDrawing();
    expect(h.commands.fitCanvasToDrawing()).toBe(false);
    expect(h.store.canUndo).toBe(true);
  });

  it('is one undo step', () => {
    const h = harness('M2 2 L20 2 L20 30 Z');
    const before = { ...h.store.state.doc.viewBox };
    h.commands.fitCanvasToDrawing();
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
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
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
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1));
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
    h.commands.onMessage = (m) => said.push(m);

    expect(h.commands.simplifySelection(1)).toBe(true);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.length).toBeLessThan(40);
    expect(said.join(' ')).toMatch(/40 nodes to/);
  });

  it('is one undo step, and puts every node back', () => {
    const h = harness(dense());
    const before = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt]);
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));

    h.commands.simplifySelection(1);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => [...n.pt])).toEqual(before);
    expect(h.store.canUndo).toBe(false);
  });

  it('clears the selection, because node 7 is now somewhere else', () => {
    const h = harness(dense());
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 7)));

    h.commands.simplifySelection(1);
    expect(h.store.state.selection.nodes.size).toBe(0);
    expect(h.store.state.selection.shapes.size).toBe(0);
  });

  it('records nothing when there is nothing to gain', () => {
    const h = harness('M0 0 L10 0 L10 10 L0 10 Z');
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);

    expect(h.commands.simplifySelection(1)).toBe(false);
    expect(h.store.canUndo).toBe(false);
    expect(said.join(' ')).toMatch(/nothing to simplify/i);
  });

  /* Zero is the instruction to move nothing, not an invalid tolerance. What it
     removes is whatever cannot change the exported file, which is what lets one
     number cover the whole range instead of a number plus a mode. */
  it('treats a tolerance of zero as "move nothing" rather than refusing it', () => {
    const h = harness('M0 0 C 10 -10 20 -10 30 0 C 40 10 50 10 60 0');
    const sp = h.store.state.doc.shapes[0].subpaths[0];
    // A node added the way double-clicking adds one: lossless, so it is free.
    splitSegment(sp, 0, 0.5);
    h.controller.render();
    const nodes = sp.nodes.length;
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);

    expect(h.commands.simplifySelection(0)).toBe(true);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes.length).toBe(nodes - 1);
    expect(said.join(' ')).not.toMatch(/above zero/i);
  });

  it('refuses a negative tolerance, which is not an instruction at all', () => {
    const h = harness(dense());
    h.store.update((s) => s.selection.shapes.add(h.store.state.doc.shapes[0].id));
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);
    expect(h.commands.simplifySelection(-1)).toBe(false);
    expect(said.join(' ')).toMatch(/negative/i);
  });

  it('refuses with nothing selected', () => {
    const h = harness(dense());
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);
    expect(h.commands.simplifySelection(1)).toBe(false);
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
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, a, 0, 0)));

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
      s.selection.nodes.add(nodeIdAt(s.doc, a, 0, 1));
      s.selection.nodes.add(nodeIdAt(s.doc, b, 0, 0));
    });

    expect(h.commands.joinSelection('merge')).toBe(true);
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
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 2));
    });

    expect(h.commands.joinSelection('merge')).toBe(true);
    expect(h.store.state.doc.shapes[0].subpaths[0].closed).toBe(true);
  });

  it('refuses a node in the middle of a path, and records no history', () => {
    const h = harness('M0 0 L10 0 L10 10 L20 10');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 3));
    });

    expect(h.commands.joinSelection('merge')).toBe(false);
    expect(h.store.canUndo).toBe(false);
    expect(h.store.state.doc.shapes[0].subpaths[0].closed).toBe(false);
  });

  it('is one undo step', () => {
    const h = harness('M0 0 L10 0');
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M20 0 L30 0')));
    const [a, b] = h.store.state.doc.shapes.map((s) => s.id);
    h.store.update((s) => {
      s.selection.nodes.add(nodeIdAt(s.doc, a, 0, 1));
      s.selection.nodes.add(nodeIdAt(s.doc, b, 0, 0));
    });

    h.commands.joinSelection('merge');
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(2);
    expect(h.store.canUndo).toBe(false);
  });

  it('connects two shapes with a segment, keeping both end nodes', () => {
    const h = harness('M0 0 L10 0');
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M20 0 L30 0')));
    const [a, b] = h.store.state.doc.shapes.map((s) => s.id);
    h.store.update((s) => {
      s.selection.nodes.add(nodeIdAt(s.doc, a, 0, 1));
      s.selection.nodes.add(nodeIdAt(s.doc, b, 0, 0));
    });

    expect(h.commands.joinSelection('connect')).toBe(true);
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
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 2));
    });

    h.commands.joinSelection();
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
    /* Each of the three is bound to something distinct. A modifier that does
       nothing different reads as broken rather than unassigned. */
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
    // A backdrop is not part of the drawing, which is a statement about the
    // export and not about whether nudging a reference off by 40 units should
    // be recoverable. It is recorded.
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

/**
 * Committing a trace that was computed somewhere else.
 *
 * The tracer runs in a worker now, so between asking for a trace and getting
 * one back the main thread stays live for as long as the walk takes -- three
 * seconds on a 900 by 900 photograph. Everything a person can do in three
 * seconds can invalidate the answer, because the walk was told where the
 * backdrop was and fitted its coordinates to that. These are the four things
 * `applyTrace` refuses.
 */
describe('a trace landing after the fact', () => {
  const place = { x: 10, y: 4, w: 40, h: 30 };

  const result = (): TraceResult => {
    const shape = shapeFromPath('M 10 4 H 50 V 34 H 10 Z', 'traced');
    return { shapes: [shape], paths: 1, nodesBefore: 4, nodesAfter: 4, colours: 1 };
  };

  const withBackdrop = (h: Harness, over: Record<string, number> = {}): void => {
    h.store.update((s) => {
      s.backdrop = {
        src: 'blob:test',
        name: 'ref.png',
        ...place,
        naturalW: 400,
        naturalH: 300,
        opacity: 0.5,
        visible: true,
        locked: true,
        ...over,
      };
    });
  };

  it('commits when nothing moved', () => {
    // The control the other three are measured against: without this, every
    // refusal below would pass on a function that refused unconditionally.
    const h = harness();
    withBackdrop(h);
    const before = h.store.state.doc.shapes.length;
    expect(h.commands.applyTrace(result(), place)).toBe(true);
    expect(h.store.state.doc.shapes.length).toBe(before + 1);
  });

  it('refuses when the backdrop was removed', () => {
    const h = harness();
    withBackdrop(h);
    h.store.update((s) => {
      s.backdrop = null;
    });
    const before = h.store.state.doc.shapes.length;
    expect(h.commands.applyTrace(result(), place)).toBe(false);
    expect(h.store.state.doc.shapes.length).toBe(before);
  });

  it('refuses when the backdrop moved by a ten-thousandth', () => {
    /* Deliberately smaller than any tolerance in this codebase. The question is
       not "are these two placements the same place" -- that would want `MEET` --
       but "were these numbers changed since the walk was told them", and the
       answer to that is exact. A tolerance here would commit shapes fitted to
       one rectangle on top of a different one. */
    const h = harness();
    withBackdrop(h, { x: place.x + 0.0001 });
    const before = h.store.state.doc.shapes.length;
    expect(h.commands.applyTrace(result(), place)).toBe(false);
    expect(h.store.state.doc.shapes.length).toBe(before);
  });

  it('refuses while a drag is in flight', () => {
    // A trace committing mid-drag lands inside somebody else's undo entry: the
    // drag's checkpoint is already on the stack, so undoing the trace rolls
    // back the drag as well.
    const h = harness('M 0 0 L 20 20');
    withBackdrop(h);
    h.down([0, 0], h.anchorEl(h.store.state.doc.shapes[0].id, 0, 0));
    h.move([5, 5]);
    const before = h.store.state.doc.shapes.length;
    expect(h.commands.applyTrace(result(), place)).toBe(false);
    expect(h.store.state.doc.shapes.length).toBe(before);
    h.up();
  });
});

/**
 * Reverse, and the selection following the nodes it was pointing at.
 *
 * The geometry half is `test/ops.test.ts`. What is only here is that the
 * selection survives the renumbering: reversing moves every node to a new
 * index, so a selection left alone would stay lit while pointing at different
 * nodes, and the next nudge would move the wrong ones.
 */
describe('reverse', () => {
  it('carries a node selection across an open subpath', () => {
    const h = harness('M 0 0 L 10 0 L 20 0 L 30 0');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1)));

    expect(h.commands.reverseSelection()).toBe(true);
    // Four nodes, so 1 becomes 3 - 1 = 2, and that node is the one that was at
    // [10, 0]. Both halves are asserted: an index alone could be right about a
    // different node.
    expect([...h.store.state.selection.nodes]).toEqual([nodeIdAt(h.store.state.doc, id, 0, 2)]);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[2].pt).toEqual([10, 0]);
  });

  it('carries a node selection across a closed subpath, which keeps node 0', () => {
    const h = harness('M 0 0 L 10 0 L 20 6 L 4 9 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1));
    });

    expect(h.commands.reverseSelection()).toBe(true);
    const nodes = h.store.state.doc.shapes[0].subpaths[0].nodes;
    expect(nodes[0].pt, 'a ring keeps its start node').toEqual([0, 0]);
    expect(nodes[3].pt, 'and the second node is now the last').toEqual([10, 0]);

    /* By where the selected nodes are, not by which indices hold them. The two
       chosen anchors were at [0, 0] and [10, 0]; the reversal moved the second
       from index 1 to index 3 and the selection is supposed to have followed
       the node rather than the number. */
    const at = resolveNodes(h.store.state.doc, h.store.state.selection).map((r) => r.pt);
    expect(at.sort()).toEqual([[0, 0], [10, 0]]);
  });

  it('reverses every subpath of a selected shape exactly once', () => {
    /* Selecting the shape and one of its own nodes names the same subpath
       twice. Reversing it twice would be a no-op that reported success, which
       is the kind of bug that hides behind a green result. */
    const h = harness('M 0 0 L 10 0 L 20 6');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.shapes.add(id);
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
    });

    expect(h.commands.reverseSelection()).toBe(true);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([20, 6]);
  });

  it('refuses, and says so, with nothing selected', () => {
    const h = harness('M 0 0 L 10 0');
    const said: string[] = [];
    h.commands.onMessage = (m) => said.push(m);
    expect(h.commands.reverseSelection()).toBe(false);
    expect(said.join(' ')).toMatch(/select/i);
  });

  it('is one undo step', () => {
    const h = harness('M 0 0 L 10 0 L 20 6');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.shapes.add(id));
    h.commands.reverseSelection();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([20, 6]);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([0, 0]);
  });
});

/**
 * Setting a node's continuity from the keyboard.
 *
 * Double-clicking an anchor already cycles corner to smooth to symmetric, which
 * is fine for one node and no use for forty: where a cycle lands depends on
 * where each node started, so the same three double-clicks leave a mixed
 * selection still mixed. These say which one you want.
 */
describe('continuity shortcuts', () => {
  const scene = (): Harness => {
    /* A corner whose two handles are also different lengths: [12,8] in and
       [26,4] out, so the tangents are [-4,8] and [10,4]. Both properties are
       needed, and two tempting fixtures are useless here. Starting symmetric
       gives Shift+S nothing to do, so the test passes by doing nothing. A corner
       with equal-length handles lands on symmetric when they are made collinear,
       so Shift+S looks broken. `smooth` is distinguishable from `symmetric` only
       when the lengths differ, because length is the only thing separating
       them. */
    const h = harness('M 0 0 C 4 8 12 8 16 0 C 26 4 28 8 32 0');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1)));
    expect(continuityOf(h.store.state.doc.shapes[0].subpaths[0].nodes[1])).toBe('corner');
    return h;
  };

  it('Shift+S makes the selected node smooth', () => {
    const h = scene();
    h.key('S', { shiftKey: true });
    expect(continuityOf(h.store.state.doc.shapes[0].subpaths[0].nodes[1])).toBe('smooth');
  });

  it('Shift+Y makes it symmetric, and Shift+C makes it a corner', () => {
    const h = scene();
    h.key('Y', { shiftKey: true });
    expect(continuityOf(h.store.state.doc.shapes[0].subpaths[0].nodes[1])).toBe('symmetric');
    h.key('C', { shiftKey: true });
    expect(continuityOf(h.store.state.doc.shapes[0].subpaths[0].nodes[1])).toBe('corner');
  });

  it('does nothing without Shift, so typing c, s or y in a field is safe', () => {
    // The tool shortcuts are lowercase and these are capitals for the same
    // reason: a bare letter has to stay available.
    const h = scene();
    const before = continuityOf(h.store.state.doc.shapes[0].subpaths[0].nodes[1]);
    h.key('c');
    h.key('s');
    h.key('y');
    expect(continuityOf(h.store.state.doc.shapes[0].subpaths[0].nodes[1])).toBe(before);
  });

  it('is refused mid-drag, like every other rewrite', () => {
    /* §16's rule: an operation that rewrites the document while a drag holds
       node indices into the array it is about to change folds into the drag's
       batch, and Escape then rolls back both. */
    const h = scene();
    const id = h.store.state.doc.shapes[0].id;
    const before = continuityOf(h.store.state.doc.shapes[0].subpaths[0].nodes[1]);
    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.move([3, 3]);
    h.key('S', { shiftKey: true });
    expect(continuityOf(h.store.state.doc.shapes[0].subpaths[0].nodes[1])).toBe(before);
    h.up();
  });
});

describe('the coarse nudge', () => {
  const scene = (): Harness => {
    const h = harness('M 10 10 L 20 10');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
      s.gridStep = 2;
    });
    return h;
  };

  it('multiplies the grid step by the settable factor', () => {
    const h = scene();
    h.store.update((s) => (s.nudgeBig = 4));
    h.key('ArrowRight', { shiftKey: true });
    // 2 units of grid step, four times over.
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt[0]).toBeCloseTo(18, 9);
  });

  it('still moves one grid step without Shift', () => {
    // The control: without this, a factor applied to both tiers would pass the
    // test above and be wrong.
    const h = scene();
    h.store.update((s) => (s.nudgeBig = 4));
    h.key('ArrowRight');
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt[0]).toBeCloseTo(12, 9);
  });

  it('treats a factor of zero as one rather than pinning the node', () => {
    /* The input floors at 1, but the store is reachable from the source drawer
       and from tests, and a Shift-arrow that moved nothing would read as a
       broken key rather than as a setting. */
    const h = scene();
    h.store.update((s) => (s.nudgeBig = 0));
    h.key('ArrowRight', { shiftKey: true });
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt[0]).toBeCloseTo(12, 9);
  });
});

/**
 * The live measurement in the status strip.
 *
 * The claim worth testing is not that a number appears. It is that the number
 * describes what the DOCUMENT did rather than what the pointer did, because
 * those differ the moment a snap holds something back, and a readout that
 * tracks the pointer is confidently wrong exactly when you need it.
 */
describe('drag measurement', () => {
  it('says nothing when nothing is being dragged', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    expect(h.controller.measure()).toBeNull();
  });

  it('reports the snapped translation, not where the pointer went', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.snapToGrid = true;
      s.gridStep = 5;
      s.snapToPoints = false;
      s.selection = { ...emptySelection(), shapes: new Set([id]) };
    });

    h.down([10, 0], h.outlineEl(id));
    // 13.2 right and 1.9 down rounds to 15 and 0 on a step of 5. The pointer
    // moved 13.3 units at 8.2 degrees; the shape moved 15 at 0.
    h.move([23.2, 1.9]);
    const m = h.controller.measure();
    /* `toEqual` on the whole object would also fail on a sign flip, because it
       separates 0 from -0. That belongs to the angle test below, and a test
       that fails for someone else's reason names the wrong culprit. */
    expect(m?.kind).toBe('vector');
    expect(m && m.kind === 'vector' && m.len).toBeCloseTo(15, 9);
    expect(m && m.kind === 'vector' && m.deg).toBeCloseTo(0, 9);
    // The shape really is where the readout says, so the number is not merely
    // self-consistent with some other bug.
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([15, 0]);
    h.up();
    expect(h.controller.measure()).toBeNull();
  });

  it('measures how far a node moved, not how far the pointer did', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.snapToGrid = true;
      s.gridStep = 5;
      s.snapToPoints = false;
    });

    h.down([0, 0], h.anchorEl(id, 0, 0));
    // Snaps to [5, 10], which is 11.18 away. The pointer is at 10.96 away.
    h.move([6.4, 8.9]);
    const m = h.controller.measure();
    expect(m?.kind).toBe('vector');
    expect(m && m.kind === 'vector' && m.len).toBeCloseTo(Math.hypot(5, 10), 9);
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt).toEqual([5, 10]);
  });

  it('measures a rectangle as its sides, not its diagonal', () => {
    const h = harness();
    h.store.update((s) => {
      s.tool = 'rect';
      s.snapToGrid = false;
    });

    h.down([10, 10]);
    h.move([50, 30]);
    const m = h.controller.measure();
    expect(m).toEqual({ kind: 'box', w: 40, h: 20 });
    // The diagonal is 44.7. A vector reading would have reported that.
    expect(m?.kind).not.toBe('vector');
  });

  it('says nothing while a create drag is too small to have made a shape', () => {
    const h = harness();
    h.store.update((s) => {
      s.tool = 'rect';
      s.snapToGrid = false;
    });
    h.down([10, 10]);
    // No move, so no shape exists yet and there is no geometry to measure.
    expect(h.controller.measure()).toBeNull();
    expect(h.store.state.doc.shapes).toHaveLength(0);
  });

  it('turns clockwise for a positive angle, like the rotate readout', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.snapToGrid = false;
      s.snapToPoints = false;
      s.selection = { ...emptySelection(), shapes: new Set([id]) };
    });

    // Right and DOWN. Document y grows downwards, so this is +45 on screen.
    h.down([10, 0], h.outlineEl(id));
    h.move([20, 10]);
    const down = h.controller.measure();
    expect(down && down.kind === 'vector' && down.deg).toBeCloseTo(45, 9);

    // Right and UP is the mirror, and must not share its sign.
    h.move([20, -10]);
    const up = h.controller.measure();
    expect(up && up.kind === 'vector' && up.deg).toBeCloseTo(-45, 9);
  });

  it('stays silent while panning, which moves the camera and not the drawing', () => {
    const h = harness('M0 0 L20 0 L20 20 Z');
    h.store.update((s) => (s.tool = 'hand'));
    h.down([10, 10]);
    h.move([40, 40]);
    expect(h.controller.measure()).toBeNull();
    expect(h.store.state.camera.x).not.toBe(0);
  });
});

/**
 * Make one shape.
 *
 * The claim is a negative one: it changes NOTHING about the geometry. That is
 * the whole difference between it and `unite`, and it is what makes a hole
 * possible, so the tests below compare curves rather than counting nodes.
 */
describe('make one shape', () => {
  /** Two separate squares, the second wholly inside the first. */
  function two(): Harness {
    const h = harness('M0 0 L40 0 L40 40 L0 40 Z');
    h.store.update((s) => {
      s.doc.shapes.push(shapeFromPath('M10 10 L30 10 L30 30 L10 30 Z'));
      s.selection = {
        ...emptySelection(),
        shapes: new Set(s.doc.shapes.map((sh) => sh.id)),
      };
    });
    return h;
  }

  it('refuses one shape, and says why', () => {
    const h = harness('M0 0 L40 0 L40 40 Z');
    h.store.update((s) => {
      s.selection = { ...emptySelection(), shapes: new Set([s.doc.shapes[0].id]) };
    });
    const r = h.commands.makeOneShape();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/two or more/);
    expect(h.store.state.doc.shapes).toHaveLength(1);
  });

  it('leaves every curve exactly where it was', () => {
    const h = two();
    const before = h.store.state.doc.shapes.map((sh) =>
      serialisePath(sh.subpaths, { decimals: 6 }),
    );

    const r = h.commands.makeOneShape();
    expect(r.ok).toBe(true);

    expect(h.store.state.doc.shapes).toHaveLength(1);
    const after = serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 6 });
    // Concatenation, in document order, character for character. Any rebuild
    // of the outline would fail this even when it looked the same on screen.
    expect(after).toBe(before.join(' '));
  });

  it('keeps both paths where unite would have made one', () => {
    const h = two();
    h.commands.makeOneShape();
    const shape = h.store.state.doc.shapes[0];
    // Two rings, 4 nodes each. Unite of a square containing a square returns
    // the outer square alone, so a single 4-node subpath would mean the wrong
    // operation ran.
    expect(shape.subpaths).toHaveLength(2);
    expect(shape.subpaths.map((sp) => sp.nodes.length)).toEqual([4, 4]);
    // And the inner ring really is inside, so even-odd has a hole to punch.
    expect(shapeBBox(shape)).toEqual({ x0: 0, y0: 0, x1: 40, y1: 40 });
  });

  it('the survivor keeps its id, name and style', () => {
    const h = two();
    const first = h.store.state.doc.shapes[0];
    const id = first.id;
    const name = first.name;
    h.store.update((s) => {
      s.doc.shapes[0].style = { ...s.doc.shapes[0].style, fill: '#111111', fillRule: 'evenodd' };
      s.doc.shapes[1].style = { ...s.doc.shapes[1].style, fill: '#eeeeee' };
    });

    const r = h.commands.makeOneShape();
    const kept = h.store.state.doc.shapes[0];
    expect(kept.id).toBe(id);
    expect(kept.name).toBe(name);
    expect(kept.style.fill).toBe('#111111');
    expect(kept.style.fillRule).toBe('evenodd');
    // The other shape's colour is gone, and the message says so rather than
    // letting it be noticed three steps later.
    expect(r.message).toMatch(/other colours are gone/);
  });

  it('stays quiet about colour when there was none to lose', () => {
    const h = two();
    h.store.update((s) => {
      s.doc.shapes[1].style = { ...s.doc.shapes[0].style };
    });
    expect(h.commands.makeOneShape().message).not.toMatch(/other colours are gone/);
  });

  it('takes them bottom first, which is the order the fill rule reads', () => {
    const h = two();
    const bottom = serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 6 });
    h.commands.makeOneShape();
    const after = serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 6 });
    expect(after.startsWith(bottom)).toBe(true);
  });

  it('is one undo step', () => {
    const h = two();
    const before = h.store.state.doc.shapes.length;
    h.commands.makeOneShape();
    expect(h.store.state.doc.shapes).toHaveLength(1);
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(before);
    // Both shapes are back with their own geometry, not one shape split again.
    expect(h.store.state.doc.shapes.map((sh) => sh.subpaths.length)).toEqual([1, 1]);
  });

  it('answers Shift+P', () => {
    const h = two();
    h.key('P', { shiftKey: true });
    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(2);
  });

  it('ignores a bare p, which is the pen tool', () => {
    const h = two();
    h.key('p');
    expect(h.store.state.doc.shapes).toHaveLength(2);
    expect(h.store.state.tool).toBe('pen');
  });
});

/**
 * Split into shapes, the inverse of Make one shape.
 *
 * The round trip is the test worth having: combine, split, and every curve
 * should be where it started. Node counts would pass while the geometry
 * drifted, so this compares the serialised paths.
 */
describe('split into shapes', () => {
  const OUTER = 'M0 0 L40 0 L40 40 L0 40 Z';
  const INNER = 'M10 10 L30 10 L30 30 L10 30 Z';

  function combined(): Harness {
    const h = harness(OUTER);
    h.store.update((s) => {
      s.doc.shapes.push(shapeFromPath(INNER));
      s.selection = { ...emptySelection(), shapes: new Set(s.doc.shapes.map((sh) => sh.id)) };
    });
    h.commands.makeOneShape();
    return h;
  }

  it('refuses a shape that holds one path, and says which problem it is', () => {
    const h = harness(OUTER);
    h.store.update((s) => {
      s.selection = { ...emptySelection(), shapes: new Set([s.doc.shapes[0].id]) };
    });
    const r = h.commands.splitShapes();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/hold one each/);
    expect(h.store.state.doc.shapes).toHaveLength(1);
  });

  it('asks for a selection when there is none, not for more paths', () => {
    const h = harness(OUTER);
    const r = h.commands.splitShapes();
    expect(r.ok).toBe(false);
    // The other refusal would send someone looking for a second path when the
    // actual fix is to click a shape.
    expect(r.message).toMatch(/needs a shape selected/);
  });

  it('survives the round trip with every curve where it started', () => {
    const h = harness(OUTER);
    h.store.update((s) => {
      s.doc.shapes.push(shapeFromPath(INNER));
      s.selection = { ...emptySelection(), shapes: new Set(s.doc.shapes.map((sh) => sh.id)) };
    });
    const before = h.store.state.doc.shapes.map((sh) =>
      serialisePath(sh.subpaths, { decimals: 6 }),
    );

    h.commands.makeOneShape();
    const r = h.commands.splitShapes();
    expect(r.ok).toBe(true);

    const after = h.store.state.doc.shapes.map((sh) =>
      serialisePath(sh.subpaths, { decimals: 6 }),
    );
    expect(after).toEqual(before);
  });

  it('keeps the original id and name on the first, and numbers the rest', () => {
    const h = combined();
    const id = h.store.state.doc.shapes[0].id;
    const name = h.store.state.doc.shapes[0].name;

    h.commands.splitShapes();
    const shapes = h.store.state.doc.shapes;
    expect(shapes).toHaveLength(2);
    expect(shapes[0].id).toBe(id);
    expect(shapes[0].name).toBe(name);
    expect(shapes[1].name).toBe(`${name} 2`);
    expect(shapes[1].id).not.toBe(id);
  });

  it('inserts the new shapes behind the original, so paint order holds', () => {
    const h = combined();
    // A third shape after the combined one. Splitting must not jump the pieces
    // over it, which is what pushing to the end of the list would do.
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M100 100 L110 100 L110 110 Z')));
    const lastId = h.store.state.doc.shapes[1].id;
    h.store.update((s) => {
      s.selection = { ...emptySelection(), shapes: new Set([s.doc.shapes[0].id]) };
    });

    h.commands.splitShapes();
    const order = h.store.state.doc.shapes.map((sh) => sh.id);
    expect(order).toHaveLength(3);
    expect(order[2]).toBe(lastId);
  });

  it('gives every piece the original style, so the hole becomes a shape', () => {
    const h = combined();
    h.store.update((s) => {
      s.doc.shapes[0].style = {
        fill: '#123456',
        stroke: '#654321',
        strokeWidth: 3,
        fillRule: 'evenodd',
      };
    });

    h.commands.splitShapes();
    for (const sh of h.store.state.doc.shapes) {
      expect(sh.style.fill).toBe('#123456');
      expect(sh.style.strokeWidth).toBe(3);
    }
    // Each is its own object, so recolouring one does not recolour the other.
    h.store.edit((s) => (s.doc.shapes[0].style.fill = '#ffffff'));
    expect(h.store.state.doc.shapes[1].style.fill).toBe('#123456');
  });

  it('selects every piece it made', () => {
    const h = combined();
    h.commands.splitShapes();
    const ids = h.store.state.doc.shapes.map((sh) => sh.id);
    expect([...h.store.state.selection.shapes].sort()).toEqual([...ids].sort());
  });

  it('leaves a single-path shape alone while splitting its neighbour', () => {
    const h = combined();
    h.store.update((s) => {
      s.doc.shapes.push(shapeFromPath('M100 100 L110 100 L110 110 Z'));
      s.selection = { ...emptySelection(), shapes: new Set(s.doc.shapes.map((sh) => sh.id)) };
    });
    const r = h.commands.splitShapes();
    expect(r.ok).toBe(true);
    // Two from the split, plus the untouched one.
    expect(h.store.state.doc.shapes).toHaveLength(3);
    expect(r.message).toMatch(/split into 2 shapes/);
  });

  it('is one undo step', () => {
    const h = combined();
    h.commands.splitShapes();
    expect(h.store.state.doc.shapes).toHaveLength(2);
    h.store.undo();
    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(2);
  });

  it('answers Shift+K', () => {
    const h = combined();
    h.key('K', { shiftKey: true });
    expect(h.store.state.doc.shapes).toHaveLength(2);
  });

  it('offers itself only when something can actually be split', () => {
    const h = combined();
    expect(h.commands.canSplitShapes()).toBe(true);
    h.commands.splitShapes();
    // Now every shape holds one path, so the button must go back to disabled
    // even though two shapes are selected.
    expect(h.store.state.selection.shapes.size).toBe(2);
    expect(h.commands.canSplitShapes()).toBe(false);
  });
});

/**
 * Dragging the curve itself.
 *
 * Drawing the bend control only where the two handles are symmetric covers a
 * minority of the segments in any drawing that has been edited. The tests below
 * are about the majority case.
 */
describe('bend control on any segment', () => {
  /* Both bow downwards, into positive y. The harness camera starts at the
     origin, so a curve arching up puts its own midpoint out of view and the
     control is culled before it is drawn. */
  /** Both handles pointing different ways and different lengths. */
  const SKEW = 'M0 0 C 5 12 25 -4 30 0';
  /** Mirror image handles: what `bendOf` can read as two numbers. */
  const SYMM = 'M0 0 C 10 10 20 10 30 0';

  function scene(d: string): Harness {
    const h = harness(d);
    h.store.update((s) => {
      s.selection = { ...emptySelection(), shapes: new Set([s.doc.shapes[0].id]) };
    });
    return h;
  }

  function bendEl(h: Harness, seg = 0): Element {
    h.controller.render();
    const el = h.canvas.overlay.querySelector(`[data-hit="bend"][data-seg="${seg}"]`);
    if (!el) throw new Error(`no bend control for segment ${seg}`);
    return el;
  }

  /** Where the dot is drawn, in document coordinates. */
  function bendAt(h: Harness, seg = 0): [number, number] {
    const el = bendEl(h, seg);
    return [Number(el.getAttribute('cx')), Number(el.getAttribute('cy'))];
  }

  it('draws a control on an asymmetric segment', () => {
    const h = scene(SKEW);
    // The heart of it: `bendOf` returns null here, so anything that gates the
    // dot on a non-null bend draws nothing on exactly this segment.
    expect(segmentBend(h.store.state.doc.shapes[0].subpaths[0], 0)).toBeNull();
    expect(() => bendEl(h)).not.toThrow();
  });

  it('draws it on the curve, not on the chord', () => {
    const h = scene(SKEW);
    const drawn = bendAt(h);
    const mid = cubicAt(segmentAsCubic(h.store.state.doc.shapes[0].subpaths[0], 0), 0.5);
    expect(drawn[0]).toBeCloseTo(mid[0], 9);
    expect(drawn[1]).toBeCloseTo(mid[1], 9);
    // The chord's midpoint is [15, 0] and the curve's is not, so a control
    // placed on the chord would have passed a laxer test.
    expect(Math.hypot(drawn[0] - 15, drawn[1] - 0)).toBeGreaterThan(0.5);
  });

  it('drags an asymmetric curve through the pointer', () => {
    const h = scene(SKEW);
    h.store.update((s) => (s.snapToGrid = false));
    const start = bendAt(h);

    h.down(start, bendEl(h));
    h.move([14, 16]);
    h.up();

    const mid = cubicAt(segmentAsCubic(h.store.state.doc.shapes[0].subpaths[0], 0), 0.5);
    expect(mid[0]).toBeCloseTo(14, 6);
    expect(mid[1]).toBeCloseTo(16, 6);
  });

  it('leaves a symmetric segment symmetric', () => {
    const h = scene(SYMM);
    h.store.update((s) => (s.snapToGrid = false));
    expect(segmentBend(h.store.state.doc.shapes[0].subpaths[0], 0)).not.toBeNull();

    h.down(bendAt(h), bendEl(h));
    h.move([12, 14]);
    h.up();

    // Still readable as two numbers, which is the property the constrained
    // edit exists to preserve.
    expect(segmentBend(h.store.state.doc.shapes[0].subpaths[0], 0)).not.toBeNull();
  });

  it('Alt breaks the symmetry, the same key that breaks a handle pair', () => {
    const h = scene(SYMM);
    h.store.update((s) => (s.snapToGrid = false));

    h.down(bendAt(h), bendEl(h), { altKey: true });
    h.move([9, 16]);
    h.up();

    const sp = h.store.state.doc.shapes[0].subpaths[0];
    // Off the perpendicular bisector, so no symmetric bend can describe it.
    expect(segmentBend(sp, 0)).toBeNull();
    const mid = cubicAt(segmentAsCubic(sp, 0), 0.5);
    expect(mid[0]).toBeCloseTo(9, 6);
    expect(mid[1]).toBeCloseTo(16, 6);
  });

  it('is one undo step, and gives the curve back', () => {
    const h = scene(SKEW);
    h.store.update((s) => (s.snapToGrid = false));
    const before = serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 6 });

    h.down(bendAt(h), bendEl(h));
    h.move([14, 16]);
    h.move([18, 20]);
    h.up();
    expect(serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 6 })).not.toBe(before);

    h.store.undo();
    expect(serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 6 })).toBe(before);
  });
});

describe('auto-smooth nodes through the controller', () => {
  /* The model tests own the arithmetic. What only the controller can show is
     that the sweep runs after every edit it makes, and that taking hold of a
     handle hands control back -- without which the drag would be undone by the
     sweep at the end of the same edit, with nothing on screen to say why. */
  const withRun = (): Harness => harness('M10 10 L30 10 L50 10');

  const handleEl = (h: Harness, which: 'in' | 'out', i: number): Element => {
    h.controller.render();
    const shape = h.store.state.doc.shapes[0].id;
    const el = h.canvas.overlay.querySelector(
      `[data-hit="${which}"][data-shape="${shape}"][data-sp="0"][data-i="${i}"]`,
    );
    if (!el) throw new Error(`no ${which} handle for node ${i}`);
    return el;
  };

  it('re-derives when a neighbour is dragged', () => {
    const h = withRun();
    const shape = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, shape, 0, 1)));
    h.commands.setSelectedAuto();

    const before = [...h.store.state.doc.shapes[0].subpaths[0].nodes[1].hOut!];

    // Drag the far node down. The auto node in the middle should re-aim.
    h.store.update((s) => {
      s.selection.nodes.clear();
      s.selection.nodes.add(nodeIdAt(s.doc, shape, 0, 2));
    });
    h.down([50, 10], h.anchorEl(shape, 0, 2));
    h.move([50, 40]);
    h.up();

    const after = h.store.state.doc.shapes[0].subpaths[0].nodes[1].hOut!;
    expect(after).not.toEqual(before);
    // Still on the chord between its neighbours, which now slopes.
    const n = h.store.state.doc.shapes[0].subpaths[0].nodes[1];
    const chord = [50 - 10, 40 - 10];
    const out = [n.hOut![0] - n.pt[0], n.hOut![1] - n.pt[1]];
    expect(out[0] * chord[1] - out[1] * chord[0]).toBeCloseTo(0, 6);
  });

  it('hands control back when its own handle is dragged', () => {
    const h = withRun();
    const shape = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, shape, 0, 1)));
    h.commands.setSelectedAuto();
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[1].auto).toBe(true);

    const el = handleEl(h, 'out', 1);
    const at = [Number(el.getAttribute('cx')), Number(el.getAttribute('cy'))] as [number, number];
    h.down(at, el);
    h.move([at[0], at[1] + 12]);
    h.up();

    const n = h.store.state.doc.shapes[0].subpaths[0].nodes[1];
    expect(n.auto).toBeUndefined();
    // And the drag actually took: the handle is where it was dragged to, not
    // back where the sweep would have put it.
    expect(n.hOut![1]).toBeGreaterThan(at[1] + 6);
  });
});

describe('two fingers', () => {
  /* The default stub maps client pixels to document units through a fixed
     scale that knows nothing about the camera, which is enough for every test
     above and useless for this one: a gesture whose whole job is to move the
     camera cannot be measured against a mapping that ignores it. So the pinch
     tests install a live one, and then ask the question the gesture exists to
     answer -- is the point you put your fingers on still under them.

     A pointer event carries one pointer, so two fingers moving arrive as two
     events and never as one. Between them the fingers are briefly at a distance
     neither started nor ended at, so the camera passes through a zoom that the
     second event undoes. That is why what is asserted is the invariant per
     gesture rather than an arithmetic identity per event: the second holds only
     for fingers that move in perfect step, which no hand does. */
  const liveCamera = (h: Harness): void => {
    Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', {
      configurable: true,
      value: () => {
        const c = h.store.state.camera;
        const k = WIDTH / c.w; // client pixels per document unit
        return new FakeMatrix(k, 0, 0, k, -c.x * k, -c.y * k);
      },
    });
  };

  /** Where a client point lands in the document, at the camera as it is now. */
  const docAt = (h: Harness, client: [number, number]): [number, number] =>
    screenToDoc(h.canvas.overlay, client[0], client[1]) as [number, number];

  it('zooms in when the fingers spread, about the point between them', () => {
    const h = harness('M 10 10 L 30 10 L 30 30 Z');
    liveCamera(h);
    const before = h.store.state.camera.w;
    const mid: [number, number] = [400, 300];
    const under = docAt(h, mid);

    h.touch('down', 1, [200, 300]);
    h.touch('down', 2, [600, 300]);
    h.touch('move', 1, [100, 300]);
    h.touch('move', 2, [700, 300]);

    // 400 apart to 600 apart is two thirds of the width, which is zooming in.
    expect(h.store.state.camera.w).toBeCloseTo((before * 2) / 3, 6);
    expect(h.store.state.camera.w).toBeLessThan(before);
    // The midpoint never moved, so what was under it is still under it.
    expect(docAt(h, mid)[0]).toBeCloseTo(under[0], 9);
    expect(docAt(h, mid)[1]).toBeCloseTo(under[1], 9);
  });

  it('zooms out when they close', () => {
    const h = harness();
    liveCamera(h);
    const before = h.store.state.camera.w;
    h.touch('down', 1, [100, 300]);
    h.touch('down', 2, [700, 300]);
    h.touch('move', 1, [200, 300]);
    h.touch('move', 2, [600, 300]);
    expect(h.store.state.camera.w).toBeCloseTo((before * 600) / 400, 6);
  });

  it('drags the drawing along when both fingers travel', () => {
    const h = harness();
    liveCamera(h);
    const before = { ...h.store.state.camera };
    const under = docAt(h, [400, 300]);

    // Both right by 100 client pixels and down by 50, so they end as far apart
    // as they began and the gesture is a pan.
    h.touch('down', 1, [200, 300]);
    h.touch('down', 2, [600, 300]);
    h.touch('move', 1, [300, 350]);
    h.touch('move', 2, [700, 350]);

    const c = h.store.state.camera;
    expect(c.w).toBeCloseTo(before.w, 9);
    // What was under the fingers travelled with them, all 100 and 50 of it.
    expect(docAt(h, [500, 350])[0]).toBeCloseTo(under[0], 9);
    expect(docAt(h, [500, 350])[1]).toBeCloseTo(under[1], 9);
    // Which is the camera moving the other way, since the drawing did not move.
    expect(c.x).toBeCloseTo(before.x - 100 * SCALE, 9);
    expect(c.y).toBeCloseTo(before.y - 50 * SCALE, 9);
  });

  it('abandons the drag the first finger started, and closes its batch', () => {
    /* The first finger lands before there is any way to know a second is
       coming, so it starts a drag on whatever it hit, and by the time the
       second arrives that drag may already have moved a node.

       Two things have to happen to it. The edit is rolled back, which is
       visible in the drawing. The batch is closed, which is not visible at all:
       a batch left open makes `checkpoint` return early for the rest of the
       session, so nothing is ever undoable again and nothing on screen says so.
       The second is why the later edit below is part of this test. */
    const h = harness('M0 0 L10 0 L10 10 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => (s.snapToGrid = false));
    const before = serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 9 });

    h.down([0, 0], h.anchorEl(id, 0, 0));
    h.move([5, 5]); // the node is now somewhere it was not
    expect(serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 9 })).not.toBe(before);

    h.touch('down', 1, [200, 300]);
    h.touch('down', 2, [600, 300]);
    h.touch('move', 1, [100, 300]);
    h.touch('move', 2, [700, 300]);
    h.touch('up', 1, [100, 300]);
    h.touch('up', 2, [700, 300]);

    expect(serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 9 })).toBe(before);
    expect(h.store.state.camera.w).toBeLessThan(WIDTH * SCALE);

    // History still works, which is the half of this that has no symptom.
    h.store.edit((s) => (s.doc.shapes[0].name = 'later'));
    expect(h.store.canUndo).toBe(true);
    h.store.undo();
    expect(h.store.state.doc.shapes[0].name).not.toBe('later');
  });

  it('stops zooming when a finger lifts, and does not draw with the other', () => {
    const h = harness('M 10 10 L 30 10 L 30 30 Z');
    h.touch('down', 1, [200, 300]);
    h.touch('down', 2, [600, 300]);
    h.touch('move', 1, [100, 300]);
    h.touch('move', 2, [700, 300]);
    const after = { ...h.store.state.camera };
    const shape = serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 9 });

    h.touch('up', 2, [700, 300]);
    // The finger still down travels a long way. Nothing follows it.
    h.touch('move', 1, [400, 100]);
    h.touch('up', 1, [400, 100]);

    expect(h.store.state.camera).toEqual(after);
    expect(serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 9 })).toBe(shape);
  });

  it('is not started by one finger', () => {
    const h = harness();
    liveCamera(h);
    const before = { ...h.store.state.camera };
    h.touch('down', 1, [200, 300]);
    h.touch('move', 1, [400, 100]);
    expect(h.store.state.camera).toEqual(before);
    h.touch('up', 1, [400, 100]);
  });

  it('is not started by two pointers that are not fingers', () => {
    /* A drawing tablet reports the pen and the mouse as separate pointers with
       separate ids, and a press from each is two live pointers that are not a
       pinch. Counting every pointer type instead of touches would zoom the
       canvas in the middle of drawing with the pen. */
    const h = harness('M0 0 L10 0 L10 10 Z');
    liveCamera(h);
    const before = { ...h.store.state.camera };

    const other = (type: string, id: number, kind: string, at: [number, number]): void => {
      const e = new MouseEvent(`pointer${type}`, {
        clientX: at[0],
        clientY: at[1],
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(e, 'pointerId', { value: id });
      Object.defineProperty(e, 'pointerType', { value: kind });
      Object.defineProperty(e, 'button', { value: 0 });
      h.canvas.overlay.dispatchEvent(e);
    };

    other('down', 7, 'pen', [200, 300]);
    other('down', 8, 'mouse', [600, 300]);
    other('move', 7, 'pen', [100, 300]);
    other('move', 8, 'mouse', [700, 300]);
    expect(h.store.state.camera).toEqual(before);
  });
});

describe('Shift and Alt without a keyboard', () => {
  /* Seven pointer gestures change meaning under a modifier, and a phone has no
     key to hold. Two buttons in the status strip latch them instead, and the
     controller asks for the latch beside the real key rather than instead of
     it. What these check is that the two routes arrive at the same place, and
     that the latch stops at the pointer: a Shift left on for a drag must not
     turn every later key press into its Shift variant. */

  it('constrains a drawn shape the same way the key does', () => {
    const held = harness();
    held.store.update((s) => {
      s.tool = 'ellipse';
      s.heldShift = true;
    });
    held.down([0, 0]);
    held.move([30, 10]);
    held.up();

    const keyed = harness();
    keyed.store.update((s) => (s.tool = 'ellipse'));
    keyed.down([0, 0]);
    keyed.move([30, 10], { shiftKey: true });
    keyed.up();

    const pts = (h: Harness): number[][] =>
      h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt);
    // A circle of radius 5, from the smaller span, and not a 15 by 5 ellipse.
    expect(pts(held)).toEqual([
      [10, 5],
      [5, 10],
      [0, 5],
      [5, 0],
    ]);
    expect(pts(held)).toEqual(pts(keyed));
  });

  it('scales from the centre with the latch, as Alt does', () => {
    const h = harness('M10 5 L50 5 L50 25 L10 25 Z');
    h.store.update((s) => {
      s.selection.shapes.add(s.doc.shapes[0].id);
      s.snapToGrid = false;
      s.heldAlt = true;
    });
    const grip = h.gripEl('scale', 'se');
    h.down(grip.at, grip.el);
    h.move([grip.at[0] - 10, grip.at[1]]);
    h.up();

    const xs = h.store.state.doc.shapes[0].subpaths[0].nodes.map((n) => n.pt[0]);
    // The centre held at 30 rather than the west edge holding at 10.
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(30, 6);
  });

  it('adds to the selection with the latch, as Shift-click does', () => {
    const h = harness('M10 10 L30 10 L30 30 Z');
    const id = h.store.state.doc.shapes[0].id;

    h.down([10, 10], h.anchorEl(id, 0, 0));
    h.up();
    expect(h.store.state.selection.nodes.size).toBe(1);

    h.store.update((s) => (s.heldShift = true));
    h.down([30, 10], h.anchorEl(id, 0, 1));
    h.up();
    expect(h.store.state.selection.nodes.size).toBe(2);
  });

  it('stops at the pointer: a latched Shift does not reach the keyboard', () => {
    /* `Shift` on an arrow key is the coarse nudge, ten times the fine one. If
       the latch were read there too, turning it on to draw a square would
       silently make every arrow key move ten times as far. */
    const h = harness('M10 10 L30 10 L30 30 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 0));
      s.gridStep = 1;
      s.nudgeBig = 10;
      s.heldShift = true;
    });

    h.key('ArrowRight');
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt[0]).toBeCloseTo(11, 9);

    // And the key itself still does what it always did.
    h.key('ArrowRight', { shiftKey: true });
    expect(h.store.state.doc.shapes[0].subpaths[0].nodes[0].pt[0]).toBeCloseTo(21, 9);
  });
});

describe('two fingers, at the edges of the gesture', () => {
  /* Written after a mutation sweep: each of these three covers a guard that
     survived being deleted, which means nothing was checking it. */

  const liveCamera = (h: Harness): void => {
    Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', {
      configurable: true,
      value: () => {
        const c = h.store.state.camera;
        const k = WIDTH / c.w;
        return new FakeMatrix(k, 0, 0, k, -c.x * k, -c.y * k);
      },
    });
  };

  const finite = (h: Harness): boolean =>
    [h.store.state.camera.x, h.store.state.camera.y, h.store.state.camera.w, h.store.state.camera.h]
      .every((n) => Number.isFinite(n) && Math.abs(n) < 1e9);

  it('survives two fingers landing on the same spot', () => {
    /* Distance zero is a division by zero, and the camera comes back `NaN`
       from it: the view is gone and every later gesture works on a viewBox
       that cannot be drawn. Two fingers touch down together often enough that
       this is a real press, not a contrived one. */
    const h = harness();
    liveCamera(h);
    const before = { ...h.store.state.camera };

    h.touch('down', 1, [300, 300]);
    h.touch('down', 2, [300, 300]);
    h.touch('move', 1, [300.2, 300]);
    h.touch('move', 2, [299.8, 300]);
    expect(finite(h)).toBe(true);

    // And once they are properly apart it zooms, rather than staying stuck.
    h.touch('move', 1, [200, 300]);
    h.touch('move', 2, [600, 300]);
    expect(finite(h)).toBe(true);
    expect(h.store.state.camera.w).not.toBeCloseTo(before.w, 6);
  });

  it('forgets a finger the browser takes away', () => {
    /* `pointercancel` is the browser claiming the gesture. A finger left in the
       map after one keeps the pinch alive, so the next single finger to move is
       read as half of a two-finger gesture and zooms the canvas on its own. */
    const h = harness();
    liveCamera(h);
    h.touch('down', 1, [200, 300]);
    h.touch('down', 2, [600, 300]);
    h.touch('move', 1, [100, 300]);

    const cancel = new MouseEvent('pointercancel', { bubbles: true, cancelable: true });
    Object.defineProperty(cancel, 'pointerId', { value: 2 });
    Object.defineProperty(cancel, 'pointerType', { value: 'touch' });
    h.canvas.overlay.dispatchEvent(cancel);

    const after = { ...h.store.state.camera };
    h.touch('move', 1, [700, 100]);
    expect(h.store.state.camera).toEqual(after);
  });

  it('ignores a third finger rather than starting a gesture with it', () => {
    /* A palm, or a hand resting on the glass, costs nothing.
       **This one passes without the guard it was written for**, and it is kept
       as the statement of the promise rather than as a check on the guard. Two
       mechanisms hold it up: a third press does start a marquee when the guard
       is removed, but its moves are swallowed while the pinch is live, and the
       first release afterwards resets the drag. The guard says the same thing
       in one line and does not depend on either. */
    const h = harness('M 10 10 L 30 10 L 30 30 Z');
    liveCamera(h);
    h.store.update((s) => (s.snapToGrid = false));
    const before = serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 9 });

    h.touch('down', 1, [200, 300]);
    h.touch('down', 2, [600, 300]);
    h.touch('down', 3, [50, 50]); // the palm, on empty canvas
    h.touch('move', 1, [100, 300]);
    h.touch('move', 2, [700, 300]);
    h.touch('up', 1, [100, 300]);
    h.touch('up', 2, [700, 300]);

    // Only the palm is left, and it travels across the whole drawing.
    h.touch('move', 3, [700, 500]);
    h.touch('up', 3, [700, 500]);

    expect(h.store.state.selection.nodes.size).toBe(0);
    expect(h.store.state.selection.shapes.size).toBe(0);
    expect(serialisePath(h.store.state.doc.shapes[0].subpaths, { decimals: 9 })).toBe(before);
    // The pinch still happened, so the third finger cost nothing either way.
    expect(h.store.state.camera.w).toBeLessThan(WIDTH * SCALE);
  });
});

/* The mid-drag refusal had no test at all, and in that silence Shift+P and
   Shift+K reached the switch without joining its key list. Both rewrite
   `st.doc.shapes` outright, which is exactly what the guard exists to keep out
   of a live drag. */
describe('keyboard guard', () => {
  /* Read out of the source rather than restated here. A list written twice is
     a list that agrees with itself and with nothing else, and this file's job
     is to disagree when the switch grows a case the guard has not heard of. */
  const source = keySource;

  /* The selection is made after the press, not before it. A marquee begins by
     clearing the selection, so a document operation fired mid-marquee has
     nothing to act on and leaves the document alone whether the guard runs or
     not -- which passed with the guard deleted, and measured nothing. */
  const TWO_SUBPATHS = 'M10 10 L40 10 L40 40 Z M50 50 L70 50 L70 70 Z';

  /* Two shapes, not one shape of two subpaths -- `shapeFromPath` produces the
     second, and Shift+P then refuses for want of a second shape rather than
     because of the guard. A key that would refuse anyway measures nothing in
     either direction, which is why Shift+J is not in the list below: it joins
     open endpoints and every subpath here is closed. */
  function twoShapes(): Harness {
    const h = harness(TWO_SUBPATHS);
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M90 90 L120 90 L120 120 Z')));
    return h;
  }

  /* Selected by hand rather than by marquee, and always after the gesture that
     precedes it. A marquee clears the selection when it starts and replaces it
     when it ends, so a selection made on the wrong side of either is empty by
     the time the key arrives -- and an operation with nothing to act on leaves
     the document alone whether the guard runs or not. Written that way once,
     it passed with the guard deleted. */
  function selectEverything(h: Harness): void {
    h.store.update((s) => {
      s.selection.shapes = new Set(s.doc.shapes.map((sh) => sh.id));
      s.selection.nodes = new Set(
        s.doc.shapes.flatMap((sh) =>
          sh.subpaths.flatMap((sp, pi) => sp.nodes.map((_, ni) => nodeIdAt(s.doc, sh.id, pi, ni))),
        ),
      );
    });
  }

  for (const key of ['Delete', 'P', 'K', 'R']) {
    it(`refuses ${key} while a drag is live`, () => {
      const h = twoShapes();
      h.down([5, 5]);
      h.move([8, 8]);
      selectEverything(h);
      const before = exportSvg(h.store.state.doc);
      h.key(key, { shiftKey: true });
      expect(exportSvg(h.store.state.doc)).toBe(before);
      h.up();
    });

    it(`lets ${key} through once the drag is over`, () => {
      const h = twoShapes();
      h.down([5, 5]);
      h.move([8, 8]);
      h.up();
      selectEverything(h);
      const before = exportSvg(h.store.state.doc);
      h.key(key, { shiftKey: true });
      expect(exportSvg(h.store.state.doc)).not.toBe(before);
    });
  }

  it('guards every capital the switch handles', () => {
    const body = source.slice(source.indexOf('const rewrites = ['));
    const listed = new Set(
      [...body.slice(0, body.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1]),
    );
    const capitals = new Set(
      [...body.matchAll(/case '([A-Z])':/g)].map((m) => m[1]),
    );
    expect(capitals.size).toBeGreaterThan(8);
    expect([...capitals].filter((k) => !listed.has(k)).sort()).toEqual([]);
  });
});

/**
 * Which of a control and the document owns a key press.
 *
 * Reported from use: Ctrl+Z did nothing. It works from the canvas, and the rail
 * is 33 numbers, two colours and 21 checkboxes, so the moment right after typing
 * a value into one of them is both when undo is most wanted and where it was
 * unreachable.
 */
describe('undo from inside a control', () => {
  /* Appended to the document and dispatched so it bubbles: the listener is on
     the window, and what the guard reads is `e.target`. A detached element
     reaches neither. */
  function control(tag: 'input' | 'textarea', type?: string): HTMLElement {
    const el = document.createElement(tag);
    if (el instanceof HTMLInputElement && type) el.type = type;
    document.body.append(el);
    el.focus();
    return el;
  }

  const pressIn = (el: HTMLElement, key: string, opts: KeyboardEventInit = {}): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
  };

  /** A harness with one edit on the undo stack, and the export from before it. */
  function edited(): { h: Harness; before: string } {
    const h = harness('M10 10 L40 10 L40 40 Z');
    const before = exportSvg(h.store.state.doc);
    h.store.edit((s) => (s.doc.shapes[0].subpaths[0].nodes[0].pt = [25, 25]));
    expect(exportSvg(h.store.state.doc)).not.toBe(before);
    return { h, before };
  }

  for (const type of ['number', 'color', 'checkbox']) {
    it(`reaches the document from a ${type} field, which has no undo of its own`, () => {
      const { h, before } = edited();
      pressIn(control('input', type), 'z', { ctrlKey: true });
      expect(exportSvg(h.store.state.doc)).toBe(before);
    });
  }

  it('redoes from one too, so the pair is reachable from the same place', () => {
    const { h, before } = edited();
    const after = exportSvg(h.store.state.doc);
    const el = control('input', 'number');
    pressIn(el, 'z', { ctrlKey: true });
    expect(exportSvg(h.store.state.doc)).toBe(before);
    pressIn(control('input', 'number'), 'z', { ctrlKey: true, shiftKey: true });
    expect(exportSvg(h.store.state.doc)).toBe(after);
  });

  /* The other half of the rule, and the reason it is not a blanket pass. Text
     carries an edit history the browser owns, so the chord belongs to it. */
  it('leaves the document alone when the press came from a textarea', () => {
    const { h } = edited();
    const after = exportSvg(h.store.state.doc);
    pressIn(control('textarea'), 'z', { ctrlKey: true });
    expect(exportSvg(h.store.state.doc)).toBe(after);
  });

  it('leaves the document alone when the press came from a text input', () => {
    const { h } = edited();
    const after = exportSvg(h.store.state.doc);
    pressIn(control('input', 'text'), 'z', { ctrlKey: true });
    expect(exportSvg(h.store.state.doc)).toBe(after);
  });

  /* Focus has to leave, and this is the assertion that says why. A field commits
     on blur, so a value typed and not committed is filed by the blur and taken
     back by the undo. Undoing with focus still inside leaves the field holding
     text the document has already disagreed with, and it lands on the next blur. */
  it('takes focus out of the field, so nothing uncommitted lands later', () => {
    const { h, before } = edited();
    const el = control('input', 'number');
    expect(document.activeElement).toBe(el);
    pressIn(el, 'z', { ctrlKey: true });
    expect(document.activeElement).not.toBe(el);
    expect(exportSvg(h.store.state.doc)).toBe(before);
  });

  /* Every other key still belongs to the control, which is what the guard was
     there for in the first place. */
  it('still gives a bare letter to the control it landed in', () => {
    const h = harness('M10 10 L40 10 L40 40 Z');
    h.store.update((s) => (s.tool = 'pen'));
    pressIn(control('input', 'number'), 'v');
    expect(h.store.state.tool).toBe('pen');
  });

  it('still gives Delete to the control it landed in', () => {
    const h = harness('M10 10 L40 10 L40 40 Z');
    h.store.update((s) => {
      s.selection.shapes = new Set(s.doc.shapes.map((sh) => sh.id));
    });
    const before = exportSvg(h.store.state.doc);
    pressIn(control('input', 'number'), 'Delete');
    expect(exportSvg(h.store.state.doc)).toBe(before);
  });
});

/* Reported from use: dragging a box around two shapes and pressing Combine was
   refused for want of two selected shapes, and clicking each shape in turn
   worked. The marquee was adding every enclosed node and adding the shape only
   when no node had been added -- a condition its own node loop had just
   falsified. */
describe('a marquee round whole shapes', () => {
  const two = (): Harness => {
    const h = harness('M10 10 L20 10 L20 20 Z');
    h.store.update((s) => s.doc.shapes.push(shapeFromPath('M40 40 L50 40 L50 50 Z')));
    h.controller.render();
    return h;
  };
  const sweep = (h: Harness, from: [number, number], to: [number, number]): void => {
    h.down(from);
    h.move(to);
    h.up();
  };

  it('selects the shapes it swallowed whole, not only their nodes', () => {
    const h = two();
    sweep(h, [5, 5], [60, 60]);
    expect(h.store.state.selection.shapes.size).toBe(2);
    expect(h.store.state.selection.nodes.size).toBe(6);
  });

  it('lets Combine act on them, which is what was reported broken', () => {
    const h = two();
    sweep(h, [5, 5], [60, 60]);
    expect(h.commands.makeOneShape().ok).toBe(true);
    expect(h.store.state.doc.shapes).toHaveLength(1);
    expect(h.store.state.doc.shapes[0].subpaths).toHaveLength(2);
  });

  it('leaves a partly caught shape out of the shape selection', () => {
    const h = two();
    sweep(h, [5, 5], [15, 15]);
    expect(h.store.state.selection.shapes.size).toBe(0);
    expect(h.store.state.selection.nodes.size).toBe(1);
  });
});

/* The point of `PathNode.id`. Under positional keys the selection named
   `shape/sp/index`, so removing an earlier node slid a different node under the
   same name and the next operation acted on it. Measured by where the selected
   node IS, because an index that is still 2 proves nothing about which node
   index 2 now holds. */
describe('a selection survives an edit that moves indices', () => {
  it('still names the same node after an earlier one is removed', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0 L40 0');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 3)));
    expect(resolveNodes(h.store.state.doc, h.store.state.selection).map((r) => r.pt)).toEqual([
      [30, 0],
    ]);

    h.store.update((s) => s.doc.shapes[0].subpaths[0].nodes.splice(0, 1));

    const after = resolveNodes(h.store.state.doc, h.store.state.selection);
    expect(after.map((r) => r.pt), 'the selection followed the node').toEqual([[30, 0]]);
    expect(after[0].ref.i, 'and its index moved under it').toBe(2);
  });

  it('resolves a deleted node to nothing rather than to its successor', () => {
    const h = harness('M0 0 L10 0 L20 0 L30 0');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 1)));
    h.store.update((s) => s.doc.shapes[0].subpaths[0].nodes.splice(1, 1));
    expect(resolveNodes(h.store.state.doc, h.store.state.selection)).toEqual([]);
  });

  it('keeps naming the same node across an undo', () => {
    const h = harness('M0 0 L10 0 L20 0');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(nodeIdAt(s.doc, id, 0, 2)));
    h.store.checkpoint();
    h.store.edit((s) => (s.doc.shapes[0].subpaths[0].nodes[2].pt = [99, 99]));
    h.store.undo();
    expect(resolveNodes(h.store.state.doc, h.store.state.selection).map((r) => r.pt)).toEqual([
      [20, 0],
    ]);
  });
});
