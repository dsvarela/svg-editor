# Reference

Every control, and what it does. Dry and complete.

## Tools

| Tool | Key | What it does |
|---|---|---|
| Select | `V` | Select and drag nodes, handles, outlines and marquees |
| Pen | `P` | Click to place nodes. Click the first node to close the path, or either end of an existing open path to carry on drawing it |
| Ellipse | `E` | Drag out an ellipse |
| Rectangle | `R` | Drag out a rectangle |
| Polygon | `N` | Drag out a regular polygon or a star |
| Hand | `H` | Drag to pan. `Space`-drag does the same from any tool |

`Shift` while drawing constrains an ellipse to a circle and a rectangle to a
square, by taking the shorter span of the drag. `Alt` reads the point you pressed
as the centre rather than a corner.

The polygon's key is `N`, for n-gon. Its initial was taken twice over: `P` is the
pen and `Shift`+`G` widens a selection to its group, so `G` one Shift away would
have meant something unrelated.

## Pointer

| Action | Effect |
|---|---|
| Click inside a shape | Select it, anywhere its fill is drawn. A shape with no fill, or one seen in wireframe, is caught by its outline instead |
| Click a node | Select it. Its handles appear, including ghost handles you can pull out |
| Drag a node | Move it, carrying its handles |
| Drag a handle | Move it, preserving whatever relationship the pair already had |
| `Alt`-drag a handle | Move it alone, breaking the pair |
| Drag an outline | Move the shape, and everything else selected with it |
| Double-click an outline | Insert a node there, without changing the curve |
| Double-click a node | Cycle cusp, smooth, symmetric |
| Drag a box handle | Scale the selection. `Shift` keeps the proportions, `Alt` works from the centre |
| Drag just outside a corner | Rotate the selection. `Shift` snaps to 15° |
| Drag on empty canvas | Marquee-select nodes |
| `Shift`-click | Add to or remove from the selection |
| Drag the corner control | Round the corner, or change the radius of one already rounded. Drag it back to the corner to square it off again |
| Drag the bend dot | Pull the curve through the pointer. Appears on every segment with both its end nodes selected |
| `Alt`-drag the bend dot | The same, but without keeping a symmetric segment symmetric |
| Wheel | Zoom at the pointer |
| `Shift`+wheel | Pan sideways |
| `Alt`+wheel | Pan up and down |
| `Space`-drag, or middle-drag | Pan, from any tool |
| Two fingers | Zoom about the point between them, and pan as that point moves |
| **Shift** and **Alt** in the status strip | Hold the key without a keyboard. They stay held until pressed again, and apply to the pointer rows above: dragging, clicking, and the box handles. Not the wheel, and not the keyboard |

The two-finger row and the two latch buttons are built and tested, but only in a
headless browser. Nobody has yet used this editor on a phone or a tablet, so
treat those two rows as untried rather than as reported working.

## Keyboard

| Key | Effect |
|---|---|
| `V` `P` `E` `R` `N` `H` | Select, pen, ellipse, rectangle, polygon, hand |
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
| `Shift`+`C` `S` `Y` | Make every selected node a cusp, smooth, or symmetric |
| `[` `]` | Select the node before or after this one along the path |
| `Shift`+`[` `]` | Add it to the selection instead of replacing |
| `Shift`+`I` | Insert a node in the segment between the two selected nodes |
| `Escape` | Abandon the drag in progress, or finish the pen path and clear the selection |
| `Enter` | Finish the current pen path |
| `Ctrl`+`Z` | Undo |
| `Ctrl`+`Shift`+`Z` | Redo |
| `Ctrl`+`C` | Copy the selected shapes, or the selected nodes as pieces of path |
| `Ctrl`+`X` | Copy the selection, then delete it |
| `Ctrl`+`V` | Put the last copy back, offset from the one before it |
| `Ctrl`+`G` | Put the selected shapes in a group |
| `Ctrl`+`Shift`+`G` | Take the selected shapes out of their group, one level |
| `Shift`+`G` | Widen the selection to the group it is in, one level |
| `Shift`+`T` | Do the last move, rotate or scale again |
| `Ctrl`+`]` `[` | Move the selection one step later or earlier in the paint order |
| `Ctrl`+`Shift`+`]` `[` | Move it in front of or behind everything |
| `Ctrl`+`E` | Open or close the source drawer |
| `Ctrl`+`B` | Open or close the inspector |

Single-letter shortcuts do nothing while a modifier is held, so `Ctrl+E` opens
the drawer without also selecting the ellipse tool. They also do nothing while
any field has focus, which is what lets you type `v` into a shape's name.

