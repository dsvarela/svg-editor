# svg-editor

A grid-based SVG path editor that you drive by dragging the drawing, not by
editing a table of commands.

The reference point is [yqnn's svg-path-editor](https://yqnn.github.io/svg-path-editor/),
which is excellent at what it does: precise numeric control over a path's
command list. The trade is that its model *is* a command list, so the interface
has to be one too. You pick `C` or `Q` or `A`, you think about relative versus
absolute, and you keep track of which numbers are control points.

Here the model is nodes and handles. Commands exist only when reading a file in
and writing one out. Everything between is anchors, control points and
transforms, which is what makes dragging, rotating, flipping and combining
shapes ordinary operations rather than ten special cases each.

**Status:** working, and short of finished. See [SHOPPING-LIST.md](SHOPPING-LIST.md)
for what is deliberately not built yet and why.

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
| `npm test` | Unit and DOM tests (324 across 10 files) |
| `npm run test:watch` | The same, watching |
| `npm run drive <scenario>` | Drive the real browser. See [Testing](#testing) |

The production build is one file, no external requests: **161.1 kB, 51.2 kB
gzipped**. Open `dist/index.html` from disk and it works.

---

## Documentation

| Where | What |
|---|---|
| [`docs/manual/`](docs/manual/README.md) | The manual: tutorial, how-to guides, reference, explanation |
| [`docs/STYLE.md`](docs/STYLE.md) | How everything a reader sees gets written |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Why the code looks the way it does |
| [`docs/REVIEW-2026-08-11.md`](docs/REVIEW-2026-08-11.md) | The last review: ten defect classes, six fixed |
| [`SHOPPING-LIST.md`](SHOPPING-LIST.md) | What is deliberately not built yet, and why |

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
    primitives.ts  ellipse, rectangle, and fitting a circle to points
  model/      the document and every mutation it allows
    doc.ts         shapes, selection, bounding boxes
    ops.ts         all geometry edits
    simplify.ts    refit a path with fewer nodes
    transform.ts   what the selection box's handles mean
    store.ts       state, undo, batching
  view/       rendering
    canvas.ts      two stacked SVGs: artwork and overlay
    viewport.ts    camera, zoom, screen<->document
    dom.ts         element pooling
  io/
    svg.ts         import and export whole documents
    boolean.ts     unite/subtract/intersect/exclude, via path-bool
  tools/
    controller.ts  every pointer and keyboard interaction
  ui/
    styles.css     the shell: one fixed grid, no page scroll
    tooltip.ts     one tooltip layer, fed by the markup's own titles
  main.ts     wiring: document -> store -> canvas -> controller -> panels
```

8 359 lines of TypeScript across 22 files, no runtime framework.

---

## Testing

**Unit and DOM tests**, with `npm test`. 378 tests over parsing, serialising,
geometry ops, rendering invariants, SVG import/export, bend, booleans, simplify,
transforms, history, the grid and the primitives. The rendering tests run in jsdom against the real `Canvas`.

Where a test could pass for the wrong reason, it doesn't compare point sets or
path strings. It measures instead: curve equality by projected deviation, boolean
results by enclosed area. A boolean is obliged to produce a region, not a
particular spelling of one, and asserting on the `d` string would break every
time a contour got reordered.

The grid tests are the other shape: an exact invariant, that every drawn line
sits on a snap position, swept across six orders of magnitude of zoom and nine snap
steps. There is no tolerance to tune, so there is no reason to sample.

**Browser tests**, with `npm run drive <scenario>`, which drives the real
Chromium-based Edge at `/usr/bin/microsoft-edge` through `playwright-core`.
No browser download; adjust the path at the top of `tools/drive.mjs` if yours
differs, and pass `--headed` to watch.

Scenarios: `smoke`, `penPolygon`, `penWithDrags`, `latentHandle`, `penUndo`,
`continuity`, `bend`, `pasteIcon`, `applyTwoShapes`, `combine`, `gridHonesty`,
`marqueeDelete`, `smallClosedPath`, `deleteModes`, `chrome`, `primitives`,
`backdrop`, `simplify`, `transform`, `canvasFrame`.

`gridHonesty` is the one that needs a real browser rather than jsdom: the drawn
step is derived from a measured element width, so the invariant can only be
checked properly against a layout engine that has one. `chrome` is the other:
it asserts that the canvas grows when a panel closes and that the page has no
scroll to speak of, neither of which means anything without real layout.

Every run also audits the overlay: how many anchors and handles are actually in
the DOM, and whether any rendered `d` is malformed. That is what catches stray
geometry surviving a delete or an undo.

The driver refuses to click a document coordinate that maps outside the canvas,
or outside the viewport. Both guards exist because the harness lied to itself:
the first once pressed "Rotate +90°" on the rail and the resulting bug report
was about the editor; the second let clicks land at a negative `y` after typing
into the source box scrolled the canvas off the top, so a scenario reported that
selecting a node did nothing.

---

## Credit and licences

The path tokenizer, the number formatter and the adaptive grid step are adapted
from **[Yann Armelin's svg-path-editor](https://github.com/Yqnn/svg-path-editor)**
(Apache-2.0). Attribution is on each adapted function; see [NOTICE](NOTICE).

Boolean operations use **[PathBool.js](https://github.com/r-flash/PathBool.js)**
by Adam Platkevič (MIT), the one piece of geometry here deliberately not written
by hand.

Ideas taken without code: [TikZiT](https://tikzit.github.io/)'s edge model,
which is where bend comes from, and [IPE](https://otfried.github.io/ipe/)'s
layered snapping, which is on the shopping list.
