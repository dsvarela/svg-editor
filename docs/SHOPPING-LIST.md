# Shopping list

Candidate features, with where the idea comes from and a rough size.
S = an afternoon. M = a day, needs tests. L = a project in itself.

Status: `[ ]` not started · `[~]` partial · `[x]` done

What each review found, and when, is indexed in
[`docs/reviews/`](reviews/README.md). One item below closed as a direct result:
the tenth finding of 2026-08-11, coincident nodes mid-path, is **Fuse nodes that
are not ends**.

---

## Snapping — the precision story

Three tiers, resolved by one rule: the most specific target within eight screen
pixels wins, so a vertex beats an outline beats the grid. Pixel fit is the grid's
phase rather than a fourth tier. See ARCHITECTURE §27. Keylines, guides, rays and
crossings all join the tier their dimension puts them in rather than adding one,
so there are still three. Nothing is left here.

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Boundary snap** — done, as **Snap to outlines**. The 1-D tier: a point anywhere along an existing curve, beaten by a vertex and beating the grid. `nearestOnPath` gained a segment filter, because a node being dragged lies on the two segments it joins and both report a distance of zero. See ARCHITECTURE §27. | IPE | — |
| `[x]` | **Intersection snap** — done, as **Snap to crossings**. A crossing is a point, so it answers the vertex tier. The solver is recursive subdivision on the control hulls rather than algebra: a cubic against a cubic is a degree-9 system whose closed forms are unstable near tangency, which is exactly the case worth snapping to. Bounded by a work budget rather than a depth, since each level halves only one of the two curves. Pruned to segments whose hull is within reach of the pointer, which is what makes it affordable: 0.35 ms per hover over 2 400 segments against 0.24 ms with it off. Its own switch, and off by default. See ARCHITECTURE §34. | IPE | — |
| `[x]` | **Angular snap** — done, as the **Angles** group. Rays at multiples of a step from a base direction, drawn on the canvas and holding the pointer to the nearest one. A ray is 1-D so it answers the boundary tier: it beats the grid and loses to a node, with no new rule. The origin is implicit by default -- wherever the gesture started, which is the node being dragged or the pen's last point -- and **Origin here** pins it to the selection instead. IPE's `F3`, taking origin and direction from a nearby edge, is not done. See ARCHITECTURE §33. | IPE | — |
| `[x]` | **Principled priority order** — done. The most specific target within reach wins: vertex (0-D) beats boundary (1-D) beats grid (2-D), and distance does not break ties between tiers. Pixel fit turned out not to be a fourth tier but the grid's phase, which is what settles how it interacts with the other two. The rule is a pure function in `model/snapping.ts` rather than an accident of statement order in the controller. See ARCHITECTURE §27. | IPE | — |
| `[x]` | **Displayed grid ≠ snap grid (defect)** — fixed. `gridDisplayFor` draws `gridStep × m` with `m` a whole number off the 1-2-5 ladder, so every line on screen is a snap position; zooming out thins the lattice instead of switching to a different one, and the readout says which (`1 · every 5 drawn`). See ARCHITECTURE §9. | — | — |
| `[x]` | **Pixel-fit** — done. A stroke is painted centred on its path, so a 1-unit stroke on a whole coordinate covers half of two pixels instead of all of one, and snapping anchors to integers made it worse rather than better. The fix is one line of arithmetic — the painted edges are whole exactly when `x ≡ w/2 (mod 1)` — so it is the same lattice shifted by a phase, not a second kind of snapping. The drawn grid shifts by the same phase from the same function, which is what keeps §9's contract. A selection whose shapes want different lattices reports `mixed widths` rather than fitting one of them. **Fit selection to pixels** applies it to what already exists. See ARCHITECTURE §25. | icon-design practice | — |
| `[x]` | **Rulers + draggable guides** — done. Rulers along the top and left, and guides you drag out of either or place by number. A guide is axis-aligned and infinite, stored rather than derived, and so undoable: that is the whole difference from a keyline, which is a function of the page. Snapping puts a guide in the boundary tier and a crossing of two in the vertex tier, which is ARCHITECTURE §27 applied rather than a fourth tier invented. Dropping one off the canvas puts it away. Never part of the export. See ARCHITECTURE §31. | Boxy SVG, Method Draw | — |
| `[x]` | **Smart guides** — done. Drag a shape and a line appears wherever it lines up with another shape or with the page, by an edge or a centre; the drag is held to it, and it beats the grid on whichever axis it found something. Solid for an edge, dashed for a centre. Deliberately not a snap tier: every tier in §27 maps a point to a point, and an alignment is about the moving box rather than the pointer, which may be nowhere near the edge that matched. Body drags only; creating a primitive and scaling a selection are not covered. See ARCHITECTURE §32. | Boxy SVG, Figma | — |
| `[x]` | **Keyline shapes** — done, as **Show keylines** in the Document panel. Circle, square, portrait and landscape sharing a centre, plus the live area dashed, in Material's system-icon proportions. Held as ratios rather than as the published numbers, since every one of them is exact in thirds and sixths, so a 24-unit canvas reproduces the 24dp grid to the unit and a 240-unit one scales it by ten. There is no non-exporting layer because there is nothing to put on one: the keylines are computed from the viewBox every frame and never enter `Doc`, so the export cannot carry one by construction. While they are shown the tools snap to them, in the tier each keyline belongs to rather than a fourth tier of their own. See ARCHITECTURE §30. | icon-design practice | — |

