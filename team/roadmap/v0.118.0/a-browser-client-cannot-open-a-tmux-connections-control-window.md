# A browser client cannot open a tmux connection's control window

Status: accepted for v0.118.0 by the owner's survey answer of 2026-10-31 (the section Owner's decision), not started: a browser client keeps the control tab in the source window while the connection runs, and check 195 models that. Raised at the v0.117.0 GA on 2026-10-31 from browser check 195's first runs against the release tree in the Linux sdme guest.

## What was asked

Nothing was asked yet; this is a finding of the cut. The tmux item's stage 9 design mints the connection's control window hidden, as the card's control row with no show or focus, and the desktop drops the control tab from the source window once the first tmux window is minted. The browser client follows the same `release_term` command by opening the control window itself (`store.svelte.ts`, the `release_term` arm) through the scoped launch route; a refused open keeps the tab.

## Evidence

Check 195 (`scripts/e2e/browser-smoke/checks/195-tmux-control-mode.mjs`), rewritten for the card model on macOS and run for the first time at the cut, in the guest (Ubuntu 26.04, Chrome 156, tmux 3.6) against the merged release tree: three runs alone, each red at `the source window let the control tab go did not appear within 30000ms`, after the control and tmux windows were minted and the connection record and the card were read. The source page's log holds the cause: `GET /api/library/command-capabilities/{capability}/windows/{control}/launch` answered 409, which `handle_library_command_launch` (`crates/chan-server/src/routes/library.rs`) gives when the window record has no tenant token (`window tenant is not running`); a window minted hidden has no tenant until it is shown, and the card offers the control row no show. The source page therefore keeps the control tab, as the arm's refusal path says. In the desktop the arm drops the tab at once and the hidden control window is the design, which the owner's hand tests of 2026-10-30 passed; the first run of the check also found it reading the control row's `label` where the name is the row's `title`, fixed at the cut (`703c0609f`).

## Desired contract

To decide: either a browser client keeps the control terminal in the source window while the connection runs (then the check models that: the source keeps its tab, no control page exists, and the control-mode chrome assertions go), or the browser opens the control window on `release_term` (then the launch route must serve a hidden row's page, or the library mints the control window shown for a browser-origin source). Whichever is chosen, the connection's end must leave the browser's control terminal usable: the `control_release` command goes to the control window's page, which in the browser is the source page's tab today.

## Acceptance

1. Check 195 green alone and in the whole suite in the Linux guest, modelling the chosen browser behaviour.
2. The connection's end in a browser leaves the source window's terminal a plain, typing terminal.

## Owner's decision, 2026-10-31

Surveyed in the owner's window on 2026-10-31 with three options: keep the control tab in the source window in a browser; open the control window in the browser too; defer to v0.119.0. The answer, in the survey's words: "1 Keep the control tab in the source window (recommended)". So the contract is the first arm of the Desired contract: a browser client keeps the control terminal in the source window while the connection runs, no control page exists in a browser, and check 195 models that (the source keeps its tab, the control-mode chrome assertions go). The connection's end must still leave that terminal a plain, typing terminal: `control_release` goes to the source page's tab. The desktop's hidden control window is unchanged.
