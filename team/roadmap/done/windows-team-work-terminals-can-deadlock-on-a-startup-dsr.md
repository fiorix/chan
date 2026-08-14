# A Windows Team Work terminal can deadlock on a startup DSR

Closed: shipped in [v0.90.0](../../release/release-v0.90.0.md).

Status: REGISTERED 2026-08-12, promoted from a v0.89.0 draft after the round's close triage traced it to a concrete reachable path. Candidate product bug, medium severity, blocked on a real-Windows reproduction before a fix is written.

## What

On Windows the terminal shell resolver defaults to PowerShell (pwsh, then powershell, then cmd). PowerShell under a ConPTY pseudoconsole emits a DSR cursor-position query (`\x1b[6n`) at startup and blocks until a terminal answers with a CPR (`\x1b[row;colR`). The chan-library reader threads only drain PTY output to the ring; nothing in the library answers the DSR. In ordinary interactive use the SPA's xterm.js frontend answers it once attached, so pwsh proceeds. The `cs terminal team new` / `cs terminal team load` path is different: the agent's pwsh is spawned server-side first and emits its one-and-only `\x1b[6n` before any frontend attaches, then the SPA attaches to the pre-assigned session in reattach mode, where `routeXtermData` deliberately suppresses replay-generated device replies to avoid duplicate input. If pwsh's single startup query lands in the ring before the attach cursor advances, the CPR xterm.js generates is dropped as a replay artifact, and because pwsh queries only once the agent shell deadlocks at startup and never runs its command.

## Grounding

Traced at v0.89.0 HEAD by the close triage, verdict inconclusive on the race but with the path concrete:
- The library reader never answers DSR: `crates/chan-library/src/terminal_sessions.rs` reader thread is `record_output` only, no scan for `\x1b[6n`, no CPR write.
- The frontend answers only once attached and suppresses in reattach mode: `web/packages/workspace-app/src/terminal/connection.ts` `routeXtermData` returns on a replay-origin generated reply (final `R`), and `components/TerminalTab.svelte` sets `suppressAttachReplayGeneratedReplies` when `reattaching` (a pre-assigned `terminalSessionId`, which the team/CLI spawn path always has).
- Ordinary UI-created terminals are safe: a fresh tab has no pre-assigned session, so device replies route as live and the CPR is forwarded.
- The exit-test failure this round already showed pwsh under ConPTY blocking on `\x1b[6n` with `-Command "exit N"`, so an explicit agent command does not avoid the startup query.
- The default backend is xterm.js; ghostty-web (opt-in via `terminal.ghostty`) also answers DSR-CPR.

## The reproduction that gates a fix

This is a race plus a shell-behavior question that source cannot settle. On a real Windows chan-desktop:
- Does `cs terminal team new` leave agent shells hung (never running their command), always, intermittently, or under load (N simultaneous members, or the powershell.exe 5 fallback)?
- Does pwsh's startup `\x1b[6n` reliably land before or after the SPA's reattach seq cursor?
- Does a single CPR unblock pwsh at all?

## Contract, if it reproduces

The robust fix is a library-side minimal DSR answerer: the reader watches for `\x1b[6n` and, when no reply has been forwarded, writes `\x1b[1;1R` to the PTY. That removes the frontend-attach race at the source, and it also closes the headless exit-test gap and the headless-server case, so the exit tests this round gated to unix could be ungated. It is strictly better than a frontend-emulating test reader or per-test shell injection, which only restore test coverage and leave the product race live.

## Acceptance

- A real-Windows reproduction result: the deadlock happens (always / intermittently / under load) or it does not, recorded with the conditions.
- If it reproduces: the library-side DSR answerer, with the ConPTY reaping and the ungated exit tests green on the Windows arm, and no double-CPR when a frontend is also attached.

## Reproduced and fixed, 2026-08-14 (Windows 11, AX8_PRO)

It reproduces, deterministically, and the cause is narrower than this item assumed.

**It is not a pwsh behavior.** The box that reproduced it has no `pwsh` installed at all: the resolver fell to Windows PowerShell 5.1, which this item listed as an open question, and it deadlocks. Forcing `cmd.exe` through `CHAN_SHELL` deadlocks identically, with the same four-byte scrollback. The `\x1b[6n` is ConPTY's OWN startup handshake -- conhost emits it before it will pump the child's output -- so it gates every Windows shell rather than one interactive shell's prompt setup. The race against the SPA's reattach cursor described above is therefore not the mechanism; there is nothing to race, because nothing in a server-side spawn answers the query at all until a frontend attaches.

Evidence, through the library's own PTY path: a session spawned with `exit 7` recorded no exit within five seconds and its entire scrollback was the lone `\x1b[6n`. With the answerer, the same session exits 7 in 0.38s. Disabling the answerer again makes both un-gated exit tests fail with exactly that original scrollback.

End to end on a real devserver, through `POST {prefix}/api/terminals` -- the same call the team dialog makes, where the session is created server-side and only attached over `/ws` afterwards:

| binary | result |
| --- | --- |
| shipped v0.89.0 (`git-0c6fd8dc`) | session created (201), command never ran, no output in 25s |
| this branch | command ran, marker file written in 2s |

Shipped: the library-side answerer in `crates/chan-library/src/terminal_sessions.rs`. The reader arms a pending query and the controller answers it on its existing 25 ms tick, after a grace in which an attached frontend's own report wins. The three natural-exit tests are un-gated and green on the Windows arm along with the ConPTY reaping tests (273 passing).

### No double CPR with a frontend attached

Also verified live, against a real devserver, with a client attached over `/ws` that answers DSR the way xterm.js does. It attaches with no session id, so the session is created with the frontend already present -- the ordinary new-tab case. It replies with a deliberately distinctive `\x1b[7;42R` so its report can be told from the library's `\x1b[1;1R`.

ConPTY makes the winner visible: it acts on whichever report it consumed by moving the cursor there, so the echoed CUP names it.

| run | ConPTY's response | shell | stray report |
| --- | --- | --- | --- |
| frontend answers `\x1b[7;42R` | `\x1b[7;42H`, the frontend's own coordinates | clean prompt | none |
| frontend silent (control) | `\x1b[H`, home -- the library's `1;1R` | clean prompt | n/a |

The control matters: it shows the fallback is live in this setup rather than the test being vacuous, and that it is what unwedges the shell when nothing else answers.

In the frontend-answering run the library wrote nothing. ConPTY waits for exactly one report, so a second would not be consumed as a device reply -- it would reach the shell as unsolicited input and echo at the prompt. The prompt is clean and the literal `1;1R` appears nowhere in the transcript.

The narrow residual race remains by design and is unobserved rather than disproven: a frontend answering in the window between the grace expiring and the library's write would land one stray report. It is documented at `take_due_dsr_answer`, and it costs one stray CPR where the alternative costs the whole session.
