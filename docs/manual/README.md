# Manual

A grid-based SVG path editor you drive by dragging the drawing.

Four pages, each with one job. Pick the one that matches what you want right
now.

| Page | Read it when |
|---|---|
| [Tutorial](tutorial.md) | You have not used this before. One guided path, about fifteen minutes, ending with a finished icon you export. |
| [How-to](how-to.md) | You know your way around and want to finish one specific task. Recipes, shortest route, no theory. |
| [Reference](reference.md) | You want the exact facts. Every tool, panel, button, key and setting, and what each one does. |
| [Explanation](explanation.md) | You want to know why it works this way. Design decisions and the reasoning behind them. |

Nothing here repeats itself. If the tutorial mentions the grid in passing, the
full account is in the reference, and the reason it behaves that way is in the
explanation.

## The short version

Shapes are made of **nodes**. Each node has up to two **handles** that decide how
the line curves into and out of it. You drag nodes and handles directly on the
canvas. There is no table of commands to edit, and no node type to choose before
you draw.

Everything you make is a path. There is no rectangle object and no circle
object, so nothing needs converting before you can edit it.

## Getting it running

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

`npm run build` produces a single self-contained `dist/index.html`. Open it from
disk and it works, with no server and no external requests.

## Status of this manual

Written against the editor as it stands on 2026-08-19. Features still to come
are listed in [`SHOPPING-LIST.md`](../SHOPPING-LIST.md), and the known rough
edges are named in the [reference](reference.md#known-limits) rather than left
for you to find.
