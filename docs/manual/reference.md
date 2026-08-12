# Reference

Every control, and what it does. Dry and complete.

## Tools

| Tool | Key | What it does |
|---|---|---|
| Select | `V` | Select and drag nodes, handles, outlines and marquees |
| Pen | `P` | Click to place nodes. Click the first node to close the path, or either end of an existing open path to carry on drawing it |
| Ellipse | `E` | Drag out an ellipse |
| Rectangle | `R` | Drag out a rectangle |
| Hand | `H` | Drag to pan. `Space`-drag does the same from any tool |

`Shift` while drawing constrains an ellipse to a circle and a rectangle to a
square, by taking the shorter span of the drag. `Alt` reads the point you pressed
as the centre rather than a corner.

## Mouse

| Action | Effect |
|---|---|
| Click a node | Select it. Its handles appear, including ghost handles you can pull out |
| Drag a node | Move it, carrying its handles |
| Drag a handle | Move it, preserving whatever relationship the pair already had |
| `Alt`-drag a handle | Move it alone, breaking the pair |
| Drag an outline | Move the shape, and everything else selected with it |
| Double-click an outline | Insert a node there, without changing the curve |
| Double-click a node | Cycle corner, smooth, symmetric |
| Drag a box handle | Scale the selection. `Shift` keeps the proportions, `Alt` works from the centre |
| Drag just outside a corner | Rotate the selection. `Shift` snaps to 15° |
| Drag on empty canvas | Marquee-select nodes |
| `Shift`-click | Add to or remove from the selection |
| Drag the bend dot | Pull the curve through the pointer. Appears on every segment with both its end nodes selected |
| `Alt`-drag the bend dot | The same, but without keeping a symmetric segment symmetric |
| Wheel | Zoom at the pointer |
| `Shift`+wheel | Pan sideways |
| `Alt`+wheel | Pan up and down |
| `Space`-drag, or middle-drag | Pan, from any tool |

## Keyboard

| Key | Effect |
|---|---|
| `V` `P` `E` `R` `H` | Select, pen, ellipse, rectangle, hand |
| Arrows | Nudge by one grid step |
| `Shift`+arrows | Nudge by the coarse step: the grid step times **Shift &times;**, which defaults to 10 |
| `Ctrl`+`←` `→` | Bend the active segment. `Shift` for a finer step |
| `Ctrl`+`↑` `↓` | Loosen or tighten the bend |
| `Delete` `Backspace` | Delete selected nodes, or selected shapes |
| `Shift`+`B` | Break the path at the selected node |
| `Shift`+`J` | Connect two selected free ends with a segment |
| `Shift`+`M` | Merge two selected free ends into one node |
| `Shift`+`F` | Fuse two adjacent nodes, or sweep a shape for zero-length segments |
| `Shift`+`R` | Reverse the selected paths |
| `Shift`+`P` | Make the selected shapes into one shape, changing no geometry |
| `Shift`+`K` | Split the selected shapes, giving each path a shape of its own |
| `Shift`+`C` `S` `Y` | Make every selected node a corner, smooth, or symmetric |
| `Escape` | Abandon the drag in progress, or finish the pen path and clear the selection |
| `Enter` | Finish the current pen path |
| `Ctrl`+`Z` | Undo |
| `Ctrl`+`Shift`+`Z` | Redo |
| `Ctrl`+`E` | Open or close the source drawer |
| `Ctrl`+`B` | Open or close the inspector |

Single-letter shortcuts do nothing while a modifier is held, so `Ctrl+E` opens
the drawer without also selecting the ellipse tool. They also do nothing while
a text field has focus.

A drag is one undo step, however many frames it took.

## Toolbar

Left to right.

| Control | Does |
|---|---|
| Tool group | The four tools above |
| Undo, Redo | History, 200 steps deep |
| Curve, Straight | Curve or straighten the segments between selected nodes |
| Delete | Delete the selection, following the **Delete** panel's mode |
| Zoom out, Zoom in | Zoom about the centre of the view |
| Fit | Fit the drawing on screen |
| Source | Open or close the source drawer |
| Inspector | Collapse or restore the right-hand panel |
| Theme | Invert the theme, light against dark |

