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
import type { Session, SessionView } from '../src/io/session';

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
      s.palette = [{ name: 'ink', style: { fill: '#111', stroke: 'none', strokeWidth: 2, fillRule: 'evenodd', opacity: 1 } }];
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

  /* Each field of the box separately, and each of `w` and `h` at zero. One
     example stands for the whole guard only if the guard is one test, and this
     one is eight: a chain of five `||` and two more comparisons, any of which
     can be loosened without the others noticing. */
  it.each(['x', 'y', 'w', 'h'] as const)('refuses a canvas whose %s is not a number', (k) => {
    const s = JSON.parse(written(store)) as { doc: { viewBox: Record<string, unknown> } };
    s.doc.viewBox[k] = 'twelve';
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it.each(['w', 'h'] as const)('refuses a canvas with no %s', (k) => {
    const s = JSON.parse(written(store)) as { doc: { viewBox: Record<string, number> } };
    s.doc.viewBox[k] = 0;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a camera it could not have written', () => {
    const s = JSON.parse(written(store)) as { camera: Record<string, unknown> };
    s.camera.y = null;
    /* Falls back to the document's own box rather than refusing the file: a
       camera is where you were looking, and there is always somewhere else to
       look. The drawing is what a refusal is for. */
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.camera).toEqual(back.doc.viewBox);
  });

  it('refuses a document that is not an object at all', () => {
    const s = JSON.parse(written(store)) as Record<string, unknown>;
    s.doc = 'M0 0 L1 1';
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  /* An object with a list missing is the case a wrong guard lets through, and
     it is worse than the case above: the wrong shape refuses either way, and
     this one walks into a `for` over `undefined` and throws. A throw out of
     `read` at startup is a blank editor with nothing said, which is the failure
     this whole reader is built to avoid. */
  it('refuses a document that is an object with no shapes in it', () => {
    const s = JSON.parse(written(store)) as { doc: Record<string, unknown> };
    delete s.doc.shapes;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a shape that is an object with no paths in it', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: Record<string, unknown>[] } };
    delete s.doc.shapes[0].subpaths;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a subpath with no nodes in it', () => {
    const s = JSON.parse(written(store)) as {
      doc: { shapes: { subpaths: Record<string, unknown>[] }[] };
    };
    delete s.doc.shapes[0].subpaths[0].nodes;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a shape with no name, which every shape has', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: Record<string, unknown>[] } };
    delete s.doc.shapes[0].name;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a stroke width that is not a number', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: { style: Record<string, unknown> }[] } };
    s.doc.shapes[0].style.strokeWidth = '2px';
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  /* A width is a length. A negative one is not refused anywhere downstream and
     reaches `exportSvg` as `stroke-width="-4"`, so this reader is the guard. */
  /* A preference reads leniently, and lenience is a fallback rather than a
     throw. `decimals` is a number at any magnitude, so the type check passed it
     and `toFixed` then threw a RangeError one notification later, inside the
     refresh that draws the previews. */
  it('bounds a restored decimals to what the field offers', () => {
    const s = JSON.parse(written(store)) as { view: Record<string, unknown> };
    s.view.decimals = 500;
    const back = read(JSON.stringify(s), view(store));
    expect(typeof back).not.toBe('string');
    expect((back as Session).view.decimals).toBe(9);

    s.view.decimals = -1;
    expect(((read(JSON.stringify(s), view(store))) as Session).view.decimals).toBe(0);
  });

  it('refuses a negative stroke width', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: { style: Record<string, unknown> }[] } };
    s.doc.shapes[0].style.strokeWidth = -4;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('keeps a stroke width of zero, which is a hairline and not an error', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: { style: Record<string, unknown> }[] } };
    s.doc.shapes[0].style.strokeWidth = 0;
    const back = read(JSON.stringify(s), view(store));
    expect(typeof back).not.toBe('string');
    expect((back as Session).doc.shapes[0].style.strokeWidth).toBe(0);
  });

  /* Opacity is part of the drawing, so it reads strictly like the rest of it.
     The lenient version restored `"0.25"` as fully opaque with no message,
     which is a wrong picture rather than a switch in the wrong position. */
  it('refuses an opacity that is present and not a number', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: { style: Record<string, unknown> }[] } };
    s.doc.shapes[0].style.opacity = '0.25';
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  /* Absent is the other half and must stay lenient: opacity arrived after the
     format did, and a workspace written before it has no such field. */
  it('reads a style written before opacity existed as opaque', () => {
    const s = JSON.parse(written(store)) as { doc: { shapes: { style: Record<string, unknown> }[] } };
    delete s.doc.shapes[0].style.opacity;
    const back = read(JSON.stringify(s), view(store));
    expect(typeof back).not.toBe('string');
    expect((back as Session).doc.shapes[0].style.opacity).toBe(1);
  });

  /* `null`, not a string: a string has no numeric `at` either, so dropping the
     object check would still refuse one and this would pass with the guard
     gone. A `null` is what tells the two apart -- reading `at` off it throws,
     and a throw out of `read` at startup is the blank editor with no message
     that this whole file exists to prevent. */
  it('refuses a guide that is not an object, rather than throwing on it', () => {
    const s = JSON.parse(written(store)) as Record<string, unknown>;
    s.guides = [null];
    expect(read(JSON.stringify(s), view(store))).toContain('guides');
  });

  it('refuses a guide with no position', () => {
    const s = JSON.parse(written(store)) as Record<string, unknown>;
    s.guides = [{ axis: 'x' }];
    expect(read(JSON.stringify(s), view(store))).toContain('guides');
  });

  it('refuses a saved style with no name', () => {
    const s = JSON.parse(written(store)) as Record<string, unknown>;
    s.palette = [{ style: { fill: '#000', stroke: 'none', strokeWidth: 1, fillRule: 'nonzero', opacity: 1 } }];
    expect(read(JSON.stringify(s), view(store))).toContain('saved styles');
  });

  it('refuses a saved style that is not a style', () => {
    const s = JSON.parse(written(store)) as Record<string, unknown>;
    s.palette = [{ name: 'ink', style: 'black' }];
    expect(read(JSON.stringify(s), view(store))).toContain('saved styles');
  });

  it('refuses a handle that is half a point', () => {
    const s = JSON.parse(written(store)) as {
      doc: { shapes: { subpaths: { nodes: Record<string, unknown>[] }[] }[] };
    };
    s.doc.shapes[0].subpaths[0].nodes[0].hOut = [5];
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a node with no id, which is what a selection is made of', () => {
    const s = JSON.parse(written(store)) as {
      doc: { shapes: { subpaths: { nodes: Record<string, unknown>[] }[] }[] };
    };
    delete s.doc.shapes[0].subpaths[0].nodes[0].id;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a subpath that does not say whether it closes', () => {
    const s = JSON.parse(written(store)) as {
      doc: { shapes: { subpaths: Record<string, unknown>[] }[] };
    };
    delete s.doc.shapes[0].subpaths[0].closed;
    expect(read(JSON.stringify(s), view(store))).toContain('malformed');
  });

  it('refuses a group with no id', () => {
    const s = JSON.parse(written(store)) as { doc: Record<string, unknown> };
    s.doc.groups = [{ name: 'pair', parent: null }];
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

  /* A group whose parent names nothing, or two groups naming each other, put a
     shape in a tree whose walk from the root never reaches it -- a shape that
     paints nowhere and lists nowhere, and that a reorder used to delete
     outright. Rooting the group is the smallest repair that puts it back. */
  it('roots a group whose parent is not in the file', () => {
    const store = starter();
    const s = JSON.parse(written(store)) as { doc: Record<string, unknown> };
    s.doc.groups = [{ id: 'g1', name: 'g', parent: 'gone' }];
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.doc.groups?.[0].parent).toBeNull();
  });

  it('breaks a cycle between two groups', () => {
    const store = starter();
    const s = JSON.parse(written(store)) as { doc: Record<string, unknown> };
    s.doc.groups = [
      { id: 'g1', name: 'g', parent: 'g2' },
      { id: 'g2', name: 'h', parent: 'g1' },
    ];
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    const roots = (back.doc.groups ?? []).filter((g) => g.parent === null);
    expect(roots.length).toBeGreaterThan(0);
    // And every group can still be walked to the root without repeating one.
    for (const g of back.doc.groups ?? []) {
      const seen = new Set([g.id]);
      let at = g.parent;
      while (at) {
        expect(seen.has(at)).toBe(false);
        seen.add(at);
        at = back.doc.groups?.find((o) => o.id === at)?.parent ?? null;
      }
    }
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

  /* The test above is only half the question, and the missing half is the one
     that bit: it says an unknown name falls back, which stays true when a real
     tool is left out of the table and starts falling back too. That is not an
     error anywhere -- the fallback is a legal tool -- so the only thing that
     can see it is asking every name the editor has to come back as itself. */
  it.each(['select', 'pen', 'ellipse', 'rect', 'poly', 'hand'] as const)(
    'brings the %s tool back as itself',
    (tool) => {
      const store = starter();
      store.update((s) => (s.tool = tool));
      const back = read(written(store), { ...view(store), tool: 'select' });
      if (typeof back === 'string') throw new Error(back);
      expect(back.view.tool).toBe(tool);
    },
  );

  it('falls back for a delete mode and a source mode it does not know', () => {
    const store = starter();
    const s = JSON.parse(written(store)) as { view: Record<string, unknown> };
    s.view.deleteMode = 'shred';
    s.view.sourceMode = 'xml';
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.view.deleteMode).toBe(store.state.deleteMode);
    expect(back.view.sourceMode).toBe(store.state.sourceMode);
  });

  /* `'constructor' in {}` is true, so a table asked with `in` would take any
     name off `Object.prototype` as a tool and hand back a string the editor
     has no case for. */
  it('does not take a name off the prototype as a tool', () => {
    const store = starter();
    const s = JSON.parse(written(store)) as { view: Record<string, unknown> };
    s.view.tool = 'constructor';
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.view.tool).toBe('select');
  });

  it('clamps a polygon setting that is outside what the generator accepts', () => {
    const store = starter();
    const s = JSON.parse(written(store)) as { view: { polygon: Record<string, unknown> } };
    s.view.polygon = { corners: 900, star: true, ratio: 40 };
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.view.polygon.corners).toBe(60);
    expect(back.view.polygon.ratio).toBe(1);
  });

  it('falls back for a polygon block that is not one', () => {
    const store = starter();
    store.update((s) => (s.polygon.corners = 7));
    const s = JSON.parse(written(store)) as { view: Record<string, unknown> };
    s.view.polygon = { corners: 'five', star: true, ratio: 0.5 };
    const back = read(JSON.stringify(s), view(store));
    if (typeof back === 'string') throw new Error(back);
    expect(back.view.polygon.corners).toBe(7);
  });

  /* `null` is a value here and not an absence: it means angles are measured
     from wherever the gesture started. So it has to survive a round trip
     rather than being read as a field that went missing. */
  it('keeps an angle origin, and keeps its absence', () => {
    const store = starter();
    store.update((s) => (s.angleOrigin = [3, 4]));
    const kept = read(written(store), view(store));
    if (typeof kept === 'string') throw new Error(kept);
    expect(kept.view.angleOrigin).toEqual([3, 4]);

    store.update((s) => (s.angleOrigin = null));
    const cleared = read(written(store), { ...view(store), angleOrigin: [9, 9] });
    if (typeof cleared === 'string') throw new Error(cleared);
    expect(cleared.view.angleOrigin).toBeNull();
  });

  /* The half above cannot see the fallback: an explicit `null` reads as `null`
     whether the field falls back or not. Only a value that is neither a point
     nor `null` separates "this field says there is no origin" from "this field
     is unreadable", and the second is the one every other field falls back on. */
  it('falls back for an angle origin that is neither a point nor absent', () => {
    const store = starter();
    const s = JSON.parse(written(store)) as { view: Record<string, unknown> };
    s.view.angleOrigin = 'the middle';
    const back = read(JSON.stringify(s), { ...view(store), angleOrigin: [9, 9] });
    if (typeof back === 'string') throw new Error(back);
    expect(back.view.angleOrigin).toEqual([9, 9]);
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
      shapes: [{ id: 'shape-9000', name: 'x', subpaths: [], style: { fill: 'none', stroke: '#000', strokeWidth: 1, fillRule: 'nonzero', opacity: 1 } }],
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
          style: { fill: 'none', stroke: '#000', strokeWidth: 1, fillRule: 'nonzero', opacity: 1 },
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
      shapes: [{ id: 'hand-written', name: 'x', subpaths: [], style: { fill: 'none', stroke: '#000', strokeWidth: 1, fillRule: 'nonzero', opacity: 1 } }],
      viewBox: { x: 0, y: 0, w: 1, h: 1 },
    });
    const after = nextId();
    expect(Number(after.split('-')[1])).toBe(Number(before.split('-')[1]) + 1);
  });
});
