# chan close can answer before the devserver records the workspace off

Status: shipped in [v0.121.0](../../release/release-v0.121.0.md).

Record before the release: raised by the Mac seat on 2026-11-02 from a pre-push hook run on macOS, where the test below read the old state once in twenty runs on unchanged code; accepted for v0.121.0 by the owner the same day ("lets fix these items").

## What is there now

`crates/chan/tests/devserver_resilience.rs`, `workspace_forget_of_an_off_devserver_row_clears_the_overlay_and_restart`, reads the devserver overlay `devserver/workspaces.json` right after `chan close <root>` exits 0 and expects the row `on: false`. On macOS 27.0.1 it read `on: true` in 1 of 20 isolated runs at the v0.120.1 code. Whether the close's success should imply the write (a product race) or the test should wait for it (a test race) is not established.

## Desired contract

1. A successful `chan close` of a devserver workspace means what the code and the help say it means, and the test asserts exactly that: if it promises the off state recorded, the reply follows the durable write; if not, the test waits for the write.
2. The test no longer fails under load on unchanged code.

## Acceptance

1. The item states which race it was, with the lines read.
2. A test that fails on the old order, or a test that waits for its condition with a bounded wait, as the reading decides.
3. Measured before and after: isolated and loaded run counts on Linux, with the method.

## Closing

Neither race as framed. A close that reaches the devserver already answers after the durable write: `close_detached` records the off with `overlay.set_each(.., false)` before the teardown and before it returns (`crates/chan-library/src/host.rs:5431-5435`), and a close of a root no runtime holds records it before answering (`host.rs:4790`); `WorkspaceOverlay::persist` (`crates/chan-library/src/workspace_persist.rs:179-200`) returns only once its snapshot or a newer one is written through `atomic_write` with file and directory fsync; the control socket writes the reply after `handle_unserve` returns (`crates/chan-server/src/control_socket.rs:1077`); and the CLI's `round_trip` waits for that reply with no client timeout (`crates/chan-shell/src/control.rs:513-531`). Waiting in the test would not help either: the red's row, `{"generation": 1, "on": true}`, is the row the mount wrote, and every recorded intent advances the generation, so no close wrote anything. The close exited 0 without the devserver closing the workspace, through one of the CLI's best-effort exits in `crates/chan/src/close.rs` at the base: a lock record with no control socket of its holder found, or no record to read, printed `(not served: PATH)` and exited 0 whatever the state of the writer lock (lines 403-420, 137); an error answer printed `could not reach the server ... treating as closed.` and exited 0 even while the holder kept the lock (line 155). The product defect is that `chan close` reported a workspace not served, or closed, while a live process still held its writer lock, against its help ("releases the workspace's writer lock").

Reproduced on Linux, deterministically: a close whose runtime directory hides the devserver's control sockets exits 0 with `(not served: ...)` and leaves the row `on: true`. The first measurement here met the same exit by accident: with a 95-character `TMPDIR` the sandbox's socket path passed the 108-byte `sun_path` limit, the devserver bound no control socket, and the unchanged test failed 60 of 60 with the Mac's exact row. Not established: which exit the Mac run took. The step that can miss without such a cause is discovery: a devserver's sockets are stable-named and carry no pid, so the CLI finds them by an Identify round trip bounded at 2 s per socket (`CONTROL_SOCKET_PROBE_TIMEOUT`, `chan-shell/src/control.rs:295`), and Identify waits for the tenant's workspace cell on the blocking pool (`control_socket.rs:1800`), so a busy tenant can miss its probe.

Changed, in `crates/chan/src/close.rs`: `find_lock_holder` looks for the recorded holder's control socket and, while the writer lock stays held with none found or no record to read, looks again every 200 ms for up to 5 s (`LOCK_HOLDER_BOUND`, also the release wait's bound). A free lock still reads not served, a record its gone holder left included. A lock still held at the bound now fails the close or forget with exit 1, `refusing to report PATH closed: pid N holds its writer lock and answered on no control socket`. An error answer from a reached holder is still printed as before and treated as closed when the holder lets go of the lock within the bound; when it keeps the lock, the close or forget fails with exit 1 naming the pid and the answer, and a forget leaves the registry as it is. `chan close` and `chan workspace forget` help and `crates/chan/design.md` say so. The flaky test's overlay assertion now prints the close's output, so a recurrence names its exit.

Verified by tests, red first against the base code with the assertions read: `close_that_cannot_reach_the_holding_devserver_fails` (`devserver_resilience.rs`; base: exit 0, `(not served: ...)` with the row on; now exit 1 naming the devserver's pid, the row still on, and a close that reaches it then records the off), `close_reaches_a_holder_whose_control_socket_binds_late` (`serve_close.rs`, a stand-in holder that binds its socket 500 ms after the close starts; base: never asked, `(not served: ...)`), and `close_answered_an_error_by_a_holder_that_keeps_the_lock_fails` (base: exit 0, `treating as closed`). One mutation per guard, each caught by its test: the bound's end reading free, no retry, and the error answer skipping the lock check. `cargo test -p chan` with the change: every binary green, 0 failed.

Measured on geekom (Linux 7.1.8-cachyos, 16 CPUs, shared with other agents' builds, load average 4 to 9 through the runs), the test alone with `cargo test -p chan --test devserver_resilience <name> -- --exact` under a clean environment and a short `TMPDIR`:

- Isolated, sequential: before 60 of 60 green, after 60 of 60.
- Loaded, three looping copies of all twelve `-p chan` test binaries beside the loop: before 60 of 60. This load did not hold (each copy finished one pass in about 40 s and the load average fell from 8.6 to 6.3), so it counts little.
- One CPU: `scripts/e2e/one-cpu-test-series.sh` was not run, as it needs a running, disk-capped sdme guest with a clean checkout at `/work/chan` and this host's only guest is stopped. Stand-in: the loop in a `systemd-run --user --scope -p CPUQuota=100%` scope under `taskset -c 15` (inside: `cpu.max` `100000 100000`, `Cpus_allowed_list` 15): before 60 of 60, after 60 of 60. It lacks a guest, a disk cap and a throttle count.
- Contended: 40 runs in a 400 percent scope on CPUs 12 to 15 beside three looping copies of the whole `devserver_resilience` binary (12 whole-binary runs of 38 tests, all green): before, the base code with diagnostics printed only on a red, 40 of 40; after 40 of 40.

Open: Linux never reproduced the Mac's 1 in 20, so whether the change removes that red on macOS is not established, and the release agent should watch for it there; a recurrence now either fails the close with the holder's pid or prints the close's own output in the overlay assertion. The two refusals wait up to 5 s, so each new refusal test takes about 5 s. A close whose holder cannot be reached asks every stable control socket in the `/tmp/chan-control-UID` fallback directory who it is, as before, now every 200 ms for up to 5 s. The gate was not run here; it runs at the merge.
