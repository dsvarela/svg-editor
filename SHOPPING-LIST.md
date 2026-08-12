# Shopping list

Candidate features, with where the idea comes from and a rough size.
S = an afternoon. M = a day, needs tests. L = a project in itself.

Status: `[ ]` not started · `[~]` partial · `[x]` done

The second 2026-08-12 review, of Fuse, pixel fit, auto-trace and the snap
priority order, is in
[`docs/REVIEW-2026-08-12b.md`](docs/REVIEW-2026-08-12b.md) — twelve defect
classes fixed, fifteen documentation claims corrected, nine tests rewritten
because they could not fail. Four of those classes were introduced by a fix from
the same morning.

The first 2026-08-12 review of the backdrop, Simplify, transform box, canvas,
Style and rounding work is in
[`docs/REVIEW-2026-08-12.md`](docs/REVIEW-2026-08-12.md) — nine defect classes
fixed, seventeen documentation claims corrected, six tests rewritten because
they could not fail.

The 2026-08-11 review of the primitives/rename/tooltips commit is in
[`docs/REVIEW-2026-08-11.md`](docs/REVIEW-2026-08-11.md) — ten defect classes,
all ten now fixed. The tenth, coincident nodes mid-path, closed on 2026-08-12
with **Fuse nodes that are not ends** below.

---

## Snapping — the precision story

Three tiers, resolved by one rule: the most specific target within eight screen
pixels wins, so a vertex beats an outline beats the grid. Pixel fit is the grid's
phase rather than a fourth tier. See ARCHITECTURE §27. What is left below is
intersections, angles, and guides.

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Boundary snap** — done, as **Snap to outlines**. The 1-D tier: a point anywhere along an existing curve, beaten by a vertex and beating the grid. `nearestOnPath` gained a segment filter, because a node being dragged lies on the two segments it joins and both report a distance of zero. See ARCHITECTURE §27. | IPE | — |
| `[ ]` | **Intersection snap** — snap where two paths cross. Needs a cubic–cubic solver. | IPE | M |
| `[ ]` | **Angular snap** — constrain to rays at multiples of N° from a settable origin and base direction (IPE: `F1` origin, `F2` direction, `F3` takes both from a nearby edge). | IPE | M |
| `[x]` | **Principled priority order** — done. The most specific target within reach wins: vertex (0-D) beats boundary (1-D) beats grid (2-D), and distance does not break ties between tiers. Pixel fit turned out not to be a fourth tier but the grid's phase, which is what settles how it interacts with the other two. The rule is a pure function in `model/snapping.ts` rather than an accident of statement order in the controller. See ARCHITECTURE §27. | IPE | — |
| `[x]` | **Displayed grid ≠ snap grid (defect)** — fixed. `gridDisplayFor` draws `gridStep × m` with `m` a whole number off the 1-2-5 ladder, so every line on screen is a snap position; zooming out thins the lattice instead of switching to a different one, and the readout says which (`1 · every 5 drawn`). See ARCHITECTURE §9. | — | — |
| `[x]` | **Pixel-fit** — done. A stroke is painted centred on its path, so a 1-unit stroke on a whole coordinate covers half of two pixels instead of all of one, and snapping anchors to integers made it worse rather than better. The fix is one line of arithmetic — the painted edges are whole exactly when `x ≡ w/2 (mod 1)` — so it is the same lattice shifted by a phase, not a second kind of snapping. The drawn grid shifts by the same phase from the same function, which is what keeps §9's contract. A selection whose shapes want different lattices reports `mixed widths` rather than fitting one of them. **Fit selection to pixels** applies it to what already exists. See ARCHITECTURE §25. | icon-design practice | — |
| `[ ]` | **Rulers + draggable guides** — manual guides you place, distinct from the grid. | Boxy SVG, Method Draw | M |
| `[ ]` | **Smart guides** — transient alignment lines when a drag lines up with another object's edge or centre. | Boxy SVG, Figma | M |
| `[ ]` | **Keyline shapes** — circle/square/portrait/landscape templates on a non-exporting layer, the standard icon-grid starting point. | icon-design practice | S |