## Inspector panels

Three tabs, split by what a control acts on.

| Tab | Holds |
|---|---|
| **Shape** | Shapes, Style, Combine, Draw, Transform |
| **Node** | Node, Bend, Align, Delete |
| **Document** | Canvas, Grid, Backdrop, Output |

Nothing switches tab on its own. Arrow keys move between the tabs once one has
focus.

### Shapes

The list of shapes, newest last, with a colour swatch and a node count.

- Click a name to select it. `Shift`-click to add.
- Double-click a name to rename it.
- With the list focused, arrows move the selection (`Shift` extends it), and
  `F2` or `Enter` starts a rename.
- **Duplicate** copies the selected shapes, offset by two grid steps and named after their originals.
- **Delete** removes them.

### Style

Fill, stroke, width and fill rule for the selected shapes. A node selection
styles the shape it belongs to, since style is a property of the whole path.

| Control | Does |
|---|---|
| **Fill** | The colour inside. Tick **none** for no fill |
| **Stroke** | The colour of the line. Tick **none** for no stroke |
| **Width** | Stroke width in document units |
| **Rule** | **Nonzero** fills overlapping subpaths; **Even-odd** punches holes where they overlap |

With nothing selected these set what the next shape you draw will look like. That
is not an edit to the drawing, so it records no undo step, and the header says
`for new shapes` when it applies.

The colour pickers stay usable while **none** is ticked, and picking a colour
clears it. A colour the picker cannot show, such as a named colour or a gradient
from an imported file, is left alone and named in the header instead.

### Combine

**Unite**, **Subtract**, **Intersect**, **Exclude**. Needs two or more shapes.
The first selected survives with its name and style, and **Subtract** removes
the rest from it.

**Make one shape** (`Shift+P`) also needs two or more, and is the odd one out:
it changes no geometry. The four booleans work out what region the shapes cover
and rebuild the outline from the answer, which discards every node that fell
inside. This one moves the paths into a single shape and leaves each of them
exactly as it was, so the node you placed is still the node you placed.

What fills is then up to **Rule** in the Style panel. Under **Nonzero** the
shape looks the same as before. Under **Even-odd** a path inside another
becomes a hole. This is the only way to make a hole here, because no boolean
can produce one.

**Split into shapes** (`Shift+K`) is the way back. It gives every path in the
selected shapes a shape of its own, and it is enabled whenever one selected
shape holds more than one path, which can be true of a single shape.

The first path keeps the original shape, with its id and name, and the rest are
numbered after it and inserted directly behind, so nothing changes paint order.
Every piece takes the original's fill, stroke and width.

A hole does not survive the trip. A hole is a relationship between two paths in
one shape, so once they are two shapes the inner one is a filled shape again.
Undo is the exact inverse of **Make one shape**; this is the useful one.

### Draw

- **Corner** sets the radius the rectangle tool rounds with. Clamped to half the
  shorter side of whatever you draw.
- **Circularise** fits a circle through the selected path's nodes and moves each
  onto it.
- **Within** is how far Simplify may move the drawing, in document units. It
  starts at about one screen pixel for the document you have open and stops
  following it once you type your own number.
- **Simplify** removes nodes from the selected paths. **Within** decides how
  much of the shape it may give up, and **Redraw curves** decides whether it may
  replace your curves as well as drop nodes. The status line reports the node
  count before and after, and the furthest anything moved.

  **Within 0 is a real setting, not a refusal.** It means move nothing, and what
  it removes is every node that cannot change the exported file. A node counts
  as doing nothing when its two segments are pieces of the same curve, which is
  exactly what a node added by double-clicking an outline is. Run it on anything:
  it cannot change a character of what you save.

  Above zero it also gives up nodes that carry a little of the shape, and the
  drawing moves by at most the number you typed.

  **Redraw curves** is off by default and is the only thing here that invents
  geometry. Left off, every node that survives is one you placed. Turn it on for
  a traced path carrying a node every few units, where the nodes are not yours
  and there is nothing to preserve.

  Corners are never removed whatever you choose. No single curve replaces two
  sides of a corner, so no tolerance makes one redundant.

