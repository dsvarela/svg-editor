/**
 * @vitest-environment jsdom
 *
 * Rendering invariants.
 *
 * The canvas must show exactly what the model holds -- no stale elements, no
 * malformed path data, no anchors without a node behind them. These checks came
 * out of a bug where stray strokes appeared on screen that the document did not
 * account for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Canvas, MARKER_CAP } from '../src/view/canvas';
import { Controller } from '../src/tools/controller';
import { Store } from '../src/model/store';
import { emptyDoc, shapeFromPath } from '../src/model/doc';
import { parsePath } from '../src/core/parse';

const SCALE = 0.1;

class FM {
  constructor(
    public a: number, public b: number, public c: number,
    public d: number, public e: number, public f: number,
  ) {}
  inverse(): FM {
    const t = this.a * this.d - this.b * this.c;
    return new FM(this.d / t, -this.b / t, -this.c / t, this.a / t,
      (this.c * this.f - this.d * this.e) / t, (this.b * this.e - this.a * this.f) / t);
  }
}
class FP {
  constructor(public x: number, public y: number) {}
  matrixTransform(m: FM): FP {
    return new FP(m.a * this.x + m.c * this.y + m.e, m.b * this.x + m.d * this.y + m.f);
  }
}

function setup(pathData?: string) {
  vi.stubGlobal('DOMPoint', FP);
  Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', {
    configurable: true, value: () => new FM(1 / SCALE, 0, 0, 1 / SCALE, 0, 0),
  });
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) }),
  });
  Element.prototype.setPointerCapture = (): void => {};
  Element.prototype.releasePointerCapture = (): void => {};
  Element.prototype.hasPointerCapture = (): boolean => false;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 0; });

  const root = document.createElement('div');
  document.body.append(root);
  const doc = emptyDoc();
  doc.viewBox = { x: 0, y: 0, w: 80, h: 60 };
  if (pathData) doc.shapes.push(shapeFromPath(pathData));

  const store = new Store(doc);
  const canvas = new Canvas(root);
  const controller = new Controller(store, canvas);
  controller.render();

  const ev = (type: string, p: [number, number], target: Element, opts: MouseEventInit = {}): void => {
    const e = new MouseEvent(type, {
      clientX: p[0] / SCALE, clientY: p[1] / SCALE, bubbles: true, cancelable: true, ...opts,
    });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'button', { value: 0 });
    target.dispatchEvent(e);
  };

  return {
    store, canvas, controller,
    down: (p: [number, number], t?: Element) => ev('pointerdown', p, t ?? canvas.overlay),
    move: (p: [number, number]) => ev('pointermove', p, canvas.overlay),
    up: () => ev('pointerup', [0, 0], canvas.overlay),
  };
}

/** Visible (not display:none) elements matching a selector. */
const visible = (root: Element, sel: string): Element[] =>
  [...root.querySelectorAll(sel)].filter((e) => e.getAttribute('display') !== 'none');

/**
 * Assert the canvas is a faithful picture of the document.
 * Returns nothing; throws with a useful message on any mismatch.
 */
