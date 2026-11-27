# The attach prelude re-asserts every mouse mode a program set, where a terminal keeps only the last

Status: withdrawn, and it did not ship: the owner withdrew it on 2026-11-23 on the core reading (the last section); closed at [v0.134.0](../../release/release-v0.134.0.md), which records the decision. Record before the close: deferred earlier that day until the core's mouse state was measured (the section); accepted for v0.132.0 by the owner on 2026-11-17, by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"); not started. Moved by the owner to v0.133.0 on 2026-11-18, out of this cycle ("the fuse-mode appimage is def moving to next v0.133, out of this current cycle; mouse-mode prelude as well"). Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap").

Record: item 7 of `dev/v0131-team/reports/owner-candidates-2.md`, from a review of the attach path (`dev/v0131-team/reports/candidates.md`, 2026-11-14T23:24:27Z) and, in its partial-reset form, from `dev/v0131-team/reviews/review-altreplay-1a.md`, note 1 ("candidate follow-up: two single-valued registers"). [The reattach row](../done/a-reattach-replays-the-normal-screen-into-a-full-screen-program-and-drops-its-mouse-modes.md) grew the tracked set to twelve modes and kept the set shape. No reproduction with a real program; programs normally set one tracking mode and one encoding. Nothing is lost.

## What is there now

Read at `b73773a93`, by reading; not run.

- The server records the tracked private modes a program has on as a set (`Session::private_modes: Mutex<BTreeSet<u16>>`, `crates/chan-library/src/terminal_sessions.rs:5031-5035`). Each DECSET inserts its mode and each DECRST removes that one mode (`update_private_modes`, `:7660-7696`). The attach prelude writes `\e[?<n>h` for every mode in the set in ascending order (`private_mode_prelude`, `:7712-7725`), after the alternate-screen prelude and before the redraw nudge (`crates/chan-server/src/routes/terminal.rs:1752-1775`). The set is persisted for an fd-store restart (`crates/chan-library/src/terminal_sessions/ring.rs:284-287`). `crates/chan-library/design.md:120` says "in numeric order".
- The set holds two exclusive families (`TRACKED_PRIVATE_MODES`, `:199-213`): tracking, 9, 1000, 1001, 1002, 1003; and encoding, 1005, 1006, 1015, 1016. The other three, 1, 1004 and 2004, are independent.
- xterm.js keeps one register per family (`web/node_modules/@xterm/xterm/src/common/InputHandler.ts`): DECSET 9, 1000, 1002 or 1003 sets `activeProtocol` to X10, VT200, DRAG or ANY (`:1919-1933`), so the last set wins, and DECRST of any of the four sets NONE (`:2160-2164`); 1006 and 1016 set `activeEncoding` to SGR or SGR_PIXELS (`:1944-1951`) and DECRST of either sets DEFAULT (`:2172-2179`); 1001, 1005 and 1015 are unhandled or logged as unsupported (`:1941-1942`, `:1947-1948`; `web/packages/workspace-app/src/terminal/mouseModeFilter.ts:33-36`).
- The ghostty widget reads each mode's own flag from the core (`web/packages/ghostty-web-ng/vt/ghosttyVt.ts:1005-1014`, `getMode`, through `ghostty_terminal_get`): tracking is on when 1000, 1002 or 1003 is on (`:1062-1064`), motion is reported when 1002 or 1003 is on with 1003 taking precedence (`lib/input-handler.ts:863-870`), and the encoding is SGR when 1006 is on, X10 otherwise (`:798-808`, `lib/terminal.ts:415-417`). So on ghostty the set of flags decides, not the last set, and the five other modes have no input implementation there. What the core's own effective mouse state is with two tracking modes set is not established from the vendored `ghostty-vt.wasm`.
- The divergence after a reattach on xterm.js, by reading. Order: a program sets 1003 then 1000; the terminal that saw the stream is at VT200; the prelude sends `\e[?1000h\e[?1003h`, so the reattached terminal is at ANY and reports motion the program last asked not to have. The same for 1016 then 1006 (SGR live, SGR_PIXELS after the reattach). Partial reset: a program sets 1002, then 1003, then resets 1003 alone; the live terminal is at NONE, the set still holds 1002, and the reattached terminal reports drags to a program that turned tracking off. On ghostty the widget's flag reading gives the live and the reattached terminal the same answer in both cases, which differs from xterm.js's in both.
- The tests pin the set semantics for independent modes (`private_modes_track_set_and_reset`, `:10829-10838`, modes 1 and 1000) and the grouped parse (`:10841-10845`, htop's `\e[?1006;1000h`).

## Desired contract

1. For each exclusive family, the server keeps the mode set last: tracking (9, 1000, 1001, 1002, 1003) and encoding (1005, 1006, 1015, 1016). Setting a mode of a family replaces the family's mode; resetting any mode of the family turns the family off, as xterm.js does for the modes it implements.
2. The attach prelude re-asserts at most one tracking mode and one encoding, the ones on, with 1, 1004 and 2004 as today.
3. The independent modes keep today's semantics. The persisted state carries the same registers; a manifest written with several modes of one family restores one mode per family by a rule the design document records.

## Boundaries

- `update_private_modes`, `private_mode_prelude` and the persisted state in `crates/chan-library/src/terminal_sessions.rs` and `terminal_sessions/ring.rs`, with their tests; the ring header's flag bits stay as they are, since a register is a set with at most one member.
- The ghostty widget's flag reading stays as it is; the difference it keeps after this change is recorded in `crates/chan-library/design.md`, and aligning it is the owner's call (the decision below).
- Not here: the alternate-screen tracker, the replay, and the client's fresh-shell reset ([the fresh-shell row](../done/a-fresh-shell-after-a-dead-full-screen-program-keeps-some-of-its-input-modes.md) compares its list with the server's set, which keeps its twelve members).

