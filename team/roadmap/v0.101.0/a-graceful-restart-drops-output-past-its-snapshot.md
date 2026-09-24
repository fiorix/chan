# A graceful restart can drop output read after its last manifest write

Status: raised during v0.101.0 on 2026-09-24; not accepted. From the terminal replay lane's restart e2e at `918f03694` on `v0101/terminal-replay`. The reproducer is `scripts/e2e/devserver-terminal-replay.sh` with `scripts/e2e/terminal-replay-client.mjs`, which land with that lane; it ran in a Linux container as root against the `chan-devserver` user unit, and the runs' logs are `dev/v0101-tasks/evidence/term/e2e-replay-918f03694.log` (restarts `cli crash`) and `dev/v0101-tasks/evidence/term/e2e-replay-cli-cli-918f03694.log` (restarts `cli cli`) in the development tree. Reproduced at that sha on the first restart of the `cli cli` run, intermittently: one of the three CLI restarts across the two runs hit it, which is an observation, not a rate. Found after the owner's two rulings on the lane's other findings and handed off the same way, without being put to the owner separately.

## What was seen

One 343-byte chunk is gone from both the attached client and the restored `seq`:

```
keep A screen after restart1-cli: DIFFER, want 102923 bytes, got 102580, first difference at offset 65908
  want[65908:+80] = b'2 line 000000 \xc3\xa9\xe2\x9c\x93\xc3\xbc\x1b[0m \n\x1b[31mrestart1-cli-a2 line 000001 \xc3\xa9\xe2\x9c\x93\xc3\xbc\x1b[0m x\n\x1b[32mr'
  got [65908:+80] = b'3 line 000000 \xc3\xa9\xe2\x9c\x93\xc3\xbc\x1b[0m \n\x1b[31mrestart1-cli-a3 line 000001 \xc3\xa9\xe2\x9c\x93\xc3\xbc\x1b[0m x\n\x1b[32mr'
fresh A after restart1-cli: seq 102580, missed 0, replay 102580 bytes, file 102923 bytes
  session seq 102580, want 102923 (the bytes written)
  missed 0 + replay 102580 = 102580, want 102923
  replay is not the file's tail (tail would start at offset 343)
```

`seal_flush_detach` (`crates/chan-server/src/devserver/fdstore.rs`) writes the final manifest and then detaches the parked sessions. Their PTY reader threads keep consuming the PTY until the process exits, and the bytes they read in that window reach no manifest and no socket. Terminal B came through equal on the same restart, and both terminals did on the `cli crash` run's graceful restart. After the `cli cli` run's second restart terminal A's gap is 686 bytes (`tail would start at offset 686`), which the lane's report does not separate into the first loss carried forward and a second one.

## Desired contract

Every byte a session's PTY emits before a graceful restart reaches either a client or the manifest the next process restores from.

## What to do

Stop the PTY readers before `seal_flush_detach`'s final snapshot, so the snapshot is the last read, and reorder `seal_flush_detach` around that stop. Acceptance: the reproducer's CLI restarts pass their attached and fresh checks for both terminals across repeated runs, and a test holds a PTY write in the window between the final manifest write and the detach.

## Boundaries

The session readers in `crates/chan-library/src/terminal_sessions.rs` and the ordering in `crates/chan-server/src/devserver/fdstore.rs`.
