# A terminal from before the socket directory moved cannot reach its server

Status: raised for v0.105.0 by the owner's word of 2026-10-09, from the v0.101.0 release report's known gaps; written down, not designed, not accepted for build.

## What was seen

The [v0.101.0 report](../../release/release-v0.101.0.md) ends its Known gaps with three things "Open by design, each stated in its item", the third of them: "where the sockets moved, a server restart and a new terminal are needed". The item is [the-control-sockets-directory-is-believed-as-found](../done/the-control-sockets-directory-is-believed-as-found.md), whose "What an upgrade costs" reads: "Where `XDG_RUNTIME_DIR` is unset, as on macOS by default, the sockets move from `/tmp` to `/tmp/chan-control-<uid>`, so a running server must be restarted and a terminal started by the earlier build cannot reach it with `cs`: a new terminal is needed." Its "What shipped" gives the ruling: "the cost of the move where `XDG_RUNTIME_DIR` is unset is accepted, with no remap of an earlier terminal's socket", one of the lead's rulings of 2026-10-02 "made under the owner's standing word and left for the owner's review". The changelog's v0.101.0 section tells users the same: "The move from a direct `/tmp` socket when `$XDG_RUNTIME_DIR` is unset requires a server restart and a new terminal; a terminal from an earlier build cannot find the moved socket" (`CHANGELOG.md`, the entry "Control sockets use an owner-only directory"). The first two things of that Known gaps line are [another-local-user-can-take-the-fallback-control-socket-directory-first](another-local-user-can-take-the-fallback-control-socket-directory-first.md).

This is a cost at one version boundary and not an exposure to another user. It falls on a machine with no usable `XDG_RUNTIME_DIR` whose server and terminals were started by a build older than v0.101.0 and are still running when a newer build is installed. In the released tree `af2af8ac0`, `cs` still validates the socket's directory before a connect and before its search for a moved tenant (`crates/chan-shell/src/control.rs`: `validate_socket_path` at line 342 and `find_moved_server` at line 95, each calling `validate_control_socket_dir`), so by that rule a terminal whose `$CHAN_CONTROL_SOCKET` names a socket directly in `/tmp` would be refused; that is a reading of the source, not a run.

Not established: whether anyone met the cost. The closed item lists "a native macOS run with its socket path length budget and its moved directory" among what was "Not run on any machine", and no report of v0.102.0, v0.103.0 or v0.104.0 mentions the move. Whether the owner reviewed the ruling: no record read for this item shows it. What `cs` prints in such a terminal today: the closed item says its refusals name the directory, and this case was not run. How many installs are still older than v0.101.0: four versions carry the move, v0.101.0 of 2026-10-02 through v0.104.0 of 2026-10-09, and nothing in the record counts the installs behind them.

## Desired contract

The item asks the owner for a decision and builds nothing until it is given: confirm the cost as accepted and closed, with the changelog's sentence as its notice; or have `cs`, in a terminal that names a socket directly in `/tmp`, say that the server moved its sockets and that a new terminal is needed; or bridge the old terminals, the "remap" that the ruling declined.

## What to do

Reproduce the case once, so that the decision has a picture: on a machine or a guest with `XDG_RUNTIME_DIR` unset, start a server and a terminal with a build older than v0.101.0, install the current build, restart the server, and record what `cs` prints in the old terminal and whether the terminal's session survives the restart at all. Put the three choices to the owner with that record. If the owner confirms the cost, close the item with the owner's words and no code.

## Boundaries

`crates/chan-shell/src/control.rs` and its tests if a message is chosen; nothing else. The owner rule is not weakened: no connect in a directory that fails it, and no socket bound in `/tmp` itself again. Whether the sockets move a second time is the sibling item's decision and not this one's.

## Acceptance

1. The reproduction is recorded with the two builds' versions, the platform and `cs`'s exact words in the old terminal; or a statement that an older build could not be run, with what was tried.
2. The owner's decision is recorded in this item in the owner's words, with its date.
3. If a message is chosen: `cs` in a terminal whose socket path lies directly in `/tmp` prints it, pinned red first; and a socket in a validated directory is unaffected, pinned.
4. If a bridge is chosen: its design is reviewed against the owner rule before any code.
5. If the cost is confirmed: the item closes as withdrawn, with no code, and says so.
