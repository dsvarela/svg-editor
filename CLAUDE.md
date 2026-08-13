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

**Touch is not supported yet, and new work must not make it harder.** The
decision is to finish the desktop backlog first, so nothing here is asked to
work on a phone today. What is asked is that the gap stops widening, because
every operation reachable only by key or hover is one more thing to retrofit:

- Every operation gets a button, not only a shortcut. Shortcuts stay as the
  fast path.
- No information appears only on hover. A tooltip may enrich, never inform.
- New controls are laid out at 44 px minimum, which is the touch target
  minimum in both Apple's and Google's guidance.

The input layer is already there: the controller listens to `pointer*` events
and never to `mouse*`, and the overlay sets `touch-action: none`. Sizing is
there too, as of 2026-08-13: `src/ui/styles.css` ends with a
`@media (pointer: coarse)` block that raises `--h` and the handful of controls
that do not take their height from it, so **every one of the 138 controls is at
least 44 px to a finger and none of them changed for a mouse**. Two fingers
zoom and pan, in `Controller.pinchMove`. What blocks a phone today is a toolbar
that scrolls sideways to reach the panel toggles, and that nothing beyond the
zoom has been tried on a real one: the gesture tests drive synthetic touch
events, which prove the arithmetic and say nothing about a hand.

Both numbers come from `node tools/touch.mjs` with the dev server up, `--coarse`
for the second. Re-run it rather than trusting a figure written here. Two
corrections went into the tool on 2026-08-13 and neither number before that date
means what it says: it skipped controls in collapsed groups, of which the rail
redesign left it eleven, and it skipped disabled ones, which are laid out at the
size they will have when they are enabled. It had been reporting 37 controls
where the markup holds 166.

## Tests

A test that cannot fail is worse than no test, and three reviews here found nine
of them. Where an assertion could pass for the wrong reason, measure instead of
comparing: curve equality by projected deviation, booleans by enclosed area,
rendering by the coordinates that reached the DOM. Before trusting a new test,
break the code it covers and watch it go red.

`docs/ARCHITECTURE.md` has the full argument under "Testing philosophy".

## Writing

[`docs/STYLE.md`](docs/STYLE.md) governs anything a reader sees, including
status-line strings. `npm run check:docs` enforces the parts of it that are
decidable without judgement, and checks every link in the docs tree while it is
there. `docs/ARCHITECTURE.md`, `docs/reviews/` and `docs/SHOPPING-LIST.md` are
exempt from the em-dash rule and from nothing else.
