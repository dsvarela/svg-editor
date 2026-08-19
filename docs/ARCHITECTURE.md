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
- `Commands.booleanSelection` catches, reports, and leaves the document
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

## 19. Simplify is two operations, and only one of them redraws

Simplify used to mean "resample the path and fit curves to the samples". That is
still in here, but it is now the optional half. The button runs **removal**
first, always, and **refitting** only if Redraw curves is ticked.

The split exists because of a defect with a very short repro: double-click an
outline four times to add four nodes, then Simplify, and the shape never comes
back. Splitting a segment is exact, so the four new nodes say nothing that the
path was not already saying, and putting them back should be free.

**A resampler cannot recognise a redundant node.** Schneider's algorithm fits
*digitised points*. "This input is already a cubic" is not a question it can be
asked, because by the time it sees the input the curve is gone. Measured: given
100 exact samples of a single cubic at tolerance 0.001, `fitCurve` returns
**seven** curves. The cause is not the iteration cap. Tracing it shows about
0.5% convergence per pass against `MAX_ITERATIONS = 4`, and lifting the cap to
200 still never returns one curve. Hand the same solve the *true* parameters
instead of chord-length ones and it returns the exact control points in a single
pass. So the information the fitter needs is the parameterisation, which a path
carries and the resampling throws away.

### Removal: `model/knots.ts`

A path of cubic Béziers is a cubic B-spline whose interior knots all sit at
multiplicity equal to the degree. Deleting a node is knot removal at `t = 3`,
which succeeds exactly when the curve is C3 there -- that is, when the two
segments are two pieces of one cubic. Tiller (CAD 24(8), 1992) gives the price
in closed form: a discrepancy between reconstructed control points bounds how
far the curve can move, everywhere, and confines the movement to one basis
function's span. That is what makes this affordable. There is no sampling and no
projection; removing a node costs a few dozen flops, not a scan of the curve.

Tiller assumes a knot vector, and a Bézier path does not carry one. **The
tangent ratio supplies it.** Splitting a cubic at `t` scales the two handles
meeting at the join by `t` and `1 - t`, so `t = a / (a + b)` recovers the split
parameter exactly, and de Casteljau run backwards recovers the parent's control
points from either side.

The cost of a removal is the **maximum of three** disagreements, and each of the
last two is there because a shape survived without it:

- **The control points.** The parent cubic reconstructed from the left segment
  against the same cubic reconstructed from the right. This is Tiller's bound.
- **The bend.** A right angle scored *zero* on the first version. Taking `t`
  from the handle ratio makes the reconstruction internally self-consistent
  about a curve that is not the input, so both sides agreed exactly and a square
  lost its corners. The C1 error is now priced separately.
- **The join.** Dragging a node together with its handles was invisible: every
  ratio survives a translation, and at `t = 0.5` both reconstructions shift by
  the same amount, so a node moved two whole units read as free. The candidate
  curve now has to pass through the join at parameter `t`.

**Order matters more than it looks.** Cheapest-first is wrong on a circle, where
every node costs about the same and greedy eats it from one end. Lyche & Mørken
(IMA J. Numer. Anal. 8(2), 1988) bucket the costs by powers of two and spread
the removals within a bucket, which is what `pickSpread` does. No two adjacent
nodes go in one pass, and costs are recomputed between passes, because removing
a node changes what its neighbours are worth.

The paper's advice on pass count does not transfer, for that same reason: taking
no two adjacent nodes means one pass can only ever halve a run. At a cap of five
passes, 128 subdivisions stranded at 5 nodes and 256 at 9, when the answer to
both is 4. The cap is 24.

Two smaller things. A merged straight run is written back with **null handles**,
not with controls on the thirds of the chord, or `segmentIsLine` stops
recognising it and the run collapses once and then refuses to collapse again.
And **Within 0 is a real setting**, not a refusal: it means move nothing, and
what it removes is every node that cannot change the exported file. The floor is
`0.5 * 10^-decimals`, half a unit in the last place the serialiser writes.

### Refitting: `model/simplify.ts`

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

A refit with the same node count is refused rather than applied, because
rebuilding a path into the same number of nodes only trades the geometry someone
drew for the geometry a fit guessed.

And whichever half ran, the selection is cleared afterwards, since node
selections are keyed by index and index 7 is now a different point on the
drawing.

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

**Keylines are not a fourth tier either.** They are outlines that happen not to
be in the document, so a keyline corner is a vertex and a keyline edge is a
boundary, and the rule above already decides them. Inside a tier the nearer one
wins, which is what happens between two real shapes, so a keyline never beats a
node you can see: the drawing is the work and the grid is scenery. They are
handed in as `guides` and only while they are on screen, since a target nobody
can see pulling the pointer reads as the editor misbehaving.

The readout shows the snap target's own coordinates when a vertex or a boundary
claims the pointer, and the raw position otherwise. Not for the grid: with a step
of 1 the readout would lock to integers and stop being a pointer position at all,
for a lattice that is already drawn on screen.

## 28. The tracer moved off the thread; the freeze mostly did not

Tracing a 900 by 900 photograph blocked the main thread. The review of
2026-08-12 recorded that as "`traceImage` is synchronous — 13 seconds", deferred
it, and said a worker was the answer. Both halves of that were wrong, and only
measuring found out.

`model/trace.worker.ts` is the worker, and it is nine lines of real work because
`traceImage` is a pure function from plain data to plain data: a raster clones
across the boundary, `Shape`s clone back, and neither `model/trace.ts` nor
`core/raster.ts` knows the file exists. Vite inlines it as base64 with
`?worker&inline`, which keeps the single-file build's promise of no external
requests, at **+1.9 kB gzipped** — measured by building the same tree with the
worker import removed, not by subtracting the commit's total, which also carries
the overlay work below. It is constructed as a *classic* worker,
not a module: Chromium refuses a module worker from a `blob:` URL when the page
came from `file://`, and opening the file from disk is the whole point of the
build. Vite's default worker format is `iife`, so this is already what happens
— setting `worker: { format: 'es' }` would break tracing on disk, silently, and
only on disk.

The synchronous path is kept and reached whenever a worker cannot be built: a
`worker-src` policy that forbids `blob:` should cost you speed, not the feature.
The `traceWorker` scenario runs both, by taking `Worker` away and tracing the
same picture, and asserts the fallback blocks for at least 100 ms longer —
otherwise the scenario would be measuring nothing, which is what an earlier
draft of it did.

Because the answer now arrives some hundreds of milliseconds after it was asked
for, and the thread is live throughout, `applyTrace` re-checks the world the walk
was told about: the backdrop still exists, has not moved, and no drag is in
flight. The placement comparison is exact, deliberately. It is not asking
whether two placements are the same *place* — that question needs `MEET` — but
whether these numbers were changed, and a backdrop nudged by a ten-thousandth is
still one that moved under a trace that assumed otherwise.

**And the worker was only a quarter of it.** With the walk off the thread the
same trace still blocked for 1 152 ms. The cause was not the tracer at all: the
overlay drew a marker for **every node in the document**, camera or no camera,
and a traced photograph is 23 454 nodes. So every pointermove after a trace paid
205 ms, not just the trace itself. Two rules in `renderNodes` now:

- **Off-screen markers are not drawn.** A marker is a thing you aim at, and one
  outside the camera cannot be aimed at by anybody.
- **Above `MARKER_CAP` markers in view, none are drawn**, and the document
  readout says `markers off, too dense`. Drawing the first 2 000 and stopping
  would make which nodes you got depend on the order shapes are stored in, which
  reads as the rest of the document having no nodes.

The cost is stated rather than hidden: with markers off, nodes cannot be clicked
at all, because the anchors *are* the hit targets. At the densities that trigger
it they could not be clicked accurately anyway, but "not usefully" and "not at
all" are different things, so the readout names which one you are in. It is
written from `controller.onRender` rather than from a store subscriber, because
whether markers were drawn is a fact about a render, and subscribers run a frame
before one happens.

Measured on the same 400 by 400 fixture, in Edge:

| | before | after |
|---|---|---|
| trace, click to shapes | 1 719 ms | 761 ms |
| longest blocked task | 1 152 ms | 215 ms |
| one render afterwards | 205 ms | 113 ms |
| markers drawn | 23 454 | 0, and said so |

The blocked-task row is a `longtask` `PerformanceObserver` reading, which measures
the longest single task. `traceWorker` measures the gap a 10 ms interval sees
instead, because `longtask` is a Chromium entry type and Firefox reports nothing
for it. **The two are not comparable**: consecutive tasks with no yield between
them are one gap and several long tasks, so the same page reads higher on the
timer. On Firefox it reads 274 to 353 ms where this table says 215.

What is left is the honest remainder: a 23 454-node document costs about 113 ms
a render, spread evenly across serialising the artwork, serialising the overlay
outlines that duplicate it, and the per-node loops. None of it is waste in the
way 23 454 unaimable markers were waste; all of it would want a render cache
keyed on something the store does not currently promise, which is its own piece
of work and is not begun.

## 29. The render cache asks about numbers, not about flags

§28 left a 23 454-node document costing 113 ms a render and said a cache would
want something the store does not promise. It does not, as it turns out, because
the question can be asked a different way.

Measured first, which changed what got built:

| per render | ms |
|---|---|
| building the artwork's `d` | 56.1 |
| building the overlay outline's `d` -- the identical string, again | 56.3 |
| `setAttribute` for both | 0.7 |
| per-node marker loops | 8.1 |

Half the cost was a duplicate. The overlay's hit target is the same path as the
artwork with the same serialiser options, and the two were built independently
every frame.

**Why not a revision counter.** The obvious cache key is "has the document
changed", and the obvious implementation is a number the store bumps. It does
not work here: `Store.edit` and `Store.update` mutate the live document **in
place** -- history clones on the way into a snapshot, not on the way out of an
edit -- so a dragged node is the same object with different numbers in it.
Identity says nothing. A counter would have to be bumped by every call site that
touches geometry, a contract enforced by nobody, whose failure mode is a canvas
that silently stops matching its own model.

So `view/pathcache.ts` asks the one question that cannot go stale: *are these
the numbers I serialised last time?* It keeps a flat `Float64Array` of the
geometry a `d` is built from, compares element-wise, allocates nothing, and
stops at the first difference. About 0.5 ms across 23 454 nodes against 56 ms to
serialise them, so it pays even when it fails. A checksum would have been
shorter and would have had collisions, and a collision here means showing
geometry the document does not have.

Handle presence is a flag rather than `NaN` coordinates, because `NaN !== NaN`
would make every straight segment compare as changed for ever. Style is excluded
deliberately: it is not in a `d`, so a colour change must not throw the string
away.

