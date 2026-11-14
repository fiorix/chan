# A window that edits a shortcut erases the shortcuts another window saved

Status: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); not started.

Record: a follow-up of v0.130.0 with no row (its release record, "Follow-ups", the standalone shortcuts; `dev/v0130/reports/termkeys-1-handback.md`): the override writer sends a window's whole table instead of merging over the server's copy, so a window behind another's write drops that window's rows. The decisions document for v0.131.0 checked it against the code and sorted it as a row of its own, as one that loses user data; the owner took that recommendation.

## What is there now

Read at `f7457becb`, by reading; not run.

- Every shortcut assign or clear in a window replaces the composite override table at `preferences.shortcuts` (`registerOverridePersist` in `web/packages/workspace-app/src/state/store.svelte.ts`, around line 641): the writer returns this window's whole table as the patch.
- The write goes through `updateWithRetry` (`web/packages/workspace-app/src/api/preferenceWrite.ts`), which reads the server's config, hands the mutation `current.preferences` and sends the result with the revision it read, replaying on a conflict. The override writer ignores the copy it is handed, so the revision check and the replay protect nothing: whatever the server held, this window's table wins.
- A window learns of another's write through `config_changed`. A window that missed one (a reconnect does not refresh preferences) holds an older table, and its next edit erases the other window's saved chords, in every slot. Since v0.130.0 standalone windows write shortcuts too, so a browser page's edit can drop a desktop window's chords.

## Desired contract

1. A shortcut edit changes the one binding it names over the server's current table; every other row the server holds, written by any window, stays.
2. A window that reconnects refreshes its preferences, so it shows and edits what the server holds.
3. A conflict is still replayed through the revision check, and the merge is what is replayed.

## Boundaries

- The override writer in `store.svelte.ts`, the preference write helper's use by it, and the reconnect path's preferences refresh in the workspace app; the standalone window's refresh the same way.
- Not here: the keymap's override model, the Settings page's layout, and other preference keys, which already merge.

## Acceptance

1. Workspace app tests: two windows' writers over one stub server, the second holding a stale table, each edits a different binding; the server ends with both. Red on today's code. A conflict replays the merge.
2. A test that a reconnect refreshes the preferences a window holds; red on today's code.
3. In a guest, two windows of one devserver, one disconnected while the other saves a chord, then an edit in the first: both chords are in the server's config afterwards.
