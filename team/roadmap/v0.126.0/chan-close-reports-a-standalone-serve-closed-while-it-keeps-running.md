# chan close reports a standalone serve closed while it keeps running

Status: raised on 2026-11-08 while writing the chan.app tutorials; accepted by the owner for v0.126.0; not started.

## What is there now

`chan close PATH` on a workspace served by `chan serve --standalone` prints `closed: PATH` and exits 0 after about five seconds, while the server keeps running, keeps answering HTTP and keeps its writer lock. Reproduced on 2026-11-08 with 0.125.0 on macOS, where `~/.local/bin/chan` links to the Chan Desktop binary and a desktop is running, against a throwaway `CHAN_HOME` and no browser attached; the same close with `CHAN_NO_DESKTOP_HANDOFF=1` stops the server at once. Two defects combine:

1. The desktop's `CloseWorkspace` handoff handler answers `Response::Closed` for both `WorkspaceLifecycleOutcome::Completed` and `NotFound` (`desktop/src-tauri/src/main.rs:5820-5825`), and the CLI maps `Closed` to `HandedOff` (`crates/chan-server/src/handoff.rs:1377`). A desktop that does not serve the path therefore reads as having closed it, and `cmd_close` never reaches the writer lock's holder over its control socket.
2. `unserve_running` discards the result of `wait_for_lock_release` on the handoff arm (`crates/chan/src/close.rs:438`) and on the control-socket arm (`close.rs:513`) and returns `Unserved` either way, so a lock still held when `LOCK_HOLDER_BOUND` expires is printed as `closed:`.

`chan close --help` promises the opposite: the close waits for the flock to release, and a dedicated `chan serve` process exits. The plain CLI personality hands off only when forced, so the first defect reaches the desktop's `chan` (the macOS link and the desktop's own terminals); the second reaches every personality. The host-side half of a close that answers before the lock is free shipped in v0.102.0 as [a-close-answers-before-the-writer-lock-is-free](../done/a-close-answers-before-the-writer-lock-is-free.md); this item is the CLI's half.

## Desired contract

1. A desktop that does not serve the requested root gives an answer the CLI can tell from a completed close, and the CLI then goes on to the writer lock's holder exactly as it does with no desktop running.
2. `chan close` and `chan workspace forget` print `closed:` only once the writer lock is free. A lock still held at the bound is a failure that names the holder's pid and exits non-zero.
3. With a desktop running, `chan close` of a standalone `chan serve` stops that server, as it does without one.

## Boundaries

- The desktop's handoff close handler, the handoff response mapping and `crates/chan/src/close.rs`; the host-side unmount and removal paths keep their behavior.
- A new handoff answer follows the pre-release rule: no compatibility path for older desktops.

## Acceptance

1. A constructed red at the base: a handoff close answered `NotFound` beside a lock held by a live standalone server reports closed at the base and stops the server at the fix.
2. A test of the lock wait: a lock held past the bound ends in a non-zero result naming the pid, not `closed:`.
3. A live run on macOS with Chan Desktop running: `chan serve --standalone --no-browser` in a throwaway `CHAN_HOME`, then `chan close PATH`; the process is gone and its port refuses within the bound.
4. The gate green, the chan and chan-desktop tests included.