**Two more, found by the same measurement.** The source box was a third full
serialisation per notification and ran with its drawer closed -- 56 ms to update
a textarea of `height: 0`. And two panel readouts materialised the whole
selection to ask its size: `selectionCount` built 23 454 ref objects and 23 454
dedupe keys to answer "how many", and `activeSegment` built a Set of 23 454 keys
before asking a question that is settled after two segments. Both are counted or
tested directly now, which is exact rather than cached.

| on a 23 454-node document | before | after |
|---|---|---|
| one render | 130.8 ms | 19 ms |
| one notification | 34 ms | 7.4 ms |
| a pan, being both | 202.7 ms | 23 ms |

What remains is genuine: `docBBox` at 5 ms, and the overlay's own per-node loops.

**On testing it.** A stale `d` throws nothing, so `assertFaithful` now compares
the rendered coordinates against the model rather than only counting nodes --
counting alone passes on a `d` left over from before a node moved. Disabling
invalidation kills 16 tests across two files. The source box's catch-up on
opening is the exception and is marked as such in the code: opening the drawer
resizes the canvas, which refits the camera, which notifies, which refreshes the
box, so removing the explicit call changes nothing observable. It is kept
because that chain is four unrelated components long and none of them is about
the source box.

## 30. The keyline grid is derived, not stored

Icons in a set have to share their measurements or they will not sit at the same
optical weight, and the standard set is Material's: a square reads heavier than a
circle of the same width, so the circle is drawn larger. `model/keylines.ts`
holds the ratios and nothing else.

**They are computed from the viewBox on every frame, and are not in `Doc`.** The
backdrop settled the same question the other way and for a reason that does not
apply here: an image has a position someone chose, so it has to be stored and
therefore has to be undoable. A keyline has no position anybody chose. It is a
function of the page. Storing it would create two things that can disagree, and
the disagreement would be silent, because a keyline is a reference and nobody
measures a reference to check it.

Deriving it also settles the export for free. There is no keyline in the model,
so there is no path from a keyline to a file: not a rule anyone has to remember,
just an absence.

Three decisions worth recording:

- **Ratios, not the published numbers.** Every one of Material's 24dp
  measurements is exact in thirds and sixths (20/24 is 5/6, 18/24 is 3/4, 16/24
  is 2/3), so a 24-unit canvas reproduces the grid to the unit and a 240-unit
  one scales it by ten. Hard-coding 18 and 20 would have worked on exactly one
  document size.
- **The grid is square even when the page is not.** It inscribes on the shorter
  side and centres on the page. Stretching the set to fit an 88 by 64 page would
  put the circle out of round, and a circle that is not round is not the thing
  the grid exists to give you.
- **The live area is drawn differently from the four keylines**, dashed rather
  than solid, because it is a different kind of claim. The keylines say what
  proportions to draw in; the live area says where to stay.

## 31. Guides are stored, which is what makes them different

The grid is a lattice you are given, and keylines are proportions you are given.
A guide is one line, at a position someone chose, for a reason only they know.
Everything else follows from that.

**Axis-aligned and infinite.** Not a segment, because an end is a decision
nobody asked to make and a thing to have to line up later. Not angled, because a
ruler cannot produce one and an angled guide wants a placement interface of its
own. `axis` names the coordinate the guide holds fixed, so an `x` guide is drawn
as a vertical line -- the reading that stays true when you say it out loud.

**Stored, and therefore undoable.** This is where guides part company with
keylines, which are a function of the page and so have nothing to undo. A guide
is a decision, and `Ctrl+Z` has to take it back. That puts them in the history
next to the backdrop rather than in the view switches next to the grid, and out
of `Doc` for the two reasons the backdrop is: the export is built from the model,
so a guide the model does not carry cannot reach a file; and Apply in the source
box replaces the document wholesale, which would throw guides away as a side
effect of editing the path text.

`showGuides` and `guidesLocked` stay out of the snapshot, the same as the
backdrop's switches. Undo is for taking back an edit, not for restoring a
checkbox you ticked afterwards.

**Two tiers, no new rule.** A guide is 1-D, so it answers the boundary tier.
Two crossing guides make a point, which is 0-D, so a crossing answers the vertex
tier and beats either line that formed it. Both are §27 applied to a line that
happens to be infinite, and the crossing is most of why anyone places a pair.
Within a tier the nearer target wins, so the drawing still beats a guide.

Three decisions the code would not explain on its own:

- **`moveGuide` does not merge; `settleGuide` does, on release.** Removing a
  duplicate mid-drag would splice the list under a gesture holding an index into
  it, and the drag would carry on moving whichever guide inherited the index.
  Passing over another guide is something a drag does on its way somewhere else,
  not a decision. Two in one place is allowed while the pointer is down.
- **The dragged guide is excluded from its own snap targets.** A guide lies on
  itself at distance zero, so without this the first move would pin it where it
  already is. The same trap boundary snapping hit with the two segments either
  side of a dragged node, arriving from a different direction.
- **Dropping a guide off the stage removes it**, measured against the stage box
  rather than the window, so the rulers count as off it. That makes dragging one
  back where it came from the way to put it away, and it means a press on a
  ruler that goes nowhere leaves nothing behind.

### The rulers, and one CSS trap

The rulers take two tracks of a grid on `.canvas`, and the SVGs moved into a
`.stage` cell inside it. They take space from the drawing rather than floating
over it, which is what every panel here does; with rulers off both tracks are
zero and the stage is the whole canvas again. The camera refits itself either
way, because the `ResizeObserver` watches the overlay rather than the window.

They are drawn in screen pixels, not document units, unlike everything in the
overlay. A ruler is furniture: its ticks are four pixels long at every zoom, so
a document-unit viewBox would mean dividing every length back out again.

**`align-self: stretch` does not apply to a replaced element with an intrinsic
aspect ratio, and an `<svg>` with a viewBox has one.** Left to itself the
horizontal ruler took its height from that ratio and drew a 550 px strip down
the middle of the drawing. `width: 100%; height: 100%` is the fix, and only a
browser could have found it.

Tick spacing borrows the grid's step and labels on its major lines when there is
a grid, so the numbers along the edge fall on lines drawn across the canvas. With
no grid it goes straight to the 1-2-5 ladder, which is honest because a ruler is
a measurement scale rather than a claim about snapping -- the same position the
axes take.

## 32. Smart guides do not go through the snap rule

A guide is a line you placed on purpose. A smart guide is the other half of the
same idea: the line appears because what you are dragging has just lined up with
something already on the page, and it goes away when that stops being true.

**It is not a snap tier, and adding one would have been wrong.** Every tier in
§27 maps a point to a point: the pointer is near a target, so the pointer moves.
An alignment is not about the pointer at all. It is about the *bounding box of
what is moving* agreeing with the box of something that is not, and the pointer
may be nowhere near either edge that matched. So `model/smart.ts` takes boxes and
returns an offset, and there is nothing for the priority rule to arbitrate.

It does beat the grid, on whichever axis it found something, and leaves the other
axis to the lattice. That is §27's reasoning arriving by a different road: a line
you can see beats a lattice you cannot, and here you can literally see it, because
holding the alignment is what draws it.

- **Nine candidates per axis**: each of the moving box's near edge, centre and
  far edge against each of the static box's three. Comparing only like with like
  would miss the useful case of butting one shape's left against another's right.
- **The axes are decided independently.** A shape can line its left edge up with
  one object while its middle lines up with another, and reporting a single best
  match would silently drop one of them.
- **The page is a static box.** An icon is drawn to a canvas, so its edges and
  its centre are the alignments wanted most often, and no other shape can offer
  them.
- **The moving box is frozen at the press**, like the transform box's. Recomputed
  each frame it would be the box of what is already moving, so an alignment would
  be measured against the answer it had just produced.
- **The line spans both boxes**, so it says what lined up with what. One covering
  only the shape being dragged leaves you guessing which of four it agreed with.
- **Ties need beating by 1e-9 to change the answer.** Not a tolerance on the
  geometry: a box at 0.2 whose far edge is at 10.2 is exactly 0.2 from an edge at
  0 and 0.19999999999999929 from one at 10, so a strict comparison let binary
  representation decide which line got drawn.

Only body drags are covered. Creating a primitive and scaling a selection are
both alignments someone would want and neither is wired up.

## 33. Angular snap, and naming what claimed the pointer

The grid gives positions and rays give directions, and the second is not
expressible as the first. A 45-degree chamfer, an isometric box, a star with
twelve arms: each is easy with rays and fiddly with a lattice.

Taken from IPE, which sets an origin, a base direction and a step. Two
differences:

**A ray is 1-D, so it answers the boundary tier** rather than becoming a mode
that overrides everything. §27's rule applied, and it has the property worth
having: an angle you set once still loses to a vertex you can see.

**The origin can be implicit.** IPE makes you place it. Most of the time the
origin wanted is where the gesture started -- the node being dragged, or the
pen's last point -- so the controller supplies that when none is set, and an
explicit one takes over when there is. With neither, and nothing being drawn,
there are no rays at all: a fan radiating from a point nobody chose would be
worse than none.

Two smaller things. The nearest ray is found by rounding the point's own angle
to the nearest multiple, which is also what keeps the projection in front of the
origin rather than behind it. And `rayAngles` walks until it has gone round
rather than computing `360 / step`, because a step that does not divide 360 is
legal: 7 degrees gives 52 rays and a final gap of 4.

### The readout names the fact, not the rule

Six things now answer three tiers: nodes and guide crossings and keyline anchors
at 0-D; outlines, keylines, guides and rays at 1-D. `SnapResult` carries a
`via` alongside its `kind`, and the status line reads the `via`.

The tier is the rule and the `via` is the fact. `on an outline` while the
pointer sits on a 45-degree ray is a true statement about the tier and a false
one about the drawing, and a status line naming a thing that is not there is
worse than one that says nothing. Each of the six has its own words.

## 34. Intersection snap, and why it is subdivision

Two outlines crossing make a point, so it answers the vertex tier beside anchors
and guide crossings. Getting the point is the whole problem.

**By recursive subdivision on the control hulls, not algebraically.** A cubic
against a cubic is a degree-9 system, and the closed forms for it are unstable
near tangency -- which is exactly the case that matters, because two curves that
nearly touch are two curves someone is trying to snap to. Subdivision has no
such cliff: a Bezier lies inside the box of its control points, so two boxes
that do not overlap contain no crossing, and halving until the boxes are under
the tolerance converges at the same rate whatever the angle between the curves.

The cost is that a tangency reports a cluster rather than a point, which is why
the results are merged at the end.

**Bounded by a work budget, not by depth.** Depth is the obvious choice and it
is wrong: each level halves *one* of the two curves, so a depth of 24 gives each
of them only twelve halvings, which on a ten-unit curve stops at 0.0024 -- twenty
times coarser than the tolerance asked for. It stopped there silently and
reported four points where there was one. Counting calls instead bounds the work
whatever the geometry does, including two curves lying on top of each other,
which overlap at every subdivision and would otherwise branch exponentially.

