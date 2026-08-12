# Architecture

Why the code looks the way it does. Each section is a decision, what it bought,
and what it cost.

---

## 1. Nodes, not commands

**The founding decision, and every other one follows from it.**

yqnn's editor stores an array of command objects — `MoveTo`, `CurveTo`,
`EllipticalArcTo` — and derives point positions by walking the whole path from
the start. That is why its interface is a command table: the model *is* a
command table. It also means every geometric operation has to special-case ten
command types. Its `EllipticalArcTo.scale` is 28 lines of conic-section algebra
whose entire purpose is keeping an ellipse expressible as an `A` command.

Here a subpath is a run of nodes. Each node owns its anchor and up to two
handles. Commands exist only in `parse.ts` on the way in and `serialise.ts` on
the way out. Nothing between them knows they exist.

What that buys:

- A transform is one matrix applied to every point. No special cases at all —
  compare `affine.ts` (79 lines, covering everything) to that arc-scaling method.
- No relative-versus-absolute distinction to carry around.
- Arcs and shorthands cannot desynchronise from what is drawn, because they no
  longer exist once parsed.

What it costs: the serialiser has to *re-derive* a good spelling rather than
remembering one. See §8.

## 2. All segments are cubics

`M L H V C S Q T A` are read on input and written on output; in between there
are only cubic Béziers. Arcs are converted by the SVG 1.1 endpoint-to-centre
formulas (F.6.5, with the radii correction from F.6.6) and then flattened to
cubics; quadratics are degree-elevated.

The conversion is one-way. A shape imported as an arc will not come back out as
an arc. That is a real loss, accepted deliberately: keeping arcs as arcs is
exactly the special-casing §1 exists to avoid, and every operation — split,
transform, boolean, offset — would have to grow an arc branch.

## 3. A straight segment has no handles

A handle is `null` when the segment it governs is straight, rather than a
control point sitting on top of its anchor.

This makes "is this segment a line?" an exact boolean rather than a float
comparison, which is what lets the serialiser emit `L`/`H`/`V` losslessly
instead of guessing from near-zero distances. `segmentIsLine` is two `=== null`
checks.

The cost is that geometry code cannot assume a handle exists. `segmentAsCubic`
widens a line into a cubic with its controls on the endpoints, so downstream
code sees a uniform shape while the model still remembers the truth.

## 4. Handles are absolute, not offsets

`hIn` and `hOut` are document coordinates, not deltas from the anchor.

Absolute costs one addition when moving an anchor. Offsets would cost a
conversion on every hit-test, render and transform — all of which happen far
more often than anchor moves.

## 5. Transforms are baked, never stored

Rotating a shape rewrites its points. There is no transform matrix hanging off
a shape waiting to be composed at render time.

This means what you see in the source box is what is actually stored: no hidden
coordinate system, no `transform=` attribute that the numbers have to be read
through. Imported `transform` attributes are baked on the way in for the same
reason.

The cost is accumulated floating-point drift under repeated transforms, and
that a rotation is not undoable by rotating back — it is undoable through the
undo stack, which is where it belongs.

## 6. A point is a point

There is no stored node type. Continuity — corner, smooth, symmetric — is
**derived from the handles** wherever it is needed (`continuityOf` in
`core/types.ts`).

A stored flag can disagree with the geometry, and did in every editor that has
one: a file can claim `smooth` while its handles sit at ninety degrees. Worse
for us, an imported path has no such flag to import, so everything read as
`corner` and dragging a handle on a visibly smooth imported curve put a kink in
it.

Deriving it means:

- Nothing to choose before drawing. Draw points; the handles decide.
- The marker on screen cannot lie, because it is computed from the same
  geometry every frame.
- "Make this smooth" is a real edit to the handles, not a mode change. The old
  version set a flag, changed nothing visible, and silently altered the next
  drag.

`moveHandle` reads the relationship **before** it mutates. This is the whole
trick: afterwards the pair is no longer collinear and would always read as a
corner, so a smooth node would break itself on its first drag. Having read it,
mirroring produces exactly equal lengths, so the relation is self-maintaining
for the life of a drag. `Alt` breaks the pair, and "broken" needs no flag to
persist — it is just non-collinear geometry.

Two tolerances, in `core/types.ts`:

- **Collinearity: 1e-4 radians.** Not an epsilon on the raw numbers. A rotation
  is exact in theory and nearly exact in floating point, so a tight test would
  turn a mirrored pair into a corner after a rotate-and-bake. 1e-4 rad is
  ~0.006°, far below what anyone can place by eye and far above that drift.
- **Equal length: 1e-6 relative.** A non-uniform scale legitimately destroys
  equal lengths, and correctly demotes symmetric to smooth.

### Making a corner smooth

Because the reading is derived, `setContinuity` has to change geometry or it
changes nothing. `corner` removes both handles. `smooth` and `symmetric` used to
decline outright on a node that had none, which was correct about the model and
useless as a button: nothing moved and nothing said why. They now materialise
the missing handles where the hollow ghosts are drawn — a third along each
neighbouring segment — and align from there.

**The drawing does jump, and an earlier version of this section said it did
not.** The handles are placed on their chords and then rotated to the *averaged*
direction, which pulls both off. Clicking `Smooth` on a right-angle corner with
10-unit sides moves the curve by 1.48 units. The materialisation is sound; the
claim that it was invisible was not, and it was never measured. Worse, when the
two neighbouring chords are equal — a square, any regular polygon — each
materialised handle is a third of an equal length, so `smooth` lands on
`symmetric` and the documented three-state cycle is a two-state toggle.

Two cases have nothing to align against, and the function now works on
candidate handles rather than on the node — deciding first, and committing only
a complete answer. It used to assign the materialised handles and *then*
discover there was no second one, which left a straight segment carrying a
handle in breach of §3 while the caller announced that nothing had happened.

It returns whether it changed anything, which is what lets a caller decline to
record an undo entry for a click that did nothing. See §16.

| | Why |
|---|---|
| An end of an open subpath | No segment on the outside, so no handle to invent and nothing to align against |
| Smooth on a symmetric node | Symmetric *is* smooth — collinear handles of equal length. The only way to make the weaker reading true is to break the equality, which is a change nobody asked for |