`Ctrl`+`Z` is the exception. It reaches the document from inside a number, a
colour or a checkbox, because none of those carries an edit history of its own:
a change made in one is already a single step in the document's history, so
undoing is the only thing the key could mean there. Somewhere you type text --
the source box, a name, a colour's hex -- it undoes the typing instead.

Undoing from a field takes focus out of it first. A number you typed and had not
committed is committed and then undone, so one press puts back the value it
replaced.

`Ctrl`+`C`, `Ctrl`+`X` and `Ctrl`+`V` stay with the field throughout: inside one
they copy and paste the text, and never the drawing.

A drag is one undo step, however many frames it took.

## Toolbar

Left to right.

| Control | Does |
|---|---|
| Tool group | The six tools above |
| Undo, Redo | History, 200 steps deep |
| Curve, Straight | Curve or straighten the segments between selected nodes |
| Delete | Delete the selection, following the **Delete** panel's mode |
| Zoom out, Zoom in | Zoom about the centre of the view |
| Fit | Fit the drawing on screen |
| Source | Open or close the source drawer |
| Inspector | Collapse or restore the right-hand panel |
| Theme | Invert the theme, light against dark |

### The polygon tool's settings

The polygon tool carries three settings of its own. Take the tool, then press it
again to open them; the small mark in the tool's corner is what says they are
there. `Escape` or a press outside closes them.

What the polygon tool draws next. Nothing here is stored on a shape: a pentagon
is five nodes from the moment it exists, the same as a rectangle, so there is
nothing that can disagree with what is on the canvas.

| Control | Does |
|---|---|
| **Polygon** / **Star** | Which of the two the tool draws |
| **Corners** | Sides for a polygon, points for a star. 3 to 60 |
| **Inner** | The star's waist, as a per cent of its outer radius. Hidden for a polygon |

**The shape is inscribed in the drag, not stretched to fill it.** A hexagon has
its widest corners 30 degrees off vertical, so a 30-unit drag gives a shape about
26 units wide and the full height. The first corner is always at the top, because
a star turned a tenth of a turn reads as a wrong star rather than a rotated one.

Every side is straight and every node is handle-free, so **Round** reaches any
corner of a polygon. `Shift` while drawing keeps it regular; without it the shape
follows the box, so a pentagon in a wide drag is a wide pentagon.

## Inspector panels

Three tabs, split by what a control acts on.

| Tab | Holds |
|---|---|
| **Shape** | Shapes, Style, Fill rule, Combine, Path, Transform, Arrange |
| **Node** | Node, Delete. Bend, Align nodes and Distribute nodes are headings inside Node |
| **Document** | File, Canvas, Angles, Guides, Keylines, Grid, Backdrop, Preview, Controls |

Nothing switches tab on its own. Arrow keys move between the tabs once one has
focus.

Every group collapses: press its header to open or shut it. Shapes, Style, Node
and File start open and the rest start shut, and a shut group still shows its state
beside its name. Groups are independent, so you can have Grid and Guides open
together. A shut group's controls leave the keyboard's tab order as well as the
screen, so tabbing reaches the group you want rather than every control before
it.

### Shapes

The list of shapes, newest last, with a colour swatch. A shape of one path shows
its node count; a shape of more than one shows how many paths it holds and opens
to list them. A group opens to show the shapes in it, and says how many there are.

- Click a name to select it. `Shift`-click to add.
- Press the eye to hide that shape or group. A hidden shape is not drawn, not
  selectable, and still in the file: it exports as `display="none"` and comes
  back hidden when you open it again. Hiding is an edit, so `Ctrl+Z` undoes it.
- Press the lock at the end of a row to lock that shape or group. A locked
  shape is not selectable on the canvas: a press goes through it to whatever
  is behind. Locking a group locks everything in it, and those rows show the
  lock without letting you open it, because the lock is not theirs. The lock
  is remembered across a reload and is not part of the file: saving and
  reopening gives you everything unlocked.
- Double-click a name to rename it.
- Press the triangle to show or hide the paths inside a shape. Only a shape
  holding more than one has one.
- Click **Path 1**, **Path 2** and so on to select that path alone. Its row says
  how many nodes it has, and says `open` when it does not close.
- With the list focused, arrows move the selection (`Shift` extends it), `→` and
  `←` open and shut a shape and step in and out of its paths, and `F2` or `Enter`
  starts a rename. With nothing selected they take the first shape, so the list
  works from the first press of `Tab`.

