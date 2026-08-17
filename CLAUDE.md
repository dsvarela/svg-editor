# svg-editor

**This project is TypeScript and npm, not Python.** The `CLAUDE.md` one level up
in `projects/` describes a uv project and applies to its Python siblings. Nothing
in it applies here: there is no `pyproject.toml`, no `.venv`, and `uv run` will
not start anything. Use `npm`.

The general rules for folders, naming, writing, interface, design and code are
the `handbook` skills. They live in a separate repository, checked out alongside
this one, so there is no link to follow from here. What follows is only what
those rules cannot know about this project.

## Commands

| Task | Command |
|---|---|
| Run it | `npm run dev` |
| Typecheck | `npm run check` |
| Unit and DOM tests | `npm test` |
| One browser scenario | `npm run drive <scenario>` |
| Name every scenario | `npm run drive -- --list` |
| Style sweep and link check | `npm run check:docs` |
| What a finger cannot hit | `node tools/touch.mjs` |
| What a keyboard cannot reach | `node tools/keys.mjs` |
| Build the single file | `npm run build` |

`npm run build` typechecks first, so a build that succeeds is a typecheck that
succeeded.

## Four constraints that are not obvious from the code

**The build must stay one file that opens from `file://`.** Every asset is
inlined. This is what rules out a module worker: Chromium refuses one from a
`blob:` URL when the page came from `file://`, so `worker.format` stays at
Vite's `iife` default. Verified by running it, not by reading the spec.

**A dependency has to be worth its transfer size.** Auto-trace is 4.2 kB
inlined against the 278 kB a WASM tracer would have cost, and PathBool went the
other way on purpose. The reasoning for both is in
[`docs/SHOPPING-LIST.md`](docs/SHOPPING-LIST.md), and a new dependency is
expected to argue the same case.

**The store mutates the document in place.** `Store.edit` and `Store.update`
change the live objects; history clones on the way into a snapshot, not on the
way out of an edit. So object identity and revision counters are useless as
cache keys, and anything that wants to know whether geometry changed has to
compare the numbers. See `src/view/pathcache.ts`.

**A node is named by `PathNode.id`, never by its index.** The selection holds
ids; `resolveNodes` turns them into positions, and a `NodeRef` is only true at
the instant it was read. Build a ref, use it, throw it away. `cloneNode` carries
the id through a history snapshot, which is what makes a selection survive undo.
Nothing writes it to a file. §43 of `docs/ARCHITECTURE.md` has the argument.

That carrying-through is why **a copy that will live in the document beside its
original has to be reidentified**, with `reidentify` from `src/model/doc.ts`. An
id naming two nodes is two nodes no selection can separate, so clicking one
selects both and dragging one moves both, and the document is well formed
throughout. Duplicate, paste and both branches of `breakAt` each had it. §46 has
the three, and `test/identity.test.ts` is what holds the rule.

**Touch is built but has never been held.** The desktop backlog finished first,
which is what the three rules below were protecting, and the retrofit they were
protecting happened on 2026-08-13. Nothing here has been tried on a real phone
or tablet, so treat every claim about touch as measured in a headless browser
and unconfirmed by a hand. The rules still hold for new work:

- Every operation gets a button, not only a shortcut. Shortcuts stay as the
  fast path.
- No information appears only on hover. A tooltip may enrich, never inform.
- New controls are laid out at 44 px minimum, which is the touch target
  minimum in both Apple's and Google's guidance.

Four pieces are in place, all from 2026-08-13:

- **Input.** The controller listens to `pointer*` and never to `mouse*`, and
  the overlay sets `touch-action: none`.
- **Size.** A `@media (pointer: coarse)` block at the end of
  `src/ui/styles.css` raises `--h` and the handful of controls that do not take
  their height from it, so **every one of the 169 controls is at least 44 px to
  a finger, and none of them changed for a mouse**.
- **Zoom.** Two fingers zoom about the point between them and pan as that point
  moves: `Controller.pinchMove`.