## 7. Bend is a view, not a replacement

`core/bend.ts` describes a curved segment with two numbers — how far it bows
away from the chord, and how taut it is — after TikZiT's edge model, which
[quiver](https://q.uiver.app/) and TikZ itself independently arrive at.

It is a **view over the handles**, not a second representation. The model still
stores two control points; `bendToHandles` and `bendOf` convert. One source of
truth means a bend and a hand-dragged handle can never disagree, and dropping
back into free-handle editing costs nothing.

`bendOf` returns `null` for an asymmetric segment, which is how the UI knows to
stop offering the bend control. A straight segment reads as angle 0, so it can
be bent directly without being "converted" to a curve first.

## 8. The serialiser re-derives the shortest spelling

Since the model has no commands, output is reconstructed: absolute versus
relative per command, whichever is shorter; `H`/`V` where an axis is unchanged;
`L` where the handles are null; `S` where a control is the reflection of the
previous one; and `Q` where a cubic is exactly a degree-elevated quadratic.

The parser reads everything (`M L H V C S Q T A Z`, relative or absolute); the
serialiser deliberately emits a narrower set. `T` is never written — its
reflection rule chains across commands, so a single edited node changes the
meaning of every `T` after it, which is a poor trade for a few bytes.

Two things learned the hard way here, both preserved as comments in the code:

**Track the pen through the emitter, not alongside it.** Relative output
accumulates: each command's numbers are relative to where the previous one left
the pen, so the serialiser must know that position *as the text encodes it*.
Rounding with `Math.round(v*f)/f` while emitting with `toFixed` produces
different answers for binary values just under a halfway point, and the error
banks one grid step at a time. It took a 2 000-segment test to surface.

**Handles never affect the pen.** Only anchors need rounding-aware comparison.
An earlier "fix" that quantised whole subpaths broke `Q` recovery, because
`cubicAsQuad` amplifies control-point rounding by 1.5×.

## 9. Every drawn gridline is a snap position

`gridDisplayFor` in `view/viewport.ts` takes the step the tools actually snap to
and decides what to draw from it. The contract is one-directional and exact:
**every line on screen is a position the pointer can land on.**

This replaced a real defect. The canvas used to draw an adaptive decade step
derived from zoom while `controller.ts` snapped to the user's fixed `gridStep`,
so at most zoom levels you were aiming at a lattice that was not on screen. For
an editor whose entire premise is the grid, that is the wrong bug to carry.

The two obvious fixes are both wrong on their own:

- **Snap to the drawn step.** Then your coordinates depend on your zoom level,
  which destroys the reason to have a grid in an icon editor.
- **Draw the snap step.** A step of 1 across a 10 000-unit view is 10 000 lines,
  which is a solid grey rectangle and a layout cost to match.

So the drawn step is `gridStep × m`, with `m` a whole number off the 1-2-5
ladder — the smallest that keeps lines at least 9 px apart. Zooming out thins
the grid to every 2nd, 5th, 10th … snap position rather than switching lattices.
The asymmetry that remains is the safe one: some snap positions stop being
drawn, but nothing drawn is ever un-snappable. The readout says which
(`1 · every 5 drawn`) so the thinning is visible rather than mysterious.

Zooming in stops at `m = 1`. Subdividing further would draw lines you cannot
snap to, which is the same lie in the other direction.

Two smaller things fall out of it. Lines are indexed by whole multiples of the
step rather than accumulated as floats, so major-line selection is exact integer
arithmetic and index 0 is the origin — major lines cannot drift off the axes at
awkward zooms. And a `gridStep` of 0 (snapping off) draws no lattice at all,
because there is nothing honest to draw; the axes stay, since they are
coordinates rather than a claim about snapping.

## 10. Two stacked SVGs, one camera

`view/canvas.ts` renders artwork and overlay into two separate `<svg>` elements
sharing a viewBox and `preserveAspectRatio`. Grid, anchors, handles and marquee
live in the overlay; nothing decorative can end up in an export, and the
artwork layer is exactly what gets written out.

Zoom and pan move the **viewBox**, never a content transform. Screen-to-document
conversion is `getScreenCTM().inverse()`, so it stays correct under any page
layout without the code knowing anything about it.

Rendering is retained-mode with element pooling (`view/dom.ts`): elements are
reused frame to frame rather than rebuilt. Overlay redraws are
`requestAnimationFrame`-batched.

## 11. The window is the canvas

The shell is a fixed `100dvh` grid — command bar, work area, source drawer,
readout strip — and `body` is `overflow: hidden`. The page never scrolls,
because a scrolling page moves the canvas out from under coordinates that other
things already computed. That was not theoretical: the browser harness once
reported that clicking a node did nothing, when what had happened was that
typing into the source box scrolled itself into view and pushed the canvas off
the top.

Panels take space from the canvas rather than floating over it. Floating is
cheaper to build and looks tidier, but it means a document coordinate can be on
screen and unclickable at the same time, which is the same class of lie. So the
inspector is a real grid column and the source is a real grid row; when they
close, the canvas gets the pixels back. The one exception is below 860 px, where
the inspector floats after all — a 288 px column out of a 700 px window is worse
than the occlusion it avoids.

Which panels are open is view state, held as classes on `#app` and nothing
else. It is deliberately not in the store: it is not part of the document, it
should not be undoable, and putting it there would mean every drawer toggle
pushed a history entry.

The consequence is that the canvas box changes without the window changing, and
a camera left at the old aspect draws the document stretched. `window.resize`
does not fire for that, so the controller also watches the overlay with a
`ResizeObserver`, guarded by a `typeof` check because jsdom — where the DOM
tests run — does not implement one.

The `chrome` browser scenario asserts both halves: the canvas widens when the
inspector closes and tallens when the drawer does, the keyboard shortcuts land
in the same state as the buttons, and `scrollHeight` never exceeds
`clientHeight`.

## 12. Primitives are nodes from the start

There is no rect or ellipse in the model. `core/primitives.ts` builds them out
of the same nodes and handles as everything else, which is why a circle you have
just drawn can have one of its nodes dragged immediately — there is nothing to
convert, because there was never anything else.

A circle is four cubics with handles `KAPPA = 4/3·(√2−1)` times the radius,
round to about 2.7e-4 of it. Every node comes out symmetric by construction,
so it behaves like the smooth point it looks like without anything being
declared. A rounded rectangle is four quarter arcs and four straight sides, and
each corner takes two nodes: a node with a handle on one side and none on the
other, which `continuityOf` reads as a corner. That is correct — there is no
pair to keep in line — and it is what keeps the sides straight under later
edits.

`circulariseSubpath` is the inverse operation, and the interesting one.
`fitCircle` finds the best circle through the nodes by algebraic least squares
(Kåsa: `x² + y² = 2ax + 2by + c` is linear in the unknowns, so it is a solve
rather than an iteration, and centring the data first decouples `c` and keeps
the conditioning sane far from the origin). Each node then keeps its angle and
moves to the fitted radius.

The handles are rebuilt at `r · 4/3 · tan(θ/4)` for the angle θ each segment now
spans, which reduces to KAPPA at a quarter turn. It is the standard
midpoint-matching approximation, **not an exact arc** — a cubic cannot be one —
and its error grows steeply with the span: 2.7e-4 of the radius at 90°, 8.9e-3
at 160°, 1.8e-2 at 180°.

So the result is **not** independent of how the nodes are distributed, and an
earlier version of this section claimed it was. This document's own example —
five nodes at 0°, 10°, 20°, 140°, 260° — measures 1.54e-3 against 2.73e-4 for
four even ones, 5.7× less round. `test/primitives.test.ts:244` already asserted
the looser bound while the prose above it claimed parity; the test was right.

**A closed contour is a ring, and its spans must sum to a full turn.** Taking
each span the shorter way round is right below half a turn and silently
destructive above it: four nodes at 0°, 20°, 40° and 60° leave a 300° gap, the
shorter way reads that as −60°, and the closing segment retraces the other three
instead of completing the circle. Every node still lands exactly on the circle,
so a radial measurement cannot see it, and the reported travel is zero — it
looked like a success. So a closed contour now picks one winding from the sign
of the polygon's area, forces every span to follow it, and checks the total is
one turn; a node order that is not a ring, such as a star, is refused with
nothing mutated. Fitting is a compromise by nature — it
cannot know which node was the mistake — so the operation reports the radius it
found and how far the furthest node had to travel, and lets the reader judge.

## 13. Delete never refuses; break is the other operation

`deleteNode` used to keep a floor — three nodes for a closed subpath, two for
an open one — on the reasoning that a path being edited should not degenerate
into something that is not a path. It was the wrong trade, and it took a bug
report to see why.

Run in a loop over a selection, that floor turned "delete these eight" into
"delete five", silently. The three survivors read as a bug in the marquee, not
in delete. A closed path of three nodes could not be reduced at all, because it
was already sitting on the floor. The failure mode of refusing is invisible and
inexplicable; the failure mode it was guarding against — a two-node closed
subpath — is visible, obviously wrong on screen, and one undo away.

So there is no floor. A closed subpath goes down to two nodes quite happily:
two segments between the same pair of points, which draws as a line when they
are straight and a lens when they are curved. Below two nodes there are no
segments at all, so `deleteSelection` prunes what is left — but only from the
subpaths it touched, because a one-node subpath elsewhere is the pen mid-stroke
and deleting in one shape must not sweep up another.

What happens to the path *around* a deleted node is a setting, `state.deleteMode`,
because the two readings suit different work and neither is wrong.

**Heal** joins the neighbours, so a pentagon becomes a quadrilateral. It is what
Illustrator, Inkscape and Figma all do on Delete, and what simplifying wants. It
is also approximate: `deleteNode` rescales the surviving handles to cover the
new span, which preserves the end tangents and nothing else.

**Split** leaves the path open at the gap. `deleteNodesSplitting` collects the
survivors into maximal runs of originally-adjacent nodes and makes each run a
subpath, so every segment that survives is *untouched* — bit-for-bit the one
that was there. Runs of one node are dropped, because a lone node has no
segments and the parser discards a bare `M` on the way back in.

It is the default that was the mistake to argue about, not the choice: healing is
the safer default because it is the one every other editor trained people to
expect, and split is one click away in the Delete panel.

`breakAt`, on `Shift+B`, is a third thing and the one worth not confusing with
split-delete: it **keeps** the node and duplicates it.

|  | Delete · heal | Delete · split | Break |
|---|---|---|---|
| Node count | −1 | −1 | **+1** |
| Path | stays whole | two ends | two ends |
| Geometry | approximated | **exact** | **exact** |
| Undoes | the point | the point and the join | the join |

Deleting-and-fusing is lossy by nature and the deviation is measured (see Known
limitations). The other two are exact by construction, and a test asserts the
contrast directly: on an S-curve, break drifts under 1e-9 where healing drifts over
1. Offering only the lossy one was the real gap.

The mode is a preference rather than a modifier key, and it lives in its own
rail group rather than in Node. `.group.disabled` sets `pointer-events: none`
whenever nothing is selected, so a setting parked in the Node group would be
unreachable at exactly the moment you want to change it — before selecting the
thing you are about to delete.

## 14. Undo is whole-document snapshots

Not inverse operations. At icon and logo scale a snapshot is a few kilobytes,
and cloning it is cheaper than maintaining an inverse for every operation and
being wrong about one of them — a wrong inverse corrupts the document silently.

`beginBatch`/`endBatch` make a drag one undo entry rather than one per frame.

If a snapshot ever becomes too slow, that is a measurable problem with a known
fix. A wrong inverse is neither.

## 15. Booleans are the one thing not written here

`io/boolean.ts` is an adapter over [PathBool.js](https://github.com/r-flash/PathBool.js).

A correct boolean needs every curve-curve intersection found, a planar graph
built from them, winding numbers resolved per face, and all of it surviving
tangency and self-intersection. Getting it subtly wrong produces output that
looks right until it does not.

Its segment format happens to be our node model — a cubic is
`["C", p0, c1, c2, p3]` — so the adapter is a translation, not an integration
layer. It never touches path-data strings; we keep our own parser and serialiser
on both sides.

Vendoring the source was measured and rejected: 4 925 lines, more than this
entire editor, and only 92 of them concern arcs, so trimming to the subset we
feed it would save nothing while forfeiting upstream fixes.

Wiring it up cost **+35.8 kB raw, +12.8 kB gzipped** — the whole reason the
adapter sat unreferenced until the operations were actually wanted.

Two things guard the boundary, because the author calls the library early-stage
and asks for failure cases:

- `booleanShapes` **throws** on non-finite output rather than returning it. A
  NaN that reaches the document cannot be undone out of it — by then it is
  already in a history snapshot — so the check has to happen before the commit,
  and its failure has to be distinguishable from a legitimately empty result.
- `Controller.booleanSelection` catches, reports, and leaves the document
  untouched. Nothing is mutated until a finite result exists.

Selection order is document order, which is paint order: the first shape
survives with its id, name and style, and the rest are consumed. That makes
`subtract` bottom-minus-the-rest, matching Inkscape's Difference and
Illustrator's Minus Front, and it means the result inherits the appearance of
the shape it visually replaced. It requires a whole-shape selection — inferring
which shape was meant from a couple of selected nodes would be a guess made
silently and destructively.

---

## 16. A gesture ends exactly once, and a decline costs nothing

Two rules that the 2026-08-11 review found broken in four places each, both
fixed structurally rather than at the call sites.

**One drag at a time, and it always ends.** `onDown` returns early while a drag
is live, and whether the gesture opened a history batch is *recorded* in
`batchOpen` rather than reconstructed at `onUp` by inspecting whichever drag is
there. It used to be reconstructed, so a second pointerdown — two fingers on a
touchscreen — replaced the drag, the first batch was never closed, and
`checkpoint()` then returned early **forever**: no undo point was recorded again
for the rest of the session, with nothing on screen to say so. Cancelling now
routes to `abortDrag`, which rolls back rather than committing; `pointercancel`
used to be wired to `onUp`, so the browser taking a gesture away *committed* the
half-drawn shape, the opposite of what Escape does with the same intent.

`Store.rollback` exists for that: it restores the last checkpoint without
offering a redo. Escape used to call `undo`, which kept the abandoned shape on
the redo stack — one Ctrl+Shift+Z from resurrecting something explicitly thrown
away. Undo is also refused mid-drag, since popping the checkpoint the drag is
standing on makes it roll back somebody else's edit when it ends.

**An operation that declines leaves no trace.** `store.edit` checkpoints first
and asks questions later, which is right for a drag — you cannot know where it
will end — and wrong for a button. `store.tryEdit` takes a mutation that returns
whether it changed anything and takes the checkpoint back when it did not,
restoring the redo stack with it. Without that, a dead button pushed an empty
undo entry *and* silently destroyed a pending redo, so pressing it five times
cost five presses of Ctrl+Z, none of which visibly did anything.

The point is that the decision lives in one place. `setContinuity` returning a
boolean, and `circulariseSubpath` returning `null` before touching anything, are
the same idea one level down: work out the answer, then commit it.

## 17. One place decides how thick a line is

Overlay chrome has to stay a constant size on screen while the drawing scales,
and there are two ways to do that. Either the code multiplies a pixel size by
`scale()` (document units per pixel) and writes it as a normal width, or the CSS
gives a pixel width and `vector-effect: non-scaling-stroke` exempts it from the
transform. Both work. Doing both to the same element scales it twice.

That is what turned the marquee into a picket fence when zoomed out: `box()`
wrote `stroke-width: k` onto elements whose stylesheet already said
`non-scaling-stroke`, so the rendered width tracked the zoom instead of ignoring
it — 0.062 px at one end of the range and 0.909 px at the other, dashed 4-on-3
-off, which is a row of blue bars rather than a rubber band.

The rule now is a split by element, not by judgement at each call site: **if a
class carries `non-scaling-stroke`, its width lives in the stylesheet and the
render loop never touches it.** That covers `.marquee`, `.sel-box`,
`.insert-dot`, `.pen-preview` and `.anchor`. Everything else keeps its width in
the render loop, multiplied by `k`.

Worth knowing while reading either file: a CSS rule beats a presentation
attribute, so adding the stylesheet width silently disabled the inline one. The
inline writes were removed anyway, because a dead attribute that looks live is
how the next person re-introduces the bug.

The overlay's other size problem is not this one. Markers are screen-sized by
design, so zooming out shrinks the drawing underneath them until a shape is
buried in its own anchors. A handle closer to its anchor than the anchor's own
width is no longer drawn, on the grounds that a control you cannot separate from
the thing it controls is not a control.

## 18. The backdrop is workspace state, and is in the history anyway

The tracing image is the first thing in this editor that is not a path, and
`Doc` was the obvious place for it and the wrong one.

- **Export.** `exportSvg` is built from the model, so a backdrop the model does
  not know about cannot reach a file. Putting it in `Doc` would replace that
  structural guarantee with a rule someone has to remember every time the
  exporter is touched.
- **Apply.** The source box replaces `doc.shapes` wholesale. A backdrop living
  there would vanish when you edited the path text, which is a surprising way to
  lose the thing you were tracing from.

So `Backdrop` sits in `EditorState` beside `camera`, `gridStep` and
`showHandles`. It renders as an `<image>` that is the first child of the artwork
SVG, so it shares the camera and paints behind every shape without a third
stacked layer.

**The correction.** This section originally carried a third argument, that undo
snapshots the whole document and a 2 MB image would be cloned into every one of
200 history entries. That argument was wrong, and it cost the feature its undo
for a day. `src` is an *object URL*: a sixty-character string pointing at bytes
the browser holds exactly once. Cloning a `Backdrop` costs about what cloning a
node costs.

Worse, the conclusion drawn from it did not follow. "Not in `Doc`" and "not in
the history" are separate questions, and only the first was ever argued for.
`Snapshot` now carries `doc`, `selection` **and** `backdrop`, which leaves both
structural guarantees above untouched while making load, move, resize and remove
ordinary undoable edits.

Two consequences worth recording:

- **`opacity`, `visible` and `locked` are overlaid on restore.** They ride along
  in the snapshot and are then replaced with their current values by
  `restoreBackdrop`. Undoing a node move should not flip a checkbox you set
  afterwards, any more than it should move the camera.
- **Object URLs outlive the image on screen.** Revoking on Remove would restore
  an `<image>` pointing at nothing, which looks exactly like a working undo until
  you glance at the canvas. `Store.reap` revokes a URL only when no snapshot on
  either stack still mentions it, which happens in two places: the oldest entry
  falling off `HISTORY_LIMIT`, and a fresh edit clearing the redo stack. The
  store does not know what an object URL is; `onOrphanImage` is set by the layer
  that made one.

`tryEdit` needed care here. It clears the redo stack before the mutation reports
whether it did anything, and restores it if not, so freeing on the way through
would have left restored entries pointing at revoked URLs. The reap is deferred
until the edit is known to have happened.

One interaction decision worth recording. An unlocked backdrop takes the
empty-canvas drag that would otherwise start a marquee, rather than claiming a
modifier. Lining up a reference is a mode you stay in for a minute, not a thing
you do once, and a mode with a visible checkbox is easier to reason about than a
chord you have to remember while dragging.

## 19. Simplify decides where to fit; the fitter decides how

`core/fit.ts` is Schneider's algorithm from Graphics Gems, and it knows nothing
about paths: give it points and two tangents and it returns cubics.
`model/simplify.ts` owns every judgement call, and there are four.

- **Corners are found first and fitted around.** A node where the path turns by
  more than 50 degrees ends one run and starts the next. Fitting through it would
  round off the point of a star or the corner of a traced letter. The threshold
  errs towards keeping detail: a corner wrongly kept is a node you can delete,
  and a corner wrongly smoothed is a shape you have to redraw.
- **Every surviving node keeps its tangents.** They are inputs to the fit, taken
  from the original geometry, not something the fit chooses. A corner stays
  exactly as sharp and a smooth join stays smooth.
- **A closed path with no corners is cut at node 0** and fitted as a single run,
  with the original tangents from both sides of that node passed in. This is why
  a simplified circle has no kink at three o'clock, and it costs nothing: the fit
  is being told what the path already did there. A closed path that *has* corners
  is cut at those instead, and node 0 gets no special treatment.
- **Sampling caps both flatness and spacing.** Flatness alone is not enough. A
  straight input segment is perfectly flat, so it samples to its two ends, and
  the fit is then free to bow out between them because the tolerance is only ever
  checked where a sample sits. `SAMPLE_SPACING` puts a sample everywhere the
  answer could go wrong. Adding it changed a 40-gon at tolerance 0.05 from "12
  nodes, error 0.0495" into an honest refusal, and that number had been wrong by
  a factor of three.
- **The tolerance is a budget, not the fitter's target.** Three things move the
  outline and only one of them is the fit: the sampling is up to `SAMPLE_RATIO`
  of the tolerance away from the true curve to begin with, and straightening a
  nearly-flat result moves it again by up to `FLATNESS_BOUND * LINE_RATIO`. The
  fitter is handed what is left. Giving it the whole tolerance and adding the
  other two afterwards is how a simplify at 8 was measured 8.33 away, which is
  the same overshoot `SAMPLE_SPACING` was added to stop, arriving by a different
  road. A result that still cannot fit inside the budget is refused rather than
  applied, since `fitCurve` does give up at its recursion cap on a dense,
  heavily oscillating run.

Two smaller decisions. A result with the same node count is refused rather than
applied, because rebuilding a path into the same number of nodes only trades the
geometry someone drew for the geometry a fit guessed. And the selection is
cleared afterwards, since node selections are keyed by index and index 7 is now a
different point on the drawing.

## 20. The transform box, and the space it has to leave

Direct manipulation was the whole argument for this editor, and scaling was the
last thing you could only do by typing a number into a panel. The box closes
that, and almost all of its difficulty is one problem: **a shape's own nodes sit
on its bounding box by definition.**

A rectangle's corner anchor and its north-west scale handle want the same point.
Handles are in `chrome`, the last overlay layer, so they are in front of the
anchors and win every click that reaches both. Drawn naively, the box would make
the corners of a rectangle permanently undraggable.

Two decisions follow, and the second was got wrong first:

- **`BOX_PAD`.** The box and its handles are drawn six screen pixels outside the
  true bounds, which is enough to clear an anchor marker. The arithmetic still
  uses the true box, so the drag records the offset between where the pointer
  pressed and where the corner actually is. Without that correction the first
  move would snap the corner to the pointer and the shape would jump before it
  moved.
- **`ROTOR_SIZE` sits outside the corner, not on it.** The first version centred
  a 26 pixel rotation zone on each corner, which covers a corner anchor
  completely: the shape could be rotated and its corner could never be selected
  again. The browser scenario caught it by clicking the corner of a rectangle and
  counting what got selected. The zone is now placed with its inner corner on the
  box's corner, so all of it lies diagonally outside, which is also where every
  other editor puts rotation.

The maths lives in `model/transform.ts`, away from the DOM, because interaction
is the hardest thing here to test and arithmetic is not. `scaleMatrix` decides
which point stays still and what factor each axis takes; `rotateMatrix` turns a
swept angle into a matrix. One subtlety is recorded there: constraining a corner
drag with Shift takes the factor by **projecting the pointer onto the box's
diagonal**, not by taking the larger of the two axis factors. The larger-of-two
rule reads as obvious and fails in one direction, because dragging inwards leaves
the untouched axis at exactly 1, which then wins the comparison and nothing moves
at all.

Every frame recomputes from `captureNodes`, a copy of the geometry taken at the
press, rather than composing one frame's matrix onto the last. Compounding drifts:
scaling out and back does not return the shape it started with, and the end state
would depend on the path the pointer took rather than on where it stopped.

Everything is baked, per §5. There is no `transform` attribute waiting to be
applied at render time, which is why the source box always shows what is really
there.

## 21. The document has a page, and it is drawn

`doc.viewBox` is the `viewBox` the export writes. It was set at startup, replaced
on import, and touched by nothing else: no control read it, no control changed
it, and **nothing on screen said where it was.**

That last part is what made the first two confusing rather than merely limiting.
The grid runs to the horizon and looks identical inside the page and outside it,
so a drawing placed in one corner of an 88 by 64 document looks centred while you
are working and occupies a fifth of the file when you export it. The report that
prompted this said the viewBox "seems to not update at all, with anything", which
was true, and reasonable to read as a bug.

Three parts, in order of how much each one helps:

- **It is drawn.** `renderDocEdge` puts a rectangle at the viewBox and dims
  everything outside it, as one path of two rectangles with `fill-rule: evenodd`
  so the page is a hole in a sheet. Both carry `pointer-events: none`, since
  filled overlay chrome would otherwise take every click on the canvas.
- **It is editable**, as four numbers in the Canvas panel. `viewBox` lives in
  `Doc`, so `cloneDoc` was already copying it and undo works with no extra
  machinery. Width and height refuse anything at or below zero rather than
  accepting a document that cannot be exported.
- **`fitCanvasToDrawing` wraps it around the content**, rounded outwards to whole
  grid steps. Outwards always: rounding must never crop.

**It still does not follow the drawing on its own, and should not.** An icon is
drawn to a page, and a page that resized itself whenever a node moved would make
the margins you were aiming for impossible to hold. Drawing outside the page is
allowed and stays that way; the panel says `drawing goes outside` when it does,
which is placed next to the button that fixes it rather than in the status strip,
because the only moment that matters is export and nobody is looking at the
canvas then.

One bug worth recording, since only the browser scenario could have caught it.
The panel's number fields are wired through `liveNum`, a `const` arrow function
declared two hundred lines below the Canvas block that calls it: a temporal dead
zone, thrown at module load, which killed every `store.subscribe` registered
after that point. The unit tests passed, the canvas still rendered because the
controller subscribes from its own constructor, and the only visible symptom was
an empty readout in the status strip.

## 22. Style, and three tabs over eleven groups

`Style` had been in the model since the beginning, was imported and exported
faithfully, and `renderArtwork` honoured it per shape. Nothing could change it.
Everything drawn got `defaultStyle()` for ever, so the editor could produce
exactly one appearance of SVG.

The panel is unremarkable; two decisions in it are not.

**The default style is not in the history.** `EditorState.style` is what the next
shape gets, and `setStyle` with nothing selected writes it through `update`
rather than `edit`. Choosing a colour for something you have not drawn yet is a
statement about the future, and `Ctrl+Z` walking back through the colours you
considered would be a strange thing for it to do. With a selection it is an
ordinary `tryEdit` on the document.

**The colour picker stays live while `none` is ticked.** `<input type="color">`
speaks only `#rrggbb`, so `none` needs a separate control, and the first version
disabled the picker while it was set. That made filling an unfilled shape a
two-step dance whose first step committed a colour nobody chose. Now reaching for
the colour is the whole gesture and it clears `none` itself. The picker is also
only ever *written* with a plain hex: a document can hold `currentColor`, a
named colour or a gradient reference, and writing one of those into the control
rounds it to black, which the next interaction would read back as a real edit.

`filled` changed meaning here. It used to paint shapes whose fill is `none` a
placeholder grey, which made "is this filled?" unanswerable from the screen. It
now only decides whether the fills that exist are drawn.

### The tabs

Eleven groups in one scrolling column had become a list to hunt through. The
split is by what a control acts on: **Shape**, **Node**, **Document**. Nothing
switches tab on its own; an inspector that jumped to Node the moment you clicked
a point would move the button you were reaching for. Panels use `hidden` rather
than a class, so a control you cannot see is also out of the tab order and out of
the accessibility tree.

Two bugs came out of this, both found by the browser scenarios and neither
visible to a unit test:

- **A missing `</div>`** in the new Style group nested every later panel inside
  the first one. Hiding the Shape panel therefore hid all three, and the
  Document tab opened onto nothing. The panel had `display: flex` and a computed
  height of zero, which is the signature of an ancestor that is `display: none`.
- **Scenarios were pressing Ctrl+Z into a focused text field**, where the
  controller correctly ignores it and the browser's own text undo answers
  instead. Restoring a number field's text fires `input`, which sets the value
  back through the app, so a scenario asserting on the result passed without the
  editor's history being involved at all. `drive.mjs` now has an `undo` helper
  that blurs first.

One process note. A batch of scenarios run immediately after editing
`index.html` reported a clean sweep that individual re-runs contradicted. Treat a
green batch taken straight after a markup change as unproven, and re-run the
scenarios that touch what changed.

## 23. Rounding a corner refuses rather than approximates

`roundCorner` replaces a corner node with two, one at each tangent point, and an
arc between them. It is the operation the rectangle tool performs while drawing,
available afterwards on anything.

**Both sides have to be straight, and a curved side is refused.** A fillet is
defined by being tangent to two lines. Against a curve you can put an arc
somewhere near the corner, but it will not meet the curve smoothly, and a corner
operation that leaves a kink has not done its job. This is the opposite call from
§13, where **Heal** approximates rather than refusing, and the difference is
what the user can tell: a healed segment that differs is visible and undoable
straight away, while a fillet that is a fraction of a degree off tangent looks
right and is wrong.

The radius is clamped to what the shorter side can hold, and the clamp is
reported. Rounding the four corners of a rectangle one at a time works because
each one sees the sides the previous ones left behind.

**Where a fillet lands exactly on its neighbour, the neighbour is reused.** Two
routes get there: the clamp, and two arcs meeting in the middle of a side they
share. Inserting a node anyway left two anchors on the same point and a
zero-length command in the exported path, and a path carrying one can never be
simplified again -- a zero chord gives the fitter no tangent to work from. It is
also the right answer geometrically: two arcs that meet share the point where
they meet, which is what turns a 40 by 20 rectangle rounded at 10 into a proper
six-node stadium. A test asserted the duplicate for a week before the review
caught it.

Two things the caller has to get right, and `roundSelection` does:

- **Descending index order.** Each rounded corner turns one node into two, so
  every index after it shifts. Ascending order rounds the wrong points from the
  second corner on, and the failure is quiet: you still get eight nodes out of a
  rectangle, they are just not where you asked.
- **The refusals are named.** `end`, `curved`, `straight` and `tiny` are all
  things the person pressing the button can act on, and "it did not work" is the
  least useful thing to tell them.

The arc is the same cubic approximation used everywhere else. Measured on a
quarter turn it sits 0.0272 % of the radius off a true circle, which is what
"about 0.027 %" in §12 was covering.


## 24. Fuse removes a segment, where every neighbour removes a node

`fuseNodes` welds two **adjacent** nodes into one. It sounds like the harder
relative of `mergeEnds` and it is the easier one, which is worth saying plainly
because the reverse assumption is what kept it unwritten for a month.

`mergeEnds` refuses anything but two free ends because welding ends is a topology
change it has to reason about: two paths become one, or one becomes a ring, and
either way something has to decide the direction each piece is travelled in. In
the middle of a path there is no topology to change. The pair is already joined
by a segment, and fusing them removes that segment. Nothing reverses, nothing
concatenates, no subpath appears or disappears.

**Adjacent only, and the refusal is the point.** Two nodes further apart have a
run of segments between them, and welding those would pinch the path into two
loops sharing a point -- a different operation, under a different name, that
would have to decide what happens to everything in between. Guessing at it here
would silently discard geometry, so `apart` comes back instead.

The seam of a closed path is the case a plain index comparison gets backwards:
the last node precedes the first. Fusing that pair keeps node 0 as node 0, so a
ring is not re-rooted by a repair and every index held elsewhere still means what
it meant.

**The repair half is why this exists.** Two anchors on the same point export a
zero-length command, and a path carrying one can never be simplified again: a
zero chord leaves the fitter with no tangent to work from. §23 closed the route
through `roundCorner`, and two remained. `rectSubpath` now names its four tangent
coordinates once and emits a vanished side's two ends as one node, so a square
rounded to its own limit is a four-node circle and a 40 by 20 rounded at 10 is a
six-node stadium. `circulariseSubpath` runs `fuseDegenerate` afterwards and
reports the count in the status line, because two nodes at the same angle about
the centre land on the same point of the circle however faithfully each one was
placed, and the node count changing is something the person watching should be
told. It computed that count and threw it away for a day, while this paragraph
and two others said the user was being told.

`fuseDegenerate` is also offered directly: with a shape selected rather than a
pair, **Fuse** sweeps it. A path can arrive carrying a zero-length segment from
an import or a trace, and until now there was nothing that could take one out.

One naming note, since it will look like churn otherwise. **Fuse** was already
the name of a Delete mode, meaning "join the two neighbouring segments". Two
controls with one name in one panel is worse than a rename, so that mode is now
**Heal**, which is what it does and what Illustrator calls the same idea. Delete
modes remove a node; Fuse removes a segment.


## 25. Pixel fit is a phase, not a second kind of snapping

A stroke is painted centred on its path. A one-unit stroke whose centreline sits
at x = 10 covers 9.5 to 10.5: half of one pixel column and half of the next,
which renders as two columns of grey rather than one of black. Snapping anchors
to integers does not help. Integers are exactly the wrong place for an odd-width
stroke to be, so the grid was actively working against the thing it was there
for.

The condition is one line. The painted edges sit at `x ± w/2`, so both are whole
numbers exactly when

    x ≡ w/2  (mod 1)

which is the same lattice shifted by a phase: half a unit for width 1 or 3, zero
for width 2 or 4. So `snap` grew one optional argument and nothing else changed.
No second snapper, no per-shape lattice, no new interaction between snapping
modes.

**The phase is per shape, and the grid can only draw one.** That is the tension
this section exists for. §9's rule is that every line drawn is a position the
pointer can land on, and a grid drawn unshifted while the tools snapped shifted
would break it in the least visible way possible: half a pixel, on a lattice
nobody would think to check. So one phase is in force at a time, taken from the
selection or from the pending style, and `phaseInForce` is called by the snapper
and by the grid renderer both. They cannot disagree, because there is nothing to
keep in sync.

A selection whose shapes want different lattices returns `null` rather than
picking one. Two shapes of width 1 and 2 are half a unit apart in phase and no
third lattice serves them; the plain grid stands, and the readout says
`mixed widths` instead of quietly fitting one of them.

**A fractional stroke width can only have one edge aligned**, and this is a fact
about the geometry rather than a shortcoming here: the two edges are `w` apart,
so unless `w` is a whole number no position puts both on whole pixels from any
lattice at all. The leading edge is the one aligned. The obvious test -- both
edges whole, for every width -- is false and looks true, so it is written out as
its own case rather than left to be discovered.

Snapping only governs what you place next, so **Fit selection to pixels** applies
the same lattice to what is already there, with the handles riding along so a
curve keeps its shape. It is a button rather than something the switch does on
being ticked: nothing here rewrites coordinates the user did not ask about.


## 26. Auto-trace, and the half we already owned

A tracer is four stages: quantise the raster to a palette, label the regions and
walk their boundaries, fit curves through the polylines, write the result out.
Stages three and four have been here since Simplify and the serialiser
respectively, and they are the expensive ones.

So the only thing to acquire was stages one and two, which are exact integer work
on a pixel grid: no intersections, no tangent ordering, nothing that can be
numerically wrong. **That is the opposite of the boolean decision**, where the
maths is treacherous and "don't write it yourself" was the whole argument.

Measured in this build rather than estimated:

| | raw | gzipped |
|---|---|---|
| `@visioncortex/vtracer`, WASM | 668.0 kB | 278.3 kB |
| auto-trace as built here, all in | 6.9 kB | **2.3 kB** |

120 times smaller, and the larger number would have arrived base64'd inside the
single HTML file whether anyone traced anything or not.

Measured by removing the feature from a clone of the tree and rebuilding. The
figure first published here was 5.6 kB / 2.0 kB with the explanation that it
included "the panel and the shape building"; it did not. That is the code alone,
and the panel's markup is the remaining 1.1 kB / 0.3 kB. The full comparison, and
the five other candidates, are in SHOPPING-LIST.

**The walk is ported from ImageTracerJS** (András Jankovics, Unlicense), which is
where the edge-node scheme and its 16-by-4 lookup table come from. The port was
checked against the original on four fixtures -- a disc with a square hole, a
ring, a field of stripes, and a diagonal -- and agreed point for point, hole
nesting included. That check needed a copy of the reference in the repo to run,
so it was run once and is recorded here rather than kept: two copies of one
algorithm is a worse thing to own than a paragraph.

**The quantiser is not ported.** Its k-means sampler, asked for three colours on
an image with exactly three, returned white, red and red; at eight it spent five
of them on red. Flat artwork is made of a handful of exact colours, so
`censusPalette` counts them. Simpler, and exactly right for the thing this editor
is for.

Three smaller decisions:

- **Coordinates are mapped into document space before fitting**, so the tolerance
  a person types is in the units they are drawing in rather than in pixels of a
  reference whose scale they never chose.
- **A fully transparent palette entry is dropped**; an opaque background is not.
  The first paints nothing and would put an invisible shape in the export. The
  second is part of the image, and deciding otherwise on the user's behalf is the
  kind of helpfulness that loses work.
- **Holes are subpaths under `fill-rule: evenodd`.** The walk reports which rings
  are holes and which outline each belongs to, but promises nothing about
  winding, and even-odd is the rule that does not need the promise.

**Nothing sweeps for zero-length segments, and that is deliberate.** One was the
first thing guarded against, since a zero chord leaves the fitter with no tangent
(§24). Then it was measured: the walk steps one lattice unit at a time and the
midpoint pass halves that, so **0.5 is the floor** and no pair is ever 0 apart.
Removing the guard changed nothing on any fixture. The test pins the floor
instead of defending against a case the floor rules out.

The first version of that sentence said "0.5 or 1.0 apart", which is false and
was offered as a measured fact. Two midpoints across a turn are √2/2 ≈ 0.7071
apart, and on a checkerboard **every** gap is. The safety conclusion survives --
0.5 really is the minimum -- but an enumeration is a stronger claim than a bound
and this one had not been checked against a diagonal.

End to end, on a 64 by 64 icon of a disc with a square hole: three rings, **344
boundary points fitted to 19 nodes**. Node soup was the reason Simplify had to
come first, and it did.


## 27. The most specific target within reach wins

Snapping had two modes and an implementation detail standing in for a rule:
compute the grid, then let a nearby point overwrite it. That lands in the right
place and is not a rule, which stopped mattering the moment pixel fit arrived and
a third thing wanted a say.

The rule is IPE's, and it is one line: **the most specific target within reach
wins**, where specific means lower dimensional.

| | Target | What it is |
|---|---|---|
| 0-D | vertex | an anchor already in the drawing |
| 1-D | boundary | any point along an existing curve |
| 2-D | grid | a lattice that fills the plane |

Each tier beats the one below whenever it is close enough to count.
**Distance does not break ties between tiers**: a vertex seven pixels away beats
a gridline one pixel away, because the person aiming at it can see the vertex and
cannot see the lattice line. Reach is measured in screen pixels, so it feels the
same at every zoom.

**Pixel fit is not a fourth tier.** It says where the lattice sits, not what to
aim at, so it lives inside the 2-D tier and is beaten by everything the grid is
beaten by. That is the honest reading, and it is also the useful one: welding to
a node someone can see still matters more than landing on a lattice they cannot.
Writing the rule down is what made this answerable rather than an accident of
statement order.

**The trap that only appears once boundary snapping exists**: a node being
dragged lies *on* the two segments it joins, both of which report a distance of
zero, so without an exclusion it would pin itself where it already is and never
move again. Excluding the whole subpath would have been the easy fix and the
wrong one, since the far side of the same path is a legitimate target. Only the
two incident segments go.

The rule lives in `model/snapping.ts` as a pure function of a document, a point
and some numbers, because a priority order is exactly the kind of thing worth
testing and the controller is exactly the kind of thing that is not. The
controller supplies what only it knows: the camera, and what is being dragged.

The readout shows the snap target's own coordinates when a vertex or a boundary
claims the pointer, and the raw position otherwise. Not for the grid: with a step
of 1 the readout would lock to integers and stop being a pointer position at all,
for a lattice that is already drawn on screen.


## Known limitations

Recorded because a document listing only the wins is not worth reading.

**Deleting a node across an inflection is genuinely lossy.** Fusing two
segments into one rescales the surviving handles, which preserves the end
tangents and nothing else. On an S-curve, where the deleted node *is* the
direction change, no single cubic can replace two. Measured maximum deviation
is **7.55 on an 80-unit span**. Two tests assert this is both non-zero and
bounded, rather than one test asserting a flattering number.

**Not every snap position is drawn when zoomed out.** The converse — a drawn
line you cannot snap to — is impossible by construction, and that is the half
that matters. See §9.

**Arc round-trip is one-way.** See §2.

**PathBool.js is early-stage** by its author's own description, who asks for
failure cases. Treat returned geometry as untrusted: check it is non-empty and
finite, and keep operands on the undo stack.

**One reported rendering bug was never reproduced.** A screenshot showed stray
path fragments. Overlay pools were proven to clear correctly, and rendering
invariants hold through pen sessions, undo/redo, deletion, transforms and
Apply. Two plausible causes were found and fixed — one-node ghost shapes, and
a source-Apply collapse — but neither was confirmed to be *the* one. If it
recurs, the `d` string or click sequence would settle it.

---

## Testing philosophy

Where a test could pass for the wrong reason, measure rather than compare.

Three bad tests were caught and rewritten during development, and the pattern
in all three was the same — an assertion that looked strict but wasn't:

- Comparing point **sets** reported 0.72 error on a curve split that was
  numerically exact. Replaced with projected deviation.
- A transform test needed index-wise comparison, because an affine map
  preserves parameterisation and a set comparison would hide a reordering.
- A flip-involution test used a shape symmetric about the flip axis. It would
  have passed with flipping entirely broken.

The same reasoning drives the boolean tests: they assert enclosed **area**, not
path strings. A boolean is obliged to produce a region, not a particular
spelling of one. A fourth bad test was caught while wiring them up — it checked
that a subtraction's `d` contained the substring `0 0`, which the serialiser
never emits because it writes `H 0` instead. The direction of the subtraction is
now checked by bounding box, which distinguishes the two ways round; the area
does not, since both leave 300.

`test/grid.test.ts` states the §9 contract as an invariant and sweeps it across
six orders of magnitude of zoom and nine snap steps, rather than checking a few
representative cases. The contract is exact — a line is either on the lattice or
it isn't — so there is no tolerance to tune and no reason not to sweep. The same
check runs against a real layout engine in the `gridHonesty` browser scenario,
because the step depends on a measured element width that jsdom does not have.