**Selecting a path selects its nodes.** There is no third kind of selection, so
every operation that works on whole paths -- **Reverse**, **Simplify**,
**Offset** -- acts on the path you picked with no further step. It
also means the row lights up whenever you select all of that path's nodes on the
canvas, by any route.

**A group is a name for shapes that belong together.** It is one `<g>` in the
output, and pressing its row selects everything in it, so moving, scaling,
recolouring and deleting all act on the group as a whole. Grouping brings the
shapes together in the stacking order, at the position the topmost of them already
had, because a `<g>` holds its contents in one run.

Grouping a few shapes that are already in one group makes a group inside it rather
than taking them out of it. Groups nest as deeply as you like, and **Ungroup**
unwraps one level per press.

**Clicking a shape on the canvas selects that shape, not its group.** That is what
lets you nudge one shape inside a group without taking it out. **Select group**
(`Shift+G`) is the way back: it widens the selection to the group the shapes are
in, and pressing it again goes one level further out. It goes dead when there is
nowhere left to go, and it changes nothing in the drawing, so it takes no undo
step.

**A group has no style of its own.** An SVG `<g>` can carry a fill for everything
inside it; a `<g>` you import has its fill pushed down onto the shapes instead,
and what you export is the style on each shape. Selecting a group and setting a
colour does what you would expect, because selecting a group selects its shapes.
What does not exist is a colour stored on the group and inherited: that would put
a shape's painted colour in two places, and the whole editor is built on there
being one. See [Explanation](explanation.md).

**Drag a row to move it through the paint order.** The line shows where it will
land, and it lands only among the rows it is already beside: a shape cannot be
dragged out of a group, because a group's shapes are one unbroken run of the
order. Ungroup is how a shape leaves. On a touch screen, hold the row for a
moment first; a finger that moves straight away is scrolling the list.

**Forward**, **Backward**, **To front** and **To back** do the same one step at a
time. They are `Ctrl+]`, `Ctrl+[`, `Ctrl+Shift+]` and `Ctrl+Shift+[`, so the four
buttons appear only when **Touch buttons** is on. They move the selection through
the paint order, which is the order of the list. A shape in a group moves among the
shapes of that group and stops at its edges, and a whole selected group moves as
one; a shape leaves a group by being ungrouped. A press with nowhere left to go
does nothing and costs no undo step.

**A group carries no position of its own.** There is no transform on it, so nothing
about a shape's coordinates changes when you group or ungroup it, and the numbers in
the source drawer stay the shapes' own. That is the rule the whole editor follows:
see [Explanation](explanation.md). What it costs is that a group is organisation and
export, not a container you can scale without scaling the shapes in it.

A `<g>` in a file you import becomes a group, and its transform is baked into the
shapes inside it. A group you make survives export and re-import, so its name is
worth setting: double-click it to rename, and the name becomes the `<g>`'s `id`.

**Duplicate and Paste put the copy outside any group**, on top of everything, even
when what you copied was inside one. A copy goes to the top of the stacking order,
and a group has to be one unbroken run of it. Group the copy again if you want it in
there.

**A shape holding two paths is not a mistake.** One shape is one `<path>` in the
output, and the paths inside it share one fill, one stroke and one fill rule. That
sharing is what a hole is made of: **Even-odd** punches a hole where two paths of
one shape overlap, and two separate shapes cannot do it. **Unite** on two shapes
that do not touch produces one shape of two paths for the same reason, and so does
**Make one shape**. Use **Split into shapes** to give each path a shape of its own
when that is what you wanted.
**Duplicate**, **Delete**, **Copy**, **Cut**, **Paste** and the four paint-order
tiles are the buttons that also have keys, so they appear only when **Touch
buttons** is on in the **Controls** panel. That is the default wherever the pointer is a finger. On a
mouse the keys below are the whole of it.

- **Duplicate** (`Ctrl+D`) copies the selected shapes, offset by two grid steps
  and named after their originals.
- **Delete** (`Delete`) removes them.
- **Group** puts the selected shapes in a group, and **Ungroup** takes them out
  again one level at a time. Two or more shapes are needed to group.
- **Select group** (`Shift+G`) widens the selection to the group it is in, one
  level per press.
- **Copy** (`Ctrl+C`) holds the selection for a later paste. With shapes selected it takes
  them whole. With only nodes selected it takes each run of two or more adjacent
  ones as its own open path, which is how you lift a piece of an outline. A
  single node is refused: a path of one node has no segment and would draw
  nothing.
- **Cut** (`Ctrl+X`) copies and then deletes.
- **Paste** (`Ctrl+V`) puts the last copy back, each one further from the last so two never
  land on top of each other. The copy survives being pasted, and survives an
  undo of the paste.

