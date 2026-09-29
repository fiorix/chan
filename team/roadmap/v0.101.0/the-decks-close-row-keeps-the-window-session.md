# The command deck's Close window does not discard the window's session, where the close command does

Status: raised for a decision on LANDING-DATE from the report of the fix round of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reports/report-Frontend-33.md` in the development tree, "Should the deck's Close window row also discard the session?", which recommends it), built to the lead's ruling that the row keeps what it did beyond the recovery write (`dev/v0101-team/tasks/task-Lead-Frontend-27.md`, ruling 1). Read at `e07f3862f`; that a save of the page can write the session back is the builder's reading and not run, and what a later window reads of such a write was not read. Recommendation, by the lead's rule for this landing: accept for v0.101.0, since a closed window's saved session can be written back.

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
