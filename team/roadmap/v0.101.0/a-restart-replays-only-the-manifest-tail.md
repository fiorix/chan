# A restart replays only the manifest's 128 KiB tail, so a fresh view reports missed bytes

Status: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-24. From the terminal replay lane's restart e2e at `918f03694` on `v0101/terminal-replay`. The reproducer is `scripts/e2e/devserver-terminal-replay.sh` with `scripts/e2e/terminal-replay-client.mjs`, which land with that lane; it ran in a Linux container as root against the `chan-devserver` user unit, and the runs' logs are `dev/v0101-tasks/evidence/term/e2e-replay-918f03694.log` (restarts `cli crash`) and `dev/v0101-tasks/evidence/term/e2e-replay-cli-cli-918f03694.log` (restarts `cli cli`) in the development tree. Reproduced at that sha in every restart of both runs; the owner confirmed on 2026-09-24 that `terminal replay missed N bytes` is the line seen, and ruled that the terminal replay lane hands it off rather than fix it. Which tabs the SPA reattaches with `since=0` after the reload is read from the SPA code, not observed in a browser.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, which settles the shape: the whole ring crosses a restart as a memfd-backed ring parked in the fd store beside the session's PTY master, the option the terminal replay lane named, because it answers this item and [a-crash-restart-restores-a-stale-manifest](a-crash-restart-restores-a-stale-manifest.md) exactly. Both items run in one terminal restore lane, which raises `FileDescriptorStoreMax` to cover two stored fds per session and measures the cost. [terminal-env-overrides-are-silently-dropped](terminal-env-overrides-are-silently-dropped.md) rides the same lane, because it edits the same file.

## What was seen

The live terminal ring holds 2 MiB (`default_terminal_ring_bytes` in `crates/chan-library/src/config.rs`), but the restart manifest carries 128 KiB per session (`FDSTORE_REPLAY_BYTES` in `crates/chan-library/src/terminal_sessions.rs`), and `from_imported` rebuilds the ring from that tail. After any restart the ring starts at `seq` minus 128 KiB, not `seq` minus 2 MiB.

On a graceful restart the server sends `closed{shutdown}` to every attached socket, the SPA reloads the window when it sees the new process, and every terminal reattaches as a fresh view. A fresh view with no matching cached snapshot sends `since=0` (the ghostty backend always does; xterm does when the snapshot's geometry differs). For a session with more than 128 KiB of output that attach gets `missed_bytes` equal to `seq` minus 128 KiB, and `TerminalTab.svelte` prints `terminal replay missed N bytes` before the replay, which ends at the prompt. The same attach before the restart reported 0. In the e2e terminal A wrote under 128 KiB and terminal B over it, both inside the 2 MiB ring; B hit the line after every restart and A never did. A was the focused terminal and B was not; focus plays no part on the server:

```
fresh B after boot: seq 196640, missed 0, replay 196640 bytes, file 196640 bytes
fresh A after restart1-cli: seq 102923, missed 0, replay 102923 bytes, file 102923 bytes
fresh B after restart1-cli: seq 301819, missed 66486, replay 235333 bytes, file 301819 bytes
  the SPA prints: terminal replay missed 66486 bytes
```

66486 is B's `seq` at the restore (197558) minus 131072. After the second CLI restart of the `cli cli` run the same attach reads `missed 171665`:

```
fresh B after restart2-cli: seq 406998, missed 171665, replay 235333 bytes, file 406998 bytes
  the SPA prints: terminal replay missed 171665 bytes
```

It is not a replay cut mid-escape (the replay is the exact byte tail) and it is not the manifest's seq and tail split of [the-fdstore-manifest-splits-seq-and-tail](the-fdstore-manifest-splits-seq-and-tail.md).

## Desired contract

A restart does not shorten a session's replay: a fresh attach after a restart replays as much history as the same attach before it, up to the live ring's size.

## What to do

Carry the whole ring across a restart. The option the lane names is a memfd-backed ring parked in the fd store beside the session's PTY master, which would also cover the crash case of [a-crash-restart-restores-a-stale-manifest](a-crash-restart-restores-a-stale-manifest.md) exactly, at the cost of a second stored fd per session counted against the unit's `FileDescriptorStoreMax`. Acceptance: the reproducer's fresh-attach check for a terminal over 128 KiB and under 2 MiB passes after a graceful restart.

## Boundaries

The ring and the manifest in `crates/chan-library/src/terminal_sessions.rs` (`FDSTORE_REPLAY_BYTES`, `from_imported`), the fd store in `crates/chan-server/src/devserver/fdstore.rs` and its `FileDescriptorStoreMax` budget. The SPA's message is correct for what the server reports and is not part of the fix.
