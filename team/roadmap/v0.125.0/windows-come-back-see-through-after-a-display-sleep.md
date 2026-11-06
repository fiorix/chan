# Windows come back see-through after a display sleep

Status: raised by the owner on 2026-11-06 from chan-desktop 0.124.0 on macOS 27.0.1, diagnosed from the unified log and a read of the code with nothing changed; accepted for v0.125.0 the same day, during its first release candidate; not started. The owner's constraint: windows stay transparent, so a fix that makes a window opaque or gives it an opaque native background is out.

## What is there now

After a display sleep (display off at 14:40:27, on at 15:00:25 by `pmset -g log`; the system stayed awake), some chan windows came back with the native title bar painted and nothing below it: the desktop wallpaper showed through the whole content area, tab strip, toolbar and sidebar included, not only a terminal body. Another chan window on the same screen, connected to the same devserver, painted normally. The owner reports it as recurring; the frequency is not measured.

Every window chan-desktop builds is transparent (`desktop/src-tauri/src/serve.rs`, `mark_transparent_window` and the `transparent(true)` builder call), and `keep_title_bar_opaque` paints only the title bar container. A webview that presents no frame therefore shows the desktop instead of a grey window: the defect is that the webview presents nothing after the wake, and the transparency only makes it visible.

The unified log of the running chan-desktop shows what WebKit did. During the sleep it could not make the page layers volatile (`WebPage::markLayersVolatile: Failed to mark layers as volatile within 2000ms`) and suspended the web processes anyway (`prepareToSuspend: Process is ready to suspend`, the throttler at Suspended), 49 times for one WebContent process, 6 and 2 for two others. At the wake (`kCGSDisplayDidWake` 15:00:25.588, `windowDidChangeOcclusionState` for three pages 1.9 s later) the page in the heaviest process logged `view visibility state changed 0 -> 1` and `sending ProcessDidResume IPC because the process was suspended`, and `isViewVisible()` reported the window visible, the view not hidden and the window not occluded. WebKit believed the view visible and the process resumed, yet the window showed no frame. No web or GPU process died between 14:39 and 15:10. One NSWindow held two webviews (a workspace page and its launcher panel) and another held one; which NSWindow was blank, and so which web process failed to present, is not established.

The page already detects a wake. `web/packages/workspace-app/src/wakeGap.ts` turns a late-firing coarse interval into `onWake`; `App.svelte` runs `scheduleResume` on it and on `visibilitychange`, and `TerminalTab.svelte` runs the terminal renderer recovery and the PTY socket recycle on it. The comment there says WKWebView does not fire `visibilitychange` across a sleep; in this log WebKit flipped the view to visible at the wake, so the page may have seen it. Whether the page's JavaScript was alive while the window was blank, and whether a blank window recovers on a click, a tab switch, a resize, a hide and show, or only on a reload, is not known. The owner's tiling window manager logged no frame writes at the wake and is not implicated; the reproduction runs once with it quit.

The terminal bodies that turned see-through after an app switch (withdrawn at v0.122.0, closed with no code) may be the same family, presented layers lost after the web process was backgrounded, with a different trigger and extent; nothing shows them to be one bug.

## Desired contract

1. After a wake, every chan window, local and devserver, presents a fresh frame without a reload and without user input, within about 2 s of the wake.
2. Windows stay transparent, and the terminal background opacity still shows the desktop at values below 100.
3. Window frames after the wake equal their frames before the sleep; a repaint that moves a frame to force a render restores it on the next run-loop turn.
4. No page is reloaded on wake to hide the defect: a reload drops the page's state.

## Boundaries

- The desktop shell (`desktop/src-tauri/src/`), main thread only for any AppKit call, as `keep_title_bar_opaque` is; the page's existing wake path (`wakeGap.ts`, `scheduleResume`, the terminal renderer recovery) if the reading shows the page alive and a DOM change repaints.
- The reproduction and the recovery mapping come first and choose the fix: a native repaint at the wake (observe `NSWorkspaceScreensDidWakeNotification` and `NSWorkspaceDidWakeNotification`, and about 1 s later nudge every shown window's webview frame by one point and restore it, the webview rather than the NSWindow when that alone repaints, since a window-frame change fires `WindowEvent::Resized`, geometry persistence and the launcher's `sync_for_host`) when a resize restores a blank window; a page-side repaint on `scheduleResume` when the page is alive and a DOM change repaints; both when each contributes.
- The webviews of the other platforms are read, not assumed: WebKitGTK on Linux and WebView2 on Windows after a long occlusion or a suspended web process, in the round's guests, so a fix that is macOS-only is a decision and not an omission.
- No automatic reload; no opaque window; no new dependency beyond the objc2 crates the shell already carries.

## Acceptance

1. On the owner's Mac, after a display sleep long enough for the log to show `Process is ready to suspend` for the windows' web processes (`pmset displaysleepnow`, at least 5 minutes), every chan window, local and devserver, paints its full content within 2 s of the wake with no input, three runs in a row; before the fix, the reproduction records which windows went blank, whether their DOM and JavaScript were alive (Web Inspector), and which recovery restored them, one at a time: a click, a tab switch, a resize by dragging an edge, a hide and show, a reload.
2. Window frames after the wake equal those before the sleep; the terminal background opacity still shows the desktop below 100.
3. A test pins the wake hook: a wake schedules the repaint for every shown window and the restored size equals the original; red without the hook. The visual result is read on the Mac, not in a test.
4. The Linux desktop in the round's guest (WebKitGTK under Xvfb) and the Windows desktop in the round's guest (WebView2), each with a workspace window and a devserver window left occluded or unmapped long enough for the web process to suspend, then shown again: each either paints at once or is recorded as blank with the recovery that restores it; the reading decides whether the fix reaches those platforms in this release or becomes a row.
