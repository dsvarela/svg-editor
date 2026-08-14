# How-to guides

Recipes. Each one is a task you might arrive wanting to finish, and the shortest
route to finishing it.

## Contents

- [Add a node to an existing curve](#add-a-node-to-an-existing-curve)
- [Move several shapes at once](#move-several-shapes-at-once)
- [Make a hand-drawn ring perfectly round](#make-a-hand-drawn-ring-perfectly-round)
- [Make a corner smooth](#make-a-corner-smooth)
- [Break one path into two](#break-one-path-into-two)
- [Join two ends back together](#join-two-ends-back-together)
- [Carry on drawing a path you already finished](#carry-on-drawing-a-path-you-already-finished)
- [Delete a node without breaking the path](#delete-a-node-without-breaking-the-path)
- [Draw a rounded rectangle](#draw-a-rounded-rectangle)
- [Combine two shapes](#combine-two-shapes)
- [Punch a hole in a shape](#punch-a-hole-in-a-shape)
- [Line up and space out nodes](#line-up-and-space-out-nodes)
- [Bend a segment without touching its handles](#bend-a-segment-without-touching-its-handles)
- [Rotate or scale by an exact amount](#rotate-or-scale-by-an-exact-amount)
- [Snap to a whole number of grid steps](#snap-to-a-whole-number-of-grid-steps)
- [Round off a corner](#round-off-a-corner)
- [Colour a shape](#colour-a-shape)
- [Set the page the drawing exports to](#set-the-page-the-drawing-exports-to)
- [Resize or rotate something on the canvas](#resize-or-rotate-something-on-the-canvas)
- [Thin out a path with too many nodes](#thin-out-a-path-with-too-many-nodes)
- [Trace over an image](#trace-over-an-image)
- [Move around the canvas](#move-around-the-canvas)
- [Paste in a path from somewhere else](#paste-in-a-path-from-somewhere-else)
- [Get the smallest possible output](#get-the-smallest-possible-output)
- [Rename a shape and control its exported id](#rename-a-shape-and-control-its-exported-id)

## Add a node to an existing curve

Double-click the outline where you want the node.

The node appears exactly where you clicked and the curve does not move. The
segment is split into two that trace the original between them, so this is
lossless: you can add ten nodes to a curve and it still draws identically.

To add a node at the end of an open path instead, use the pen tool and click the
path's last node, then keep clicking.

## Move several shapes at once

Select them, then drag any one of their outlines. Everything selected moves
together.

Three ways to select more than one shape:

- `Shift`-click each name in the **Shapes** list.
- `Shift`-click each outline on the canvas.
- Drag a marquee over them on empty canvas. A marquee selects nodes, so grab an
  outline it covered completely and the whole selection moves.

Arrow keys nudge the whole selection too, and everything in the **Transform**
panel applies to all of it.

## Make a hand-drawn ring perfectly round

Select the shape, then press **Circularise** in the **Draw** panel.

A circle is fitted through the nodes by least squares. Each node keeps its angle
and moves out or in to the fitted radius, and the handles are rebuilt to match
the arc each segment now covers.

The status line reports the radius it found and how far the furthest node had to
travel. A small number means it was nearly a circle already. A large one is the
honest measure of how far it was.

Two things it will not do. It refuses nodes that do not go round in order, such
as a star, because no circle through them in that order is a ring. And when one
gap is much wider than the others, it says so, because a single curve cannot
hold a wide arc tightly. Add a node in the gap and run it again.

## Make a corner smooth

Select the node, then press **Smooth** or **Symm** in the **Node** panel. You can
also double-click the node to cycle through corner, smooth and symmetric.

Expect the drawing to move. A corner has no handles, so making it smooth has to
create them, and creating them changes the curve. Roughly 1.5 units on a
right-angle corner with 10-unit sides.

On a corner whose two sides are the same length, **Smooth** produces a symmetric
node, because both new handles come out the same length. That is correct rather
than a fault: symmetric is smooth with equal handles.

If a button does nothing, the status line says why. There are three reasons: the
node already is what you asked for, it ends an open path so there is no second
handle to line up with, or it is symmetric and you asked for smooth.

## Break one path into two

Select one node and press `Shift+B`, or press **Break here** in the **Node**
panel.

The node is duplicated in place, so nothing moves and no curve is rebuilt. An
open path becomes two open paths. A closed path opens at that node and stays one
path.

This is the lossless way to cut. Use it rather than deleting a node when you care
that the surviving curves are unchanged.

## Join two ends back together

Two operations, because there are two things you might mean. Both need exactly
two free ends selected, meaning the first or last node of an open path.

**Connect** (`Shift+J`, or the button in the **Node** panel) draws the segment
that is missing. Both nodes stay, nothing moves, and the new segment is straight.
This is the one you usually want.

**Merge** (`Shift+M`) welds the two nodes into one at their midpoint. It costs a
node, and ends already sitting on top of each other do not move at all, which
makes it the exact inverse of **Break here**.

Two ends of the *same* path close it into a ring, either way. Two ends of
*different* paths concatenate into one, and either path is reversed as needed so
the drawing directions agree. If the two paths were separate shapes, the second
shape disappears once its last path has moved across.

Inkscape ships both under names so similar they are easy to confuse (`Shift+J`
merges nodes there, `Shift+Ctrl+J` joins with a segment). Here the word "join"
means the non-destructive one.

## Carry on drawing a path you already finished

Select the pen with `P`, then click either end of the path.

The pen picks the path up from there, and the next click extends it. If you click
the start rather than the end, the path is reversed first, because the pen only
ever appends.

To add a node in the *middle* rather than at an end, double-click the outline
with the select tool.

## Delete a node without breaking the path

Set the **Delete** panel to **Heal**, then select the node and press `Delete`.

Heal rebuilds one segment from the two that met at the node, so the path stays
whole. The rebuilt segment is an approximation, and it is a good one when the two
originals curved the same way. Across an inflection it will visibly differ.

Set the mode to **Split** instead and the same key leaves two ends, with every
surviving curve untouched.

## Draw a rounded rectangle

1. Set **Corner** in the **Draw** panel to the radius you want.
2. Press `R`.
3. Drag out the rectangle.

`Shift` constrains it to a square, and `Alt` treats the point you pressed as the
centre instead of a corner.

The radius is clamped to half the shorter side, so a large value gives a stadium
rather than a shape that crosses itself. The four sides stay exactly straight,
because their nodes carry no handles at all.

## Combine two shapes

Select two or more, then press **Unite**, **Subtract**, **Intersect** or
**Exclude** in the **Combine** panel.

The first shape you selected survives, keeping its name and its colour.
**Subtract** takes all the others away from it, so selection order matters for
that one.

If the operation cannot produce a valid result, nothing changes and the status
line says so. The document is never left in a half-finished state.

## Punch a hole in a shape

1. Draw the outer shape, then draw the hole inside it as a second shape.
2. Select both.
3. Press **Make one shape** in the **Combine** panel, or `Shift+P`.
4. Set **Rule** to **Even-odd** in the **Style** panel.

The middle is now empty, and the two paths are still two paths: every node is
where you put it, and you can drag either ring afterwards.

No boolean does this. **Subtract** would rebuild the outline as one ring and
throw the inner nodes away, which looks similar until you try to edit it.

To take it apart again, select the shape and press **Split into shapes**, or
`Shift+K`. The hole becomes a filled shape, because a hole only exists while
both paths are in one shape.

## Line up and space out nodes

Select two or more nodes, then use the **Align** panel. Spacing them out needs three.

The six align buttons move the selection to a common left, centre, right, top,
middle or bottom. **Space H** and **Space V** distribute the middle nodes evenly
between the two outermost ones, which stay where they are.

## Bend a segment without touching its handles

Select both nodes at either end of the segment. A bend dot appears at its middle.

Drag the dot to bow the segment. `Ctrl+←` and `Ctrl+→` change the bend by keyboard,
with `Shift` for a finer step, and `Ctrl+↑` and `Ctrl+↓` change how taut it is.

The dot appears on every segment, curved or straight, and dragging it always
puts the curve through the pointer.

What happens to the handles depends on what they already were, the same way
dragging a handle does. On a segment whose two handles mirror each other, the
drag keeps them mirrored, and the **Bend** panel keeps describing it as two
numbers. On any other segment the drag moves both handles by as little as it
can, which leans the curve instead of bowing it. Hold `Alt` to get that second
behaviour on a symmetric segment.

The **Bend** panel shows the two numbers and lets you type them, for as long as
the segment is symmetric enough to have them. **Flat** returns the segment to a
straight line. **Free** hands control back to the handles.

## Rotate or scale by an exact amount

Use the **Transform** panel.

**Rotate −90°** and **Rotate +90°** are one press. For anything else, type into
**Angle** and press **Rotate**, or type a factor into **Scale** and press
**Apply**. Both work about the centre of the selection.

**Flip horizontal** and **Flip vertical** mirror the selection in place.

Transforms are baked into the coordinates, so the source box always shows what
is stored. There is no hidden `transform` attribute to read the numbers
through.

## Snap to a whole number of grid steps

Both are on by default in the **Grid** panel.

- **Snap to grid** rounds to the nearest multiple of **Step**.
- **Snap to points** welds to an existing node within 8 pixels, and beats the
  grid when both apply.

Moving a whole shape snaps the distance moved, not each node's position. A shape
whose nodes sit on the grid stays on it, and one that does not keeps its exact
offsets rather than being pulled onto the lattice.

Every grid line you can see is a position you can snap to. When you zoom out the
lattice thins rather than changing, and the readout says what you are looking at,
for example `1 · every 5 drawn`.

## Trace over an image

Drop an image file onto the canvas, or press **Load image** in the **Backdrop**
panel.

It appears under the drawing, scaled to fit the document and at half opacity, so
you can draw over it with the pen. **Opacity** dims it further; **Show** hides it
without unloading it.

To line it up, untick **Locked**. While unlocked, dragging on empty canvas moves
the image instead of selecting, which is what unlocking means. Tick it again when
you are done, or you will keep moving the reference instead of selecting nodes.
**X**, **Y** and **Width** place it exactly, and **Fit** puts it back in the
middle of the document. Width drives height, so it cannot be squashed.

The backdrop is not part of the drawing: it never appears in the Shapes list and
never reaches the export. It is covered by undo, so `Ctrl+Z` takes back a nudge
you did not mean and brings back an image you removed by accident. Opacity,
**Show** and **Locked** stay as you left them, since undo is for taking back an
edit rather than for restoring a checkbox. Nothing survives a page reload.

## Trace an image automatically

Load the image as a backdrop, then press **Trace** in the same panel.

You get one shape per colour, filled with that colour, with holes already cut.
The backdrop stays where it is, so switch **Show** off and on to compare.

Three numbers control it. **Colours** caps the palette: an icon usually wants two
or three, and asking for more finds antialiasing rather than detail. **Within**
is how far a fitted curve may move, in document units, and it is the same idea as
Simplify's tolerance; raise it for fewer, smoother nodes and lower it to keep the
shape honest. **Noise** drops small regions, which is what removes the specks
around a scanned line.

If the result has more nodes than you want, select the shapes and run **Simplify**
on them with a larger tolerance. Tracing and simplifying use the same fitter, so
the second pass is not fighting the first.

This is built for flat artwork. A photograph will trace and will give you
thousands of nodes in a handful of flat colours, which is a poster effect rather
than a vectorisation.

The editor stays live while a trace runs, so a large image no longer stops
everything for the several seconds it takes. What a dense result does cost
you is afterwards: past 2 000 node markers in view the overlay stops drawing
them, the document readout says `markers off, too dense`, and nodes cannot be
clicked until you zoom in far enough that fewer are on screen. The shapes
themselves are unaffected.

## Round off a corner

Select the corner node, set **Round** in the **Node** panel to the radius you
want, and press **Apply**.

The node is replaced by two, one where the arc meets each side, and the sides
stay exactly straight. Select several corners and they are all rounded at once.

Both sides of the node have to be straight. A fillet is defined by touching two
lines, and there is no honest version of it against a curve, so it refuses and
says why rather than leaving a kink where the arc nearly meets the curve.

If the radius is larger than a side can hold it is cut down to fit, and the
status line says so. To round every corner of a rectangle evenly, select all four
and apply once.

## Colour a shape

Select it, then set **Fill**, **Stroke** and **Width** in the **Style** panel on
the **Shape** tab. Tick **none** beside a colour for no fill or no stroke; the
picker stays usable while it is ticked, and choosing a colour clears it.

With nothing selected, the same controls set what the next shape you draw will
look like, so you can pick a colour once and draw three shapes in it. That is not
an edit to the drawing and records no undo step.

If a shape came from an imported file with a colour the picker cannot show, such
as a named colour or a gradient, the panel leaves it alone and names it in the
header rather than rounding it to black.

## Set the page the drawing exports to

The rectangle drawn on the canvas, with everything outside it dimmed, is the
page. It is what the exported file's `viewBox` says, and it decides how much
space the drawing takes up in whatever displays it.

- To choose a page first, type the **origin** and **size** into the **Canvas**
  panel. `0`, `0`, `24`, `24` is a 24 unit icon.
- To wrap the page around what you have already drawn, press **Fit canvas to
  drawing**. The result is rounded outwards to whole grid steps, so the numbers
  stay tidy and nothing gets cropped.

The page never moves on its own. If your drawing sits in one corner of it, the
exported file has it in one corner too, which is the usual reason a shape looks
small in a browser after it looked right here. The panel header says `drawing
goes outside` when part of the drawing is off the page.

## Resize or rotate something on the canvas

Select a shape, or two or more of its nodes. A dashed box appears with eight
square handles.

- Drag an edge handle to stretch one direction, a corner to change both.
- Hold `Shift` on a corner to keep the proportions.
- Hold `Alt` to scale about the centre instead of the opposite corner.
- Drag a handle past the far side to mirror.
- Move just outside a corner until the cursor changes, then drag to rotate.
  `Shift` snaps the turn to 15°.

The status line reads the scale or the angle as you drag and states the new size
when you let go. `Escape` abandons a drag you have thought better of, and the
whole drag is one `Ctrl+Z`.

Handles sit a little outside the shape on purpose, so a node on the edge of its
own bounding box is still clickable. The panel's **Transform** buttons do the
same work by number when you want an exact quarter turn or an exact factor.

## Thin out a path with too many nodes

Imported and traced paths often carry a node every few units. Every handle is
too short to grab and moving one node changes nothing you can see.

1. Select the shape.
2. Set **Within** in the **Draw** panel. It is how far the drawing may move, in
   document units, and it starts at roughly one screen pixel for the document you
   have open.
3. Tick **Redraw curves**. A traced path's nodes are not yours, so there is
   nothing to preserve, and this is the setting that gets the count right down.
4. Press **Simplify**.

The status line reports what happened: `Simplified 1 path: 40 nodes to 6.
Nothing moved further than 0.19.` If that is more change than you wanted, undo
and try a smaller number.

### Taking back nodes you added yourself

Double-clicking an outline adds a node without changing the curve, so that node
is carrying nothing. Set **Within** to **0** and press **Simplify**: it removes
exactly those and nothing else, because it can prove they cost nothing. A node
goes only when its two segments are pieces of the same curve.

Use it after an editing session to get back to the nodes that are holding the
shape. At 0 it cannot change the file you export, so it is safe to
run on anything.

Sharp corners are kept exactly where they are, so the points of a star and the
corners of a traced letter survive. Gentle wobbles do not. A path that already
uses the fewest nodes the tolerance allows is left alone and says so, rather than
being redrawn into the same node count from a guess.

## Move around the canvas

| To | Do |
|---|---|
| Zoom | Wheel, at the pointer |
| Pan sideways | `Shift`+wheel |
| Pan up and down | `Alt`+wheel |
| Pan freely | `Space`-drag, middle-drag, or the hand tool (`H`) |
| Get back to 100 % | Click the zoom readout at the bottom of the window |
| Fit everything on screen | The **Fit** button in the toolbar |

100 % means one document unit per pixel, which is the scale to check icon work
at. The hand tool exists because not every pointer has a middle button.

## Paste in a path from somewhere else

Press `Ctrl+E` to open the source drawer.

Choose the mode. **Path data** takes a bare `d` string. **SVG** takes a whole
document, including `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`
and `transform` attributes, all converted to paths on the way in.

Paste, then press **Apply**.

In **Path data** mode with one shape selected, Apply updates that shape. With
nothing selected it replaces the document, and the hint under the box tells you
which is about to happen.

## Get the smallest possible output

In the **Output** panel, set **Decimals** as low as the drawing tolerates and
tick **Minify**.

Decimals rounds the numbers, which does change the geometry, so check the
drawing afterwards. Minify only changes the spelling: it drops separators where
they are unambiguous, drops leading zeros, drops repeated command letters and
prefers relative commands when they are shorter.

```
off  M 10 30 L 25 15 L 40 30 Q 55 15 70 30
on   M10 30 25 15 40 30Q55 15 70 30
```

## Rename a shape and control its exported id

Double-click the name in the **Shapes** list, type, and press `Enter`. From the
keyboard, Tab to the list, pick the shape with the arrows, and press `F2`.

The name becomes the `id` on the exported `<path>`. An `id` is an XML Name, so
it cannot hold spaces or quotes and cannot start with a digit. Anything that will
not fit is hyphenated, a leading digit gains an `n`, and the status line tells you
what the export will read.

Two shapes may share a name. The export adds a numeric suffix to the second, so
the file stays valid.
