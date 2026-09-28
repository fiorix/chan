# A browser terminal window's kept row keeps its sessions alive until it is closed

Status: raised for a decision on 2026-09-28 by the independent review of the rule of when a waiting window is on its page (`dev/v0101-team/reviews/review-Clients-11.md` in the development tree, finding 4b, with the lead's notes), read in code and not run. It is the cost of the owner's ruling of 2026-09-27 that the launcher keeps the row of a browser window it holds no handle for (recorded in [refusals-answer-in-four-shapes](refusals-answer-in-four-shapes.md)), and the lead's notes raise it so that the owner hears it in those words. The lead's notes make no recommendation of their own: the owner keeps the ruling with this cost, or narrows it.

## What was seen

Before the rule landed, a launcher that held no handle for a browser window's record that did not read connected scheduled its discard and asked the server to discard it 2.5 seconds later (`web/packages/launcher/src/state/windowManager.svelte.ts:32-57`, `:208-209` at `cf105bb14`). At `7957bccef` the row stays and asks for an Open click, and only a window this launcher saw closed discards its record (`reconcileWindows`, `windowManager.svelte.ts:166-189`, the kept row at `:182-183`, the discard at `:180-181`).

A discard is what reaps a window's sessions: the host drops the record and reaps the window's terminal sessions, their PTYs and its session blobs (`discard_window`, `crates/chan-library/src/host.rs:2867-2887`; `reap_discarded_window_state`, `:2941-2951`). A standalone terminal window's record otherwise leaves only when its shell exits with no client attached (`host.rs:1829-1848`). So a browser terminal window that is gone, because the launcher tab that held it reloaded or closed, keeps its record and its shell running on the devserver until the user closes its row or the shell exits, where before the rule a launcher with no handle discarded it, with its sessions, within about 2.5 seconds. The kept row flashes in every launcher tab, and nothing ages it out (the review's finding 4b).

## Desired contract

A browser terminal window that is gone does not keep its shell running unknown to its user: either the kept row says that its sessions are alive, or the row goes with its sessions after a bound the owner sets. Which, is the owner's.

## What to do

The owner chooses. Keep the ruling as it is, with the cost written where a user reads the row; the rule's fix round already writes the kept row's costs into the launcher's design document (`dev/v0101-team/tasks/task-Lead-Clients-24.md`, ruling 4). Or bound a kept terminal row, which brings back a discard for a window that may still be open in a tab this launcher cannot see.

## Boundaries

`web/packages/launcher/src/state/windowManager.svelte.ts` and `web/packages/launcher/design.md`, with their tests. The host's discard is not changed.

## Acceptance

1. The owner's choice is in place, and the launcher's design document says what a kept terminal row costs.
2. If a bound is chosen: a kept browser terminal row past it is discarded with its sessions, pinned under a fake clock, and a row whose window is open in another tab is not.