- **Reverse** (`Shift+R`) walks the selected paths the other way round. The
  drawing does not move. Direction is what decides winding under `nonzero`, and
  which end of a path a marker lands on. A closed path keeps its start node, so
  only the direction changes; an open one swaps its ends, because that is what
  reversing it means. Whatever you had selected stays selected.

### Node

Live coordinates for the selected node and its two handles. Type into any field
to set it exactly.

- **Corner**, **Smooth**, **Symm** show what the handles currently say, and set
  it when pressed.
- **Round** with **Apply** replaces the selected corners with an arc of that
  radius. Both sides of the node have to be straight.
- **Break here** duplicates the node to cut the path there.
- **Connect** draws the missing segment between two free ends. Nothing moves.
- **Merge** welds two free ends into one node at their midpoint, the inverse of Break.
- **Fuse** welds two adjacent nodes into one, anywhere along a path. With a shape
  selected instead of a pair, it sweeps that shape for segments of zero length
  and welds those. Two free ends are the one case it declines, because that is
  Merge.
- **Delete node** removes it, following the **Delete** panel's mode.

### Bend

Shows the active segment's bend as two numbers: how far it bows from the chord,
and how taut it is. A segment whose handles do not mirror each other has no such
pair: the panel reads `free handles` and the two numbers are unavailable. It can
still be dragged by its dot.

- **Angle** and the two `Ctrl`+arrow pairs adjust them.
- **Flat** makes the segment straight.
- **Free** returns control to the handles.

### Align

Six align buttons for left, centre, right, top, middle, bottom, which need two
or more nodes. **Space H** and **Space V** distribute the middle nodes evenly
between the outermost two, and need three.

### Delete

How deleting a node treats the path around it.

| Mode | Deleting the middle node of `M10 30 L25 15 L40 30 L55 15 L70 30` |
|---|---|
| **Heal** (default) | `M10 30 L25 15 H55 L70 30`, still one path |
| **Split** | `M10 30 L25 15 M55 15 L70 30`, two ends |

**Break here** is neither. It keeps the node and duplicates it, so nothing moves.

### Transform

**Rotate −90°**, **Rotate +90°**, **Flip horizontal**, **Flip vertical**, plus an
**Angle** field with **Rotate**, and a **Scale** factor with **Apply**. All work
about the centre of the selection, and all are baked into the coordinates.

### Backdrop

A raster image shown under the drawing, to trace over. Load it with the button
or by dropping a file onto the canvas.

| Control | Does |
|---|---|
| **Load image** | Choose a file. Dropping one on the canvas does the same |
| **Opacity** | 0 to 100. Starts at 50 |
| **Show** | Hide it without unloading it |
| **Locked** | While unlocked, dragging empty canvas moves the image instead of selecting |
| **X**, **Y** | Position in document coordinates |
| **Width** | Size. Height follows, so the aspect ratio is kept |
| **Fit** | Scale it to fit the document and centre it |
| **Remove** | Unload it |

It is workspace state, not document content: no entry in the Shapes list and
nothing in the export. It is still on the undo stack, so loading, moving,
resizing and removing an image are all ordinary edits that `Ctrl+Z` takes back.
Opacity, **Show** and **Locked** are not: they say how you want to look at the
reference, and undo leaves them alone. Nothing survives a reload.

### Trace

Turn the loaded backdrop into shapes, one per colour.

| Control | Does |
|---|---|
| **Colours** | How many colours to keep. The commonest are kept and everything else is assigned to its nearest |
| **Within** | How far a fitted curve may move, in document units. 0 keeps the raw polygons |
| **Noise** | Regions with fewer boundary points than this are dropped |
| **Trace** | Run it |

Traced shapes land on top of the backdrop, which stays where it is so you can
compare the two. Each shape is filled with its own colour and has no stroke;
holes come back as extra paths inside the same shape, under **Even-odd**. A fully transparent
background is dropped, since it would export an invisible shape; an opaque one is
kept, because it is part of the picture.

