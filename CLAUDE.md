# svg-editor

**This project is TypeScript and npm, not Python.** The `CLAUDE.md` one level up
in `projects/` describes a uv project and applies to its Python siblings. Nothing
in it applies here: there is no `pyproject.toml`, no `.venv`, and `uv run` will
not start anything. Use `npm`.

The general rules for folders, naming, writing, interface, design and code are
the [handbook](../handbook/README.md) skills. What follows is only what those
cannot know about this project.

## Commands

| Task | Command |
|---|---|
| Run it | `npm run dev` |
| Typecheck | `npm run check` |
| Unit and DOM tests | `npm test` |
| One browser scenario | `npm run drive <scenario>` |
| Style sweep and link check | `npm run check:docs` |
| Build the single file | `npm run build` |

`npm run build` typechecks first, so a build that succeeds is a typecheck that
succeeded.

## Three constraints that are not obvious from the code

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
