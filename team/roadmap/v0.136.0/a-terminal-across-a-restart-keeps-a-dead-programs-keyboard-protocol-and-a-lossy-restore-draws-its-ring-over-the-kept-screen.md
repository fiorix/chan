# A terminal across a restart keeps a dead program's keyboard protocol, and a lossy restore draws its ring over the kept screen

Status: accepted by the owner on 2026-11-26 (the last section); not started. Not built in v0.135.0 (D126 item 1), so it moves to the next version before GA, as the roadmap's Lifecycle 5 moves a deferred item. Moved to v0.136.0 at the v0.135.0 GA on 2026-11-27.

Record: two pre-existing defects found while the app half of [the redial row](../done/a-redialed-terminal-keeps-a-dead-programs-modes-and-a-short-ack-wedges-a-view.md) was built, which the owner accepted as one row under the lead's name for it, "a terminal across a devserver restart in place" (`dev/v0135-team/decisions.md`, D126 item 1). (a) The fresh dial: the Term seat's hand-back, "Adjacent, not built" (`dev/v0135-team/followups/followup-Term135-Lead135-36.md`), recorded for the owner by D99 item 3. (b) The lossy restore: the second-lens review of the app half, S1's "Context, N3c" and "Adjacent, predates the range" (`dev/v0135-team/reviews/review-u6-app-d.md`), recorded for the owner by D106. The redial row closed with a related limit stated and not built: a lossy restore's answer to a cut redial can apply a kitty keyboard push twice (N3, its "Closed, 2026-11-26").

By the code, the two restarts differ. The restart of (a) is a session's restart in place: a new PTY under the same session id with its generation bumped (`TerminalSessions::restart`, `crates/chan-library/src/terminal_sessions.rs:3120-3124`; `crates/chan-library/design.md:118`), as the Restart terminal command (`app.terminal.restart`, `web/packages/workspace-app/src/state/commands/terminal.ts:129`) and `cs terminal restart` (`term_restart`, `crates/chan-server/src/control_socket.rs:5130-5150`) do. The restore of (b) is a devserver's own restart under systemd, whose fd store keeps the terminals alive (`crates/chan-library/design.md:142`); a restore that may end behind the previous process bumps the generation too and keeps the old one (`terminal_sessions.rs:4978-4988`).

## What is there now

Read at `aabb9d039`, by reading; the stand-in readings are named.