**Pruned twice before any real work.** Only segments whose hull comes within
reach of the pointer can hold a crossing near the pointer, so one linear scan
collects those and only pairs from that short list are intersected. Measured on
2 400 segments: a hover costs 0.24 ms with crossings off and 0.35 ms with them
on, over the busiest part of the drawing. That is why it is affordable, and it
is also why it has its own switch -- it is the one target computed rather than
looked up, so it is off unless asked for.

Two decisions that are not obvious:

- **Segments sharing an endpoint are skipped.** Every pair of neighbours meets
  at the node they share, and that node is already a vertex target. Reporting it
  again would put a second, worse-named answer on top of a better one, at every
  node of every closed path.
- **The switch works on its own.** Crossings were first computed inside the
  `toPoints` gate, which made `Snap to crossings` silently do nothing unless
  `Snap to points` was also on: two switches where one quietly required the
  other, which reads as a broken switch.

The hull prune has no behavioural signature -- with it or without it the same
crossings are found -- so nothing tests it. That is recorded rather than papered
over with a timing assertion that would be flaky.

## 35. Auto-smooth is the one stored node flag, and §6 still holds

Inkscape's fourth node type: handles that re-derive themselves from the
neighbours, so moving one node of a curve re-aims the two either side and the
shape stays fair without anyone dragging six handles to keep it that way.

§6 argues at length that node state must never be stored, and this stores some.
The exception rests on a distinction rather than an excuse:

| | |
|---|---|
| A stored `smooth` flag | A **claim about the geometry**. Checkable against the handles, and therefore able to disagree with them -- which is what happened in every editor that has one, and why continuity is derived here |
| `auto` | An **instruction about the future**. "Keep recomputing me when a neighbour moves" is not something any arrangement of control points can express, so there is nothing for it to disagree with |

It is never exported. A file has no way to say it, and reading one back gives
ordinary handles sitting exactly where the auto node had put them.

**The sweep is whole-document, not targeted.** `Controller.edit` runs
`reflowDoc` on the way out of every edit it makes. The targeted version -- update
the node that moved and its two neighbours -- means every operation that could
disturb an auto node has to work out which indices it touched: moving one,
deleting one, inserting one, reversing a path, fusing two, applying a boolean.
Getting that wrong leaves a stale handle, which reads as a rendering bug rather
than a missed call. The sweep skips a node in one comparison and walks nodes that
are about to be walked to redraw anyway.

Three decisions:

- **Taking hold of a handle hands control back.** Without it the drag would be
  undone by the sweep at the end of the same edit, and nothing on screen would
  say why.
- **Turning it off keeps the handles.** What you had is what you carry on
  editing; the only thing that changed is that it stops moving on its own.
- **Losing a neighbour drops the flag**, rather than leaving it dormant to fire
  when one reappears -- long after anyone would connect the two.

The handle direction is the chord between the neighbours, which makes the node
smooth by construction, and each handle reaches a third of the way to its own
neighbour rather than to an average of both. Separately, because on an uneven run
a shared length puts a bulge on the short side.

## 36. Find in source, and why the offsets are an out-parameter

Pointing at a node on the canvas is free. Finding it among forty commands of a
`d` attribute is not, and that asymmetry is the whole feature.

**Only the serialiser knows where it put things.** The spelling of a command
depends on shorthand detection, on whether relative form came out shorter, and
on how the numbers rounded -- so an offset computed by anyone else would be a
re-implementation that agrees until it does not. `serialisePath` therefore takes
an optional `marks` array and fills it with `{sp, i, start, end}` per node.

**An out-parameter rather than a second return value**, so the overwhelmingly
common caller -- every render, every export, every keystroke in the source box --
pays nothing for a feature only one button uses. The same string comes back
either way.

Three details worth keeping:

- **Subpaths are numbered by their place in the model, not in the output.** A
  subpath of one node emits nothing, and numbering by emitted order would shift
  every subpath after it. The marks address the model.
- **The closing node of a closed path gets its `M`.** `Z` arrives nowhere new,
  and node 0 was placed by the `M`, which is the command a person would point at.
- **The button forces path-data mode and scopes to one shape.** The offsets are
  true of exactly the string the serialiser returned, and in SVG mode that string
  sits inside a document with attributes and other shapes around it. Asking for
  the one form whose offsets can be trusted is honest; tracking the embedding
  would be a second thing to keep in step.

## 37. Keyboard completeness was a selection problem

"Every operation reachable without the mouse" was on the list as partway done,
with nothing recorded about which way. `tools/keys.mjs` is that survey: it walks
the tab order in each inspector tab, with a shape and a node selected so the
panels are live, and reports every enabled control it never reached.

**It reports none.** Every live control in the interface is reachable by Tab.
The first run said 36 were not, which was the survey measuring the wrong thing:
a disabled control is legitimately not focusable, and with nothing selected most
of the Node panel is disabled. It now separates "live and unreachable" from
"disabled throughout and so not surveyed", and only the first of those is a
finding.

**The real gap was upstream of every button.** Every control in the Node panel
acts on the selected nodes, and the only way to select a node was to click it.
So the panel was pointer-only however tabbable its buttons were, and no survey
of controls could have found that, because nothing was wrong with the controls.

`[` and `]` walk the selection along the path, `Shift` extends, `Shift+I`
inserts a node in the selected segment. Three details:

- **The step is taken from the last node added**, not the lowest index, so a run
  of presses keeps walking from where it just arrived. Re-adding a key moves it
  to the end of the `Set`, which is what makes that work.
- **Stepping wraps on a closed path and stops at the ends of an open one**,
  because that is what the path does: there is no node past the end of an open
  path to step to.
- **Shift arrives as a brace.** The browser reports the shifted character, so
  the extend form is `{` and `}` and never a bracket. The first version stepped
  instead of extending, which looked like the modifier being ignored.

All three have buttons as well, which is the touch rule in `CLAUDE.md` as much
as the keyboard one.

## 38. A focus tooltip follows a scroll; a hover tooltip does not

**Correcting a finding from the review of 2026-08-13.** That review recorded the
`chrome` scenario's local failure as "not a defect: the harness browser is not
delivering the event to a 13 px target". That was wrong, and it was concluded
twice from the same weak evidence -- a synthetic `pointerover` worked, so the
handler was assumed sound. The review stays as written, per the rule in
`docs/reviews/README.md`; this is the reversal.

The defect: focusing a control that is below the fold scrolls the panel to bring
it into view, and `scroll` was wired straight to `hide`. The scroll arrived
before the tooltip's own timer fired, so tabbing through a panel described
whatever was already on screen and nothing else -- which is most of it. A
keyboard user got descriptions for the top of each panel and silence below.

The fix is that the two kinds of tooltip want opposite things from a scroll:

| | On a scroll |
|---|---|
| Shown by hover | Goes. The pointer was over something, and after a scroll it is over something else |
| Shown by focus | Follows. The anchor is still focused and still where the description belongs |

**Why CI passed and one machine did not.** Whether `#pixelFit` needs scrolling to
reach depends on the window size, so the check passed or failed by luck. The
scenario now blurs, scrolls the panel to the top, and focuses a control at the
bottom of it, which forces the scroll on any window. With `scroll` wired back to
`hide` it fails.

## 39. Offset path: sample the offset, let the fitter do the rest

The exact offset of a cubic is not a cubic -- degree 10 in general -- so every
editor approximates and the only question is how. This samples the true offset
and fits cubics through the samples, which works here because of one property:

**An offset curve is parallel, so it shares its original's tangent direction at
every parameter.** `core/fit.ts` takes the end tangents as inputs rather than
guessing them, so both ends of every run come out at exactly the right angle and
the fitter is left with only the middle. It subdivides on its own when it cannot
hit the tolerance, so the error control was already written. Measured: a circle
of radius 20 offset by 5 at a tolerance of 0.02 is within 0.042 everywhere, in
ten nodes.

Two details. The whole subpath is sampled and fitted **in one go** rather than
segment by segment, so the fitter chooses where the curves break instead of
being forced to break at every node, where the offset has no feature at all. And
`tangentAt` looks either side of the parameter when the derivative vanishes,
because a cusp has no tangent to take a normal from and the curve still has a
direction of travel there.

### The overrun, and the rule that settles it

On the inside of a corner the two neighbouring offsets run past each other, so
the raw offset doubles back. **Chen and McMains (2005) settle what to keep: the
invalid parts of a raw offset bound regions of non-positive winding number.**
The local form of the same statement is a distance, and that is what is
implemented: a raw-offset point lies on the true offset exactly when it is `|d|`
from the original, because anything nearer is inside the disc swept along the
curve and so is not on the boundary of the swept region.

**The filter runs on the samples, before fitting.** Fitting first and trimming
after was tried twice and neither worked, for a reason worth keeping: a curve
fitted through a sequence that doubles back does not merely loop, it leaves the
offset altogether, so by then there is nothing left worth trimming. What was
tried, and why each failed:

- **`booleanShapes`** needs two operands, and uniting a self-crossing path with
  a copy of itself puts coincident edges everywhere, which throws inside
  path-bool.
- **Splicing out the self-crossings** with `cubicIntersections`. The version
  written skipped adjacent segments, which is exactly where a polygon overruns;
  including them still left a stray piece at the original corner, six units out
  on a six-unit offset.

Three things follow from filtering samples:

- **Runs meet at a computed corner**, not at whichever sample survived. The
  filter cuts up to one sample spacing short, and a corner short by that much is
  a corner the path does not close through. Consecutive runs are put on the
  crossing of the directions they arrive and leave at.

  **Bisecting the filter's own criterion instead does not work, and the reason
  is the criterion rather than the search.** The obvious replacement for that
  extrapolation is to hunt between the last surviving sample and the first
  casualty for the place the offset actually stops. It was built and measured
  and taken back out. The criterion is asked once per sample and there are
  thousands, so it is answered by `NearMap` -- the nearest of a polyline's
  points, which overstates a distance by up to half a step -- and slackened by
  the fit tolerance on top. Bisecting that lands the end past the corner by the
  slack divided by the sine of the half angle: the square inward went from
  0.001 out to 0.031. Bisecting an exact projection instead fixes that one and
  breaks a worse thing, because it no longer agrees with the cheap criterion
  about which samples were kept. Eight of the star's run ends were already
  inside the strict distance, so there was nothing to bisect from, they could
  not be found to meet, and a shape that is one contour came back as four --
  taking `strokeOutline` to null with it. Making the filter exact as well is
  what `NearMap` exists to avoid.

  The extrapolation has neither problem: it reads only the samples that
  survived, so it cannot disagree with the filter, and for a corner between two
  straight branches it is exact rather than approximate.
- **The result is a list of subpaths.** Two runs that do not meet are not a
  corner; the offset has come apart, which happens whenever a shape cannot hold
  the distance asked of it. Returning one path with a segment across the gap was
  what this did, and it measured 6.8 out on an 8-unit offset.
