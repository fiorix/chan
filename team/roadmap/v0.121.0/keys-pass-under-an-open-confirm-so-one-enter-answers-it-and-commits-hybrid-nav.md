# Keys pass under an open confirm, so one Enter answers it and commits Hybrid Nav

Status: raised by the owner on 2026-11-01 from a screencast dry take, where it killed a running terminal; read from that take's recording and the code at v0.120.1, drafted for v0.121.0.

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