- The server resets a view ahead of its session frame only for a dial whose echoed generation is neither the live one nor the one a lossy restore continues (`stale_generation`, `crates/chan-server/src/routes/terminal.rs:1321-1331`; the reset's doc at `:39-47`).
- (a) A fresh dial echoes no generation: the tab sends one only when it resumes from a cursor (`liveResumeGeneration`, `web/packages/workspace-app/src/components/TerminalTab.svelte:1638-1639`). So across a restart in place a fresh dial gets no reset. After a cut, the tab's reset replay restores the keyboard protocol saved before the cut replay (`:1736-1744`, armed at `:1838`), and the snapshot is retaken at the session frame only when the dial echoed a generation that the answer does not match (`:1859-1864`), which a fresh dial never does. A reload restores the saved snapshot (Term-36). Either way the dead program's keyboard protocol reaches the new program. By reading in Term-36's hand-back, not run: the same effect for a redial that echoed a generation was read red there (modifyOtherKeys 2 and kitty flags restored, so Shift+Enter reached the new shell as `ESC[27;2;13~`) and fixed by its P2, which covers only that redial; the plain-reload form predates the redial row.
- (b) On Linux, a clean-close redial answered by a lossy fd-store restore (`Resume::PastLossyRestore`, `crates/chan-library/src/terminal_sessions.rs:1691-1694`, chosen at `:7243-7261`) gets the whole ring with no reset ahead, and the tab writes it over the screen it kept: rows repeat on the normal screen (the probe reads `["$ vim screen","$ vim screen"]`) and a kitty keyboard push is applied twice. The reviewer's mounted probe N3c is red at the tip and at the base; the server's answer in it was read from code and played by a stand-in, not a real fd-store restore (review-u6-app-d, "Not established").
- No snapshot rule in the tab passes both of the lossy restore's cut cases, because the tab cannot know the protocol at the restored ring's start (review-u6-app-d S1: N3 against N2).

## Desired contract

1. After a session's restart in place, a view that dials fresh (a reload, or a dial with no generation) ends with none of the dead program's keyboard protocol: no modifyOtherKeys level and no kitty flags the new program did not set.
2. After a lossy fd-store restore, a redial from a clean close shows the restored screen once: no row the view kept is drawn again under the replay, and each kitty keyboard push in the ring is applied once.
3. A lossless redial, a redial that echoes a generation, and a restore that does not end behind behave as today.

Where the fix lives (a server reset ahead of a whole-ring answer the view cannot continue, a field of the session frame, or the tab) is chosen after acceptance 1's reading.

## Boundaries

- The attach prelude (`crates/chan-server/src/routes/terminal.rs`), the session's resume choice (`crates/chan-library/src/terminal_sessions.rs`), and the tab's dial and session-frame handling (`TerminalTab.svelte`), with their tests.
- Not here: the fd store's parking and ring files. The redial row's other recorded limits stay as they are; N3 (the push applied twice after a cut) is read with item 2 and fixed with it only if the same change covers it.

## Acceptance

1. First, before anything is built, a real fd-store restore on a Linux devserver under systemd in an isolated guest, at the base: a restore that ends behind, then a clean-close redial of a view on the normal screen and of one whose program pushed kitty flags; record the rows and the flags each view shows. And a session restarted in place, then a reload of its view: record the bytes Shift+Enter sends to the new shell. This reading confirms or replaces the stand-in's.
2. Tests red at the base for each case the reading confirms, at the layer the fix lives: server tests on the attach prelude, mounted tests on the real core in the tab. One mutation per guard turns a case red.
3. Acceptance 1's reading again at the tip.

## Accepted, 2026-11-26

Accepted by the owner on 2026-11-26 ("agree with your list, let's set 11 for later cleanup in the next version", `dev/v0135-team/decisions.md`, D126 item 1), answering the lead's list, which made this row of two candidates of the round's hand-back (`dev/v0135-team/handback.md`, section 7, "Fresh dial across a restart" and "Lossy restore on Linux"). Before it, the owner had asked why the lossy restore would be dropped, and the lead answered that there was no technical reason and recommended it as a row with the fresh dial (D125, "Open with Alex"). Drafted as a lead document and not built in v0.135.0 (D126 item 1).

## Widened, 2026-11-27: a lost pop on the alternate screen

The owner added a third case to this row on 2026-11-27 ("yes", `dev/v0135-team/decisions.md`, D130), found by the Fable review of the lost tail's fix (`dev/v0135-team/reviews/review-d129-fable.md`, F6, probes 7a and 7b). A program on the alternate screen pushes kitty keyboard flags, and its pop falls in the bytes a lossy recovery misses. The view keeps the alternate screen's flags and stack, so a later program on that screen that never pushed reads `CSI ? 1 u` back for `CSI ? u`, and the tab's key encoder (`web/packages/workspace-app/src/terminal/keymap.ts`), which reads the same per-screen state, sends it kitty-encoded keys. On the normal screen the answer is 0, as the owner's Mac reading of check 2 found. The recovery suffix reconciles DEC private modes only. The reviewer's candidate: clear the alternate screen's kitty flags and stack when a reconciling answer takes the view off it. Contract, for this case: after a lossy recovery whose lost span holds a pop, no kitty flag the new program did not push reaches its keys. Acceptance: a mounted test on the real core, red at the base, and the case in acceptance 1's reading.
