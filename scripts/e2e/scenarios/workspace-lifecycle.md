# Workspace lifecycle

End-to-end expectations for opening, closing, removing, and losing a workspace, plus the durable state that must survive each of those. Owner-run: see [`../README.md`](../README.md) for the model and the rules that apply to every run.

Each scenario states behavior that must hold today. Where an executable check or test already proves it, that check is named under **Backing**; where none exists, the scenario says so and stays manual.

## What this covers

- startup stays responsive and observable while work is still in progress;
- startup and shutdown cancel without resurrection or leaked tasks;
- durable workspace, session, document, and scene state survives a clean cycle;
- terminal, editor, collaboration, pane, index, graph, and file browser behavior keeps working across a cycle;
- shared-terminal and workspace PTYs survive every non-destructive devserver restart;
- stopping a workspace is distinct from removing it;
- an editor open on a file converges on external filesystem edits in both directions, including shrinkage, byte-exact restores, and truncation;
- a workspace root that disappears is a terminal filesystem state, never an empty workspace and never an invitation to recreate the root.

## When to re-run

Look up the area you changed and run the scenarios listed against it.

- **Workspace open, mount, host registry**: WL-01, WL-02, WL-03, WL-13
- **Shutdown, task ownership, cancellation**: WL-02, WL-03, WL-04
- **Editor and scene sessions, collaboration, CAS**: WL-07, WL-08, WL-09, WL-10, WL-15
- **Watcher, index, graph, recovery**: WL-11, WL-14, WL-15
- **Terminal and pane state, layout restore, devserver restart**: WL-05, WL-06, WL-10, WL-16
- **File browser**: WL-12, WL-14
- **Anything that touches path resolution or the workspace root**: WL-13, WL-14

## Scenarios

| ID | Scenario | Kind |
| --- | --- | --- |
| WL-01 | Cold startup stays observable | mixed |
| WL-02 | `chan close PATH` during startup | automated |
| WL-03 | `chan workspace forget PATH` during startup | automated |
| WL-04 | Shutdown flushes task-owned state | automated |
| WL-05 | Terminal mouse preference | automated |
| WL-06 | Deterministic pane and session state | automated |
| WL-07 | Local edits and external permission changes | automated |
| WL-08 | Two-client document collaboration | automated |
| WL-09 | Two-client diagram collaboration | automated |
| WL-10 | Opaque session and layout data survives open | automated |
| WL-11 | Index and graph usable while incomplete | bounded fixture |
| WL-12 | File browser in a shared window | bounded fixture |
| WL-13 | Root disappears during startup | automated |
| WL-14 | Root disappears while fully in use | destructive |
| WL-15 | Filesystem-driven edits converge in an open editor | automated |
| WL-16 | Devserver restart preserves shared and workspace PTYs | destructive |

Automated coverage runs from two places. The Rust cases run under the normal test command; the browser cases run through the smoke harness:

```sh
SMOKE_ONLY=40,50,55,56,57,58,61,63,97,120 node scripts/e2e/browser-smoke/run.mjs
SMOKE_ONLY=98 node scripts/e2e/browser-smoke/run.mjs
```

Check `98` is destructive and must stay in the lexical tail slot, because the workspace is intentionally absent when it returns.

---

### WL-01 - cold startup stays observable

**Expectation.** `chan ps` answers within its bound while startup is still in progress, the JSON row carries the canonical path and a coherent serving state, and the launcher renders and accepts input during startup. Exactly one serve wins and the workspace reaches ready. No startup task, lock, or temporary file survives teardown.

**Run.** Start `chan serve PATH` with startup held at a deterministic in-progress barrier over a fixture with enough generated Markdown to exercise reports and indexing, plus a second variant with semantic indexing enabled. Query `chan ps` and `chan ps --json` while held, open the launcher, then release and wait for readiness.

**Backing.** Rust integration plus a launcher smoke. Not yet a single named case.

**Evidence.** `chan ps --json` before and after release, launcher screenshot while starting, teardown check for stray locks and temp files.

### WL-02 - `chan close PATH` during startup

**Expectation.** Close returns within the shutdown bound, the writer lock is free, and the serve process and tenant are gone. The workspace stays registered as stopped and its chan metadata sentinel remains. Releasing the stale startup afterwards cannot resurrect the tenant or change state, and an immediate reopen succeeds without a lock race.

