# An agent's terminal renders at the wrong size after pane splits and tab moves

Status: raised by the owner on 2026-10-12 from daily use with agent tabs; written down, not reproduced, not designed. Accepted into v0.106.0 on 2026-10-12 by the owner asking for it, at the round launch of that day: its first step (the reproduction, search or probe named below) is accepted, and nothing past the decision it names.

## What was seen

The owner's words: "Terminals with agents can struggle to render the correct size after a pane is split.. codex some times just keeps flickering and claude renders a smaller version of the agent until i resize the terminal a bit; codex never records, claude does for a while but eventually renders smaller again; something after split pane a few times and moving tabs around". ("records" is read here as "recovers".)

Two different symptoms on full-screen terminal programs after the pane's size changed: one program redraws continuously (flickers), the other draws for a grid smaller than the pane until a manual resize, and later falls back to the smaller grid again. Both fit a terminal whose program was told a size other than the one the pane has, or was told two sizes in alternation. Not read at source to a cause. The sizing path is `web/packages/workspace-app/src/terminal/resize.ts` (the grid proposed for a measured host), the resize observers in `components/TerminalTab.svelte` and `components/Pane.svelte`, and the `resize` frame to the server's PTY. Not established: the sequence of splits and moves; whether the page's grid and the PTY's window size disagree when it happens, or agree on a wrong size; whether a second window on the same session (a co-viewer with another size) is involved; whether hidden tabs, which have no measurable size, send a resize; which terminal backend.

## Desired contract

After any split, close or move, a visible terminal's grid matches its pane, the PTY's window size matches the grid, and the program receives one resize for the settled size, not a stream of alternating sizes. A terminal that is not visible sends no size.

## What to do

Build the instrument before the hunt: a probe program in the terminal that prints the size from each `SIGWINCH` with a timestamp (kept alive, as the browser checks' PTY probes are), read beside the page's grid (`cols` and `rows`) and the pane's box. Then drive splits, closes and tab moves between panes in a guest's Chrome, several times in a row as the owner describes, on both backends, and record every resize the program sees. A wrong settled size, or more than one size after the layout settles, is the reproduction. Read whether one window alone shows it before adding a second. Then the repair, design to the reviewer first.

## Boundaries

`web/packages/workspace-app/src/terminal/resize.ts`, `components/TerminalTab.svelte` (its fit and resize effects), `components/Pane.svelte`, the tab move and split paths in `state/tabs.svelte.ts` where they trigger a fit, their tests; the server's resize handling in `crates/chan-server/src/routes/terminal.rs` only if the trace places the fault there; one browser check. Not changed: the agents themselves, the session's replay.

## Acceptance

1. A reproduction with the sizes the program received, the page's grid and the pane's box on one clock, for each backend tried; or a statement that a bounded search did not find one, with what was driven and the count.
2. After the repair, the same sequence ends with one size equal to the pane's grid, and no further resize arrives while the layout is still, in a browser check that is red on the base.
3. A terminal moved to a pane of another size receives that pane's size once it is visible.
4. A hidden terminal sends no resize, pinned.
5. One run with a real full-screen program (the check's own, not an agent CLI) showing its redraw at the settled size.

## Reproduction 2026-10-12

By the desktop seat in its guest, on one page in Chrome 155 headless at 1600x1000, with an instrument of three commits on its branch (`18e205b39`, `0e83144a3`, `8e9abce64`; `scripts/e2e/desktop-observations/terminal-size-probe.py`, `terminal-size-page.mjs`, `terminal-size-reader.mjs`, `terminal-size.mjs`, the README's line): a probe in the terminal records its start, every delivered `SIGWINCH` and each requested checkpoint from the real PTY on the kernel's monotonic clock; a page observer keeps the renderer's published grid and the pane, host and screen boxes without touching frames; the reader joins the two clocks and keeps the page samples bracketing each signal. Each run drives, three times over, split right, split bottom, unequal widths, move bottom, move right, close bottom, hide the probe beneath another tab, resize the hidden pane, reveal, move left and close right: 33 layout actions, 34 checkpoints (28 visible, six hidden), 23 delivered signals, every signal bracketed, clock uncertainty under 0.1 ms. On both backends every visible checkpoint's PTY size, renderer grid and computed pane fit are equal, and no signal arrives after the layout settles (750 ms of still geometry, then at least 2,100 ms of observation): the owner's visible flicker and smaller settled grid were not reproduced in this bounded one-window search. The search did find one violation of this item's contract: a hidden terminal sends a size, three times per run on each backend (xterm 70x44 to 90x44, Ghostty 72x44 to 92x44, while the probe's tab is covered), read on the PTY and in the renderer's published grid alike. Retained: a first run that collapsed its source pane on a move (repaired in the instrument by anchor tabs), and a second whose reader measured a native scrollbar in place of xterm's reserved gutter and so reported false fits (corrected, with a constructed control that loses the gutter on purpose). Not exercised: a native engine, a real agent, a second page, a full-screen program. Records: `reports/report-Desktop106-termsz.md`, `tasks/task-Desktop106-Lead106-4.md`, `evidence/Desktop106/termsz-*`.

Lead's ruling: acceptance 1 is met as a bounded search with its count and one measured contract violation. The item goes to a design for the hidden send (acceptance 4, a hidden terminal sends no resize, pinned by this instrument) and for the once-visible size (acceptance 3), reviewed before code; the source read names the unguarded resize and fit paths of `TerminalTab.svelte` under `visibility: hidden` sizing as the place to read first, which is not yet evidence of the owner's symptom. The instrument's co-viewer arm, implemented and unrun, is one more bounded search for the owner's symptom before the cut if the lane's time allows; otherwise the owner's reading is asked for in the survey.