## Node editing

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **A point is a point** — continuity is derived from the handles wherever it is needed, never stored. Dragging a handle preserves whatever relationship the pair already had; Alt-drag breaks it. Nothing to choose up front, and the marker on screen cannot disagree with the geometry. | — | — |
| `[ ]` | **Auto-smooth node** — handles re-derive themselves from the neighbours whenever anything nearby moves. Inkscape's fourth type, and the one that saves the most fiddling. Note this one genuinely does need stored state: "keep recomputing me" is not something a static pair of handles can express. | Inkscape | M |
| `[ ]` | **Continuity shortcuts** — `Shift+C` corner, `Shift+S` smooth, `Shift+Y` symmetric. Double-click already cycles. | Inkscape | S |
| `[x]` | **Connect ends** (`Shift+J`) — done. Draws the missing segment between two free ends. Both nodes stay, nothing moves, and the segment is straight for free. This is what "join" means to anyone who has not memorised Inkscape, so it got the obvious key. | Inkscape's `Shift+Ctrl+J` | — |
| `[x]` | **Merge ends** (`Shift+M`) — done. Welds two free ends into one node at their midpoint, so ends already coincident do not move and it is the exact inverse of `Break path`. Each end keeps the handle facing away from the joint, since the one facing it governed nothing. Shipped first under the name `Join`, which was wrong: one name covered both readings and it did the destructive one. | Inkscape's `Shift+J`, TikZiT (`Ctrl+M`) | — |
| `[x]` | **Resume a finished path** — done. The pen picks up either end of an existing open path and carries on, reversing it when you click the start. Without it a path put down and let go of could never be extended again, which is the gap that prompted both this and Join. | every editor | — |
| `[x]` | **Fuse nodes that are not ends** — done, on `Shift+F`. Welds two adjacent nodes into one anywhere along a path, and with a shape selected sweeps it for zero-length segments instead. It sounds like the harder relative of Merge ends and is the easier one: in the middle of a path there is no topology to change, so nothing reverses and no subpath appears or disappears. Two nodes further apart are refused rather than guessed at. The generators were fixed at the same time: `rectSubpath` emits a vanished side's two tangent points as one node, so a square rounded to its own limit is a four-node circle, and `circulariseSubpath` sweeps afterwards and reports the count. The Delete mode that used to be called Fuse is now **Heal**. See ARCHITECTURE §24. | Inkscape | — |
| `[x]` | **Break path** (`Shift+B`) — split at the selected node, leaving two ends; a closed path opens at that node instead. The node is duplicated, so nothing moves — this is the lossless counterpart to deleting a node, which cannot be. See ARCHITECTURE §13. | Inkscape | — |
| `[ ]` | **Reverse direction** + optional direction arrows on the outline. Matters for fill-rule and for which end a marker lands on. | Boxy SVG, Inkscape | S |
| `[ ]` | **Make path** — turn a selection into a single path. | TikZiT (`Ctrl+P`) | S |
| `[~]` | **Drag the curve directly** — done as bend mode, but ours only engages when the segment is symmetric. Figma's version works on any segment and re-derives both handles. Worth relaxing. | Figma bend tool | S |