**Run.** Register and begin opening the fixture, hold startup before readiness, run `chan close PATH`, keep the original barrier open long enough to detect a stale completion, release it, then inspect `chan ps --json` and reopen.

**Backing.** `devserver::tests::chan_close_during_startup_stays_off_preserves_metadata_and_reopens`, `host::tests::close_for_root_accepts_registered_starting_before_runtime_lands`, `host::tests::close_for_root_waits_for_inflight_registration_then_unmounts`.

**Evidence.** Exit status and elapsed time for close, the post-close JSON row, lock state, reopen result.

### WL-03 - `chan workspace forget PATH` during startup

**Expectation.** Shutdown completes with no tenant or process resurrecting. The registry row and the launcher/API row are absent, `CHAN_HOME` workspace metadata including saved layouts is removed, and the source directory and its sentinel are untouched. A later `chan serve PATH` starts with fresh metadata.

The existing refusal contract also holds: a hosted workspace with live terminals refuses both `chan close PATH` and `chan workspace forget PATH`, and forget must not remove the registry entry after that refusal.

**Run.** Repeat WL-02 with a source-tree sentinel and a chan-metadata sentinel, run `chan workspace forget PATH` while startup is held, release the stale startup, then poll the local registry and hosted library state.

**Backing.** `devserver::tests::chan_close_remove_during_startup_forgets_metadata_preserves_source_and_reopens_fresh`.

**Evidence.** Both sentinels after the run, registry and library state, fresh-reopen metadata.

### WL-04 - shutdown flushes task-owned state

**Expectation.** Acknowledged document and scene content survives reopen. Every owned task is completed, or aborted and awaited, before teardown returns, and no state mutation is observed after that return. The workspace cell and writer lock release only after the required flushes. Drop stays a bounded fallback, never the normal shutdown path.

**Run.** Exercise standalone and hosted teardown separately. Open a document and a scene, make acknowledged edits, hold the shutdown flushers at a barrier, request normal shutdown, verify teardown does not report completion early, release, await, and reopen. Repeat with one deliberately non-cooperative task to exercise bounded abort and await.

**Backing.** Focused Rust integration.

**Evidence.** Reopened content, task join results, timing of the teardown return relative to the flush release.

### WL-05 - terminal mouse preference

**Expectation.** On and off behavior and revisioned config writes stay correct.

**Run.** Browser check `97-terminal-mouse-toggle.mjs`.

**Backing.** That check.

### WL-06 - deterministic pane and session state

**Expectation.** Placement, focus, teardown, and semantic restore stay correct, including exact 3-column by 2-row terminal placement, focus at row 1 column 2, the expected last-pane behavior for standalone versus workspace windows, and semantic layout restore across server close and reopen.

**Run.** Browser check `120-cs-pane-layout.mjs`.

**Backing.** That check.

### WL-07 - local edits and external permission changes

**Expectation.** Edits persist, external changes reconcile, and readonly state is enforced and recovers.

**Run.** Browser checks `55-external-edit-reopen.mjs`, `56-external-edit-matrix.mjs`, `57-external-restore-converge.mjs`, `58-chmod-readonly-lamp.mjs`.

**Backing.** Those checks.

### WL-08 - two-client document collaboration

**Expectation.** Both participants converge and durable content survives close and reopen. Assert the singular session owner and the role implied by each participant's origin. Two remote clients are not both the designated leader merely because two participants exist.

**Run.** Browser check `50-editor-collab.mjs` plus a shutdown-preservation pass.

**Backing.** That check.

### WL-09 - two-client diagram collaboration

**Expectation.** Both participants converge and durable scene content survives close and reopen.

**Run.** Browser checks `40-excalidraw-collab.mjs` and `61-scene-session-reconcile.mjs` plus a shutdown-preservation pass.

**Backing.** Those checks.

### WL-10 - opaque session and layout data survives open

**Expectation.** Host session bytes are not parsed or pruned by the workspace core, and a valid layout restores.

**Run.** A focused Rust test plus the browser restore in `120-cs-pane-layout.mjs`.

**Backing.** Both.

### WL-11 - index and graph usable while incomplete

**Expectation.** Opening the window, dashboard, graph, and inspector does not wait for a complete index. Incomplete data is safe and does not masquerade as an error, available directory nodes are inspectable, and completion updates the current view without corrupting graph state or forcing a reload.

**Run.** Use the bounded fixture, not a large real repository. Open a workspace window as soon as the hosted surface is available, open the dashboard indexing page and a graph tab before indexing completes, inspect first-degree directory nodes, then wait for completion.

