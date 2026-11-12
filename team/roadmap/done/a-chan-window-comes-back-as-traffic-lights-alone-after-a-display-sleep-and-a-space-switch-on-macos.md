# A chan window comes back as traffic lights alone after a display sleep and a Space switch on macOS

Status: shipped in [v0.128.0](../../release/release-v0.128.0.md).

Record before the release: raised by the owner on 2026-11-11 from a screenshot of his Mac and built outside the team by his Mac agent from the lead's order (`dev/owner-order-macos-wake-blank-window.md`, base 088322f3a), handed to the team as `owner/macos-wake-repaint` at 5ed8f975a (two commits on 10ce56abd) and taken in as an intake for v0.128.0 with one team follow-up commit. The fault was in the page, not in the desktop's wake repaint schedule.

## What is there now

v0.125.0 shipped the macOS wake repaint: every chan window is transparent, WebKit hides a webview's content until its web process commits a frame, and the desktop asks the page for a frame one second after the latest wake or turn to visible ([the done row](../done/windows-come-back-see-through-after-a-display-sleep.md)). v0.127.0 closed [the WKWebView visibility row](../done/the-terminal-tab-assumes-wkwebview-fires-no-visibilitychange-across-a-sleep.md) on the owner's word with its reading procedure written and never run. The owner still saw, with a display sleep and a switch between Spaces at about the same time, a window that came back as its three traffic lights over the wallpaper, its content arriving seconds later.

## Desired contract (the owner's order)

1. Measure before changing anything: how long the window shows only its traffic lights, per shape (a display sleep; a sleep with a Space switch; a Space switch alone after five minutes hidden; a sleep long enough for WebKit to suspend the web process), with a timeline from the page probe and the unified log.
2. Fix what the timeline shows, keeping the v0.125.0 constraints: nothing changes size, windows stay transparent, no page reloads.
3. Revive the reading the closed row never ran as a documented procedure under `scripts/e2e/desktop-observations/`, measuring the blank per shape before and after.
4. The design documents gain the cause and the measured timeline; the done rows stay as they are, and this row records the build.

## Boundaries

- A remote window runs its devserver's page, so the fix reaches a devserver window only when that devserver is upgraded.
- The Linux reading stays `wake-present.sh` in the team's desktop guest; Windows has no driver (the hidden page's accumulation is the page's on any engine).
- Two findings from the measurement are recorded, not fixed here: a hidden page that WebKit suspends and resumes redials every terminal about every 20 s; a window's tab bar vanished once after a 17 s stall on a v0.128 desktop showing a v0.127.0 page, restored by a hide and show.

## Acceptance

1. The before measurement with the timeline that names the fault.
2. The after measurement: every window painted within the time the first signal arrives, the frames unchanged, the terminal background still showing the desktop.
3. `make web-check` green (the fix is in the page); the new tests red without the fix.
4. The owner clicks around after the fix and says yes.

## Built, 2026-11-11

The timeline named the fault: every terminal repaint requested while a window was off-screen queued its own animation frame callback; they all ran in the first frame back, and WebKit keeps the content hidden until that frame commits. The native repaint script was sent on time and waited behind them. A hidden page is asked often, because WebKit suspends it and each resumption reads to the wake detector and the PTY redials as a signal. `createRepaintScheduler` (`web/packages/workspace-app/src/terminal/renderer.ts`) now holds at most one pending repaint per terminal, on the next animation frame and once the fonts are ready, and `TerminalTab.svelte`'s recovery goes through it; a request while one is pending adds nothing, since the pending pass draws the terminal as it is then, and `cancel()` drops the pending work at teardown. Measured by the owner on macOS 27.0.1 across one 45-minute display sleep with six terminals printing, baseline and fixed devservers side by side: 19.5 s blank with 8,419 callbacks in the first frame (24.4 million `fillText` calls) against 0.20 s; an unfixed 0.127.0 remote window in the same wake was blank 21.3 s. `scripts/e2e/desktop-observations/macos-wake-blank.sh` reads each page's blank from the unified log (the view turning visible, the content hidden until the pending update, the layer tree unhidden) and fails over a limit; `scripts/e2e/wkwebview-stall-probe.js` names what a blank page was doing. Departures from the order, by the evidence: the fix is in the page, so the tests are vitest cases of the scheduler rather than Rust schedule tests; the measurement reads WebKit's log rather than screen captures; one side-by-side run rather than three runs per shape across four shapes. The owner's scoped terminal tests (466) and svelte-check were green on the rebased tip. The team's review (`dev/v0128-team/reviews/review-wake-repaint-intake.md`) accepted the branch with one follow-up commit (bee1314b4): the scheduler keeps its frame armed under a frame host that runs the callback before returning, which the component tests' stub does, so those tests now prove the frame repaint and not only the fonts path (a unit test over a synchronous host and a second pass of the TerminalTab repaint tests with fonts that never load); the review's residual, the same pile-up in `queueFit()`, is a leftover. The merge gate ran `make web-check` and `make shell-check` on the integration branch (a34960489). `desktop/design.md` and the web app's `design.md` describe the cause and the bound. The owner's walk (acceptance 4) is his own measurement; nothing here needs a further Mac step.
