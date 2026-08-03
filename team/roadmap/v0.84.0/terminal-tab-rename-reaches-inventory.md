# Terminal tab rename reaches the session inventory

Status: REGISTERED for v0.84.0, grounded 2026-08-02, specified 2026-08-03, ready to implement.

## What

Renaming a terminal tab currently changes only the SPA. The server inventory,
`cs terminal list`, by-name operations, other co-view windows, and the live tab
group can continue to describe a different terminal.

After this item, the server owns terminal name/group settlement. A client sends
one atomic proposal, the registry resolves a tenant-wide unique live name, and
the settled pair converges through the WebSocket acknowledgement and terminal
roster. All by-name operations use that settled live name.

The name and group injected into the current PTY remain immutable spawn
provenance. A live edit does not mutate shell environment variables; the UI
offers one restart prompt when live metadata diverges from spawn metadata.

## Terms

- **live metadata**: the server-authoritative name and group used by the roster,
  CLI inventory, by-name targeting, and broadcast membership now;
- **spawn metadata**: the immutable name and group injected into this PTY
  incarnation as `$CHAN_TAB_NAME` and `$CHAN_TAB_GROUP`; and
- **proposal**: a client's requested live name/group pair before server
  normalization and collision settlement.

Name and group are one metadata value. They must never be read or published as
a torn pair.

## Verified current state

- `renameTerminalTab` in
  `web/packages/workspace-app/src/state/tabs.svelte.ts` deduplicates locally and
  mutates `tab.title`; it never reaches the terminal WebSocket.
- The Name control commits on blur. The adjacent Group control only reaches the
  server as part of a PTY restart.
- `Session.tab_name` and `tab_group` in
  `crates/chan-library/src/terminal_sessions.rs` are spawn-time fields. The
  registry summaries, roster, by-name selectors, restart options, and fdstore
  manifest all read them.
- `ClientFrame::Placement` proves that a mounted terminal can update live
  session state and republish parked metadata. `SetBroadcast` proves that a
  terminal frame can also trigger a tenant roster broadcast.
- `get_or_create_for_ws` intentionally ignores `tab_name` and `tab_group` query
  values on reattach. Those URL values are creation inputs, not a safe source
  of current truth.
- `ServerFrame::Session` does not return live or spawn metadata today.
- `Session::from_imported` restores the live name/group from fdstore but
  reconstructs `spawn_opts` without either value, so spawn provenance is lost
  across a Linux devserver handoff.
- `Registry::create` allocates registry state and spawns the PTY across
  different lock intervals. A server-side uniqueness rule therefore needs a
  short-lived name reservation; holding the sessions lock across fork/exec is
  not acceptable.

## Contract

### Server authority and settlement

The registry is the only uniqueness authority. Remove client-side settlement
from the commit path; a client may validate and trim for UX, but it does not
claim the final name.

Every path that establishes or changes a terminal name uses one shared atomic
settlement operation:

- terminal WebSocket creation;
- POST/CLI terminal creation;
- restart with name/group overrides;
- live metadata update; and
- any existing internal creation caller.

Settlement applies the existing name/group normalization, then reserves the
name tenant-wide. An unnamed creation keeps the lowest-free `Terminal-N`
policy. A duplicate explicit proposal keeps the existing suffix policy:
`name`, `name-2`, `name-3`, choosing the first free value. A live update excludes
its own session from collision checks.

Creation and restart reserve the settled name while the PTY is spawned, then
atomically convert or release the reservation. A failed spawn releases it.
Never hold the registry sessions lock across PTY creation. Tests, not timing,
must prove two concurrent callers cannot receive the same name.

The group is normalized and committed in the same critical section as the
name. Only the name is unique. The server returns the complete settled pair,
even when only one input changed.

### Session representation and provenance

Represent live metadata as one interior-mutable snapshot, equivalent to:

```text
LiveTerminalMetadata {
  name,
  group,
}
```

Readers for summaries, roster entries, selectors, restart options, broadcast
routing, and fdstore take one snapshot. Do not introduce independent name and
group locks.

Store `spawn_name` and `spawn_group` separately as immutable fields for the
current PTY incarnation. A live edit changes only live metadata. A successful
PTY restart creates a new incarnation whose spawn fields equal the newly
settled live metadata and the values injected into its environment.

