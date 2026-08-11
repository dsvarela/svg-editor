# Reference

Every control, and what it does. Dry and complete.

## Tools

| Tool | Key | What it does |
|---|---|---|
| Select | `V` | Select and drag nodes, handles, outlines and marquees |
| Pen | `P` | Click to place nodes; click the first node to close the path |
| Ellipse | `E` | Drag out an ellipse |
| Rectangle | `R` | Drag out a rectangle |

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
| Drag on empty canvas | Marquee-select nodes |
| `Shift`-click | Add to or remove from the selection |
| Drag the bend dot | Bow a segment. Appears when both its end nodes are selected |
| Wheel | Zoom at the pointer |
| `Space`-drag, or middle-drag | Pan |

## Keyboard

| Key | Effect |
|---|---|
| `V` `P` `E` `R` | Select, pen, ellipse, rectangle |
| Arrows | Nudge by one grid step |
| `Shift`+arrows | Nudge by ten steps |
| `Ctrl`+`←` `→` | Bend the active segment. `Shift` for a finer step |
| `Ctrl`+`↑` `↓` | Loosen or tighten the bend |
| `Delete` `Backspace` | Delete selected nodes, or selected shapes |
| `Shift`+`B` | Break the path at the selected node |
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

### Shapes

The list of shapes, newest last, with a colour swatch and a node count.

- Click a name to select it. `Shift`-click to add.
- Double-click a name to rename it.
- **Duplicate** copies the selected shapes, naming each copy after its original.
- **Delete** removes them.

### Combine

**Unite**, **Subtract**, **Intersect**, **Exclude**. Needs two or more shapes.
The first selected survives with its name and style, and **Subtract** removes
the rest from it.

### Draw

- **Corner** sets the radius the rectangle tool rounds with. Clamped to half the
  shorter side of whatever you draw.
- **Circularise** fits a circle through the selected path's nodes and moves each
  onto it.

### Node

Live coordinates for the selected node and its two handles. Type into any field
to set it exactly.

- **Corner**, **Smooth**, **Symm** show what the handles currently say, and set
  it when pressed.
- **Break here** duplicates the node to cut the path there.
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

### Grid

| Control | Does |
|---|---|
| **Step** | The snap interval, in document units |
| **Show grid** | Draw the lattice |
| **Snap to grid** | Round positions to a multiple of Step |
| **Snap to points** | Weld to an existing node within 8 pixels. Beats the grid |
| **Show handles** | Draw handles and their lines |
| **Filled** | Render shapes filled rather than as outlines |

The readout in the group header says what is drawn against what is snapped, for
example `1 · every 5 drawn`.

### Output

- **Decimals** rounds the numbers in the output. This changes the geometry.
- **Minify** shortens the spelling only. Drops unnecessary separators and leading
  zeros, drops repeated command letters, and prefers relative commands when they
  are shorter.

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
readout; the status line; the pointer's document coordinates.

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
- **Clicking inside the rename field changes the selection.** Rename works; the
  side effect on the selection is a known defect.
- **No keyboard route to the shape list.** Renaming and selecting a shape from
  the list both need a pointer.
- **The selection outline is drawn in document units,** so its dashes look coarse
  when you zoom far out.

Full detail on all of these is in
[`docs/REVIEW-2026-08-11.md`](../REVIEW-2026-08-11.md).
