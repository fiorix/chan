# Document sync and scene sync stay off for a page's life when their first connection closes before a frame

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner has not ruled on this item. Found beside the order on a stopping devserver by its builder (`dev/v0101-team/reports/report-Services-40.md` in the development tree, "Found outside the items, for the lead to raise", its second entry), read by an agent of that seat and not run. The lead told the owner of it on 2026-09-28 and said that it would be raised at the landing, "to be read by a web lane first" (`dev/v0101-team/for-host-2026-09-27.md`, the entry of 23:18Z); a reading of the ledger on 2026-09-29 found no item for it (`dev/v0101-team/machine-move/lead38-recon-1-prior-host-questions.md`, E4). No record of a web lane's reading was found.

## What was seen

By the report: a window's document sync socket and its scene sync socket "stay off for the page's life when the first dial closes before a frame" (`web/packages/workspace-app/src/state/docSync.svelte.ts:859-866`; `sceneSync.svelte.ts:670-676`; the report's lines, at its lane's base `61895c96d`). The report infers the cause and marks it as the question to settle first: that the devserver's gate, which refuses a tenant's requests while the devserver starts or stops, refuses the socket's upgrade. The lead's note to the owner says the same, as the seat's inference.

Not established: whether the gate's refusal of an upgrade is what closes the first dial; whether a window meets it in practice; what a user sees in a window whose sync is off, whether its edits still reach the file and whether a peer's edits reach it; and whether a reload is the only way back. Nothing was run, and the lines were read by one seat's agent and by nobody since.

## Desired contract

Not written yet: the record holds a mechanism as one seat read it, and the reading that would say what a user loses has not been made.

## What to do

A reading first, by a web lane, as the lead's note asks: at the head then in hand, whether a first dial that closes before a frame leaves both sessions off for the page's life, and what closes it. Then decide.

## Boundaries

By the report's citations, `web/packages/workspace-app/src/state/docSync.svelte.ts` and `sceneSync.svelte.ts`. What the devserver's gate answers is [a-stopping-devserver-says-it-is-restoring](../done/a-stopping-devserver-says-it-is-restoring.md)'s. The other findings of the same section of the report are [a-stopping-devservers-report-left-four-findings](a-stopping-devservers-report-left-four-findings.md).

## Acceptance

1. The reading is recorded with its lines: what closes a first dial before a frame, and what the page does after it.
2. The owner's decision on what the reading finds is recorded.
