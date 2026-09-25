# The detached devserver daemon keeps the launching shell's directory

Status: raised during v0.101.0 on 2026-09-25 by the reading lane over the side-effect and error-handling lows (review line 4850 of the development ledger `dev/rust-review-lows.md`); not accepted. A source reading against `main` at `f063ddd45`.

## What was seen

`spawn_daemon_child` (`crates/chan/src/devserver_daemon.rs:281`) builds the `__devserver-daemon` command with its args, null stdin, log-file stdout and stderr and the tunnel env (`:288-307`). It detaches the child with `setsid` on Unix or `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on Windows (`:371-392`), but never calls `current_dir`. The daemon therefore inherits the directory `chan devserver start --service=chan` ran in and keeps it for its whole life. On Windows that folder then cannot be deleted or renamed while the daemon runs, and on Unix the filesystem it sits on cannot be unmounted, with nothing pointing at chan as the cause.

## What to do

Pin the child's working directory to a stable location, such as the resolved chan home, in `spawn_daemon_child`. Red first: factor the command build into a function and assert that `Command::get_current_dir()` is the expected directory; on Linux the existing daemon e2e can also read `/proc/<pid>/cwd`.

## Boundaries

`home_unavailable_config_dir` consults `current_dir()` when HOME cannot be resolved (`crates/chan-workspace/src/paths.rs:76`, `:95`). A child with a new cwd could therefore resolve a different home than its parent and miss the lock and record the parent waits on. The fix must hand the child the parent's resolved `CHAN_HOME` explicitly and must not change that fallback, which the-chan-home-fallback-trusts-var-tmp.md owns.