The whole trace is one undo step. The status line reports how many boundary
points went in and how many nodes came out, which is usually a factor of ten or
more: a 64-pixel icon of a disc with a hole traces to 344 points and fits to 19
nodes.

The image is traced at its own pixel size, whatever you have scaled it to on
screen, so shrinking a reference to line it up does not cost you detail. This is
built for flat artwork: icons, logos, line drawings. A photograph will trace, and
will give you thousands of nodes in a handful of flat colours.

### Canvas

The page the drawing sits on, and the `viewBox` the exported file carries. It is
drawn on screen as a rectangle, with everything outside it dimmed.

| Control | Does |
|---|---|
| **origin** | The top left corner, in document units |
| **size** | Width and height. Both must be above zero |
| **Fit canvas to drawing** | Wrap the page around everything drawn, rounded outwards to whole grid steps |

The canvas never changes on its own. Drawing outside it is allowed and leaves it
alone, and the panel header says `drawing goes outside` when something is out
there. Every change here is undoable.

### Guides

| Control | Does |
|---|---|
| **Rulers** | Show the rulers along the top and left |
| **Show guides** | Draw the guides, and let the tools snap to them |
| **Lock guides** | Stop guides being dragged, so a press near one edits the drawing |
| **at** | The position a new guide goes at |
| **Vertical**, **Horizontal** | Place a guide there |
| **Clear guides** | Remove every guide |

A guide is a straight line you place and then aim at. It reaches across the whole
view rather than stopping at the page, and it holds one coordinate fixed: a
vertical guide is at an `x`, a horizontal one at a `y`.

To place one with the pointer, turn the rulers on and drag out of either: the top
ruler gives horizontal guides, the left one vertical. Drag a guide off the canvas
to put it away. To place one exactly, type the number and press **Vertical** or
**Horizontal**, which is also the route that needs no pointer.

The tools snap to a guide the way they snap to an outline. Where two guides
cross they make a point, which beats either line on its own, so a pair of them
places a node exactly.

Guides are never part of the export. Placing, moving and removing one are all
undoable, and a drag is one step.

### Keylines

| Control | Does |
|---|---|
| **Show keylines** | Draw the icon grid, and let the tools snap to it |

The icon grid is a circle, a square and two rectangles sharing a centre, in
Material's proportions, with the live area dashed around them. A square reads
heavier than a circle of the same width, so the circle is drawn larger; drawing
every icon in a set to these keeps the set at one optical weight.

They come from the canvas, so there is nothing to place and nothing to move. On
a 24-unit page you get the published 24dp grid to the unit: live area 20, square
18, circle 20, rectangles 16 by 20. On a page that is not square the grid is
inscribed on the shorter side and centred, since a stretched circle would be no
use as a circle.

Keylines are never part of the export. They are worked out from the canvas each
time it is drawn, so there is nothing in the file to leave behind.

The panel header gives the sizes for your page. While the keylines are shown the
tools snap to them, in the same tiers as anything else: a corner is a node, an
edge is an outline, and the drawing wins where both are in reach.

### Grid

| Control | Does |
|---|---|
| **Step** | The snap interval, in document units. Also the distance one arrow key moves things |
| **Shift &times;** | How much further an arrow key moves with `Shift` held. 10 by default |
| **Show grid** | Draw the lattice |
| **Snap to grid** | Round positions to a multiple of Step |
| **Snap to points** | Weld to an existing node within 8 pixels |
| **Snap to outlines** | Weld to a point *on* an existing curve, not only to its anchors |
| **Pixel fit** | Shift the lattice by half the stroke width, so the stroke's edges land on whole pixels |
| **Show handles** | Draw handles and their lines |
| **Show fills** | Draw each shape's fill. Off leaves each shape's own stroke, so a filled shape with no stroke becomes invisible |
| **Wireframe** | Draw every shape as a plain one-pixel outline, ignoring its own fill and stroke. The switch for the case above, and for picking apart shapes stacked on top of each other |

