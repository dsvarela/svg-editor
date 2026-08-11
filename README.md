# svg-editor

A grid-based SVG path editor that you drive by dragging the drawing, not by
editing a table of commands.

The reference point is [yqnn's svg-path-editor](https://yqnn.github.io/svg-path-editor/),
which is excellent at what it does: precise numeric control over a path's
command list. The trade is that its model *is* a command list, so the interface
has to be one too — you pick `C` or `Q` or `A`, you think about relative versus
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
| `npm test` | Unit and DOM tests (171 across 7 files) |
| `npm run test:watch` | The same, watching |
| `npm run drive <scenario>` | Drive the real browser — see [Testing](#testing) |

The production build is one file, no external requests: **70.8 kB, 22.3 kB
gzipped**. Open `dist/index.html` from disk and it works.

---

## Using it

### Mouse

| Action | Effect |
|---|---|
| Click a node | Select it; its handles appear, including hollow ones you can pull out |
| Drag a node | Move it, handles and all |
| Drag a handle | Move it, preserving whatever relationship the pair already had |
| **Alt**-drag a handle | Move it alone, breaking the pair |
| Drag the outline | Move the whole shape |
| Double-click the outline | Insert a node exactly there, without changing the curve |
| Double-click a node | Cycle corner → smooth → symmetric |
| Drag on empty canvas | Marquee-select |
| **Shift**-click | Add to or remove from the selection |
| Drag the bend dot | Bow a segment; appears when both its endpoints are selected |
| Wheel | Zoom at the pointer |
| **Space**-drag, or middle-drag | Pan |

### Keyboard

| Key | Effect |
|---|---|
| `V` / `P` | Select tool / pen tool |
| Arrows | Nudge by one grid step |
| **Shift**+arrows | Nudge by ten |
| **Ctrl**+←/→ | Bend the active segment (**Shift** for a finer step) |
| **Ctrl**+↑/↓ | Loosen or tighten it |
| `Delete` / `Backspace` | Delete selected nodes, or selected shapes |
| `Escape` | Finish the current pen path and clear the selection |
| `Enter` | Finish the current pen path |
| **Ctrl**+`Z` / **Ctrl**+**Shift**+`Z` | Undo / redo |

A drag is one undo step, not one per frame.

### Points don't have types

There is no node type to choose before you draw. Every point is a point; what
its handles do follows from where they already are:

| Handles | Behaves as |
|---|---|
| Missing, or at different angles | Independent |
| In line, different lengths | Direction shared |
| In line, equal lengths | Fully mirrored |

Drag a handle and that relationship is preserved. **Alt**-drag to break it. The
`Corner`/`Smooth`/`Symm` buttons are a readout of what the handles currently
say, and clicking one moves the handles to make it so — `Corner` removes them.

### The source box

The panel at the bottom shows the selected shape's `d` string, or the whole
document as SVG. Edit it and press Apply. It parses `M L H V C S Q T A Z` in
any mixture of relative and absolute, and paste of a whole `<svg>` document
works — `rect`, `circle`, `ellipse`, `line`, `polyline` and `polygon` are
converted to paths, and `transform` attributes are baked in.

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
  model/      the document and every mutation it allows
    doc.ts         shapes, selection, bounding boxes
    ops.ts         all geometry edits
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
  main.ts     wiring: document -> store -> canvas -> controller -> panels
```

4 613 lines of TypeScript across 17 files, no runtime framework.

---

## Testing

**Unit and DOM tests** — `npm test`. 171 tests over parsing, serialising,
geometry ops, rendering invariants, SVG import/export, bend, and booleans.
The rendering tests run in jsdom against the real `Canvas`.

Where a test could pass for the wrong reason, it doesn't compare point sets or
path strings — it measures. Curve equality is by projected deviation, boolean
results by enclosed area. A boolean is obliged to produce a region, not a
particular spelling of one, and asserting on the `d` string would break every
time a contour got reordered.

**Browser tests** — `npm run drive <scenario>`, which drives the real
Chromium-based Edge at `/usr/bin/microsoft-edge` through `playwright-core`.
No browser download; adjust the path at the top of `tools/drive.mjs` if yours
differs, and pass `--headed` to watch.

Scenarios: `smoke`, `penPolygon`, `penWithDrags`, `latentHandle`, `penUndo`,
`continuity`, `bend`, `pasteIcon`, `applyTwoShapes`.

Every run also audits the overlay: how many anchors and handles are actually in
the DOM, and whether any rendered `d` is malformed. That is what catches stray
geometry surviving a delete or an undo.

The driver refuses to click a document coordinate that maps outside the canvas.
That guard exists because it silently pressed "Rotate +90°" on the rail during
development and the resulting bug report was about the editor.

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
