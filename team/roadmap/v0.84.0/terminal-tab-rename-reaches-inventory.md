# Terminal tab rename reaches the session inventory

Status: REGISTERED for v0.83.0, grounded 2026-08-02, ruled 2026-08-02, ready to spec.

## What

Renaming a terminal tab changes the label in the SPA and nothing else. `cs terminal list` keeps reporting the name the session was spawned with, and so does every by-name operation built on it. The two views of the same terminal disagree, with no way to correlate them.

After this item, a rename updates the live session immediately: `cs terminal list` shows the new name, and `cs terminal write --tab-name`, `scrollback`, `close`, and `restart` all target it. The name the session was spawned with stays visible in `cs terminal list` as read-only provenance, and is never targetable.

Terminal tabs only. Editor, browser, graph, and dashboard tabs have no session inventory to diverge from.

## What is already known (grounding, verified 2026-08-02)

The rename never leaves the client:

- `renameTerminalTab` (`web/packages/workspace-app/src/state/tabs.svelte.ts:1862`) is two statements: it sets `tab.title` to the deduped `uniqueTerminalName(title, tab.id)`, then re-arms the stale-env restart prompt by clearing `terminalEnvNamePromptDismissed` when `terminalEnvTabNameStale` holds (`:1867-1868`). Its three callers are the Name input in the terminal config panel (`components/TerminalTab.svelte:2266-2283`, committing on blur), the `renameActiveTerminal` command (`state/commands/terminal.ts:34-39`), and the team orchestrator (`state/teamOrchestrator.svelte.ts:312,420`).
- `uniqueTerminalName` (`state/tabs.svelte.ts:872`) already disambiguates with a `-N` suffix, tenant-wide, against local tabs plus the cross-window roster, precisely because `cs terminal write --tab-name` targets by name and a duplicate would double-deliver.

The server treats the name as spawn-time state:

- `Session.tab_name` (`crates/chan-library/src/terminal_sessions.rs:2622`) is a plain field. Its neighbours `window_id`, `pane_id`, `side`, and `tab_id` (`:2629-2638`) are `Mutex<_>` with setters, because those already re-bind on attach and move. The name has no setter.
- On reattach, `get_or_create_for_ws` (`:1379`) rebinds the window and the placement and drops `opts.tab_name` entirely, so not even a page reload resyncs the name.
- The only existing path that changes it is a full PTY restart: the restart route reads a `name` override through `normalize_tab_name` (`crates/chan-server/src/routes/terminal.rs:440-467`, `:1059`) into `RestartOverrides` (`terminal_sessions.rs:1267,1288`). Renaming therefore means killing the shell.

The name is read in twelve places, all of which follow one field:

- `TerminalSessionSummary.tab_name` (`:445`), built in `session_summaries` (`:1637`) and rendered by `cs terminal list` (`crates/chan-server/src/control_socket.rs:3930`).
- Name allocation: `next_terminal_name` (`:1082`) scans the live names for the lowest free `Terminal-N` ordinal.
- By-name targeting: `write_input_matching` (`:1675`), `enqueue_write_matching` (`:1766`, which reads the name twice, for the selector and for its divergence report), `scrollback_matching` (`:1832`), `restart_matching` (`:1869`), `close_matching` (`:1911`), and `window_ids_matching` (`:1952`).
- `RosterEntry.tab_name` (`:604`), built in `roster()` (`:1141`), pushed to every window on `notify_roster_change` (`:1108`), and read back by `uniqueTerminalName`.
- `FdStoreSessionMeta.tab_name` (`:509`), built in `fdstore_manifest_entry` (`:3037`), the Linux fdstore restart manifest.
- `restart_options()` (`:3587`) copies the live name into the next incarnation's `CreateOptions`.

