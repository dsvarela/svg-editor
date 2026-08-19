# Reviews

**Evidence, never instruction.** Each file records what one review found on one
date: the defects, the documentation claims that turned out to be false, and the
tests that could not have failed. They justify decisions. They do not tell you
how anything works now.

To find out how something works now, read [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
or the [manual](../manual/README.md). A review is true of the day it was written
and is left that way on purpose, so a claim it corrected still has the correction
attached to the reason for it.

| Date | Covered | Found |
|---|---|---|
| [2026-08-19d](2026-08-19d.md) | No commits: the 127 mutation survivors `2026-08-19c` left unread in `src/model/ops.ts` | Four classes, all already in the register. Most of the 127 are one of them: **every fixture in `ops.test.ts` is spelled `M0 0 ...`, so `a + (b - a) / 3` and `a + (b + a) / 3` are the same number** and no test in the file could separate them. Fixed by the property those fixtures were failing to state rather than by moving them: eighteen operations run twice, once on a path and once on the same path moved, and required to agree. `nearestOnPath`'s box reject, which held 11 of that function's 12 survivors, is now checked against an exhaustive search over 693 swept points; four of six mutations on it go red and the two survivors are provable equivalents. Three pieces of `ops.ts` were rewritten so the survivors had nowhere to live, including a dead ternary and one bound stated twice. |
| [2026-08-19c](2026-08-19c.md) | The five commits that closed the 97 findings of 2026-08-19b: about 1 780 lines, none of it read by anything but its author | About 50 findings, a third of them one class: **a fix applied to the instance it was reported on and not to its siblings.** The pass that gave `tryEdit` to Align left Round counting corners cut; the pass that rewrote one engine-text message walked past four in the same file. 1 that loses work: a negative `stroke-width` imported unguarded made a document this build writes a document this build cannot read. 5 checks that could not fail, in the pass whose subject was checks that could not fail, 3 proved by mutation. The audit's NaN sweep missed `viewBox`, where a NaN blanks the entire drawing silently. |
| [2026-08-19b](2026-08-19b.md) | A wrap-up of the whole repository in two waves: the 21 commits since the last review, and the eleven from 2026-08-17 that no review had ever covered | 97 findings across 8 read-only lanes, on a tree green by every gate. 5 that changed or destroyed somebody's work, including a group written to file as two `<g>` elements and a reorder that deleted a shape outright. 3 of the 7 gates quoted that morning were not gates. 12 checks in the harness held on state a previous step had produced, and 3 of the reviewer's own new tests could not fail. All 97 were closed, 96 in code and 1 by decision; the 50 that outlived the review are listed in the file by lane, with a dated section under them saying what happened to each. Six were a different defect from the one recorded. The fixes themselves were then reviewed, in [2026-08-19c](2026-08-19c.md). |
| [2026-08-19](2026-08-19.md) | The rail redesign and the seven commits that closed the shopping list: twenty commits, about 5,500 lines, none of it read before | 3 defects, 1 module with no test at all, 1 bound living in four places, 1 comment naming deleted code, 5 comments restating a section none of them cites, 2 doc blocks that lost their code. The defect that matters is a list of tool names a new tool never joined: nothing was wrong at the type level or at run time, and the symptom was a preference changing on its own. `mutate.mjs` on the session reader went from 28 survivors of 57 to 4 of 67. |
| [2026-08-18b](2026-08-18b.md) | The commit that closed the comment and reachability backlog, which had reviewed nothing but itself | 1 defect introduced by the commit, 6 more of its class already in the tree, 1 duplication the same pass walked past, 4 measurements deleted from comments that needed them, 1 false reason in the commit message. The class is a comment that has come away from the declaration it documents, and `comments/check.mjs` could not see it: it reads a detached doc and the doc below it as one comment. |
| [2026-08-18](2026-08-18.md) | The palette against the contrast floors, the switch to Firefox, and the three scenarios that went red on it | 1 check that could not fail, 2 scenarios asserting nothing, 1 defect in the editor, 1 instrument that had never measured Tab, 5 comments describing code that is gone. The check that could not fail is `--audit` itself: `page.check('#filled')` satisfied its test for a scenario that asserts something. |
| [2026-08-15](2026-08-15.md) | The touch retrofit: coarse-pointer sizing, the two-finger gesture, the held-key buttons, and the three tests fixed before it | 1 instrument wrong three ways, 1 defect the tests found before a hand could, 5 tests that could not fail, 1 line nothing distinguishes. Every touch number recorded before this date was produced by the wrong instrument: 84 of 85 was really 165 of 166. |
| [2026-08-14](2026-08-14.md) | The last seven shopping-list items, offset path, stroke to path, importing a file | 3 pieces of code nothing distinguishes, 1 claim wrong twice before it was right, 4 tests that could not fail. The three pieces were all written to fix one error that never moved, because the error was in what measured it. |
| [2026-08-13](2026-08-13.md) | Knot removal, Make one shape, curve dragging, keylines, rulers and guides | 6 defects, 4 documentation claims, 2 tests that could not fail. Three of the defects were one rule the guide gestures did not follow; two more came out of rewriting a test that could not fail. |
| [2026-08-12b](2026-08-12b.md) | Fuse, pixel fit, auto-trace, the snap priority order | 12 defect classes, 15 documentation claims, 9 tests that could not fail. Four of the classes were introduced by a fix from the same morning. |
| [2026-08-12](2026-08-12.md) | The backdrop, Simplify, the transform box, the canvas, Style, corner rounding | 9 defect classes, 17 documentation claims, 6 tests that could not fail |
| [2026-08-11](2026-08-11.md) | Primitives, rename, tooltips | 10 defect classes and 8 documentation claims. Nine classes were fixed in the same pass; the tenth was deferred to a named feature and closed the next day. |

**A review covers a RANGE, and the range starts where the last one ended.** Not
"the commits that have had no review", counted backwards from HEAD until the
number looks right: that is how eleven commits from 2026-08-17 became invisible
for two days, and they were only found because somebody asked whether a wrap-up
was overdue. The range each file covers is named at its head so the next one can
start there.

Nothing here is edited into agreement with the present. When a review's finding
is later reversed, the reversal is written in the next review or in
`ARCHITECTURE.md`, and the original stays as it was.