The clipboard is this editor's own and holds shapes, not text. It does not reach
other programs, and nothing another program copied arrives in it. To carry a
shape out, use **Copy** in the source drawer, which copies the text.

### Style

Fill, stroke, width, opacity and fill rule for the selected shapes. A node
selection styles the shape it belongs to, since style is a property of the whole
path.

| Control | Does |
|---|---|
| **Fill** | The colour inside. Tick **none** for no fill |
| **Stroke** | The colour of the line. Tick **none** for no stroke |
| **Width** | Stroke width in document units |
| **Opacity** | How much of the shape shows, from 0 to 100 per cent |

**Opacity is one number for the whole shape**, fill and stroke together. SVG also
has a `fill-opacity` and a `stroke-opacity`, and they are deliberately not here:
the three multiply, so a shape at 50 per cent with a fill at 50 per cent draws
its fill at 25 and its stroke at 50, and that is a rule about compositing rather
than about the drawing. A colour with alpha in it is refused for the same reason.

Reading a file is the other direction, and there the three do have to be
reconciled. An `opacity` on a `<g>` is multiplied into the shapes inside it,
because a group carries no style here, so a group at 50 per cent holding a path
at 50 per cent arrives as one shape at 25.

**Fill rule** is a group of its own inside **Style**, shut until you press it,
because it is set once on a shape and then rarely looked at. **Nonzero** fills
the places where one shape's own paths overlap; **Even-odd** leaves a hole
there. The setting shows beside the header without opening it.

With nothing selected these set what the next shape you draw will look like. That
is not an edit to the drawing, so it records no undo step, and the header says
`for new shapes` when it applies.

**Saved** keeps styles you want again. **Save style** stores the five values
above under a name made from the colours; double-click the name to change it.
Clicking a swatch puts that style on the selected shapes, or on what you draw
next if nothing is selected. **Delete style** removes the highlighted one, and
so does the `Delete` key while the swatches have focus.

A saved style is part of how you are working rather than part of the drawing. It
is not in the file, and it is not in the history: what the export carries is the
style on each shape, which is what applying one puts there. The highlight lets go
as soon as the style shown stops matching it.

The colour pickers stay usable while **none** is ticked, and picking a colour
clears it. A colour the picker cannot show, such as a named colour or a gradient
from an imported file, is left alone and named in the header instead.

### Combine

**Unite**, **Subtract**, **Intersect**, **Exclude**. Needs two or more shapes.
The first selected survives with its name and style, and **Subtract** removes
the rest from it.

**Or two paths of one shape.** Open the shape in the list and select two of its
paths, and the same four operations combine those, leaving the shape and any
paths you did not select alone. The result lands where the first chosen path was,
so nothing else moves. The header says which of the two it is about: `2 shapes`
or `paths of one shape`.

A shape selected whole is a question about shapes, so **Unite** on one shape
still declines rather than quietly uniting its own paths. Select the paths to ask
the other question.

**The two readings are opposite, which is why they are different operations.**
Between shapes, a shape's paths are one region together, which is what makes a
hole a hole: subtracting a ring takes its hole with it. Between paths, each one
is a region of its own, so uniting a ring's two paths gives back the solid disc.

**Make one shape** (`Shift+P`) also needs two or more, and is the odd one out:
it changes no geometry. The four booleans work out what region the shapes cover
and rebuild the outline from the answer, which discards every node that fell
inside. This one moves the paths into a single shape and leaves each of them
exactly as it was, so the node you placed is still the node you placed.

What fills is then up to **Fill rule** in the Style panel. Under **Nonzero** the
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

### Path

Reverse acts on the path as a whole. The two headings under it sort the rest by
what they do: take nodes out of the path, or make a second path from it.

- **Reverse** (`Shift+R`) walks the selected paths the other way round.
- **Offset** with **by** draws a path parallel to each selected shape, as a new
  shape beside it, or several if the shape cannot hold the distance and the offset
  comes apart. A negative distance goes the other way, and one that would consume
  the shape leaves nothing rather than a sliver.
- **Outline** and **Outline round** turn the selected shapes' strokes into filled
  paths, cut square or rounded at the ends. The width is the shape's own, and the
  new fill is what the stroke was coloured. A closed path becomes two contours
  under **Even-odd**, which is what makes it read as a band. A stroke too wide for
  its shape is refused rather than guessed at.
- **Reduce** with **to** reduces each selected path to that many nodes, whatever
  it costs, and says how far the drawing moved. **Within** asks the opposite
  question: what can go for a given cost.
