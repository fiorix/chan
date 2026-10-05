# One window's close discards a record whose connection another window still holds

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-28 by the lead, who found the launcher's half while reading the launcher's window manager for the plan of the waiting windows' wait (`dev/v0101-team/journals/journal-Lead.md` in the development tree, the entry of 2026-09-28 13:47Z; `dev/v0101-team/followups/followup-Lead-Clients-17.md`, "To confirm or refute by reading"), and by the builder of that wait, who confirmed it by the code with the server's half (`dev/v0101-team/reports/report-Clients-30.md`, "Found beside the order"). Read again at `fe2708e45`; not run. It is not a part of [a-connecting-page-close-discards-its-window](a-connecting-page-close-discards-its-window.md), which is the desktop's connecting page.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters: a close of one window ends the terminal sessions of another window that is still open, and the fix is local to the launcher. The shape, as ruled, is the launcher's, the first of the two below: a closed handle whose record reads connected discards nothing, and its record is discarded at a later push that reads it disconnected. The launcher keeps the closed handle until then, which `handleState` forgets at its first read today, so that a user's own close still discards. The server's discard route is unchanged and its request gains no field. The cost is the one this item names: a record says that a socket is live and not whose, so a record that should go can stay until its next push.

## What was seen

The launcher discards the record of a browser window whose handle it holds and finds closed, unless an Open of that window is still deciding. Its reconcile reads the handle's state and the record's origin, and never the record's `connected` (`reconcileWindows`, `web/packages/launcher/src/state/windowManager.svelte.ts:203-228`, the discard at `:219-220`, the pending Open at `:215`; `handleState`, `:61-67`), and its discard closes the handle and asks the server to discard the record (`discardBrowserWindow`, `:54-59`). The launcher of v0.100.0 discarded a closed handle's record the same way (`windowManager.svelte.ts:166-167` at `v0.100.0`).

The server's discard asks nothing about a live socket. `DELETE /api/library/windows/{id}` checks the leader's gate alone (`handle_discard_library_window`, `crates/chan-server/src/routes/library.rs:1189-1212`), and the host's discard removes the record, reaps the window's terminal sessions and its session blobs, and tells the window's socket that its window was discarded (`discard_window`, `crates/chan-library/src/host.rs:2905-2925`; `reap_discarded_window_state`, `:2990-3023`).

One id can have two live windows. A record that reads connected, whose window this page cannot reach by name, gets a new blank window from Open or Focus, and a blank window is always repaired, so it becomes a second live window on that id (`openWindowRecord`, `windowManager.svelte.ts:137-144`; `web/packages/launcher/design.md:64`; for the workspace app, `web/packages/workspace-app/src/design.md:26`).

So where a launcher page holds the handle of one of two windows on an id, its user's close of that window discards the record under the other, which is still open and connected: a terminal window's sessions are ended, and the other window is told that its window was discarded (`host.rs:2918-2921`). Inferred from the lines read, and not run.

## Desired contract

A close of one window on an id discards neither the record nor its sessions while another window still holds a live socket for that id; a discard that the user asks for, the row's Close, stays as it is.

## What to do

Suggestions, beyond the record: the launcher's reconcile leaves the record of a closed handle whose record still reads connected, as it keeps a row it holds no handle for, and discards it at a later push that reads it disconnected; or the server's discard route refuses a discard while a socket is live for the id unless the request says it is the user's Close. Either meets [a-connected-record-does-not-say-whose-socket](a-connected-record-does-not-say-whose-socket.md): a record that says a socket is live and not whose cannot tell the closing window's own socket, not yet dropped, from the other window's, so the first shape can keep a record that should go until its next push. Red first: in the launcher's window manager tests, a handle closed while its record reads connected sends no discard; today it sends one.

## Boundaries

`web/packages/launcher/src/state/windowManager.svelte.ts` (`reconcileWindows`) and its tests, and `web/packages/launcher/design.md`; the discard route and `discard_window` only if the server's shape is taken. Not the desktop's connecting page, which is [a-connecting-page-close-discards-its-window](a-connecting-page-close-discards-its-window.md).

## Acceptance

1. A closed handle whose record reads connected discards nothing, pinned red first.
2. A closed handle whose record does not read connected discards as now, and the row's Close discards as now; pinned.
3. `web/packages/launcher/design.md` says what a close of one of two windows on an id does.

## What shipped

The build is on the integration branch and not on `main`, in ranges the lead accepted, with the combined gate green on Linux at the integration's tip. This record was written on 2026-10-02 from a reading of the code at that tip; what the acceptance of its range found beyond the code is in the round's records and was not read for it.

In the shape that is local to the launcher, as ruled: the launcher discards a closed browser window's record only when the record is not connected, and keeps the closed handle until the first push that shows it disconnected, when it discards the record once (`reconcileWindows`, `handleState` and `discardBrowserWindow`, `web/packages/launcher/src/state/windowManager.svelte.ts`). The server's discard route is unchanged. Pinned in `windowManager.svelte.test.ts`: a connected record survives the close of its local browser handle, a disconnected one is discarded, and a kept handle is discarded exactly once; `web/packages/launcher/design.md` says what closing one of two windows on one id does and what it costs. The changelog has the entry.
