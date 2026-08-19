# svg-editor

A grid-based SVG path editor that you drive by dragging the drawing, not by
editing a table of commands.

**Use it at [dsvarela.github.io/svg-editor](https://dsvarela.github.io/svg-editor/),
or download one file.** The whole editor is a single HTML page with every
asset inlined, 334 kB on 2026-08-19. Take the `.html` from [the latest
release](https://github.com/dsvarela/svg-editor/releases/latest), open it in a
browser, and it runs offline with no server and nothing installed.

The reference point is [yqnn's svg-path-editor](https://yqnn.github.io/svg-path-editor/),
which is excellent at what it does: precise numeric control over a path's
command list. The trade is that its model *is* a command list, so the interface
has to be one too. You pick `C` or `Q` or `A`, you think about relative versus
absolute, and you keep track of which numbers are control points.

Here the model is nodes and handles. Commands exist only when reading a file in
and writing one out. Everything between is anchors, control points and
transforms, which is what makes dragging, rotating, flipping and combining
shapes ordinary operations rather than ten special cases each.

**Status:** working, and short of finished. See
[`docs/SHOPPING-LIST.md`](docs/SHOPPING-LIST.md) for what is deliberately not
built yet and why.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Typecheck, then build to a single self-contained `dist/index.html` |
| `npm run check` | Typecheck only |
| `npm run check:docs` | The [style](docs/STYLE.md) tell sweep, and every link in the docs |
| `npm run check:contrast` | Every colour pair in `src/ui/pairs.txt`, against the WCAG floors |
| `npm test` | Unit and DOM tests. See [Testing](#testing) |
| `npm run test:watch` | The same, watching |
| `npm run drive <scenario>` | Drive the real browser. See [Testing](#testing) |

The production build is one file, no external requests: **337.4 kB, 97.1 kB
gzipped**, measured after the review in
[`docs/reviews/2026-08-19c.md`](docs/reviews/2026-08-19c.md), as `npm run build`
reports it. Open `dist/index.html`
from disk and it works. Auto-trace is 4.2 kB of
that all-in, against the 278 kB a WASM tracer would have cost: 2.3 kB of tracer
and 1.9 kB for the inlined worker it runs in, measured by building without it.
See ARCHITECTURE §26 and §28.

---

## Documentation

Everything is under [`docs/`](docs/README.md), which opens by saying how each
kind is meant to be read. Four kinds, because a backlog read as a description
tells you a feature exists that does not.

| Where | What | Read it as |
|---|---|---|
| [`docs/manual/`](docs/manual/README.md) | Tutorial, how-to guides, reference, explanation | the editor as shipped |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Why the code looks the way it does, and what it costs | a standing explanation |
| [`docs/STYLE.md`](docs/STYLE.md) | How everything a reader sees gets written | a rule to apply |
| [`docs/SHOPPING-LIST.md`](docs/SHOPPING-LIST.md) | What is deliberately not built yet, and why | intent, not behaviour |
| [`docs/reviews/`](docs/reviews/README.md) | Nine reviews, 2026-08-11 to 2026-08-19, each with what it found and what it got wrong | evidence, true of its date |

---

## Using it

The full account is in the [manual](docs/manual/README.md). The short version:

Shapes are made of **nodes**, each with up to two **handles** that decide how
the line curves through it. You drag them directly. There is no command table to
edit and no node type to choose before you draw, because continuity is worked
out from where the handles are rather than stored as a flag.

Everything is a path. The ellipse and rectangle tools produce nodes and handles
like anything else, so nothing needs converting before you can edit it or
subtract it from something.

Shapes can be grouped, and a group is one `<g>` on export. It carries no transform:
grouping changes no coordinate, so a group says what belongs together rather than
where it is.

| I want to | Go to |
|---|---|
| Learn it by drawing something | [Tutorial](docs/manual/tutorial.md) |
| Finish one specific task | [How-to guides](docs/manual/how-to.md) |
| Look up a key, button or panel | [Reference](docs/manual/reference.md) |
| Understand why it behaves like that | [Explanation](docs/manual/explanation.md) |

---

## Layout

```
src/
  core/       geometry and file format; no DOM, no state
    types.ts       the model, and what a node is
    parse.ts       path data -> nodes
    serialise.ts   nodes -> the shortest exact path data
    bezier.ts      evaluate, split, project, bound
    arc.ts         SVG arcs -> cubics
    affine.ts      2x3 matrices
    bend.ts        a curve described as angle + looseness
    fit.ts         cubics through a run of points, by least squares
    primitives.ts  ellipse, rectangle, polygon and star
    raster.ts      a raster's boundaries -> polylines, for tracing
    intersect.ts   where two cubics cross, by hull subdivision
    offset.ts      a path parallel to another, and stroke outlines
  model/      the document and every mutation it allows
    doc.ts         shapes, groups, selection, bounding boxes
    ops.ts         all geometry edits
    arrange.ts     align, distribute and space whole shapes
    simplify.ts    refit a path with fewer nodes
    knots.ts       remove the nodes that are not doing anything
    auto.ts        handles that re-derive themselves from their neighbours
    snapping.ts    which snap wins: vertex, then outline, then grid
    smart.ts       alignment you did not have to place
    angles.ts      rays from a point, at multiples of an angle
    guides.ts      straight lines you place, and then aim at
    keylines.ts    the icon keyline grid: circle, square, two rectangles
    pixelfit.ts    where the lattice sits so strokes land on whole pixels
    trace.ts       raster boundaries -> shapes, one per colour
    trace.worker.ts   the same walk, off the main thread
    transform.ts   what the selection box's handles mean
    store.ts       state, undo, batching
  view/       rendering
    canvas.ts      two stacked SVGs: artwork and overlay
    viewport.ts    camera, zoom, screen<->document
    pathcache.ts   `d` strings, rebuilt only when the geometry moved
    rulers.ts      the two rulers, and the guides they hand out
    dom.ts         element pooling
  io/
    svg.ts         import and export whole documents
    pixels.ts      the document as a data URI, and as a PNG
    boolean.ts     unite/subtract/intersect/exclude, via path-bool
    session.ts     the whole session as one JSON value, and back
    storage.ts     that value in `localStorage`, and the two ways it fails
  tools/
    controller.ts  pointer gestures on the canvas
    commands.ts    what a button or a key does to the document
    keys.ts        which of those two a key reaches
    readout.ts     how a number is written into a status line
  ui/
    styles.css     the shell: one fixed grid, no page scroll
    tooltip.ts     one tooltip layer, fed by the markup's own titles
  main.ts     wiring: document -> store -> canvas -> commands -> panels
```

19 261 lines of TypeScript across 44 files, plus 1 436 lines of CSS, counted on
2026-08-19. No runtime framework.

---

## Testing

**Unit and DOM tests**, with `npm test`. 1 110 tests in 37 files, 15 119 lines
after the review in [`docs/reviews/2026-08-19c.md`](docs/reviews/2026-08-19c.md), over parsing, serialising, geometry ops, rendering invariants, SVG
import/export, bend, booleans, simplify, fusing, snapping, pixel fit, tracing,
transforms, history, tooltips, node identity, the clipboard, corner fillets,
groups, arranging shapes, paint order, PNG output, the grid and the primitives. The rendering
tests run in jsdom against the real `Canvas`.

Where a test could pass for the wrong reason, it doesn't compare point sets or
path strings. It measures instead: curve equality by projected deviation, boolean
results by enclosed area. A boolean is obliged to produce a region, not a
particular spelling of one, and asserting on the `d` string would break every
time a contour got reordered.

The grid tests are the other shape: an exact invariant, that every drawn line
sits on a snap position, swept across six orders of magnitude of zoom and nine snap
steps. There is no tolerance to tune, so there is no reason to sample.

**Browser tests**, with `npm run drive <scenario>`, which drives a real Firefox
through `playwright-core`. Playwright drives its own builds rather than the
browser you installed, so this needs
`node node_modules/playwright-core/cli.js install firefox` once. `BROWSER` picks
another engine and `BROWSER_PATH` points at a system Chromium-family binary,
which does not need the download. Pass `--headed` to watch.
`npm run drive -- --list` names every scenario.

There are 53 of them on 2026-08-19, and they are not listed here: `--list`
prints the set that exists, and a copy of it in this file is a second list that
drifts. This one had drifted by twelve before anyone noticed.

`gridHonesty` is the one that needs a real browser rather than jsdom: the drawn
step is derived from a measured element width, so the invariant can only be
checked properly against a layout engine that has one. `pixelFit` is the same
idea half a pixel finer: it reads the drawn gridlines out of the overlay and
checks a dragged node landed on one of them. `trace` needs a browser for a
different reason -- it writes a PNG, loads it as a backdrop and traces it, so
image decoding and `getImageData` are under test rather than mocked. `chrome` is the other:
it asserts that the canvas grows when a panel closes and that the page has no
scroll to speak of, neither of which means anything without real layout.

Every run also audits the overlay: how many anchors and handles are in the DOM,
and whether any rendered `d` is malformed. That is what catches stray
geometry surviving a delete or an undo.

The driver refuses to click a document coordinate that maps outside the canvas,
or outside the viewport. Both guards exist because the harness lied to itself:
the first once pressed "Rotate +90°" on the rail and the resulting bug report
was about the editor; the second let clicks land at a negative `y` after typing
into the source box scrolled the canvas off the top, so a scenario reported that
selecting a node did nothing.

---

## Credit and licences

**[Apache-2.0](LICENSE).** It follows the largest thing adapted here, so the
[NOTICE](NOTICE) file the project already carried is the mechanism the licence
expects rather than a second scheme running alongside it.

The path tokenizer, the number formatter and the adaptive grid step are adapted
from **[Yann Armelin's svg-path-editor](https://github.com/Yqnn/svg-path-editor)**
(Apache-2.0). Attribution is on each adapted function; see [NOTICE](NOTICE).

The raster boundary walk is ported from
**[ImageTracerJS](https://github.com/jankovicsandras/imagetracerjs)** by András
Jankovics (Unlicense), which asks for no attribution and gets it anyway.

Boolean operations use **[PathBool.js](https://github.com/r-flash/PathBool.js)**
by Adam Platkevič (MIT), the one piece of geometry here deliberately not written
by hand.

Ideas taken without code: [TikZiT](https://tikzit.github.io/)'s edge model,
which is where bend comes from, and [IPE](https://otfried.github.io/ipe/)'s
layered snapping, now built: see ARCHITECTURE §27.