- **Keep these nodes** removes everything except the nodes you have selected. A
  closed path needs three kept and an open one two.
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

**Reverse in full.** The drawing does not move. Direction is what decides
winding under `nonzero`, and which end of a path a marker lands on. A closed path
keeps its start node, so only the direction changes; an open one swaps its ends,
because that is what reversing it means. Whatever you had selected stays
selected.

### Node

Live coordinates for the selected node and its two handles. Type into any field
to set it exactly.

**A dimmed, italic number is a handle that does not exist**, shown where one
would go if you pulled it out. The canvas draws the same thing as a hollow
circle. The difference matters: a side with no handle on it is straight, so it
stays straight when **Round** cuts an arc from it and exports as a line rather
than a curve.

- **Cusp**, **Smooth**, **Symm** show how the selected node's handles are set,
  and change it when pressed. **Cusp** means the two handles are not in line, so
  the path turns at the node; it is the word Inkscape uses, and it is deliberately
  not "corner". Every corner **Round** can cut is a cusp, but not every cusp is
  one: the end of an open path has only one side, and a node with three points in
  a line does not turn.
- **Radius** with **Round** replaces the selected corners with an arc of that
  radius. With a shape selected and no particular nodes, it rounds every corner
  the shape has.

  **A corner that is already rounded can be rounded again**, to a larger or a
  smaller radius, which is what makes the field usable on a rectangle drawn with
  one. Pressing it twice at the same radius says **Already rounded** and costs no
  undo step. Either side may be a curve; what it cannot do is round a node the
  path runs smoothly through, because there is no corner there to replace.

  **Every corner gets the same radius.** A radius larger than one of them can
  hold reduces the whole request to the largest that fits everywhere, and the
  status line says so, rather than leaving one corner rounder than the rest.
  Where two corners share a side, each may have half of it.

  The same operation is on the canvas as a small mark just inside each roundable
  corner: hollow while the corner is square, filled once it holds an arc. Drag it
  in to round the corner and out to open it up, and the status strip reads the
  radius as you go. **Snap to grid** rounds the radius to a whole step.

  **One mark dragged rounds every corner it is grouped with**, under the same
  rule as the button: the whole shape when no nodes are picked out, and the
  selected nodes when some are.

  **The largest radius the sides can hold is where the corner ends.** At that
  size the arc runs from one neighbour to the other, the two sides are used up,
  and there is no corner left: the control goes, and the status line
  says so. Undo brings the corner back. A rectangle rounded to its limit is a
  stadium, which is the drawing you asked for and not a corner any more.

  A rounded corner can be grabbed and changed again, because nothing stores the
  radius: the two handles of the arc point at the corner they were cut from, so the
  corner and its radius are read back off the path. Dragging the radius to nothing
  restores the corner exactly. What ends this is editing the arc by other means --
  move one of its nodes or pull one of its handles and it stops being a circle
  tangent to two straight sides, which is the only thing the control can recognise.
  The mark disappears, and the corner is then an ordinary pair of curves.
- **Break here** duplicates the node to cut the path there.
- **Connect** draws the missing segment between two free ends. Nothing moves.
- **Merge** welds two free ends into one node at their midpoint, the inverse of Break.
- **Fuse** welds two adjacent nodes into one, anywhere along a path. With a shape
  selected instead of a pair, it sweeps that shape for segments of zero length
  and welds those. Two free ends are the one case it declines, because that is
  Merge.
- **&#8592; Node** and **Node &#8594;** (`[` and `]`) walk the selection along the
  path, wrapping on a closed one. The two buttons appear only when **Touch
  buttons** is on; the keys are always there, and clicking the next node does the
  same thing. So does **Delete node**, which is the `Delete` key. With a shape selected and no nodes, they take
  the first. `Shift` adds instead of replacing, which is how you get the two
  adjacent nodes the next two operations want.
- **Insert node** (`Shift+I`) puts a node in the middle of the segment between
  two selected nodes, without changing the curve. Double-clicking the outline
  does the same where you point.
- **Find in source** opens the source drawer and selects the command that drew
  the node. It switches the box to **Path data** and to that shape alone, since the
  position it points at is only true of that text.
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

**Align nodes** has the same six tiles as **Arrange** has for shapes: left,
centre, right, top, middle, bottom. It needs two or more nodes.

**Distribute nodes** has two where Arrange has six, and moves the middle nodes to
sit at equal steps between the outermost two. It needs three. A node is a point
with no width, so equal gaps, equal centres and equal edges are one move here
rather than three.

### Delete

How deleting a node treats the path around it.

