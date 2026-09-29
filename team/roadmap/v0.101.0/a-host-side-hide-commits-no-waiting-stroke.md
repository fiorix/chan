# A desktop hide requests no flush of a waiting stroke before destroying the webview

Status: raised for a decision on 2026-09-29 by the lead's notes on the independent review of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reviews/review-Frontend-18.md` in the development tree, finding 1, older than that range), whose fix round built the page's side and left the hides that request no page flush (`dev/v0101-team/reports/report-Frontend-33.md`, the review's first finding). Read at `e07f3862f`; whether a webview fires an unload event when the desktop destroys it is owed on a display, and the code's own comments disagree. Not run. Recommendation, by the lead's rule for this landing: accept for v0.101.0, since a stroke or a text tab's last edit can be lost with no word.

## What was seen

Lines at `e07f3862f`, in `desktop/src-tauri/src/` where no other path is named. `cs window hide` and the launcher's hide flag the window's next close request as a silent hide and ask the window to close (`hide_window`, `window_ops.rs:178-193`); the close request's handler takes the flag and buries the window at once, with no prompt and no command to the page (`on_close_requested`, `serve.rs:1018-1026`, `:1062-1065`), and for a local or a devserver workspace window the bury closes the webview through its watcher's reconcile (`bury_window_now`, `serve.rs:1340-1343`, `:1356-1369`, `:1376-1400`). The host invokes no page flush before it buries, so the function that the page's own hides and closes call first, which commits every board's waiting change and writes every queued recovery write (`flushEditsToRecovery`, `web/packages/workspace-app/src/state/tabs.svelte.ts:2688-2712`), does not run from this path; an unload event could still call it. A stroke still inside its board's wait and a text tab's edit whose recovery write waits on its debounce are lost unless the webview fires `pagehide` or `beforeunload` as it is destroyed, whose handler would write them (`web/packages/workspace-app/src/App.svelte:1514-1525`). The page's store says a buried WebKit view may never fire it (`web/packages/workspace-app/src/state/store.svelte.ts:3459-3460`), and the desktop's comment on a transfer's close says a destroy does (`serve.rs:1421-1424`). `web/packages/workspace-app/src/editor/design.md:88` names these hides, and a window the desktop destroys on its own, as at its quit or a devserver's disconnect, as ways that commit nothing.

## Desired contract

A hide or a close that the desktop makes without the page leaves each tab's unsaved input where the next open of its file finds it, as the page's own hide and close do.

## What to do

A reading on a display first, of whether each platform's webview fires an unload event at the destroy. Then, if it does not, the host asks the page to commit before it buries, as the red dot's close asks the page before it closes, with a bound for a page that does not answer.

## Boundaries

`desktop/src-tauri/src/window_ops.rs` (`hide_window`) and the close request's handler in `desktop/src-tauri/src/serve.rs`, with their tests; the page's side is unchanged.

## Acceptance

1. `cs window hide` and the launcher's hide of a window whose drawing has a stroke inside its wait leave the stroke where the next open of the drawing finds it; shown on a display, and pinned where a test can drive the host.
