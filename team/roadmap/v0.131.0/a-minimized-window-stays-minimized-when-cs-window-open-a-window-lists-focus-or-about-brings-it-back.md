# A minimized window stays minimized when cs window open, a window list's Focus or About brings it back

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: found on 2026-11-12 by the worker that built v0.129.0's shared raise, by reading, and confirmed by reading in the review of that change (`dev/v0129/row-notes.md`, "minraise: questions and follow-ups raised by the worker"; `dev/v0129/reviews/review-minraise-1.md`, "Other raise sites"). Recorded as not built in the shipped [raise row](../done/coming-forward-to-a-minimized-window-may-not-activate-the-app.md) ("Built") and among v0.129.0's follow-ups. Not seen on a screen. At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`, with tao 0.37.2 as locked; by reading, not run.

- The shared raise (`raise_window`, `desktop/src-tauri/src/raise.rs:57-70`) restores, shows and focuses a window and settles the platform's remainder. Three callers take it: a second launch coming forward (`come_forward`, `single_instance.rs`), a close confirmation (`serve.rs`) and a Window menu Open row (`show_window`, `main.rs`); a test pins that list (`only_the_three_raises_take_the_shared_raise`, `raise.rs:443`).
- `unbury_window` (`desktop/src-tauri/src/main.rs:7135`) brings a live window forward by `show` then `set_focus`, with no `unminimize`, at three sites (7156-7157 for a `local::` window, 7190-7191 for a devserver `lib-` window, 7200-7201 for any other). It is reached from `cs window open` (`open_window_by_label`, `serve.rs:763`, through `window_ops.rs`), from a window list's Focus, Show or Open in the workspace app on chan-desktop (`runLibraryWindowAction`, `web/packages/workspace-app/src/api/libraryWindows.ts`, through the `focus_library_window` command, `main.rs:5004`), and from a Window menu row for a hidden window (`run_menu_item`, `main.rs:6605-6610`).
- `open_about_window` (`main.rs:7223-7227`) brings an open About window forward with `set_focus` alone.
- tao's `set_focus` does nothing while the window reads minimized, on Linux, macOS and Windows; on Linux and Windows `show` does nothing to a window that is already shown, minimized or not. So on those two a minimized window brought back by these paths stays minimized and unfocused. On macOS, whether `show` alone brings a minimized window out of the Dock is not read here; if it does, the app is not activated, the case the shipped raise row fixed for its three paths.

## Desired contract

1. A window brought forward by `cs window open`, by a window list's Focus, Show or Open, by a Window menu row for a hidden window, or by the About item while its window is open, comes back restored and focused when it was minimized, as a Window menu Open row's window does: these paths take the shared raise.
2. Nothing takes focus that nobody asked for: the pin on the raise's callers names these and no others.
3. A buried window, which the desktop reopens through its watcher, opens as it does now.

## Boundaries

- `unbury_window` and `open_about_window` in `desktop/src-tauri/src/main.rs`, and the caller pin and module comment in `raise.rs`. The raise itself is unchanged.
- Not here: focus-stealing prevention on Linux ([its row](a-second-launch-from-a-terminal-gets-no-focus-where-the-window-manager-prevents-focus-stealing.md)); on GTK the shared raise leaves a window that read hidden shown but unfocused (the module comment of `raise.rs`), which `unbury_window`'s last branch meets for a hidden window that is still alive.

## Acceptance

1. Tests in the raise's own style (its decision table and source pins): the caller pin names the new callers, and each of the four sites restores before it focuses; red on the code without the change.
2. In a guest, a minimized workspace window brought back by `cs window open` from outside it, and a minimized About window by the About item, ten times each under openbox and under metacity with the chan window never clicked (the reading of the raise row's harness, `dev/v0129/evidence/minraise/scripts/read.sh`): restored and focused 10 of 10 with the change, still minimized without it.
3. On the Windows VM (`dev/vm/windows.sh`) and on the owner's Mac, `cs window open` on a minimized window, ten runs each: the window restored and in front.
