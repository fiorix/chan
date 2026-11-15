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

## Built, 2026-11-15

The client waits for pending debounced edits and the serial preference writer to settle and captures its generation before each workspace read. Arming a pane-width or page-width debounce invalidates older reads immediately, and reads begun during the debounce wait for the final value to be enqueued and written. Pending drags do not block unrelated preference writes. Enqueuing a write also invalidates older reads, including no-op writes. A stale response updates metadata and warnings while retaining the current served preference object's identity and the local preference mirrors, then requests one coalesced fresh read. Keeping the served object preserves Settings' optimistic overlay. Bootstrap repeats an invalidated first read without publishing it. The refresh disposer cancels its pending timer and invalidates successful read continuations still awaiting a write or response. The server payload is unchanged.

The deferred-response Vitest cases use the demo router's real response bodies. The twelve-case baseline produced ten assertion failures and two passing controls. Six later cases were shown red by individual guard mutations, not by that baseline run; the initial fixed suite has eighteen passing cases covering docks, theme, Settings, queued writes, a queue extended during a wait, no-op convergence without another frame, bootstrap, metadata and cancellation. Individual guard mutations are recorded under `dev/v0131-team/evidence/Edit131/prefstale/`; the full gate and browser acceptance evidence remain pending. Check 268 holds an original pre-toggle workspace response across trusted launcher Paste and dock-toggle actions, then observes the dock for at least 500 ms after consumption. Its syntax is checked; a browser result is not yet claimed.

Contract 3 uses the watcher-ready refresh in the integrated keysmerge range. Its regression is committed with the composed preference code: bootstrap holds its tree listing after the first preference read, a peer changes the server record before the socket exists, and the ready callback refreshes the theme and dock. On the merged tree the case passes; removing only the watcher-ready refresh fails with the old light theme instead of the peer's dark theme; restored source bytes match and the case passes again. Standalone reads share the write wait and invalidation contract described below. The row remains awaiting the committed gate and both browser acceptance lines.

## Debounced preference writes, 2026-11-15

Pane-width and page-width drags invalidate an older read when their debounce arms. A read also waits for every pending drag to enter the serial write queue, so the 250 ms refresh cannot overtake the 400 ms page-width debounce. A rearmed debounce replaces its pending edit synchronously; overlapping drags remain independent, and an immediate preference write can proceed while a drag is pending.

At `174e40f51`, three deferred-response cases fail with the actual old widths in both the window and the server. The corrected suite passes 25 cases, including rearmed and overlapping drags, an unrelated immediate write, a canceled waiting refresh and a no-op drag without a watcher frame. Five separate mutations fail: removing either drag registration, omitting arm-time invalidation, omitting the pending-edit registration, and admitting a read while a rearmed edit remains pending. The restored sources match their saved bytes and all 25 cases pass again. Raw logs and commands are under `dev/v0131-team/evidence/Edit131/prefstale/round1/`; the committed gate and browser runs remain pending.

## Width-edit disposal, 2026-11-15

Workspace teardown invalidates its read epoch before canceling pane-width and page-width debounces. Each debounce owner clears its timer and releases its pending edit without sending the canceled value; rearming uses the same cancellation path. The mounted FileBrowserSurface, GraphPanel and FileEditorTab suites call this lifecycle before removing their demo transport and timer trackers.

At `2fd461c1c`, the two bounded disposal cases fail: a timer remains active, the old waiting read never settles, and a new workspace read cannot start after the timer tracker clears it. The corrected preference suite passes 27 cases. Six independent mutations produce assertion failures: omitting each teardown cancellation, omitting each timer clear, and canceling each timer without releasing its pending edit. The restored source bytes match; raw logs and commands are under `dev/v0131-team/evidence/Edit131/prefstale/disposal/`. Committed gates and browser acceptance remain pending.

## Editor fixture disposal, 2026-11-15

FileEditorTab uses the same store teardown before removing its demo transport and tracked timers. At `3099750e8`, running the shared-width drag followed by the pane-width drag passes the first case but times out in the next fixture's workspace refresh after 30 seconds. With cleanup, both cases pass. Removing only the teardown call reproduces that same next-fixture timeout; the fixed test source is then restored byte for byte. The timer tracker documents that pane-width and page-width debounces also require their owner's cleanup to release pending preference edits. Raw logs and commands are under `dev/v0131-team/evidence/Edit131/prefstale/editor-teardown/`. The committed FileEditorTab suite at `aaf4ce7de` passes all 135 cases (exit 0); the full web check remains pending.

## Standalone refresh composition, 2026-11-15

Standalone config reads wait for pending preference edits and serial writes, then retry if a newer local write invalidates the response. Only the standalone preference record, body themes and shortcut table are applied; workspace theme and dock mirrors stay excluded. This preserves an optimistic shortcut assignment while it saves, so a reset clicked during an overlapping refresh reaches the writer instead of finding a stale empty table. Both the pre-fetch and post-response epoch checks stop canceled reads. The design account now combines the shared refresh timer and read/write ordering beside shortcut persistence.

At the merged `5d45846b3`, six deterministic standalone cases fail assertions using the demo router's real held config responses. The fix passes all six, covering both refresh/assignment orderings, a pending reset, a no-op reset without a config event and cancellation while waiting or fetching. Five independent mutations fail assertions: removing the write wait, either epoch check, the generation check, or the retry for an invalid response. Restored source and test bytes match and all six pass again. Fresh composition proof and commands are under `dev/v0131-team/evidence/Edit131/prefstale/composition/`. The composed committed full web gate and browser runs remain pending.

## Built, 2026-11-15: browser acceptance

Check 268 records launcher Enter at window capture before navigation, before the command handler consumes the event. The fetch observer preserves that command log and delays the original workspace Response without replacing its body. Its base run at `4d851d1fadde9197fe588c1060c87403db765300` fails at `PRODUCT_STALE_PREFERENCE_REFRESH`: one dock removal, 23 invisible samples out of 24 over 510.8 ms after the stale response is consumed. The tip at `920919d309c74d05cedc063d4e7a4dfee6a9923d` passes: no removal or invisible sample in 22 readings over 505.4 ms. Both runs record actual trusted Paste and dock-toggle Enter on the focused launcher input, matching original and saved body hashes, the server retaining the new preference, and later responses held until observation ends. Both have empty page-error and cleanup-error lists.

The launcher-driven check 251 passes five consecutive complete invocations on that same tip. Each covers New, Upload and Paste across list/tree selection kinds and both action routes, standalone home targets, entry Upload exceptions and nested creation. Standalone row and launcher Paste both record the landed wire path as the dock's active selected row. The frozen launcher instrument retains its launcher dock setup; its repairs wait for the exact asynchronously listed child icons and compare standalone row titles with the wire path, not the absolute disk path. Capability HTTP errors and deleted-fixture listing 404s remain in the timelines and are not described as clean network logs. Raw results, observations, timelines, screenshots and per-command exit files are in `dev/v0131-team/evidence/Ops131/J184/`.

J162's committed scoped, full frontend and marketing gates all pass at `920919d30`, followed by explicit successful web and chan builds. J179's six scoped suites pass 205 cases with zero Svelte errors or warnings at cleanup commit `e290958ce`; its only product change removes a duplicate idempotent teardown stop. J184 reuses J162's retained builds, verifies their source, binary and complete bundle provenance before and after the readings, and restores the exact instrument overlays. The repaired committed check 268 is byte-identical to the instrument used for both J184 arms. No further product change is needed for the browser acceptance.
