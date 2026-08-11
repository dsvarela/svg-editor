# Shopping list

Candidate features, with where the idea comes from and a rough size.
S = an afternoon. M = a day, needs tests. L = a project in itself.

Status: `[ ]` not started · `[~]` partial · `[x]` done

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
| `[ ]` | **Displayed grid ≠ snap grid (defect)** — `canvas.ts:172` draws `gridStepFor(camera, widthPx)` (adaptive decades), `controller.ts:122` snaps to `state.gridStep`. At most zoom levels you snap to a lattice you cannot see. Pick one: either drive snapping from the drawn step, or draw the snap step and let it disappear when too dense. | — | S |
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
| `[ ]` | **Join nodes** (`Shift+J`) — weld two selected endpoints into one, placed at their midpoint. | Inkscape, TikZiT (`Ctrl+M`) | M |
| `[ ]` | **Break path** (`Shift+B`) — split at the selected node, leaving two ends. | Inkscape | S |
| `[ ]` | **Join with segment** — connect two endpoints with a new segment rather than merging them. | Inkscape | S |
| `[ ]` | **Reverse direction** + optional direction arrows on the outline. Matters for fill-rule and for which end a marker lands on. | Boxy SVG, Inkscape | S |
| `[ ]` | **Make path** — turn a selection into a single path. | TikZiT (`Ctrl+P`) | S |
| `[~]` | **Drag the curve directly** — done as bend mode, but ours only engages when the segment is symmetric. Figma's version works on any segment and re-derives both handles. Worth relaxing. | Figma bend tool | S |

## Path operations

| | Feature | Source | Size |
|---|---|---|---|
| `[~]` | **Booleans** — unite / intersect / subtract / exclude. Adapter and tests done in `src/io/boolean.ts`; not yet reachable from the UI. Built on [`path-bool`](https://www.npmjs.com/package/path-bool) (MIT) — see below. | Boxy SVG, Inkscape, everything | S remaining |
| `[ ]` | **Simplify** — fewer nodes within a tolerance, by curve fitting rather than point decimation. | Boxy SVG, Inkscape | M |
| `[ ]` | **Offset path** — parallel outline at a distance. Shares most of its machinery with stroke-to-path. | Illustrator, Inkscape | L |
| `[ ]` | **Stroke to path** — convert a stroked outline into a filled shape. | Boxy SVG, Inkscape | L |

## Interface

| | Feature | Source | Size |
|---|---|---|---|
| `[ ]` | **On-canvas transform box** — drag handles to scale/rotate a selection, instead of only the rail buttons. | every editor | M |
| `[ ]` | **Two-tier nudge** — coarse and fine arrow-key steps, both configurable. Currently `gridStep` and `10×`. | TikZiT | S |
| `[ ]` | **Revert-failed-source** — if the typed `d`/SVG doesn't parse, restore the last good text rather than leaving the field broken. | TikZiT | S |
| `[ ]` | **Jump to source** — select a node, land the cursor on the command that produced it. | TikZiT | M |
| `[ ]` | **Named styles palette** — reusable fill/stroke sets rather than per-shape colours. | TikZiT | M |
| `[ ]` | **Wireframe view** — outlines only, no fills, for editing overlapping shapes. | Method Draw | S |
| `[ ]` | **Keyboard completeness** — every operation reachable without the mouse. We're partway. | quiver | M |
| `[ ]` | **Measurement readout** — live length/angle while dragging. | Illustrator, IPE | S |

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
| Editor as it stands | 70.8 kB | 22.3 kB |
| With booleans wired in | 104.0 kB | 34.4 kB |
| **Delta** | **+33.2 kB** | **+12.1 kB** |

The npm tarball's 143 kB is unminified and includes the path-data parser we do
not use; our build minifies and tree-shakes both away. The dependency also costs
nothing until it is actually imported from `main.ts`.

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
Treat returned geometry as untrusted — check it is non-empty and finite, and
keep the operands on the undo stack.

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
- [Icons8: guide to pixel-perfect icons](https://icons8.medium.com/a-guide-to-pixel-perfect-icons-390e2fa2820c)
- [Helena Zhang: Icon grids & keylines demystified](https://minoraxis.medium.com/icon-grids-keylines-demystified-5a228fe08cfd)
