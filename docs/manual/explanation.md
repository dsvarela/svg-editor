# Explanation

Why the editor behaves the way it does. None of this is needed to use it, and
all of it explains something you will otherwise find surprising.

## Points do not have types

Most editors store a flag on each node saying corner, smooth or symmetric. This
one does not. It works out the answer from where the handles are, every time it
needs it.

A stored flag can disagree with the drawing, and eventually does. A file claims a
node is smooth while its handles sit at ninety degrees, and the marker on screen
tells you something the geometry contradicts. Worse for an editor that imports:
an SVG path carries no such flag, so everything read from a file starts as a
corner, and dragging a handle on a visibly smooth imported curve puts a kink in
it.

Deriving it means the marker cannot lie, and there is nothing to choose before
you draw. It also means **the continuity buttons are real edits**. Pressing
**Smooth** moves the handles, because moving the handles is the only thing being
smooth consists of. A button that appeared to change a setting without changing
the drawing would be the flag problem wearing a different hat.

The cost is that a drag has to read the relationship before it changes anything.
Once a handle has moved, the pair is no longer lined up and would read as a
corner, so a smooth node would break itself the first time you touched it.

## A straight line has no handles at all

When a segment is straight, both handles are absent rather than sitting on top of
their nodes.

This makes "is this straight?" an exact yes or no instead of a measurement
against a tolerance, which is what lets the output keep `L`, `H` and `V` instead
of writing every line as a curve that happens to be flat.

You can see it in the ghost handles. A hollow circle marks where a handle would
go if it existed. Pull one out and the segment becomes a curve; press **Corner**
and the handles go away and it is a line again, not a curve pretending.

It is also why a rounded rectangle's sides stay exactly straight no matter what
you do to the corners.

## Everything is a path, including the circle you just drew

There is no ellipse object and no rectangle object. The moment you finish
dragging one out, it is nodes and handles like everything else.

So there is no "convert to path" step, and no operation that works on some shapes
and not others. **Subtract** does not care that one input came from the ellipse
tool.

A circle drawn this way is four curves, and it is round to about 0.027 % of its
radius. That is not exact, because a Bézier curve cannot be a circular arc. It is
closer than a screen can show and closer than most renderers care about.

The number matters when you circularise something with one very wide gap between
nodes, because the error grows quickly with the arc a single curve has to cover.
That is why the status line tells you when a gap is wide, and suggests adding a
node in it.

## A closed shape has to go round once

Circularise takes the nodes you have, fits a circle through them, and moves each
one onto it. It then has to decide, for each pair of neighbours, which way round
the circle the curve between them travels.

Taking the shorter way is right almost always, and destructive in one case. If
four nodes are bunched into a sixty degree wedge, the gap closing the shape is
three hundred degrees, and "the shorter way" reads that as sixty degrees
backwards. The closing curve then retraces the other three instead of completing
the circle.

Every node still sits exactly on the circle when this happens, so measuring the
radius cannot detect it, and the reported travel is zero. It looks like a perfect
result.

So a closed path is treated as a ring. One direction is chosen from the shape's
own winding, every gap follows it, and the total has to add up to a full turn. A
set of nodes that cannot do that, such as a five-pointed star, is refused with
nothing changed rather than mangled.

## The grid never draws a line you cannot snap to

Zoom out far enough in most editors and the grid switches to a coarser lattice
that no longer matches the snap interval. You then place a point on a line and it
lands somewhere else.

Here the drawn grid is always the snap step multiplied by a whole number. Zooming
out thins the lattice; it never replaces it. Every line you can see is a position
you can snap to, and the readout says which multiple you are looking at.

## Moving a shape snaps the distance, not the positions

Snapping each node's position while you drag a shape would pull every node onto
the lattice and change the shape's proportions. A rectangle at 0.3, 0.4 would
snap into a different rectangle.

