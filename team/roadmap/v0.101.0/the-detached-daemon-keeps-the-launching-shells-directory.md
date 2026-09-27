# The detached devserver daemon keeps the launching shell's directory

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-25 by the reading lane over the side-effect and error-handling lows (review line 4850 of the development ledger `dev/rust-review-lows.md`). A source reading against `main` at `f063ddd45`.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, in the lane for small server and CLI fixes with [a-watcher-loss-leaves-the-code-report-stale](a-watcher-loss-leaves-the-code-report-stale.md), [a-corrupt-devserver-config-re-mints-the-library-identity](a-corrupt-devserver-config-re-mints-the-library-identity.md), [a-scripted-reports-disable-exits-zero-having-changed-nothing](a-scripted-reports-disable-exits-zero-having-changed-nothing.md) and [a-keychain-failure-freezes-a-connected-gateways-roster](a-keychain-failure-freezes-a-connected-gateways-roster.md), landing before the split of [the-chan-cli-crate-is-one-13k-line-file](the-chan-cli-crate-is-one-13k-line-file.md) moves code in `crates/chan/src/`.

## What was seen

`spawn_daemon_child` (`crates/chan/src/devserver_daemon.rs:281`) builds the `__devserver-daemon` command with its args, null stdin, log-file stdout and stderr and the tunnel env (`:288-307`). It detaches the child with `setsid` on Unix or `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on Windows (`:371-392`), but never calls `current_dir`. The daemon therefore inherits the directory `chan devserver start --service=chan` ran in and keeps it for its whole life. On Windows that folder then cannot be deleted or renamed while the daemon runs, and on Unix the filesystem it sits on cannot be unmounted, with nothing pointing at chan as the cause.

## What to do

Pin the child's working directory to a stable location, such as the resolved chan home, in `spawn_daemon_child`. Red first: factor the command build into a function and assert that `Command::get_current_dir()` is the expected directory; on Linux the existing daemon e2e can also read `/proc/<pid>/cwd`.

## Boundaries

`home_unavailable_config_dir` consults `current_dir()` when HOME cannot be resolved (`crates/chan-workspace/src/paths.rs:76`, `:95`). A child with a new cwd could therefore resolve a different home than its parent and miss the lock and record the parent waits on. The fix must hand the child the parent's resolved `CHAN_HOME` explicitly and must not change that fallback, which the-chan-home-fallback-trusts-var-tmp.md owns.

## What shipped

Landed on 2026-09-27. The detached daemon runs in the parent's resolved chan home, made absolute, so it keeps no directory of the user's busy. The daemon end-to-end test reads the live daemon's `/proc/<pid>/cwd`.

The daemon is handed `CHAN_HOME` in two cases only, which narrows the Boundaries sentence above. One is when the parent has a `CHAN_HOME` override: the daemon gets the resolved home as an absolute path, because a relative override would resolve against the daemon's new directory. The other is when no home resolves, because the fallback makes a fresh directory per process and the two would split. A daemon whose home resolves finds the same one from any directory and gets no `CHAN_HOME`: a set `CHAN_HOME` reads as an override to every terminal the daemon spawns, to the bin directory it resolves, and to the systemd and launchd backends, which carry it into a unit or plist only when the user set it. The three cases are pinned through the command build's inputs; no test runs the third against a process that has no home. `crates/chan-workspace/src/paths.rs` is unchanged.
