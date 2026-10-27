# A FreeBSD devserver runs out of descriptors watching a large workspace and stops answering

Status: raised on 2026-10-27 by the owner after the v0.112.0 GA; awaiting acceptance for v0.113.0.

## What was seen

The owner's words of 2026-10-27: "finding a problem running devserver on freebsd, help me sort out what could be the problem and let's add an item to roadmap". The command, run from macOS against a FreeBSD 15 Lima guest whose library holds a chan checkout:

```
ssh -F ~/.lima/freebsd-15/ssh.config -o ExitOnForwardFailure=yes -L 127.0.0.1:19021:127.0.0.1:8787 lima-freebsd-15 .local/bin/chan devserver join --service=chan
```

It ended with `Error: chan devserver: daemon pidfile exists but health did not become ready.` and the daemon's log tail: `WARN chan_workspace::watch: watcher: failed to register directory error=Too many open files (os error 24)` for the checkout's root four times a second, and `ERROR axum::serve::listener: accept error: Too many open files (os error 24)` once a second.

Read at `171150ef0`, with notify 6.1.1 and kqueue 1.1.1 from `Cargo.lock`:

- `crates/chan-workspace/src/watch.rs`, the non-Linux `register_root` (line 1165), takes one `RecursiveMode::Recursive` watch on the workspace root. Its comment says the backends "(FSEvents, ReadDirectoryChanges) recurse natively with no per-directory descriptor cost". FreeBSD takes this arm, and notify selects its kqueue backend there. The Linux arm (line 1025) walks the tree itself through the scope policy and never registers an excluded subtree; the non-Linux arm applies the policy only when it dispatches events.
- notify's kqueue `add_watch` (`src/kqueue.rs`, lines 289 to 305) answers a recursive watch with `WalkDir::new(path).follow_links(true)` over every entry, files and directories alike, and `add_single_watch` opens each one through `kqueue::Watcher::add_filename` (`File::open`, kqueue `src/lib.rs` lines 290 to 307). It holds one descriptor per path for the watch's life, `target/`, `node_modules/` and `.git/` included and symlinked trees followed. A tree with more entries than the process's descriptor limit cannot register.
- On the first failed open, `add_watch` returns the error and keeps every descriptor it had opened. The supervisor retries on the same watcher every `WATCH_RETRY_INTERVAL` (250 ms, line 316). `reset_registrations` (line 981) unwatches only `registered_dirs`, which never received the failed root, so the partial registration stays open. The retry walks again, and `add_filename` opens each already watched path anew, finds an equal entry (`Ident` compares filenames only, kqueue `src/lib.rs` lines 207 to 219) and drops the new descriptor without closing it. The table stays full, and every retry that finds a free slot fills it again.
- The devserver's HTTP listener shares that table, so `accept` fails with `EMFILE`. `chan devserver join` (`crates/chan/src/devserver_daemon.rs`, `attach_existing`, lines 245 to 270) finds the running daemon's pidfile, waits 5 s for its health and gives up with the error above; the stuck daemon keeps running.
- chan never raises its soft `RLIMIT_NOFILE` (the only `setrlimit` in the tree is a test fixture), and the `fd_budget` probe sizes indexing and the SQLite pools, not the watcher. The FreeBSD port (`done/freebsd-is-not-a-published-target.md`) bounded the catch-up rescans' descriptors by tree depth; the root registration is the remaining unbounded user.

Not established: the failure was not reproduced on a FreeBSD guest for this reading, and the guest's entry count, `ulimit -n` and `kern.maxfilesperproc` were not measured. What settles the cause: `find` over the workspace counted against `ulimit -n` and `sysctl kern.maxfilesperproc`, the same count with `target/`, `node_modules/` and `.git/` pruned, and `procstat -f` on the daemon's pid sampled while the warning repeats, which also shows whether the count grows with the retries.

## Desired contract

A FreeBSD devserver serving any workspace, a built chan checkout included, stays healthy: `/api/health` answers and the listener accepts whatever state the watcher is in. The watcher's descriptor use on FreeBSD stays below the process limit with a reserve left for the listener, terminals and workspace I/O, and subtrees the scope policy excludes cost no descriptors, as on Linux. A registration that cannot complete releases every descriptor it opened, retries do not accumulate descriptors, and the watcher reports a tree it cannot watch through `ProviderError`, so the full-reconcile contract covers it, instead of retrying four times a second forever.

## What to do

1. Measure first on the FreeBSD guest: reproduce with the owner's workspace and record the counts and limits above and the daemon's descriptor count over time. Then a red test that needs no large tree: a child process with a lowered `RLIMIT_NOFILE`, as the `fd_budget` tests already do, watching a constructed tree wider than the limit, in which the watcher must leave a listener able to accept.
2. `watch.rs` on FreeBSD: register through chan's own walk and the scope policy, as the Linux arm does, instead of one recursive notify watch. kqueue reports a directory write only for entry changes, so a content change to an existing file needs that file's own descriptor: decide, and record in this row, how per-file changes are seen within a budget (per-file watches for accepted files up to the budget and a degraded poll or reconcile beyond it, or another backend).
3. On a failed registration, unwatch the partial root or rebuild the watcher, whose `Drop` closes every descriptor, before retrying, and space retries so a tree that cannot fit does not loop at 250 ms. Pin the release and the non-growth.
4. Decide whether the devserver raises its soft `RLIMIT_NOFILE` to the hard limit at start on unix, with the budget still applied, and record the decision.
5. The non-Linux `register_root` comment names kqueue's per-path cost.

## Boundaries

`crates/chan-workspace/src/watch.rs` and its tests, `crates/chan-workspace/src/fd_budget.rs` if the watcher draws on it, and the devserver start path if the limit is raised. Not changed: the Linux and macOS watcher arms, the indexer's budget, the daemon's readiness contract.

## Acceptance

1. On a FreeBSD guest, `chan devserver join --service=chan` with a built chan checkout in the library comes up healthy, and the daemon's descriptor count stays below its limit with the reserve held.
2. The constructed test above fails before the change and passes after; a mutant of the release on failure and one of the scope filter each fail it.
3. `crates/chan-workspace/tests/watch_completeness.rs` still passes on FreeBSD.
