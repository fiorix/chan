# A terminal that falls behind a fast stream loses part of it

Status: accepted for v0.130.0 by the owner on 2026-11-13; not started.

Record: reported by the owner on 2026-11-13 in his Mac report for v0.129.0's terminal renderer batch, part R9: during `yes 'the quick brown fox' | head -400000` and a `cat` of `/usr/share/dict/words` the terminal printed "terminal error: terminal output lagged; reconnect to replay retained scrollback", and part of the stream never reached the view. He ran the same in the installed v0.128.0: it "feels the same", and he is "pretty sure it is the same thing" there (`dev/v0129/owner/reports/batch3-terminal-renderer-at-09d7a4f9e.md`; the integrator's reading in `dev/v0129/status.md`). Recorded as a candidate in `dev/v0129/row-notes.md` ("Command deck: owed at the row record and the cut", the batch 3 bullet). The owner, for v0.130.0: "what i really want on v0.130 is the systemd and flush-window-edges, plus ghostty/terminal bug fixes like the one my other agent is actively fixing right now".

## What is there now

Read at `342dbe791`, and the same at v0.128.0 (`8ded1bda9`); not run.

- **Server.** A session pushes each PTY read into its replay ring and broadcasts it as one `SessionEvent::Output` on a tokio broadcast channel of 1,024 events (`BROADCAST_CAP`, `record_output`, `crates/chan-library/src/terminal_sessions.rs`); the event carries the bytes and no position. Each terminal socket forwards events one WebSocket message at a time, awaiting each send (the `session.rx.recv()` arm of the socket loop, `crates/chan-server/src/routes/terminal.rs`). Nothing slows the PTY for a socket. A socket more than 1,024 events behind loses the oldest: its next receive is `RecvError::Lagged`, and the loop sends an `error` frame, "terminal output lagged; reconnect to replay retained scrollback", and goes on from the oldest event still held. The skipped events never reach that socket, output or otherwise.
- **The ring.** A bounded buffer of numbered chunks, 2 MiB by default (`ring_bytes`, `default_terminal_ring_bytes` in `crates/chan-library/src/config.rs`). An attach subscribes and snapshots it under one lock and resumes from the client's cursor, with a missed count when the cursor is older than the ring (`attach_resuming`; `crates/chan-library/design.md`). A lag re-reads nothing from it. Under a writer running flat out a Linux PTY read is about 4 KiB (the `PTY_READ_BYTES` comment), so 1,024 events are about 4 MiB, twice the default ring: when a socket lags, the bytes it skipped are mostly gone from the ring too. Read sizes on macOS were not read.
- **Client.** The workspace app writes the frame into the terminal as `terminal error: ...` and does not redial (`ws.onmessage`, `web/packages/workspace-app/src/components/TerminalTab.svelte`). Its cursor `receivedSeq` adds the length of each live binary frame, so after a lag it is short by the skipped bytes, by reading: a later redial resumes from it, and an xterm.js snapshot captured after the lag records it, so the replay shows that many bytes a second time while the skipped ones stay missing.
- The owner's run was on the ghostty backend, whose writes parse synchronously inside `ws.onmessage` (through the viewport controller); xterm.js queues writes in its own buffer. Whether the xterm.js backend lags as readily is not established by reading.

## Desired contract

1. A view that falls behind a fast stream loses none of it: when the stream ends the view holds every byte the program wrote, once and in order, and the terminal prints no lag line. The R9 commands above are the reference load.
2. A view that stops reading (a hung page, a socket nobody drains) holds neither the program nor the other views beyond a bound, and the server's memory per session stays bounded. When it reads again it resumes as a reattach does: from the ring, with the count of what it missed.
3. Wherever bytes are lost the terminal says how many, as a replay that missed bytes does, and the client's cursor stays equal to the server's, so a redial or a snapshot resume neither repeats bytes nor skips more.

## Boundaries

- The session's output fan-out and the terminal socket's loop (`terminal_sessions.rs`, `routes/terminal.rs`), and the client's cursor and error handling (`TerminalTab.svelte`). How the server keeps a slow view whole is the build's choice, after a measurement: pacing the PTY read by the views that read, which is what a full PTY buffer does to a writer under a native terminal, or a window of bytes the client acknowledges (the watermark scheme of xterm.js's flow-control guide). Re-reading the ring at a lag cannot meet contract 1 under the reference load alone, by the sizes above.
- Not here: the ring's size and the scrollback setting; the `/ws` watcher socket's lag handling; program status and title frames, which already read their latest value independently of output lag (`crates/chan-server/design.md`).

## Acceptance

1. A measurement in a guest before the design is chosen: the reference load on the ghostty backend in a browser against the guest's devserver, recording read sizes, the point where the socket lags, and how far behind it is then.
2. Server tests: a socket that reads slower than the PTY writes, past what the broadcast holds, receives every byte once and in order and no `error` frame; a socket that stops reading holds the session no longer than the bound and does not slow another socket; each red on today's code where it applies.
3. A workspace app test: after a loss the server reports, the cursor equals the server's and a redial replays no byte twice; red on today's code.
4. In the guest, on both backends: `seq 1 400000` read back from the terminal's buffer is the whole sequence, and no lag line is printed. On the owner's Mac, on chan-desktop: the R9 commands print no lag line, and `seq 1 400000` scrolled back at a few points shows consecutive numbers.
