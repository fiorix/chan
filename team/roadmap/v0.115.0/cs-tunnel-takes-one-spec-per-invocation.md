# cs tunnel takes one spec per invocation

Status: accepted by the owner's word of 2026-10-28 (the section Owner ruling); not built.

## What was seen

The owner's words of 2026-10-28: "today im opening 2 terminals and running `cs tunnel <port>` on each; i'd like to `cs tunnel <spec> <spec>` as many as...? --tunnel-limit=5? but users could want... 1000s? thinking i use this for things like vnc, web servers, while others may want to test much larger systems".

A VNC port and a web server port from one devserver cost two terminals and two foreground commands, and anything that ends one of them (a closed tab, a killed shell) ends one forward and leaves the other up.

## Evidence

Read at `9117165d1`.

- The clap arm takes exactly one `SPEC` (`crates/chan-shell/src/cli.rs:464-473`), and `tunnel_rejects_bad_specs_and_protocols_at_parse_time` pins that `cs tunnel 8080:3000 8081:3001` is refused (`cli.rs:4081`). The long help's caveat says "One spec per invocation; run one `cs tunnel` per forwarded port" (`crates/chan-shell/src/help.rs:1797-1798`).
- The wire request carries one spec as three flat fields beside the proto and the window (`crates/chan-shell/src/wire.rs:171-195`); the server re-validates it, mints one unguessable id, registers one tunnel, sends one `tunnel_open` window command, and waits for that one listener's report under the 10 s ready window (`crates/chan-server/src/control_socket.rs:1049-1075`, `:4124-4284`). The connection's lifetime is the tunnel's, and the registration guard's drop is the one teardown path.
- The host's `TunnelRegistry` is unbounded by design, with an in-code TODO to cap live tunnels where a tunnel is admitted (`crates/chan-revtunnel/src/server.rs:11-28`); `register` takes one id and one spec (`server.rs:168-172`). The host builds the registry with no configuration in hand (`crates/chan-library/src/host.rs:1583`).
- Each live tunnel costs the desktop one listener and one control WebSocket pinged every 30 s (`crates/chan-revtunnel/src/client.rs:114`, `:29`), and the devserver one WebSocket; each forwarded connection adds one more WebSocket and two TCP sockets. Over the gateway every one of those is a yamux substream on the session the terminal's own WebSocket rides: the session admits 256 substreams and the devserver serves 128 concurrently (`crates/chan-tunnel-client/design.md:72`, `:80`). That session is the ceiling a number of tunnels meets first.
- A `cs tunnel` leases one program-status record on its terminal, whose ready text names one bound authority and one devserver port (`crates/chan-library/src/terminal_sessions/request_status.rs:78-84`); a session holds at most 16 request records (`crates/chan-library/src/terminal_sessions/program_status.rs:139`).
- The desktop opens one listener per trigger, keyed by tunnel id, and a replayed id replaces its listener (`desktop/src-tauri/src/revtunnel.rs:156-189`); the SPA forwards each `tunnel_open` frame as it arrives (`web/packages/workspace-app/src/state/store.svelte.ts:2211-2243`). Neither knows about the command that asked.
- A server-side policy number already has a home: `[transfer] stall_timeout_secs` in `server.toml`, captured when a tenant starts, zero selecting the default (`crates/chan-server/src/config.rs:38-68`), and set through `chan config set server.transfer.stall_timeout_secs` (`crates/chan/src/config.rs:231-234`).
- A control request line may be 48 MiB (`crates/chan-shell/src/wire.rs:63`); the largest expansion a range can produce, 65535 specs, is a few MiB.
- `parse_spec` is the one spec parser, with the last-two-colons rule and the lone-port shorthand (`crates/chan-revtunnel/src/spec.rs:126`).

## Owner ruling

Offered on 2026-10-28: A, the CLI opening one control connection per spec with no server change, the roster showing one tunnel record per spec; or B, one request carrying every spec, the server registering them as one group under one acknowledgement and one teardown, the desktop and the SPA unchanged because the per-tunnel trigger stays. Offered with it: no per-command limit flag, a cap at the registry's admission instead, default in the tens; all-or-nothing on a bind failure against ssh's warn-and-continue; and a range syntax as a later expansion of the spec grammar. The owner's words: "option B, with a max of 32 and spec range support like 8000-8010, and all-or-nothing".

## Desired contract

`cs tunnel SPEC...` takes one or more specs and opens every one of them as one group that lives exactly as long as the command.

The spec grammar is `[bind-address:]desktop:devserver`, or one side for both ends, where each side is a port or an inclusive range `first-last`:

- `3000` reads as `3000:3000`; `8000-8010` reads as `8000-8010:8000-8010`, eleven tunnels pairing each desktop port with the same devserver port.
- `8000-8010:3000-3010` pairs the ranges in order; the two ranges must have the same length, and a mismatch is refused naming both counts.
- `0:3000-3010` pairs an OS-picked desktop port with every devserver port in the range; a fixed desktop port cannot pair with a devserver range, since one authority cannot listen eleven times.
- A bind address applies to every tunnel the spec expands to. A reversed range (`8010-8000`) and an empty one are refused; a range whose devserver side includes 0 is refused as today's `ZeroDevserverPort`.
- Two specs that name the same desktop authority (same bind address and the same non-zero desktop port) are refused at the CLI edge, before any round-trip; the same devserver port in two specs is allowed. The server re-validates every spec and the duplicate rule, as it does today, because it does not trust clients.
- `--proto` stays one flag for the whole command.