- **The grid cell is the query radius.** `NearMap` answers "is anything nearer
  than this", and sizing its cells by the tolerance instead made each query scan
  eighty-one cells rather than nine: 700 ms an offset, against 6 ms.

What this bought, measured:

| | Before the filter | After |
|---|---|---|
| Square inward by 4 | 4.0 out | 0.0006 |
| Notched shape inward by 8 | 6.8 out, one path | 1.14, two paths |
| Square outward by 4 | 0.0195 | 0.0195 |
| An offset that consumes the shape | a sliver | nothing, which is the answer |

**The last of the error was in the measurement, not the geometry.** `NearMap`
used one number for its grid cells and for its polyline: sizing cells by the
query radius made queries cheap and, with it, made the source coarse -- a
forty-unit edge got seven points along it, so a point well inside the offset was
reported as outside because no sample happened to be near enough. The deviation
sat at exactly 1.1349 through three attempts to fix the geometry, and that
constancy is what finally said the geometry was not what was wrong. Cell size and
sample step are separate arguments now.

**A closed offset is a ring, and the seam is not a place.** Filtering cuts the
samples into runs, welding corners cuts the runs into pieces, and both are the
same operation: split a ring at the places something broke it. Each had been
written out separately, ending with a repair that took the first result and sewed
it onto the last. `ringRuns` does it once, by starting the walk just after a
break, so no run can straddle the join and there is nothing left to sew.

**What the seam repairs were hiding.** The two ends of a closed offset are the
seam rather than a feature, so the fitter is handed the original's tangents
there. Whether that applies was inferred from the shape of the result -- one run
in one group -- and that is a different claim from the one it needs, which is
that the filter took nothing. They part company when the filter does cut and the
offcut is too short to keep: one run in one group, and tangents describing a
seam that is now a trimmed corner. The notched shape offset outward is exactly
that case, and it came out with a cusp at the tip, 0.059 against 0.012
everywhere else on the same shape, on a node the model read as smooth because
its handles were collinear while the outgoing one pointed back the way the curve
had arrived. Read off the ring instead -- nothing was filtered -- and the node is
a corner and the error is 0.02.

The trim was never in the wrong place: the notch tip's bisector at
`8 / sin(33.7°)` = 14.42 is where the node sat all along. It was the tangent that
was wrong, and no distance measure can see a tangent.

## 40. Stroke to path is two offsets and some bookkeeping

Everything hard is in §39. What is left is which contours come back and how they
are joined:

- **A closed path gives two contours**, not one. The outer offset and the inner
  one bound a ring, and a ring is two loops wound in opposite directions, so the
  inner comes back reversed. One loop would be a filled disc.
- **An open path gives one contour**: out along one side, round the far end, back
  along the other, round the start. The two crossings are the caps.
- **The result replaces the original** and is filled with what the stroke was
  coloured, because the outline *is* the stroke. Under `evenodd` a closed path's
  two contours read as a band.
- **The width comes from the shape's own style**, not from a field. Asking for a
  number would let you convert a 1-unit stroke into a 4-unit outline and call it
  the same drawing.
- **It refuses when either side comes apart.** An offset that breaks into pieces
  has no single other side to pair each piece with, and guessing which piece
  answers which produces a shape nobody could predict.

The one subtlety is which way a round cap turns. The two ends of a cap are
exactly opposite, so the sweep between them is half a turn and its sign is a coin
toss; the wrong toss puts the cap back over the stroke, and the drawing still
reads as a stroke until you notice the ends are dented. The sense that agrees
with the direction the outline arrived in is the right one.

**What the tests pin down, and what they do not.** Taking the sweep's absolute
value and ignoring the direction passes every fixture here as well; leaving the
raw normalised difference fails one. So these fixtures establish that the sign
must be forced, and not which of the two ways of forcing it is correct. The
direction of travel is the one with a reason behind it, so it is the one kept,
and this paragraph is here so nobody reads the tests as saying more than they do.

## 41. The inspector was heavy with prose, not with controls

Measured before it was changed, because "feels busy" is not something to act on
directly. The rail held **19 group headers, 131 controls and 1 014 words** of
explanation in a 288 px column, and the Document tab alone held 9 groups and 543
words.

**The Node tab was the control in the experiment.** Four groups, 35 controls, 81
words -- almost as many controls as Shape and a fifth of the prose -- and it did
not feel busy. That is what said the problem was not control count.

Two changes, and the second is the one that pays:

- **One line per group instead of a paragraph.** Every note restated something
  `docs/manual/reference.md` already says at length, read once and skipped
  forever, in the space that made the controls look crowded. 1 014 words to 210.
- **Groups collapse.** Independent toggles, not an accordion: the snapping aids
  are used together -- that is the point of them being separate tiers of one
  rule -- so shutting Grid every time Guides opened would be the interface
  arguing with the feature.

**Collapsing improves the keyboard rather than costing it.** A shut group uses
`hidden`, which takes its controls out of the tab order as well as off the
screen, so it costs one Tab stop instead of however many controls it holds.
Reaching the Output group used to mean tabbing past all 58 Document controls.
`tools/keys.mjs` opens every group before it walks, because a person reaches a
shut group by tabbing to its header and pressing it, and it still reports no
live control it cannot reach.

Two details worth keeping:

- **Defaults are the whole design.** Everything shut is an empty rail and
  everything open is what was there before. The groups that act on the current
  selection open -- Shapes, Style, Node -- and the rest are shut. File is the one
  exception, and §58 says why: it acts on no selection, and it is where the
  drawing leaves the editor.
- **A shut group has to say what it is doing.** The header readouts already did
  that (`every 45° · origin free`), which is what makes collapsing safe rather
  than a way to lose a control. They were the densest useful thing in the panel
  before this and they are what carries it now.

Which groups are open is session state: not in the store, not in the history,
and not persisted across a reload, because nothing else in this editor is and
one thing that was would be a surprise.

The proposal this came from also suggested splitting the Document tab in two. It
is not done, and on the evidence it may not be needed: nine collapsed groups
occupy 454 px, which is a third of the rail.

## 42. Touch is three answers, and the third is the awkward one

The three questions a finger asks are: can I hit the control, can I move the
view, and can I hold the key. The first two have clean answers. The third does
not, and pretending otherwise would have hidden the compromise.

**Size is one variable.** `--h` is where nearly every control takes its height,
so a `@media (pointer: coarse)` block raises it, and after it a short list of
controls that size themselves: labels holding a 13 px checkbox, segmented
buttons that subtract two pixels of border, the tabs, the group headers, the
status strip and the rows of the shape list. Asked by pointer rather than by
width on purpose. A coarse pointer is a finger or a stylus and never a mouse,
where a narrow window is often a mouse in a small window; and applying 44 px to
every pointer would add roughly 2 500 px to a 288 px rail.

**The pinch is one gesture, not two.** Spreading the fingers zooms about the
point between them and moving that point drags the drawing with it, and the
order is what makes it feel attached to the hand: the zoom is taken about the
document point under the *old* midpoint, which leaves that point where it is on
screen, and the pan is then a screen distance at the new scale. Taken about the
new midpoint the drawing moves twice.

A pointer event carries one pointer, so two fingers moving arrive as two events
and never as one. Between them the fingers sit at a distance neither started nor
ended at, and the camera passes through a zoom the next event undoes. The
invariant that survives this is per event, not per gesture: whatever was under
the midpoint is still under the midpoint. That is what the tests assert, and an
arithmetic identity across the whole gesture would hold only for fingers moving
in perfect step, which no hand does.

**The second finger abandons what the first started**, which is not a nicety.
The first press lands before there is any way to know a second is coming, so it
starts a drag on whatever it hit and may already have moved a node. Rolling that
back is visible. Closing its history batch is not, and it is the half that
matters: a batch left open makes `checkpoint` return early for the rest of the
session, so nothing is undoable again and nothing says so.

**Modifiers are the compromise.** Seven pointer gestures change meaning under
Shift or Alt: adding to the selection, keeping a scale's proportions, snapping a
rotation to 15°, drawing a square or a circle, scaling from the centre, breaking
a handle pair, and bending a segment freely. Three have equivalents in the rail
already, as numbers rather than gestures, and four have nothing. Two latching
buttons in the status strip stand in for the keys, read by `Controller.shift`
and `Controller.alt` beside the real event rather than instead of it.

They stop at the pointer deliberately. The keyboard handlers still read the
event, because `Shift` there is the second half of a shortcut: a latch that
reached them would turn every arrow key into the coarse nudge, ten times the
fine step, for as long as it was on. A latch is a mode, and this is the argument
for keeping the mode as small as it can be rather than for it being free.

**Where they live is a measurement, not a taste.** At 390 px the toolbar holds
858 px of controls and the status strip 729 px, so both scroll, and anything not
pinned is a control that exists and cannot be pressed. The panel toggles are
pinned at the right of the toolbar and the held keys at the left of the strip,
because those are the two things you reach for while something else is already
happening on the canvas.

## 43. A node is a thing, not a position in an array

The selection used to name a node by `shape/subpath/index`. Every operation that
removes a node moved the meaning of every index after it, so the name outlived
what it named and started naming its neighbour.

No caller could ignore that, and no two of them agreed on what to do about it.
Splitting a segment rebuilt the selection to the index the split returned.
Seventeen sites threw the whole selection away rather than work out which part
of it had survived. One walked the selection and deleted whatever no longer
resolved. `reverseSelection` carried a remap -- index `i` became `n - 1 - i` in
an open subpath and `n - i` in a closed one -- purely so the highlight would not
drift off the nodes it was on. Twelve `if (!n) continue` guards stood behind all
of it, in `ops.ts` and `controller.ts`, catching whatever still got through.

The model already held the argument against itself. `knots.ts` tracks the nodes
it keeps as node objects, and says why in its own comment: "rather than
re-deriving indices it would have to keep correcting".

So `PathNode` carries an `id`. `cloneNode` preserves it, which is what makes a
selection still mean the same nodes after an undo, and nothing writes it to a
file: it is identity within one session, not a name for the geometry.

What changes is the failure mode. A stale id resolves to nothing, and nothing is
a case worth handling. A stale index resolved to whichever node had moved into
its place, and that is not a case anybody wrote code for.

`resolveNodes` walks the document once and returns positions in document order.
A `NodeRef` is now explicitly a position -- true when it was read, wrong as soon
as anything splices the array it indexes. Resolve one, use it, discard it.

The remap in `reverseSelection` is gone, because reversing an array moves nodes
about without changing which node is which. One sweep for dropped ids remains,
where the pen discards subpaths too short to draw: `selection.nodes.size` is
read directly as "how many are selected", and a ghost would be counted.

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

**Stroke to path refuses when an offset comes apart.** A stroke wider than the
shape can hold has no single other side to pair each piece with. See §40.