Rounding the displacement instead keeps every relative offset exactly. A shape
whose nodes are on the grid ends on the grid; one that is not keeps its offsets.
Node dragging is different, and does snap the position, because there is only one
node and its position is what you are choosing.

## The page does not follow the drawing

The canvas is the page the drawing is made for, and nothing you draw changes it.
That is deliberate, and it is the opposite of what a first look suggests.

An icon is drawn to a size. You choose 24 by 24, you leave two units of margin,
and the margin is the point. A page that resized itself whenever a node moved
would make that margin impossible to hold: every edit would redefine what the
drawing is drawn to.

So the page stays where you put it, drawing outside it is allowed, and one button
wraps it around what is there when that is what you want. **Fit canvas to
drawing** rounds outwards to whole grid steps, never inwards, because a page that
crops the drawing to reach a rounder number is a page that has thrown work away.

None of which was obvious while the page was invisible. The grid runs to the
horizon and looks the same on both sides of the boundary, so a drawing in one
corner of a large page looks centred while you work and takes up a fifth of the
exported file. It is drawn now, with everything outside it dimmed, and the panel
says so when part of the drawing is out there.

## The transform box keeps its distance

A selection's box has to be drawn around whatever is selected, and the handles
have to sit on it. Which puts them exactly on top of the shape's own nodes,
because a bounding box touches the drawing at its extremes by definition. The
corner of a rectangle and the corner handle of its box are the same point.

Handles are drawn in front of nodes, so drawn honestly the box would take every
click aimed at a corner. You could rotate the rectangle and never drag its corner
again.

So the box and its handles are drawn a few pixels outside the true bounds. The
arithmetic still uses the real box, and the drag remembers how far the pointer
was from the corner when you pressed, which is why nothing jumps on the first
move.

Rotation had the same problem and a worse version of it. A rotation zone big
enough to find by accident is much larger than a handle, and centred on the
corner it swallowed the corner node completely. It now sits diagonally outside
the corner instead, which is where every other editor puts it, and where you
were going to try first anyway.

## Transforms are baked, never stored

Rotating a shape rewrites its coordinates. There is no `transform` attribute
hanging off it waiting to be applied at render time, and imported ones are baked
in on the way in.

This is why the source box always shows what is really there. No hidden
coordinate system, and no numbers that only make sense after a matrix you cannot
see. The cost is that rotating by ten degrees and back is not exactly the
identity. Undo is exact; arithmetic is not.

## Rounding refuses where fusing approximates

Two operations that both rebuild a corner, and they answer the same question
differently. **Fuse** approximates: it rebuilds one segment from two and the
result can visibly differ. **Round** refuses outright if either side of the node
is a curve.

The difference is what you can tell. A fused segment that came out wrong is
visible immediately and one keystroke away from being undone. A fillet that is a
fraction of a degree off tangent looks correct at every zoom you are likely to
check, and shows up later as a seam in the finished artwork. So one is allowed to
be approximate and the other is not.

## Delete never refuses, and fuse is approximate

Deleting a node has two reasonable meanings and this editor lets you pick.

**Fuse** keeps the path whole by rebuilding one segment from the two that met at
the node. Rebuilding is approximate by nature. When both original curves bowed
the same way it is very close; across an inflection it visibly differs, because
one cubic curve cannot reproduce an S made of two.

**Split** leaves two ends, and is exact: no segment is rebuilt, so every curve
that survives is the one that was there.

**Break here** is the third option and the honest inverse of adding a node. It
keeps the node, duplicates it, and cuts between the copies. Nothing moves at all.

Adding a node is always lossless in the same way, using the standard subdivision
that produces two curves tracing the original exactly. So you can add nodes
freely, and you should know which kind of delete undoes that.

## The backdrop is not in the document, and is in the history anyway

A tracing image is the first thing here that is not a path, so it had to go
somewhere, and the obvious home was wrong.

Putting it in the document would have meant two bad things. It could reach the
export, and an SVG that carries the photograph you traced from is not what
anyone asked for. And **Apply** in the source box replaces the document
wholesale, so editing the path text would silently throw away the thing you were
tracing.

