# Tutorial: draw a bookmark icon

You will draw a bookmark icon from nothing, shape it with handles, make part of
it perfectly round, and export it as SVG. It takes about fifteen minutes.

Follow the steps in order. Everything you need is on screen, and nothing here
depends on anything you have not already done.

## Before you start

Open the editor. You get a canvas with a grid, a toolbar across the top, and an
inspector down the right side. A starter shape is already there.

Delete it. Click its name in the **Shapes** list, then press **Delete** in the
same panel. The canvas is now empty.

## 1. Draw the body with the pen

Select the pen. Press `P`, or click the pen in the toolbar.

Click these five points in order. The grid readout at the bottom of the window
shows the coordinate under your pointer, so you can place them exactly.

| Click | At |
|---|---|
| 1 | 25, 12 |
| 2 | 55, 12 |
| 3 | 55, 60 |
| 4 | 40, 46 |
| 5 | 25, 60 |

Click the first point again to close the shape. You now have a bookmark
outline with five corners.

Press `Escape` to finish the path.

## 2. Look at what you made

Switch to the select tool with `V`, then click any node.

Two things appear. The node turns solid, and hollow circles show where its
handles would go if you pulled them out. Those are **ghost handles**. They mark
positions, not geometry: the segments either side are still straight lines.

Press `Ctrl+E` to open the source drawer. The path reads as `M` and `L`
commands, with no curves in it, which is what the ghost handles were telling
you. Leave the drawer open for now.

## 3. Curve the top corners

Click the node at 25, 12.

Drag its ghost handle, the hollow circle on the segment heading right. The
segment bows. Watch the source drawer: the `L` became a `C`.

Do the same at 55, 12, dragging the ghost handle on the segment heading left.

The top of the bookmark is now a shallow curve instead of a flat edge.

## 4. Make the curve symmetric

Click the node at 25, 12 again and look at the **Node** panel on the right. One
of **Cusp**, **Smooth** and **Symm** is lit. It reads **Cusp**, because one
handle exists and the other does not.

Press **Symm**. The missing handle is created, both are lined up, and they are
given equal lengths. The drawing moves when you do this, which is expected: the
button changes the geometry, because that is the only thing continuity is made
of here.

Press `Ctrl+Z` if you want the sharper version back.

## 5. Round the tail with a circle

The notch at the bottom is two straight segments meeting at 40, 46. Round it
instead.

Select the ellipse tool with `E`. Hold `Shift` and drag from 32, 40 to 48, 56.
`Shift` keeps it a circle rather than an ellipse.

You now have a separate circle shape overlapping the bookmark.

## 6. Cut the circle out of the body

Click the bookmark in the **Shapes** list, then hold `Shift` and click the
circle. Both are selected, in that order.

In the **Combine** panel, press **Subtract**. The circle is removed from the
bookmark, leaving a round notch. The result keeps the bookmark's name and its
colour, because the first shape you selected is the one that survives.

## 7. Tidy the numbers

Open the **Output** panel and set **Decimals** to 2.

Look at the source drawer. The coordinates are shorter and the shape has not
moved, because two decimal places is far more precision than a 100-unit canvas
needs.

Now tick **Minify**. The source gets shorter again: separators disappear
where they are not needed, leading zeros go, and repeated command letters are
dropped. The geometry is identical. This is the form to paste into production.

## 8. Name it and export

Double-click the shape's name in the **Shapes** list. Type `bookmark` and press
`Enter`.

In the source drawer, switch the mode from **Path data** to **SVG**. You now
have a complete SVG document, with your shape carrying `id="bookmark"`.

Close the drawer, open the **Document** tab and press **Download SVG** under
**File**. The file saves to disk. Open it in a browser to check.

## What you learned

- Nodes and handles are the whole model. You never chose a node type or picked a
  command letter.
- Ghost handles show where a handle would go before it exists.
- Continuity buttons move geometry rather than setting a flag.
- Primitives are ordinary paths from the moment you draw them, so `Subtract`
  works on a circle and a hand-drawn outline with no conversion step.
- Decimals and minify change the spelling of the output, never the drawing.

## Next

- [How-to](how-to.md) for specific tasks: fixing a wobbly circle, moving several
  shapes at once, cutting a path in two.
- [Explanation](explanation.md) for why points have no types, and why the grid
  never draws a line you cannot snap to.
