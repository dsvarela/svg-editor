# Shopping list

Candidate features, with where the idea comes from and a rough size.
S = an afternoon. M = a day, needs tests. L = a project in itself.

Status: `[ ]` not started · `[~]` partial · `[x]` done

The 2026-08-11 review of the primitives/rename/tooltips commit is in
[`docs/REVIEW-2026-08-11.md`](docs/REVIEW-2026-08-11.md) — ten defect classes,
nine now fixed. The tenth, coincident nodes mid-path, waits on **Fuse nodes that
are not ends** below.

---

## Snapping — the precision story

Currently: grid snap (`snapToGrid`, step `gridStep`, default 1) and point snap
(within 8 px screen, beats the grid). Nothing else.

| | Feature | Source | Size |
|---|---|---|---|
| `[ ]` | **Boundary snap** — snap to a point *on* a curve, not just to its anchors. `projectToCubic` already exists. | IPE | M |
| `[ ]` | **Intersection snap** — snap where two paths cross. Needs a cubic–cubic solver. | IPE | M |
| `[ ]` | **Angular snap** — constrain to rays at multiples of N° from a settable origin and base direction (IPE: `F1` origin, `F2` direction, `F3` takes both from a nearby edge). | IPE | M |
| `[ ]` | **Principled priority order** — IPE resolves vertex/intersection → boundary → grid, and treats angular (1-D) as mutually exclusive with the 0-D modes. Ours is grid-then-point-override, which happens to land in the same place but isn't a rule. | IPE | S |
| `[x]` | **Displayed grid ≠ snap grid (defect)** — fixed. `gridDisplayFor` draws `gridStep × m` with `m` a whole number off the 1-2-5 ladder, so every line on screen is a snap position; zooming out thins the lattice instead of switching to a different one, and the readout says which (`1 · every 5 drawn`). See ARCHITECTURE §9. | — | — |
| `[ ]` | **Pixel-fit** — snap so *strokes* land on the pixel grid, not just anchors (a 1-unit stroke on an integer coordinate straddles two pixels; it wants a half-unit offset). The whole crisp-icon workflow depends on this. | icon-design practice | M |
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
| `[ ]` | **Fuse nodes that are not ends** — merging two coincident nodes in the *middle* of a path, which `Join ends` deliberately refuses. Also the repair for the duplicate anchors `rectSubpath` at its radius clamp and `circulariseSubpath` at the centre can produce (review Class 9). | Inkscape | S |
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
| `[x]` | **Application shell** — done. One fixed grid filling the window, canvas edge to edge, no page scroll; the toolbar is icons, the source is a drawer you open (`Ctrl+E`) and the inspector collapses (`Ctrl+B`). Panels take space from the canvas rather than floating over it, and a `ResizeObserver` re-fits the camera when they do. | Figma, Rive | M |
| `[~]` | **Measurement readout** — the pointer's document coordinates are in the status strip. Live length and angle *while dragging* is the part still missing. | Illustrator, IPE | S |
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

Researched 2026-08-11 on request, not started. Two separate features that people
usually ask for together.

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Backdrop image** — done. Drop a raster on the canvas or load it from the Backdrop panel. Opacity, show, lock, X/Y/width and fit. Workspace state rather than document content, so it never exports and never appears in the Shapes list, but it *is* in the undo history: load, move, resize, fit and remove are ordinary edits, while opacity, show and lock are view switches undo leaves alone. The first version shipped with no undo at all, on a memory argument that turned out to be about data URLs and not the object URLs actually used. The only remaining trade is no survival across a reload. See ARCHITECTURE §18 and the manual's explanation page. | every editor | — |
| `[ ]` | **Auto-trace** — convert a raster to paths in one step. Needs a library; see below. | Illustrator, Inkscape | L |

### The auto-trace decision, if it is ever taken

| Candidate | Licence | Colour | Ships to a browser | Note |
|---|---|---|---|---|
| [VTracer](https://github.com/visioncortex/vtracer) | MIT | yes | WASM, `@visioncortex/vtracer` | Rust, a linear pipeline rather than Potrace's optimal-polygon search. The only candidate that is both permissive and colour-capable. |
| [Potrace](https://potrace.sourceforge.net/) | **GPL-2.0-or-later** | no, bilevel | WASM builds exist | The best-known tracer and the reason to read licences. GPL would govern this whole editor. |
| [ImageTracerJS](https://github.com/jankovicsandras/imagetracerjs) | public domain | yes | pure JS, no build step | Simplest to adopt, coarser output than VTracer. |
| [EdgeSVG](https://github.com/raphaelmansuy/edgesvg) | check before use | yes | WASM, plus CLI and bindings | Newer, Rust, several surfaces. Unverified here beyond its README. |

**Potrace is the trap.** It is what most tutorials reach for and it is GPL, so
linking it would put this editor under the GPL too. The `potrace` npm package is
a wrapper around the same GPL core. VTracer is the one to use if this is built.

Two things to settle before writing any of it, neither about the library:

1. **Traced output is node soup.** A photograph traces to thousands of nodes, and
   this editor has no **Simplify** yet. Auto-trace without it produces a document
   nobody can edit, which defeats the point. Simplify is the prerequisite, not a
   follow-up.
2. **Where the raster lives.** A backdrop is not part of the drawing and must not
   reach the export. Everything in the document is currently a path, so this is
   the first thing that is not, and that is a model decision rather than a
   feature.

The honest order was backdrop first, then Simplify, then auto-trace if it still
looks worth it once tracing by hand over a backdrop is possible. The first two
are done, so auto-trace is unblocked. The open question is now size: the build
is one 153 kB file with no external requests, and a WASM tracer is several
hundred kilobytes on its own.

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
- [ImageTracerJS](https://github.com/jankovicsandras/imagetracerjs) (public domain)
- [image2svg-awesome](https://github.com/fromtheexchange/image2svg-awesome), a survey of tracers
- [Icons8: guide to pixel-perfect icons](https://icons8.medium.com/a-guide-to-pixel-perfect-icons-390e2fa2820c)
- [Helena Zhang: Icon grids & keylines demystified](https://minoraxis.medium.com/icon-grids-keylines-demystified-5a228fe08cfd)