So it lives with the camera, the grid and the handle toggle: workspace state,
not drawing content. The export is built from the model rather than from what is
on screen, which means a backdrop the model does not know about cannot leak into
a file by accident. That is a structural guarantee rather than a rule someone
has to remember.

None of which says anything about undo, though it was read that way at first,
and the feature shipped with no way to take back a nudge or a removal. Those are
two questions, not one. Being outside the document is about what gets exported;
being outside the history is about what you can take back, and there was never
an argument for the second. There is now no reason for it either: the image is
held by reference, so a history entry carrying one costs about what a node
costs.

The line that is drawn instead is between the image and your view of it. Which
picture is loaded, where it sits and how big it is are edits, and undo takes them
back. Opacity, **Show** and **Locked** are how you are looking at it, and undo
leaves them exactly as you set them. Otherwise taking back a node move would flip
a checkbox you pressed afterwards, which is the same surprise as undo moving the
camera.

One thing follows from this that is worth knowing. Removing a backdrop does not
free the image, because undo has to be able to bring back the picture rather than
a broken link. It is freed once no step in the history can reach it any more.

The remaining price is that none of it survives a reload.

## Simplify keeps the corners and moves the rest

Fitting a curve through a run of points is a solved problem, and the solution is
about thirty years old. What decides whether the result looks right is not the
fitting. It is which runs get fitted.

A traced or imported path is mostly gentle wobble with a few real features in it.
Fit through everything and the features go: the points of a star round off, and
the corner of a letter becomes a bend. So corners are found first, and a node
where the path turns by more than fifty degrees ends one run and begins the next.
It stays exactly where it is.

Fifty degrees is a judgement, and there is no threshold that is right for every
drawing. It errs towards keeping detail, because the two mistakes are not equally
bad. A corner wrongly kept is one node you delete. A corner wrongly smoothed is a
shape you redraw.

Every node that survives keeps its direction as well as its position. The fit is
told which way to leave and which way to arrive, taken from the path as it
already was, rather than choosing for itself. That is what makes a corner stay
exactly as sharp, and it is also how a closed path avoids growing a kink at the
point where it had to be cut open to be fitted.

The tolerance means what it says, within one honest limit. The path is measured
by sampling it, and the promise is kept at the samples. Sampling is dense, and
capped in two ways at once: no sample may sit further from the true curve than a
tenth of the tolerance, and no two samples may be further apart than twice it.
The second cap is the one that is easy to forget and expensive to omit. A
straight stretch of the input is perfectly flat, so it samples to its two ends,
and a fit is then free to bow out between them where nothing is checking.
Without that cap, a forty-sided ring reported an error of 0.05 while sitting
0.15 away from the shape it had replaced.

A result with the same number of nodes is refused rather than applied. Redrawing
a path into the node count it already had trades the geometry someone chose for
the geometry a fit guessed, which is a loss with no gain to show for it.

## Booleans are the one thing not written here

Union, subtraction, intersection and exclusion come from
[`path-bool`](https://www.npmjs.com/package/path-bool), a maintained MIT library
whose segment format maps one to one onto this editor's node model. The
translation never goes through a path string in either direction.

Its author describes it as early-stage, so its output is treated as untrusted:
non-finite results are rejected, a library exception is caught, and nothing in
the document changes until a valid result exists. A failed boolean leaves the
drawing exactly as it was.

## Undo is a snapshot of the whole document

Every history entry is a full copy, not a description of what changed.

For a drawing of this size that is cheap, and it removes an entire class of bug:
there is no such thing as an operation that forgets to record part of what it
did. A drag is one entry because the whole drag is wrapped in one batch, not
because each frame is cleverly merged.

An operation that turns out to have nothing to do records no entry at all. That
sounds obvious and was not true until recently: pressing a button that declined
used to leave an empty step on the stack and throw away anything you could have
redone.
