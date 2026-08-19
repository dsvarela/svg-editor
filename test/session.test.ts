/**
 * The session format, which is the only thing here that reads bytes it did not
 * write.
 *
 * An SVG the importer refuses shows an error and leaves the drawing alone. A
 * session the reader mishandles is loaded at startup, before anything is on
 * screen, so a `null` reaching the geometry is a blank editor with no message.
 * That is what these are about: `read` returns a sentence for everything it will
 * not take, and never returns a `Session` holding a value the rest of the model
 * would not have produced.
 *
 * The id counters get their own group. They are module-level and start at zero
 * on a fresh page, so a restored document brings ids the counters are about to
 * hand out for a second time -- §46's collision, arriving from a direction §46
 * does not cover.
 */

import { describe, expect, it } from 'vitest';
import { Store } from '../src/model/store';
import { emptyDoc, nextId, reserveIds, shapeFromPath } from '../src/model/doc';
import { nextNodeId } from '../src/core/types';
import { encode, read, toSession, whatIsMissing } from '../src/io/session';
import type { SessionView } from '../src/io/session';

const starter = (): Store => {
  const doc = emptyDoc();
  doc.viewBox = { x: 0, y: 0, w: 88, h: 64 };
  doc.shapes.push(shapeFromPath('M 10 10 C 20 10 30 20 30 30 L 10 30 Z', 'one'));
  return new Store(doc);
};

const view = (s: Store): SessionView => toSession(s.state).view;

/** The text a live editor would write, which is what every read here is given. */
const written = (s: Store): string => encode(toSession(s.state));

describe('a session survives being written and read', () => {
  it('brings the geometry back node for node', () => {
    const store = starter();
    const back = read(written(store), view(store));
    expect(typeof back).not.toBe('string');
    if (typeof back === 'string') return;
    expect(back.doc.shapes).toEqual(store.state.doc.shapes);
    expect(back.doc.viewBox).toEqual(store.state.doc.viewBox);
  });

  it('keeps a straight segment straight rather than collapsing its handle onto the anchor', () => {
    const store = starter();
    const back = read(written(store), view(store));
    if (typeof back === 'string') throw new Error(back);
    const last = back.doc.shapes[0].subpaths[0].nodes.at(-1);
    expect(last?.hIn).toBeNull();
    expect(last?.hOut).toBeNull();
  });

  it('brings the camera, the guides, the palette and the switches', () => {
    const store = starter();
    store.update((s) => {
      s.camera = { x: -5, y: -5, w: 200, h: 150 };
      s.guides = [
        { axis: 'x', at: 12 },
        { axis: 'y', at: 40 },
      ];
      s.palette = [{ name: 'ink', style: { fill: '#111', stroke: 'none', strokeWidth: 2, fillRule: 'evenodd' } }];
      s.showKeylines = true;
      s.gridStep = 4;
      s.decimals = 1;
      s.tool = 'pen';
    });
    const back = read(written(store), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.camera).toEqual({ x: -5, y: -5, w: 200, h: 150 });
    expect(back.guides).toEqual([
      { axis: 'x', at: 12 },
      { axis: 'y', at: 40 },
    ]);
    expect(back.palette[0].style.fillRule).toBe('evenodd');
    expect(back.view.showKeylines).toBe(true);
    expect(back.view.gridStep).toBe(4);
    expect(back.view.decimals).toBe(1);
    expect(back.view.tool).toBe('pen');
  });

  it('keeps a group and the shapes pointing at it', () => {
    const store = starter();
    store.edit((s) => {
      s.doc.groups = [{ id: 'group-1', name: 'pair', parent: null }];
      s.doc.shapes[0].group = 'group-1';
    });
    const back = read(written(store), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.doc.groups).toEqual([{ id: 'group-1', name: 'pair', parent: null }]);
    expect(back.doc.shapes[0].group).toBe('group-1');
  });
});