Three things can claim the pointer, and the most specific one within reach wins:
a **node** beats an **outline** beats the **grid**. Distance does not break ties
between them, so a node seven pixels away still beats a gridline one pixel away.
Nothing reaches further than eight screen pixels except the grid, which is
everywhere.

The `xy` readout shows that target's own coordinates rather than the pointer's,
so you can see where a click would land before you make it, and the readout
immediately to its left names whichever tier claimed it. They are two readouts
rather than one so that a tier coming into reach cannot move the digits you are
reading. The grid is never named that way, since it is already drawn.

The `grid` readout in the status strip says what is drawn against what is
snapped, for example `1 · every 5 drawn`. The group's own header says whether
snapping is on.

**Pixel fit** exists because a stroke is painted centred on its path. A 1-unit
stroke on a whole coordinate covers half of one pixel and half of the next, which
is grey where you wanted black. Ticking it shifts the grid by half the stroke
width: half-pixels for a width of 1 or 3, whole pixels for 2 or 4. The drawn grid
moves with it, so what you see is still what you snap to.

The shift follows what is selected, except while a drawing tool is chosen, when
it follows the width you are about to draw with. The header says which is in
force: `half pixels` for an odd stroke width, `whole pixels` for an even one,
`offset 0.75` and the like for a fractional width, or `mixed widths` when the
selection holds shapes that want different lattices, in which case the plain grid
stands and **Fit selection to pixels** is unavailable. Otherwise **Fit selection
to pixels** applies the same lattice to a shape that already exists.

### Output

- **Decimals** rounds the numbers in the output. This changes the geometry.
- **Minify** shortens the spelling only. Drops unnecessary separators and leading
  zeros, drops repeated command letters, and prefers relative commands when they
  are shorter.

## The transform box

Select a shape, or two or more of its nodes, and a dashed box appears around it
with eight square handles.

| To | Do |
|---|---|
| Scale in one direction | Drag a handle on an edge |
| Scale in both | Drag a corner handle |
| Keep the proportions | Hold `Shift` while dragging a corner |
| Scale about the centre | Hold `Alt` |
| Mirror | Drag a handle past the opposite side |
| Rotate | Drag just outside a corner, where the cursor turns |
| Rotate in steps of 15° | Hold `Shift` while rotating |
| Abandon the drag | `Escape` |

The status line reads out the scale or the angle while you drag, and states the
new size when you let go. The whole drag is one undo step.

Handles are drawn a few pixels outside the true bounds, so a node sitting on the
edge of its own bounding box stays clickable. The box does not appear for a
single node, which has no extent to scale, or in the pen and shape tools, which
own the canvas while they are active.

## Source drawer

`Ctrl+E`, or the **Source** button.

Two modes.

- **Path data** is a bare `d` string. With one shape selected, **Apply** updates
  that shape; with nothing selected it replaces the document. The hint under the
  box says which.
- **SVG** is a whole document. Import understands `path`, `rect`, `circle`,
  `ellipse`, `line`, `polyline`, `polygon`, and `transform` attributes, all
  converted to paths.

**Apply** parses and applies. It refuses text that cannot be parsed, and also
text that parses to nothing drawable, such as a lone `M 0 0`: either way the
drawing is left as it was and what you typed is left as you typed it, because
the error names an offset into that text. **Revert** puts the document's own
text back when you want to start again. **Copy** puts the text on the
clipboard.
**Download SVG** saves a whole SVG document, in either mode. **Close** closes the drawer.

## Status strip

Along the bottom, left to right: the shape, node and segment counts; the grid
readout; the zoom; the status line; the name of the snap tier under the pointer;
the measurement, described below; the `xy` readout, described under Grid above.

The counts gain `markers off, too dense` when the document has more than 2 000
node markers inside the camera. The overlay draws none at all in that case: a
marker is something you aim at, and at that density they are neither aimable nor
affordable. Zoom in until fewer are in view and they come back.

**Zoom** is the magnification, so 100 % means one document unit per pixel. Click
it to go back to 100 % about the centre of the view.