| Mode | Deleting the middle node of `M10 30 L25 15 L40 30 L55 15 L70 30` |
|---|---|
| **Heal** (default) | `M10 30 L25 15 H55 L70 30`, still one path |
| **Split** | `M10 30 L25 15 M55 15 L70 30`, two ends |

**Break here** is neither. It keeps the node and duplicates it, so nothing moves.

### Transform

**at** and **size** are the selection's box as four numbers: X, Y, width and
height. They show the same box the handles are drawn on, and typing into one is
the typed form of dragging a handle. Width and height scale about the top-left
corner, so setting one leaves the other three numbers alone.

A value takes effect when the field loses focus or on `Enter`. A size of zero or
less is refused, as is scaling an axis the selection has no length on: a straight
horizontal line has no height to grow from.

**Rotate −90°**, **Rotate +90°**, **Flip horizontal**, **Flip vertical**, plus an
**Angle** field with **Rotate**, and a **Factor** field with **Scale**. All work
about the centre of the selection, and all are baked into the coordinates.

**Repeat** (`Shift`+`T`) does the last move, rotate or scale again, to whatever
is selected now. Duplicate, move, repeat builds a row; duplicate, rotate, repeat
builds a radial pattern. The heading beside it says what a press will do, and
reads `nothing yet` until something has been transformed.

It remembers the matrix, not the gesture. That is the same thing for a rotate and
deliberately not the same thing for a typed size: setting the width of a 20-wide
selection to 40 produces a doubling, and repeating it doubles again rather than
setting 40. A drag of the box counts, and so does an arrow-key nudge.

Undo takes back a repeat and does not forget what to repeat, so pressing undo and
then repeat again does the same thing a second time.

### Arrange

Moves whole shapes around each other. **Align nodes** in the Node panel is a
different thing: that one moves anchors inside one path.

**Relative to** chooses the box everything below it works in.

| Setting | Means |
|---|---|
| **Selection** | The box the selected shapes sit in together |
| **Canvas** | The whole canvas, whatever the drawing occupies |

**Align shapes** has six buttons: left, horizontal centre, right, top, vertical
centre, bottom. Each puts that edge of every shape on the same line. Two shapes
are needed against the selection, and one is enough against the canvas, which is
how a single icon is centred.

**Distribute shapes** offers gaps, centre and edges on each axis, and needs three shapes. Each spaces that
edge evenly. Against the selection the outer two stay where they are; against the
canvas they go flush to its sides.

**Gap** with **Space H** and **Space V** puts the same gap between neighbours.
Leave the field empty and the gap becomes whatever fills the box, which against
the selection is the answer that evens out the middle without moving the ends.
Type a number and the shapes pack from the leading edge at exactly that gap.

A group counts as one thing throughout, and moves without coming apart. Selecting
only some of a group's shapes moves those on their own.

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

### File

Everything that moves a drawing in or out of the editor.

| Control | Does |
|---|---|
| **Add an SVG** | Read an SVG file and add its shapes to this document |
| **Download SVG** | Save the whole document as an SVG file |
| **Download PNG at N px wide** | Save the drawing as a PNG. The height follows the canvas proportions |
| **Workspace: Save** | Write the whole session to a file |
| **Workspace: Open** | Read one back, replacing this session |
| **Forget saved work** | Remove the copy this browser holds |
| **Output** | How the text is written: see below |

A PNG is transparent wherever nothing is painted, which is what an icon wants.
The canvas decides its frame, not the drawing, so padding you left around a shape
is kept. The width runs from 1 to 8192, and the status line says the size it
wrote.

#### A workspace is not an SVG

An SVG is the drawing. A workspace is the drawing and everything around it: the
canvas, the camera, the guides, the saved styles, the grid and keyline settings,
and every switch in the three panels. None of that can go in an SVG, because an
SVG has nowhere to put it.

**Open replaces the session.** That is the opposite of **Add an SVG**, which adds
to what is there, and it is why the two sit under different headings. Two
cameras is not a camera, so there is no coherent way to merge two workspaces.
Opening one does not go into the undo history: `Ctrl`+`Z` afterwards undoes your
last edit to the workspace you opened, not the open itself.

**Two things do not go in.** The backdrop image, because it is a picture the
editor was given rather than one it holds, and the undo history.

#### The copy this browser keeps

The same workspace is written into this browser as you work, and read back when
you return. The reading is silent when there is nothing there, and says one of three things
when there is:

| It says | Meaning |
|---|---|
| **Picked up where you left off** | The copy is the drawing you had, and it names how many shapes came back |
| **Restored an earlier copy** | The last save was refused, so this is the drawing as it was before that. What was on screen after it is gone |
| **Your saved work could not be read** | This build cannot read the copy that is there. It is left alone rather than deleted, and nothing new is saved until you press **Forget saved work** |

The third is the one to know about. A copy this build cannot read may be one a
different build wrote, so deleting it would throw away work that is still
readable somewhere; the price of keeping it is that nothing is saved over it in
the meantime, and the header says so.

The header beside **On this device** says whether it is happening.

| It says | Meaning |
|---|---|
| `saving` | The work is being kept |
| `stopped` | You pressed **Forget saved work**. Nothing is kept until you reload |
| `not saving` | Either the browser refused, or a copy is here that this build could not read. The sentence under it says which |

**Three reasons, and none of them is a fault in the editor.** Opened from a
`file://` URL, Chromium gives the page an origin with no storage attached and
every attempt throws; Firefox allows it. A drawing past about two megabytes of
text is more than the space a browser gives one page, so it is refused while
there is still something to say about it. And a copy this build cannot read is
kept rather than overwritten, which stops the saving until you clear it. The
first two name a workspace file as the answer, because a file has neither limit;
the third names **Forget saved work**.

**It is not a backup.** Clearing site data removes it, a private window never had
it, and another browser on the same machine has its own. A workspace file is the
thing you keep.

**Output** is one press away inside the group, because it is set once and read
rarely. It governs both downloads and the previews.

- **Decimals** rounds the numbers in the output. This changes the geometry.
- **Minify** shortens the spelling only. Drops unnecessary separators and leading
  zeros, drops repeated command letters, and prefers relative commands when they
  are shorter.

Dropping an SVG file on the canvas does the same as **Add an SVG**. Dropping any other image loads
it as a backdrop to trace over.

It reads the file the way pasting it into the source drawer does: the same
importer, the same refusal of anything that draws nothing, and one undo step.
Group transforms are baked into the points and primitives become paths.

**It adds; it does not replace.** What was open stays, the shapes that arrive are
selected so you can move them straight away, and the canvas keeps its own size:
the file's `viewBox` is not adopted, because the page belongs to the drawing you
already have. The view re-fits, so artwork that landed outside the page is at
least on screen. To replace the document instead, paste the file's text into the
source drawer and press **Apply**.

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

### Angles

| Control | Does |
|---|---|
| **Snap to angles** | Hold the pointer to rays at a fixed angle |
| **Every** | Degrees between rays |
| **From** | Where the first ray points, in degrees |
| **Origin here** | Radiate from the middle of what is selected |
| **Origin free** | Go back to radiating from wherever the gesture starts |

The grid gives you positions; this gives you directions. With it on, the pointer
is held to the nearest ray, so a 45&deg; chamfer or a twelve-armed star is drawn
rather than nudged into place.

With no origin set the rays come from wherever the gesture started: the node you
are dragging, or the pen's last point. That means nothing is drawn until you
start something, which is deliberate. **Origin here** pins them to the middle of
the selection instead, and they stay after the gesture ends.

A ray is a line, so it is beaten by a node and it beats the grid, the same as an
outline or a guide. The readout says `on an angle` when one has the pointer.

### Guides

| Control | Does |
|---|---|
| **Rulers** | Show the rulers along the top and left |
| **Show guides** | Draw the guides, and let the tools snap to them |
| **Lock guides** | Stop the guides you have from being moved, so a press near one edits the drawing. New ones can still be placed |
| **Smart guides** | While you drag a shape, line it up with the others and with the page |
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

**Smart guides** are the other half, and nothing is placed. Drag a shape and a
line appears wherever it lines up with another shape or with the page, by an edge
or by a centre: solid for an edge, dashed for a centre. The drag is held to what
the line shows, and on that axis the alignment wins over the grid. The line goes
when the drag does.

Only dragging a shape is covered. Drawing a rectangle and scaling a selection do
not show them.

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
| **Snap to crossings** | Weld to where two outlines cross. Worked out on the spot, so it is off unless you want it |
| **Pixel fit** | Shift the lattice by half the stroke width, so the stroke's edges land on whole pixels |
| **Reference point** | The three by three grid at the top of **Transform**. Picks which point of the selection stays put: **at** reads that point, and typing a size grows the shape about it. Starts on the centre |
| **Show nodes** | Draw the square and round markers on each node. Off leaves the shape with nothing on it to press, so nodes cannot be selected or dragged |
| **Show handles** | Draw handles and their lines, the bend dots and the corner controls |
| **Show fills** | Draw each shape's fill. Off leaves each shape's own stroke, so a filled shape with no stroke becomes invisible |
| **Wireframe** | Draw every shape as a plain one-pixel outline, ignoring its own fill and stroke. The switch for the case above, and for picking apart shapes stacked on top of each other |

