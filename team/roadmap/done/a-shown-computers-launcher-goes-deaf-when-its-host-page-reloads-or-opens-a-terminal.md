# A shown Computers launcher goes deaf when its host page reloads or opens a terminal

Status: shipped in [v0.124.0](../../release/release-v0.124.0.md).

Record before the release: landed on `main` at `720b543c0` on 2026-11-04, the commit the round's integration branch `v0124/int` was cut from, and carried no row until the GA. Reported once as a launcher that took no keys after a switch to another desktop and back, and not reproduced since. The two paths below were found by reading the code against that report. It continues [the-computers-launcher-takes-no-keys-after-an-app-switch](the-computers-launcher-takes-no-keys-after-an-app-switch.md), whose Open line named the first of them ("a host page that navigates or reloads while its launcher shows loses the marker until the next toggle").

## What was there

The Computers launcher is a second webview over the window's own webview and owns the window's keyboard while it shows. Since v0.122.0 chan-desktop marks the host page's root with `data-launcher-shown` while the launcher shows, and the terminal skips its resume refocus under the mark. Two paths still made the host's webview the window's first responder and left the launcher deaf until the next toggle:

1. A host page that finished loading under a shown launcher (a reload, or the connecting page reaching its live page) booted without the mark, and its terminal focused itself on load.
2. A terminal tab mounted, or given its pane's focus, under the launcher (a tab opened from `cs`) focused a fresh element through `focusTerminal`, whose guard covered a survey and not the launcher.

On both terminal engines that is a real focus change in the host page, which the native window answers by moving the first responder to the host's webview.

## Desired contract

1. While the launcher shows, nothing in the host page takes the keyboard: the terminal's mount, its pane focus and its resume refocus all wait for the launcher to hide.
2. When the window regains focus, and when a host page finishes a load under a shown launcher, the launcher holds the keyboard again with no click, and the new host document carries the mark.
3. A hide that races a host page load leaves no mark behind, and the terminal takes the keyboard on hide as before.

## Boundaries

`TerminalTab.svelte` routes every refocus through one guard that reads the mark; `launcher_panel.rs` gains `reclaim_keyboard`, `host_page_loaded`, a `WindowEvent::Focused(true)` arm on the host window, and an uncover after the hide unlists the launcher; `main.rs` hooks `on_page_load` (`PageLoadEvent::Finished`); `desktop/design.md` states the rule. No change to the launcher's page, its toggle chord or its transition.

## Acceptance

1. Mounted tests on both engines (`TerminalTab.test.ts`, `TerminalTab.ghosttyBackend.test.ts`): a terminal focused under the mark takes no focus and takes it once the mark clears; both red on the base.
2. A desktop test pins the window-focus arm, the load hook re-marking the host before it reclaims the keyboard, and the hide uncovering the host after it unlists the launcher; red with the arm removed.
3. On macOS, with the launcher shown: a host page reload and a terminal tab opened from `cs` leave the launcher taking keys with no click, and a hide hands the keyboard to the terminal.

## Built

`720b543c0`, fix(desktop): a shown launcher reclaims the keyboard after a host refocus. The new tests are `a terminal focused under the launcher takes the keyboard only after it hides` in both terminal test files and `a_shown_launcher_takes_the_keyboard_back_when_its_window_or_host_page_comes_back` in `launcher_panel.rs`.

Verification recorded in the commit: both mounted tests red on the base; the desktop test red with the focus arm removed; desktop fmt, clippy and tests and the full web check green. In the same release [a-command-launcher-run-that-opens-nothing-leaves-the-terminal-deaf](a-command-launcher-run-that-opens-nothing-leaves-the-terminal-deaf.md) moved the guard into `state/focusGuard.ts`, so the terminal and the command launcher's post-run restore read one function, and `d1e98d764` points the desktop test that pins the marker's spelling at that file.

Open: acceptance 3 was not read on macOS before the GA commit; Linux and Windows run the same reclaim and were not read either. Since the original report was not reproduced, whether either path was its cause is not established.
