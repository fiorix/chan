# The e2e harnesses report results they did not measure

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): The e2e harnesses fail or skip for a named reason when they cannot evaluate a check, record measured values, and always end with a verdict file.

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

## The baseline, by name rather than by count

Measured on unmodified code in a build container: **47 recorded, 10 failed, 1 skipped**, not the larger number this round carried in its notes before anyone ran it. The ten are `binary-transfer-streaming-queue`, `cs submit refusal exits non-zero`, `editor-appearance`, `large-file-streaming`, `launcher-open`, `terminal-appearance`, `terminal-ghostty-toggle`, `terminal-mouse-toggle`, `terminal-secret-masking` and `video-inspector`. The skip is `graph-lens`, which is this item's own first finding showing itself.

A count cannot do the job acceptance 4 asks of it, because a repaired check produces a red the baseline does not have. `graph-lens` is the case: it passes when run alone and skips in the full suite, so it does not hold the suite-position property the harness requires, and the skip is what kept that invisible. Its repair turns a hidden skip into a visible red, which is the item working rather than a regression. So a reading compares names and failure text, and a check that is still red is checked against the text it is red for: `large-file-streaming` now fails on scenario F rather than D, which says the D repair took and the baseline red was always elsewhere.

`workspace-root-loss` failed on its teardown in the post-change run and not in the baseline, passes twice when run alone, and cannot be made to fail by the change this item made to it. One run each side cannot separate an intermittent failure from a newly exposed one, and no verdict is recorded here beyond those three facts.

## What acceptance 1 cost, and where it stopped

Four checks were shown red against the real thing or by replaying both recording rules over the same outcomes. Four were not, and each for a stated reason rather than for want of trying:

- `binary-transfer-streaming-queue`: the environment break never lands, because the check fails earlier on its own baseline red, before the guarded code runs. The repair is unreachable until that earlier failure is somebody's item, which is a fact about the order those two sit in.
- `pdf-cs-export`: removing the seeded file mid-run does not redden it, so the export does not depend on that file being on disk at that moment.
- `large-file-streaming` scenario D: the open guard is reddenable by pointing at a name that never opens; the UTF-8 assertion itself needs a product that displays invalid UTF-8 as valid.
- `terminal-secret-masking` leg 5: needs a backend that paints mask decorations with masking on. No fixture or environment does it.

The last two need a broken product build per check, which is not a trade this version makes against a disk that is the round's constraint.

## A defect the repair surfaced

`selectTerminalFont` leads with Source Code Pro when the preference asks for it **or** the operating system is Linux, so both Python harnesses were returning a bare fallback chain for `os-default` that the product never ships. That is a quiet wrong measurement rather than a loud death, and it is more this item's theme than the failure the item was raised for. The harnesses read the chain from `terminal/font.ts` rather than importing it, because importing needs that module restructured for a node without TypeScript support; the read is a residual that belongs with the source-text test convention.
