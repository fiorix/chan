# The control socket's directory is believed as found, by the server that binds in it and by every client

Status: accepted for v0.101.0 by the owner on 2026-09-29; raised for a decision on 2026-09-28 by the lead, from the independent review of a range that is not landed, `cs` in a terminal that a restart moved (`dev/v0101-team/reviews/review-Services-16.md` in the development tree, its first finding and the lead's notes at its end). Read at `a6834b1ee`, where no file of `crates/` differs from `main`; not run. Older than this round.

## Owner ruling

Accepted on 2026-09-29 for v0.101.0, plan first. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. This item enters as a weakness of security: on a machine with other local users, one of them can answer as the devserver and receive what `cs` sends, a terminal's input, a clipboard's payload and paths, and `/tmp` is the socket directory by default on macOS. Its fix moves where the sockets live, so the rule alone did not decide it, and the owner accepted it by name. The shape, as ruled: the owner check on both sides, the server's bind and the clients' connect, by the rule that the handoff's sockets have, with a per-user fallback directory that only its owner can use where `XDG_RUNTIME_DIR` is unset or fails the rule, as the handoff's sockets have one, so that a devserver on a default macOS setup still starts. A plan comes before the build. By the same answer [the-control-socket-identity-names-no-library](../v0.102.0/the-control-socket-identity-names-no-library.md) goes to v0.102.0.

## What was seen

- **The server takes its socket directory from the environment and checks nothing of it.** The directory is `XDG_RUNTIME_DIR` as it is set, or `/tmp` (`xdg_runtime_dir` and `unix_socket_dir`, `crates/chan-server/src/mcp_bridge.rs:63-73`), and a control socket's stable path is a name joined to it (`stable_socket_path`, `crates/chan-server/src/control_socket.rs:373-378`). Neither function reads the directory's owner or its mode.
- **The handoff's sockets do check.** The handoff's directory must be a directory and no link, owned by the effective user, with the mode 0700 (`owner_dir_metadata`, `crates/chan-server/src/handoff.rs:505-514`, the mode at `:500`), and the devserver's discovery directory is refused in the same words when it is not (`ensure_unix_discovery_dir`, `crates/chan-server/src/devserver_handoff.rs:238-250`).
- **No client of the control socket reads the directory either.** A search of `crates/chan-shell/src` at the tip for a read of a user id, a mode or a link's metadata finds none; `cs` connects to the path that `CHAN_CONTROL_SOCKET` names.

So where the runtime directory is one that another user can replace, as one kept under `/tmp` that has gone away, that user can bind a socket at the path a terminal's environment names and receives what `cs` sends there: the text of a `cs terminal write`, a clipboard's payload, a path. Under a runtime directory that only root can create, as systemd makes `/run/user/<uid>`, nobody but its owner and root can. Inferred from the code read and from what a directory's owner may do; the review walked it and nothing was run. The socket's name holds 64 bits of a hash and is no secret: the path of a bound socket can be read by every user of a Linux machine while its server runs, by the review's knowledge of `/proc/net/unix`.

**Read again on 2026-09-28 at `d440ab656`,** where the range that the review read has landed with its fix round ([a-relinked-root-window-nests-outside-its-row](a-relinked-root-window-nests-outside-its-row.md), `cs` in a moved terminal). The third bullet above no longer holds as written: `cs` still connects first to the path that `$CHAN_CONTROL_SOCKET` names and reads nothing of its directory for that connect (`crates/chan-shell/src/control.rs:58-62`), but when that socket is gone it may search the socket's directory, and the search reads the directory's mode, through a link, and not its owner (`only_owner_writes`, `control.rs:155-165`), by the lead's ruling, the owner's to overrule. The server's side is as above. So the case this item describes no longer needs the socket's name: where the runtime directory has gone away and another user puts a directory of their own at its path, with neither the group's nor the world's write bit, a socket of the stable shape bound there under any name answers `cs` in a terminal whose socket is gone, as a devserver serving that terminal's workspace, which that user has to name by its canonical path (`control.rs:95-130`; `crates/chan-shell/design.md:129`, the first of its costs; the review, F1). And the search believes a directory that another user owns: a root devserver or shell that inherited another user's runtime directory searches that directory, and after a move that user no longer has to replace a live socket to answer, since the gone name is free (`design.md:129`). A client that connects only in a directory that is the effective user's own, as this item's contract asks, refuses both.

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
