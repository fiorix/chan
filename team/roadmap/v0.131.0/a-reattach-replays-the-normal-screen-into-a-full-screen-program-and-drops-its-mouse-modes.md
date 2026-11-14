# A reattach replays the normal screen into a full-screen program and drops its mouse modes

Status: found by the v0.131.0 round's terminal regression audit and accepted for v0.131.0 by the owner on 2026-11-14 ("Take all my recommendations", answering `dev/v0131-team/reports/owner-candidates-1.md`, item 1); not started.

Record: entries T005 and T007 of the round's terminal regression list (`dev/v0131-team/terminal-regressions.md`). Red Rust probes at `fa22e73ac` showed both as live defects (`dev/v0131-team/evidence/Core131/termregress-server/initial/probes.rs`, log `initial/tests.log`, hashes `initial/source.sha256`; `dev/v0131-team/followups/followup-Core131-Lead131-8.md`).

## What is there now

Read at `9d7b56c45`.

- The server decides whether a reattach replays the ring from `Session::in_alt_screen`, which `update_alt_screen` (`crates/chan-library/src/terminal_sessions.rs`, around line 7564) sets by searching each PTY read (with a short tail carried from the last) for the literal `\e[?1049h` and `\e[?1049l`. It checks enter first and exit second over the whole read, so an exit and a re-entry in one read (`\e[?1049l ... \e[?1049h`) leaves the flag on the normal screen. DECSET 47 and 1047 and a grouped DECSET such as `\e[?1;1049h` are not recognised at all. In each of those cases a reattach to vim, less or htop replays the normal screen's scrollback into the program's screen.
- `TRACKED_PRIVATE_MODES` (same file, around line 202) re-asserts DECCKM, mouse modes 1000, 1002 and 1003, focus reporting 1004, SGR encoding 1006 and bracketed paste in the attach prelude. The other mouse modes and encodings, 9 (X10), 1001 (highlight), 1005 (UTF-8), 1015 (urxvt) and 1016 (SGR pixels), are not tracked, so a reattach to a program that set one of them leaves the fresh terminal sending clicks in the default encoding, or none.
- The probes: `an_alt_screen_reentry_in_one_read_takes_no_normal_screen_replay` fails "the final DECSET selects the alternate screen"; `a_legacy_alt_screen_takes_no_normal_screen_replay` fails "DECSET 47 selects the alternate screen"; `a_grouped_alt_screen_takes_no_normal_screen_replay` fails "grouped DECSET selects the alternate screen"; `an_alt_screen_reattach_reasserts_urxvt_mouse_coordinates` fails with an empty prelude where `\e[?1015h` was expected.

## Desired contract

1. The server's alternate-screen state after a PTY read is the state the last alternate-screen transition in that read selects, in order, across read boundaries, for DECSET and DECRST 47, 1047 and 1049, alone or grouped with other modes in one CSI.
2. A reattach to a program on the alternate screen replays no normal-screen output, whichever of those forms entered it.
3. The attach prelude re-asserts every mouse tracking mode and mouse encoding the program left on (9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016), with focus reporting, DECCKM and bracketed paste as today.
4. Nothing else changes: a normal-screen reattach replays as today, and the prelude's order and the modes it leaves out (autowrap, cursor visibility) stay.

## Boundaries

- `update_alt_screen`, `TRACKED_PRIVATE_MODES` and the private-mode parser beside them in `crates/chan-library/src/terminal_sessions.rs`, and their tests; one scan of the CSI parameters may serve both.
- Built before the fast stream row ([streamlag](a-terminal-that-falls-behind-a-fast-stream-loses-part-of-it.md)), which changes the attach and replay path around it.
- Not here: a replay that starts inside an escape sequence (the ring evicting whole chunks, entry T008), which the owner sent to a later release as a reading.

## Acceptance

1. The four probes above, moved into the crate's tests, red at the base and green at the tip, plus tests for DECRST 47 and 1047, an exit and re-entry split across two reads, and each newly tracked mouse mode set and reset.
2. One mutation per guard (the order of transitions, each recognised form, each tracked mode) turns a test red.
3. A browser check in a guest, on both backends: a shell prints normal-screen text, then a `printf` enters the alternate screen with `\e[?1047h` and draws; a reload reattaches and the view holds no normal-screen text. And a program that sets 1015 and echoes what it reads: after a reload's reattach, a click reaches it in the urxvt encoding.
4. `crates/chan-library/design.md` says which forms the tracker reads and which modes the prelude re-asserts.
