# release-v0.76.0

Rebuild-storm and recovery hardening: the devserver stops livelocking on busy trees, and the pieces that a storm or a restart used to corrupt -- the editor's authority over your unsaved work, the search/index readiness a client sees, and an installed systemd unit -- now recover correctly instead of silently losing state. This was a plan-driven team round (`dev/v0.76.0/plan.md`) that closed the correctness gaps left open when the storm kill-switch (levers 1-4) landed on `main`, and it hardened them behind two adversarial review passes.

No release decision is recorded here yet: this cycle was prepared as a local, committed, unpushed, untagged state ending at the `chore(release): 0.76.0` commit. The publish decision, the host-only acceptance smokes, and the full-scale storm acceptance are the release owner's to run.

## What shipped

**The rebuild-storm class is closed, not just damped.** Levers 1-4 (build-output exclusions, unit migration, Linux watch-registration pruning, rebuild-storm damping, inotify-overflow surfacing, the worker cap, and the systemd watchdog) had already landed on `main`. This round unified them behind a single `IndexScopePolicy` shared by walk, indexing, the Linux inotify registration, and the report scanner, layered `.gitignore` honoring under the `index_excluded_dirs` overrides, and replaced the drop-the-trigger-then-cooldown rebuild path with a generation coordinator: a trigger arriving *during* a rebuild forces exactly one more pass before ready, repeated overflow coalesces to the last required generation with no lost trigger, and the `REBUILD_COOLDOWN` stays a floor under the latch. `WatchEvent` was enriched so a directory rename or removal forgets the whole affected subtree from the graph and search index instead of leaving it stale.

**The editor never silently discards your work.** `PUT /api/files/{path}` became a checked write: a stale `expected_mtime_ns`/`authority_version` returns `428`/`409` with the current version so the client can three-way merge or open a conflict dialog, and the conflict-resolution UX (reload-from-disk / overwrite-disk, for both documents and scenes) is now wired end to end through `/api/session-conflicts/resolve` instead of existing only in tests. Held document and scene authorities persist a durable recovery record under `.chan/editor-sessions/`, written through the canonical bounded atomic writer, so a server restart during an unsaved or conflicted edit rehydrates that state before any flush can run and never overwrites newer disk content with stale authority.

**Transfers are bounded end to end.** The canonical filesystem helpers (a streaming atomic writer and a bounded chunked reader) replaced the ad-hoc write/read paths; the standalone-terminal single-file download now streams instead of buffering the whole file into memory; and chan-desktop downloads and uploads stream through the native layer to a temp file with an atomic commit, origin pinning, redirect refusal, <=10 Hz progress, and a bounded 2-download/1-upload queue -- the WebView IPC never copies a whole file.

**Recovery is legible.** A `WorkspaceReadiness` (`ready`/`recovering`) status is exposed on the index-status, indexing-state, preflight, and content-search routes and consumed by the SPA and by a new `chan workspace status`. A query issued while the workspace recovers returns an explicit *recovering* result rather than a fresh-looking empty one.

**Installed systemd units are handled honestly.** A devserver unit is classified before it is rewritten: the current or a known prior chan render migrates through a safe daemon-reload/restart/rollback path that preserves fdstore ownership, while a foreign or admin-edited unit is refused with an actionable error rather than silently overwritten. A failed migration rollback discloses that live terminal PTYs were dropped instead of claiming a lossless restore.

## Team and process

One `claude` lead (planner, integrator, contract owner, release closer) coordinating three `codex` worker lanes in per-lane git worktrees over a shared `dev/` coordination tree: **@@Workspace** (chan-workspace filesystem/recovery/policy + the server rebuild coordinator + the storm harness), **@@Editor** (chan-server sessions/routes + desktop streaming + the SPA), and **@@Runtime** (the devserver startup state machine + systemd units + the CLI). Seven wire contracts (WatchEvent enrichment, session state, the HTTP write contract, the index-scope policy + generation, the readiness surface, the canonical fs helpers, and the desktop streaming command) were frozen before the dependent tasks were dispatched.

Work ran in three waves (foundational primitives; consumers and policy; streaming, acceptance, and readiness) plus a review-driven fix round, with an adversarial review after wave 2 and after wave 3. Each review fanned dimension reviewers out over the highest-risk changes and had two independent skeptics try to refute every finding before it was accepted; only confirmed findings drove fixes.

