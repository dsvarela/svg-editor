/**
 * @vitest-environment jsdom
 *
 * Guide gestures, against the history rules the store sets out.
 *
 * `edit` checkpoints first and asks questions later, which is right for a drag
 * and wrong for a press that turns out to change nothing. Three of the four
 * ways a guide gesture can end change nothing, and each of them used to leave
 * an undo entry that undoes to the same state and throws the redo stack away.
 * These are the cases; `test/controller.test.ts` explains the harness.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Canvas } from '../src/view/canvas';
import { Controller } from '../src/tools/controller';
import { Store } from '../src/model/store';
import { emptyDoc, shapeFromPath } from '../src/model/doc';

const SCALE = 0.1;
const WIDTH = 800;
const HEIGHT = 600;

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

function stub(): void {
  vi.stubGlobal('DOMPoint', FakePoint);
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
  Element.prototype.setPointerCapture = (): void => {};
  Element.prototype.releasePointerCapture = (): void => {};
  Element.prototype.hasPointerCapture = (): boolean => false;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
}

interface Rig {
  store: Store;
  controller: Controller;
  canvas: Canvas;
  rulerH: SVGSVGElement;
  rulerV: SVGSVGElement;
  /** A pointer event in document coordinates, at whatever element you name. */
  at(type: string, doc: [number, number], target: Element): void;
  guideEl(i: number): Element;
}

function rig(): Rig {
  stub();
  const root = document.createElement('div');
  document.body.append(root);

  const doc = emptyDoc();
  doc.viewBox = { x: 0, y: 0, w: WIDTH * SCALE, h: HEIGHT * SCALE };
  doc.shapes.push(shapeFromPath('M10 10 L60 10 L60 40 Z'));

  const store = new Store(doc);
  const canvas = new Canvas(root);
  const controller = new Controller(store, canvas);
  const ns = 'http://www.w3.org/2000/svg';
  const rulerH = document.createElementNS(ns, 'svg');
  const rulerV = document.createElementNS(ns, 'svg');
  root.append(rulerH, rulerV);
  controller.attachRulers(rulerH, rulerV);
  controller.render();

  const at = (type: string, p: [number, number], target: Element): void => {
    const e = new MouseEvent(type, {
      clientX: p[0] / SCALE,
      clientY: p[1] / SCALE,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'button', { value: 0 });
    target.dispatchEvent(e);
  };

  return {
    store,
    controller,
    canvas,
    rulerH,
    rulerV,
    at,
    guideEl: (i) => {
      controller.render();
      const el = canvas.overlay.querySelector(`[data-hit="guide"][data-guide="${i}"]`);
      if (!el) throw new Error(`no hit strip for guide ${i}`);
      return el;
    },
  };
}

describe('a guide gesture that changes nothing records nothing', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it('drags one out of a ruler as a single undo step', () => {
    // The baseline the three below are measured against.
    r.at('pointerdown', [20, 0], r.rulerH);
    r.at('pointermove', [20, 25], r.canvas.overlay);
    r.at('pointermove', [20, 30], r.canvas.overlay);
    r.at('pointerup', [20, 30], r.canvas.overlay);

    expect(r.store.state.guides).toEqual([{ axis: 'y', at: 30 }]);
    r.store.undo();
    expect(r.store.state.guides).toEqual([]);
    // One step, not one per pointermove.
    expect(r.store.canUndo).toBe(false);
  });

  it('leaves no entry when the ruler press lands where a guide already is', () => {
    r.controller.addGuideAt('y', 30);
    const depth = r.store.canUndo;
    expect(depth).toBe(true);

    r.at('pointerdown', [20, 30], r.rulerH);
    r.at('pointerup', [20, 30], r.rulerH);

    expect(r.store.state.guides).toHaveLength(1);
    // One undo takes back the guide that was placed, and there is nothing
    // underneath it: the refused press must not have pushed an entry of its own.
    r.store.undo();
    expect(r.store.state.guides).toEqual([]);
    expect(r.store.canUndo).toBe(false);
  });

  it('leaves no entry when a new guide is dropped straight back off the canvas', () => {
    /* Out of the ruler and released beyond the stage without ever landing. The
       guide never existed as far as the drawing is concerned, so `Ctrl+Z` must
       not spend a step arriving back where it already is. */
    r.at('pointerdown', [20, 0], r.rulerH);
    r.at('pointermove', [20, 8], r.canvas.overlay);
    r.at('pointerup', [-5, -5], r.canvas.overlay);

    expect(r.store.state.guides).toEqual([]);
    expect(r.store.canUndo).toBe(false);
  });

  it('leaves no entry when an existing guide is pressed and released', () => {
    r.controller.addGuideAt('x', 20);
    r.store.undo();
    r.store.redo();
    expect(r.store.canUndo).toBe(true);

    const el = r.guideEl(0);
    r.at('pointerdown', [20, 25], el);
    r.at('pointerup', [20, 25], r.canvas.overlay);

    expect(r.store.state.guides).toEqual([{ axis: 'x', at: 20 }]);
    r.store.undo();
    expect(r.store.state.guides).toEqual([]);
    expect(r.store.canUndo).toBe(false);
  });

  it('does record removing a guide that was already there', () => {
    // The other side of the rule: this one is a change, so it costs a step.
    r.controller.addGuideAt('x', 20);
    const el = r.guideEl(0);
    r.at('pointerdown', [20, 25], el);
    r.at('pointermove', [18, 25], r.canvas.overlay);
    r.at('pointerup', [-5, 25], r.canvas.overlay);

    expect(r.store.state.guides).toEqual([]);
    r.store.undo();
    expect(r.store.state.guides).toEqual([{ axis: 'x', at: 20 }]);
  });
});
