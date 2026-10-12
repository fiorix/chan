# `cs terminal status` returns at once, so a reported state cannot be watched on its tab

Status: raised by the owner on 2026-10-12, after v0.105.0 shipped the OSC 7501 program status item; written down, not designed. The owner asked for the flag by name. Accepted into v0.106.0 on 2026-10-12 by the owner asking for it, at the round launch of that day: its first step (the reproduction named below) is accepted, and nothing past the decision it names.

## What was seen

The owner tried to validate the tab marks of v0.105.0 by hand with `cs terminal status` from a shell prompt and could not: the command writes its report and exits, and the tab's state is gone before it can be read. The owner's words: "the cs terminal status commands could use a --sleep flag so that we can actually validate the states because otherwise they run too fast and we can't see the tab state because when the program exists the state is reset; i was able to run cs tunnel to validate, but that was it". `cs tunnel` works for this only because it stays in the foreground while it reports.

Read at source on `main` at `4507fe5a0`: `cs terminal status` takes a state and six options and no way to stay alive (`crates/chan-shell/src/cli.rs`, `TerminalAction::Status`, dispatched to `program_status::emit`). The library tags a report that sets `working`, `blocked` or `idle` with the process group that holds the PTY's foreground when the report is read, and stores `done` and `error` without one (`crates/chan-library/src/terminal_sessions/program_status.rs`, `apply`); the shipped item says a killed job takes its tagged records with it and that `working`, `blocked` and `idle` are also dropped at `OSC 133 ; A`. A report written by a command that has already exited is therefore the short-lived case by design.

Not established: which of the two rules removed the record in the owner's reading (the foreground group's end or the shell's next prompt mark); whether `done` and `error`, which both rules spare, were also lost in the owner's shell; whether the command's help line "A control report stays after this command returns, like a PTY report" is true of a PTY report of `working` from an interactive prompt.

## Desired contract

A person at a shell prompt can put a tab into each of the six states and look at it for as long as they ask. `cs terminal status <STATE> ... --sleep <SECONDS>` writes the report exactly as today and then stays in the foreground for that long before it exits, so the record lives under the rules that already exist; without the flag nothing changes.

## What to do

Read the two removal rules at source and reproduce the owner's reading first, so the flag is built against the rule that applies and the help text says what a user will see. Then settle, before the code: the unit and form of the value (whole or fractional seconds) and its bound; what an interrupt during the wait does (exit at once, nothing more written); whether the command writes anything when the wait ends (the default taken here: nothing, the existing rules end the record); what the flag means with `clear` and on the control-socket route, where no foreground group is involved (accepted and waited, or refused with a reason). Add the flag, its help with an example a user can paste for each state, and the user manual's program status section.

## Boundaries

`crates/chan-shell/src/cli.rs` (the `Status` arguments and dispatch), `crates/chan-shell/src/program_status.rs`, `crates/chan-shell/src/help.rs`, their tests; `web/packages/marketing/src/pages/manual/terminal.html` if the manual names the command. Not changed: the report's bytes, the library's record rules, the wire.

## Acceptance

1. The owner's reading reproduced, and the rule that removed the record named with its source lines.
2. With `--sleep N` from an interactive prompt, the record for `working`, `blocked` and `idle` is on the session for the wait and gone after it, read through `cs terminal list --json` from a second terminal during and after; `done` and `error` behave as they do without the flag.
3. An interrupt during the wait ends the command at once with no second report written.
4. A refused value (negative, not a number, over the bound) writes no report byte.
5. The help's pasted examples each produce the state they name, and the corrected sentence about what stays after the command returns is true as written.
