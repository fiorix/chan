# The control socket's directory is believed as found, by the server that binds in it and by every client

Status: raised for a decision on 2026-09-28 by the lead, from the independent review of a range that is not landed, `cs` in a terminal that a restart moved (`dev/v0101-team/reviews/review-Services-16.md` in the development tree, its first finding and the lead's notes at its end). Read at `a6834b1ee`, where no file of `crates/` differs from `main`; not run. Older than this round. Recommendation, the lead's: accept for v0.101.0 as a small order, plan first: the devserver and the control socket's clients refuse a socket directory that is not the effective user's own, by the rule that the handoff's sockets have.

## What was seen

- **The server takes its socket directory from the environment and checks nothing of it.** The directory is `XDG_RUNTIME_DIR` as it is set, or `/tmp` (`xdg_runtime_dir` and `unix_socket_dir`, `crates/chan-server/src/mcp_bridge.rs:63-73`), and a control socket's stable path is a name joined to it (`stable_socket_path`, `crates/chan-server/src/control_socket.rs:373-378`). Neither function reads the directory's owner or its mode.
- **The handoff's sockets do check.** The handoff's directory must be a directory and no link, owned by the effective user, with the mode 0700 (`owner_dir_metadata`, `crates/chan-server/src/handoff.rs:505-514`, the mode at `:500`), and the devserver's discovery directory is refused in the same words when it is not (`ensure_unix_discovery_dir`, `crates/chan-server/src/devserver_handoff.rs:238-250`).
- **No client of the control socket reads the directory either.** A search of `crates/chan-shell/src` at the tip for a read of a user id, a mode or a link's metadata finds none; `cs` connects to the path that `CHAN_CONTROL_SOCKET` names.

So where the runtime directory is one that another user can replace, as one kept under `/tmp` that has gone away, that user can bind a socket at the path a terminal's environment names and receives what `cs` sends there: the text of a `cs terminal write`, a clipboard's payload, a path. Under a runtime directory that only root can create, as systemd makes `/run/user/<uid>`, nobody but its owner and root can. Inferred from the code read and from what a directory's owner may do; the review walked it and nothing was run. The socket's name holds 64 bits of a hash and is no secret: the path of a bound socket can be read by every user of a Linux machine while its server runs, by the review's knowledge of `/proc/net/unix`.

## Desired contract

The devserver binds its control sockets only in a directory that is the effective user's own and that no other user can write, and says why when it refuses; a client of the control socket connects only in such a directory.

## What to do

A suggestion beyond the record: give the control socket's directory the rule of `owner_dir_metadata`, in one function that the server's bind and the clients' connect both call. chan-shell reads no user id today and would gain the dependency that chan-server reads it with, which the lock file holds already. Settle in the plan what a devserver does at its start in a directory that fails the rule (refuse to start, or fall back to a directory of its own under the user's home), and what `cs` prints. Red first: a bind in a directory owned by another user is refused; a connect of `cs` to a path in such a directory is refused in words that name the directory.

## Boundaries

`crates/chan-server/src/mcp_bridge.rs`, `crates/chan-server/src/control_socket.rs` (the bind), `crates/chan-shell/src` (the connect by the environment's path), one manifest line, their tests, `crates/chan-server/design.md` and `crates/chan-shell/design.md`. The handoff's sockets are unchanged. Windows' named pipes are not in scope.

## Acceptance

1. The devserver refuses to bind a control socket in a directory that is not the effective user's own or that another user can write, pinned red first.
2. `cs` refuses to connect in such a directory and says so, pinned red first.
3. A runtime directory as systemd makes it passes both, pinned.
4. The design documents say the rule and what each side does when it fails.