## Acceptance

1. Crate tests, red at the base: `\e[?1003h\e[?1000h` gives a prelude of `\e[?1000h` alone; `\e[?1002h\e[?1003h\e[?1003l` gives no tracking mode; `\e[?1016h\e[?1006h` gives `\e[?1006h` alone; `\e[?1006h\e[?1016h\e[?1016l` gives no encoding; a grouped `\e[?1006;1000h` still gives both; the existing independent-mode cases stay green; a persisted state round trip holds one mode per family.
2. One mutation per guard, the replace on set and the family-wide clear on reset for each family, turns a case red, and restoring it turns the case green.
3. A browser check in a guest on xterm.js: a program sets 1003 then 1000 and echoes what it reads; after a reload a click reaches the raw PTY as a VT200 report and a bare motion reports nothing; red at the base. On ghostty the socket's frames show the prelude carrying 1000 alone, as the reattach row's check reads the wire.
4. `crates/chan-library/design.md:120` and `crates/chan-server/design.md:124` say one mode per family, the reset rule and what the ghostty widget reads.

## Accepted, 2026-11-17

The owner accepted this row by survey at 2026-11-17T09:50Z, answering the first batch of candidates v0.131.0 took with no row ("Accept all six (recommended)"). The choice the draft left to him is taken as the draft recommended: option (a), the server only, with the ghostty widget's flag reading recorded in `crates/chan-library/design.md`. He may revisit it before the build. The options as drafted:

- (a) Server only (recommended): matches xterm and xterm.js; the ghostty widget's flag reading is recorded, so on ghostty a reattached terminal after a partial reset stops tracking where the live widget still reports (the widget's own divergence from the core, not the server's).
- (b) Server and the ghostty widget together: the widget follows the core's effective state or keeps its own last-set register from the stream; needs a reading of what `ghostty_terminal_get` exposes. Medium, touches `web/packages/ghostty-web-ng`.
- (c) Leave as is and record it: no reproduction with a real program.

## Deferred by the owner, 2026-11-23

With xterm.js leaving chan ([its row](../done/chan-carries-xterm-js-as-a-second-terminal-backend.md)), option (a) would repair no shipped client and would make a reattached Ghostty terminal differ from the live one after a partial reset (`dev/team-ghostty-web-ng-plan-review.md`, change 8). The owner answered the survey on 2026-11-23 with "Defer, measure core state in M1 (recommended)": nothing is built here for now. The vendored core's effective mouse state, with two tracking modes set, after a partial reset and with two encodings set, is measured and recorded in this row, and the owner then chooses option (b) or (c) on that reading.

## The core's mouse state, read 2026-11-23

Read on the vendored libghostty-vt 1.0.1 through the binding's `getMode` (the widget's own reads), nine streams each on a fresh terminal, by a probe run once in Node with rc 0; not run in a browser and not through the server. The core keeps one flag per mode, not one register per family: after `\e[?1003h\e[?1000h` and after `\e[?1000h\e[?1003h` both 1000 and 1003 are on; after `\e[?1016h\e[?1006h` both 1006 and 1016 are on; a reset clears only the mode it names (`\e[?1002h\e[?1003h\e[?1003l` leaves 1002 on, so the widget keeps reporting drags). Mode 1001 is not a mode the core answers (its query returns an error status), and the widget's encoding is SGR whenever 1006 is on. Replaying the prelude the server builds today from its set gives the same flags as the live terminal in all nine cases, so on Ghostty a live and a reattached terminal agree now. Option (a) alone would make them disagree after a partial reset; option (b) needs the widget to keep last-set and family-wide-reset semantics of its own, since the core's flags do not carry them; option (c) keeps the agreement that was read.

## Withdrawn by the owner, 2026-11-23

On the reading above, the owner answered the survey with "(c) Close it with the reading (recommended)": the server keeps its set of modes and its prelude, which reproduce on Ghostty what the live terminal holds, so nothing is built. The row moves to `done/` at the release close, as withdrawn.
