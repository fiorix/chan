# The e2e harnesses report results they did not measure

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding TERMPIX-01 high; E2EC-03, E2EB-03, E2EB-04, E2EA-01, E2EA-04, E2EB-02 and E2EC-02 medium), re-verified against `main` at `d3de0180b`. `scripts/e2e/browser-smoke` is untouched since the review, so every finding in it is verbatim.

## What was seen

`scripts/e2e` is owner-run tooling whose only product is a verdict. These are the places where the verdict is not supported by the evidence.

**A regression reported as a skip.** `checks/110-graph-lens.mjs` wraps its core wait in a bare `catch` that calls `ctx.skip`, so the regression the check exists to catch, the tag-lens button ceasing to render, prints ALL GREEN and exits 0. Neighbour check 111 awaits the identical predicate with no catch.

**A failure recorded as a pass.** `checks/63-external-shrink-convergence.mjs` records its rapid add/remove step as `ok` with a hard-coded `cycles: 3` after a cycle that never converged: both `break` paths leave the previous cycle's timing in place and the record runs unconditionally.

**Assertions that cannot fail.** Scenario D of `checks/59-large-file-streaming.mjs` reads the first `.cm-content` on a page that by then holds two editors, so its invalid-UTF-8 assertion is true by short circuit. Leg 5 of `checks/93-terminal-secret-masking.mjs` asserts the ghostty backend shows no mask decorations while masking is still switched off from leg 4. `checks/30-pdf-cs-export.mjs` still skips on a regex meant for a `cs export` that did not exist yet; the subcommand ships, and the regex now swallows any real failure whose message contains "invalid" or "unexpected".

**A failure that loses the whole run.** `checks/62-binary-transfer-streaming.mjs` reads `/proc` unguarded inside a 25 ms timer, which throws the moment the server pid goes away, the exact regression it hunts; `checks/98-workspace-root-loss.mjs` leaves a `page.evaluate` promise unattended on its failure path. Either kills the node process before `results.json` is written, so every check's verdict is lost, not one.

**A driver that dies before it measures.** `scripts/e2e/terminal-pixels.mjs` scrapes the Windows font chain out of `TerminalTab.svelte` with a regex; the chain lives in `web/packages/workspace-app/src/terminal/font.ts` now. The regex returns null and the driver throws after building the product and launching the browser, so every Windows pixel scenario has been failing for the wrong reason. Its two Python siblings carry the same defect, and one measures a font chain the product does not ship.

## Desired contract

A check that cannot evaluate its core assertion fails or says it skipped for a named environmental reason; it never converts its own assertion into a skip. A recorded result carries measured values. A harness run always ends with a verdict file, whatever a single check does.

## Boundaries

`scripts/e2e/browser-smoke/checks/` (30, 59, 62, 63, 93, 98, 110), the runner's top level for an `unhandledRejection` and `uncaughtException` handler that records the failing check and still writes `results.json`, `scripts/e2e/terminal-pixels.mjs` and its two Python siblings, which import the font chain from the module that owns it instead of scraping it. The copy-pasted helpers across checks are the next version's work. The suite stays outside `make pre-push`.

## Acceptance

1. Each repaired check is shown red against a deliberately broken product or fixture: the lens button hidden, a cycle that cannot converge, the wrong editor holding the text, masking left off, a `cs export` that fails.
2. Killing the server mid-run in check 62, and forcing a failure in 98, each leave a `results.json` that names the failing check.
3. `terminal-pixels.mjs` reads the font chain from `terminal/font.ts` and reaches its first scenario; the Windows run itself is the owner's to make.
4. The suite's count against a baseline on unmodified code is recorded, so the repaired checks' new reds are told apart from this box's known ones.
