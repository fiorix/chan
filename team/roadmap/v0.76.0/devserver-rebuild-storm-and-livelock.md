# Devserver rebuild storm on build-output trees (buckos livelock)

Status: levers 1-4 IMPLEMENTED on `main` for v0.76.0: exclusions with
migration + Linux watch-registration pruning (`27fcc334`), rebuild
storm damping (`8fecff5d`), inotify overflow surfacing (`6f6dd9c7`),
worker cap + systemd watchdog (`b352639f`); the kill-switch is verified
end to end by `scripts/e2e/storm-check.sh` (`bde67c91`, ALL GREEN).
Remainder moved to v0.77.0: lever 5
(`../v0.77.0/workspace-open-reconcile-off-mount-path.md`), the
startup-journal branch rework
(`../v0.77.0/devserver-startup-journal-branch-rework.md`), and
`.gitignore` honoring (`../v0.77.0/gitignore-aware-exclusions.md`).
Root cause of the storm CONFIRMED by live repro against the installed
0.75.0 binary; the terminal request-seizure on the field box is
narrowed but not pinned (process died before the deciding capture;
the journal there remains the last evidence). Fix levers below.

## Incident

`chan devserver` v0.75.0 on a 315-logical-core box livelocked ~2h after
start: ~3 cores burned continuously, port bound and accepting but `curl /`
never answered, 645 threads (632 `tokio-rt-worker`). Workspace: a
buckos-build clone (Buck2 OS build) with an sdme container bind-mounted
over it, so container-side builds fire host inotify. Deleting `~/.chan`
"fixes" it (the overlay is gone, nothing re-mounts at boot).

## Confirmed: the rebuild storm

Repro rig (`~/chan-repro` on the dev box, sandboxed CHAN_HOME, port 8790,
installed 0.75.0 bits): 180k-file synthetic tree, 4-writer torrent into
`buck-out/`. Result: 70 back-to-back full-tree rebuilds in ~13 min, ZERO
idle samples, 2600+ trigger WARNs, thread menagerie identical to the field
dump (`tokio-rt-worker`, `segment_updater`, `merge_thread_0..3`,
`r2d2-worker-*`, `notify-rs inoti`).

Mechanism, all file:line refs on main @ e1d33a04:

- `buck-out/`, `.buckos/`, `downloads/`, `distfiles/`, `prebuilt/`,
  `vendor/`, `prelude/` are NOT in `DEFAULT_INDEX_EXCLUDED_DIRS`
  (chan-workspace/src/registry.rs:23); chan never reads `.gitignore`. The
  watcher registers inotify recursively on EVERY directory (WalkFilter
  applies to event dispatch only, chan-workspace/src/watch.rs:170 vs :319).
- The build torrent reaches the server indexer, whose rebuild triggers are
  level-triggered with no cooldown: broadcast Lagged (1024-cap,
  chan-server/src/indexer.rs:527-537), >=64 pending indexable paths in a
  VCS workspace (indexer.rs:32,502-510), and root `.git/HEAD|.git/index`
  events (indexer.rs:641-645; vcs.rs:87-89). The coordinator drains its
  queue only BEFORE starting a rebuild (indexer.rs:316-320), so one
  trigger per rebuild-duration sustains the loop forever.
- Each rebuild walks the ENTIRE unfiltered tree twice (rebuild_graph at
  chan-workspace/src/workspace.rs:2245; build_all list_indexable at
  index/facade.rs:477) with per-entry stat, plus tantivy writer+merge
  threads.
- Kill-switch PROVEN: adding `"buck-out"` to `index_excluded_dirs` in the
  library config, same torrent: zero triggers, index pinned idle, for the
  whole 10-min window.

Adjacent confirmed bug: notify 6.1.1 delivers inotify queue overflow as
`Ok(EventKind::Other)` which dispatch silently drops (watch.rs:209-214),
and swallows runtime `add_watch` ENOSPC with `.ok()` — chan goes silently
stale on overflow/watch-limit instead of surfacing or reconciling.

## Narrowed but open: the request seizure

The 315-core fact resolves the thread census benignly: 632 tokio-named =
315 default workers + ~317 blocking threads (512 cap NOT reached), and the
"643 threads at one identical instruction" observation is an artifact
(every futex_wait, including normal idle worker parking, shares one
syscall IP in a static binary). What remains unexplained is only why
`GET /` (pure async over rust-embed, no locks beyond two short RwLock
reads) never answered. Adversarially refuted: blocking-pool saturation,
tracing-writer wedge, RwLock reader-behind-writer seizure. Surviving
suspects: accept backlog full behind a stalled accept path; a
315-worker scheduler/driver pathology under the storm. Evidence still
obtainable: `journalctl --user -u chan-devserver` on the field box for
the incident window (storm WARNs + adjacent errors).

## Fix levers (ranked)

1. Exclusions: honor `.gitignore` (or at minimum ship an extensible
   excluded-dirs default including `buck-out`, `.buckos`, `downloads`,
   `distfiles`, `prebuilt`, `vendor`) for walk AND watch registration.
   Proven complete kill-switch for this failure class.
2. Storm damping: cooldown/backoff between coordinator rebuilds; coalesce
   triggers DURING a rebuild instead of draining only before start
   (indexer.rs:316-320).
3. Surface watcher degradation: propagate inotify overflow (Rescan) and
   add_watch ENOSPC to the consumer as a real event (one bounded reconcile
   + a user-visible workspace notice), instead of silent drops.
4. Runtime hardening: cap `worker_threads` in the runtime builder
   (chan/src/main.rs:17-20) — 315 workers on a loopback devserver is pure
   waste and made the field dump unreadable; and add `WatchdogSec=` +
   periodic `WATCHDOG=1` notify pings to the systemd unit template
   (chan/src/lib.rs:4697-4706) and the packaged unit
   (packaging/distros/shared/chan-devserver.service) so a seized-but-alive
   process auto-restarts with a journal trail.
5. Move `Workspace::open`'s inline reconcile (full stat walk) off the
   calling thread; it runs on an async worker on the mount path and is
   minutes-long on cold large trees. Also the main lever for chan-desktop
   startup on large repos (desktop boot matrix already backgrounds mounts;
   the mount itself is what is slow).

## Startup-journal branch (a42436ac) disposition

`claude/dev-server-startup-journal-jrl3rw` does NOT address this failure
(the field wedge formed post-mount; bind-after-mounts proves boot mounts
completed). It fixes real launcher-reachability pain but shipped-as-is
would regress: pending re-mount rows are invisible to `persist_state`
(any mid-window persist DROPS them from the overlay), toggle-off/forget
during the window are silently reversed by the background mount, READY
fires with mounts pending (fail-visible -> fail-silent), the deferred
fdstore apply can duplicate restored terminals after clients reconnect,
and the restore task is detached with no owner/cancellation. Rework
shape: track pending rows as `starting` in the serving map BEFORE the
spawn (fixes persist visibility + the toggle races), supervise the task
and honor shutdown, and keep fdstore apply ahead of serving terminals.
Full findings (20, adversarially verified) in the session record.
