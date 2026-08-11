# Writing style

How everything a reader sees gets written: the manual, the README, the status
line, tooltips, button labels. One goal governs all of it. **The writing should
read like a person who cares made it.**

This is built with AI help and says so. Honesty only earns attention if the
result looks professional, so the patterns that make people dismiss AI-assisted
work on sight stay out.

## What this stands on

No style invented from scratch. A thin set of project rules on maintained
foundations:

- **Prose:** the [Google developer documentation style guide](https://developers.google.com/style).
  When this file is silent, follow Google.
- **Structure:** [Diátaxis](https://diataxis.fr/). Every page is one of four
  kinds and never mixes them.
- **How-to guides:** minimalist instruction. Task first, shortest path to a real
  result, no filler.
- **Acceptance test:** [ISO 24495-1 plain language](https://www.iso.org/standard/78907.html).
  A page ships only if a reader can find it, understand it, use it, and gets
  what they came for.

This file holds the deltas and the things a general guide will not cover.

## The prime rule: earn the look

Readers decide in seconds. Two things earn it:

1. **No tells.** The surface markers people read as machine-made stay out, even
   where they would read fine, because the perception cost is not worth it.
2. **Consistency is trust.** One term per concept. One name per control. A
   message that differs from its siblings for no reason reads as carelessness,
   and carelessness reads as slop.

## Voice

- **Second person, present tense, active.** "Drag the outline to move the
  shape." Not "the shape can be moved by dragging."
- **Plain and direct.** Short sentences, one idea each. Cut a word if the
  sentence survives without it.
- **Confident, not promotional.** State what it does. The reader is already
  here.
- **Warm, not chatty.** No greetings, no exclamation marks, no jokes at the
  reader's expense.
- **Specific beats generic.** "Round to 0.027 % of the radius" beats "very
  accurate." Name the real number, the real key, the real button.

## The tell list

**Punctuation**

- **No em-dashes.** Use a comma, a colon, parentheses, or two sentences. The
  en-dash is for numeric ranges only (nodes 3–7). This is the one rule most
  often broken here, and the one most worth keeping.
- Ellipsis only for a genuine omission or a loading state, never for suspense.

**Vocabulary** (the type matters more than the list)

- Filler intensifiers: very, really, just, quite, simply, actually.
- Corporate verbs: leverage, utilise, elevate, unleash, empower, streamline.
- Throat-clearing: certainly, of course, it's worth noting, when it comes to.
- Significance inflation: seamless, robust, powerful, cutting-edge, at its core.
- Chatbot artifacts: "Great question", "Let's dive in", "In conclusion".

**Shape**

- No "not just X, but Y" and no "it's not about X, it's about Y."
- Vary sentence length. A uniform cadence, and the rule-of-three rhythm on every
  line, is itself a tell.
- No paragraph that only restates the one before it.
- No opener pointing at a "this" with no antecedent.
- Hedge only when it buys accuracy ("fitting cannot know which node was the
  mistake, so it reports how far the furthest one moved"), never as a reflex.

## Scope, and the debt this creates

This governs **user-facing text**: the manual, the README, the status line,
tooltips, labels.

`docs/ARCHITECTURE.md` and `docs/REVIEW-*.md` are developer documents and are
exempt from the em-dash rule, deliberately: they argue about decisions, and the
aside is the unit of that argument. They are not exempt from anything else.

The README and the in-app strings currently break the em-dash rule in about
twenty places. That is real debt, listed in the catalogue below, and it is
cheaper to fix than to keep explaining.

## Structure (Diátaxis)

Each page declares one type and stays in it.

| Type | Reader wants | Reads like | Here |
|---|---|---|---|
| **Tutorial** | to learn by doing | one guided path, success guaranteed | "Draw your first icon" |
| **How-to** | to finish a task | goal, steps, done | "Make a shape perfectly round" |
| **Reference** | the exact facts | dry, complete, mirrors the app | key tables, tool list, panel list |
| **Explanation** | to understand why | prose about a design choice | why points have no types |

Implementation detail belongs in user docs only when it changes what the reader
should do or expect. "Circularise fits a circle by least squares, so it cannot
know which node was wrong" earns its place, because it tells the reader why the
result moved. "The fit is a Kåsa algebraic solve with the data centred first"
does not, and lives in `ARCHITECTURE.md`.

## Terminology

One term per concept, matching what the interface says. The model and the
interface disagree in places; **the interface wins in user-facing text.**

| Concept | Use | Never |
|---|---|---|
| A point on the path | **node** | point, vertex, anchor point, knot |
| The round dot you drag out of a node | **handle** | control point, tangent, lever |
| A handle that does not exist yet, drawn hollow | **ghost handle** | latent handle, phantom |
| One continuous run of nodes | **path** | subpath, contour, ring |
| One entry in the Shapes list | **shape** | object, element, layer |
| The stroked line you can grab to move a shape | **outline** | border, edge |
| Dragging a box over empty canvas | **marquee** | rubber band, lasso, box select |
| The straight line between two nodes | **segment** | edge, span |
| The `d` text in the drawer | **source** | code, path data, markup |

`subpath` and `contour` appear throughout the code and in `ARCHITECTURE.md`,
where they are the right words. In the manual they are both **path**, because a
reader who has drawn two separate rings in one shape does not need a third noun
to describe what they can already see.

Keys as `Ctrl+S`. Buttons and panels in bold (**Circularise**, the **Draw**
panel). Paths, flags and path data in `monospace`.

## In-app copy

The status line is one line, read in passing, often after something surprising.

1. **Sentence case. Full stop at the end.** Every message, including fragments.
   `Copied.` not `Copied`.
2. **Say what happened, then what to do about it.** `Break needs exactly one
   node selected.` states the requirement, which is the fix.
3. **Two sentences maximum.** If it needs three, the interface is wrong.
4. **Name the thing the user named it.** `Renamed to outer ring.` uses their
   word, not "shape 3".
5. **Report numbers that were measured, not adjectives.** `Furthest node moved
   1.713.` beats "made it much rounder".
6. **A refusal explains itself.** A button that declines says why in the same
   breath, because a silent no-op reads as a bug. This is not optional: five
   silent dead clicks were a shipped defect here.
7. **No em-dash.** A full stop nearly always works.

### Catalogue and decisions

Current strings, and what each has to become. The pattern is the point: the same
three faults repeat.

| Now | Fault | Becomes |
|---|---|---|
| `Imported 3 shapes` | no full stop | `Imported 3 shapes.` |
| `Copied.` / `Nothing to import.` | fine, keep | keep |
| `Apply would merge all 4 shapes — select one first, or switch to SVG.` | em-dash, two instructions | `Apply would merge all 4 shapes. Select one first, or switch to SVG.` |
| `That node is an end of the path — there is no second handle to line up with.` | em-dash, wordy | `That node ends the path. There is no second handle to line up with.` |
| `That node is already an end of the path — nothing to break.` | em-dash | `That node already ends the path.` |
| `No circle is determined by those nodes — they are collinear, or they do not go round the ring in order.` | em-dash, 18 words before the point | `Those nodes do not determine a circle. They are collinear, or they do not go round in order.` |
| `Already smooth: symmetric means collinear handles of equal length, which is smooth. Drag one handle to give them different lengths.` | 22 words, explains the model | `Already smooth. Symmetric is smooth with equal handle lengths; drag one to differ.` |
| `Already a corner — the handles are where that setting puts them, so there is nothing to move.` | em-dash, explains itself twice | `Already a corner.` |
| `Renamed to outer ring; exports as id="outer-ring".` | semicolon carries a second fact | `Renamed to outer ring. Exports as id="outer-ring".` |
| `Circularised 1 contour onto r 17.051; furthest node moved 1.713.` | "contour" is not in the vocabulary | `Circularised 1 path onto r 17.051. Furthest node moved 1.713.` |
| `Clipboard blocked by the browser.` | fine | keep |

**Pluralisation** is computed, never `shape(s)`. The code already does this; keep
it.

**Failures** read `{Thing} failed.` in sentence case with a full stop, and add
the reason only when the reader can act on it.

## Before it ships

1. **Plain-language test.** Can a reader find, understand and use this, and does
   it answer what they came for?
2. **Reader test.** Paste the page to a fresh model with no context and ask what
   a real user would ask. Fix what confuses it.
3. **Tell sweep.** Search for `—` and the banned vocabulary. In user-facing text
   the em-dash count should be zero.
4. **Terminology sweep.** Search for every word in the "Never" column.
