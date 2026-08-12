# A Windows Team Work terminal can deadlock on a startup DSR

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