`FdStoreSessionMeta` persists both live fields and both spawn fields. Import
restores all four exactly, including the case where live and spawn metadata
differ. Old manifests without the new optional fields remain readable; their
missing spawn values remain unknown rather than being fabricated from live
metadata.

### WebSocket protocol

Add one client frame:

```json
{"type":"rename","name":"requested name","group":"requested group"}
```

`group` follows the existing nullable/empty normalization. The success frame is:

```json
{"type":"renamed","name":"settled name","group":"settled group"}
```

Use a nonfatal failure frame such as:

```json
{"type":"rename_failed","message":"..."}
```

A rejected proposal leaves the socket and previous live metadata intact. No
request id or metadata revision is added: the SPA permits one in-flight
metadata update per terminal.

Do not acknowledge success until the registry has committed the settled pair
and scheduled the same parked-manifest/roster notifications used by other live
session updates. The roster carries live name and group keyed by terminal
session id, so every connected window converges even if it did not originate
the request.

The attach `ServerFrame::Session` prelude gains authoritative `name`, `group`,
`spawn_name`, and `spawn_group`. URL/query `tab_name` and `tab_group` remain
creation-only. On reattach they never write an existing session; the prelude
always flows from session state to the SPA.

### SPA behavior

Name and Group controls edit one local draft pair. Blur or Enter submits both
values together. While the request is in flight, disable both controls. Do not
optimistically mutate the tab, roster, or group.

On `renamed`:

- replace the local draft and tab metadata with the settled pair;
- clear the pending/error state; and
- let the roster broadcast reconcile every tab with the same terminal session
  id in this and other windows.

On `rename_failed`, restore editing with the typed draft intact and show the
error beside the controls. An attempt made while disconnected fails visibly
without changing authoritative metadata and leaves the draft editable. If the
socket drops after a send but before acknowledgement, treat the result as
unconfirmed; the next attach prelude is authoritative and the client does not
silently resubmit.

The active-terminal rename command and team-orchestrator callers use this same
proposal path. They must not retain a local-only fallback. A mounted terminal
connection exposes the proposal sink by terminal session id; absence of a live
sink is a visible failure, not permission to diverge.

Changing the live group takes effect for server-side cross-window broadcast
membership when the success is acknowledged. It does not rewrite the running
shell's environment.

### Environment staleness prompt

Compare live name/group with spawn name/group from the attach prelude. When
either differs, show one consolidated prompt that lists the stale variables:

- `$CHAN_TAB_NAME` when the names differ;
- `$CHAN_TAB_GROUP` when the groups differ; or
- both when both differ.

The actions are `Restart now` and `Later`. `Later` dismisses the current
divergence; another settled live metadata change rearms it. `Restart now` uses
the settled live pair, and success clears the divergence because the next PTY
incarnation's spawn fields now match.

### Inventory and targeting

`TerminalSessionSummary` exposes `spawn_name` in addition to the live name.

- `cs terminal list --json` always emits a `spawn_name` key. It is `null` only
  when provenance is genuinely unknown, such as an imported legacy manifest.
- Markdown output always includes a `spawn` column and renders unknown as `-`.
  It does not hide the column or collapse equal live/spawn values.
- `spawn_group` remains internal to attach/env-staleness handling for this
  item; it is not added to CLI output.

`cs terminal write --tab-name`, `scrollback`, `restart`, `close`, and every
other by-name selector match the live settled name only. The prior live name
and `spawn_name` are never aliases and are never targetable.

### Hybrid Nav integration

Roster reconciliation may update authoritative terminal name/group while
Hybrid Nav has a local draft. Apply the settled metadata, mark that Pane Mode
transaction stale, and require Escape to discard it under the
`hybrid-nav-staged-editor-bubble` contract. A local draft must never overwrite
the server-settled metadata.

## Implementation shape

Library (`crates/chan-library/src/terminal_sessions.rs`):

- add the atomic live metadata value and immutable per-incarnation spawn
  fields;
- centralize normalization-independent registry settlement, name reservation,
  and all creator/restart/live-update callers;
- read atomic snapshots in summaries, roster, selectors, restart, broadcast,
  and parked metadata; and
- version fdstore serialization compatibly with the two provenance fields.

Server (`crates/chan-server/src/routes/terminal.rs` and
`control_socket.rs`):