## Node editing

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **A point is a point** — continuity is derived from the handles wherever it is needed, never stored. Dragging a handle preserves whatever relationship the pair already had; Alt-drag breaks it. Nothing to choose up front, and the marker on screen cannot disagree with the geometry. | — | — |
| `[x]` | **Auto-smooth node** — done, as **Auto** in the Node panel and `Shift+A`. Handles come from the chord between the neighbours and re-derive whenever anything nearby moves. The note was right: this needs stored state, and it is the model's only piece of it. It earns the exception §6 refuses to a stored `smooth` flag, because that would be a claim about the geometry and this is an instruction about the future -- nothing for it to disagree with. Taking hold of a handle hands control back. Never exported. See ARCHITECTURE §35. | Inkscape | — |
| `[x]` | **Continuity shortcuts** — `Shift+C` corner, `Shift+S` smooth, `Shift+Y` symmetric. Double-click already cycles. **Done.** Shift+C, Shift+S, Shift+Y. | Inkscape | S |
| `[x]` | **Connect ends** (`Shift+J`) — done. Draws the missing segment between two free ends. Both nodes stay, nothing moves, and the segment is straight for free. This is what "join" means to anyone who has not memorised Inkscape, so it got the obvious key. | Inkscape's `Shift+Ctrl+J` | — |
| `[x]` | **Merge ends** (`Shift+M`) — done. Welds two free ends into one node at their midpoint, so ends already coincident do not move and it is the exact inverse of `Break path`. Each end keeps the handle facing away from the joint, since the one facing it governed nothing. Shipped first under the name `Join`, which was wrong: one name covered both readings and it did the destructive one. | Inkscape's `Shift+J`, TikZiT (`Ctrl+M`) | — |
| `[x]` | **Resume a finished path** — done. The pen picks up either end of an existing open path and carries on, reversing it when you click the start. Without it a path put down and let go of could never be extended again, which is the gap that prompted both this and Join. | every editor | — |
| `[x]` | **Fuse nodes that are not ends** — done, on `Shift+F`. Welds two adjacent nodes into one anywhere along a path, and with a shape selected sweeps it for zero-length segments instead. It sounds like the harder relative of Merge ends and is the easier one: in the middle of a path there is no topology to change, so nothing reverses and no subpath appears or disappears. Two nodes further apart are refused rather than guessed at. The generators were fixed at the same time: `rectSubpath` emits a vanished side's two tangent points as one node, so a square rounded to its own limit is a four-node circle, and `circulariseSubpath` sweeps afterwards and reports the count. The Delete mode that used to be called Fuse is now **Heal**. See ARCHITECTURE §24. | Inkscape | — |
| `[x]` | **Break path** (`Shift+B`) — split at the selected node, leaving two ends; a closed path opens at that node instead. The node is duplicated, so nothing moves — this is the lossless counterpart to deleting a node, which cannot be. See ARCHITECTURE §13. | Inkscape | — |
| `[x]` | **Reverse direction** + optional direction arrows on the outline. Matters for fill-rule and for which end a marker lands on. **Done.** The model op existed for Join; this gave it a button and Shift+R. Direction arrows not drawn. | Boxy SVG, Inkscape | S |
| `[x]` | **Make path** — done, as **Make one shape** (`Shift+P`). Puts the selected shapes into one shape and changes no geometry, which is the whole difference from `unite`: the booleans rebuild the outline from the region it covers and discard every node that fell inside. It is also the only way to make a hole, since `even-odd` needs two paths in one shape and no boolean leaves two. Named for the interface's nouns rather than TikZiT's, because STYLE.md reserves *path* for a run of nodes and *shape* for a list entry, and this makes one of the latter. `Ctrl+P` went to the browser's print dialogue. Shipped with its inverse, **Split into shapes** (`Shift+K`), which was not on this list and should have been: without it the only way back out is undo, and a door that opens one way is a trap however useful the room behind it. | TikZiT (`Ctrl+P`) | — |
| `[x]` | **Drag the curve directly** — done. The dot is now drawn on every segment, at the curve's own midpoint, and dragging it puts the curve through the pointer whatever the handles were doing. A symmetric segment stays symmetric, which is the same rule handle dragging already follows, and `Alt` opts out of it. The unconstrained case is `reshapeSegment`: one equation in two unknowns, solved least-norm, so the handles move as little as the displacement allows and the work splits in the ratio the two controls already influence the point. | Figma bend tool | — |