**Touch has never been held.** Every claim in §42 was measured in a headless
browser with synthetic touch events, which prove arithmetic and say nothing
about a hand. Unknown: whether 44 px is enough at the rail's density, what the
on-screen keyboard does to the layout when a number field takes focus, whether a
one-finger drag on a node is precise enough to be worth having, and whether a
latching modifier reads as obvious or as a mode you forget you are in.

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

### What a suite passing does not tell you

Everything above is about a single test being able to pass for the wrong reason.
Two failures found on 2026-08-14 were a level up from that: whole layers that
could not report a failure at all.

`tools/drive.mjs` caught every scenario error into a field of the JSON it
printed and never set an exit code, so the browser job could only go red if the
browser failed to launch. Underneath that, thirteen of the 43 scenarios never
asserted anything — they drove the editor, read the page and returned what they
found. Fixing the exit code made the suite able to fail; it took the second pass
to make it measure. `node tools/drive.mjs --audit` refuses a scenario that never
calls `check`, and CI runs it first.

That check is deliberately weak. Calling `check` does not show that a scenario
measures the right thing, and no machine can settle that. Never calling it shows
the scenario measures nothing, and a machine can settle that, so it does.

`tools/mutate.mjs` answers the same question for the unit suite by experiment
rather than by inspection. It changes one operator in the source — a `<` for a
`<=`, an `&&` for an `||` — runs the tests that import the file, and puts it
back. A mutation the suite catches says nothing. A survivor is a change to what
the program does that no test disagreed with.

Not every survivor is a missing test. A guard the caller already makes true, or
a bound nothing can reach, is an equivalent mutant: the program's behaviour did
not change, so no test could have noticed. Reading them is the work; the tool
only finds the candidates.

Its own first version could not report a finding. `--silent` swallowed the
filename, vitest exited 1 on a command line it could not parse, and every
mutation scored as caught, so it reported a clean sweep having measured nothing —
the exact failure it exists to detect. An unmutated baseline run now settles both
halves of that before any result is believed: that the invocation is one vitest
accepts, and that the tree was green to begin with.

`offsetSubpath` is the measured example, and reading its survivors is what shows
why the count on its own is not the finding. Twenty-nine of its 92 operators
survived every test that imports the file. Applying each one and looking at what
it did to thirteen shapes -- piece count, closedness, node count, corner count,
length, bounding box, deviation -- moved nothing at all for twenty-two of them.
Those are equivalent mutants, and several are equivalent because the routine
guards the same condition twice: `usable` is filtered to runs of two points or
more and then both operands are checked for two points or more, so neither
comparison can go the other way. The real gap was seven, and the number that
looked like a third of the file was mostly the tool finding its own noise.

`--apply N` exists for that reading. A survivor is two different findings
wearing one word -- a missing test, or nothing to disagree with -- and the tool
cannot tell them apart, so it hands over the number and lets a person look.

Four of the seven are closed. What closed them was not a distance:

- **How many pieces come back.** Cutting an open path that turns sharply into
  two or three passed everything, because each piece is parallel and that is all
  a deviation measure asks. The suite had no open path with a sharp turn in it.
- **How long the result is.** An offset that stops early is parallel for its
  whole length. Four fixtures have a circumference arithmetic can supply, so
  the expected number is derived rather than recorded from a run.
- **Which nodes are corners.** A circle offsets to a circle and has none; a
  square offset inward has exactly four. A wrong tangent at a seam moves neither
  the position of any point nor the distance to the original.

The other three were not a missing test at all. They were the seam cusp above,
and what closed them was fixing it: the ring representation retired the
inference they lived in. Two survivors are left of the 26 across the rewritten
machinery, and neither is a correctness gap -- a whole ring fitted from two
samples along, and a hundredth of a unit of deviation at the end of a run. Both
would have to be pinned by asserting a node count or a tolerance, which is the
approximation-encoding this file's tests exist not to do.

**The count went up while the gap closed.** 29 of 92 before, 26 of 87 after, and
the seven that meant something became two. A survivor count is a population of
candidates, not a measurement, and the two numbers are not comparable without
reading both populations.

## 44. A gesture and a command are different things

`controller.ts` held both, and at 3,808 lines with 54 public members it was a
filing cabinet: the value of a module is what it does over what you must know to
use it, and 54 is most of what there was to know. The 2026-08-15 structure
review ranked this fifth of five, as shape rather than defect, which is what it
is.

**The line is what the thing is, not what it touches.** A gesture has a
beginning, a middle and an end: it captures the pointer, opens a history batch,
mutates on every move and closes the batch on release. A command either happens
or is declined with a reason. Nothing else separates them cleanly -- both read
the selection, both edit the document, both report to the status line -- and any
boundary drawn on those would have cut through the middle of both.

Measured before it was moved, the split was already there. Of 44 command
members, exactly two reached into gesture machinery: `applyTrace` asking whether
a drag was live, and `fuseSelection` calling a private helper only it used. The
rest touched the store and nothing else.

| File | What it is | Public members |
|---|---|---|
| `controller.ts` | Pointer gestures on the canvas | 14 |
| `commands.ts` | What a button or a key does to the document | 45 |
| `keys.ts` | Which of those two a key reaches | 1 |

**They are peers, and `main.ts` holds both.** A `Controller.offsetSelection`
forwarding to `Commands.offsetSelection` would be a layer that changes no
vocabulary, which is the definition of one not earning its place. The one fact
that genuinely crosses is whether a drag is under way, and it arrives as a
`busy` predicate in the constructor rather than as a back-reference.

**The keyboard is the third peer, not part of either.** It was the reason a
split looked impossible: `onKeyDown` calls fourteen commands *and* aborts drags,
so leaving it in `Controller` would have made the two objects reference each
other. It is wiring -- `Delete` and the `#del` button are the same operation
reached two ways -- so it belongs beside the button wiring, and now sits one
import away from it. `test/controller.test.ts` reads its source to check that
every capital the switch handles appears in the mid-drag refusal list, which is
the drift this arrangement is meant to make visible.

**Two facts moved down rather than sideways.** The auto-smooth sweep was a
private `Controller.edit` wrapper, so it protected only the callers that went
through `Controller`; it is now inside `Store.edit` and `Store.tryEdit`, where
no edit can skip it. `selectedNodes` and `selectedSubpaths` are pure functions
of a document and a selection, wanted by both halves, and are now in `doc.ts`
beside `selectedRefs`.

Nothing observable changed: 783 unit tests, 43 of 43 browser scenarios, and a
build within a kilobyte of the one before.

## 45. The tooltip did not need rewriting; it needed something that could fail

One reviewer of the 2026-08-15 structure review read `tooltip.ts` and concluded
it wanted a rewrite. The review declined to judge that, calling it a design call
rather than a defect, and the reading here agrees for a stated reason: **"this
should be rebuilt" is a claim that needs a specific complaint attached, and
nobody had one.** 206 lines is not a complaint. Six module-level variables for a
single overlay is not a complaint either.

The complaint that *is* attachable is about evidence. The file records six
behaviours in its comments that were each once wrong, and every one of them was
found by hand. Three had a check afterwards and three did not:

| Behaviour | Checked before |
|---|---|
| The `title` is adopted, so the native tooltip cannot show underneath | Browser scenario |
| A trailing parenthesis becomes a key cap | Browser scenario |
| A `<label>` resolves to its control, so a screen reader gets the description | Browser scenario |
| A focus tooltip follows a scroll | Browser scenario |
| A hover tooltip goes on a scroll | Nothing |
| Only the described element can dismiss its own tooltip | Nothing |
| The position is clamped on **both** axes | Nothing |

The last three are now `test/tooltip.test.ts`, along with the delay split --
focus shows at once, hover waits, and neither had a check either. Ten tests, and
each was watched failing: the clamps by removing each `Math.max`, the dismissal
rules by widening `out`'s containment test, the scroll split by wiring
`onScroll` to one answer for both kinds, the delay by fixing `wait` at each end.

**They are unit tests and not scenarios because of what they need.** A clamp is
only measurable against a window small enough to hit it, and a real browser is
one viewport per run. jsdom is a different one per test, which is what turns
"off the top of the screen" into `y < GAP` and nothing else.

The one code change is that the keydown listener is now a named function like
the other six. It was an arrow, which the DOM cannot dedupe, and the `installed`
guard covered for it -- so the guard now says one thing that is true of all
seven rather than covering an asymmetry the next reader has to rediscover.

## 46. One clone, two meanings, and only one of them mints an identity

`cloneShape` and `cloneNode` carry `PathNode.id` through, deliberately, for the
reason §43 gives: that is what makes a selection still mean the same nodes after
an undo. Both are also what an operation reaches for when it needs a second copy
of a shape to live in the document beside the first, and there the same
behaviour is a bug. Nothing in either signature says which of the two you are
doing.

The failure is quiet, because the document is well formed. An id naming two
nodes is two nodes `resolveNodes` cannot tell apart: it finds a node by walking
every shape and matching on the id alone, so a selection naming one names both.
Three places had it.

| Where | What it produced |
| --- | --- |
| `Duplicate` | A copy whose every node answered to the original's id |
| `breakAt`, closed | Two ends of one opened path, sharing one id |
| `breakAt`, open | The last node of the head and the first of the tail, sharing one id |

All three read as the drawing having a mind of its own rather than as an identity
collision. Clicking one anchor of a duplicate highlighted the matching anchor of
the original, and dragging it moved both shapes. Breaking a closed path put two
ends where there was one, and neither could be pulled away from the other,
because a drag on either moved both -- so the operation looked like it had done
nothing at all.

**The fix is a second function rather than a change to the first.** `reidentify`
in `model/doc.ts` gives a shape and every node in it fresh ids, and the two
halves stay separate on purpose: folding the minting into `cloneShape` would
break history, which is the one caller that must not have it. So the rule is
about the destination, not the operation. A copy going into a history snapshot
keeps its ids. A copy going into the live document is reidentified.

`breakAt` mints one id rather than calling `reidentify`, because only one of the
two ends is a node that was not there before. The front keeps the original id, so
a selection naming the node before the break still names something after it.

**What holds the rule is `test/identity.test.ts`**, which asserts the invariant
directly -- no id names two nodes -- over each operation that puts a copy into
the document, and asserts the symptom beside it, because the invariant can hold
while the document is still wrong in some other way. The symptom needs a real
drag to show, so `clipboard` in `tools/drive.mjs` grabs one anchor of a copy and
counts how many paths moved. Both were watched failing: the unit tests against
each of the three sites in turn, the scenario against `reidentify` with its
minting loop removed.

The clipboard is where this was found, on the way to building it. It holds
shapes, not text, and it is not in the store: undoing a paste must not empty it,
and copying is not something to undo. That also means it does not reach other
programs, which is what the source drawer's **Copy** is for.

## 47. A path is a row in the list and not a kind of selection