function assertFaithful(canvas: Canvas, store: Store): void {
  const doc = store.state.doc;

  // 1. One artwork path per shape, no orphans left behind.
  const paths = [...canvas.artwork.querySelectorAll('path')];
  expect(paths.length, 'artwork path count').toBe(doc.shapes.length);

  // 2. Every `d` is well formed and describes the same nodes as its shape.
  for (let i = 0; i < paths.length; i++) {
    const d = paths[i].getAttribute('d') ?? '';
    const shape = doc.shapes[i];
    const modelNodes = shape.subpaths.reduce((a, sp) => a + (sp.nodes.length >= 2 ? sp.nodes.length : 0), 0);

    expect(d, `shape ${i} d contains NaN`).not.toMatch(/NaN|Infinity|undefined/);
    if (modelNodes === 0) {
      expect(d, `shape ${i} should render nothing`).toBe('');
      continue;
    }
    const reparsed = parsePath(d);
    const renderedNodes = reparsed.reduce((a, sp) => a + sp.nodes.length, 0);
    expect(renderedNodes, `shape ${i} node count through the renderer`).toBe(modelNodes);

    /* And the coordinates, not only how many there are. Counting alone passes
       on a `d` left over from before a node moved, which is exactly the failure
       the path cache could introduce: it serialises only when the geometry it
       last saw has changed, so every test in this file that edits and re-renders
       is a check on that only if it looks at the numbers. Six decimals is what
       the renderer writes. */
    const want: number[] = [];
    for (const sp of shape.subpaths) {
      if (sp.nodes.length < 2) continue;
      for (const n of sp.nodes) want.push(n.pt[0], n.pt[1]);
    }
    const got: number[] = [];
    for (const sp of reparsed) for (const n of sp.nodes) got.push(n.pt[0], n.pt[1]);
    expect(got.length, `shape ${i} coordinate count`).toBe(want.length);
    for (let k = 0; k < want.length; k++) {
      expect(got[k], `shape ${i} coordinate ${k} through the renderer`).toBeCloseTo(want[k], 5);
    }
  }

  /* 3. Every node inside the camera has an anchor, and no node well outside it
        has one. This used to be "one anchor per node in the document", which
        stopped being true when the overlay started culling to the camera -- a
        23 454-node trace was drawing 23 454 markers, all of them, every frame.
        The per-node form is the stronger claim anyway: the old count would have
        been satisfied by any 3 anchors, including three on the same node.

        The band within `M` of the camera edge is asserted about in neither
        direction. The overlay's real margin is a marker's own width, which
        depends on the zoom; restating that here would make this test a copy of
        the code it is checking rather than a statement about what a person can
        see. */
  const cam = store.state.camera;
  const M = 4;
  const drawn = new Set(
    visible(canvas.overlay, '.anchor').map(
      (el) => `${el.getAttribute('data-shape')}/${el.getAttribute('data-sp')}/${el.getAttribute('data-i')}`,
    ),
  );
  for (const sh of doc.shapes) {
    sh.subpaths.forEach((sp, spI) => {
      sp.nodes.forEach((n, i) => {
        const key = `${sh.id}/${spI}/${i}`;
        const [x, y] = n.pt;
        if (x > cam.x + M && x < cam.x + cam.w - M && y > cam.y + M && y < cam.y + cam.h - M) {
          expect(drawn.has(key), `node ${key} at [${x},${y}] is in view with no anchor`).toBe(true);
        }
        if (x < cam.x - M || x > cam.x + cam.w + M || y < cam.y - M || y > cam.y + cam.h + M) {
          expect(drawn.has(key), `node ${key} at [${x},${y}] is off screen but drawn`).toBe(false);
        }
      });
    });
  }

  // 4. Every visible anchor points at a node that actually exists.
  for (const el of visible(canvas.overlay, '.anchor')) {
    const shape = doc.shapes.find((s) => s.id === el.getAttribute('data-shape'));
    const node = shape?.subpaths[Number(el.getAttribute('data-sp'))]?.nodes[Number(el.getAttribute('data-i'))];
    expect(node, `anchor ${el.getAttribute('data-shape')} points at a missing node`).toBeTruthy();
  }

  // 5. Handles only ever belong to selected nodes.
  const selCount = store.state.selection.nodes.size + store.state.selection.shapes.size;
  if (selCount === 0) {
    expect(visible(canvas.overlay, '.handle-dot').length, 'handles with nothing selected').toBe(0);
    expect(visible(canvas.overlay, '.handle-line').length, 'handle lines with nothing selected').toBe(0);
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('render fidelity', () => {
  it('matches the model for an imported path', () => {
    const h = setup('M 20 30 C 20 20 30 12 40 12 L 60 12 A 8 8 0 0 1 68 20 Q 68 30 56 30 Z');
    assertFaithful(h.canvas, h.store);
  });

  it('stays faithful through a pen session with drags', () => {
    const h = setup();
    h.store.update((s) => { s.tool = 'pen'; s.snapToGrid = false; s.snapToPoints = false; });

    const clicks: [number, number][] = [[10, 10], [30, 8], [45, 25], [30, 45], [12, 40]];
    for (const c of clicks) {
      h.down(c);
      h.move([c[0] + 4, c[1] + 2]); // small accidental drag, as with a real mouse
      h.up();
      h.controller.render();
      assertFaithful(h.canvas, h.store);
    }
  });

  it('stays faithful across undo and redo', () => {
    const h = setup();
    h.store.update((s) => { s.tool = 'pen'; s.snapToGrid = false; s.snapToPoints = false; });
    for (const c of [[10, 10], [30, 8], [45, 25]] as [number, number][]) {
      h.down(c); h.up();
    }

    for (let i = 0; i < 4; i++) {
      h.store.undo();
      h.controller.render();
      assertFaithful(h.canvas, h.store);
    }
    for (let i = 0; i < 4; i++) {
      h.store.redo();
      h.controller.render();
      assertFaithful(h.canvas, h.store);
    }
  });

  it('stays faithful when shapes are deleted', () => {
    const h = setup('M0 0 L20 0 L20 20 Z');
    h.store.update((s) => { s.tool = 'pen'; s.snapToGrid = false; });
    h.down([40, 40]); h.up();
    h.down([60, 40]); h.up();
    h.controller.render();
    assertFaithful(h.canvas, h.store);

    h.store.edit((s) => { s.doc.shapes = []; s.selection.nodes.clear(); s.selection.shapes.clear(); });
    h.controller.render();
    assertFaithful(h.canvas, h.store);
    expect(h.canvas.artwork.querySelectorAll('path')).toHaveLength(0);
  });

  it('leaves nothing behind when a subpath drops below two nodes', () => {
    // A one-node subpath cannot be drawn; it must not leave a stale `d` either.
    const h = setup();
    h.store.update((s) => { s.tool = 'pen'; s.snapToGrid = false; });
    h.down([10, 10]); h.up();
    h.down([30, 10]); h.up();
    h.controller.render();

    h.store.edit((s) => { s.doc.shapes[0].subpaths[0].nodes.pop(); });
    h.controller.render();
    assertFaithful(h.canvas, h.store);
  });

  it('keeps the artwork in step after transforms', () => {
    const h = setup('M0 0 C0 20 40 20 40 0 L40 30 Z');
    h.store.update((s) => s.selection.shapes.add(s.doc.shapes[0].id));
    h.controller.applyTransform('rotate', 37);
    h.controller.render();
    assertFaithful(h.canvas, h.store);
    h.controller.applyTransform('flipH');
    h.controller.render();
    assertFaithful(h.canvas, h.store);
  });
});

describe('latent handles', () => {
  it('offers pullable handles on a selected node of a straight segment', () => {
    const h = setup('M0 0 L20 0 L20 20 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${id}/0/1`));
    h.controller.render();

    const dots = visible(h.canvas.overlay, '.handle-dot');
    // Node 1 sits between two straight segments, so both sides are pullable.
    expect(dots).toHaveLength(2);
    expect(dots.every((d) => d.getAttribute('class')?.includes('latent'))).toBe(true);
  });

  it('places the ghost a third of the way along the segment', () => {
    const h = setup('M0 0 L30 0 L30 30 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${id}/0/0`));
    h.controller.render();

    const out = visible(h.canvas.overlay, '.handle-dot').find((d) => d.getAttribute('data-hit') === 'out');
    expect(Number(out?.getAttribute('cx'))).toBeCloseTo(10, 6);
    expect(Number(out?.getAttribute('cy'))).toBeCloseTo(0, 6);
  });

  it('offers no ghost where there is no segment', () => {
    // Node 0 of an OPEN subpath has nothing arriving at it.
    const h = setup('M0 0 L20 0');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${id}/0/0`));
    h.controller.render();

    const dots = visible(h.canvas.overlay, '.handle-dot');
    expect(dots).toHaveLength(1);
    expect(dots[0].getAttribute('data-hit')).toBe('out');
  });

  it('turns a straight segment into a curve when its ghost is dragged', () => {
    const h = setup('M0 0 L30 0 L30 30 Z');
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => {
      s.selection.nodes.add(`${id}/0/0`);
      s.snapToGrid = false;
      s.snapToPoints = false;
    });
    h.controller.render();

    const ghost = visible(h.canvas.overlay, '.handle-dot').find((d) => d.getAttribute('data-hit') === 'out')!;
    h.down([10, 0], ghost);
    h.move([10, -12]);
    h.up();

    const n = h.store.state.doc.shapes[0].subpaths[0].nodes[0];
    expect(n.hOut).toEqual([10, -12]);
    assertFaithful(h.canvas, h.store);
  });
});

describe('degenerate shapes', () => {
  it('discards a pen path abandoned after one click', () => {
    // One click leaves a single node: invisible, but it still shows an anchor
    // and counts toward the node total, which reads as a rendering fault.
    const h = setup('M0 0 L20 0 L20 20 Z');
    h.store.update((s) => { s.tool = 'pen'; s.snapToGrid = false; });
    h.down([50, 50]); h.up();
    expect(h.store.state.doc.shapes).toHaveLength(2);

    h.controller.finishPen();
    h.controller.render();

    expect(h.store.state.doc.shapes).toHaveLength(1);
    assertFaithful(h.canvas, h.store);
    expect(visible(h.canvas.overlay, '.anchor')).toHaveLength(3);
  });

  it('keeps a pen path that got two nodes', () => {
    const h = setup();
    h.store.update((s) => { s.tool = 'pen'; s.snapToGrid = false; });
    h.down([10, 10]); h.up();
    h.down([30, 10]); h.up();
    h.controller.finishPen();
    h.controller.render();
    expect(h.store.state.doc.shapes).toHaveLength(1);
    assertFaithful(h.canvas, h.store);
  });

  it('never renders an empty path element', () => {
    const h = setup();
    h.store.update((s) => { s.tool = 'pen'; s.snapToGrid = false; });
    h.down([10, 10]); h.up();
    h.controller.finishPen();
    h.controller.render();
    const ds = [...h.canvas.artwork.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    expect(ds.filter((d) => !d)).toHaveLength(0);
  });

  it('drops selection entries pointing at pruned nodes', () => {
    const h = setup();
    h.store.update((s) => { s.tool = 'pen'; s.snapToGrid = false; });
    h.down([10, 10]); h.up();
    const id = h.store.state.doc.shapes[0].id;
    h.store.update((s) => s.selection.nodes.add(`${id}/0/0`));
    h.controller.finishPen();
    expect(h.store.state.selection.nodes.size).toBe(0);
  });
});

/**
 * What the overlay refuses to draw.
 *
 * Both rules exist for the same reason and were found by the same measurement:
 * a traced photograph put 23 454 nodes in a document, the overlay drew a marker
 * for every one of them on every frame, and a render cost 205 ms -- so every
 * pointermove after a trace did. Markers are things you aim at; these are the
 * two cases where drawing one helps nobody.
 */
describe('the overlay under load', () => {
  /** A shape of `n` nodes along a line from `x0`, `step` document units apart. */
  const row = (n: number, x0: number, y: number, step = 1): string =>
    `M ${x0} ${y} ` +
    Array.from({ length: n - 1 }, (_, i) => `L ${+(x0 + (i + 1) * step).toFixed(4)} ${y}`).join(' ');

  it('draws no marker for a node outside the camera', () => {
    // The camera is the document's 80 by 60. Half this row is past its right
    // edge, and asymmetric on purpose: a bug that culled the wrong half, or
    // both halves, or neither, gives three different counts here.
    const h = setup(row(20, 71, 25));
    h.controller.render();
    const drawn = visible(h.canvas.overlay, '.anchor').map((el) => Number(el.getAttribute('data-i')));
    expect(drawn.length).toBe(10);
    expect(Math.max(...drawn)).toBe(9);
  });

  it('draws nothing at all above the cap, rather than an arbitrary prefix', () => {
    /* Drawing the first `MARKER_CAP` and stopping would leave which nodes you
       got depending on the order shapes are stored in. The count is what makes
       that distinguishable: a prefix would give exactly MARKER_CAP. */
    const h = setup();
    h.store.edit((s) => {
      // Packed 0.05 apart so all 2 400 are inside the 80 by 60 camera: at one
      // unit apart the culling would answer first and the cap would never be
      // reached, which is what the first draft of this test actually measured.
      for (let k = 0; k < 3; k++) s.doc.shapes.push(shapeFromPath(row(800, 10, 10 + k, 0.05)));
    });
    h.controller.render();
    expect(visible(h.canvas.overlay, '.anchor').length).toBe(0);
    expect(h.canvas.markersCapped).toBe(true);
  });

  it('counts only what is in view when deciding, so panning away brings them back', () => {
    /* The cap is on markers in view, not nodes in the document. A document far
       over the cap in total is still perfectly workable a few nodes at a time,
       which is the whole point of culling first and capping second. */
    const h = setup();
    h.store.edit((s) => {
      for (let k = 0; k < 3; k++) s.doc.shapes.push(shapeFromPath(row(MARKER_CAP, 1000, 10 + k)));
      s.doc.shapes.push(shapeFromPath('M 10 10 L 20 20'));
    });
    h.controller.render();
    expect(h.canvas.markersCapped).toBe(false);
    expect(visible(h.canvas.overlay, '.anchor').length).toBe(2);
  });
});

describe('wireframe', () => {
  it('marks every shape, and leaves its real fill and stroke on the element', () => {
    /* The class is what CSS overrides; the attributes stay exactly as the
       export will write them. Asserting both is the point: a wireframe
       implemented by rewriting the attributes would look the same on screen and
       would be a view switch quietly editing the drawing, which §18 separates.
    */
    const h = setup('M 0 0 L 20 0 L 20 20 Z');
    h.store.update((s) => {
      s.doc.shapes[0].style.fill = '#ff0000';
      s.doc.shapes[0].style.stroke = 'none';
      s.wireframe = true;
    });
    h.controller.render();

    const path = h.canvas.artwork.querySelector('path')!;
    expect(path.getAttribute('class')).toBe('wire');
    expect(path.getAttribute('fill')).toBe('#ff0000');
    expect(path.getAttribute('stroke')).toBe('none');
  });

  it('takes the mark off again', () => {
    const h = setup('M 0 0 L 20 0 L 20 20 Z');
    h.store.update((s) => (s.wireframe = true));
    h.controller.render();
    h.store.update((s) => (s.wireframe = false));
    h.controller.render();
    expect(h.canvas.artwork.querySelector('path')!.getAttribute('class')).toBe('');
  });
});
