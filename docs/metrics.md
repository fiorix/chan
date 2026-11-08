# Metrics

The Dashboard's first page shows the serving chan process: hostname, version, build hash, PID, uptime, CPU, resident memory, I/O, chan-home storage, service traffic, tunnels, transfers, and HTTP/2 and yamux channels. The graphs use the window's focus-border colour, including the neutral grey preset that works in light and dark mode. Standalone windows have Metrics and About; workspace windows also have Workspace and Search. The carousel rotates every five seconds by default; hovering, focus, or its play/pause button pauses it. The Dashboard carousel setting controls autoplay and shares its state with the carousel's play/pause button.

## Collection

One runtime at the outer server router owns continuous collection. A dedicated worker samples once per second and retains the latest 600 aggregate samples in memory, including while no dashboard is open. Requests copy that cache and never trigger collection. Another worker scans `CHAN_HOME` (default `~/.chan`) once per minute after the previous scan completes; it never overlaps scans or blocks process sampling. Dropping the runtime signals both workers to stop; an OS filesystem call already in progress can finish later.

CPU uses cumulative CPU time and monotonic sample intervals; 100% is one logical core. Memory is resident memory of the server process. Child shells, subprocesses, and desktop WebViews are excluded. Linux and macOS I/O counters report storage I/O; Windows reports all process I/O and labels the scope accordingly. Initial rates are unavailable until two observations exist. Instance identity and sequence numbers let clients distinguish a restart from a counter decrease.

Storage totals describe regular files below the resolved chan home, without following descendant symlinks or reading their content. Logical bytes and, on Unix, allocated file bytes are separate. Unix hard links count once. The last complete total and its timestamp survive a failed refresh; pending or failed collection is not presented as zero. Scans are bounded by elapsed time, entry count and depth; the elapsed bound is checked between filesystem calls and cannot interrupt a blocked kernel call.

Network counts successful userspace reads and writes at chan's local serving sockets, gateway TCP/connector transport, and reverse-forward sockets. It includes upgraded WebSockets. It is service transport accounting, not a host-interface total, packet capture, or a count of arbitrary networking by child processes. Gateway connector bytes are measured at the connector boundary; WireGuard encryption overhead is outside that measurement.

HTTP/2 and yamux counters describe payloads at their respective layers; their bytes overlap and must not be summed. Active yamux streams include upgraded connections, while serving counts describe handlers holding the admission permit; waiting counts describe streams waiting for that permit. Counts do not imply exact flow-control window utilisation. Reverse listeners count ready registrations; reverse connections count the TCP byte pumps.

Transfer occupancy is recorded at bulk-lane admission and worker transitions. Finished counts jobs that returned without cancellation or panic, including jobs returning application errors; it is not a count of files successfully delivered. Cancelled, stalled, panicked and refused jobs have separate totals. Transfer payload counts uploaded file chunks accepted from multipart input and downloaded bytes yielded to response bodies; it excludes HTTP/multipart framing and does not imply durable storage or remote acknowledgement.

## CLI and HTTP

```sh
chan metrics
chan metrics --json
chan metrics --json --history
chan metrics --watch
chan metrics --json --watch
chan metrics --url 'http://127.0.0.1:8787/workspace?t=TOKEN'
```

Without `--url`, the command reads the devserver port and bearer belonging to `CHAN_HOME` and connects over IPv4 loopback. Use `--url` for a server bound only to another address. An explicit URL uses its launch token or `--token` / `CHAN_METRICS_TOKEN`; it never inherits the local devserver's bearer. `--watch --json` emits one JSON object per line. The CLI describes the target server, not the short-lived CLI process.

Authenticated `GET /api/metrics` is available on the launcher root and tenant routes. `?history=true` includes bounded history; `&since=N` selects sequences greater than N. `latest` is null before the first observation. Readers must discard old history when `identity.instanceId` changes. A sequence gap indicates samples no longer retained or observations that were not delivered. `schemaVersion` identifies the response contract.

## Linux Varlink

The optional socket-activated adapter runs `chan metrics --varlink` with a connected Unix socket on stdin/stdout. It reads the running devserver and owns no sampler or history. If that server is down, `io.chan.Metrics.Get` returns `io.chan.Metrics.Unavailable`; a metrics query does not start the devserver. The adapter re-resolves the server address and token on every read, including after a restart or token rotation. The interface supports standard service introspection and streaming calls with `more=true`.

Example user units are in [systemd/chan-metrics.socket](systemd/chan-metrics.socket) and [systemd/chan-metrics@.service](systemd/chan-metrics@.service). Install them in `~/.config/systemd/user/`, set `ExecStart` to your installed chan binary, and set the same `CHAN_HOME` as the devserver if it uses a non-default home. The socket is private to the user, and each connected client has one activated process, capped at 16 connections. Idle connections and stalled writes time out.

```sh
systemctl --user daemon-reload
systemctl --user enable --now chan-metrics.socket
varlinkctl info "$XDG_RUNTIME_DIR/chan-metrics/io.chan.Metrics"
varlinkctl introspect "$XDG_RUNTIME_DIR/chan-metrics/io.chan.Metrics" io.chan.Metrics
varlinkctl call "$XDG_RUNTIME_DIR/chan-metrics/io.chan.Metrics" io.chan.Metrics.Get '{}'
varlinkctl --more call "$XDG_RUNTIME_DIR/chan-metrics/io.chan.Metrics" io.chan.Metrics.Get '{}'
```

The units do not restart, stop, or socket-activate the devserver itself. Disable the optional interface with `systemctl --user disable --now chan-metrics.socket`.
