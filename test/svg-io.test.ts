/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import {
  drawsSomething,
  exportSvg,
  importSvg,
  parseTransform,
  primitiveToPath,
  xmlId,
} from '../src/io/svg';
import { parsePath } from '../src/core/parse';
import { makeNode, segmentAsCubic, segmentCount } from '../src/core/types';
import { cubicAt } from '../src/core/bezier';
import { emptyDoc } from '../src/model/doc';
import type { Pt, Shape } from '../src/core/types';

const samplePts = (shape: Shape, per = 12): Pt[] => {
  const out: Pt[] = [];
  for (const sp of shape.subpaths) {
    for (let i = 0; i < segmentCount(sp); i++) {
      const c = segmentAsCubic(sp, i);
      for (let k = 0; k <= per; k++) out.push(cubicAt(c, k / per));
    }
  }
  return out;
};

const bbox = (shape: Shape) => {
  const pts = samplePts(shape, 32);
  return {
    x0: Math.min(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])),
    y1: Math.max(...pts.map((p) => p[1])),
  };
};

describe('transform parsing', () => {
  it('reads translate', () => {
    expect(parseTransform('translate(10 20)')).toEqual([1, 0, 0, 1, 10, 20]);
    expect(parseTransform('translate(10)')).toEqual([1, 0, 0, 1, 10, 0]);
  });

  it('reads scale with one or two arguments', () => {
    expect(parseTransform('scale(2)')).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform('scale(2,3)')).toEqual([2, 0, 0, 3, 0, 0]);
  });

  it('reads matrix', () => {
    expect(parseTransform('matrix(1,2,3,4,5,6)')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rotates about a point when given three arguments', () => {
    // Rotating 180 degrees about (5,5) maps (5,0) to (5,10).
    const m = parseTransform('rotate(180 5 5)');
    const x = m[0] * 5 + m[2] * 0 + m[4];
    const y = m[1] * 5 + m[3] * 0 + m[5];
    expect(x).toBeCloseTo(5, 9);
    expect(y).toBeCloseTo(10, 9);
  });

  it('composes a list left to right', () => {
    // translate then scale: the scale applies in the translated frame.
    const m = parseTransform('translate(10 0) scale(2)');
    expect(m).toEqual([2, 0, 0, 2, 10, 0]);
  });

  it('ignores junk', () => {
    expect(parseTransform('')).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransform('nonsense(1 2)')).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe('primitive conversion', () => {
  const el = (markup: string): Element =>
    new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml')
      .documentElement.children[0];

  it('converts a plain rect', () => {
    expect(primitiveToPath(el('<rect x="1" y="2" width="10" height="5"/>'))).toBe('M1 2H11V7H1Z');
  });

  it('converts a rounded rect with arcs', () => {
    const d = primitiveToPath(el('<rect width="10" height="10" rx="2"/>'))!;
    const sp = parsePath(d);
    const b = bbox({ subpaths: sp } as Shape);
    expect(b.x0).toBeCloseTo(0, 6);
    expect(b.x1).toBeCloseTo(10, 6);
    expect(b.y1).toBeCloseTo(10, 6);
  });

  it('takes rx from ry when only ry is given', () => {
    const a = primitiveToPath(el('<rect width="10" height="10" ry="3"/>'));
    const b = primitiveToPath(el('<rect width="10" height="10" rx="3" ry="3"/>'));
    expect(a).toBe(b);
  });

  it('clamps radii to half the side', () => {
    const a = primitiveToPath(el('<rect width="10" height="10" rx="99"/>'));
    const b = primitiveToPath(el('<rect width="10" height="10" rx="5"/>'));
    expect(a).toBe(b);
  });

  it('converts a circle to something actually round', () => {
    const d = primitiveToPath(el('<circle cx="5" cy="5" r="4"/>'))!;
    const shape = { subpaths: parsePath(d) } as Shape;
    for (const p of samplePts(shape, 40)) {
      expect(Math.abs(Math.hypot(p[0] - 5, p[1] - 5) - 4)).toBeLessThan(2e-3);
    }
  });

  it('converts an ellipse', () => {
    const d = primitiveToPath(el('<ellipse cx="0" cy="0" rx="10" ry="4"/>'))!;
    const b = bbox({ subpaths: parsePath(d) } as Shape);
    expect(b.x1 - b.x0).toBeCloseTo(20, 2);
    expect(b.y1 - b.y0).toBeCloseTo(8, 2);
  });

  it('converts line, polyline and polygon', () => {
    expect(primitiveToPath(el('<line x1="0" y1="0" x2="5" y2="6"/>'))).toBe('M0 0L5 6');
    expect(primitiveToPath(el('<polyline points="0,0 5,5 10,0"/>'))).toBe('M0 0L5 5L10 0');
    expect(primitiveToPath(el('<polygon points="0,0 5,5 10,0"/>'))).toBe('M0 0L5 5L10 0Z');
  });

  it('returns null for things that are not shapes', () => {
    expect(primitiveToPath(el('<text>hi</text>'))).toBeNull();
  });

  it('yields nothing for a zero-sized rect', () => {
    expect(primitiveToPath(el('<rect width="0" height="10"/>'))).toBe('');
  });
});

describe('what an import is allowed to replace the document with', () => {
  /* Both import routes -- the source box and the file picker -- refuse text
     that draws nothing. Until this predicate moved out of `main.ts` the check
     had a copy in each of them and neither had a unit test, so only the
     `importFile` browser scenario covered it. Every case here parses without
     complaint, which is what makes the refusal necessary. */

  it('refuses a move with nothing after it, which arrives as a shape', () => {
    /* The count is what makes this necessary: a bare move comes back as one
       shape, so refusing on `shapes.length` would accept it. The subpath is
       what the parser dropped. */
    const r = importSvg('M 0 0');
    expect(r.shapes).toHaveLength(1);
    expect(r.shapes[0].subpaths).toHaveLength(0);
    expect(drawsSomething(r.shapes)).toBe(false);
    expect(drawsSomething(importSvg('M 12 -4').shapes)).toBe(false);
  });

  it('refuses commands the parser drops, leaving a bare move', () => {
    // `Q Q Q` is not geometry, and what it leaves behind is the case above.
    expect(drawsSomething(importSvg('M 0 0 Q Q Q').shapes)).toBe(false);
  });

  it('refuses empty text, and markup holding no shape', () => {
    expect(drawsSomething(importSvg('').shapes)).toBe(false);
    expect(drawsSomething(importSvg('<svg viewBox="0 0 20 20"></svg>').shapes)).toBe(false);
  });

  it('refuses a document whose every shape draws nothing', () => {
    /* The markup route differs from the bare-`d` one: a `<path>` that draws
       nothing is dropped rather than kept as an empty shape, so this document
       arrives with no shapes at all. Refused either way. */
    const r = importSvg(`<svg viewBox="0 0 20 20">
      <path d="M0 0"/>
      <path d="M10 10"/>
    </svg>`);
    expect(r.shapes).toHaveLength(0);
    expect(drawsSomething(r.shapes)).toBe(false);
  });

  it('accepts a document where one shape draws and the rest do not', () => {
    /* The rule is about the document, not about every shape in it. A stray
       bare move alongside real geometry is not a reason to refuse the file. */
    const r = importSvg(`<svg viewBox="0 0 20 20">
      <path d="M0 0"/>
      <path d="M0 0 L10 0"/>
    </svg>`);
    expect(drawsSomething(r.shapes)).toBe(true);
  });

  it('refuses a lone node, which no parse produces and the rule still names', () => {
    /* Built by hand, because `parsePath` drops a subpath with one node rather
       than returning it: through `importSvg` this case cannot arise, and a
       threshold of one node would pass every test above. The function takes
       shapes, so it is answerable for shapes that did not come from the
       parser -- and one node is not a drawing whoever made it. */
    const lone: Shape = {
      id: 'shape-1',
      name: 'lone',
      subpaths: [{ nodes: [makeNode([5, 5])], closed: false }],
      style: { fill: 'none', stroke: '#000', strokeWidth: 1, fillRule: 'nonzero', opacity: 1 },
    };
    expect(lone.subpaths[0].nodes).toHaveLength(1);
    expect(drawsSomething([lone])).toBe(false);
  });

  it('accepts the smallest thing that draws: two nodes', () => {
    expect(drawsSomething(importSvg('M 0 0 L 1 0').shapes)).toBe(true);
    // Including a line of zero length, which draws a dot under a round cap.
    expect(drawsSomething(importSvg('M 0 0 L 0 0').shapes)).toBe(true);
  });
});

describe('svg import', () => {
  it('makes one shape per path, which Apply used to collapse into one', () => {
    const r = importSvg(`<svg viewBox="0 0 20 20">
      <path d="M0 0 L10 0 L10 10 Z"/>
      <path d="M12 12 L18 12 L18 18 Z"/>
    </svg>`);
    expect(r.shapes).toHaveLength(2);
    expect(r.viewBox).toEqual({ x: 0, y: 0, w: 20, h: 20 });
  });

  it('reads mixed primitives', () => {
    const r = importSvg(`<svg viewBox="0 0 100 100">
      <rect width="10" height="10"/>
      <circle cx="50" cy="50" r="5"/>
      <polygon points="0,0 5,5 10,0"/>
      <path d="M0 0 L1 1"/>
    </svg>`);
    expect(r.shapes).toHaveLength(4);
  });

  it('bakes a transform into the coordinates', () => {
    const r = importSvg(`<svg><path transform="translate(10 20)" d="M0 0 L5 0"/></svg>`);
    expect(r.shapes[0].subpaths[0].nodes[0].pt).toEqual([10, 20]);
    expect(r.shapes[0].subpaths[0].nodes[1].pt).toEqual([15, 20]);
  });

  it('composes transforms down through groups', () => {
    const r = importSvg(
      `<svg><g transform="translate(10 0)"><g transform="scale(2)">` +
        `<path d="M1 1 L2 1"/></g></g></svg>`,
    );
    // scale first (inner), then translate: (1,1)*2 = (2,2), +10 x -> (12,2)
    expect(r.shapes[0].subpaths[0].nodes[0].pt).toEqual([12, 2]);
  });

  it('rotates a transformed primitive correctly', () => {
    const r = importSvg(`<svg><rect transform="rotate(90)" x="0" y="0" width="10" height="4"/></svg>`);
    const b = bbox(r.shapes[0]);
    // A 10x4 rect rotated 90 degrees about the origin becomes 4 wide, 10 tall.
    expect(b.x1 - b.x0).toBeCloseTo(4, 6);
    expect(b.y1 - b.y0).toBeCloseTo(10, 6);
  });

  it('inherits style from groups and reads inline style', () => {
    const r = importSvg(
      `<svg><g fill="#ff0000" stroke="#00ff00">` +
        `<path d="M0 0 L1 1"/>` +
        `<path d="M0 0 L1 1" style="fill:#0000ff;stroke-width:3"/>` +
        `</g></svg>`,
    );
    expect(r.shapes[0].style.fill).toBe('#ff0000');
    expect(r.shapes[0].style.stroke).toBe('#00ff00');
    expect(r.shapes[1].style.fill).toBe('#0000ff');
    expect(r.shapes[1].style.stroke).toBe('#00ff00');
    expect(r.shapes[1].style.strokeWidth).toBe(3);
  });

  it('skips hidden elements and defs', () => {
    const r = importSvg(`<svg>
      <defs><path d="M0 0 L1 1"/></defs>
      <path d="M0 0 L1 1" display="none"/>
      <path d="M0 0 L2 2"/>
    </svg>`);
    expect(r.shapes).toHaveLength(1);
  });

  it('warns about unsupported elements instead of failing', () => {
    const r = importSvg(`<svg><text x="0" y="0">hi</text><path d="M0 0 L1 1"/></svg>`);
    expect(r.shapes).toHaveLength(1);
    expect(r.warnings.join(' ')).toContain('text');
  });

  it('accepts bare path data too', () => {
    const r = importSvg('M0 0 L10 0 L10 10 Z');
    expect(r.shapes).toHaveLength(1);
    expect(r.viewBox).toBeNull();
  });

  it('uses the id as the shape name', () => {
    const r = importSvg(`<svg><path id="handle" d="M0 0 L1 1"/></svg>`);
    expect(r.shapes[0].name).toBe('handle');
  });

  it('throws on malformed markup', () => {
    expect(() => importSvg('<svg><path d="M0 0"</svg>')).toThrow();
  });
});

/* An exported document that will not re-open is the only failure here that
   survives a reload, so these assert on parsing the output rather than on its
   spelling. Both defects below shipped: `xmlId` sanitised the one attribute it
   was written for and left its neighbours interpolating raw, and nothing
   anywhere checked that two shapes had not been given the same id. */
describe('svg export cannot produce a document that will not re-open', () => {
  const twoShapes = (nameA: string, nameB: string): ReturnType<typeof emptyDoc> => {
    const doc = emptyDoc();
    doc.viewBox = { x: 0, y: 0, w: 20, h: 20 };
    const r = importSvg(`<svg viewBox="0 0 20 20">
      <path d="M0 0 L10 0 L10 10 Z"/>
      <path d="M12 12 L18 12 L18 18 Z"/>
    </svg>`);
    doc.shapes = r.shapes;
    doc.shapes[0].name = nameA;
    doc.shapes[1].name = nameB;
    return doc;
  };

  const ids = (svg: string): string[] => [...svg.matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);

  it('gives two shapes of the same name different ids', () => {
    const out = exportSvg(twoShapes('ring', 'ring'));
    const found = ids(out);
    expect(found).toHaveLength(2);
    expect(new Set(found).size).toBe(2);
    expect(found[0]).toBe('ring');
  });

  it('separates names that sanitise to the same id', () => {
    // `xmlId` is not injective: these three all hyphenate to `a-b`.
    const out = exportSvg(twoShapes('a b', 'a/b'));
    expect(new Set(ids(out)).size).toBe(2);
  });

  it('escapes a style value holding a quote, which import can supply', () => {
    const doc = twoShapes('one', 'two');
    // Legal XML on the way in: <path d="…" fill='a"b'/>
    doc.shapes[0].style.fill = 'a"b';
    const out = exportSvg(doc);

    expect(out).toContain('fill="a&quot;b"');
    // The real assertion: it parses, and the value survives intact.
    const back = importSvg(out);
    expect(back.shapes).toHaveLength(2);
    expect(back.shapes[0].style.fill).toBe('a"b');
  });

  it('escapes an ampersand and angle brackets too', () => {
    const doc = twoShapes('one', 'two');
    doc.shapes[0].style.stroke = 'a&b<c>';
    const out = exportSvg(doc);
    expect(importSvg(out).shapes[0].style.stroke).toBe('a&b<c>');
  });
});

describe('svg export', () => {
  it('writes one path per shape', () => {
    const doc = emptyDoc();
    doc.viewBox = { x: 0, y: 0, w: 20, h: 20 };
    const r = importSvg(`<svg viewBox="0 0 20 20">
      <path d="M0 0 L10 0 L10 10 Z"/>
      <path d="M12 12 L18 12 L18 18 Z"/>
    </svg>`);
    doc.shapes = r.shapes;

    const out = exportSvg(doc);
    expect(out.match(/<path /g)).toHaveLength(2);
    expect(out).toContain('viewBox="0 0 20 20"');
  });

  it('round-trips shape count and geometry', () => {
    const src = `<svg viewBox="0 0 100 100">
      <rect x="5" y="5" width="20" height="10" rx="3"/>
      <circle cx="60" cy="60" r="12"/>
      <path d="M0 90 C10 70 30 70 40 90 Z"/>
    </svg>`;
    const first = importSvg(src);
    const doc = emptyDoc();
    doc.viewBox = first.viewBox!;
    doc.shapes = first.shapes;

    const again = importSvg(exportSvg(doc, { decimals: 6 }));
    expect(again.shapes).toHaveLength(first.shapes.length);

    for (let i = 0; i < first.shapes.length; i++) {
      const a = bbox(first.shapes[i]);
      const b = bbox(again.shapes[i]);
      expect(b.x0).toBeCloseTo(a.x0, 4);
      expect(b.y0).toBeCloseTo(a.y0, 4);
      expect(b.x1).toBeCloseTo(a.x1, 4);
      expect(b.y1).toBeCloseTo(a.y1, 4);
    }
  });

  it('omits shapes too small to draw', () => {
    const doc = emptyDoc();
    const r = importSvg('<svg><path d="M0 0 L1 1"/></svg>');
    doc.shapes = r.shapes;
    doc.shapes[0].subpaths[0].nodes.pop();
    expect(exportSvg(doc).match(/<path /g)).toBeNull();
  });

  it('preserves fill-rule and stroke settings', () => {
    const r = importSvg(
      `<svg><path d="M0 0 L1 1" fill="#abc" fill-rule="evenodd" stroke="#123" stroke-width="2.5"/></svg>`,
    );
    const doc = emptyDoc();
    doc.shapes = r.shapes;
    const out = exportSvg(doc);
    expect(out).toContain('fill="#abc"');
    expect(out).toContain('fill-rule="evenodd"');
    expect(out).toContain('stroke="#123"');
    expect(out).toContain('stroke-width="2.5"');
  });
});

describe('shape names as ids', () => {
  it('passes a name that is already a valid id straight through', () => {
    expect(xmlId('outer-ring')).toBe('outer-ring');
    expect(xmlId('Layer_2.copy')).toBe('Layer_2.copy');
  });

  it('replaces what an XML Name cannot hold', () => {
    // Renaming is free text; an id is not. A name with a quote in it would
    // otherwise close the attribute and produce a document that will not parse.
    expect(xmlId('my shape')).toBe('my-shape');
    expect(xmlId('say "hi"')).toBe('say-hi');
    expect(xmlId('a/b\\c')).toBe('a-b-c');
  });

  it('fixes a leading digit rather than emitting an invalid id', () => {
    expect(xmlId('2nd ring')).toBe('n2nd-ring');
  });

  it('falls back rather than emitting an empty id', () => {
    expect(xmlId('   ')).toBe('shape');
    expect(xmlId('!!!')).toBe('shape');
  });

  it('exports a renamed shape with a usable id, and it parses back', () => {
    const doc = emptyDoc();
    const shape: Shape = {
      id: 'shape-1',
      name: 'outer ring',
      subpaths: parsePath('M0 0 L10 0 L10 10 Z'),
      style: { fill: 'none', stroke: '#000', strokeWidth: 1, fillRule: 'nonzero', opacity: 1 },
    };
    doc.shapes.push(shape);

    const svg = exportSvg(doc);
    expect(svg).toContain('id="outer-ring"');
    // And it survives a round trip rather than throwing the parser.
    expect(importSvg(svg).shapes).toHaveLength(1);
  });
});

/**
 * Opacity, which is the first style field added since fill, stroke, width and
 * rule, and the only one an SVG can put in three places at once.
 *
 * The reading is where it earns tests. A group carries no style in this model
 * (§5), so a `<g opacity>` has nowhere to live except multiplied into the shapes
 * under it, and getting that wrong is a drawing that is visibly the wrong
 * darkness with nothing on screen to explain why.
 */
describe('opacity', () => {
  const only = (svg: string) => importSvg(svg).shapes[0].style.opacity;

  it('reads the attribute', () => {
    expect(only('<svg><path d="M0 0 L1 0" opacity="0.4"/></svg>')).toBeCloseTo(0.4, 12);
  });

  it('reads it out of an inline style too', () => {
    expect(only('<svg><path d="M0 0 L1 0" style="opacity:0.25"/></svg>')).toBeCloseTo(0.25, 12);
  });

  it('is opaque when the file does not mention it', () => {
    expect(only('<svg><path d="M0 0 L1 0"/></svg>')).toBe(1);
  });

  /* The renderer multiplies down the tree and a group here holds no style, so
     the factor has to land on the shape or be lost. */
  it('multiplies a group into the shapes under it', () => {
    expect(only('<svg><g opacity="0.5"><path d="M0 0 L1 0" opacity="0.5"/></g></svg>')).toBeCloseTo(0.25, 12);
  });

  it('multiplies through two nested groups', () => {
    expect(only('<svg><g opacity="0.5"><g opacity="0.5"><path d="M0 0 L1 0"/></g></g></svg>')).toBeCloseTo(
      0.25,
      12,
    );
  });

  it('clamps a file that says more than all of it', () => {
    expect(only('<svg><path d="M0 0 L1 0" opacity="1.5"/></svg>')).toBe(1);
    expect(only('<svg><path d="M0 0 L1 0" opacity="-2"/></svg>')).toBe(0);
  });

  /* A percentage is legal in CSS and not as a presentation attribute, so
     `parseFloat` alone reads "50%" as 50 and clamps it to opaque -- which is
     right for the attribute and wrong for the inline style this also reads. */
  it('reads a percentage as a percentage', () => {
    expect(only('<svg><path d="M0 0 L1 0" style="opacity:50%"/></svg>')).toBeCloseTo(0.5, 12);
  });

  it('writes nothing when the shape is opaque, because that is the initial value', () => {
    const doc = emptyDoc();
    doc.shapes = importSvg('<svg><path d="M0 0 L1 0"/></svg>').shapes;
    expect(exportSvg(doc)).not.toContain('opacity');
  });

  it('writes it when it says something, and reads back the same number', () => {
    const doc = emptyDoc();
    doc.shapes = importSvg('<svg><path d="M0 0 L1 0" opacity="0.4"/></svg>').shapes;
    const out = exportSvg(doc);
    expect(out).toContain('opacity="0.4"');
    expect(importSvg(out).shapes[0].style.opacity).toBeCloseTo(0.4, 12);
  });

  it('rounds it with the decimals the geometry gets', () => {
    const doc = emptyDoc();
    doc.shapes = importSvg('<svg><path d="M0 0 L1 0" opacity="0.6666666"/></svg>').shapes;
    expect(exportSvg(doc, { decimals: 2 })).toContain('opacity="0.67"');
  });
});
