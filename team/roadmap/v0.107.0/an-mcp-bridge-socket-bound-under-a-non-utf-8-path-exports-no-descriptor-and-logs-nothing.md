# An MCP bridge socket bound under a non-UTF-8 path exports no descriptor and logs nothing

Status: built on 2026-10-16 on the seat's branch; the section MCP socket warning holds the evidence; it closes at the GA as shipped.

## What was seen

Read at source at `d7492c5ba`, not constructed. The MCP bridge chooses its socket's runtime directory as the control socket does (`crates/chan-server/src/mcp_bridge.rs` 50 to 94, through `var_os`), and `start` (323 to 380) binds a path without requiring UTF-8; `crates/chan-server/src/lib.rs` 755 to 762 logs a failed bind only. For a successful bind under a path that is not valid UTF-8 the terminal registry keeps the real path, but `crates/chan-library/src/terminal_sessions/platform.rs` 408 to 427 returns `None` at `socket_path.to_str()?`, the opted-in spawn (`terminal_sessions.rs` 4499 to 4505) inserts no descriptor, and `ChanSpawnEnv::apply` (909 to 916) removes every unset reserved key, so `CHAN_MCP_SERVER_NAME`, `CHAN_MCP_SOCKET`, `CHAN_MCP_COMMAND`, `CHAN_MCP_COMMAND_JSON` and `CHAN_MCP_SERVER_JSON` are all absent. A user who opted in sees no chan MCP descriptor in the terminal, a tool that relies on it cannot discover the serving workspace's endpoint, and no line in the log says why. The same helper returns `None` when `current_exe` fails or its path is not UTF-8, which a check of the socket path alone does not cover. The control socket's sibling case is [a-control-socket-bound-under-a-non-utf-8-path-leaves-no-socket-no-report-and-no-log-line](a-control-socket-bound-under-a-non-utf-8-path-leaves-no-socket-no-report-and-no-log-line.md).

Not established: that anyone has met it; the MCP env is off by default; not constructed in a running server.

## Desired contract

A server whose MCP bridge binds a socket it cannot export says so once in its start-up log, where a reader missing the descriptor looks.

## What to do

The shape of the control socket item's repair: one warning at the successful bridge bind when the socket path is not UTF-8, naming the path in its Debug form and the consequence (the opted-in terminals get no `CHAN_MCP_*` descriptor); the library's spawn arm unchanged; the pin red first with the crate's capture subscriber, the level asserted apart, the mutants as for the control socket (omitted, unconditional, duplicated, the level lowered). The design text says whether the helper's other `None` causes (`current_exe` failing or not UTF-8) take the same line or stay as they are.

## Boundaries

`crates/chan-server/src/mcp_bridge.rs` and `src/lib.rs` at the bridge's bind, their tests, and the server's design document. Not changed: the descriptor's shape, the opt-in, the runtime directory's choice.

## Acceptance

1. The log line pinned red first, with its level.
2. The whole `chan-server` suite green at the commit in the owning guest.

## MCP socket warning 2026-10-16

The workspace builder warns once after an MCP bridge binds a socket whose path is not UTF-8, naming the real path with Debug escaping and the missing `CHAN_MCP_*` descriptor in opted-in terminals. The bridge stays bound. The library's descriptor helper and spawn arm are unchanged. The server design names the other two omission causes, failure to resolve the server executable and a non-UTF-8 executable path, which still emit no warning, as the lead ruled.

Acceptance 1 is covered by two isolated Linux cases in `control_socket_diagnostics_tests`: both build a workspace tenant, require a real kernel socket in their private directory, and check the path's encoding. Capture selects the event by message, then checks its level independently, its exact escaped path and consequence, one event for the non-UTF-8 bind and none for the UTF-8 control. Neither bind may emit a failed-bind diagnostic. The fixture uses the existing diagnostic socket-directory seam; it does not measure descriptor delivery to a spawned terminal or tool. The library source reading above establishes that consequence. The Linux gate follows the filesystem fixture's requirement; no macOS or Windows execution is claimed.

Against base `637c30345a19dedbd46a525b2ec2088586bbbe9d`, `cargo test -p chan-server --lib control_socket_diagnostics_tests::mcp_ -- --nocapture --test-threads=2` compiled and exited 101: the non-UTF-8 child failed at its warning count, 0 rather than 1, after proving the bind; the UTF-8 control passed. At the repair, omitted, unconditional, duplicated and INFO-level mutations each compiled and exited 101 at their intended count or level assertion. The restored pair passed, exit 0. The first mutation driver stopped with Python `ValueError: substring not found` because rustfmt changed the indentation its selector assumed; no mutation ran in that attempt, and its trap restored the source. The corrected selector completed all four mutations, with no survivor. The expected string's continuation indentation was then aligned; `diff -w` proves that final test-only edit changes whitespace alone. Formatting and diff checks passed afterwards.

Evidence is under `dev/v0107-team/evidence/Runtime107/mcpnon/`: `red-driver.log`, `green-driver.log/status` and `first-controls/` retain the initial red, repaired pair and driver failure; `mutants-driver.log/status` and `controls/` retain all four assertion failures, their patches and the restored pair; `export-driver.log/status` records the final whitespace proof. Every test runs as ubuntu in `chan-v0107-runtime` at 2 CPUs / 6 GiB, with two cargo jobs, two test threads and disk TMPDIR, under an in-guest timeout. `reports/environment-Runtime107.md` records the guest; cgroup snapshots record contention and no OOM. The driver itself passes stdout-success and stderr-exit-23 controls before the first test.

Acceptance 2 is covered at committed code sha `f1de4ebfe79abbc5f6307b8d2c4fe001a08dca70`: `cargo fmt --check`, `RUSTFLAGS=-Dwarnings cargo clippy -p chan-server --all-targets -- -D warnings` and `cargo test -p chan-server --all-targets -- --test-threads=2` each exited 0. The full suite passed 2,258 tests with no failure and one existing helper, `devserver::tests::emit_restore_note_in_child`, ignored by the ordinary harness because its parent probe runs it; the example target has no tests. The whole suite was bounded inside the guest at 5400 seconds. Start/end sha equality and clean source are recorded. Full logs and genuine statuses are in `gate-evidence/gate-*.log/status`, also in `gate-evidence.tar`; `gate-driver.status` is 0. The final amendment changes only this row and the commit message; `row-only.diff` and `final-sync.log/status` prove the unchanged code and synchronized clean guest. The host cgroup snapshots show 380 additional throttled periods and 170,269,041 additional throttled microseconds over this item's controls and gate, memory-max events rising by 413,059, a lifetime swap peak of 2,404,511,744 bytes and no OOM or OOM kill. These are contended correctness runs, not timing evidence.