**Backing.** Bounded browser and devserver fixture. Not yet a single named check.

**Evidence.** Screenshots before and after completion, inspector output for an available node.

### WL-12 - file browser in a shared window

**Expectation.** The current shared expand and collapse contract is preserved with no stale or lost state. Audit the product contract first: if expansion state is shared as part of the window session, both clients converge in each direction and the intended state persists across close and reopen. If expansion state is client-local today, record that and treat shared expansion as a product feature request, not a regression.

**Run.** Open one devserver workspace window from two clients, expand a bounded directory depth in client A, verify B converges, collapse it in B, verify A converges, then close and reopen.

**Backing.** Bounded two-client browser smoke. Not yet a single named check.

### WL-13 - root disappears during startup

**Expectation.** The attempt returns a typed workspace-root-missing error and settles within the startup bound. No tenant is published and no process, task, watcher, lock, or retry loop survives the failed attempt. The registered row stays off or failed and displays the root-missing reason. Neither the server nor a background recovery task recreates the directory, releasing stale work cannot later turn the row on, and recreating the directory by hand does not auto-mount it, though a fresh explicit open succeeds.

**Run.** Use a generated workspace whose exact root the run owns. Put the mount behind a deterministic barrier after registration and before the tenant can be published, remove only the generated root while the mount is held, release the barrier, then inspect host, overlay, launcher row, lock, metadata, and filesystem.

The deterministic barrier, not the speed of a recursive delete, is what makes this assertion reliable. A real deletion during browser startup is an additional smoke check, not a replacement.

**Backing.** `host::tests::mount_rejects_root_removed_while_tenant_builds`, `devserver::tests::workspace_root_removed_during_startup_fails_closed`.

**Evidence.** The typed error, the launcher row and its reason string, a filesystem check proving the root was not recreated.

### WL-14 - root disappears while fully in use

**Expectation.** Stated per surface, because each converges differently.

- **File browser**: progressively removes entries and settles on one stable workspace-root-unavailable state. A missing root must not render as an empty valid workspace, and the surface must not enter a reload or toast loop.
- **Graph**: may shrink incrementally as watcher and index delete events arrive, then converges with no phantom file nodes. It may retain an explicitly unavailable virtual root; it must not serve stale indexed files as though they still exist.
- **Existing editor**: keeps the in-memory buffer and the unsaved edit intact, shows the current file-moved-or-deleted treatment, retains the dirty indicator, and neither autosaves nor recreates the root. The buffer bytes survive even though the missing-file panel replaces the editor canvas.
- **New root-dependent surfaces**: draft, terminal, graph, and file-browser creation all fail promptly with the same root-missing condition. A tab may render that stable error state; it must not crash the window or silently become an empty workspace.
- **Whole window and server**: stays responsive enough to close or remove the workspace. Repeated events and requests are idempotent, bounded, and cannot resurrect files or the tenant.

Any consistent prefix of the tree may be observed while deletion is underway. What must hold is eventual convergence after the root is gone, preservation of the dirty editor buffer, and strict failure of every new root-dependent operation without recreation.

**Run.** Fixture: a generated disposable multi-level tree large enough that recursive deletion produces observable intermediate states, a Markdown file of roughly 2 MiB, one file-browser tab with the hierarchy expanded, one workspace graph at maximum depth after indexing settles, and one editor tab with a visible unsaved edit in the large file.

Capture the expanded paths, graph node set, editor content and dirty state, API health, and on-disk root identity. Start recursive deletion of the positively identified test root from outside chan. Sample the file browser, graph, editor, and server APIs while it runs: partial-tree snapshots and leaf-not-found responses are valid, crashes, hangs, unsafe path fallback, and root recreation are not. Wait for deletion and bounded watcher and index reconciliation, then separately attempt to create a draft, a terminal, a new graph, and a new file browser. Confirm the deleted path is still absent after all background work and autosave intervals.

**Backing.** `scripts/e2e/browser-smoke/checks/98-workspace-root-loss.mjs`, which validates the throwaway path shape immediately before invoking `/bin/rm -rf -- <exact-root>`.

**Evidence.** Screenshots at each sampling point, the four creation attempts and their errors, a final filesystem check.

### WL-15 - filesystem-driven edits converge in an open editor

