# Team identity pokes wait for TUI readiness

Status: SHIPPED in [v0.83.0](../../release/release-v0.83.0.md). The identity poke gates on DECSET 2004 with a bounded, named failure instead of a fixed grace.

## What

`cs terminal team new` and `load` gate each agent member's identity poke on that member's PTY enabling bracketed-paste mode with DECSET 2004. The waits run concurrently and are bounded at 15 seconds, so a ready member is poked immediately while a slow or dead peer continues waiting.

Shell members remain outside the gate. They have no agent compose box, receive no identity poke, and add no wait to team startup.

## Live path

The control socket receives the shared `Arc<TerminalRegistry>` created by `chan-server` and calls `spawn_and_poke_team` for both `new` and `load`. Each successful agent spawn retains its exact `AttachHandle` through readiness and delivery. The server passes the member command in that session's `CreateOptions`; it does not create an interactive shell session and later type the agent command into it, so a preceding shell life cannot satisfy readiness on the retained handle.

The PTY reader thread in `chan-library/src/terminal_sessions.rs` sends every read to `Session::record_output`. That function calls `update_private_modes` before broadcasting the output event. Mode 2004 is already part of the tracked DEC private-mode set, so `AttachHandle::wait_for_bracketed_paste` observes parsed terminal state rather than polling scrollback or matching an agent banner.

## Failure contract

- A member that does not enable bracketed-paste mode within 15 seconds is not poked and is named in the team summary.
- A member whose terminal exits, closes, or restarts before readiness is also not poked and is named.
- Any unpoked agent makes the control response an error, which makes `cs terminal team new|load` exit non-zero. Successfully ready peers are still poked.
- The `--script` form retains `sleep 3` because the emitted shell script does not own the server's PTY observation. Its generated comment labels the sleep as an approximation of the server readiness gate.

## Verification

- A PTY-level test proves a DECSET 2004 sequence split across reads does not signal early and does signal when complete.
- A PTY-level test proves a closed terminal ends the wait without reporting readiness.
- A spawn test uses an agent probe that emits DECSET 2004 after 3.25 seconds and proves the readiness marker precedes the test PTY's echoed identity poke.
- A paused-clock spawn test proves a never-ready member is named after the 15-second bound and its scrollback contains no identity prompt.
- A spawn test proves a member that exits before readiness is named and receives no identity prompt.
- Existing shell-member and window-surfacing tests pin the zero-wait shell path and the SPA notification behavior.
