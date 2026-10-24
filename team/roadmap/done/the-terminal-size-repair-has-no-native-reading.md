# The terminal size repair has no native reading

Status: closed at [v0.109.0](../../release/release-v0.109.0.md) by its native reading, which found no fault; the reading's harness under `scripts/e2e/desktop-observations/` shipped with it, and the section Measured 2026-10-21 holds the record.

Record before the release: closed on 2026-10-21 by the native reading; the section Measured 2026-10-21 holds the record.

Record before the release: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: raised by the lead at the v0.106.0 GA cut on 2026-10-15 from the open native reading of [An agent's terminal renders at the wrong size after pane splits and tab moves](an-agents-terminal-renders-at-the-wrong-size-after-pane-splits-and-tab-moves.md), whose repairs shipped; written down, not designed, not accepted for build; owner the desktop seat.

## What is open

The item was raised by the owner on 2026-10-12 from daily use with agent tabs. The two repairs (a hidden terminal view no longer sends its grid to the shared PTY; the hidden-dial token) and the size instrument landed and were read, and the four arms (default and two-page, both terminal backends) were green at the landing and at both candidates, in Chrome on Linux. No reading was taken in a native engine (Linux WebKitGTK, macOS WebKit or Windows WebView2), and the item's own line stands: not established, the DOM path in the app or under WebKit. The instrument has one recorded limit: on a DOM renderer the surface reading judges a frame only when both end rows span the grid, so it confirms a right frame and never refutes a wrong one, and the verdict there is the redraw records'. Two small repairs are named with the native reading: an unreadable DOM surface at a shown checkpoint as a finding of its own, with the preflight's missing-corner row taking the real shapes; or the README saying the DOM reading confirms only, with the native reader looking at each step's `readable`. Six clauses of the DOM branch have no row (the row count, the two length clauses, the first row's corner, the two selectors) and belong with that repair.

## What to do

Run the size instrument's default arm in a native desktop build (the desktop seat's Linux WebKitGTK build first), with the engine named, every size told to the program recorded, and the DOM branch's reading made a finding or declared confirm-only as above; the six clauses get their rows in the same change. The README's native section is the recipe for a later WKWebView or WebView2 reading; no macOS or Windows run sheet is prepared in this version.

## Boundaries

The reading changes no product file; a difference it finds is a row of its own.

## Acceptance

1. One native run recorded with its engine, its checkpoints and every size told to the program, equal to the Chrome arm's or with each difference named.
2. The DOM branch's limit repaired one of the two ways, with the six clauses pinned.
3. If a difference is a product fault, a row for it with the reading; otherwise the item closes measured.

## Measured 2026-10-21

The lead opened a ninety-minute lead-idle window at 16:17:05Z with the integration guest idle; the other two seats' guests continued at two CPUs each. In the Hygiene guest, the release `chan-desktop` built by `cd desktop && make build` and the debug `chan` built by `cargo build --locked -p chan -j2` came from `d360ba7e2ab60e40ffe08eb45dfa6765ee9560fd`, with no product source edit. The desktop binary SHA-256 was `45322255a82c9924a8bc732ad8c761e9d7e35636c076c502840d038397c91452`, and the CLI SHA-256 was `e0fb34ff03b6d6b2dd25eb65fcf368e18d73e9398b22cbc8afa5cb91bc81bdb4`. The desktop binary links `libwebkit2gtk-4.1.so.0` (`ldd`), installed as `libwebkit2gtk-4.1-0:amd64` `2.52.6-0ubuntu0.24.04.1`; its page answered WebKit's remote inspector and its mounted terminal renderer was Ghostty. WebKitGTK ran under Xvfb with software GL, the DMA-BUF renderer disabled, the web-process sandbox disabled and `GDK_BACKEND=x11`. The Xvfb screen was 1600 by 1000, and the mapped workspace window was 1200 by 800; `window-before.png`, X geometry and the answering WebKit inspector establish the window before the instrument started its size sequence.

The native default arm completed three cycles and 34 checkpoints, with 57 probe events, no findings and a `bounded-search-no-fault` verdict. The full-screen arm completed one cycle and 12 checkpoints, with 32 probe events, 10 redraws, no findings and the same verdict. At every shown checkpoint in both arms, the PTY, page grid, sent size and independently fitted cells agreed; at the six hidden default checkpoints the PTY stayed at the last shown size. The full-screen renderer was a canvas: all ten shown surfaces had `readable=false`, so the DOM surface establishes no border result in this arm; the redraw records and checkpoint sizes carry the verdict. Its final screenshot visibly shows both far frame corners at 146 by 35. The full-screen clock uncertainty was 0.798 ms and the default arm's was 0.714 ms under the declared 1 ms WebKitGTK page-clock step.

The same-source Chrome for Testing `156.0.8078.47` Ghostty control completed three cycles and 34 checkpoints, with 58 probe events, no findings and the same verdict; its page-clock uncertainty was 0.195 ms. Every absolute checkpoint grid differs from the native Ghostty grid: Chrome's 1600 by 1000 viewport gives a 1592 by 992 pane, while the native window gives a 1192 by 792 pane. Both engines measured an 8 by 21 px cell pitch, 8 px padding, zero scrollbar and host insets of 2 px wide and 35 px high at all 34 steps. Each pane-width difference is the same fraction of the 400 px viewport-width difference for its label in every cycle: 1 at initial and close-right, 0.5 at the two splits, 0.62 at unequal-width, 0.38 at move-bottom, move-right, close-bottom and hide-probe, 0.48 at resize-hidden and show-probe, and 0.52 at move-left. Heights differ by 200 px except the two bottom-pane steps, which differ by 100 px; each grid fits its own host box. The arm records and `evidence/Review109/tsznat/viewport-fractions.txt` carry the 34-step comparison. The table below names the initial checkpoint and each action's value in all three cycles; each run agrees with its own PTY and fitted grid.

The probe's startup sequence was native default born at `146x34`, then signaled `146x35`; Chrome born at `196x44`, then signaled `196x43` and `196x44`; and native full-screen born at `146x35`, then signaled `146x34` and `146x35`. These are the attach's one-row pair, with the birth size depending on when the program starts against the attach. After the initial checkpoint, the default arms each delivered 21 signals, label for label; each page arm had 11 attaches (one hidden dial with no session id and ten shown), 58 resize frames, no frame from a hidden view and no unjudged hidden-dial width. The extra Chrome probe event is its startup signal, not a checkpoint disagreement.

Two more arms selected xterm through the native WebKitGTK page, with the page reloaded before the sequence so its mounted renderer matched the preference. The default arm completed three cycles and 34 checkpoints with 57 probe events, and the full-screen arm completed one cycle and 12 checkpoints with 32 probe events and 10 redraws; both exited 0 with `bounded-search-no-fault` and no finding. Xterm is the desktop default on macOS and Windows, while Ghostty is the Linux default. All ten shown xterm full-screen DOM surfaces were readable and had both far corners; the final screenshot also shows the 145 by 35 border. The two arms' PTY, page grid, sent grid and fitted cells agreed at each shown checkpoint, and the hidden checkpoints preserved the prior PTY size. The default arm started at `145x34`, then signaled `145x35`; the full-screen arm started at `145x35`, then signaled `145x34` and `145x35`. Both used the same `d360ba7e2` binaries as the Ghostty arms, under Xvfb with software GL, the DMA-BUF renderer disabled and the WebKit web-process sandbox disabled. The two xterm arms ran from 17:03Z to 17:07Z in a second lead-idle window with the integration guest held idle; over the three xterm runs, the inconclusive first attempt among them, the Hygiene guest's cgroup read 18 throttled periods of 1,628 and no new memory or swap peak (`xterm-cgroup-start.txt`, `xterm-cgroup-end.txt`).

| Checkpoint | Native Ghostty | Native xterm | Chrome Ghostty |
| --- | ---: | ---: | ---: |
| initial | 146x35 | 145x35 | 196x44 |
| cycles 1 to 3 / split-right | 71x35 | 69x35 | 96x44 |
| cycles 1 to 3 / split-bottom | 71x35 | 69x35 | 96x44 |
| cycles 1 to 3 / unequal-width | 89x35 | 87x35 | 120x44 |
| cycles 1 to 3 / move-bottom | 53x16 | 51x16 | 72x20 |
| cycles 1 to 3 / move-right | 53x16 | 51x16 | 72x20 |
| cycles 1 to 3 / close-bottom | 53x35 | 51x35 | 72x44 |
| cycles 1 to 3 / hide-probe | 53x35 | 51x35 | 72x44 |
| cycles 1 to 3 / resize-hidden | 53x35 | 51x35 | 72x44 |
| cycles 1 to 3 / show-probe | 68x35 | 66x35 | 92x44 |
| cycles 1 to 3 / move-left | 74x35 | 72x35 | 100x44 |
| cycles 1 to 3 / close-right | 146x35 | 145x35 | 196x44 |

Native xterm and Ghostty grids differ at all 34 default and all 12 full-screen labels by one or two columns, with equal rows. Their pane and host boxes match at every label, and both measure an 8 by 21 px cell pitch; xterm reports a 14 px scrollbar where Ghostty reports zero, and its measured screen box is 8 px narrower at initial and close-right and 16 px narrower at the other labels. Each grid fits its renderer's measured screen box, and each PTY agrees with that grid; the same mapping repeats in all three cycles and the full-screen arm. `xterm-default-comparison.json` and `xterm-fullscreen-comparison.json` record every label. The difference is a measured renderer geometry difference, with no size fault or load-sensitive symptom in these arms.

The README states the DOM surface's confirm-only limit and requires each shown checkpoint's `readable` field to be read. The instrument's preflight pins the row count, first and last lengths, first and last far corners, and tab and row selectors; one deletion mutant per DOM clause failed at its own assertion before the unmutated preflight passed, as did the step-guard and socket-suffix mutants in their tests. No product fault was observed in these bounded Linux WebKitGTK readings of Ghostty and xterm. No macOS or Windows run sheet was prepared in this version, and WKWebView and WebView2 remain unmeasured; a reading of either needs a driver of its own.

The three earlier arms ran the instrument as an uncommitted overlay on `d360ba7e2`; each arm's `reader-preflight.json` equals the committed reader's preflight output, and both native `run.json` files carry `pageClockStepMs: 1` and `tabMoveInput: DOM DragEvent` from the committed driver, though no per-file hash was taken during those arms. The two xterm arms ran the revised driver as a dirty overlay on `30e3f3e31`, with their `run.json` source labels marked `-dirty` and `instrument-sha256.txt` recording the driver and reader files; the first xterm attempt was inconclusive because the updated preference had not yet been consumed by the page, so the driver reloads it before installing the observer and the two counted arms, and that attempt remains in `xterm-default-window-first/`. The retained records are `dev/v0109-team/evidence/Hygiene109/tsznat/`: the three earlier arm directories, `xterm-default-window/` and `xterm-fullscreen-window/` hold `run.json`, `summary.json`, probe and screenshot evidence; their `.log` and `.status` files hold the driver results; the comparison JSON files name the checkpoint differences; `inputs/` holds the comparison and mutant scripts with SHA-256 lines; and `commit-gate-4.log` and `mutants-4/` hold the final at-commit checks and mutant assertions. Each private server log remains inside the disposable guest and is excluded from the exported records.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "tsznat, the terminal size repair's native reading: carry"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.
