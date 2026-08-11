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

## Transforms are baked, never stored

Rotating a shape rewrites its coordinates. There is no `transform` attribute
hanging off it waiting to be applied at render time, and imported ones are baked
in on the way in.

This is why the source box always shows what is really there. No hidden
coordinate system, and no numbers that only make sense after a matrix you cannot
see. The cost is that rotating by ten degrees and back is not exactly the
identity. Undo is exact; arithmetic is not.

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
