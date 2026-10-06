# No client reads the code that a stopping devserver answers

Status: accepted for real-stop measurement only; no client change is approved.

## Owner decision, 2026-10-06

Measure a disposable devserver's actual stop with the browser connecting-page wait, desktop probe and workspace API callers. Distinguish coded devserver_stopping 503 responses from connection failures and record what each client shows. Use the observations to propose client behavior; do not infer a rule for every 503 from this code.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: carried into v0.103.0 at the v0.102.0 GA on 2026-10-05 with its measurement not taken; nothing of it was built.

Record before the release: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner had not ruled on this item then. It is the cost written under What shipped in [a-stopping-devserver-says-it-is-restoring](../done/a-stopping-devserver-says-it-is-restoring.md), which no item held. The builder's report names it as a residual (`dev/v0101-team/reports/report-Services-40.md` in the development tree, "The clients of the 503 and the launcher routes, at the tip" and "Residuals"), and a reading of the ledger on 2026-09-29 searched `web`, `desktop`, `crates/chan` and `crates/chan-shell` at `4c4ada0a1` and found no reader (`dev/v0101-team/machine-move/lead38-recon-5-runtime-launcher-drawing.md`, T5, part c). Read, not run. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: the measurement is accepted, of how often a real stop reaches a client as the 503, taken by the team. A build is ruled after it.

## What was seen

From the stop signal on, a devserver's gate answers a tenant's request with 503, the sentence `the devserver is stopping`, the code `devserver_stopping` and no `Retry-After`, where a devserver that starts answers 503 with `Retry-After: 1`; the shape is the lead's ruling, which the owner confirmed as built on 2026-09-29, so that a client can wait out a start and give up on a stop without reading words. The build is on the integration branch and not on `main`.

No client branches on the code. By the builder's report, whose lines are at its lane's tip:

- **The shared wait of a browser window for its page** retries the stop's answer every second for sixty seconds, since it retries every 503 and reads a missing header as one second (`web/packages/web-shared/src/window-page.ts:81-95`). The report notes that it "could give up on `devserver_stopping` through the refusal it already holds".
- **The desktop's probe** reads the status alone.
- **The workspace app's callers of `isTransientApiError`** still take the stop as transient.

So a desktop window on its connecting page and a browser window in the shared wait tell a stop from a start by nothing.

Not established: how often the code reaches a client at all. A refusal reaches a client only when its request is dispatched after the coordinator has entered its stopping phase and before its connection shuts down, so by a reading of the framework's source most clients of a stopping devserver meet a closed or refused connection and not the 503; that was never measured, and on 2026-09-29 the owner ruled who measures it (in the item above). What each client should show at a stop is in no record.

## Desired contract

A client that receives a stopping devserver's refusal tells it from a starting devserver's by its code, and does not wait it out as it waits out a start.

## What to do

Decide, after the measurement of what a real stop answers, since it says how many clients the code reaches. The records name no shape beyond the report's note on the shared wait.

## Boundaries

By the report's citations: `web/packages/web-shared/src/window-page.ts`, the desktop's probe, and the workspace app's callers of `isTransientApiError`, with their tests. What the devserver answers is [a-stopping-devserver-says-it-is-restoring](../done/a-stopping-devserver-says-it-is-restoring.md)'s, and the refusal's envelope is [refusals-answer-in-four-shapes](../done/refusals-answer-in-four-shapes.md)'s.

## Acceptance

1. The owner's decision is recorded, with the measurement it rests on.
2. If it is built: each client that reads a devserver's 503 has a pin of what it does with the code `devserver_stopping`, red first.
