# A FreeBSD devserver runs out of descriptors watching a large workspace and stops answering

Status: raised on 2026-10-27 by the owner after the v0.112.0 GA; accepted for v0.113.0 by the owner's word of 2026-10-27 ("organise 3 independent worktrees for 3 agents to work on ... they will build in parallel"); building on `v0113/a-freebsd`.

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

## Measured on the guest, 2026-10-27

Read on the FreeBSD 15.1-RELEASE-p6 arm64 guest with the 0.112.0 release (`build git-90ad947b8241`), whose notify 6.1.1 and kqueue 1.1.1 match the reading above.

- The workspace, `~/chan` at `ff5713172`, holds 77,685 entries (`find . | wc -l`; 77,703 following links). Pruning `target/`, `node_modules/` and `.git/` leaves 5,056, of which 465 are directories (8,091 directories unpruned). `target/` alone is 72,453 and `.git/` 176; there is no `node_modules/`. Of the 6 symlinks, 4 dangle: `.build-tools/dmg-venv/bin/python`, `python3`, `python3.14` and a fourth with a non-ASCII name, a macOS virtualenv synced into the guest.
- Limits: the ssh shell's `ulimit -n` equals `kern.maxfilesperproc`, 234,972, and `kern.maxfiles` is 261,088. The daemon inherits the shell's: `procstat -l` reads openfiles 234,972 soft and 234,972 hard. The whole tree fits the limit three times over, so the limit alone does not explain the failure.
- Reproduced with the owner's command (forwarding 19121 rather than 19021). `~/chan` was off in the devserver's overlay, so the daemon came up healthy at 27 descriptors; `chan serve --devserver=8787 ~/chan` turned it on. `procstat -f <pid> | wc -l`, sampled once a second: 28, 15,886, 31,740, 51,535, 71,330, 91,125, 114,882, 142,592, 170,305, 198,021, 229,693, then 234,972 from the eleventh second on. `kern.openfiles` reached 235,346 of the system's 261,088.
- The first failure is not `EMFILE`. It is `No such file or directory` with an empty path, 59 times in the first ten seconds: notify's recursive `add_watch` walks with `WalkDir::follow_links(true)`, and a dangling symlink ends the walk with an error that carries no path. `EMFILE` begins at the tenth second (269 warnings by the thirtieth) and `accept error: Too many open files` once a second from the eleventh.
- The retries are what grow the count, at about 20,000 descriptors a second. Each one re-walks the roughly 4,000 entries that precede the dangling link and leaks a descriptor for every one already watched. When the table was full, `procstat -f` counted `web/` 111,449, `team/` 47,100 and `crates/` 24,603, and `target/` not at all: the walk never reached it, and the table filled with duplicates of the first few thousand paths.
- `chan close ~/chan` unmounted the tenant and the count stayed at 230,974. A leaked duplicate is never stored, so not even the kqueue watcher's `Drop`, which closes only stored entries, releases it; only process exit did (`kern.openfiles` back to 384).
- notify 6.1.1's kqueue event loop cannot follow a scope policy even with per-directory registration. On a write to a watched directory it adds the first entry it does not know with `add_watch(path, true)`, recursively (`src/kqueue.rs`, the `Vnode::Write if path.is_dir()` arm). On a link-count change it removes the directory and re-adds it recursively (the `Vnode::Link` arm), opening every child again. The first would walk an excluded `target/` the moment anything is written beside it, and the second leaks a descriptor per child already watched.

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