Three kinds of thing can claim the pointer, and the most specific one within
reach wins: a **point** beats a **line** beats the **grid**. Nodes, guide
crossings, keyline corners and outline crossings are points; outlines, guides,
keylines and angular rays are lines. Distance does not break ties
between them, so a node seven pixels away still beats a gridline one pixel away.
Nothing reaches further than eight screen pixels except the grid, which is
everywhere.

The `xy` readout shows that target's own coordinates rather than the pointer's,
so you can see where a click would land before you make it, and the readout
immediately to its left names what claimed it: `on a node`, `on an outline`,
`on a keyline`, `on a guide`, `where guides cross`, or `on an angle`. It names
the thing rather than the tier, because six things answer three tiers and
`on an outline` with no outline there would be a true statement about the rule
and a false one about the drawing. They are two readouts
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

### Preview

The drawing at 16, 24, 32 and 48 pixels wide, on a chequer so a transparent
background is visible. Each is as tall as the canvas proportions make it, so a
wide canvas gives wide swatches rather than a letterboxed square.

They are drawn from the exported SVG, so the **Output** settings show in them:
set **Decimals** to 0 and the rounding appears here before it appears in a file.

They hold still while you drag and redraw when you let go, and they do nothing at
all while the group is shut.

### Controls

- **Touch buttons** shows the buttons for the operations a keyboard already
  reaches: **Duplicate**, **Delete**, **Copy**, **Cut**, **Paste**, the four
  paint-order tiles, and stepping and deleting nodes. It is on wherever the pointer is a finger and off on a
  mouse, and either can be changed here.

Nothing else moves with it. Every operation still has a button; this decides
whether the ones that repeat a shortcut take up room while you have the keyboard
to hand.

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
- **SVG** is a whole document. Everything it understands on the way in is
  converted to paths, and
  [what is read on import](#what-is-read-on-import-and-what-is-written-on-export)
  lists it.

| Button | What it does |
|---|---|
| **Apply** | Parses the text and applies it. `Ctrl`+`Enter` from inside the box does the same |
| **Revert** | Puts the document's own text back, to start again |
| **Copy** | Puts what the box is showing on the clipboard, whichever mode it is in |
| **Close** | Closes the drawer |

To save a file rather than copy text, use **Download SVG** in **Document → File**.
It writes the whole document whichever mode this box is in.

**Apply** refuses text that cannot be parsed, and text that parses to nothing
drawable, such as a lone `M 0 0`. Either way the drawing is left as it was and
what you typed is left as you typed it, because the error names an offset into
that text.

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

Read: `M m L l H h V v C c S s Q q T t A a Z z`, the six shape elements
`rect`, `circle`, `ellipse`, `line`, `polyline` and `polygon`, plus `transform`,
`fill`, `fill-rule`, `stroke`, `stroke-width` and `viewBox`.

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
- **Select a circle and its four nodes each offer a corner radius.** A circle is
  four circular arcs meeting smoothly, which is exactly what a rounded corner is
  made of, so the editor reads one at every node. Nothing is wrong with the
  shape and dragging a control does what it says. There is no measurement that
  tells the two apart: a circle's numbers are cleaner than a real rounded
  corner's, not messier. Ellipses and rounded rectangles are unaffected.
- **A corner rounded to its limit cannot be adjusted again.** The arc reaches
  both neighbours, so the two straight sides that defined the corner are gone
  and nothing can read a radius back off the path. Undo, or draw it again.
- **Arcs do not survive a round trip.** A shape imported as an `A` comes back out
  as a `C`. See [what is read on import](#what-is-read-on-import-and-what-is-written-on-export).
- **A traced photograph makes a document too dense to edit.** Tracing runs in a
  worker, so the editor stays live while it works, and the walk itself is no
  longer what costs the time. What costs it is the result: a 400 by 400
  photograph at the defaults comes back as 3 695 paths and 23 454 nodes, and a
  document that size takes about a tenth of a second to redraw whatever you do
  to it. Above 2 000 node markers in view the overlay stops drawing them and the
  document readout says `markers off, too dense`; the shapes are all still
  there, but you cannot click a node until you zoom in far enough for the
  markers to come back. A document that size redraws in about 20 ms, so it is
  workable, but it is not what this editor is shaped for. Tracing is for flat
  artwork. For a photograph, fewer colours and a higher **Noise** floor are the
  controls that help.
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
