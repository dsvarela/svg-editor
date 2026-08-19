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
| Contrast floors, over the palette | `npm run check:contrast` |
| What a finger cannot hit | `node tools/touch.mjs` |
| What a keyboard cannot reach | `node tools/keys.mjs` |
| Build the single file | `npm run build` |

`npm run build` typechecks first, so a build that succeeds is a typecheck that
succeeded.

## Constraints that are not obvious from the code

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

**A group is a relation, not a container.** `Doc.shapes` stays one flat array in
paint order, and `Shape.group` points up at a `Group` that points up at its parent.
No group holds a list of its members. What that costs is one invariant: **a group's
shapes are contiguous in `doc.shapes`**, because a `<g>` holds its children in one
run. **Nothing has to remember it: `Store.edit` and `Store.tryEdit` call
`rebuildPaintOrder` after every edit**, beside `pruneGroups`, so a broken run is a
state the document cannot be left in rather than a rule each new operation has to
be told about. That is not how it started. It started as a rule three separate
functions wrote `doc.shapes` under, and the one named here as its guardian was
the one that broke it: grouping a loose shape with one taken from the middle of a
group split that group into two runs, and the export wrote it as two `<g>`
elements under two different ids. A copy still lands outside any group, because
keeping its group would write the same `<g>` twice. A group carries no transform,
per §5. §49 of `docs/ARCHITECTURE.md` has the argument.

**Touch is built but has never been held.** The desktop backlog finished first,
which is what the three rules below were protecting, and the retrofit they were
protecting happened on 2026-08-13. Nothing here has been tried on a real phone
or tablet, so treat every claim about touch as measured in a headless browser
and unconfirmed by a hand. The rules still hold for new work:

- Every operation gets a button, not only a shortcut. Shortcuts stay as the
  fast path. **On a mouse the button may be hidden, never absent**: the five that
  only repeat a key (Duplicate, Delete, Copy, Cut, Paste) and the node stepper
  are behind `touchButtons`, which a FIRST visit sets from `pointer: coarse`. A
  restored session carries the answer somebody gave and a media query does not
  overrule it, so the guess is made only when there is nothing to restore. A
  new operation still needs a button, and needs a key before it may hide one.
- No information appears only on hover. A tooltip may enrich, never inform.
- New controls are laid out at 44 px minimum, which is the touch target
  minimum in both Apple's and Google's guidance.

Four pieces are in place, all from 2026-08-13:

- **Input.** The controller listens to `pointer*` and never to `mouse*`, and
  the overlay sets `touch-action: none`.
- **Size.** A `@media (pointer: coarse)` block near the end of
  `src/ui/styles.css` raises `--h` and the handful of controls that do not take
  their height from it, so **every one of the 228 controls is at least 44 px to
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

**Three instruments are gates, and were not until 2026-08-19.** `tools/keys.mjs`
and `tools/touch.mjs` printed a count and exited 0 whatever it said, and CI ran
neither of them, nor `npm run check:contrast`. Both set an exit code now and CI
runs all three, so a regression in keyboard reach, touch target size or contrast
turns a run red. **No green from those three before that date is evidence of
anything**, which is the fourth time a signal in this project has been worth
nothing.

**A reload is not a reset.** The session is written to `localStorage` on a
timer and read back on load, and the page flushes it on `pagehide` -- so
`localStorage.clear()` from a harness does not hold across a reload, because the
page writes it straight back on the way out. A scenario that wants a fresh
editor presses **Forget saved work**, which latches for the rest of the session.
`applyTwoShapes` and `session` are the two that reload. §59 of
`docs/ARCHITECTURE.md` has the design.

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

**The audit also fails on overlay decoration that takes the press without naming
a hit**, painted over something that does, because such an element does the
opposite of the control it covers. It found two, and only one was doing harm:
`.handle-line` cost **16.4% of the whole pixels down a selected rectangle's
edge**, and restoring it failed 31 of the 52 scenarios there were then. §54 of
`docs/ARCHITECTURE.md` has the rule and both instances.

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

**The browser is Firefox, resolved by `tools/browser.mjs`.** All three driving
tools go through it: `BROWSER` picks the engine, `BROWSER_PATH` points at a
system Chromium-family binary, `APP_URL` moves the dev server. Playwright drives
its own builds, so a stock `/usr/bin/firefox` cannot be used and
`node node_modules/playwright-core/cli.js install firefox` is what puts one
there. **All 53 scenarios pass on Firefox, and no figure here was measured on it
before 2026-08-18.**

