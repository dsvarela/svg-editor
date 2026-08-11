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
| Drag the bend dot | Bow a segment. Appears when both its end nodes are selected |
| Wheel | Zoom at the pointer |
| `Shift`+wheel | Pan sideways |
| `Alt`+wheel | Pan up and down |
| `Space`-drag, or middle-drag | Pan, from any tool |

## Keyboard

| Key | Effect |
|---|---|
| `V` `P` `E` `R` `H` | Select, pen, ellipse, rectangle, hand |
| Arrows | Nudge by one grid step |
| `Shift`+arrows | Nudge by ten steps |
| `Ctrl`+`←` `→` | Bend the active segment. `Shift` for a finer step |
| `Ctrl`+`↑` `↓` | Loosen or tighten the bend |
| `Delete` `Backspace` | Delete selected nodes, or selected shapes |
| `Shift`+`B` | Break the path at the selected node |
| `Shift`+`J` | Connect two selected free ends with a segment |
| `Shift`+`M` | Merge two selected free ends into one node |
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
| Fit | Fit the document to the canvas |
| Source | Open or close the source drawer |
| Inspector | Collapse or restore the right-hand panel |
| Theme | Cycle system, light and dark |

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
- **Duplicate** copies the selected shapes, naming each copy after its original.
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

### Draw

- **Corner** sets the radius the rectangle tool rounds with. Clamped to half the
  shorter side of whatever you draw.
- **Circularise** fits a circle through the selected path's nodes and moves each
  onto it.
- **Within** is how far Simplify may move the drawing, in document units. It
  starts at about one screen pixel for the document you have open and stops
  following it once you type your own number.
- **Simplify** refits the selected paths with as few nodes as **Within** allows.
  Corners are kept. The status line reports the node count before and after, and
  the furthest anything actually moved.

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
- **Delete node** removes it, following the **Delete** panel's mode.

### Bend

Shows the active segment's bend as two numbers: how far it bows from the chord,
and how taut it is.

- **Angle** and the two `Ctrl`+arrow pairs adjust them.
- **Flat** makes the segment straight.
- **Free** returns control to the handles.

### Align

Six align buttons for left, centre, right, top, middle, bottom. **Space H** and
**Space V** distribute the middle nodes evenly between the outermost two. Needs
three or more nodes.

### Delete

How deleting a node treats the path around it.

| Mode | Deleting the middle node of `M10 30 L25 15 L40 30 L55 15 L70 30` |
|---|---|
| **Fuse** (default) | `M10 30 L25 15 H55 L70 30`, still one path |
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

### Grid

| Control | Does |
|---|---|
| **Step** | The snap interval, in document units |
| **Show grid** | Draw the lattice |
| **Snap to grid** | Round positions to a multiple of Step |
| **Snap to points** | Weld to an existing node within 8 pixels. Beats the grid |
| **Show handles** | Draw handles and their lines |
| **Show fills** | Draw each shape's fill. Off draws everything as an outline |

The readout in the group header says what is drawn against what is snapped, for
example `1 · every 5 drawn`.

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

**Apply** parses and applies. **Copy** puts the text on the clipboard.
**Download** saves it to a file. **Close** closes the drawer.

## Status strip

Along the bottom, left to right: the shape, node and segment counts; the grid
readout; the zoom; the status line; the pointer's document coordinates.

**Zoom** is the magnification, so 100 % means one document unit per pixel. Click
it to go back to 100 % about the centre of the view.

## What is read on import and what is written on export

Read: `M m L l H h V v C c S s Q q T t A a Z z`, the six shape elements above,
`transform`, `fill`, `fill-rule`, `stroke`, `stroke-width`, `viewBox`.

Written: `M L H V C S Z`, absolute or relative depending on which is shorter when
minifying, plus `fill`, `fill-rule`, `stroke`, `stroke-width` and an `id` taken
from the shape's name.

Arcs and quadratics are converted to cubics on the way in. That conversion is one
way: a shape imported as an `A` comes back out as a `C`.

Ids are made unique within the document, and every attribute value is escaped, so
an exported file always re-opens.

## Known limits

Named here rather than left for you to find.

- **Fuse across an inflection.** Deleting a node whose two segments curve
  opposite ways rebuilds them as one that visibly differs. Use **Split** or
  **Break here** when the curve matters.
- **Arcs do not survive a round trip.** See above.
- **Circularise is a least-squares fit.** It cannot know which node was the
  mistake, so with few nodes and one big outlier it moves the whole circle rather
  than restoring the original radius. The reported travel is how it tells you.
- **A wide gap circularises loosely.** One curve cannot hold an arc much wider
  than a quarter turn tightly. The status line says when this applies.
- **Coincident nodes.** A rectangle drawn at the maximum corner radius, and a
  circularised path that had a node at its centre, can both end up with two
  anchors in the same place. **Merge** only works on free ends, so there is no
  way to fuse them yet.
- **The backdrop does not survive a reload.** Everything else about it is
  undoable; this is not, because nothing here is saved between sessions.
- **Simplify checks the tolerance where it samples.** Sampling is dense, and
  denser than the tolerance, so the gap is small. It is not zero, and a path with
  extreme curvature between samples can move a little further than the number you
  typed.
- **Anchors are a fixed size on screen,** so zooming out shrinks the drawing
  while they stay put and crowd it. Handles closer to their node than the node's
  own marker are dropped, which thins it out, but the anchors are always drawn.

Full detail on all of these is in
[`docs/REVIEW-2026-08-11.md`](../REVIEW-2026-08-11.md).
