# A reattach replays the normal screen into a full-screen program and drops its mouse modes

Status: found by the v0.131.0 round's terminal regression audit and accepted for v0.131.0 by the owner on 2026-11-14 ("Take all my recommendations", answering `dev/v0131-team/reports/owner-candidates-1.md`, item 1); server implementation verified; browser acceptance pending.

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
- Built before the fast stream row ([streamlag](../v0.132.0/a-terminal-that-falls-behind-a-fast-stream-loses-part-of-it.md)), which changes the attach and replay path around it.
- Not here: a replay that starts inside an escape sequence (the ring evicting whole chunks, entry T008), which the owner sent to a later release as a reading.

## Acceptance

1. The four probes above, moved into the crate's tests, red at the base and green at the tip, plus tests for DECRST 47 and 1047, an exit and re-entry split across two reads, and each newly tracked mouse mode set and reset.
2. One mutation per guard (the order of transitions, each recognised form, each tracked mode) turns a test red.
3. A browser check in a guest, on both backends: a shell prints normal-screen text, then a `printf` enters the alternate screen with `\e[?1047h` and draws; a reload reattaches and the view holds no normal-screen text. And a program that sets 1015 and echoes what it reads: after a reload's reattach, a click reaches it in the urxvt encoding.
4. `crates/chan-library/design.md` says which forms the tracker reads and which modes the prelude re-asserts.

## Ruling on acceptance 3, 2026-11-14

Found while drafting the browser check: neither of chan's terminal backends encodes clicks in the urxvt form. ghostty-web's input handler chooses SGR (1006) or X10 only (`web/packages/ghostty-web-ng/lib/input-handler.ts`, around 788 to 809), and xterm.js 6 logs DECSET and DECRST 1015 as unsupported (`@xterm/xterm/src/common/InputHandler.ts`, around 1947 and 2175); `terminal/mouseModeFilter.ts` records the same. So a urxvt click after a reattach cannot pass on either backend, whatever the server sends. The lead's ruling, inside the row's purpose:

- Contract 3 stays as written: the server re-asserts every mode the program left on, 1015 included, since that is the server's state to keep and a client that encodes it gets it.
- Acceptance 3's mouse arm becomes two parts: the reattach prelude, read from the socket's frames in the browser check, carries each tracked mode the program set (1015 among them); and a click after a reload reaches the program in the encoding of a newly tracked mode that backend does honour, on each backend that honours one (the build names which, from the backend's source, and says so for a backend that honours none).
- That neither backend encodes 1015 is recorded here, not built: it predates this row, and modern programs ask for SGR.

## Server implementation, 2026-11-14

Commit `434c1412e18419c3af5ff613542a6971c7e5ad14`, from base `5775af2ca6bc51d7b6c7fb07640a7b2e3ebd1b63`, uses one bounded private-mode scanner for both trackers. Alternate-screen selection follows the last 47, 1047 or 1049 transition, including grouped and split sequences. The prelude tracks the five additional mouse modes and preserves numeric order and rendering-mode exclusions. Five reserved flags carry the added modes across fd-store restoration without changing the fixed ring header or its version; the original seven slots retain their meanings.

The server evidence is in `dev/v0131-team/evidence/Core131/altreplay/`: `red.log` has 25 intended assertion failures and three passing controls at the base; `mutations-1/summary.json` records 25 assertion reds and 25 restored greens; `ring-compat.log` records actual old/new writer-reader compatibility in both directions. The committed scoped gate in `gate/` passed fmt, library all-target clippy, rustdoc and 573 terminal-session tests, with the existing host-profile printing test ignored. `dev/v0131-team/followups/followup-Core131-Lead131-13.md` identifies exact commands, hashes and limits. These are server proofs, not browser acceptance.

Check `scripts/e2e/browser-smoke/checks/270-alt-replay.mjs` prepares the guest reading: visible alternate-screen output and the actual 1047 reattach wire on both backends; all twelve tracked modes in the reattach prelude on both; and a trusted click reaching the raw PTY in 1016 pixel encoding before and after reload on xterm.js. Its installed xterm.js 6 source selects `SGR_PIXELS` for 1016. Ghostty's input binding chooses SGR cells or X10 from mode 1006 and recognises tracking modes 1000, 1002 and 1003; none of the five added modes has an input implementation there, so its new-mode reading is wire-only. Guest acceptance, the terminal regression suite on both backends and the two row reviews remain open.

## Browser selection setup, 2026-11-15

The J146 base run stopped before the xterm 1047 reload: its Shift-first drag left the clipboard sentinel unchanged. The other four arms reached the expected base defects, but the five-arm judge refused the incomplete xterm receipt; no tip or mutation ran. The pinned xterm.js 6.0.0 SelectionService control confirms that alternate-buffer activation clears the anchor, Shift-first cannot create one while selection is enabled, and an ordinary drag creates a selection. Three mutations of that control fail at their intended assertions. This is a source control, not a browser verdict.

Check 270 uses an ordinary drag in its 1047 arms, which enable no mouse reporting. It records bounded copy and focus receipts before and after explicitly focusing the owned textarea. The clipboard observer waits for drag and diagnostic writes to settle and requires a completed native write from the current phase, so an earlier copy cannot satisfy the post-focus sentinel. A pre-focus sentinel is diagnostic because focus routing and an empty selection can both explain it; the post-focus copy remains required. A successful diagnostic copy can itself refocus the terminal; the focus samples bracket the copy and explicit-focus sequence but do not identify the caller that changed focus. The visible-grid, sentinel, before/after marker, wire, cleanup and five-arm completeness guards remain. One bounded base, tip, six-mutation/restoration and 97+270 pair run is pending through Ops131; unexpected setup failures stop the sequence.

## Regression proof boundaries, 2026-11-15

Check 270 proves the 1047 replay fix on the wire: `replay_bytes` must be zero and the normal-screen marker must be absent from the attach binary. Its visible-grid assertions verify the initial alternate draw, live output after reload and the rendered result; they do not independently distinguish the replay defect, because replayed clear sequences can erase the normal-screen text before the visible capture. The browser comparison remains pending through J217.

The DECRQM tests query 1047 while the alternate screen is active and 1015 while that input mode is enabled, and require both trackers and their attach behavior to stay on. One mutation accepting every private-CSI final byte makes both tests fail at their tracker assertions; restoring the guard makes both pass. The stale substring-only sniffer test is removed. Check 270 and its attachment helper use the shared backend-surface export; the browser base carries the same pinned test-helper instrument as the tip. Local proof records are under `dev/v0131-team/evidence/Core131/altreplay/fix49/`; the revised browser matrix and confirm review remain pending.

## Merged, 2026-11-16

`v0131/altreplay` at `c02814385` (from `5775af2ca`) merged into `v0131/int` as `2e02485a8`. Four reviews accepted it: two readers of the server range (`dev/v0131-team/reviews/review-altreplay-1a.md`, `-1b.md`: one should-fix, the DECRQM guard with no test, and notes), a confirm read of the fix round that added the two DECRQM tests and removed the stale sniffer test (`-2.md`, notes), and a confirm read of check 270 (`-3.md`, notes).

- Acceptance 1 and 2: the crate tests in `terminal_sessions/tests/alt_screen_tests.rs`, red at the base and green at the tip, and one mutation per guard red and restored green, as the server sections above record.
- Acceptance 3: J231r2 ran check 270's matrix in a rig guest under a short output root (`dev/v0131-team/evidence/Ops131/J231r2/run/heavy/verdict.txt`). The base reads red and the tip green; the 1047 mutant and each of the mouse-mode mutants 9, 1001, 1005, 1015 and 1016 read red, and each restored run green; checks 97 and 270 pass side by side twice with no skip; both trees are clean after the run. It replaces J222, whose restored reading could not open its socket under a longer root. The click arm reads on xterm.js, in the 1016 encoding; ghostty encodes none of the five added modes, so its arm is the wire only, as the ruling above allows.
- Acceptance 4: `crates/chan-library/design.md` names the forms the tracker reads and the modes the prelude re-asserts.
- At the merge: the integration branch's `scripts/e2e/browser-smoke/lib/terminal-attach.mjs` is kept, since it already carries the shared surface export this branch added; the terminal manual's reattach line names the restored modes; the fast stream link points at v0.132.0.
- Merge checks at `2e02485a8` on the host: `cargo fmt --check`; chan-library clippy with all targets and rustdoc, both with warnings denied; 583 terminal-session tests passed with the existing host-profile printing test ignored; `node --check` of check 270; `make web-marketing-check`; the tree clean after (`dev/v0131-team/evidence/Lead131/merge-altreplay-2e02485a8/`).
- `dev/v0131-team/terminal-regressions.md` marks T005 and T007 covered, and the terminal suite gains check 270.

Closed.