## Path operations

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Simplify to a count, and to a selection** — done, as **Keep** with **Reduce** and **Keep these nodes**. The same knot-removal machinery as **Within** with the question turned round: not "what can go for a given cost" but "what goes first", stopping on a count or on a set of protected nodes. Both report how far the drawing moved rather than promising it did not, because below some count it certainly did. Two buttons rather than a mode on Simplify: selecting nodes already means "work within these", and one gesture cannot also mean "keep these" without the first reading changing under anyone who relied on it. Asked for 2026-08-14. | Illustrator, Inkscape | S |
| `[x]` | **Booleans** — unite / intersect / subtract / exclude, in the Combine panel. Select two or more shapes; the first survives with its name and style, and `subtract` takes the rest away from it. Built on [`path-bool`](https://www.npmjs.com/package/path-bool) (MIT) — see below. | Boxy SVG, Inkscape, everything | — |
| `[x]` | **Simplify** — done. Schneider's least-squares fit (`core/fit.ts`) under a layer that decides which runs to fit (`model/simplify.ts`): corners past 50° are kept and fitted around, every surviving node keeps its tangents as inputs to the fit, and a closed path is cut at node 0 with the original tangents handed in from both sides so there is no kink at the seam. Sampling caps spacing as well as flatness, without which the tolerance is only checked where a sample happens to sit. A result with the same node count is refused. See ARCHITECTURE §19. **That is now the optional half**, behind a Redraw curves checkbox, because a resampler cannot recognise a redundant node: Schneider's algorithm fits digitised points and never sees a curve, so "this input already IS a cubic" is not a question it can be asked. Measured, it needed seven curves to fit one. The half that always runs is knot removal (`model/knots.ts`), which takes a node out exactly when its two segments are pieces of the same curve, priced by Tiller's control-point bound and ordered by Lyche & Mørken's buckets. Within 0 means move nothing and remove only what cannot change the exported file. | Boxy SVG, Inkscape | — |
| `[x]` | **Offset path** — done, as **Offset** in the Draw panel. Samples the true offset and fits cubics through it, which works because a parallel curve shares its original's tangent direction and `core/fit.ts` takes the end tangents as inputs. The overrun at a concave corner goes before fitting, by Chen & McMains's rule that the invalid parts bound regions of non-positive winding number, in its local form: a raw-offset point is on the true offset only if it is `|d|` from the original. Exact everywhere measured -- 0.0006 on a square inward by 4, 0.0028 on a notched shape that separates into two paths, nothing at all when the offset consumes its shape. The last 1.14 of error turned out to be in the measurement: `NearMap` sized its polyline by its grid cells. See ARCHITECTURE §39. | Illustrator, Inkscape | — |
| `[x]` | **Stroke to path** — done, as **Outline** and **Outline round** in the Draw panel. Two offsets joined up: a closed path gives two contours wound opposite ways, which is what makes a ring rather than a disc, and an open one gives a single loop with a cap at each end. The width comes from the shape's own style and the result is filled with what the stroke was coloured, because the outline is the stroke. Refuses when either side comes apart, since there is then no single other side to pair each piece with. See ARCHITECTURE §40. | Boxy SVG, Inkscape | — |

## Interface

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Groups** — done, as **Group** and **Ungroup** (`Ctrl+G`, `Ctrl+Shift+G`). A group is a named set of shapes exported as one `<g>`, nesting as deep as you like, shown in the shape list as a tree. `<g>` in an imported file becomes a group instead of being flattened away. It carries **no transform**, because §5 bakes transforms into coordinates and a group holding one would be the hidden coordinate system §5 refuses -- so a group is organisation and export, and not a container you can scale without scaling its shapes. Modelled as a parent pointer over the flat `doc.shapes` rather than as a tree of children, which is what left all 73 places that read that array alone. Selection gained nothing: a group reads as selected when its shapes are, so transform, delete, style, boolean and align work on one with no change to any of them. See ARCHITECTURE §49. | Illustrator, Inkscape | — |
| `[ ]` | **A style on a group** — not done. An SVG `<g>` can carry `fill` and `stroke` for everything inside it, and a fill set on one in an imported file is currently pushed down to the shapes. Keeping it on the group would mean a shape's painted colour was not a property of the shape, which is the same objection §5 makes to a stored transform and §6 makes to a stored node type: two places for one fact. Worth doing only with an answer to which of the two wins when they disagree. | SVG | S |
| `[ ]` | **Entering a group** — not done. Double-clicking a group in Illustrator puts you inside it, so clicking a shape selects that shape rather than the whole group. Here a group's shapes are always individually selectable, which removes most of the need: the gap is that there is no way to select the group *as a whole* by clicking the canvas, only by its row in the list. | Illustrator | S |
| `[x]` | **Collapsible groups, and a rail with less prose in it** — done. Measured first: 19 headers, 131 controls and 1 014 words in a 288 px column, with the Node tab as the control -- nearly as many controls as Shape, a fifth of the prose, and not busy. So the prose went to one line per group (1 014 words to 210) and every group collapses, with independent toggles rather than an accordion because the snapping aids are used together. Collapsing improves the keyboard: a shut group is `hidden`, so it costs one Tab stop instead of the controls it holds. Asked for 2026-08-14. See ARCHITECTURE §41. | — | S |
| `[x]` | **Import an SVG file** — done, as **Import SVG** in the Document panel. The same route as pasting one into the source drawer: the same importer, the same refusal of anything that draws nothing, one undo step. What it adds is the reading. Asked for 2026-08-13; `applySource` was split so the file and the box share everything after the text arrives, since the two differ only in where it came from and what to call it when it is wrong. | every editor | S |
| `[x]` | **Primitive tools** — done. Ellipse and rectangle draw tools (`E`, `R`), Shift to constrain, Alt from the centre. Built as nodes and handles, so there is nothing to convert before editing one. The drag ignores the shape it is drawing when point-snapping, and refuses to commit one with no area. | every editor | M |
| `[-]` | **Circularise** — built, then removed on 2026-08-18. It fitted a circle through a contour's nodes by least squares and moved each onto it at its own angle, which is not what "make this round" means to someone who has not read it: node spacing came back untouched and the result was only as round as the fit. Removed at the owner's request as a feature that would not be used. `fitCircle` went with it, having no other caller. ARCHITECTURE §55. | Inkscape's "make circle" | M |
| `[x]` | **Rename shapes** — done. Double-click the name in the list, or focus the list and press `F2` or `Enter`. It is what the exported `id` carries, sanitised to an XML Name and made unique on the way out. The keyboard route had a dead first step: Tab reaches the list on the very first press, and `F2` there did nothing until an arrow key had chosen a row, which reads as the key not working rather than as a precondition. It now takes the first shape. | every editor | — |
| `[x]` | **Tooltips** — done. One layer, fed by the markup's own `title` attributes, with the shortcut pulled out as a key cap. Class 10 of the review is closed: `aria-describedby` is set on show and removed on hide. And the keyboard case now works at all: focusing a control below the fold scrolls the panel, `scroll` was wired straight to `hide`, and the scroll beat the tooltip's own timer -- so tabbing through a panel described only what was already on screen. A focus tooltip follows a scroll now; a hover one still goes. See ARCHITECTURE §38. | — | — |
| `[x]` | **Fill, stroke and width** — done. A Style group with fill, stroke, width and fill rule, applied to the selected shapes or, with nothing selected, to whatever you draw next. `Style` had been in the model, imported and exported faithfully, and honoured by the renderer since the beginning; nothing could change it, so the editor produced exactly one appearance of SVG. The colour pickers stay live while `none` is ticked, because disabling them made filling an unfilled shape a two-step dance whose first step committed a colour nobody chose. See ARCHITECTURE §22. | every editor | — |
| `[x]` | **Tabbed inspector** — done. Eleven groups split three ways by what they act on: Shape, Node, Document. Nothing switches tab on its own, and hidden panels use `hidden` so their controls leave the tab order too. Requested 2026-08-12, when one scrolling column had become "a lot of scrolling through random stuff". | Figma, Illustrator | — |
| `[x]` | **Round a corner from a node** — done. **Radius** and **Round** in the Node panel replace the selected corners with an arc of that radius, tangent to both sides, which is the operation the rectangle tool performs only while drawing. Refuses a curved side rather than approximating: a fillet is defined by touching two lines, and one that is a fraction of a degree off tangent looks right and is wrong. The radius is clamped to what the shorter side holds, and the clamp is reported. Applied from the highest index down, since each rounded corner turns one node into two. See ARCHITECTURE §23. | Figma corner radius, Illustrator live corners | — |
| `[x]` | **Application shell** — done. One fixed grid filling the window, canvas edge to edge, no page scroll; the toolbar is icons, the source is a drawer you open (`Ctrl+E`) and the inspector collapses (`Ctrl+B`). Panels take space from the canvas rather than floating over it, and a `ResizeObserver` re-fits the camera when they do. | Figma, Rive | M |
| `[x]` | **Measurement readout** — done. The pointer's document coordinates are in the status strip, and a second slot appears while something is being dragged: `drag 15 at 0°` for a move, `size 40 × 20` for a rectangle or a marquee. It reports the geometry, so a shape held to the grid reads the whole steps it travelled and not the fraction the pointer did. | Illustrator, IPE | S |
| `[x]` | **Document canvas** — done. `doc.viewBox` is drawn on the canvas with everything outside it dimmed, editable as four numbers in the Canvas panel, and **Fit canvas to drawing** wraps it around the content rounded outwards to whole grid steps. It still never follows the drawing on its own, because an icon is drawn to a page and a page that resized itself would make a margin impossible to hold. Reported as "viewbox seems to not update at all, with anything", which was true and was mostly invisible: nothing on screen said where the page was. See ARCHITECTURE §21. | every editor | — |
| `[x]` | **Zoom readout** — done. A percentage in the status strip, where 100 % is one document unit per pixel, and clicking it returns to 100 % about the centre of the view. | every editor | — |
| `[x]` | **On-canvas transform box** — done. Eight scale handles and four rotation zones around the selection, for shapes and for node subsets alike. `Shift` keeps the proportions by projecting onto the diagonal, `Alt` scales about the centre, dragging past the far side mirrors, and `Shift` snaps a turn to 15°. Every frame recomputes from the geometry captured at the press rather than composing onto the last, so a drag out and back is the identity. The box is drawn six pixels outside the true bounds and the rotation zones sit diagonally outside the corners, because a shape's nodes sit on its own bounding box and the handles are in front of them. See ARCHITECTURE §20. | every editor | — |
| `[x]` | **Hand tool** — done. A pan tool on `H`, with a grab cursor, for pointers with no middle button. Space-drag still pans from any tool. | every editor | — |
| `[x]` | **Modified scroll** — done. Plain and `Ctrl` zoom, `Shift` pans sideways, `Alt` pans up and down. Trackpads report sideways scrolling as `deltaX`, so whichever axis moved is the one used. | Figma, Illustrator | — |
| `[x]` | **Marquee at low zoom** — fixed. `box()` set `stroke-width` to document-units-per-pixel on an element that already carried `vector-effect: non-scaling-stroke`, so the width was scaled twice and the rubber band grew into a picket fence when zoomed out: 0.062 px near, 0.909 px far. Width now comes from CSS in pixels for everything non-scaling, and `marqueeDelete` measures it at both ends of the zoom range. Separately, handles nearer their node than the node's own marker are no longer drawn, which thins the overlay on a shape under about 120 px. | — | — |
| `[x]` | **Two-tier nudge** — coarse and fine arrow-key steps, both configurable. Currently `gridStep` and `10×`. **Done.** The fine step is the grid step; the coarse multiplier is a field. | TikZiT | S |
| `[x]` | **Revert-failed-source** — if the typed `d`/SVG doesn't parse, restore the last good text rather than leaving the field broken. **Done.** A Revert button rather than an automatic wipe: the error names an offset into the text it would have thrown away. Apply also refuses text that parses to nothing drawable, which used to empty the selected shape and report success. | TikZiT | S |
| `[x]` | **Jump to source** — done, as **Find in source** in the Node panel. The serialiser hands back where it put each node's command, as character offsets into exactly the string it just produced, and the box selects that range. It forces path-data mode and scopes to the node's own shape, because the offsets are only true of that string. The other direction was always free: the drawing is on screen and you can point at it. See ARCHITECTURE §36. | TikZiT | — |
| `[x]` | **Named styles palette** — done, as **Saved** in the Style panel. Save the four values under a name, click a swatch to put them on the selection or on what you draw next, double-click to rename, Forget to drop one. Session state rather than document state: a palette is how you are working, it cannot be expressed in SVG, and undoing a node move has no business forgetting a colour you saved. The highlight lets go the moment the style stops matching, so a lit swatch never claims a shape has a style it does not. | TikZiT | — |
| `[x]` | **Wireframe view** — outlines only, no fills, for editing overlapping shapes. **Done.** Distinct from Show fills, which leaves each shape stroke and so hides an unstroked one entirely. | Method Draw | S |
| `[x]` | **Keyboard completeness** — done, and the survey is now a tool: `node tools/keys.mjs` walks the tab order in each inspector tab and reports every live control it cannot reach. It reports none. What that could not see is that every control in the Node panel acted on a selection only a click could make, so the panel was pointer-only however tabbable its buttons were. `[` and `]` walk the node selection along the path, `Shift` extends, and `Shift+I` inserts a node in the selected segment; all three have buttons too. See ARCHITECTURE §37. | quiver | — |

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

## Composing an icon, rather than drawing one

Surveyed on 2026-08-17, after groups went in. The editor is strong at making one
path and weak at arranging several into a drawing, and every item in this section is
part of that one gap. Nothing here is a new mechanism: each is a use of machinery the
editor already has, which is why the sizes are small.

| | Feature | Source | Size |
|---|---|---|---|
| `[x]` | **Z-order** — done, as **Forward**, **Backward**, **To front** and **To back** in the Shapes panel, with `Ctrl`+`]` and `Ctrl`+`[`. A shape moves among its siblings and stops at the edge of its group, which is §49's invariant restated as a behaviour; `doc.shapes` is rebuilt by walking the tree, so contiguity holds by construction rather than by each branch remembering it. §51 has the argument. It also turned up a defect nothing had noticed: the canvas only ever appended its `<path>` elements, so the screen drew the order shapes were first seen rather than the order the document held, and had disagreed with the export ever since grouping started reordering them. | every editor | M |
| `[x]` | **Align and distribute shapes, and align to the canvas** — done, as the **Arrange** group. Six align buttons, six distribute buttons and a **Gap** field with **Space H** and **Space V**, all working in whichever box **Relative to** names: the selection's own, or the canvas. That is one operation given two boxes rather than two families of buttons, which is the whole of §50. A group counts as one thing and moves without coming apart. The key object is the one part of Illustrator's panel deliberately left out, and §50 says why. | Illustrator, Inkscape, Figma | S |
| `[x]` | **Numeric bounds for the selection** — done, as the **at** and **size** fields at the top of the Transform group. X, Y, width and height, showing the same box the transform handles are drawn on, and moving what a drag of those handles moves. Each edit derives its matrix from the box as it is, which is §52's argument and the reason typing the same width twice is a no-op the second time. Width and height anchor the top-left corner so that setting one leaves the other three alone. A proportion lock is deliberately not there. | Illustrator, Figma | S |
| `[x]` | **Export PNG at a chosen size** — done, as the **PNG** group: a width, and a button. The height follows the canvas proportions rather than the drawing, so padding somebody chose is kept. Needed no dependency and no server, because a data-URI SVG does not taint a canvas and so can be read back; §53 has the argument, and the same string feeds the previews below. The browser scenario reads the bytes back and counts the opaque pixels, because a well-formed PNG of nothing has a valid header too. | — | S |
| `[x]` | **Target-size preview** — done, as the **Preview** group: the drawing at 16, 24, 32 and 48 pixels, on a chequer, each shaped like the canvas. Drawn from the exported SVG, so the Output settings show in it and rounding the decimals can be watched spoiling a curve before a file is saved with it. Held still during a drag and while the group is shut, because pointing four `<img>` elements at a fresh data URI is four rasters of the whole document. | icon-design practice | S |

## Smaller things, and one that needs a decision

| | Feature | Source | Size |
|---|---|---|---|
| `[ ]` | **Survive a refresh** — the document is held in memory and nothing else, so a reload loses the work. localStorage answers it on the hosted page. Opened from `file://` Chromium gives the page an opaque origin and storage throws, so this has to degrade and say so rather than appear to save. What to save is the harder half: the drawing is the SVG, but guides, keylines, the camera and the backdrop are not in it, and the backdrop is an image. | — | S |
| `[ ]` | **A workspace file** — export and import already are save and open for the *drawing*. They are not save and open for the workspace: guides, keylines, the backdrop and its placement, and the camera all go. A JSON sidecar carrying those would make a session resumable. Worth doing after the item above, since it answers the same question at a different scale. | — | M |
| `[ ]` | **Star and polygon tools** — a regular polygon by side count, a star by point count and inner ratio. They are ordinary paths from the moment they are drawn, which is the claim the ellipse and rectangle tools already make good on, so this adds a generator and nothing to the model. | Inkscape, Boxy SVG | S |
| `[ ]` | **Repeat the last transform** (`Ctrl`+`D`) — duplicate-and-rotate-again is how a radial icon is built. Cheap precisely because transforms are baked: the last matrix is the whole of what has to be remembered, and applying it again is the same call. | Illustrator | S |
| `[ ]` | **Booleans between the paths of one shape** — a path is selectable on its own now (§47), so uniting or subtracting two paths of one shape without splitting it into two shapes first is a step that could be removed. The operands are subpaths rather than shapes, which is a change to what `booleanShapes` takes. | — | M |
| `[ ]` | **Opacity** — one number per shape, and the first style attribute added since fill, stroke, width and rule. Listed with its own objection: the reason to stop at one number is the reason gradients are refused, and a `fill-opacity` and a `stroke-opacity` would follow it. Worth having only if opacity is wanted more than the boundary is. | SVG | S |

## Explicitly not doing

One list, so that nothing is refused in two places for two different reasons. The
last four were weighed during the survey of 2026-08-17.

- **Vector networks** (Figma) — points with three or more edges. It solves a real
  problem (stroke joins at a T-junction are impossible in plain paths), but it
  replaces the path model wholesale and cannot round-trip through SVG `d`
  without flattening. Wrong bet for an SVG-native editor.
- **Layers, text, filters, gradients** — Method Draw dropped layers deliberately
  to stay pleasant. Same reasoning applies here.
- **Live or parametric shapes** — a rectangle that stays a rectangle with an editable
  width, height and corner radius. It contradicts §2 and §5 directly, and §48 shows
  the alternative that does not: the corner widget re-derives a radius from the
  geometry rather than storing one, so a rounded corner is re-editable with nothing
  written down that could disagree with the drawing. Where a parameter is recoverable,
  recover it. Where it is not, the shape is a path.
- **Live mirror or symmetry** — draw half, get the other half. A stored relation
  between two halves, and the same objection as above. The one-shot version is already
  reachable: duplicate, flip, and connect the ends.
- **Stroke alignment, inside or outside** — SVG has no attribute for it; a stroke is
  painted centred and nothing else. Inside and outside are an offset of the path, and
  **Offset path** and **Stroke to path** already do that, destructively and visibly,
  which is the honest version of a feature other editors present as a setting.
- **Artboards or pages** — the document is one viewBox, and every readout, the grid
  phase and the export are written against that. Several would be several documents.

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
