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
| `npm test` | Unit and DOM tests (266 across 9 files) |
| `npm run test:watch` | The same, watching |
| `npm run drive <scenario>` | Drive the real browser — see [Testing](#testing) |

The production build is one file, no external requests: **130.6 kB, 41.8 kB
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
| Drag with the ellipse or rect tool | Draw one. **Shift** for a circle or square, **Alt** from the centre |
| **Shift**-click | Add to or remove from the selection |
| Drag the bend dot | Bow a segment; appears when both its endpoints are selected |
| Wheel | Zoom at the pointer |
| **Space**-drag, or middle-drag | Pan |

### Keyboard

| Key | Effect |
|---|---|
| `V` / `P` / `E` / `R` | Select, pen, ellipse, rectangle |
| Arrows | Nudge by one grid step |
| **Shift**+arrows | Nudge by ten |
| **Ctrl**+←/→ | Bend the active segment (**Shift** for a finer step) |
| **Ctrl**+↑/↓ | Loosen or tighten it |
| `Delete` / `Backspace` | Delete selected nodes, or selected shapes |
| **Shift**+`B` | Break the path at the selected node |
| `Escape` | Finish the current pen path and clear the selection |
| `Enter` | Finish the current pen path |
| **Ctrl**+`Z` / **Ctrl**+**Shift**+`Z` | Undo / redo |
| **Ctrl**+`E` | Open or close the source drawer |
| **Ctrl**+`B` | Open or close the inspector |

A drag is one undo step, not one per frame.

### Points don't have types

There is no node type to choose before you draw. Every point is a point; what
its handles do follows from where they already are:

| Handles | Behaves as |
|---|---|
| Missing, or at different angles | Independent |
| In line, different lengths | Direction shared |
| In line, equal lengths | Fully mirrored |

Drag a handle and that relationship is preserved. **Alt**-drag to break it, and
it stays broken: the drag leaves the pair out of line, so the next one reads
them as independent too.

The `Corner`/`Smooth`/`Symm` buttons are a readout of what the handles currently
say, and clicking one moves the handles to make it so. `Corner` removes them;
`Smooth` and `Symm` on a corner grow them where the hollow ghosts sit, a third
along each neighbouring segment. Two clicks genuinely have nothing to do — the
end of an open path has no second handle to line up with, and a symmetric node
is *already* smooth, since collinear-and-equal is a special case of collinear.
Both say so in the status line rather than looking broken.

### Circles, rectangles and circularising

`E` and `R` draw an ellipse and a rectangle. Drag out a box; **Shift** constrains
it to a circle or a square by taking the shorter span, which keeps the result on
the grid whenever the drag already was, and **Alt** reads the press as the
centre rather than a corner. **Corner** in the Draw panel is the radius the
rectangle tool rounds with, clamped to half the shorter side.

They are nodes and handles from the moment they exist — there is no rect or
ellipse in the model, so there is nothing to "convert to path" before you can
drag one of the corners. A circle is four cubics with handles of `4/3·(√2−1)`
times the radius, which is round to about 0.027 % of it. A rounded rectangle is
four quarter arcs and four straight sides, and the sides stay straight because
their nodes have no handles at all.

**Circularise** goes the other way: it takes a hand-drawn or imported
near-circle and makes it exact. Every node keeps its angle about the best-fit
centre and moves to the fitted radius, then the handles are rebuilt from the
angle each segment now spans, at `r · 4/3 · tan(θ/4)`. Nodes stay where they
were around the ring and none are added, so unevenly spaced ones come out as
round as evenly spaced ones. The status line says which radius it found and how
far the furthest node had to travel — with a genuine near-circle that number is
small, and when it isn't, that is the honest measure of how much of a circle
this was to start with.

### Deleting and breaking

Delete always deletes. There is no minimum size and no case where it quietly
does less than you asked: a closed path goes down to two nodes, which draws as a
line when the segments are straight and a lens when they are curved, and below
that there is nothing left to draw so the subpath goes.

What happens to the path *around* the node is a setting, in the **Delete** panel,
because both readings are useful:

| Mode | Deleting the middle node of `M10 30 L25 15 L40 30 L55 15 L70 30` |
|---|---|
| **Fuse** (default) | `M10 30 L25 15 H55 L70 30` — still one path |
| **Split** | `M10 30 L25 15 M55 15 L70 30` — two ends |

**Fuse** is what every other editor does on Delete, and what you want when
simplifying: a pentagon becomes a quadrilateral. It rebuilds one segment out of
two, which is approximate — see the deviation note in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Split** is what you want when cutting a path apart. It is exact, because no
segment is rebuilt: every curve that survives is bit-for-bit the one that was
there. Fragments left with a single node are dropped, since a lone node has no
segments and serialises to nothing.

**Break here**, or `Shift+B`, is neither — it *keeps* the node and duplicates
it, leaving two ends exactly where the one node was, or opening a closed path at
that node. Nothing moves at all.

| | Nodes | Path | Geometry |
|---|---|---|---|
| Delete · fuse | −1 | stays whole | approximated |
| Delete · split | −1 | two ends | exact |
| Break here | +1 | two ends | exact |

### Naming shapes

Double-click a name in the Shapes list to rename it. The name is what the
exported `id` carries, and an `id` is an XML Name — no spaces, no quotes, not
starting with a digit — so anything that will not fit is hyphenated on the way
out and the status line says what the export will read. The name in the editor
is left exactly as typed.

### Combining shapes

Shift-click the shape list to select two or more, then **Unite**, **Subtract**,
**Intersect** or **Exclude**. The first shape in the list survives, keeping its
name, id and colour, and the rest are consumed — so **Subtract** is the first
minus the rest, the same way round as Inkscape's Difference and Illustrator's
Minus Front, and the result looks like the shape it replaced.

It is one undo step. If the operation produces nothing, or produces geometry
that fails a finite check, the document is left exactly as it was and the status
line says so.

### The grid

The step you type is the step you snap to *and* the step you see. When you zoom
out far enough that every line would not fit, the grid thins to every 2nd, 5th
or 10th position rather than switching to a different lattice, and the readout
says which — `1 · every 5 drawn`. Anything you can see, you can snap to.

Set the step to 0 to turn snapping off; the lattice goes with it, since there
would be nothing behind it. Arrow keys nudge by one step, Shift+arrows by ten.

### The window

The canvas is the application: it takes every pixel the panels are not using,
and the page itself never scrolls. The inspector on the right and the source
drawer at the bottom both *take* space from the canvas rather than floating over
it, so nothing you can see is ever sitting underneath a panel. Close them —
**Ctrl**+`B`, **Ctrl**+`E` — and the canvas takes the space straight back. Below
about 860 px the inspector gives up and floats, because taking 288 px from a
window that narrow leaves nothing to draw in.

The strip along the bottom is the readout: what the document contains, what the
grid is doing, the last thing that happened, and the pointer's position in
document coordinates.

### The source drawer

Closed until you open it. It shows the selected shape's `d` string, or the whole
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
    primitives.ts  ellipse, rectangle, and fitting a circle to points
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
  ui/
    styles.css     the shell: one fixed grid, no page scroll
    tooltip.ts     one tooltip layer, fed by the markup's own titles
  main.ts     wiring: document -> store -> canvas -> controller -> panels
```

5 891 lines of TypeScript across 19 files, no runtime framework.

---

## Testing

**Unit and DOM tests** — `npm test`. 266 tests over parsing, serialising,
geometry ops, rendering invariants, SVG import/export, bend, booleans, the grid
and the primitives. The rendering tests run in jsdom against the real `Canvas`.

Where a test could pass for the wrong reason, it doesn't compare point sets or
path strings — it measures. Curve equality is by projected deviation, boolean
results by enclosed area. A boolean is obliged to produce a region, not a
particular spelling of one, and asserting on the `d` string would break every
time a contour got reordered.

The grid tests are the other shape: an exact invariant — every drawn line sits
on a snap position — swept across six orders of magnitude of zoom and nine snap
steps. There is no tolerance to tune, so there is no reason to sample.

**Browser tests** — `npm run drive <scenario>`, which drives the real
Chromium-based Edge at `/usr/bin/microsoft-edge` through `playwright-core`.
No browser download; adjust the path at the top of `tools/drive.mjs` if yours
differs, and pass `--headed` to watch.

Scenarios: `smoke`, `penPolygon`, `penWithDrags`, `latentHandle`, `penUndo`,
`continuity`, `bend`, `pasteIcon`, `applyTwoShapes`, `combine`, `gridHonesty`,
`marqueeDelete`, `smallClosedPath`, `deleteModes`, `chrome`, `primitives`.

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
