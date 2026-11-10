# Coming forward to a minimized window may not activate the app

Status: raised on 2026-11-10 by the review of v0.127.0's single-instance guard before its GA, from reading; not observed on a Mac. Accepted for v0.128.0 by the owner the same day. Not started.

## What is there now

When a second launch asks the running desktop to come forward, `come_forward` (`desktop/src-tauri/src/single_instance.rs`) raises the last focused window that still shows by calling `unminimize`, `show` and `set_focus` one after the other. On macOS the windowing library's `set_focus` does nothing while the window still reads as miniaturized (tao 0.37.2, `platform_impl/macos/window.rs`), and it is the only one of the three calls that activates the app. If the window has not finished leaving the Dock when the third call runs, the window is restored but chan stays behind the app the user launched from. The close-confirm path in `desktop/src-tauri/src/serve.rs` raises a window by the same three calls, and so does a Window menu row (`show_window`, `desktop/src-tauri/src/main.rs`), where chan is already the active app. On Linux the same library skips `set_focus` while its own minimized flag is set, which clears only once the restore is processed, so a restored window may not take focus there either. Both are read from the library's source, not observed.

## Desired contract

1. A window chan raises (a second launch coming forward, a close confirmation, a Window menu row) ends up key with chan frontmost, whether it was minimized, hidden with the app, or behind another app.
2. No focus is taken when nothing asked for it.

## Boundaries

- The raise sequence those paths share, on macOS and on Linux. Windows only if the reading finds the same gap there.

## Acceptance

1. First the reading on chan-desktop (owner, macOS): minimize the only window, bring another app forward, start a second launch that reaches the guard (`CHAN_NO_DESKTOP_HANDOFF=1 /Applications/chan.app/Contents/MacOS/chan-desktop`), and record whether chan becomes frontmost. The same for a close confirmation on a minimized window.
2. If it does not: a fix (activating the app itself instead of relying on the window's focus call, or raising once the window reports restored), and the same steps pass ten times in a row.
3. If it does: the item closes with the reading recorded and a comment at the sequence saying why it holds.