**CI's browser job could not launch one from that switch until 2026-08-18, so a
red run in between said nothing about the code.** `ci.yml` hunted for a system
Edge and exported `BROWSER_PATH`, which `browser.mjs` reads only when the engine
is Chromium. It found Edge, set the path, then tried to launch a Firefox nobody
had installed, and all 52 scenarios died at launch. The job installs the
Playwright build now. This is the third time a signal here has been worth
nothing: the two before it were greens, and this one was a red, which is the
easier of the two to leave alone because it looks like it is already telling you
something.

**The three that failed on the switch were defects in the tests, not differences
between the engines.** Each looked like the second and was the first:

- `backdrop`'s 4 by 3 PNG was truncated: an IDAT holding 20 bytes of a deflate
  stream that needed more, so only the first of three rows could be
  reconstructed. Chromium decodes what arrived and reports the header's 4 by 3;
  Firefox refuses the image. Every check passed on both, because they all read
  the `<image>` element's attributes and none read a pixel. `png()` builds the
  fixture now and the check reads the far corner, which catches it on either
  engine.
- `angles` asked for the pointer at client pixel 656.887. **A browser delivers
  whole pixels**: Firefox truncates the fraction, Chromium keeps it, so the two
  put the pointer in different places. `toClient` rounds, which makes what the
  harness asks for what the page will see, and `toDoc` inverts it so a scenario
  can compute an expectation from where the pointer is rather than where it
  aimed.
- `traceWorker` measured main-thread blocking through a `longtask`
  `PerformanceObserver`. **`longtask` is a Chromium entry type, and `observe`
  ignores a type it does not know rather than refusing it**, so it reported 0 ms
  for both runs and the scenario compared two numbers that had measured nothing.
  A 10 ms interval measuring its own lateness reads 800 ms on a thread blocked
  for 800, on both engines, over an 11 ms idle floor.

**No source file may contain a NUL byte.** `rg` treats one as binary and skips
the whole file, and three of this project's own instruments run on `rg`:
`code/unreached.mjs` reported every name in `src/model/snapping.ts` as
unreferenced because it could not read the file that used them. The sentinel
that caused it is `#guides` now. Any id that cannot collide works, because every
shape id comes from `nextId` as `prefix-n` and an imported `id` attribute becomes
the shape's name rather than its id.

**Nothing may edit `src/` while `npm run drive` is running.** The dev server
reloads the page on a save, and a scenario mid-step dies with `Execution context
was destroyed, most likely because of a navigation`. That message means an edit
landed during the run and says nothing about the code. Re-run the scenario on a
still tree before believing it. This is the same constraint `mutate.mjs` has, for
the same reason, and it applies to a hand edit just as much.

**A survivor count is not a finding until someone has read the survivors.** In
`offsetSubpath` it went from 29 of 92 to 26 of 87 while the gap closed, because
most survivors change nothing observable and no test could have caught them.
`--apply N` puts one mutation in the tree so that difference can be looked at;
`git checkout` puts it back. Report the number that moved something, and say
which measure moved. Of the 26 there now, 2 do, and both are a node laid out
differently rather than a shape that is wrong.

**Two changes on 2026-08-19 moved every site index and cut the count by about a
quarter, so no figure above was measured against the list the tool builds now.**
It counted the `<` and `>` of a TypeScript type argument as operators, and
`new Promise<Blob>` mutated to `Promise<=Blob>` is not the syntax error it looks
like: esbuild reads it as `new Promise() <= Blob > (…)`, which parses, so the
file loads and the swap can never be a finding. And it judged a comment one line
at a time, so a wrapped block-comment line beginning with anything but `*` read
as code. Five files went from 170 sites to 129. **It also left a hung
`vitest related` alive** past its own timeout, holding two cores, because
`spawnSync` signalled the `npx` above vitest rather than vitest; the local binary
is spawned directly now. A timing-sensitive measurement taken after a sweep on
the old tool is worth nothing.

`docs/ARCHITECTURE.md` has the full argument under "Testing philosophy".

## Writing

[`docs/STYLE.md`](docs/STYLE.md) governs anything a reader sees, including
status-line strings. `npm run check:docs` enforces the parts of it that are
decidable without judgement, and checks every link in the docs tree while it is
there. `docs/ARCHITECTURE.md`, `docs/reviews/` and `docs/SHOPPING-LIST.md` are
exempt from the em-dash rule and from nothing else.
