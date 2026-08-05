# Three editor tests fail intermittently and make every gate nondeterministic

Status: REGISTERED for v0.86.0, grounded 2026-08-05 by base reproduction.

## What

Three tests in `web/packages/workspace-app/src/editor/` fail intermittently on an unmodified tree:

```
src/editor/fold.test.ts            a fold range reaches its terminator past the lazy-parse viewport
src/editor/widgets/diagram.test.ts cursor OUTSIDE a closed block renders the diagram widget
src/editor/widgets/table.test.ts   renders a pipe table as a block widget without throwing
```

All three assert that a CodeMirror decoration rendered, and fail with a null where a widget was expected. They fail more readily under load, and they also fail cold.

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

## Contract

- The three tests pass deterministically, or the behavior they assert is covered by a test that does.
- `make pre-push` does not fail on an unmodified tree.
- Whatever replaces them still fails when the decoration genuinely does not render. Deleting or skipping the cases is not a fix: they cover real behavior, and a diagram or table that stops rendering should still break the build.

## Acceptance

- The suspected cause is named rather than worked around. The evidence points at a race between the first asynchronous render and the assertion, so the likely shapes are an await on a render-complete signal instead of a timing assumption, or a deterministic fake for the first mermaid initialization.
- Each of the three passes 20 consecutive isolated runs, and 5 consecutive full package runs, on an otherwise idle machine.
- Per the gate discipline, prove the repaired tests can still go red: break the decoration on purpose once, capture the red, then restore.
- The fix does not rely on retry, on a raised timeout alone, or on running the file in isolation. A test that only passes when nothing else runs has not been fixed.

## Rough size

Small to medium, and mostly investigation. The change is likely to be small once the race is identified; identifying it is the work, and the reproduction is intermittent by nature.