- **Modifiers.** Seven pointer gestures change meaning under Shift or Alt, and
  a phone has no key to hold. Two latching buttons at the head of the status
  strip stand in, read by `Controller.shift` and `Controller.alt` beside the
  real key. They stop at the pointer on purpose: a latched Shift must not turn
  every later key press into its Shift variant.

Both strips overflow at 390 px and both now scroll, with the controls you need
mid-gesture pinned: the panel toggles at the right of the toolbar, the held
keys at the left of the status strip.

Both counts come from `node tools/touch.mjs` with the dev server up, `--coarse`
for the second. Re-run it rather than trusting a figure written here. **Three
corrections went into the tool on 2026-08-13, so no count recorded before that
date means what it says.** It skipped controls in collapsed groups, of which
the rail redesign left it eleven; it skipped disabled ones, which are laid out
at the size they will have when they are enabled; and its key for a control
with no id collided, which quietly merged 28 of them into other rows. On the
markup of that date it had been reporting 37 controls where there were 166.

## Tests

A test that cannot fail is worse than no test, and four reviews here have found
ten of them plus the whole browser suite. Where an assertion could pass for the
wrong reason, measure instead of comparing: curve equality by projected
deviation, booleans by enclosed area, rendering by the coordinates that reached
the DOM. Before trusting a new test, break the code it covers and watch it go
red.

**No browser scenario could fail before 2026-08-14, and thirteen still could
not afterwards.** Two separate holes, both closed on that date:

- A failed `check` threw, the top-level `try` in `tools/drive.mjs` turned the
  throw into a field of the JSON it printed, and nothing set `process.exitCode`.
  Every scenario, every `check` in them, and the CI loop reading their exit
  codes could only go red if the browser failed to launch.
- Thirteen of the 43 never called `check` at all. They drove the editor, read
  the page and returned what they found, so breaking what they exercised
  changed the printed blob and nothing else. `node tools/drive.mjs --audit`
  refuses that now and CI runs it before the scenarios.

Any green recorded before 2026-08-14 means the browser started. Re-running the
sweep after both fixes put all 43 back at green, so nothing was hiding, but no
earlier figure is evidence of that.

The exit code now also fails on a `d` attribute that reached the DOM holding
`NaN`, `Infinity` or `undefined`, and on anything the page logged as an error.
Both were already measured by the audit every scenario runs and neither was
read by anything.

**No browser scenario waits a fixed number of milliseconds.** There were 233
such sleeps, each a guess about how long a machine takes, so each was either
slower than it needed to be or shorter than the thing it waited for. Three waits
replaced them, and which one a step needs is decided by what it is waiting for:

| Waiting for | Use |
|---|---|
| A render | `settle(page)` -- two frames, because the controller renders one `requestAnimationFrame` after a store notification |
| A panel animating and the canvas re-fitting | `laidOut(page)` -- polls until the canvas box stops moving |
| Something the app owns a timer or a worker for | Its own condition: `page.waitForSelector`, `waitForFunction`, `describedBy`, `backdropRead`, `traced` |

The one remaining `waitForTimeout` is the 25 ms poll interval inside `laidOut`.

**`node tools/mutate.mjs <path>` breaks the source on purpose** and reports what
the unit suite still calls green. A survivor is a change to what the program
does that no test disagreed with. It rewrites files in place while it runs, so
it cannot share the tree with `npm run drive`.

**A survivor count is not a finding until someone has read the survivors.** In
`offsetSubpath` it went from 29 of 92 to 26 of 87 while the gap closed, because
most survivors change nothing observable and no test could have caught them.
`--apply N` puts one mutation in the tree so that difference can be looked at;
`git checkout` puts it back. Report the number that moved something, and say
which measure moved. Of the 26 there now, 2 do, and both are a node laid out
differently rather than a shape that is wrong.

`docs/ARCHITECTURE.md` has the full argument under "Testing philosophy".

## Writing

[`docs/STYLE.md`](docs/STYLE.md) governs anything a reader sees, including
status-line strings. `npm run check:docs` enforces the parts of it that are
decidable without judgement, and checks every link in the docs tree while it is
there. `docs/ARCHITECTURE.md`, `docs/reviews/` and `docs/SHOPPING-LIST.md` are
exempt from the em-dash rule and from nothing else.