## Path operations

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Booleans** — unite / intersect / subtract / exclude, in the Combine panel. Select two or more shapes; the first survives with its name and style, and `subtract` takes the rest away from it. Built on [`path-bool`](https://www.npmjs.com/package/path-bool) (MIT) — see below. | Boxy SVG, Inkscape, everything | — |
| `[x]` | **Simplify** — done. Schneider's least-squares fit (`core/fit.ts`) under a layer that decides which runs to fit (`model/simplify.ts`): corners past 50° are kept and fitted around, every surviving node keeps its tangents as inputs to the fit, and a closed path is cut at node 0 with the original tangents handed in from both sides so there is no kink at the seam. Sampling caps spacing as well as flatness, without which the tolerance is only checked where a sample happens to sit. A result with the same node count is refused. See ARCHITECTURE §19. | Boxy SVG, Inkscape | — |
| `[ ]` | **Offset path** — parallel outline at a distance. Shares most of its machinery with stroke-to-path. | Illustrator, Inkscape | L |
| `[ ]` | **Stroke to path** — convert a stroked outline into a filled shape. | Boxy SVG, Inkscape | L |

## Interface

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Primitive tools** — done. Ellipse and rectangle draw tools (`E`, `R`), Shift to constrain, Alt from the centre, and a corner radius for the rectangle. Built as nodes and handles, so there is nothing to convert before editing one. The drag ignores the shape it is drawing when point-snapping, and refuses to commit one with no area. | every editor | M |
| `[x]` | **Circularise** — done. Fits a circle through a contour's nodes by least squares, moves each onto it at its own angle, and rebuilds handles at `r·4/3·tan(θ/4)`. A closed contour is treated as a ring — one winding, spans summing to a full turn — so a gap wider than 180° closes instead of retracing, and a node order that is not a ring is refused. Reports the radius, the furthest node's travel, and the widest gap when it is wide enough to limit the result. | Inkscape's "make circle" | M |
| `[~]` | **Rename shapes** — double-click the name in the list. It is what the exported `id` carries, sanitised to an XML Name and made unique on the way out. Class 8 of the review is closed: the row's click handler ignores anything inside `.rename`, and a plain click selects rather than toggles. Still open: no keyboard route to start a rename other than `F2` on a focused row. | every editor | S |
| `[~]` | **Tooltips** — one layer, fed by the markup's own `title` attributes, with the shortcut pulled out as a key cap; the two tool buttons now put theirs last so it renders. Class 10 of the review is closed: `aria-describedby` is set on show and removed on hide, so a control keeps its accessible description. | — | S |
| `[x]` | **Fill, stroke and width** — done. A Style group with fill, stroke, width and fill rule, applied to the selected shapes or, with nothing selected, to whatever you draw next. `Style` had been in the model, imported and exported faithfully, and honoured by the renderer since the beginning; nothing could change it, so the editor produced exactly one appearance of SVG. The colour pickers stay live while `none` is ticked, because disabling them made filling an unfilled shape a two-step dance whose first step committed a colour nobody chose. See ARCHITECTURE §22. | every editor | — |
| `[x]` | **Tabbed inspector** — done. Eleven groups split three ways by what they act on: Shape, Node, Document. Nothing switches tab on its own, and hidden panels use `hidden` so their controls leave the tab order too. Requested 2026-08-12, when one scrolling column had become "a lot of scrolling through random stuff". | Figma, Illustrator | — |
| `[x]` | **Round a corner from a node** — done. **Round** and **Apply** in the Node panel replace the selected corners with an arc of that radius, tangent to both sides, which is the operation the rectangle tool performs only while drawing. Refuses a curved side rather than approximating: a fillet is defined by touching two lines, and one that is a fraction of a degree off tangent looks right and is wrong. The radius is clamped to what the shorter side holds, and the clamp is reported. Applied from the highest index down, since each rounded corner turns one node into two. See ARCHITECTURE §23. | Figma corner radius, Illustrator live corners | — |
| `[x]` | **Application shell** — done. One fixed grid filling the window, canvas edge to edge, no page scroll; the toolbar is icons, the source is a drawer you open (`Ctrl+E`) and the inspector collapses (`Ctrl+B`). Panels take space from the canvas rather than floating over it, and a `ResizeObserver` re-fits the camera when they do. | Figma, Rive | M |
| `[~]` | **Measurement readout** — the pointer's document coordinates are in the status strip. Live length and angle *while dragging* is the part still missing. | Illustrator, IPE | S |
| `[x]` | **Document canvas** — done. `doc.viewBox` is drawn on the canvas with everything outside it dimmed, editable as four numbers in the Canvas panel, and **Fit canvas to drawing** wraps it around the content rounded outwards to whole grid steps. It still never follows the drawing on its own, because an icon is drawn to a page and a page that resized itself would make a margin impossible to hold. Reported as "viewbox seems to not update at all, with anything", which was true and was mostly invisible: nothing on screen said where the page was. See ARCHITECTURE §21. | every editor | — |
| `[x]` | **Zoom readout** — done. A percentage in the status strip, where 100 % is one document unit per pixel, and clicking it returns to 100 % about the centre of the view. | every editor | — |
| `[x]` | **On-canvas transform box** — done. Eight scale handles and four rotation zones around the selection, for shapes and for node subsets alike. `Shift` keeps the proportions by projecting onto the diagonal, `Alt` scales about the centre, dragging past the far side mirrors, and `Shift` snaps a turn to 15°. Every frame recomputes from the geometry captured at the press rather than composing onto the last, so a drag out and back is the identity. The box is drawn six pixels outside the true bounds and the rotation zones sit diagonally outside the corners, because a shape's nodes sit on its own bounding box and the handles are in front of them. See ARCHITECTURE §20. | every editor | — |
| `[x]` | **Hand tool** — done. A pan tool on `H`, with a grab cursor, for pointers with no middle button. Space-drag still pans from any tool. | every editor | — |
| `[x]` | **Modified scroll** — done. Plain and `Ctrl` zoom, `Shift` pans sideways, `Alt` pans up and down. Trackpads report sideways scrolling as `deltaX`, so whichever axis moved is the one used. | Figma, Illustrator | — |
| `[x]` | **Marquee at low zoom** — fixed. `box()` set `stroke-width` to document-units-per-pixel on an element that already carried `vector-effect: non-scaling-stroke`, so the width was scaled twice and the rubber band grew into a picket fence when zoomed out: 0.062 px near, 0.909 px far. Width now comes from CSS in pixels for everything non-scaling, and `marqueeDelete` measures it at both ends of the zoom range. Separately, handles nearer their node than the node's own marker are no longer drawn, which thins the overlay on a shape under about 120 px. | — | — |
| `[ ]` | **Two-tier nudge** — coarse and fine arrow-key steps, both configurable. Currently `gridStep` and `10×`. | TikZiT | S |
| `[ ]` | **Revert-failed-source** — if the typed `d`/SVG doesn't parse, restore the last good text rather than leaving the field broken. | TikZiT | S |
| `[ ]` | **Jump to source** — select a node, land the cursor on the command that produced it. | TikZiT | M |
| `[ ]` | **Named styles palette** — reusable fill/stroke sets rather than per-shape colours. | TikZiT | M |
| `[ ]` | **Wireframe view** — outlines only, no fills, for editing overlapping shapes. | Method Draw | S |
| `[ ]` | **Keyboard completeness** — every operation reachable without the mouse. We're partway. | quiver | M |

### The boolean decision — settled

`path-bool` (MIT) clears the "don't write it yourself" bar comfortably:

| | |
|---|---|
| Interface | a path is a flat array of segments; a cubic is `["C", p0, c1, c2, p3]` |
| Curves | lines, cubics, quadratics, elliptical arcs; multiple subpaths; self-intersections |
| Operations | union, difference, intersection, exclusion, division, fracture |
| Runtime deps | none — `gl-matrix` is inlined at publish |
| Maintenance | published 2026-08-05 |
| Independent use | ported to Rust and shipped inside [Graphite](https://graphite.rs) |

**Its segment format is our node model.** A subpath maps to segments one to one
in both directions, so `src/io/boolean.ts` is a translation, not an integration
layer, and it never touches path-data strings — we keep our own parser and
serialiser on both sides.

**Cost, measured in our own build** rather than guessed from the shipped dist:

| | raw | gzipped |
|---|---|---|
| Before wiring | 70.8 kB | 22.3 kB |
| After wiring, as shipped | 106.6 kB | 35.1 kB |
| **Delta** | **+35.8 kB** | **+12.8 kB** |

That is the pre-measured estimate of +33.2 kB / +12.1 kB plus about 2.5 kB of
UI wiring and the grid rework in the same build. The npm tarball's 143 kB is
unminified and includes the path-data parser we do not use; our build minifies
and tree-shakes both away.

Vendoring the source instead was considered and rejected: it is 4 925 lines of
TypeScript, more than this entire editor, and only 92 of those lines concern
arcs — so trimming to the subset we feed it (lines and cubics only) would save
almost nothing while forfeiting upstream fixes on a library whose author is
still actively hunting failure cases.

One quality signal worth recording, found while reading the source: gl-matrix
allocates as `Float32Array`, and the author traced tangent-ordering failures
around a vertex to exactly that, then forced `Float64Array` with the reasoning
written out in a comment. That is not the behaviour of an abandoned library.

Caveat that stands: the author calls it early-stage and asks for failure cases.
So the returned geometry is treated as untrusted — `booleanShapes` throws on
non-finite output rather than returning it, and `booleanSelection` catches both
that and a library throw, leaving the document untouched. Nothing is mutated
until a finite result exists, and the operation is one undo step.

## Tracing an image

Researched 2026-08-11, decided 2026-08-12. Two separate features that people
usually ask for together.

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Backdrop image** — done. Drop a raster on the canvas or load it from the Backdrop panel. Opacity, show, lock, X/Y/width and fit. Workspace state rather than document content, so it never exports and never appears in the Shapes list, but it *is* in the undo history: load, move, resize, fit and remove are ordinary edits, while opacity, show and lock are view switches undo leaves alone. The first version shipped with no undo at all, on a memory argument that turned out to be about data URLs and not the object URLs actually used. The only remaining trade is no survival across a reload. See ARCHITECTURE §18 and the manual's explanation page. | every editor | — |
| `[x]` | **Auto-trace** — done, in the Backdrop panel. One shape per colour, holes and all, mapped onto the backdrop's placement and fitted with the Schneider fitter Simplify already used. **Cost in this build: +4.2 kB gzipped all in** — 2.3 for the tracer and its panel, and 1.9 for the inlined worker added the same day so it stops blocking the thread, each measured by building without it. Against the +278 kB gzipped a WASM tracer would have added: 66 times smaller, because the expensive half of a tracer is curve fitting and we owned it. The estimate below said +1.8 kB; the extra is the panel and the shape building. See ARCHITECTURE §26. | Illustrator, Inkscape | — |

### The auto-trace decision — settled, and then built

Taken 2026-08-12, on the same terms as the boolean decision: measure in our own
build, judge the interface against our own model, and ask what we would actually
be buying. Built the same day; **the measured cost came in at 2.0 kB gzipped for the code
against the 1.8 kB predicted here, and 2.3 kB with the panel.** What follows is the decision as it was
taken, kept because the reasoning is the useful part.

**VTracer fails on size, and not narrowly.**

| | raw | gzipped |
|---|---|---|
| `vtracer_wasm_bg.wasm` | 668.0 kB | 278.3 kB |
| This whole editor, as shipped | 170.7 kB | 53.7 kB |

278 kB gzipped is 5.2× the entire application. Lazy-loading, the usual answer, is
not open to us: `vite-plugin-singlefile` inlines everything into one HTML file
with no external requests, so a WASM module would arrive base64'd in the document
whether the user ever traces anything or not. It also emits an SVG string, so we
would parse our way back into the model we started from.

**The pipeline splits, and we already own the expensive half.** Every tracer is
four stages:

1. quantise the raster to a palette
2. label the regions and walk their boundaries
3. fit curves through the boundary polylines
4. write the result out

We have had 3 since Simplify shipped (`core/fit.ts`, Schneider's least-squares
fit, with corner detection on top in `model/simplify.ts`) and 4 since the first
commit (`core/serialise.ts`). Only 1 and 2 are missing, and they are exact
integer work on a pixel grid: no intersections, no tangent ordering, no
robustness problem to get wrong. **That is the reverse of booleans**, where the
maths is treacherous and "don't write it yourself" was the entire argument.

**Every candidate measured in our own bundler** (vite 8, minified, `gzip -9`),
rather than read off an npm page:

| Candidate | Licence | What it emits | raw | gzip |
|---|---|---|---|---|
| `@visioncortex/vtracer` | MIT/Apache-2.0 | SVG string | 668.0 kB | 278.3 kB |
| `@image-tracer-ts/core` | MIT | SVG string | 35.6 kB | 9.9 kB |
| `imagetracerjs` | Unlicense | SVG string | 30.2 kB | 6.5 kB |
| `imagetracer` (TS port) | MIT | **every stage separately** | 25.8 kB | 6.4 kB |
| `contours.ts` | MIT | `{x, y}[]`, bilevel only | 7.1 kB | 2.5 kB |
| **stages 1–2 alone, vendored** | see below | `{x, y}[]` with hole nesting | **7.4 kB** | **1.8 kB** |

`potrace` and `esm-potrace-wasm` are GPL-2.0 and would govern this editor;
`marchingsquares` is AGPL-3.0. All three are out on licence before size is even
asked about. Potrace remains the trap it was: it is what most tutorials reach
for, and the `potrace` npm package wraps the same GPL core.

**Importing three functions does not cost three functions' worth.** The TS port
declares `sideEffects: false`, but importing only `layering`, `pathScan` and
`interNodes` still produced 24.7 kB: the sixteen-entry option-presets table and
the SVG writer's string literals both survive the shake (`posterized1`,
`randomsampling1` and `viewBox` are all still in the output). The same three
functions extracted by hand are 7.4 kB. A 3.3× difference, and the reason the
last row of that table is not simply the fifth row with a narrower import.

**Why vendoring wins here and lost for booleans.** The same question, the
opposite answer, which is worth writing down so neither looks arbitrary later:

| | `path-bool` | the raster half |
|---|---|---|
| Size of the thing | 4 925 lines | 255 |
| Upstream | published five days before we looked, ported into Graphite | last published 2022; the algorithm is finished |
| Fraction we would use | nearly all of it | about a quarter of the module |
| The hard part | numerical robustness at intersections | none: an integer walk over a 16×4 lookup |
| Forfeited by vendoring | upstream fixes from an author still hunting failure cases | nothing |

**What was verified rather than assumed:**

- **The extraction is faithful.** `layering`, `pathScan`, `interNodes` and their
  three helpers pulled out by brace matching (255 lines, 9.3 kB of source), then
  run against the npm package on the same image. Output byte-identical, path for
  path, point for point. What shipped is a TypeScript rewrite against
  **jankovicsandras' Unlicense original**; the MIT package was the yardstick for
  that check, not the source. `NOTICE` says the same, and said less before.
- **Their quantiser is the weak stage, and we should not use it.** On a
  three-colour test image at `numberofcolors: 3` it returned
  `229,229,255 | 255,0,0 | 255,0,0`: blue lost entirely, red duplicated. At eight
  colours it spent five of them on red. Only an explicitly supplied palette got
  it right. Flat art wants an exact colour census, not k-means, and that is about
  twenty lines of ours.
- **The two halves join.** A 64×64 disc with a square hole, traced and then
  handed straight to `simplifySubpath` at a tolerance of 1:

  ```
  disc outline   208 points ->  11 nodes, error 0.961, d is 360 chars
  square hole     68 points ->   4 nodes, error 0.100, d is  24 chars
  ```

  Eleven nodes for a traced circle, from code we already had. Node soup was the
  reason Simplify had to come first, and it did.
- **Hole nesting arrives for free.** `pathScan` returns `holechildren` and
  `isholepath`, which is exactly subpaths-within-a-shape plus the fill rule the
  Style panel already sets.

**Provenance.** The measured extraction came from
[`imagetracer`](https://github.com/murongg/imagetracer), the MIT TypeScript port.
The original, [ImageTracerJS](https://github.com/jankovicsandras/imagetracerjs),
is Unlicense and so carries no obligation at all. Vendoring from the original is
the cleaner route; either way a `NOTICE` entry goes in, as `path-bool` has one.

**Still true, and not about the library:** a backdrop is not part of the drawing
and must not reach the export. Tracing writes shapes into `Doc`; the raster stays
in `EditorState`. See ARCHITECTURE §18.

**Shape of the work, if it is taken:** `src/core/raster.ts` for the vendored walk
and our palette census, `src/model/trace.ts` to turn its polylines into shapes
(one per palette entry, outer plus holes, `fill-rule: evenodd`), and a Trace
button in the Backdrop panel that runs on the loaded image as one undo step. The
tolerance is the one Simplify already takes. Estimate M, not L: the L was the
tracer, and we are not writing one.

## Explicitly not doing

- **Vector networks** (Figma) — points with three or more edges. It solves a real
  problem (stroke joins at a T-junction are impossible in plain paths), but it
  replaces the path model wholesale and cannot round-trip through SVG `d`
  without flattening. Wrong bet for an SVG-native editor.
- **Layers, text, filters, gradients** — Method Draw dropped layers deliberately
  to stay pleasant. Same reasoning applies here.

---

## Sources

- [IPE snapping documentation](https://otfried.github.io/ipe/40_snapping.html)
- [Inkscape node types](https://inkscape-manuals.readthedocs.io/en/latest/node-types.html)
- [Inkscape node operations](https://inkscape-manuals.readthedocs.io/en/latest/node-operations.html)
- [Figma: Introducing Vector Networks](https://www.figma.com/blog/introducing-vector-networks/)
- [Method Draw](https://github.com/methodofaction/Method-Draw)
- [Boxy SVG](https://boxy-svg.com/)
- [quiver](https://q.uiver.app/)
- [TikZiT](https://tikzit.github.io/)
- [VTracer](https://github.com/visioncortex/vtracer) (MIT) and [Potrace](https://potrace.sourceforge.net/README) (GPL-2.0-or-later)
- [ImageTracerJS](https://github.com/jankovicsandras/imagetracerjs) (Unlicense), and the TypeScript ports [`imagetracer`](https://github.com/murongg/imagetracer) and [`image-tracer-ts`](https://github.com/mringler/image-tracer-ts) (both MIT)
- [contours.ts](https://www.npmjs.com/package/contours.ts) (MIT), Moore-neighbour tracing on a thresholded image
- [image2svg-awesome](https://github.com/fromtheexchange/image2svg-awesome), a survey of tracers
- [Icons8: guide to pixel-perfect icons](https://icons8.medium.com/a-guide-to-pixel-perfect-icons-390e2fa2820c)
- [Helena Zhang: Icon grids & keylines demystified](https://minoraxis.medium.com/icon-grids-keylines-demystified-5a228fe08cfd)