One request carries the proto, the window, the calling session and the list of expanded specs. The server validates every spec, then admits the group under the host's live-tunnel cap in one registry operation, so two commands racing against the cap cannot interleave past it; a group that would exceed it is refused whole, naming the requested count, the live count and the cap. Admitted, the server mints one unguessable id per tunnel, sends one `tunnel_open` per tunnel to the window, and waits for every listener's report under the one 10 s ready window.

All-or-nothing: a `Failed` report from any listener, a ready timeout, or client EOF while waiting drops every registration of the group, which closes every control leg the desktop already attached, and the command exits non-zero naming the spec that failed. Once every listener is bound the server answers one acknowledgement naming every bound authority in spec order (a port-0 spec reads back as the port the desktop's OS picked); the CLI prints one line per tunnel on stderr, then the Ctrl-C hint. The group ends together: client EOF drops it quietly, and a desktop gone on any tunnel ends the command with the existing close reason. A command of one spec behaves exactly as today.

The cap is `[tunnel] max_live` in `server.toml`, set as `server.tunnel.max_live`, default 32, zero selecting the default, captured when a tenant starts as the transfer stall timeout is, and passed to the registry at admission; the registry itself holds no number. It counts the host's live tunnels across every tenant and every command, so a shell loop of single-spec commands meets the same cap as one many-spec command. There is no per-command flag: argument count is not the scarce resource, and a flag would not bound the loop.

The terminal's one program-status record names every tunnel of the group, as `desktop <bound> -> devserver 127.0.0.1:<port>` pairs separated by `; `, clipped to the status message bound; the ready, could-not-open and closed-by-the-desktop texts are unchanged.

Thousands of tunnels are outside this item: that needs one control leg per command instead of one per tunnel and a raised descriptor limit on the desktop, a wire change on the desktop legs, while the many-spec request this item adds is the unit such a leg would carry.

## Boundaries

- `crates/chan-revtunnel/src/spec.rs`: the range grammar and the expansion of one spec into its tunnels, the equal-length and fixed-desktop-port rules, the duplicate-authority check over a list; `parse_spec` keeps its rule for a single pair.
- `crates/chan-revtunnel/src/server.rs`: group admission under a caller-supplied cap in one lock, the refusal naming its counts, the unbounded-by-design note reduced to what stays unbounded (connections per tunnel, bytes).
- `crates/chan-shell/src/wire.rs` and `cli.rs`: the request's spec list, `SPEC...` with expansion and the duplicate refusal at the clap edge, the help in `help.rs`.
- `crates/chan-server/src/config.rs` and `lib.rs`: `[tunnel] max_live`, captured into the control-socket context; `control_socket.rs`: the group in `handle_tunnel`; `crates/chan/src/config.rs`: the key; `docs/config-reference.md`: its row.
- `crates/chan-library/src/terminal_sessions/request_status.rs`: the ready text over a group.
- `crates/chan/tests/revtunnel_e2e.rs`: the harness opens a request of many specs; the scenarios below.
- `crates/chan-revtunnel/design.md`, `design.md` (the reverse port forwarding paragraph), `crates/chan-server/design.md` (the control connection and reverse-tunnel legs rows).
- Not changed: the two WebSocket legs and their wire types, `chan_revtunnel::client`, `desktop/src-tauri/src/revtunnel.rs`, the SPA's `tunnel_open` forwarding, the owner-desktop gate, UDP's refusal.

## Acceptance

1. `cs tunnel 8080:3000 8081:3001` parses to two specs; `cs tunnel 8000-8010` expands to eleven with equal ends; `8000-8010:3000-3010` pairs in order; `0:3000-3010` pairs port 0 with each; `8000-8005:3000-3010`, `8010-8000`, `8000:3000-3010` and `0-10` are refused with the named reason; `[::1]:8000-8001` binds `::1` for both; pinned in `spec.rs` and `cli.rs`.
2. Two specs naming the same desktop authority are refused at the clap edge; `0:3000 0:3001` and `8080:3000 8081:3000` are accepted; pinned.
3. A request of two specs opens two listeners on the stand-in desktop, both forward bytes, one acknowledgement names both bound authorities in spec order, and dropping the connection closes both control legs and empties the registry; pinned in the e2e suite.
4. A request of two specs where the second listener cannot bind answers one error naming that spec, the first listener's control leg is closed, and the registry is empty; pinned in the e2e suite.
5. A request that would take the host past `max_live` is refused before any registration, naming the counts; a cap of 2 refuses a third single-spec command while two are live and admits it after one ends; pinned in the e2e suite with the key written to the test home's `server.toml`.
6. The program-status record of a session that opened two tunnels names both pairs; pinned.
7. `chan config get server.tunnel.max_live` reads 32 on a fresh home and `set` writes it; pinned beside the stall timeout's tests.
8. A single-spec command's wire request, acknowledgement text, status text and exit paths are unchanged; the existing e2e scenarios pass unmodified apart from the harness helper's signature.
9. The long help, the dump-skill rendering, the three design documents and the config reference describe the list, the ranges, the all-or-nothing rule and the cap; the "one spec per invocation" caveat is gone.
