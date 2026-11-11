# Metrics

The Dashboard's first page shows the serving chan process: hostname, version, build hash, PID, uptime, CPU, resident memory, I/O, chan-home storage, service traffic, tunnels, transfers, and HTTP/2 and yamux channels. The graphs use the window's focus-border colour, including the neutral grey preset that works in light and dark mode. Standalone windows have Metrics and About; workspace windows also have Workspace and Search. The carousel rotates every five seconds by default; hovering, focus, or its play/pause button pauses it. The Dashboard carousel setting controls autoplay and shares its state with the carousel's play/pause button. With privacy mode on, the page conceals the hostname, the chan-home path and storage scan errors that may name files, each behind its own reveal button; `chan metrics` and `/api/metrics` are not affected, since privacy mode is a setting of the viewing client.

## Collection

One runtime at the outer server router owns collection. A dedicated worker samples once per second and retains the latest 600 aggregate samples in memory, including while no dashboard is open. Requests copy that cache and never wait for collection. Another worker scans `CHAN_HOME` (default `~/.chan`) only while someone reads, since a scan stats every entry of the home: there is no scan at startup, the first `/api/metrics` read starts one, scans repeat once per minute after the previous one completes while reads keep arriving, and the worker rests after five minutes with no read. A read after that starts a scan again. Until a new scan completes, storage shows the last completed total with its timestamp, or pending before the first, never zero. Scans never overlap or block process sampling. Dropping the runtime signals both workers to stop; an OS filesystem call already in progress can finish later.

CPU uses cumulative CPU time and monotonic sample intervals; 100% is one logical core. Memory is resident memory of the server process. Child shells, subprocesses, and desktop WebViews are excluded. Linux and macOS I/O counters report storage I/O; Windows reports all process I/O and labels the scope accordingly. FreeBSD process I/O bytes and rates are null with `ioScope: "unavailable"`: sysinfo exposes block-operation counts there, which cannot be converted to bytes without operation sizes. Initial rates are unavailable until two observations exist. Instance identity and sequence numbers let clients distinguish a restart from a counter decrease.

Storage totals describe regular files below the resolved chan home, without following descendant symlinks or reading their content. Logical bytes and, on Unix, allocated file bytes are separate. Unix hard links count once. Entries this user cannot read, and entries removed while a scan runs, are skipped and not counted, at any depth; a chan home that cannot be read itself fails the scan. The last complete total and its timestamp survive a failed refresh; pending or failed collection is not presented as zero. Scans are bounded by elapsed time, entry count and depth; the elapsed bound is checked between filesystem calls and cannot interrupt a blocked kernel call.

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

Without `--url`, the command reads the devserver bearer belonging to `CHAN_HOME` and connects to the address the devserver's launchd plist on macOS or systemd unit elsewhere pins with `--bind` and `--port`, else to the persisted port on IPv4 loopback; a wildcard bind is reached on loopback. The persisted port outlives the devserver, so another user on the host could listen there while it is stopped. On Linux the command therefore sends the bearer only when every socket listening on that address belongs to the caller's user, read from `/proc/net/tcp` and `/proc/net/tcp6`, and refuses otherwise, including when nothing listens there. The unit file also outlives a stopped unit, and a devserver started afterwards with `chan devserver run` listens on the port it records, not the pinned one. So when the pinned address has no listener of the caller's, Linux tries the persisted port on IPv4 loopback under the same check, and refuses only when neither address passes it. The check runs just before the connection, so another listener can slip in only if this user's own devserver stops in that instant. macOS, FreeBSD and Windows name socket owners only through binary sysctl records or per-process handle walks, none of them a small and sound check, so there the bearer goes to the port unverified.

`--url` takes a server URL as chan prints it. A launcher or unprefixed `chan serve` URL (`http://HOST:PORT/?t=TOKEN`) reads the server root's `/api/metrics`; a tenant URL, as `chan serve --prefix` and the desktop print it (`http://HOST:PORT/PREFIX/index.html?t=TOKEN`) or as the prefix alone, reads that tenant's `/PREFIX/api/metrics`. A URL that already ends in `/api/metrics` is read as given. An explicit URL is read with `--token`, else `CHAN_METRICS_TOKEN`, else the URL's launch token; it never inherits the local devserver's bearer. `CHAN_METRICS_TOKEN` applies only beside `--url`: without it the variable is ignored, so exporting it changes nothing for a local read or the systemd-report source, while `--token` without `--url` is refused. The CLI describes the target server, not the short-lived CLI process.

