# A command launcher run that opens nothing leaves the terminal deaf

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: asked by the owner on 2026-11-04 and built that day in another of the owner's sessions on `fix/launcher-run-returns-focus` off `main` at `720b543c0`, with browser validation in an isolated guest and a new browser check; merged into `v0124/int` as `d54a1875d`, again as `aab299375` for a desktop test the change broke, and as `7f9379e12` for a repair of its browser check. The owner's words are not on record in this item.

## What was seen

Choosing Toggle group broadcast in the command launcher left the terminal deaf: nothing typed reached the PTY until the terminal was clicked.

## Evidence

The command deck (`CommandDeck.svelte` in web-shared, mounted by the workspace app's `CommandLauncher.svelte`) closes before the chosen command runs and leaves focus where the command puts it. A command that opens no surface, such as a toggle that flips state, therefore left the keyboard on the document body. A prompt a command opens (Set terminal name, Set terminal group, the screen-lock PIN) lost the keyboard the same way when it closed, because its opener was the launcher's input, which was gone by then. Open's cancel path focused the element the launcher was last opened from, even when an assigned chord had run Open with no launcher open, which could move the keyboard to another terminal.

## Desired contract

1. A dismissal of the launcher hands focus back to the element it opened from, as before.
2. A run leaves focus where the command put it, before or after the run settles. A command that put it nowhere gets it handed back to the element the launcher opened from once the run has settled; when that element is gone or hidden under another surface, the host focuses its active tab instead (the workspace app bumps the tab focus pulse, which refocuses the active terminal, editor or Rich Prompt).
3. Neither restore happens while a survey is modal over the active terminal or the Computers launcher is shown over the window; both read the same guard as the terminal's own refocus.
4. A dialog a command opens as it runs takes the element the launcher opened from as its opener, so it returns focus there when it closes; a dialog opened from another control while a slow run is in flight returns focus to that control.
5. A cancelled Open returns focus through its own dialog: to the launcher's origin when the launcher ran it, to the control that held focus when a chord did.

## Boundaries

web-shared: `CommandDeck.svelte` (the settle, `deckPendingReturnFocus` cleared once the close has rendered, an optional `mayTakeFocus` predicate), `modalFocus.ts` (`canTakeFocus`, shared by the deck and the modal stack). Workspace app: `CommandLauncher.svelte` passes the guard, `ModalShell.svelte` and `modalStack.ts` take the pending opener, `state/focusGuard.ts` holds `launcherShownOverWindow` and `refocusRefused` for the terminal and the launcher, `TerminalTab.svelte` reads them, `state/commands/global.ts` drops Open's extra restore and the deck's last-opener export, and the design note. chan-desktop: the `launcher_panel.rs` test that pins the launcher-shown marker's spelling on both sides. Browser check 203. The launcher SPA mounts the same deck and takes the settle without a predicate.

## Acceptance

1. Deck tests: a chosen item that closes the deck and takes no focus hands it back; one that put focus somewhere, before or after it settles, keeps it; an awaited item's success and a failure after the close hand it back; a gone or hidden opener asks the host; a refusing host gets nothing; the pending opener is published until the close has rendered.
2. Launcher focus tests: a command that takes no focus, one whose surface takes it after an await, one whose surface takes it after the run, a command that removes the opener, a prompt asked by a command, a dialog opened from another control during a long run, a run settling under the Computers launcher, a window action closing the launcher after its success card, and a cancelled Open from the launcher and from a chord. The cases added after the review are red on the previous deck and the previous Open code.
3. Browser check `203-launcher-run-returns-focus`, one arm per terminal engine: Toggle group broadcast run by its web chord, then a typed marker read back from the PTY's scrollback; Set terminal name keeps the keyboard in its prompt and returns it after Escape. Red on the base at the first leg, with the keyboard on the body.
4. In chan-desktop on WebKitGTK and WebView2, the same two runs reach the terminal with no click, in a workspace window and in a standalone terminal window.

## Built

Four commits on the branch: `672533478` (the deck's restore and the pending opener), `18197e02c` (check 203), `ffd1a1463` (the pending opener ends at the close, `canTakeFocus` in web-shared, the `mayTakeFocus` guard through `state/focusGuard.ts`, check 203 resets broadcast in its finally), `0180b4cd8` (Open's cancel returns through its dialog). Then two repairs. `ffd1a1463` moved the page's `data-launcher-shown` check out of `TerminalTab.svelte` into `state/focusGuard.ts`, and the desktop test `the_covered_marker_is_the_one_the_terminal_reads` still read the terminal for it: CI 41927493155 at `038d82f42` was red on that one test in ci-linux, ci-macos, ci-windows and both AUR desktop builds, since the branch's gate was web-only and never ran the desktop suite. `d1e98d764` reads the spelling from the guard and checks that the terminal imports it and returns early on it. And `e6a7ea258` gives check 203's terminals a broadcast group of their own and waits for the roster to list that one session, so a terminal another check leaves in the default group cannot join the toggle.

Verification recorded in the commits and the branch's notes: the web-shared and workspace-app suites and svelte-check; `make web-check` at the tip; check 203 green alone on both engines in an isolated guest, with regressions 10, 15, 123, 178, 182, 195, 196, 197, 198 and 199. An independent review's findings were fixed as separate commits. After `d1e98d764`: the chan-desktop suite 743 of 743 at `aab299375` and CI 41939573022 there green in every job. Check 203 green after 201 with the repairs, and in the whole browser suite at `b2665def0` in suite order. Acceptance 4 in chan-desktop debug builds: on FreeBSD (Xfce, X11) and Arch Linux (KDE, Wayland) on WebKitGTK, driven by QEMU key events with a file oracle, the no-focus run and the Set terminal name prompt red 3 of 3 at `720b543c0` and green 3 of 3 at `0180b4cd8` in both window kinds; on Windows 11 in WebView2, red 3 of 3 with the published v0.123.0 installer and green 3 of 3 with the installer of Desktop Package Dry Run 41928160550 (`038d82f42`), standalone and workspace. Open and Escape was green at the base too (its dialog already returned focus there), so it shows only no regression.

Open: WKWebView on macOS was not read before the GA commit; the desktop runs did not drive the xterm.js engine and did not exercise the guard's refusals under a survey or the Computers launcher; the launcher SPA's deck, which takes the settle with no predicate, was not read after the change.
