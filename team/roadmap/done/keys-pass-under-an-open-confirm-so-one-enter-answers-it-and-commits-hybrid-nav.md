# Keys pass under an open confirm, so one Enter answers it and commits Hybrid Nav

Status: shipped in [v0.121.0](../../release/release-v0.121.0.md).

Record before the release: raised by the owner on 2026-11-01 from a screencast dry take, where it killed a running terminal; read from that take's recording and the code at v0.120.1, drafted for v0.121.0, and accepted by the owner on 2026-11-02 ("yes", to the lead's question whether to accept it for the build); not started.

## What is there now

On chan-desktop 0.120.1 for macOS, in a standalone terminal window, Cmd+W on a tab with a live shell raised "Close tab? Terminal-2 is still running. Close anyway?" with Close focused, and the dialog was left unanswered. Chords still reached the window under it for the next nine minutes, with the dialog on screen the whole time (frames of the take's recording from 10:30 to 19:08): Cmd+/ splits, then Cmd+. into Hybrid Nav, and `/`, `t`, Right and `[` staging a split, a terminal and a divider move. Meanwhile a log tailer had been started in Terminal-2 with `cs terminal write`, and the pane holding it was flipped to its side B. The Enter that committed the draft also pressed Close: the layout was committed and Terminal-2's PTY was killed, tailer and all. Nothing sent after the Cmd+W was meant as a close; a reader of the screen took the tab loss for a Hybrid Nav defect on a pane showing side B.

The path in the code:

- `onWindowKey` (`web/packages/workspace-app/src/App.svelte`) withholds app keys only behind a raised cover (`appInputBlocked`, `state/store.svelte.ts`, which counts `raisedCovers`), not under a modal. The modal stack's capture handler (`modalStack.ts`) takes Escape and Tab, and `ModalShell` stops propagation for Tab only, so Cmd+. reaches `enterPaneMode` with a confirm open.
- `ConfirmModal.svelte` answers Enter on its focused button with `e.target.click()` and `preventDefault`, and does not stop propagation. The same keydown reaches `onWindowKey`, which in pane mode hands it to `handlePaneModeKey`, and Enter commits the draft.
- The click resolves the confirm, so the pending `closeTabOnce` (`state/tabs.svelte.ts`) runs the terminal close sink, which closes the session.

The draft code itself is not at fault: entering pane mode clones both sides of every pane, the staged split and terminal touch only the new pane, and a commit kills no session (only a cancel reaps staged terminals). No test sends keys under an open confirm; `App.paneMode.test.ts` answers the Cmd+W confirm with a click.

## Desired contract

1. While a modal dialog is open, app chords and Hybrid Nav keys do not act on the window under it. Cmd+. does not enter Hybrid Nav, and a draft already staged is neither committed nor discarded by a key meant for the dialog. The macOS window cycler (Cmd+`) passes, as it does behind a cover.
2. A key the dialog handles, Enter on its focused button or Escape, is consumed there and reaches nothing else.
3. Tests in `App.paneMode.test.ts`: with two live terminals, fire `app.tab.close`, wait for "Close tab?", press Cmd+. and Enter, and expect pane mode inactive, the confirm answered once, and nothing else changed; with a draft staged and a confirm open, Enter answers the confirm and leaves the draft staged.

## Next

The row: the guard in `onWindowKey` and the propagation stop in `ConfirmModal`, tests red first.

## Closing

Built from `762f95240`. While a modal dialog is open, nothing acts on the window under it. `modalDialogOpen()` (`state/store.svelte.ts`) names the dialogs: the app-root dialogs, the desktop's close prompt and the window-wide survey, which is the dialog half of `keyboardOwnedAbovePanes()`, and that predicate now reads it. `onWindowKey` (`App.svelte`) checks it after the cover guard and before Hybrid Nav: a key that reaches it fires no chord, neither enters nor feeds Hybrid Nav, and stops there with its default left alone, so the dialog's fields keep their typing and editing chords; Cmd+` passes untouched. `runCommand` drops host commands under a dialog as it does behind a cover, the host's close request excepted. That gate is needed beside the key guard: in chan-desktop the key bridge turns Cmd+W, Cmd+/ and Cmd+1 to Cmd+9 into `chan:command` events before the page sees the key, which is how the take's Cmd+/ splits arrived. `Pane.svelte`'s reopen-closed-tab listener, which hears `app.tab.reopenClosed` apart from `runCommand`, drops it under a dialog too.

The dialogs that answer a key inside their keydown, and so close before the key bubbles on, now stop that key: Enter in `ConfirmModal`, `PromptModal` and `PathPromptModal`, and Escape in `CloseConfirmOverlay`. Without the stop the key reaches `onWindowKey` after the dialog has closed, where the guard cannot see the dialog, and in Hybrid Nav Enter commits the draft and Escape drops it. The survey and the Team Work dialog already stop the keys they take. The draft close, file conflict, workspace warnings and contacts import dialogs answer through native button activation, which runs after the key's dispatch while the dialog is still open.

One existing pin changed with the contract: `keyboardLayoutDispatch.test.ts` held that Ctrl+` under a modal is prevented as well as ignored. It now holds that the chord flips nothing and keeps its default, because under a dialog the window handler leaves every key's default alone.

Verification is in `App.paneMode.test.ts` ("keys under an open dialog"). The item's two: Cmd+. under the close confirm does not enter Hybrid Nav, then Enter answers the confirm once and nothing else changes; with a draft staged, Enter and then Escape answer an open confirm, the draft stays staged and Enter commits it once the confirm is gone. Five rows hold the bridged Cmd+/, Cmd+T and Cmd+Shift+T and the page's Ctrl+Alt+/ and Ctrl+Alt+Shift+T under the confirm, and three hold the prompt, the path prompt and the close prompt with a draft staged; each of these ten ran red against the base code before the fix. One more holds that Cmd+` under the confirm is neither prevented nor stopped; the base code passes it, and it goes red when the guard stops the chord too. Removing each part of the fix in turn (the `onWindowKey` guard, its stop, the `runCommand` gate, the pane's reopen guard and each of the four dialog stops) turns its own test red on the intended assertion. `make web-check` gates the commit.

Open: none of this was exercised in a WebView. The tests run in jsdom and send host commands as `chan:command` events, as the key bridge and the menu do. The key bridge's IPC chords (reload, zoom, the devtools chord, and Quit, New Window and Toggle Launcher off macOS) bypass the page and still act under a dialog, as they do behind a cover. Behind a full-window cover, `Pane.svelte`'s reopen-closed-tab listener still reopens a tab, because it does not read `appInputBlocked`. With a Hybrid Nav draft staged, the close prompt, which is not on the modal focus stack, loses its focus to the document's editor within 50 ms in jsdom; Escape then lands on the editor, the guard holds it, and the prompt stays open until it is clicked.
