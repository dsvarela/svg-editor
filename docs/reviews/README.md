# Reviews

**Evidence, never instruction.** Each file records what one review found on one
date: the defects, the documentation claims that turned out to be false, and the
tests that could not have failed. They justify decisions. They do not tell you
how anything currently works.

To find out how something works now, read [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
or the [manual](../manual/README.md). A review is true of the day it was written
and is left that way on purpose, so a claim it corrected still has the correction
attached to the reason for it.

| Date | Covered | Found |
|---|---|---|
| [2026-08-13](2026-08-13.md) | Knot removal, Make one shape, curve dragging, keylines, rulers and guides | 6 defects, 4 documentation claims, 2 tests that could not fail. Three of the defects were one rule the guide gestures did not follow; two more came out of rewriting a test that could not fail. |
| [2026-08-12b](2026-08-12b.md) | Fuse, pixel fit, auto-trace, the snap priority order | 12 defect classes, 15 documentation claims, 9 tests that could not fail. Four of the classes were introduced by a fix from the same morning. |
| [2026-08-12](2026-08-12.md) | The backdrop, Simplify, the transform box, the canvas, Style, corner rounding | 9 defect classes, 17 documentation claims, 6 tests that could not fail |
| [2026-08-11](2026-08-11.md) | Primitives, rename, tooltips | 10 defect classes and 8 documentation claims. Nine classes were fixed in the same pass; the tenth was deferred to a named feature and closed the next day. |

Nothing here is edited into agreement with the present. When a review's finding
is later reversed, the reversal is written in the next review or in
`ARCHITECTURE.md`, and the original stays as it was.
