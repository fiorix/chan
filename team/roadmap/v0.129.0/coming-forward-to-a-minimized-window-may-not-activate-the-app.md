# Coming forward to a minimized window may not activate the app

Status: built in v0.129.0 on 2026-11-12 ahead of the owner's Mac reading, on the owner's word the same day (the section at the end); the owner's Mac walk of the fix is pending. At the v0.128.0 cut on 2026-11-12 it was carried to v0.129.0 not started, with the owner's Mac reading of the raise to decide whether a fix is built.

Record before the v0.128.0 release: raised on 2026-11-10 by the review of v0.127.0's single-instance guard before its GA, from reading; not observed on a Mac. Accepted for v0.128.0 by the owner the same day. Not started.

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

## Built, 2026-11-12

The owner reversed the acceptance's order on 2026-11-12: the fix is built from a reading of the libraries, and he walks it on his Mac afterwards. Nothing here has run on macOS.

The reading (tao 0.37.2, tauri 2.12.4, tauri-runtime-wry 2.12.2): tao's `set_focus` does nothing on any platform while the window reads minimized or not visible. On macOS it is the only one of the three calls that activates the app, so a window restored from the Dock, or a window of a hidden app, is left with chan behind. On GTK tao queues the restore and clears its minimized flag only when GTK reports the new state, so a `set_focus` in the same burst is always skipped. On Windows the restore runs inline before the focus call and there is no gap.

The fix: one helper, `raise::raise_window` (`desktop/src-tauri/src/raise.rs`), used by the three callers the row names. It makes the same `unminimize`, `show` and `set_focus` calls as before and then settles per platform. On macOS it activates the app itself on the main thread (unhide without activation if the app is hidden, make the window key, activate), and does nothing for a window that is gone by then. On GTK, for a window that read minimized before the raise, it looks every 20 ms for at most 1 s off the main thread and focuses once the window no longer reads minimized. Windows is unchanged. Which window `come_forward` picks, what it answers, and the close-confirm flow are unchanged.

Proofs, in an isolated guest at the tip: fmt, clippy, rustdoc, the Windows-target clippy and a macOS-target clippy (through cargo-zigbuild; a type check, nothing linked or run on macOS) green; chan-desktop's tests green as a normal user (1,022); 17 mutations each red on their own test, among them a fourth caller, the deleted activation call and a swapped platform. A Linux reading under a window manager that really minimizes, a second launch on a minimized window, focused of 10 at base and at the tip: openbox 10 and 10 (it focuses any window that restores itself, which hides the gap); metacity with chan never clicked 0 and 10 (tao's guard, which the fix answers); metacity once chan had been clicked 0 and 0, minimized or behind another window (focus-stealing prevention weighing the request's old timestamp, which this change does not fix). An independent review accepted the change with fixes, all applied (`dev/v0129/reviews/review-minraise-1.md`).

Open: the owner's Mac walk (a second launch on a minimized, a hidden and a covered window, a close confirmation, a Window menu row, ten runs each, with the installed v0.128.0 as the base control), which also answers whether macOS 14 and later honors the activation for a launch by path. Not built, reported: a raise from a second launch started in a terminal gets no focus under a window manager that prevents focus stealing, at base and at the tip (a follow-up could carry the launch's startup id or activation token in `Activate`); `unbury_window`'s three raise sites and `open_about_window` in `main.rs` do not use the helper and share the defect. Not read: Wayland, native Windows.