- add rename, renamed, and nonfatal failure frames;
- return all four metadata fields in the attach prelude;
- keep query metadata creation-only;
- route WebSocket, POST, CLI, and restart naming through registry settlement;
  and
- add `spawn_name` to JSON inventory.

Shell (`crates/chan-shell/src/cli.rs`): add the stable Markdown `spawn` column.

SPA (`TerminalTab.svelte`, `state/tabs.svelte.ts`, terminal command and team
orchestrator state):

- replace optimistic/local naming with one-in-flight proposal/ack state;
- reconcile both live fields by terminal session id from ack, prelude, and
  roster;
- consolidate name/group environment divergence; and
- connect roster changes to Hybrid Nav staleness.

## History verdict

This is a longstanding product-model gap, not a regression from the last two
or three releases:

- terminal tab controls introduced the client-only rename in `02be09c6` on
  2026-05-17 (v0.15.5 era);
- terminal groups and the first `cs terminal` inventory arrived in `41b28e7a`
  on 2026-05-30, followed by list/by-name operations in `cf2c8b2c` on
  2026-05-31 (v0.20/v0.21 era); the two authorities could disagree from that
  point onward;
- initial fdstore PTY preservation arrived in `df40fa06` on 2026-06-30 (v0.57
  era) and already reconstructed spawn options without name/group; and
- continuous parking in `b7e30794` on 2026-07-30 (v0.81 era) retained that
  model but did not create it.

The live rename mismatch is therefore old. Exact spawn provenance across
fdstore is a latent missing contract exposed by making live metadata mutable,
not a recent regression.

## Acceptance checks

Rust tests must prove:

- concurrent default creation, duplicate explicit creation, restart-with-name,
  and live rename all use one suffix policy and never settle duplicate names;
- reservation release on spawn failure and self-exclusion on live rename;
- name/group readers observe only old or new atomic pairs, never a torn pair;
- reattach ignores query name/group and returns authoritative live/spawn
  metadata;
- a rename ack follows settlement, a failure is nonfatal, and roster entries
  carry the settled pair;
- live group changes affect broadcast membership immediately;
- fdstore round-trips distinct live/spawn name/group values and accepts a
  legacy manifest; and
- every by-name operation follows only the new live name.

SPA and CLI tests must prove:

- blur/Enter submits one pair, both fields disable in flight, ack adopts a
  server suffix, and failure/disconnection preserves an editable draft;
- attach and roster reconcile every copy by terminal session id;
- the consolidated prompt names the correct one or two environment variables,
  re-arms after a later change, and clears after restart;
- a roster name/group change stales Hybrid Nav; and
- JSON always includes `spawn_name` while Markdown always includes `spawn`.

Add an end-to-end smoke with browser A and B co-viewing one `?w=` session and
browser C in another window:

1. A and C concurrently propose the same name. A/B converge on one settled
   name and C receives the `-2` result; roster and `cs terminal list` agree.
2. A changes group. B observes the group, cross-window broadcast membership
   changes, and a reload cannot overwrite either settled value with URL state.
3. `cs terminal write`, `scrollback`, `restart`, and `close` work by the settled
   name. The old live name and spawn name do not target the session.
4. A live name/group change while B is in Hybrid Nav produces the stale
   transaction contract.
5. On Linux, a devserver fdstore handoff preserves a deliberately different
   live pair and spawn pair for the surviving PTY.

## Boundaries

- No shell-environment mutation inside a running PTY.
- No request ids, metadata revisions, optimistic conflict UI, or client-side
  final uniqueness authority.
- No aliases for old or spawn names.
- No `spawn_group` CLI column in this item.
- No change to non-terminal tab rename behavior.

## Implementation evidence