Reported from use: two disjoint paths in one shape, and the shape list showing one
row, one name and one number. Nothing on screen said the shape held two paths, so
the reasonable reading was that the editor had put unrelated things together and
ought to have made a group.

**It had not, and a group would be wrong.** A shape is one `<path>` on export, and
the paths inside it share one fill, one stroke and one fill rule. That sharing is
load-bearing rather than incidental: an `evenodd` hole is two contours in *one*
path, and there is no arrangement of two shapes that draws it. `Unite` on two
disjoint shapes returns two contours by the same argument -- the union of two
regions is one region, whether or not it is connected -- and `test/boolean.test.ts`
has held that since the booleans were written.

So the model was right and the list was hiding it. `Split into shapes` had existed
the whole time, and you cannot look for it if you cannot see that you need it.

**The list is a tree.** A shape holding more than one path carries a disclosure and
reads `2 paths` where a single-path shape reads its node count; opening it lists
the paths, each with its own node count and whether it closes.

**What a path row selects is its nodes.** `Selection` stays two sets, shapes and
node ids, and nothing was added to it. A third kind -- selected subpaths -- would
be a second place the same fact lived, and the two would disagree the first time a
node was deleted out of a selected path. Every operation that works on whole paths
already reads them back out of the node selection through `selectedSubpaths`, so
Reverse, Circularise, Simplify and Offset became reachable per path with no change
to any of them. The row reads its own state back the same way, which is why
selecting a path's nodes on the canvas lights its row.

Which shapes are open is not in the store, for the reason the open panels are not:
undo has no business shutting a disclosure.

**The `data-id` collision is the part worth knowing before editing this.** A path
row is nested inside its shape's `li` and carries the same `data-id`, because it
needs to name the shape it belongs to. So every handler on the list has to test
`data-sp` before `data-id`, or the shape branch claims presses meant for a path.
Three handlers do: click, double-click, and the arrow keys. `shapeTree` in
`tools/drive.mjs` fails on each of them separately.

Groups are still absent, and this does not add them. `<g>` is flattened on import
with its transforms baked in (`io/svg.ts`), so grouping made in another tool does
not survive a round trip.

## 48. A corner's radius is recovered, never stored

Asked for: Illustrator's live corner widget, a handle just inside a corner that
rounds it as you drag. The geometry was already here -- `roundCorner` has built a
true fillet, tangent to both sides, since the rectangle tool needed one -- so what
was missing was the handle. The design question is the interesting part.

**Illustrator's widget is available forever because Illustrator keeps a live
rectangle.** Its corner radius is a property of an object that has not been reduced
to a path yet, so the widget can read it back whenever it likes. Here everything is
a path from the moment it is drawn, which is §2, and there is no object to hang a
radius on.

The obvious answer is to store one: a `radius` on `PathNode`, or on the shape. It is
the wrong answer, and for the reason §43 gives about node indices. A stored radius is
a second statement of something the geometry already says, and the two disagree the
first time anything else moves one of the arc's nodes. The path would then be
carrying a claim about itself that is false, with nothing to detect it.

**So it is recovered.** A fillet's two tangent nodes carry exactly one handle each,
and each handle points along the side it came from -- which means both handle rays
pass through the corner the fillet was cut from. The corner is where they cross, the
cut is the distance to it, and the radius is `cut * tan(alpha / 2)`. Nothing is
stored and nothing can disagree.

`filletAt` does that recovery, and it *measures* rather than assuming. Two nodes with
one handle each are not necessarily a fillet, so it checks four things: one handle
each and both facing the arc, equal handle lengths, equal cuts on the two sides, and
a handle of the length a circular arc through that angle actually needs. Dropping any
one of the four admits something that is not a fillet, and `test/fillet.test.ts` has
a case for each.

**Which makes the widget's limit honest and visible.** The control appears while the
corner is a circular arc tangent to two straight sides, and stops appearing when it
is not. Move one of the arc's nodes and the corner becomes an ordinary pair of
curves; the mark goes, and it should, because there is no longer a radius to change.
That is a real difference from Illustrator, and it is the difference between reading
the drawing and trusting a note attached to it.

**The drag rebuilds from a sharp copy every frame.** On the press the subpath is
cloned and `unroundCorner` puts the corner back; every move clones that copy and
calls `roundCorner` at the new radius. One function decides what a fillet is, so a
dragged radius and one typed into the rail cannot come out differently, and dragging
back to zero leaves the corner sharp because `roundCorner` declines a radius of
nothing. `cornerAt` is shared for the same reason: the canvas and the button have to
agree about which corners are roundable.

`cornerArcReach` and `cornerRadiusAtReach` are an inverse pair, and both are used --
the first to place the control, the second to read a drag back. Two separate
formulas here would be a control that slides out from under the pointer.

**The control is offset 16 px from the corner, and that is not decoration.** The
anchor layer paints in front of the handle layer, and a node's anchor is 7 px centred
on the corner, so a control at the corner is covered by it and cannot be pressed at
all. This was found by building it that way first. It is the same collision `BOX_PAD`
exists to prevent between a rectangle's corner anchor and its north-west scale
handle, and `cornerWidget` in `tools/drive.mjs` asserts the gap directly rather than
asserting that a drag happens to work.

**Being pressable is the floor, and it is not the same as being readable.** The
offset was 11 px, which clears the anchor by 3.5 px: enough to hit, not enough to
tell apart from the node it belongs to, so the pair read as one cluster.

**The control is a diamond because the other two shapes were already spoken for.**
This is the constraint that is easy to miss, because each half of it is reasonable
on its own:

| Shape at `--measure` | Already means |
|---|---|
| Circle | the bend control, `.bend-dot` |
| Square | an anchor whose node is a corner |
| Rounded square | an anchor whose node is smooth |

So a round corner control is the bend control's own picture, and a square one
spells the anchor's sentence 16 px from an anchor using it to mean something else.
Both were drawn before this was noticed: the corner control was a circle at
`--measure`, filled when rounded, which made it and `.bend-dot` identical but for
half a pixel of radius. A diamond is in neither vocabulary.

**State is fill, and only fill.** Sharp is the same diamond at `fill-opacity: 0.3`,
rounded is the same diamond solid. An earlier version swapped fill and stroke
between the states, which made one tool read as two: the sharp state was an
outline and the rounded state was a solid of a different colour pairing.

## 49. Groups are a relation over a flat list, not a tree

§47 said groups were absent and that a multi-path shape was not one in disguise.
This builds them, and the shape of the answer is set by two decisions already made.

**§5 decides that a group carries no transform.** Transforms are baked into
coordinates everywhere here, so a `<g transform="...">` would be the hidden
coordinate system §5 exists to refuse: every hit test, every snap and every number in
the source drawer would have to be read through it. So a group is organisation and
export. Its shapes move together because moving a selection moves everything in it,
and grouping changes no coordinate at all. What that costs is the thing Illustrator
has and this does not: a group you can scale non-destructively.

**`doc.shapes` stays one flat array, and that decides the model.** Seventy-three
places in `src/` read it, and it is the paint order -- the only order there is. A tree
of children would rewrite every one of them to gain nesting that a parent pointer
gives for nothing. So `Shape.group` names a group and `Group.parent` names another,
and no group holds a list of its members: one statement of the relation, for the
reason §46 gives about one statement of an identity.

**The invariant that buys is contiguity.** A `<g>` holds its children in one run, so
a group's shapes have to be contiguous in `doc.shapes` or the group cannot be written
without changing what paints over what. `groupSelection` is what maintains it: it
moves the selected shapes together, to where the topmost of them already was, keeping
their order among themselves. Nothing else in the editor reorders shapes -- they are
appended or filtered, and both preserve the runs -- which is why one function can hold
the invariant. `test/groups.test.ts` asserts it as a property over every group rather
than checking a particular order.

**Selection gains nothing.** A group reads as selected when every shape in it is,
derived exactly as a path row's state is derived in §47. A `groups` set on the
selection would be a second statement that disagreed the first time a shape was
deleted out of a selected group. It also means every existing operation -- transform,
delete, style, boolean, align -- works on a group with no change to any of them,
because each already works on a set of shapes.

**Empty groups are swept in `Store.edit`.** Eight places remove shapes and any of them
can take the last one out of a group; a group naming nothing draws an empty row and
writes an empty `<g>`. The sweep is beside the auto-smooth one and for the same
reason §16 gives, and it returns on its first line when there are no groups.

Nesting is decided by where the selection already is: shapes that all sit in one group
make a group inside it, and anything else makes one at the top. Grouping part of a
group and having the outer group come apart is the answer nobody wants. Ungroup goes
one level per press, so nesting can be taken back a step at a time.

Import stops flattening. A `<g>` becomes a group with its transform still baked into
the shapes, which is the part §5 keeps and the part that was being thrown away is the
grouping itself. The outer `<svg>` and an `<a>` deliberately do not become groups:
neither is a thing anyone drew, and a row wrapping the whole drawing cannot be
ungrouped into anything meaningful.

**What is still not here.** A group has no style of its own, so a fill set on a `<g>`
in an imported file is pushed down to the shapes rather than kept on the group. There
is no way to enter a group to edit inside it without selecting it whole first. And a
group cannot be scaled without scaling its shapes, which is §5 and not an oversight.

## 50. Align and distribute are one operation given two different boxes

Aligning shapes to each other and aligning them to the canvas are the same
arithmetic. What changes is the box the arrangement happens in, so `arrange.ts`
takes that box as an argument and has no idea which of the two it was handed.
The alternative is two families of six buttons whose implementations drift apart
the first time one of them is fixed.

The same argument covers distribute and spacing, which is why "distribute across
the canvas" needed no code of its own. It needed the frame it already reads to be
the viewBox instead of the selection's own box.

**A node and a shape are different subjects, so the two aligns stay apart.**
`alignNodes` in `ops.ts` moves anchors inside a path and `alignUnits` moves paths
around each other. They cannot be merged, because a node is a point and every
question here is about size: aligning two shapes to the left means putting their
left edges together, and a shape's left edge is a property of its curves rather
than of any node on it. A rectangle drawn from its top-right corner has no node
at its left edge at all. What the two do share is the six-way choice of which
edge, and that lives in one place -- `AlignMode` -- rather than in two lists that
would drift.

**A group is one thing to arrange.** Without that, aligning a selection holding a
group collapses the group onto its own left edge, which is the operation
destroying the structure the user built. `arrangeUnits` gathers the selected
shapes into units, where a group whose every shape is selected is one unit and
moves as one. Selecting only some of a group's shapes moves those on their own,
which is the only reading that leaves room for nudging one shape inside a group.

The unit a shape joins is its **outermost** wholly selected ancestor. Whole-ness
is inherited downwards, so the outermost is the largest thing the selection can
be said to have chosen. Nothing about this is stored: the units are rebuilt from
`Shape.group` on every press, which is §49's relation being read rather than a
second copy of it.