`--watch` streams the way systemd's subscribe-style methods do: the first output is the complete view (with `--history`, every retained sample), and each later one, about once per second, carries only the samples newer than the last one sent, with `latest` the newest; nothing is sent while nothing is newer. When `identity.instanceId` differs between two successful reads, the server restarted and its sequences with it, so that output is complete again. A failed read ends the stream: `--watch` exits with the error, so a stream outlives a restart only when the server answers again by the next read, about a second later. `--watch --json` emits one JSON object per line.

Authenticated `GET /api/metrics` is available on the launcher root and tenant routes. `?history=true` includes bounded history; `&since=N` selects sequences greater than N. `latest` is null before the first observation. Readers must discard old history when `identity.instanceId` changes. A sequence gap indicates samples no longer retained or observations that were not delivered.

`schemaVersion` identifies the response contract, and a reader checks it before it reads anything else. A reader that meets a version it does not know does not interpret the rest of the response: `chan metrics` exits with `unsupported metrics schema N`, and the systemd-report source answers `io.systemd.Metrics.NoSuchMetric` and writes that line to its journal. Within one version fields are only added. A reader ignores a field it does not know, and takes every field added after the version first shipped as optional, since a server of an earlier release does not send it. Renaming or removing a field, or changing its type or unit, takes a new version.

## systemd-report

`systemd-report`, in systemd 260 and later, collects metrics from a machine's services through systemd's metrics interface, `io.systemd.Metrics`. `chan metrics --varlink` makes the devserver one of its user sources: systemd starts it for each connection to a socket named `io.chan.Devserver` in `$XDG_RUNTIME_DIR/systemd/report/`, the directory `systemd-report --user` reads, and it serves `List`, `Describe` and the standard `org.varlink.service` introspection on that connection, under systemd's own description of the interface. It owns no sampler or history.

`List`, which systemd-report calls with `more` set, reads the running devserver once, without history, and sends one reply per metric, every reply but the last marked `continues`. It finds the devserver's address and token afresh on every call, as `chan metrics` does without `--url`, so it follows a restart and a rotated token, and it never starts the devserver. When the devserver cannot be read, or answers with a `schemaVersion` this build does not know, `List` answers `io.systemd.Metrics.NoSuchMetric`, which systemd-report reads as a source with nothing to report, and the source writes one line to stderr, the unit's journal, saying why. A reading that is null is not sent: before the first sample, without process readings, for I/O the platform cannot count, and for a chan-home scan that is pending or failed before its first total. `Describe` sends every family from the same table `List` reads and needs no devserver. Both answer `org.varlink.service.ExpectedMore` when called without `more`, and `org.varlink.service.InvalidParameter` for any parameter.

A report is a snapshot, so the families are counters and gauges, not rates: two reports give a rate, and `chan metrics --json --history` has chan's own rates and the last ten minutes. Counters start over when the devserver restarts, and `InstanceId` changes with it. Sequence numbers, sample timing, the hostname (systemd-report reports the machine's), the chan-home path and the scan error are left out. Each family is `io.chan.Devserver.` followed by its name; values are JSON integers, except in the three string families:

- `Version`, `Build`, `InstanceId` (string): `identity.version`, `.build` and `.instanceId`. `InstanceId` changes on every restart, when every counter starts over.
- `PID` (gauge): `identity.pid`.
- `UptimeSec` (counter): `process.uptimeSeconds`.
- `CPUUsageNSec` (counter): `process.cpuTimeMs` in nanoseconds, times 1,000,000.
- `MemoryResidentBytes` (gauge): `process.residentBytes`.
- `IOReadBytes`, `IOWriteBytes` (counter, field `scope`): `process.readBytes` and `.writtenBytes`. `scope` is `storage` where `ioScope` is `storage_io` (Linux, macOS) and `process` where it is `process_io` (Windows); where it is `unavailable` (FreeBSD) the two are not sent.
- `TrafficReceivedBytes`, `TrafficSentBytes`, `TrafficOpened` (counter) and `TrafficActive` (gauge), field `layer`: one metric per traffic layer, `network`, `http2`, `yamux`, `reverseConnections` and `transferPayload`, from that layer's `receivedBytes`, `sentBytes`, `opened` and `active`. The layers overlap and must not be summed.
- `TransfersQueued`, `TransfersRunning`, `TransfersWorkerCapacity`, `TransfersQueueCapacity` (gauge): `transfers.queued`, `.running`, `.workerCapacity` and `.queueCapacity`.
- `TransferJobs` (counter, field `outcome`): one metric per outcome, `finished`, `cancelled`, `stalled`, `panicked` and `refused`, from the `transfers` total of that name.
- `GatewayTunnels`, `ReverseListeners`, `YamuxWaiting`, `YamuxServing`, `YamuxServiceCapacity`, `YamuxStreamLimit` (gauge) and `TunnelDialFailures` (counter): the sample's `gatewayTunnels`, `reverseListeners`, `yamuxWaiting`, `yamuxServing`, `yamuxServiceCapacity`, `yamuxStreamLimit` and `tunnelDialFailures`.
- `HomeLogicalBytes`, `HomeAllocatedBytes`, `HomeFiles` (gauge): `storage.logicalBytes`, `.allocatedBytes` and `.files`, the totals of the last completed scan, which a failed refresh keeps.

Example user units are in [systemd/chan-metrics.socket](systemd/chan-metrics.socket) and [systemd/chan-metrics@.service](systemd/chan-metrics@.service), and the manual's [systemd integration](https://chan.app/manual/systemd/#systemd-report) page has a block that writes them. Install them in `~/.config/systemd/user/`, set `ExecStart` to your installed chan binary, and set the same `CHAN_HOME` as the devserver if it uses a non-default home. The socket is private to the user, and each connected client has one activated process, capped at 16 connections. A connection carries any number of calls; one whose client sends no call for 60 seconds, or does not read a reply within 10 seconds, is closed. That ends its process with status 0, as the client's own close does; a frame that breaks the protocol ends it with an error.

```sh
systemctl --user daemon-reload
systemctl --user enable --now chan-metrics.socket
/usr/lib/systemd/systemd-report --user list-sources
/usr/lib/systemd/systemd-report --user describe io.chan.Devserver
/usr/lib/systemd/systemd-report --user metrics io.chan.Devserver
varlinkctl introspect "$XDG_RUNTIME_DIR/systemd/report/io.chan.Devserver" io.systemd.Metrics
varlinkctl --more call "$XDG_RUNTIME_DIR/systemd/report/io.chan.Devserver" io.systemd.Metrics.List '{}'
```

systemd installs `systemd-report` in `/usr/lib/systemd/`, outside `PATH`, and systemd 260 names its `describe` command `describe-metrics`. The units do not restart, stop, or socket-activate the devserver itself. Disable the source with `systemctl --user disable --now chan-metrics.socket`.

## Platform differences

OS process readings come from `sysinfo`; service traffic, tunnel/channel activity, and transfer counters come from chan itself. Network totals cover chan transports, not all host interfaces. The systemd socket-activation example is Linux-specific.

| Reading | macOS | Linux | FreeBSD | Windows |
| --- | --- | --- | --- | --- |
| Hostname, PID, uptime, CPU, resident memory | sysinfo | sysinfo | sysinfo | sysinfo |
| Process I/O bytes | Storage I/O | Storage I/O | Unavailable | All process I/O |
| CHAN_HOME logical size and file count | Yes | Yes | Yes | Yes |
| CHAN_HOME allocated size | Yes | Yes | Yes | Unavailable |
| Hard-link deduplication during storage scan | Yes | Yes | Yes | No |
| Chan transport and activity counters | Same counters | Same counters | Same counters | Same counters |
