# The launcher's add and on answer another process's lock with two statuses and two sentences

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 by the plan for the open's bound (`dev/v0101-team/followups/followup-Services-Lead-15.md` in the development tree, section 8), which read it at `d5a38d0fd` and left it out of that order, as the lead ruled (`dev/v0101-team/followups/followup-Lead-Services-22.md`, "Not in this order"). Read again at `fe2708e45`, where the tests pin both answers as they are; not run. It is not in the contract of [refusals-answer-in-four-shapes](../done/refusals-answer-in-four-shapes.md), which asks that every refusal be one envelope with a sentence, and a code where a client branches: both answers are envelopes with a sentence, and one status and one sentence for one fact on two routes is no part of that contract. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: the fault is more than one status and sentence for one fact, which loses nothing, and its fix changes what the routes answer. The shape is not ruled: which sentence the routes answer, and whether the launcher's delete and the devserver's forget are in its scope. When it was raised the lead recommended accepting it for v0.101.0, as one status and one sentence. It is not part of v0.101.0.

On 2026-10-03 the owner ruled, as the lead recommended: another process's lock answers 409 with the sentence "This workspace is open in another chan process. Quit it and try again." at every caller that answers it, the removal included.

## What was seen

When another process holds a workspace's writer lock:

- **The add answers 400** with the error's own sentence, "chan-workspace: workspace is locked by another process": its open's arms name the fd pressure, a root still releasing and a stopping host, and the lock falls to the last arm (`add_workspace`, `crates/chan-server/src/routes/library.rs:1913-1940`, the arm at `:1939`; the words, `crates/chan-library/src/error.rs:10-11`, `crates/chan-workspace/src/error.rs:41-42`). Pinned as it is (`workspace_add_mount`, `routes/library.rs:6209-6229`).
- **The on answers 409** with "workspace is open in another Chan process" (`handle_workspace_on`, `routes/library.rs:1991-1994`). Pinned (`workspace_on_locked`, `:6303-6321`; `on_over_a_foreign_locked_workspace_answers_a_conflict_envelope`, `:3892-3917`).

Beside them, the shared mapper answers the same error 409 with its own sentence (`err_from`, `crates/chan-server/src/error.rs:145`), the removal answers it 500 with that sentence (`handle_remove_workspace`, `routes/library.rs:2041-2066`; pinned, `workspace_remove_locked`, `:6367-6385`), and the desktop's own open says "This workspace is open in another chan process. Quit it and try again." (`map_open_error`, `desktop/src-tauri/src/embedded.rs:715-717`). `crates/chan-server/design.md:16` names the on's 409 and not the add's 400.

No client of the add reads its status: the web launcher shows the body's `error` of any refusal (`req`, `web/packages/launcher/src/api/library.ts:601-619`), and the desktop's gateway arm reports the add's refusal whatever its status, while it reads the on's 409 as a conflict (`add_workspace`, `desktop/src-tauri/src/devserver.rs:2389-2396`; `set_workspace_on`, `:2512-2514`). So a user who adds a folder another chan holds reads an internal sentence where the on's row gives another.

**Added on 2026-09-28, at the landing after the one that raised this item:** the launcher's removal is a third status for the same fact, as named above, read again at `ada0ecc4c`: it answers another process's lock 500 with the error's own sentence (`handle_remove_workspace`, `crates/chan-server/src/routes/library.rs:2037-2062`, the arm at `:2060`; pinned as it is, `workspace_remove_locked`, `:6352-6368`), beside the add's 400 (`:1935`; `workspace_add_mount`, `:6194-6212`) and the on's 409 (`:1987-1990`). The boundary below leaves the removal to the ruling, and the lead's recommendation now asks the ruling to take it in: one status and one sentence for another process's lock at every caller that answers it, the removal among them. Not run.

## Desired contract

The launcher's add and on answer another process's lock with one status and one sentence, and `crates/chan-server/design.md` says which.

## What to do

A suggestion beyond the record: the add answers the lock as the on does, 409 with the on's sentence, in an arm beside its arm for a root still releasing; 409 is the status the shared mapper and the desktop's reader of a gateway on already give this error. Whether the sentence is the on's or the desktop's notice's is the owner's to choose. Red first: the add's pin asserts the chosen status and sentence; today it answers 400 with the error's own words.

## Boundaries

`crates/chan-server/src/routes/library.rs` (`add_workspace`, `handle_workspace_on`) and their tests, and `crates/chan-server/design.md`. The removal's 500 and the desktop's sentence are named here and are not in scope unless the ruling widens it.

## Acceptance

1. The add and the on answer another process's lock with one status and one sentence, pinned through the assembled launcher router.
2. `crates/chan-server/design.md` says it.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and an independent review of its whole diff. This record was written that day from those.

Built for the launcher's three callers, and the row stays open for the devserver's own. The launcher's add, on and delete answer a workspace whose lock another chan process holds with 409 and one sentence, "This workspace is open in another chan process. Quit it and try again.", from one builder (`workspace_open_elsewhere`, `crates/chan-server/src/routes/library.rs`); the add answered 400 and the delete 500 with the error's own sentence, and the on 409 with another. Pinned through the assembled launcher router, and the design says it. Left: the devserver's own open, on and forget (`crates/chan-server/src/devserver.rs`) still answer that lock 400 and 500 with the error's sentence, and the desktop reads their statuses, so a reading of every caller is ordered before they are turned. The answer covers every lock this process cannot prove is its own: a record that is missing or torn, one written under another path of a root relinked since, a dead holder that cannot be stolen from (read by the review in the lock's code, not run). The on's old sentence made the same claim. The launcher's design document and one tooltip still give the old sentence. The design document quotes the one sentence since later that day, in a range the lead accepted on its report, its status files and its own reading of the range's code; the tooltip describes a row's `locked` status, which is another condition, and is left.

The devserver's own routes were built later that day, on a reading of every caller, in a range the lead accepted on its report, its status files and an independent review of its whole diff. Its add, turn-on and forget answer that lock with 409 and the same sentence, from the one builder the launcher's routes use (`workspace_open_elsewhere`, `crates/chan-server/src/error.rs`); they answered 400, 500 and 500 with the error's own sentence. The desktop reads a 409 as a refusal, so a turn-on refused over that lock on a local devserver is shown, where the 500 was taken as done. Pinned red first for the three routes. The row stays open: the desktop's own add does not tell the 409 from another failure, the handoff socket's answer for `chan serve --devserver` is not ruled, and two sentences of `web/packages/launcher/design.md` still quote the old words.

The desktop's add was built on 2026-10-03, in a range the lead accepted on its report, its status files and an independent review of its whole diff: `add_workspace` reads a 409 on the gateway's arm and on the direct devserver's and shows the server's sentence with no operation and no HTTP prefix (`refusal_from_conflict`, `desktop/src-tauri/src/devserver.rs`); a devserver that still answers 400 keeps the prefix around what it sends. Left: the answer of the handoff socket to `chan serve --devserver`, ruled that day to be the same sentence.
