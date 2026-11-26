# A queued message waits behind a stopped view of an idle program on macOS and Windows

Status: accepted by the owner on 2026-11-21 as a follow-up that does not hold the stream row ("sure follow up", `dev/v0133/decisions.md`), for v0.134.0. Not started. It builds on the acknowledged stream pacing merged for v0.133.0. Moved to v0.135.0 by the owner on 2026-11-23 ("all other roadmap items will move to next version").

Record: the stream row paces the PTY reader by the bytes a view acknowledges, and its write queue does not deliver while the reader waits for credit, since a held program is mid-output and not idle. Found while that fix was built. On Linux the reader first polls for output, so it waits for credit only with bytes to read. On macOS and Windows it asks for credit before it blocks in `read`, so it can wait with nothing to read, and the queue reads that wait as a hold.

## What is there now

Read at `98a1c1871`, by reading; not run on macOS or Windows.

- `reader_may_read` is `cfg(target_os = "linux")` (`crates/chan-library/src/terminal_sessions.rs:6102-6103`). The credit wait is `Pacing::credit` (`terminal_sessions/pacing.rs`).
- Trigger: a program's last output leaves an acknowledging view a full window (or 512 events) behind, and the program then goes idle.
- Worst case for a stopped view: the 5 s bound, the 800 ms quiet period and one 150 ms drain tick, about 5.95 s from the start of the wait.
- A view still parsing: a byte-limited wait ends at its next acknowledgement. An event-limited wait can last longer, because each acknowledgement renews the 5 s clock while 512 events remain unsent.
- The message is late, never early, and never stuck.
- Linux has a narrower form: the reader waits only once it has seen pending bytes, but a small final write that is still pending can park it for up to 5 s and hold the queue about 5.8 s.

## Desired contract

1. On macOS and Windows, an idle program with no pending PTY output is not treated as held: a queued message is delivered at the normal quiet period. Decide while building whether the Linux form above should deliver sooner too.
2. A program that is really blocked on a full PTY still receives nothing until it is idle.
3. Pacing, its 5 s bound and the exit drain are unchanged.

## Boundaries

- The reader's wait and the write queue's idle test in `terminal_sessions.rs` and `terminal_sessions/pacing.rs`.
- Not the acknowledgement protocol, the window or the bound.
- Linux changes only if that decision says so.

## Acceptance

1. A native test on macOS and on Windows, with a real PTY: a view a full window behind an idle program, a queued message delivered within the quiet period. Red at the base on each platform.
2. A test that a program really blocked on output still receives no queued message.
3. Read on the local Windows VM and on the owner's Mac through `cs terminal write` to a real agent.

## Built, 2026-11-26

Merged at `5ddcc56a3` (branch tip `5a68eac79`). Off Linux, where the reader cannot poll the PTY, the reader waits for a view only once it has read output the view has not taken: with nothing pending it reads, so a queued message reaches an idle program behind a stopped view within the quiet period, and a program really blocked on output still gets none until its hold ends. The hold and the reader's credit are decided under one lock, so a view that runs out of credit between the two cannot bring the old hold back. The Linux form is unchanged and was chosen to stay so: its reader polls before it waits, and a final write behind a stopped view still waits for the hold bound there (about 5.8 s after the last output), as before. Read: native tests with a real PTY, red at the base on Windows (one test) and macOS (two) in CI and green at the tip on Linux, macOS and Windows; on the local Windows 11 VM at the tip the 512-events test delivers 6 ms after the quiet period and a held program 1.17 s after its hold ends, and at the base the same test delivers 5,014 ms after it; the lock race red at its own commit on Linux and on the VM. Not read: acceptance 3 through `cs terminal write` to a real agent, on the VM (no agent is installed there) and on the owner's Mac.

## Closed, 2026-11-26

The owner closed the row on 2026-11-26 with nothing carried ("not carrying anything about terminal and ghostty, we will close them all"). Acceptance 1 and 2 are read (above). Acceptance 3 was being read when the row closed: on the owner's Mac through `cs terminal write` to a real agent, and on the local Windows VM, where the owner allowed an agent CLI to be installed for it the same day. Neither reading had a result at this commit. At the final integration tip `5915fd54f`: the 103-check terminal suite in Chrome in an isolated guest (102 passed, 346's same-pane leg unavailable in Chrome by design), the replay end-to-end test 6 of 6, one full `make pre-push` in a gate guest, and CI green on every job but the AUR desktop binary package's, which timed out fetching from the Arch Linux Archive.
