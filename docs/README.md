# Documentation

Four kinds of material live here, and they are not read the same way. The
distinction matters more than the subject: a specification read as a guide sends
you somewhere the code never went, and a backlog read as a description tells you
a feature exists that does not.

| Entry | You may | You may not |
|---|---|---|
| [`manual/`](manual/README.md) | rely on it: it describes the editor as shipped | expect it to explain the code |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | rely on it for why the code has the shape it has, and for what it costs | read it as a user guide, or as an API listing |
| [`STYLE.md`](STYLE.md) | apply it to anything a reader sees | treat it as a general writing guide, which it defers to |
| [`SHOPPING-LIST.md`](SHOPPING-LIST.md) | read it for what is not built and why it was passed over | assume anything marked `[ ]` exists |
| [`reviews/`](reviews/README.md) | read it for why a decision went the way it did | act on it: every entry is true of its date and is left that way |

The split inside `manual/` is by reader ([Diátaxis](https://diataxis.fr/)):
tutorial, how-to, reference, explanation. Everything else here splits by how
much authority it carries.

## Where a fact belongs

One fact, one place. When two of these disagree, the order below decides which
is wrong, and the disagreement is a defect in the loser rather than a matter of
taste.

1. The code and the tests.
2. `ARCHITECTURE.md`, for a reason the code cannot state.
3. `manual/`, for what a user sees.
4. `SHOPPING-LIST.md` and `reviews/`, which record intent and history and never
   define behaviour.

The manual describes behaviour and never explains implementation, except where
the implementation changes what a reader should expect. `ARCHITECTURE.md`
explains implementation and never instructs a user. Where the two cover the same
limit, the manual says what to do about it and `ARCHITECTURE.md` says why it
cannot be fixed.
