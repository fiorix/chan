# A stale workspace read reverts a preference the user just set

Status: accepted for v0.131.0 by the owner on 2026-11-15, by survey: "Fix now as a small row, Edit131 (recommended)"; not started.

Record: found on 2026-11-15 while the newpaste row's browser check 251 failed at its tip (job J156): its left file browser dock disappeared between two clicks. A read-only diagnosis (`dev/v0131-team/reports/diag-251-dock.md`) traced it to the app, not the check and not that row; the lead checked the store's lines. Same family as a gap recorded for v0.132.0: a window's bootstrap reads the workspace before its watcher subscribes, so a preference change made in that gap reaches the window only with the next change (`dev/v0131-team/reports/candidates.md`, 2026-11-14T19:33:19Z).

## What is there now

Read at `0a94ab793`.

- `refreshWorkspace` (`web/packages/workspace-app/src/state/store.svelte.ts`, about line 3713) awaits `api.workspace()`, stores the payload and calls `applyServerPreferences`, which sets every preference from the payload unconditionally, `browser_side_panes` among them (about lines 990 and 1009-1012).
- `scheduleWorkspaceRefresh` (about lines 3724-3742) fires that read 250 ms after the first watch frame of a burst and 250 ms after a `config_changed` frame.
- A preference the user sets (a dock, the theme, a pane width) changes the local state at once and is written with `updateGlobalConfigSerial` (`api/preferenceWrite.ts`, a GET then a PATCH of `/api/config`); the server broadcasts `config_changed` after the write.
- The server's `/api/workspace` (`crates/chan-server/src/routes/workspace.rs`) snapshots the preferences before a drafts preflight and returns no revision, so the client cannot tell a payload read before its write from one read after.
- So a read that started before the write and lands after it puts the old value back until the `config_changed` refresh about 250 ms later: paste, save or upload in a window, then toggle a dock within about 300 ms, and the dock disappears and comes back. The server keeps the user's value; nothing is lost.

## Desired contract

1. A workspace read that started before a local preference write of the same window does not change that window's preferences when it lands; the window's preferences after it equal what the user set.
2. A read that started after the write is applied as today, and a change made in another window still arrives through `config_changed` as today.
3. The window's bootstrap gap (a preference change made between its first workspace read and its watcher's subscription) is closed in the same row if the fix stays small (for example a refresh once the watcher reports ready); otherwise it stays recorded for v0.132.0 with the reason.

## Boundaries

- The workspace app's store and its preference write helper, and their tests. The server's payload is unchanged unless the build shows a revision field is the smaller fix; a wire change takes two reviewers.
- Not here: which preferences exist, how the server stores them, the merge of shortcut overrides (the keysmerge row).

## Acceptance

1. A vitest with a deferred `api.workspace` payload holding the old `browser_side_panes`: start a refresh, set the left dock locally, resolve the payload; the dock stays set. Red on today's code. The same for one other preference (the theme or a pane width), and a read that started after the write still applies.
2. Browser check 251's tip arm, run with the dock toggled through the launcher (not through the server), passes in five runs in a row; and a browser check that toggles a dock right after a paste and reads it 500 ms later, red at the base.
