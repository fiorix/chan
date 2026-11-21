# A control terminal hidden in place on Windows stops following resizes

Status: accepted for v0.133.0 by the owner on 2026-11-19; not started. Moved to v0.134.0 by the owner on 2026-11-20 ("the carry items and the current items in v0.133 move to v0.134 roadmap").

Record: on Windows, when the Computers screen hides a connected control terminal in place, `close_for_host` (`desktop/src-tauri/src/launcher_panel.rs`) drops the screen's webview from that window and the window lives on: Show brings back the same native window (hwnd 590776). After that hide and show, the window's page no longer follows the window's size and no longer takes the keyboard when the window is activated, and its connection feed falls to the unfocused cadence, one ping every 20 s instead of every 3 s. Read on 2026-11-19 on the local Windows 11 VM at `b3a03cd24`, with a second devserver registered directly with a script, its screen built by a real chord show and hide, and each read made by resizing the window with `SetWindowPos` (no activation), making it the last window used, clicking away and coming back with Alt+Tab (`dev/v0132-team/followups/followup-Ops132-Lead132-54.md`, "The reader's resize leg (f)"; evidence under `dev/v0132-team/evidence/Ops132/J211c/run/`). The readings, in CSS px at a device pixel ratio of 1:

- The local window, as a control: client 684x551, page 684x551 and following, `hasFocus` true, OS focus in its WebView2 child, a ping every 3 s.
- The control terminal before the hide: client 564x571, page 564x571 and following, `hasFocus` true, OS focus on `Tauri Window` and then its WebView2 child (`Chrome_WidgetWin_0`), a ping every 3 s.
- The control terminal after the hide and show: client 544x511, page still 564x571, `hasFocus` false, OS focus on the `Tauri Window` top-level only with no WebView2 child focused, pings 20 s apart (41:13.328, 41:33.334). Its capture shows the page clipped at the right and bottom edges, with the cursor line cut off.

The mechanism is in wry 0.57.0: `Drop for InnerWebView` calls `dettach_parent_subclass(parent)` (`src/webview2/mod.rs`, lines 71-77 and 1361-1368), which removes the parent window's one subclass, `PARENT_SUBCLASS_ID`. That subclass's `WM_SIZE` arm sizes a controller to the parent's client area and its `WM_SETFOCUS` arm moves focus into it (lines 1297-1328). Dropping the screen's webview therefore takes that handling away from the host webview of a window that lives on. No Tauri webview of the window then gets `GotFocus` on activation, so no `Focused(true)` arrives, and the screen's own report is gone with its webview.

Scope: Windows only, since the subclass belongs to wry's WebView2 backend, and control terminals only. The watcher-managed devserver windows are not affected the same way: their hide closes the native window and Show builds a new one (hwnd 3605240 hid, 2621928 came back).

## Desired contract

1. After a control terminal is hidden in place and shown again, its page follows the window's size on every resize, as it does before the hide.
2. Activating that window gives its page the keyboard (`hasFocus` true, OS focus in its WebView2 child), so its feed keeps the focused cadence.

## Acceptance

1. A reading on the Windows VM as the resize leg above: a control terminal hidden in place and shown again, resized with `SetWindowPos`, clicked away from and brought back with Alt+Tab, reads a page the size of the resized client, `hasFocus` true and a ping every 3 s. The same reading is red at the base the fix starts from.