**Illustrator's key object is not here.** Its Align panel can align everything to
one nominated object, shown with a heavier outline. That would be a new piece of
selection state, a way to set it, a way to see it and a way to clear it, and the
two frames cover the cases people reach for. Naming it as a decided gap rather
than an oversight: someone wanting "align these to *that* one" has to move that
one last.

**Nothing clamps a negative gap.** Shapes wider than the frame they are being
spaced across can only overlap, and overlapping them by an even amount is a truer
answer than refusing, and a much truer one than spilling silently off one end.

## 51. Paint order is reordered per parent, and the canvas has to follow

`doc.shapes` is the paint order and nothing had ever reordered it except
`groupSelection`, which gathers a group's shapes into one run. Bring forward and
send backward are the first operations whose whole purpose is to reorder it.

**The move happens among siblings, never across a parent.** A shape brought
forward moves through the other children of its group and stops at the edge of
it, because a shape leaving that run could not be written as one `<g>` -- §49's
invariant stated as a behaviour rather than as something each branch has to
remember. Front and back on a grouped shape mean front and back of its group.
Ungroup is how a shape leaves.

The implementation reads the flat array into one list of children per parent,
reorders the one list that is moving, and rebuilds `doc.shapes` by walking the
tree. Contiguity then holds by construction. The alternative -- splicing the flat
array and being careful -- is the version where the fifth case gets it wrong.

**A press with nowhere to go declines through `tryEdit`.** A shape already at the
front cannot move, and an undo entry for that costs a press of Ctrl+Z that
appears to do nothing. The buttons stay live regardless: whether there is room is
a question about the whole tree, and a button greying out on the answer would
flicker as the selection changed.

**The canvas was drawing the wrong order, and had been.** `renderArtwork` makes a
`<path>` per shape and keeps it in a map, so creating one can only append. The
DOM order was therefore the order shapes were *first seen*, not `doc.shapes`
order -- which had already been wrong since grouping started reordering the
array, with the export and the screen quietly disagreeing about what covered
what. One pass now puts each element at its index, writing only where it is
already wrong. Found by a browser scenario, because no unit test had ever asked
what order the elements were in.

## 52. A typed size is derived from the box, never composed onto the last one

The four fields for the selection's X, Y, width and height are the typed form of
dragging a box handle, and they move exactly what a drag moves: the selected
nodes, which for a selected shape is all of them. The box they show is
`selectionBBox`, the same one the handles are drawn on, so the panel and the
canvas cannot disagree about what is being measured.

Each edit builds its matrix from the box as it is at that moment. §5 bakes
transforms into coordinates, so there is no stored size that could be corrected
instead -- and composing each edit onto the last would let a run of them
accumulate rounding, so typing 60 twice would not leave the same drawing as
typing it once.

That is also why the fields commit on `change` rather than streaming on `input`
like the canvas fields do. A stream would scale from each intermediate width to
the next, which reaches the right answer but passes through the widths a
half-typed number spells: typing 120 squashes the selection to one unit wide on
the way, and an axis already shorter than `FLAT` cannot be scaled back.

Width and height anchor the top-left corner rather than the centre, so setting
one leaves the other three numbers alone. Anchoring the centre would move X and Y
as a side effect of typing W, and a panel whose fields change each other is a
panel nobody can predict.

`FLAT` is exported from `transform.ts` rather than restated here: a drag and a
typed number ask the same question about a flat selection, and two thresholds
would let the panel refuse what a drag allowed.

**Not here:** a lock linking width to height. Scaling both together is what the
**Scale** field above already does, and a proportion lock is a mode.

## 53. Pixels come from the browser, and cost nothing to ask for

Two things wanted the drawing as pixels: a PNG to ship, and a row of small
previews to judge an icon by. Both are the same string -- the document written
out as an SVG data URI -- handed to a browser that already knows how to draw one.

That is why neither needed a dependency or a server. A data-URI SVG does **not**
taint a canvas, so the canvas can be read back; an `<img>` pointed at a file
would, and `toDataURL` on a tainted canvas throws. Everything stays a URI the
page built itself, so this works from `file://` like the rest of the editor.

**Both are written with the Output settings.** A preview shows what the exported
file draws rather than what the editor holds, so dropping the decimals to nothing
visibly rounds the drawing. Seeing that is the point: the settings that shrink
the file are the ones that can spoil it.

The URI is percent-encoded rather than pasted in raw, because a data URI ends at
the first unescaped `#` and every fill this editor writes is a hex colour. Raw,
the browser reads the first colour as a fragment and loses everything after it.

**The previews hold still during a drag.** Pointing an `<img>` at a new data URI
is a parse and a raster of the whole document, four times over, and doing that on
every `pointermove` stutters the drag it is meant to illustrate. The drag ends
with a store notification like any other, which is what redraws them. They are
also left alone while their group is shut, on the same argument the source drawer
makes: a panel nobody is looking at should not cost a redraw.

**A PNG's height follows the viewBox, never the drawing.** The canvas is the page
the icon sits on, and cropping to the artwork would silently change the padding
somebody chose. Both sides are floored at one pixel, because `toBlob` on a canvas
of zero pixels returns null and the download would fail rather than produce a
small image.

`renderPng` rejects rather than resolving with a blank image when the browser
declines to decode or encode. A silently blank PNG is the worst outcome
available: the download succeeds and nobody looks at the file until later. The
browser scenario reads the bytes back for the same reason -- a well-formed PNG of
nothing has a valid header too, so it counts the opaque pixels.

## 54. Overlay decoration takes no pointer, whatever is covering it today

The controller reads a press by asking what is under it and looking for a
`data-hit` attribute. A target without one is not a control, so the press starts
a marquee, which clears the selection. That is the right reading of a press on
empty canvas and the wrong reading of a press on a shape.

So a decorative element painted over a control does the opposite of the control
where it lies. `.handle-line` did: a latent handle's line runs from a node along
the straight segment it would bend, directly over that segment's outline, and
**16.4% of the whole pixels down a selected rectangle's edge deselected the shape
instead of moving it.** One press in six. It is a dashed line one pixel wide, so
nobody aiming at the edge could see why the edge sometimes failed.

**Document order is paint order in SVG**, which is what decides whether an
element is over a control or under one. The grid is painted before anything
carrying a `data-hit`, so it can take a press from nothing and needs no
declaration. Everything painted after the first control needs
`pointer-events: none` unless it is a control itself.

**The rule is about what an element is, not about whether it is getting away
with it.** `.guide` was swallowing no press at all: its hit strip is eight pixels
wide, transparent, painted immediately after it and covering it everywhere. What
stopped it was another element's geometry, and geometry changes. It is declared
now, and the rule reads the same for both.

The audit inside `tools/drive.mjs` runs on every scenario and fails the run on
any element that breaks this. Restoring the `.handle-line` defect fails 31 of the
52 scenarios. It asks the browser's own taxonomy -- `SVGGeometryElement` and its
image, text and use siblings -- rather than a list of tag names, so a new kind of
overlay element is covered without anyone remembering to add it.

## 55. Two ways to do a thing is one way and a trap

Three controls left in one pass, and the reason was the same each time.

**The rectangle tool's corner radius.** `rectSubpath` took an `r` and built four
quarter arcs, so the tool rounded while drawing and `roundCorner` rounded after.
Two generators for one shape, which §23 had already had to teach the same lesson
about coincident anchors twice. It also applied to one tool out of four, with
nothing on screen saying so: the field sat in a panel of operations that acted on
what was selected, and it acted on what you were about to draw. The tool draws
four handle-less nodes now, and `roundCorner` is the only thing in the program
that builds a fillet.

**Circularise.** It fitted a circle through a path's nodes by least squares and
moved each onto it at its own angle, which is not what "make this round" means to
anyone who has not read the implementation: a hand-drawn ring came back with its
node spacing untouched and its shape only as round as the fit. `fitCircle` went
with it, having no other caller.

**The five clipboard buttons, on a mouse.** Duplicate, Delete, Copy, Cut and
Paste each repeat a key. They stay for a finger, which has no Ctrl+C, and
`touchButtons` decides: on wherever `pointer: coarse` matches, which is the same
condition the 44px targets answer to. The rule that every operation gets a button
is a rule about touch, and this is what it costs to keep it there and not
everywhere. Duplicate had no key at all until this, which is what had kept its
button in front of a keyboard that never needed it.

**What one radius buys, beyond one implementation.** `sharedCornerRadius` asks
what every corner in a set can hold at once, which `maxCornerRadius` cannot: two
corners rounding on the side they share eat it from both ends, so each may have
half. Without it, rounding a rectangle clamped each corner in whatever order the
loop ran and returned four radii for one request, reported as "Rounded 4 corners.
3 clamped to r 8.284 by the shorter side." One request now has one answer, and
the drag on a corner control uses the same number: dragging one control rounds
every corner of the shape, or every selected node, the way a corner widget
behaves everywhere else.

§12, §16, §23 and §47 all name the deleted code. They are records of decisions
taken while it existed, and they stay as they are: the reason `setContinuity`
returns a boolean is not changed by the fact that the other example of it is
gone.

## 56. A destination is a step with the arithmetic done once

Dragging a row in the shape list is the same reordering the four tiles do, with
the destination named rather than walked to. `dropShapes` sits beside
`reorderShapes` in `src/model/arrange.ts` and ends where it ends: the tree of
per-parent orders is rebuilt and `flattenOrders` walks it back into one flat
paint order. So §49's contiguity holds for a drop for the reason it holds for a
step, which is that neither of them writes `doc.shapes` directly.

**The index is taken among the rows that are staying.** Taking it in the list as
it stands counts the rows that are about to leave, so a row dragged downward past
its own neighbours lands short of the line that was drawn for it -- by one for
each row moving with it. That is the whole of the arithmetic and it is the whole
of what can go wrong in it.

**A drop lands only among siblings, and the interface is what makes that true.**
The drag collects its targets from the `<ul>` the row is already in, so there is
no pointer position that asks for a shape to leave its group. The model does not
have to refuse anything, because nothing can express it. A shape leaves a group
by being ungrouped, which is the same answer §49 gives to every other route.

**Pointer events, not HTML drag and drop**, which no touch screen implements. The
cost is that a press has to be read twice over: a mouse begins the drag on
movement past four pixels, and a finger begins it on a four-hundred-millisecond
hold, because a finger that moves straight away is scrolling a list that is 170px
tall and usually taller than that inside.

**Selecting happens before the rows are captured.** Selecting notifies the store,
the list rebuilds itself from scratch on a notification, and rows captured before
that are detached nodes by the time the pointer moves. The row is found again by
its key afterwards, which is the same rule §43 states for nodes: build a
reference, use it, throw it away.

## 57. One word, one meaning, and this one had two

`continuityOf` answered `corner` for a node whose handles are missing or not in
line. `cornerAt` answers with a corner when two straight sides meet at a node,
which is what Round can cut. Both are correct about their own question and the
two answers disagree constantly:

- A node with two curved sides pulling different ways is a cusp with no corner to
  round. The panel said **Corner** beside a canvas with no corner control on it.
- A square's corner is roundable and has no handles at all to be a cusp about.
  The panel said **Corner** there too, for the other reason.

The user reading that screen had no way to tell which sentence the word was in,
and reported the corner control as broken. It was not: the interface was using
one noun for two things.

The continuity is `cusp` now, which is the word Inkscape uses for the same node
type beside the same Smooth and Symmetric. `corner` belongs to the fillet, which
is where the geometry earns it: `cornerAt`, `roundCorner`, `unroundCorner`, the
`corner` drag kind and the `data-hit="corner"` control are one concept under one
name.

`writing` rule 9 states the trap in both directions. Two words for one concept is
the half everybody checks. One word for two concepts is the half that hides,
because nothing on the screen looks inconsistent.

## 58. One place to get a drawing in, one place to get it out

Saving a drawing meant opening a text box. **Download SVG** sat in the source
drawer's header, beside **Apply**, **Revert** and **Copy**, and `Ctrl+E` was the
only way to reach it. **Download PNG** had a group of its own at the far end of
the Document tab, next to Preview. **Add an SVG** was in Document under File.
Three places, and the one holding the primary export was a panel whose job is
editing text.

It was also lying about its scope. The drawer shows one shape's path data when a
shape is selected, and `Download SVG` writes the whole document regardless. Two
controls a hand's width apart, one scoped to the selection and one not, with
nothing on either saying so.

**Everything that moves a drawing across the boundary is in Document under File
now**, under two sub-headings that say which way it goes:

| | |
|---|---|
| Add | **Add an SVG** |
| Save | **Download SVG**, **Download PNG at N px wide** |

**Output** -- decimals and minify -- is a nested group inside it, one press away
and shut by default, on the same argument that put Fill rule inside Style: it is
set once and read rarely, and it governs both downloads and the previews. Its own
top-level group had been a fourth place to look.

**File is the only group that opens by default without acting on a selection.**
§41's rule is that a group opens when it acts on what is selected. File acts on
nothing selected, and shutting it would have put Download SVG two presses from
anywhere in the app, which is the position this section exists to leave.

**The drawer keeps `Copy`, and it is not an export.** It copies what the box is
showing, which is path data or a whole SVG depending on the switch beside it, and
that is the one operation here whose scope really is the drawer's. The title says
so, because the label cannot.

**Node and shape align now say the same words.** §50 argues the two
implementations must stay apart, and they do. What was not argued was the
interface: shapes had **Align shapes** and **Distribute shapes** as two rows of
six tiles, and nodes had **Align** as six tiles and then two plain buttons
labelled **Space H** and **Space V**. `Space H` also names one of the shape
controls, the gap-based one, so the same two words meant two operations depending
on which panel you were in. The node pair is **Distribute nodes** now, drawn as
tiles with the same icons and the same word -- `centre` -- as the shape row.

Two tiles where shapes get six, and the sentence under them says why: a node is a
point with no width, so equal gaps, equal centres and equal edges are one move
rather than three. Stating the count is the alternative to a reader assuming four
tiles are missing.

## 59. Two things a person means by "save my work", and one reader for both

The document lived in memory and nowhere else. A reload lost it, and the editor
said nothing before or after.

**An SVG is not the answer, because it is only half the work.** It carries the
drawing. It has nowhere to put the camera, the guides, the saved styles, the
grid step, the keylines or any of the twenty switches across the three panels,
and those are what a session is: not what you drew, but where you were.

So there are two formats and one reader. `io/session.ts` turns the editor into
one JSON value and back. `io/storage.ts` writes that on a timer into
`localStorage`; **Workspace: Save** writes the same bytes to a file. Two writers
of one format would disagree the first time either was extended, and the
disagreement surfaces as a file that opens in one of them.

### Nothing about the read trusts what it is given

`read` rebuilds every object field by field and returns a sentence for anything
that is the wrong shape. That is stricter than it looks necessary, and the reason
is where it runs: at startup, on whatever is in storage, before a single pixel is
on screen. A restore that threw would leave a blank editor with no message, and
it would do it on every load until somebody cleared the entry by hand.

**The drawing reads strictly and the preferences read leniently.** A coordinate
that is not a number refuses the whole file; a switch that is missing falls back
to what the running editor already thinks. A wrong boolean costs one press. A
wrong coordinate is somebody's drawing. And a build that adds a switch would
otherwise refuse every file written before it.

`version` is checked against one number and a mismatch is refused rather than
guessed at. A field that changed meaning reads as perfectly valid and restores
the wrong thing, which is the failure with no symptom.

### The counters are younger than the document

`nextId` and `nextNodeId` are module-level and start at zero on a fresh page. A
restored document arrives holding `shape-4` and `n12`, and the next shape drawn
takes `shape-1` for the second time. That is §46's collision -- an id naming two
things is two things no selection can separate -- reached from a direction §46
does not cover, because nothing was copied. `reserveIds` walks the incoming
document and moves both counters past it.

The symptom is not an exception. It is one click on one row selecting two shapes,
and the browser scenario checks for exactly that rather than for the ids.

### Order is the whole of the restore

Every checkbox in the rail sets itself from `store.state` once, at the moment it
is bound. Nothing re-syncs them: the subscriber redraws the canvas and the
readouts, not the controls. So the restore runs immediately after the store is
built and before any of the wiring, and a restore that ran later would put the
drawing back while leaving fourteen switches showing the state it replaced.

Two things then have to know a restore happened. The startup `fit` is skipped,
because a restored camera is where somebody left the view and fitting the drawing
over it throws away the one part of the session that took a gesture to set. And
the `pointer: coarse` default for Touch buttons is skipped, because a media query
is not entitled to overrule an answer a person gave.

### It says when it is not saving

Opened from a `file://` URL, Chromium gives the page an opaque origin and every
`localStorage` access throws. A build of this editor is one file you double-click,
so that is not an edge case. A tick that was always on would be a lie exactly
where it matters most, so the readout beside **On this device** reads `saving`,
`stopped` or `not saving`, and the sentence under it names which of the two
reasons applies. The quota is the other one: a drawing past two megabytes of text
is refused while there is still something to say about it, rather than silently
stopping.

**Forget saved work latches rather than storing a preference.** Leaving the
subscriber running would write the session back inside the second and make the
button look broken. Storing the choice would turn one press into a promise the
button does not make. It lasts until the reload, which is when a fresh start
takes effect anyway.

## 60. Opacity is one number, and the objection to it is the design

`Style` had four fields, and every one of them answers a question with a single
answer: what colour, what colour, how wide, which rule. Opacity does not have to
be like that, and SVG offers three ways to say it -- `opacity`, `fill-opacity`,
`stroke-opacity` -- plus a fourth in the alpha channel of a colour.

**Only the first is here.** The three multiply, so a shape at 0.5 with a fill at
0.5 draws its fill at 0.25 and its stroke at 0.5. That is a true statement about
compositing and a useless one about a drawing: the panel would have to teach it,
and the person reading the panel wanted to know how see-through the shape is.
One number composites the whole shape and needs no rule to explain it.

The alpha channel goes the same way, and more sharply: `#ff000080` puts the
fill's transparency somewhere the stroke's cannot follow, and the colour input a
browser gives you cannot show or return it, so the value would round to opaque
the first time anybody touched the picker.

The shopping list recorded this as an objection before the field existed -- "the
reason to stop at one number is the reason gradients are refused" -- and building
it did not answer the objection so much as hold the line it drew.

### Reading is where the three have to be reconciled anyway

A file may carry all of them, and refusing to read what you refuse to write is
losing somebody's drawing. So `readStyle` multiplies `opacity` down the tree, the
same way a renderer does. **A group carries no style here** (§5), so the factor on
a `<g>` has nowhere to live except on the shapes under it, and dropping it would
draw an imported file at visibly the wrong darkness with nothing on screen to
explain why.

Two details, both of which have a test because neither is obvious:

- **A percentage is legal in a `style` attribute and not as a presentation
  attribute.** `parseFloat("50%")` is 50, which clamps to opaque -- the right
  answer for `opacity="50%"` and the wrong one for `style="opacity:50%"`, and
  `styleProp` reads both. The suffix is checked rather than ignored.
- **`opacity="1"` is the initial value**, so it is written only below 1. The same
  argument writes `fill-rule` only for even-odd.

`fill-opacity` and `stroke-opacity` are read as nothing, which is the one place
this loses information from a file. It is the honest cost of the field not
existing, rather than a gap: folding them into the shape's opacity would be
inventing a number the file does not contain.

### The canvas writes it always, and the file writes it sometimes

`setAttrs` sets what it is given and does not clear what it is not, so a canvas
that wrote `opacity` only below 1 would leave the last value on the element and a
shape brought back to 100% would stay faded. The browser scenario checks exactly
that, because it is invisible in a unit test of the exporter and it is the only
half of the pair that a person would report as a bug.

## 61. The way back up from a shape to its group, without a mode

Clicking a shape inside a group selects that shape. Illustrator selects the
group, and you double-click to go inside it. The difference is deliberate and
§49 is why: a group here is a relation and not a container, so a shape in one is
an ordinary shape, and nudging one shape inside a group should not require
taking it out first.

What that cost was the other direction. A group was selectable only by its row in
the shape list, so a drawing on screen had no handle for the thing it belonged
to.

**Select group** (`Shift+G`) widens the selection to the group its shapes are in,
one level per press.

### The level is derived, not stored

Illustrator's version is a mode: you are inside a group until you press Escape,
and what a click means depends on where you have been. That is a second piece of
state describing the selection, and it can disagree with the selection -- the
same objection §6 makes to a stored node type and §5 to a stored transform.

Here the level is read off the selection at the moment of the press: the nearest
ancestor group that is not **already wholly selected**. Pressing again goes one
further out, because the group you just selected now is wholly selected. Nothing
is remembered between presses, so a selection made by hand behaves exactly like
the same selection arrived at by pressing, which a mode cannot promise.

`canSelectGroup` asks the same question and is what greys the button out at the
top level, so a press that would report success and change nothing is not
offered.

### The style on a group stays refused

The shopping list carried **a style on a group** beside this, and building it
would undo §49. An SVG `<g>` can hold a `fill` for everything inside it, and a
`<g>` imported here has its fill pushed down onto the shapes. Keeping it on the
group instead would mean a shape's painted colour is not a property of the shape:
two places for one fact, which is §5's objection to a stored transform and §6's
to a stored node type, arriving a third time.

The entry set its own condition -- "worth doing only with an answer to which of
the two wins when they disagree" -- and there is no answer that is not a rule the
panel would have to teach. Meanwhile the operation people actually want already
works: selecting a group selects its shapes, so setting a colour on a group
colours them. What is missing is only the inheritance, and the inheritance is the
part that costs.
