# The screen lock lets keys, focus and viewers through to the window under it

Status: shipped in [v0.133.0](../../release/release-v0.133.0.md), not read in WKWebView, WebKitGTK or WebView2: while the screen lock is up, no key or focus reaches viewers, the date and link popovers, dialogs, desktop chords or the terminal's find input; full-window viewers stay open and paint under the lock, audio and video pause and stay paused after unlock, picture-in-picture ends, and a dialog that opens under the lock takes the keyboard when it lifts (`v0133/lockholes` at `471d05045`, merged as `1c5e1abfe`). Read by check 336, red at the base, green at the tip alone and with 302 to 305 and green in the whole browser suite on `49f7491b2`, and by the ghostty terminal suite; of four readers the first rejected the range on the slide player's fullscreen hole, since fixed, and the other three accepted with notes. Open for the owner: the walk on the Mac in WKWebView. Sound from cross-origin embeds keeps playing under the lock and is [a v0.134.0 row](../v0.136.0/a-youtube-embed-keeps-playing-under-the-screen-lock.md), by the owner's answer of 2026-11-21 ("yes", a separate row).

Record before the release: accepted for v0.133.0 by the owner on 2026-11-19 ("screen-lock: make an item for next version"). Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap"), and back to v0.133.0 when the owner landed it on 2026-11-21 ("yes merge lockholes now"). Built and merged into the integration branch. Open for the owner: the owner's walk on the Mac in WKWebView, and whether sound from cross-origin embeds gets a row of its own.

Record: the v0.132.0 review of the keyboard-owner arbiter closed the screen lock's holes in the code it rewrote (covers, dialogs, the close prompt, the Team dialog, menus) and named these, all older than that work and left for this row (`dev/v0132-team/reviews/stage-fix-kbd-arbiter-c-4.md` and `-c-5.md` in the development tree, read at `v0132/keyboard` `c809d3e40`, now merged). The arbiter is `web/packages/workspace-app/src/state/keyboardOwner.svelte.ts`; full-window covers hold the keyboard over the page and rank among themselves by paint; the screen lock paints at 39000.

## What is there now

- **Fullscreen viewers paint over the lock.** The image zoom, slide preview, diagram zoom and the shared viewer overlay paint at 40000 (`state/imageZoom.ts`, `state/slidePreview.ts`, `state/diagramZoom.ts`, `state/viewerOverlay.ts`), above the lock. A PDF, image or slide left open stays visible on a locked screen, and their document capture listeners take Escape while the lock holds the keyboard. A privacy defect as much as a keyboard one.
- **Editor popovers answer keys under the lock.** With the editor's date popover left open (`editor/overlays/date_popover.ts`), the arrow keys move its selection and Enter on the lock's PIN field commits a date into the document; the link preview popover (`editor/overlays/preview_popover.ts`) dismisses on Escape and opens its link on Cmd/Ctrl+Enter. Neither checks a cover.
- **A dialog that opens under the lock takes the keyboard off the PIN.** The dialogs' open-time focus (ModalShell's mount through web-shared's modal focus helper, `PromptModal.svelte`, `ConfirmModal.svelte`, `PathPromptModal.svelte`, `DraftCloseModal.svelte`) moves focus into them without asking the owner, so every key is dead until a click on the PIN.
- **Desktop chords act under the lock.** The desktop's key bridge dispatches `chan:command`; the App's own gate covers only its dispatch. `TerminalTab.svelte`'s listener opens the terminal's find bar (Cmd/Ctrl+F) and steps it (Cmd+G), and `Pane.svelte`'s reopen-closed-tab listener checks only `modalDialogOpen()`, so the reopen chord reopens a tab under the lock.
- **A terminal's find input after a move under a cover** focuses without asking `mayFocus`.

## Desired contract

1. While the screen lock is up, no key reaches anything under it and no focus move lands under it, whatever opens or was open: viewers, editor popovers, dialogs, desktop chords.
2. Viewers and editor popovers close as the lock comes up (or paint under it and take no key); after unlock the user finds the window as it was, minus what closed.
3. A dialog that opens under the lock waits: it takes the keyboard when the lock lifts, through the arbiter's hand-back.
4. `chan:command` listeners outside the App's gate return under a cover the way the App's own dispatch does.

## Boundaries

- The workspace app's viewers, editor popovers, dialogs' open focus and the two `chan:command` listeners; the arbiter's existing rules are consumed, not changed.
- The screen lock's own UI, PIN and timers are not touched.

## Acceptance

1. An end-to-end browser check that locks the screen (the page's served lock state with a PIN, as check 305 does) and tries each path: a viewer open at lock time (hidden, takes no key), the date popover open (Enter on the PIN commits no date), a dialog opened under the lock (the PIN keeps the keyboard; the dialog has it after unlock), the find and reopen chords as the desktop sends them (nothing happens under the lock). Red at the base for each.
2. Unit tests for each guard, red without it.

## Built, 2026-11-21

While the screen lock is up, no key or focus reaches anything under it: viewers, the date and link popovers, dialogs, desktop chords and the terminal's find input. Full-window viewers stay open and paint under the lock. A slide player cannot return to element fullscreen over it. Audio and video pause at the lock and stay paused after unlock, at their position, and media opened under the lock does not play. Picture-in-picture ends at the lock and is not restored. A dialog that opens under the lock takes the keyboard when it lifts.

Evidence, in the development tree, at `471d05045`:

- Check 336: red at the base; at the tip green in three runs alone and with 302 to 305. Two browser mutants, a refused request and the fullscreen listener, are each red on the intended assertion.
- The ghostty terminal suite green (33 ran). Checks 97, 178, 990 and 331 force xterm.js and did not run in it, by the owner's decision to focus on ghostty.
- The scoped gate green: `make web-check`, `make web-marketing-check`, `make e2e-check`, `make browser-smoke-lib-test` and `make shell-check`.
- Four readers. The first rejected the range on the slide player's fullscreen hole, since fixed; the others accepted, the last two with no blocking finding.
- Not read: WKWebView, WebKitGTK and WebView2, whose presentation and Tauri paths are unit tests with stubs, and real picture-in-picture.
- Known and open: sound from cross-origin embeds keeps playing under the lock, though nothing shows, and no browser check switches tabs under the lock with a deck open; unit tests cover those two focus guards.