describe('a session it will not take', () => {
  const store = starter();

  it('refuses text that is not JSON', () => {
    expect(read('{oh dear', view(store))).toContain('not JSON');
  });

  it('refuses a version it does not know', () => {
    const s = JSON.parse(written(store)) as Record<string, unknown>;
    s.version = 99;
    expect(read(JSON.stringify(s), view(store))).toContain('version 99');
  });

  it('refuses a coordinate that is not a number', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: { subpaths: { nodes: { pt: unknown }[] }[] }[] } };
    s.doc.shapes[0].subpaths[0].nodes[0].pt = ['10', 10];
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a coordinate that is NaN, which JSON writes as null', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: { subpaths: { nodes: { pt: unknown }[] }[] }[] } };
    s.doc.shapes[0].subpaths[0].nodes[0].pt = [null, 10];
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a canvas with no area', () => {
    const s = JSON.parse(written(store)) as { doc: { viewBox: { w: number } } };
    s.doc.viewBox.w = 0;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a style it could not have written', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: { style: { fillRule: string } }[] } };
    s.doc.shapes[0].style.fillRule = 'inherit';
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a guide on an axis that does not exist', () => {
    const s = JSON.parse(written(store)) as Record<string, unknown>;
    s.guides = [{ axis: 'z', at: 3 }];
    expect(read(JSON.stringify(s), view(store))).toContain('guides');
  });
});

describe('a session it repairs rather than refuses', () => {
  /* Written into the JSON rather than into the store, because `pruneGroups`
     clears a dangling pointer on the way through `Store.edit` -- so a fixture
     built through the editor would arrive here already repaired, and this would
     pass whatever the reader did. */
  it('drops a group pointer with no group behind it', () => {
    const store = starter();
    const s = JSON.parse(written(store)) as { doc: { shapes: { group?: string }[] } };
    s.doc.shapes[0].group = 'group-404';
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.doc.shapes[0].group).toBeUndefined();
  });

  /* A preference reads leniently where the drawing reads strictly: a build that
     adds a switch would otherwise refuse every file written before it. */
  it('falls back to the running editor for a switch that is not in the file', () => {
    const store = starter();
    store.update((s) => (s.showKeylines = true));
    const s = JSON.parse(written(store)) as { view: Record<string, unknown> };
    delete s.view.showKeylines;
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.view.showKeylines).toBe(true);
  });

  it('falls back for a tool name it does not know', () => {
    const store = starter();
    const s = JSON.parse(written(store)) as { view: Record<string, unknown> };
    s.view.tool = 'lasso';
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.view.tool).toBe('select');
  });
});

describe('what a save cannot carry, it says', () => {
  it('says nothing when there is nothing to say', () => {
    expect(whatIsMissing(starter().state)).toBeNull();
  });

  it('names the backdrop when one is loaded', () => {
    const store = starter();
    store.edit((s) => {
      s.backdrop = {
        src: 'blob:x',
        name: 'ref.png',
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        naturalW: 10,
        naturalH: 10,
        opacity: 1,
        visible: true,
        locked: true,
      };
    });
    expect(whatIsMissing(store.state)).toContain('backdrop');
  });
});

describe('the id counters move past a document that arrived from outside', () => {
  it('will not hand out a shape id the restored document already uses', () => {
    reserveIds({
      shapes: [{ id: 'shape-9000', name: 'x', subpaths: [], style: { fill: 'none', stroke: '#000', strokeWidth: 1, fillRule: 'nonzero' } }],
      viewBox: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(nextId()).toBe('shape-9001');
  });

  it('will not hand out a node id the restored document already uses', () => {
    reserveIds({
      shapes: [
        {
          id: 'shape-1',
          name: 'x',
          subpaths: [{ nodes: [{ id: 'n8000', pt: [0, 0], hIn: null, hOut: null }], closed: false }],
          style: { fill: 'none', stroke: '#000', strokeWidth: 1, fillRule: 'nonzero' },
        },
      ],
      viewBox: { x: 0, y: 0, w: 1, h: 1 },
    });
    expect(nextNodeId()).toBe('n8001');
  });

  it('counts a group id too', () => {
    reserveIds({
      shapes: [],
      viewBox: { x: 0, y: 0, w: 1, h: 1 },
      groups: [{ id: 'group-9500', name: 'g', parent: null }],
    });
    expect(nextId('group')).toBe('group-9501');
  });

  it('leaves an id that cannot collide alone', () => {
    const before = nextId();
    reserveIds({
      shapes: [{ id: 'hand-written', name: 'x', subpaths: [], style: { fill: 'none', stroke: '#000', strokeWidth: 1, fillRule: 'nonzero' } }],
      viewBox: { x: 0, y: 0, w: 1, h: 1 },
    });
    const after = nextId();
    expect(Number(after.split('-')[1])).toBe(Number(before.split('-')[1]) + 1);
  });
});