- `fd458c70` makes one registry-owned `LiveTerminalMetadata` snapshot authoritative for name/group and keeps immutable spawn name/group on the PTY incarnation. One reservation path now settles default and explicit names for create, restart, and live rename without holding the sessions lock across spawn; summaries, roster entries, broadcast membership, restart options, every by-name selector, and fdstore manifests read the atomic live pair. Failed spawns release reservations, live rename excludes its own session, restart refreshes spawn provenance, and legacy manifests leave omitted provenance unknown.
- `86e27ad2` adds the `rename`, `renamed`, and nonfatal `rename_failed` terminal WebSocket frames, acknowledges only after registry settlement, republishes the roster/parked state, and makes the attach prelude return all four authoritative live/spawn fields. Reattach query metadata remains creation-only, while terminal POST creation returns the registry-settled `tab_label` used before a socket mounts.
- `48299dab` and `6f2a6bce` add the stable Markdown `spawn` column and the always-present JSON `spawn_name` key, rendering genuinely unknown provenance as `-` and `null`. The control-socket list path reads the same registry summary as targeting.
- `7a458ead`, `91c6413b`, and `e06706ea` replace optimistic SPA naming with a session-id proposal sink, one in-flight atomic draft pair, and authoritative reconciliation from attach preludes, acknowledgements, and roster snapshots. Name and Group disable together while pending; failures and disconnects preserve the editable draft; team/bootstrap and active-terminal commands retain no local-only fallback. One consolidated environment prompt compares both live fields with both spawn fields and restarts with the settled pair.
- `494e81b7` removes the obsolete name-only environment shims and makes the remaining terminal-slot selector use only the settled live title, so spawn provenance cannot survive as an alias. `79d8774a` pins POST-settled team bootstrap names, including a returned collision suffix, and `5abf614f` keeps the Rich Prompt submit-identity and teardown source pins stable around the expanded session/closed frame arms.
- `404fe75f` adds browser smoke 107 and the Linux handoff extension. The browser drives back-to-back A/C collision proposals while A/B co-view one window, then checks both inventories, immediate group membership, stale-query reattach/reload authority, Hybrid Nav staleness, and live-name-only write/scrollback/restart/close. The fdstore harness records deliberately distinct live/spawn pairs in the durable manifest and checks the exact four-field prelude after a bare systemd restart with stale query metadata; its process WebSocket probe is itself exercised against the browser smoke's throwaway server.

## Validation evidence

- `cargo test -p chan-library terminal_sessions::tests::` passed 130 tests. Independent exact runs passed `concurrent_default_creates_reserve_distinct_lowest_free_names`, `concurrent_duplicate_explicit_creates_use_the_shared_suffix_policy`, `create_restart_and_live_rename_share_suffixes_and_self_exclusion`, `failed_spawn_releases_its_name_reservation`, `fdstore_metadata_round_trips_distinct_live_and_spawn_values_and_reads_legacy`, and `live_metadata_readers_never_observe_a_torn_name_group_pair`; the filter also covers live-name-only selectors and immediate live-group broadcast membership. `cargo clippy -p chan-library --all-targets -- -D warnings` passed.
- Focused chan-server tests passed the rename wire shape, settled acknowledgement/nonfatal failure, authoritative reattach prelude, and POST-settled label cases. `cargo test -p chan-server term_list_reports_live_pane_side_placement` passed the distinct JSON live/spawn case, the focused chan-shell Markdown tests passed, and `cargo clippy -p chan-server --all-targets -- -D warnings` passed on the committed production slice.
- Focused SPA runs passed 278 tabs/store tests, 16 TerminalTab component tests, 8 team-bootstrap tests, and 11 Rich Prompt wiring tests. These runs cover atomic submission and disablement, suffix adoption, failure/disconnection, session-id reconciliation, consolidated environment divergence/rearm/restart, live-only survey targeting, POST-settled bootstrap names, submit identity, and socket/session teardown ordering. Workspace-app Svelte checks passed with 0 errors and 0 warnings after the production changes.
- With `TMPDIR` and output under `$HOME`, the final `SMOKE_SKIP_BUILD=1 SMOKE_ONLY=107 node scripts/e2e/browser-smoke/run.mjs` runs passed consecutively in 12.785 and 16.242 seconds. The last result is at `/home/fiorix/.cache/chan-v084-rename-smoke.06U5FH/results.json`. A prior non-skip run rebuilt every web workspace and the embedded `chan` binary before exercising the same production path.
- `make shell-check`, the fdstore cleanup-order self-test, both Node syntax checks, `git diff --check`, and `cargo fmt` passed. The real `systemctl --user restart` handoff was not run because the shared `chan-devserver.service` was active with 8 stored team PTYs and the harness correctly refused destructive takeover; that acceptance arm requires an idle user unit. A later aggregate six-file Vitest invocation did not complete and was interrupted, so only the individually completed focused runs above are reported green. The lead owns the final isolated pre-push gate.