## Validation

- Full `make pre-push` gate green on a fresh worktree (shell/workflow lint, `cargo fmt --check`, clippy `-D warnings` all-targets, `cargo test` all-targets, `--no-default-features`, the separate gateway workspace, `make web-check`, marketing).
- Integration rebuild-storm (`scripts/e2e/storm-check.sh`) ALL GREEN at the committed scale: excluded-torrent produced zero rebuilds, tracked-torrent stayed on the per-file path, a real git checkout/reset/rename/branch-flip plus an inotify-queue overflow (18,432 events over the host's 16,384 queue) converged disk, graph, index, report, and the live editor authority, and the same convergence held after a server restart re-attached the held session.
- Two adversarial review passes. Wave 2 caught two HIGH release-blockers (a terminal single-file download that buffered the whole file, and a single unrelated `.gitignore` negation that defeated descent-pruning). Wave 3 (38 agents) confirmed 13 findings; the seven fix-now items were fixed, including a HIGH: the workspace flock-leak-on-close class was found still open in the workspace's own startup recovery worker after it had been fixed for the server coordinator.
- A cross-lane regression that every lane's filtered own-gate missed -- the server rebuild coordinator held a strong `Arc<Workspace>` across its poll/cooldown awaits, so a `forget` racing the mount-triggered rebuild hit `WorkspaceAlreadyOpen` -- was caught by running the FULL `cargo test -p chan-server` suite at integration and fixed before it could ship.
- Real-systemd acceptance was host-proven, not deferred: the SIGSTOP/watchdog/fdstore restart e2e ran against a real user-manager (systemd 259) with `NRestarts` observed.

**Host / owner-verified (not locally proven):** the desktop native GUI responsiveness smoke (needs a display server + WKWebView) and the full-scale storm acceptance (`CHAN_STORM_ACCEPTANCE=1`, 180k files / 4 writers / 10 minutes) are named here for the release owner to run; they were not represented as locally proven.

## Retrospective

**Highlights.** The two adversarial passes earned their cost: each caught a HIGH release-blocker that the gate, the lane own-gates, and integration testing all passed. The full-suite-at-integration discipline caught a real cross-lane lock race that filtered own-gates hid. Real-systemd acceptance turned out to be runnable on the build host, so watchdog/fdstore behavior was proven rather than assumed.

**Lowlights.** The lock-lifetime fix landed incomplete the first time -- it fixed the server coordinator but not the workspace's own recovery worker, the same bug class one file away; the wave-3 review is what caught the second instance. The lesson recorded: when fixing a bug *class*, sweep for every instance of the pattern, not just the reported site. Separately, filtered own-gates gave false green on a race that only surfaces in the full crate suite; the integrator's per-merge verify now runs the whole suite for any crate a merge touched.

**Honest feedback.** A plan-driven round with seven frozen contracts kept three parallel lanes from stepping on each other, but the contracts had to be genuinely frozen before dispatch -- the one place a contract shifted mid-wave (the readiness shape) cost a ratification round. The single-owner integration model (every merge cross-reviewed, full-suite verified, then adversarially reviewed) is slow but is what surfaced the release-blockers before a tag existed.

## Follow-ups

Deferred to v0.77.0 (six LOW wave-3 findings, none of which lose user data; the data-dropping gitignore false-exclude was fixed this round):

- Editor recovery persistence should debounce off the per-push ack path rather than writing a full sidecar per push.
- A `Conflicted` rehydration should collapse to Clean/Dirty when the fresh disk matches authority/baseline instead of re-prompting.
- `classify_rendered` should derive chan's own desired unit from the trusted renderer so a renamed binary cannot make chan classify its own unit as foreign.
- Desktop generated-download temp files and sinks should be reaped on window teardown, not only via the pagehide IPC.
- The desktop 64 KiB chunk bound should be documented as a client-cooperative limit or enforced on the raw frame before materializing it.
- The remaining gitignore over-descent on an escaped leading path component (a fail-safe: it over-descends, it does not drop files) should decode escaped literals when extending the fixed prefix.

Already-registered v0.77.0 scope carried forward: storm lever 5 (moving `Workspace::open`'s inline full-stat reconcile off the async mount path), the devserver startup journal-branch rework, the fuller `.gitignore`-aware exclusions shape, the upload/download budgets, video preview + HTTP range serving, and the editor external-restore echo-swallow.