The precedent for changing live session state without reconnecting already exists and is already used for exactly this class of update: `ClientFrame::Placement` (`crates/chan-server/src/routes/terminal.rs:147`) drives `update_session_layout` (`terminal_sessions.rs:1494`), which sets the mutable fields and republishes the park manifest via `parked_changed()`. The SPA sends it from `components/TerminalTab.svelte:1502` whenever a mounted terminal moves.

## Contract

- `Session.tab_name` and `tab_group` become interior-mutable with setters, matching `window_id` / `pane_id` / `side` / `tab_id`.
- A new `rename` client frame on the terminal WebSocket carries the settled name and group, sanitized with the restart route's `normalize_tab_name` / `normalize_tab_group` (`crates/chan-server/src/routes/terminal.rs:1059`, `:1089`). Same socket and same `parked_changed()` manifest republish as `Placement`, so a crash restore keeps the user's name, but `Placement` is not a full precedent: its handler (`terminal.rs:739-750`) only calls `update_session_layout` and pushes nothing, while a rename changes roster-carried fields, so the handler also nudges `notify_roster_change`, the pattern `SetBroadcast` already uses for its toggle (`terminal.rs:731-737`). `get_or_create_for_ws` also stops dropping `opts.tab_name` on reattach, as a resync.
- The client stays the uniqueness authority. `renameTerminalTab` already dedupes before commit and the frame carries the settled name; the server stores what it is told, exactly as it does at spawn. No conflict-reply path.
- Group rides the same frame. It is the adjacent control in the same panel (`TerminalTab.svelte:2285`), has the identical spawn-time-only limitation, and `cs terminal list` groups its whole output by it, so a renamed tab under a stale group is the same bug. Behavior change to call out in the spec: the server-side group gates the cross-window broadcast fan, so a live group edit starts moving broadcast membership without a restart.
- Spawn-name provenance reads `Session.spawn_opts` (`:2644`), which retains the `CreateOptions` the incarnation was created with, so `cs terminal list` can render `spawn_opts.tab_name` beside the live name. Caveat to state in the spec: a restart mints the next incarnation from `restart_options()` (`:3587`), which copies the live name into the options before any override is applied, so after a restart-with-rename the retained value is that incarnation's spawn name, not the original. A second gap is Linux-specific: a session that survives a devserver restart is rebuilt by `Session::from_imported` (`:3086`) with `spawn_opts.tab_name: None` (`:3120`) while the live name is restored from the manifest (`:3110`), so `spawn_opts` yields no provenance for a restored session. Whether that gap needs closing is Open below.
- `$CHAN_TAB_NAME` and `$CHAN_TAB_GROUP` in the running shell stay stale until the session restarts. Accepted: the user can re-export them in place. The existing staleness warning and restart prompt (`terminalEnvTabNameStale`, `state/tabs.svelte.ts:1871`) are unchanged.

## Rough size

Small to moderate. Two fields gain setters, one client frame is handled beside `Placement` with a roster push and a manifest republish, one line in `get_or_create_for_ws` stops dropping the name, and `cs terminal list` gains a read-only spawn-name column in both of its renderers: the JSON builder (`crates/chan-server/src/control_socket.rs:3930`, in `term_list`) and the human table (`crates/chan-shell/src/cli.rs:2572`, `render_terminal_list_markdown`). The SPA change is a send call in the same place the blur handler already commits.

## Open

- Two windows renaming to the same name in the same instant. Client-side uniqueness reads a roster that can be one push behind, so a duplicate is possible in principle and would ambiguate by-name routing. Not closed here; server-side enforcement is the fallback if it is ever observed.
- Whether `cs terminal list --json` exposes the spawn name unconditionally or only when it differs from the live name.
- Whether spawn-name provenance must survive a devserver restart on Linux. The fdstore restore rebuilds `spawn_opts` with `tab_name: None`, and the manifest's own `tab_name` carries the live name at park time (`terminal_sessions.rs:3061`), which a live rename changes, so neither stands in for the spawn name. If the spawn name must survive, `Session` needs a dedicated spawn-name field carried through `FdStoreSessionMeta`.
