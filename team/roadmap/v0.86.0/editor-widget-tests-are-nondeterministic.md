# Three editor tests fail intermittently and make every gate nondeterministic

Status: REGISTERED for v0.86.0, grounded 2026-08-05 by base reproduction.

## What

Three tests in `web/packages/workspace-app/src/editor/` fail intermittently on an unmodified tree:

```
src/editor/fold.test.ts            a fold range reaches its terminator past the lazy-parse viewport
src/editor/widgets/diagram.test.ts cursor OUTSIDE a closed block renders the diagram widget
src/editor/widgets/table.test.ts   renders a pipe table as a block widget without throwing
```

They share a trigger, timing, but not a mechanism, and the difference decides what a fix has to do.

`diagram` and `table` assert that a CodeMirror decoration rendered and fail with a null where a widget was expected. `fold` asserts no widget at all: it pins a fold range's end at `bottom.from - 1` and fails with a number, `doc.length`, because the range took its doc-end fallback. All of them fail more readily under load, and they also fail cold.

This makes `make pre-push` nondeterministic. Every contributor and every release gate inherits a chance of a red that means nothing, and the project's own standard says that is a defective check: a red that fires on a run that shipped trains the operator to discard it, so the next genuine failure arrives with the same name and gets waved through.

## Verified current state (2026-08-05)

Measured during the v0.85.0 delivery round, on the untouched round base in an isolated worktree with no in-flight work present:

```
diagram.test.ts   3 runs at base, alone   1 failed, 2 passed
fold.test.ts      3 runs at base, alone   1 failed, 2 passed
table.test.ts     failed at base alongside diagram in the same command, while diagram passed
```

Roughly one failure in three for the two measured individually. The failing `diagram` case is the FIRST test in its describe block, which fits a cold-start race on the first mermaid render rather than a wrong assertion.

Four independent observations agree on the class, and they disagree on WHICH of the three fails in any given run, which is itself the evidence that the trigger is timing rather than content:

- A full package run reporting `fold`, `diagram`, and `table`.
- A second full run reporting the same three.
- A shared-tree run where `diagram` and `table` failed and a base run in the clean worktree where `table` failed and `diagram` passed.
- Isolated repeats where each of `fold`, `table`, and `diagram` passed on some runs and failed on others.

Ruled out during the investigation rather than assumed:

- Not caused by any change in that release. `git diff --name-only <base>..HEAD -- src/editor/` was empty for the whole round, and no in-flight work touched that directory.
- Not a dependency drift. `node_modules/.package-lock.json` was byte-identical across the worktrees, `mermaid` resolved to the same version in all of them, and the `@excalidraw/mermaid-to-excalidraw` patch was applied in each.
- Not a config change. `vite.config.ts`, `vitest.setup.ts`, `web/package.json`, and the lockfile were untouched.
- Not purely load. Each of the three has failed on an otherwise idle repeat, so scheduling worker pools apart reduces the rate without removing it.

## The `fold` mechanism, measured (2026-08-06)

`fold.test.ts` case 11 builds a 4000-line filler document, deliberately does not pre-parse it, and requires the fold helper to force the parse itself far enough to reach the terminating `## Bottom` heading.

Observed failure: `expected 84026 to be 84006`. Those two numbers name the mechanism exactly. `84026` is the document length (`## Top\n` at 7, filler at 84000, `## Bottom\n` at 10, `tail body` at 9). `84006` is `bottom.from - 1`, the assertion's target. So the range ended at the end of the document rather than at the heading, which is the helper's doc-end fallback: the forced parse did not reach `## Bottom` within its budget, so no terminator was found.

That is a time-budgeted parse asserted exactly, and it is a different failure from the other two. It observed 18 of 18 passing in isolation and failed inside a full package run that took 347s wall with 1120s of environment time on a machine with concurrent builds. The load correlation is consistent but was not reproduced under controlled contention, so the mechanism is established and the trigger is not.

This is why the acceptance below separates them. A deterministic fake for the first mermaid initialization would address `diagram` and `table` and would not touch `fold`, whose parse budget is unrelated to mermaid.

## Contract

- The three tests pass deterministically, or the behavior they assert is covered by a test that does.
- `make pre-push` does not fail on an unmodified tree.
- Whatever replaces them still fails when the decoration genuinely does not render. Deleting or skipping the cases is not a fix: they cover real behavior, and a diagram or table that stops rendering should still break the build.

## Acceptance

- The suspected cause is named rather than worked around, and named per mechanism rather than for the group. For `diagram` and `table` the evidence points at a race between the first asynchronous render and the assertion, so the likely shapes are an await on a render-complete signal instead of a timing assumption, or a deterministic fake for the first mermaid initialization. For `fold` the mechanism is already measured above and is a parse budget, so the fix is on the forcing side: the helper either parses to the terminator deterministically or reports that it could not, rather than returning a doc-end range that is indistinguishable from a real one. A fold range that silently means "I gave up looking" is a production concern, not only a test one.
- Each of the three passes 20 consecutive isolated runs, and 5 consecutive full package runs, on an otherwise idle machine.
- Per the gate discipline, prove the repaired tests can still go red: break the decoration on purpose once, capture the red, then restore.
- The fix does not rely on retry, on a raised timeout alone, or on running the file in isolation. A test that only passes when nothing else runs has not been fixed.

## Rough size

Small to medium, and mostly investigation. The change is likely to be small once the race is identified; identifying it is the work, and the reproduction is intermittent by nature.
