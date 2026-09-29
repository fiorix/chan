# The control socket's identity and a terminal's environment name no library, so `cs` can reach another devserver's tenant

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-28 by the lead, from the plan of the order on `cs` in a moved terminal (`dev/v0101-team/followups/followup-Services-Lead-18.md` in the development tree, its leaning 5), which the lead ruled no part of that order and to be raised at its landing as an item of its own (`dev/v0101-team/followups/followup-Lead-Services-25.md`, approved 4). Read at `d440ab656`; not run.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0: its fix adds a field to the wire and a variable to a terminal's environment, and the devserver that `cs` reaches in its case is the same user's own. The case of another user is [the-control-sockets-directory-is-believed-as-found](../v0.101.0/the-control-sockets-directory-is-believed-as-found.md), which the owner accepted for v0.101.0 the same day. When it was raised the lead recommended accepting this item for v0.101.0, plan first. It is not part of v0.101.0.

## What was seen

- **A devserver's stable socket is named for its library and its prefix.** Each tenant of a devserver binds its control socket at a name that hashes the devserver's library id with the tenant's prefix (`stable_socket_path` and `stable_socket_name`, `crates/chan-server/src/control_socket.rs:365-400`; the identity installed from the library id, `crates/chan-server/src/devserver.rs:2270-2276`), in the directory every chan server of the user binds in (`unix_socket_dir`, `crates/chan-server/src/mcp_bridge.rs:63-73`).
- **Neither the identity a tenant answers nor a terminal's environment names the library.** The identity holds the server's kind, version and pid, and a workspace tenant's root and metadata key (`Identity`, `crates/chan-shell/src/wire.rs:1767-1782`; the handler, `control_socket.rs:1664-1695`). A spawn's environment names the control socket and the workspace's path, and no library (`crates/chan-library/src/terminal_sessions.rs:4137-4187`).
- **So `cs` believes any devserver's tenant of the terminal's root.** When a terminal's stable socket is gone, `cs` takes the one devserver tenant beside it whose root is the canonical path of the terminal's workspace, whichever devserver it belongs to (`find_moved_server`, `crates/chan-shell/src/control.rs:95-130`). A second devserver of the same user, under another chan home with its sockets in the same directory, serving the same root while the terminal's own devserver serves nothing there, is reached, and so is one serving `$HOME` as a workspace, for a shared-terminal shell whose `$CHAN_WORKSPACE_PATH` is `$HOME` (`crates/chan-shell/design.md:129`, among its costs). The request stays with a server of the same user, and reaches another library's windows and sessions.

What an id would cost and what it cannot do, by the plan's reading at `34d13281e`, not run: an optional field of the identity costs nothing on the wire, since the identity's decoder does not refuse a field it does not know, so an older `cs` ignores it and an older server omits it (the derive at `wire.rs:1773`, with no attribute that refuses one); and it cannot help a terminal spawned before the id was in its environment, as every terminal that the first restart under v0.101.0 moves, since the gone socket's name cannot be checked against an id without the old prefix, which the environment does not carry.

## Desired contract

`cs` in a terminal whose socket is gone reaches only a tenant of the library that spawned the terminal, when the terminal's environment names that library; a terminal whose environment names none, and a server that answers none, keep the rule by root.

## What to do

A suggestion from the record: the identity a devserver's tenant answers gains an optional library id, each spawn's environment gains a variable that names it, and the search keeps a candidate only when both name the same library, falling back to the rule by root when either names none. Settle in the plan the variable's name, whether a desktop or a `chan serve` socket answers an id at all, and what `chan ps` shows of it. Red first: a second devserver's tenant of the same root, beside a gone socket, is refused when the environment names another library; today it is reached.

## Boundaries

`crates/chan-shell/src/wire.rs` (`Identity`), `crates/chan-server/src/control_socket.rs` (the `Identify` handler), `crates/chan-library/src/terminal_sessions.rs` (the spawn's environment) and the path by which the id reaches it, `crates/chan-shell/src/control.rs` (the search), their tests, `cs`'s help for the environment contract, and the design documents that describe the identity and the environment.

## Acceptance

1. A candidate of another library is refused when the terminal's environment names a library, pinned red first.
2. A terminal whose environment names no library, and a server that answers no id, keep the rule by root, pinned.
3. `cs`'s help and the design documents name the variable and the rule.