### The measurement

A slot that is empty until you drag something, and reports one of two things.

| Reading | When | Means |
|---|---|---|
| `drag 15 at 0°` | Moving a shape, a node, a handle or the backdrop | How far it went, and which way |
| `size 40 × 20` | Drawing a rectangle or ellipse, or sweeping a marquee | The width and height of the box |

The measurement is of the drawing, not of the pointer. With snapping on, a shape
that lands two grid steps away reads two steps even though the pointer stopped
between them. This is the number you can act on: it is what the document now
says.

Angles run clockwise from east, so 90° points down the screen and -90° points up.
That matches the rotation readout, which means an edge you draw at 30° and a
shape you rotate by 30° agree with each other.

Panning is silent, because it moves the camera and not the drawing. Scaling and
rotating are silent here too, because they report themselves in the status line
to the left.

## What is read on import and what is written on export

Read: `M m L l H h V v C c S s Q q T t A a Z z`, the six shape elements above,
`transform`, `fill`, `fill-rule`, `stroke`, `stroke-width`, `viewBox`.

Written: `M L H V C S Q Z`, absolute or relative depending on which is shorter when
minifying, plus `fill`, `fill-rule`, `stroke`, `stroke-width` and an `id` taken
from the shape's name.

Arcs and quadratics are converted to cubics on the way in. That conversion is one
way: a shape imported as an `A` comes back out as a `C`.

Ids are made unique within the document, and every attribute value is escaped, so
an exported file always re-opens.

## Known limits

Named here rather than left for you to find.

- **Healing across an inflection.** Deleting a node whose two segments curve
  opposite ways rebuilds them as one that visibly differs. Use **Split** or
  **Break here** when the curve matters.
- **Arcs do not survive a round trip.** See above.
- **Circularise is a least-squares fit.** It cannot know which node was the
  mistake, so with few nodes and one big outlier it moves the whole circle rather
  than restoring the original radius. The reported travel is how it tells you.
- **A wide gap circularises loosely.** One curve cannot hold an arc much wider
  than a quarter turn tightly. The status line says when this applies.
- **A traced photograph makes a document too dense to edit.** Tracing runs in a
  worker, so the editor stays live while it works, and the walk itself is no
  longer what costs the time. What costs it is the result: a 400 by 400
  photograph at the defaults comes back as 3 695 paths and 23 454 nodes, and a
  document that size takes about a tenth of a second to redraw whatever you do
  to it. Above 2 000 node markers in view the overlay stops drawing them and the
  document readout says `markers off, too dense`; the shapes are all still
  there, but you cannot click a node until you zoom in far enough for the
  markers to come back. A document that size redraws in about 20 ms rather than
  the 130 ms it once took, so it is workable, but it is not what this editor is
  shaped for. Tracing is for flat artwork. For a photograph, fewer colours and a
  higher **Noise** floor are the controls that help.
- **A feature one pixel wide loses its corners when traced.** The pass that keeps
  right angles sharp needs two straight lattice steps on each side of a corner,
  so a 1 px line or dot has none and comes back as a diamond of half the area.
  Two pixels and up are exact.
- **A fractional stroke width cannot be crisp.** Pixel fit aligns the leading
  edge, and the two edges are a stroke width apart, so unless that width is a
  whole number the other edge lands mid-pixel. Nothing can do better.
- **The backdrop does not survive a reload.** Everything else about it is
  undoable; this is not, because nothing here is saved between sessions.
- **Redraw curves checks the tolerance where it samples.** Sampling is dense,
  and denser than the tolerance, so the gap is small. It is not zero, and a path
  with extreme curvature between samples can move a little further than the
  number you typed. With the box off nothing is sampled at all, and the limit is
  a bound rather than a measurement.
- **Anchors are a fixed size on screen,** so zooming out shrinks the drawing
  while they stay put and crowd it. Handles closer to their node than the node's
  own marker are dropped, which thins it out, but the anchors are always drawn.

Why each of these is a limit rather than a bug, with the measurements, is in
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#known-limitations).
