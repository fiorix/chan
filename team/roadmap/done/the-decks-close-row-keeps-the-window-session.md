# The command deck's Close window does not discard the window's session, where the close command does

Status: shipped in [v0.102.0](../../release/release-v0.102.0.md).

Record before the release: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 from the report of the fix round of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reports/report-Frontend-33.md` in the development tree, "Should the deck's Close window row also discard the session?", which recommends it), built to the lead's ruling that the row keeps what it did beyond the recovery write (`dev/v0101-team/tasks/task-Lead-Frontend-27.md`, ruling 1). Read at `e07f3862f`; that a save of the page can write the session back is the builder's reading and not run, and what a later window reads of such a write was not read.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: the fault is a wrong state, and its fix, one call, reverses the lead's ruling under which the deck's Close window row was built, that the row keeps what it did beyond the recovery write (`dev/v0101-team/tasks/task-Lead-Frontend-27.md` in the development tree, ruling 1); that ruling stands for v0.101.0. When it was raised the lead recommended accepting it for v0.101.0, since a closed window's saved session can be written back. It is not part of v0.101.0.

## What was seen

Lines at `e07f3862f`, under `web/packages/workspace-app/src/` where no other path is named. The close-window command discards the window's session, then writes the recovery buffer and asks the desktop to close the window (`App.svelte:1419-1423`); the command deck's Close window, and a chord a user assigned to it, which runs the row's `run` (`App.svelte:633-652`), write and ask and discard nothing (`state/commands/global.ts:307-321`; `flushAndCloseWindow`, `state/closeConfirm.svelte.ts:63-72`). The page's discard sets a guard that stops every later save of the window's session by the page (`discardWindowSessionLocal`, `state/store.svelte.ts:3537-3538`; the debounced save and the save at a `pagehide`, `:3300-3301`, `:3566-3570`). The desktop's close of a local window discards its registry record, which reaps its sessions (`request_close_window`, `desktop/src-tauri/src/main.rs:4182-4190`). With no guard, a save of the page after that, by its debounce or at a `pagehide` as the webview is destroyed, can write the session back, by the builder's reading.

## Desired contract

Every way the page closes its window discards the window's session as the close-window command does.

## What to do

As the builder recommends: the deck's row discards the window's session before it writes the recovery buffer and asks the desktop, as the close-window command does; a pin in the shape of the fix round's pins of the row.

## Boundaries

`web/packages/workspace-app/src/state/commands/global.ts` (the Close window row) and its tests; the close prompt's module may not import the store, which imports it, as the fix round's report reads the imports.

## Acceptance

1. The deck's Close window and a chord assigned to it discard the window's session before they ask the desktop, and no save of the page follows; pinned red first.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, a reading of its diff and its own gate. This record was written that day from that reading.

The deck's Close window row, and a chord assigned to it, discard the window's session before they write the recovery buffer and ask the desktop (`discardWindowSession` then `flushAndCloseWindow`, `web/packages/workspace-app/src/state/commands/global.ts`), the order of the close-window command. Pinned in `App.windowClose.test.ts` in the shape of the row's other pins, and in `globalWindowCommands.test.ts` against the real store: the row sends the session's `DELETE`, then the close request, and neither the debounced save nor the save at a `pagehide` writes the session after it. The close prompt's module still imports no store.