**Expectation.** An open editor converges on every external change to its file, in both directions, without needing a later unrelated edit to shake it loose. Growth, shrinkage, a byte-exact restore of content the session recently read, rapid alternation between two states, and truncation to empty all reach the editor, `GET /api/fs`, and later `cs open` calls within a bounded time. Convergence must not depend on the new content being novel: an edit that returns a file to bytes the session already saw is an ordinary external edit, not an echo of the session's own writes.

One asymmetry is deliberate and must survive. Content this session wrote to disk stays suspect for far longer than content it merely read, because a filesystem that commits asynchronously can replay our own bytes under a re-stamped mtime, and folding that replay back in destroys live state. Bytes the session only read carry no such risk and must not buy an external restore the same protection. An empty read is refused only while the session itself has a recent write to blame it on.

**Why this is load-bearing.** Agents routinely edit files through the filesystem rather than through chan's MCP server, while a human watches the same file in the editor. A stale editor in that loop is indistinguishable from an agent that did nothing, and the reviewer then acts on content that is no longer on disk. Deletions are the dangerous direction: an addition almost always produces content the session has never seen, so it converges regardless, while removals frequently restore a prior state.

**Run.** Browser checks `57-external-restore-converge.mjs` and `63-external-shrink-convergence.mjs`. The collaboration path must stay green alongside them, so run WL-08 and WL-09 in the same pass.

**Backing.** Those checks, plus `doc_sessions::tests::external_restore_of_adopted_content_converges_at_watcher_speed`, `doc_sessions::tests::truncation_on_a_never_flushed_session_needs_only_corroboration`, and the origin-window cases in `disk_echo::tests`.

**Evidence.** Per-step convergence timings from both checks, the restore and truncate steps included, and the `apiShows` field showing the HTTP read agrees with the editor.

### WL-16 - devserver restart preserves shared and workspace PTYs

**Expectation.** A windowed PTY in the shared terminal tenant and one in a mounted workspace tenant keep the same session ids and live child processes across a bare systemd restart, `chan devserver restart`, watchdog recovery, and kill-9 crash recovery. The fd store retains exactly one entry per live windowed session across every adoption. Session close removes only its entry; `chan devserver stop`, `restart --force`, and a bare stop end the relevant children and empty the store.

During startup, root health and management routes remain responsive while persisted workspaces mount. Whether a request arrives on the direct listener or through the segment-preserving gateway tunnel, mounted tenant routes return 503 with a retry hint until workspace restoration, inherited-session adoption, and continuous parking finish. A shutdown before parking activates leaves the inherited manifest untouched.

**Run.** Inside a fresh sdme container with a lingering non-root user manager, run `scripts/e2e/devserver-fdstore.sh` with `CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1`. Set `TMPDIR` and `CARGO_TARGET_DIR` to writable guest-local `/var/tmp` paths when the source is mounted read-only. The suite refuses to run outside a container.

**Backing.** `scripts/e2e/devserver-fdstore.sh`; `devserver::tests::startup_gate_keeps_root_healthy_and_refuses_tenant_routes`; `devserver::tests::fdstore_finalization_is_single_and_precedes_tenant_readiness`; `devserver::fdstore::linux::parker_tests::shutdown_before_activation_preserves_the_inherited_manifest`.

**Evidence.** Child liveness, exact per-window tenant rosters, session ids, restart counters, and systemd `NFileDescriptorStore` after every phase.

## Manual and soak

Outside the automated set, and deliberately so: these need scale, a real host, or hardware that a deterministic fixture cannot stand in for.

**Large repositories.** Use existing local checkouts. Record repository URL, exact commit, file count, disk use, enabled report and semantic modes, peak memory, and elapsed milestones. Observe launcher progress and responsiveness, `chan ps` while each workspace starts, early workspace-window availability, index and report progress to readiness, and one `chan close` plus one `chan workspace forget` on disposable copies. Linux with reports enabled and BuckOS build sources with reports and semantic search enabled are the two useful targets. Neither belongs in an automated run.

**Fresh container or devserver.** In a fresh supported container: build the exact commit, repeat WL-01 through WL-04 and WL-13 through WL-14 with bounded fixtures, repeat document and scene collaboration with two clients, repeat the graph and file-browser checks, and verify one hosted leader with the expected follower and origin roles.

**OSC 52.** Protocol parsing and unit coverage stay automated. Validate one real terminal clipboard write by hand on a supported host, because browser and container clipboard policy produces false results either way. Record terminal kind and host, the OSC 52 setting, the clipboard value before and after, and the behavior when the sequence is rejected.
