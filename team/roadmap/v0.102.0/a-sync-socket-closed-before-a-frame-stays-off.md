# Document sync and scene sync stay off for a page's life when their first connection closes before a frame

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner had not ruled on this item then. Found beside the order on a stopping devserver by its builder (`dev/v0101-team/reports/report-Services-40.md` in the development tree, "Found outside the items, for the lead to raise", its second entry), read by an agent of that seat and not run. The lead told the owner of it on 2026-09-28 and said that it would be raised at the landing, "to be read by a web lane first" (`dev/v0101-team/for-host-2026-09-27.md`, the entry of 23:18Z); a reading of the ledger on 2026-09-29 found no item for it (`dev/v0101-team/machine-move/lead38-recon-1-prior-host-questions.md`, E4). No record of a web lane's reading was found. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

On 2026-10-03 the owner ruled, as the lead recommended: the reading is accepted. A web seat reads the first dial at the current head, and a fix is ruled after it.

Later on 2026-10-03, with the reading in hand, the owner ruled as the lead recommended: the latch is dropped. A first dial of a kind that closes with no frame retries, as a dial does after one frame; one change in the page covers the devserver's gate and the scene socket's attach timeout. Not verified in the reading, and the build's to check: that no way of serving the page lacks the route.

That evening the owner revised the ruling, as the lead recommended, after the drop was built and reviewed three times: the latch stays, and its triggers are removed instead. Dropping the latch lets a tab that began on classic saves join a sync session later, and each review found new unsafe states in that transition: a clean tab undoing another writer's change, a tab with edits doing so over an open conflict prompt, and, since the server keeps a detached session for 30 seconds and refuses a save that names no authority version, a redial loop, a prompt on a file nobody changed and a tab that cannot save. None of it landed. The shape now: the devserver's gate answers a sync upgrade with an error frame while it starts or stops, so that dial is not frameless and the retry a session makes after a frame applies; the scene socket gains the attach-timeout guard the document socket has. A refused token and a server without the route still latch. A code map comes first, to confirm that an error frame at the gate takes the page's retry path. The transition itself moves to a later version with [a-dirty-tabs-first-sync-attach-overwrites-what-changed-under-it](a-dirty-tabs-first-sync-attach-overwrites-what-changed-under-it.md).

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

## Reading of 2026-10-03

Read at the v0.102.0 branch on 2026-10-03 and run as a probe. The page's first dial of each kind that ends with no frame turns that kind of sync off for every tab until a reload: a module-wide latch written as a probe for a server without the route (`docSync.svelte.ts:131-134`, `:877-884`, read at `:143`; `sceneSync.svelte.ts:101-103`, `:858-867`, read at `:111`), pinned by `docSync.test.ts:592` and `sceneSync.test.ts:484`, and cleared by nothing. The devserver's gate does refuse the upgrade, with 503, while the devserver starts and from its stop signal on (`crates/chan-server/src/devserver.rs:2952-2992`); a tenant that is not mounted, a refused token, and a shutdown signalled as the socket starts end the dial frameless too. The handlers themselves always send an error frame first, for this reason (`routes/doc.rs:190-194`). The scene socket's own five-second attach timeout also latches (`sceneSync.svelte.ts:816-819`, `:860`), which the document socket guards against (`docSync.svelte.ts:866-877`). A window whose sync is off shows no sign of it, still saves through the classic path, and meets a peer's edits as file changes and conflict prompts instead of a merge. Whether a window meets the gate in practice was not established.

The builder names four fixes: drop the latch, so a frameless first close takes the ordinary retry path, which closes the scene timeout as well; keep the latch and let it expire; give the scene socket the document socket's guard alone; or have the server's gate answer an upgrade with an error frame. Which, if any, is the owner's.
