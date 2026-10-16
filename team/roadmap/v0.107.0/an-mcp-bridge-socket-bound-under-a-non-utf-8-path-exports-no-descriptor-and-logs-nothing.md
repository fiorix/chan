# An MCP bridge socket bound under a non-UTF-8 path exports no descriptor and logs nothing

Status: raised on 2026-10-16 by the lead from the review seat's read of the control socket item's design and the runtime seat's source reading; written down with its repair's shape, that item's; built by the runtime seat after the control socket item; owner the runtime seat.

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
