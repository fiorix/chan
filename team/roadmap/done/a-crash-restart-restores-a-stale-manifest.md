# A crash restart restores a stale sequence and tail from the manifest

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-25; raised during v0.101.0 on 2026-09-24. From the terminal replay lane's restart e2e at `918f03694` on `v0101/terminal-replay`. The reproducer is `scripts/e2e/devserver-terminal-replay.sh` with `scripts/e2e/terminal-replay-client.mjs`, which land with that lane; it ran in a Linux container as root against the `chan-devserver` user unit, and the runs' logs are `dev/v0101-tasks/evidence/term/e2e-replay-918f03694.log` (restarts `cli crash`) and `dev/v0101-tasks/evidence/term/e2e-replay-cli-cli-918f03694.log` (restarts `cli cli`) in the development tree. Reproduced at that sha on the `kill -9` restart of the `cli crash` run, and at `f8ae53dcf` in `dev/v0101-tasks/evidence/term/e2e-replay-f8ae53dcf.log`; the owner ruled on 2026-09-24 that the terminal replay lane hands it off rather than fix it.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, in one terminal restore lane with [a-restart-replays-only-the-manifest-tail](a-restart-replays-only-the-manifest-tail.md), which answers this item's two questions. Output does not refresh the manifest: the memfd-backed ring chosen for that item survives a crash, which makes a refresh moot. A resume cursor the server cannot honour, such as one ahead of a restored `seq`, gets a full replay and a visible notice, never a silent skip.

The ring half landed with [a-restart-replays-only-the-manifest-tail](a-restart-replays-only-the-manifest-tail.md) on 2026-09-26; the resume half (a cursor the server cannot honour, the ring for a session restored without one, the terminal flags beside the bytes) landed later the same day.

## What was seen

The fd-store manifest is rewritten on park, move, rename and unpark, never on output. After `kill -9` the new process restores the `seq` and replay tail of the last rewrite, which in the e2e was the activation after the previous restart. A fresh view loses the history written since:

```
fresh A after restart2-crash: seq 101113, missed 0, replay 101113 bytes, file 137804 bytes
  session seq 101113, want 137804 (the bytes written)
  missed 0 + replay 101113 = 101113, want 137804
  replay is not the file's tail (tail would start at offset 36691)
```

An attached client resumes with a cursor ahead of the server: the keep client dialed `since=102923` and the restored prelude said `seq 68050` (the client's event log under the `f8ae53dcf` run's work directory). The attach replays nothing at or below the client's cursor, so the output the shell produced while the devserver was down is skipped without a word:

```
keep A screen after restart2-crash: DIFFER, want 137804 bytes, got 135986, first difference at offset 102944
  want[102944:+80] = b'1 line 000000 \xc3\xa9\xe2\x9c\x93\xc3\xbc\x1b[0m \n\x1b[31mrestart2-crash-a1 line 000001 \xc3\xa9\xe2\x9c\x93\xc3\xbc\x1b[0m x\n\x1b[32'
  got [102944:+80] = b'7 line 000000 \xc3\xa9\xe2\x9c\x93\xc3\xbc\x1b[0m \n\x1b[31mrestart2-crash-a7 line 000001 \xc3\xa9\xe2\x9c\x93\xc3\xbc\x1b[0m x\n\x1b[32'
```

Chunks a1 to a6 were lost on terminal A, and b1 to b6 on terminal B.

## Desired contract

After a crash restart a fresh view replays the session's real tail, and an attached client whose cursor the server cannot honour is told so and replayed in full, never skipped silently.

## What to do

Two questions for the owner, which the lane named. First, whether output should refresh the manifest, at a write cost of several times a second while output flows. Second, whether a resume cursor ahead of a restored `seq` gets a full replay instead of a silent skip. The memfd-backed ring of [a-restart-replays-only-the-manifest-tail](a-restart-replays-only-the-manifest-tail.md) would answer the first exactly, since the ring itself survives the crash. Acceptance: the reproducer's `cli crash` run passes its crash checks for both the attached and the fresh client.

## Boundaries

The manifest's rewrite points and the imported ring in `crates/chan-library/src/terminal_sessions.rs`, the attach's resume path (`snapshot_since` in `crates/chan-library/src/terminal_sessions/ring.rs`), and the fd store in `crates/chan-server/src/devserver/fdstore.rs`.

## What shipped

Landed on 2026-09-26, after the ring half. A parked session restored without a ring file gets one when parking activates, so every restored session has a ring. The ring file's header carries the alt-screen flag and the private modes, and a restore that takes its bytes from the file takes those from it too. A resume cursor the server cannot honour, such as one ahead of a restored `seq`, gets the whole ring and a `missed_bytes` count in the session frame, never a silent skip; the server tells such a cursor apart from a good one even after new output has moved the end past it. A mirrored ring's manifest entry carries no tail: at 100 sessions of 2 MiB the manifest is 108 KB where it was 17.6 MB. The replay e2e (`scripts/e2e/devserver-terminal-replay.sh`) passes its crash checks on `cli crash` and `cli cli`.

The restore rules the review of that order added. A lossy restore, one that could not recover the ring exactly, so the session comes back under a new generation and a client of the old one is replayed the whole ring with a missed count, keeps its ring file marked stopped until this process has committed a manifest that carries the minted generation; a crash before that commit restores the old generation exactly, so a stale client's cursor is never honoured into a shifted replay, and a failed commit leaves the mark. The minted generation is `max(previous + 1, the wall clock in microseconds, the last mint in this process + 1)`, so two processes cannot mint alike. Activation's reconcile parks every ring-less session and commits the manifest once: the first boot after v0.100.0 with 100 sessions of 2 MiB writes 13 MB where it wrote 889 MB, and reaches ready in 1.1 s where it took 3.6 s. A ring file a restore gives up on is removed from the store at boot, before a new ring is parked under its name. A state-changing push writes the ring file's window and state in one `pwrite`, so a kill cannot leave a stale flag beside new bytes.

Rollback consequence: v0.100.0 parses the new manifest, ignoring the fields it does not know and defaulting the replay tail, so a rollback to it restores every mirrored session with an empty ring and a notice of `seq` missed bytes. The tail a v0.100.0 manifest kept is gone once this release has rewritten it.
