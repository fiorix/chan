# A desktop hide requests no flush of a waiting stroke before destroying the webview

Status: withdrawn, and it did not ship: seeded text, stroke and launcher Hide observations on Linux WebKitGTK lost nothing and no repair was selected; closed at [v0.103.0](../../release/release-v0.103.0.md) by the owner's ruling of 2026-10-07 that no row that can close is carried, which that report records.

Record before the release: seeded candidate text and stroke hides, including an inspected launcher Hide stroke, passed on Linux WebKitGTK with no loss; other native engines and wider cases remain unproved.

## Owner decision, 2026-10-06

Check a pending drawing stroke and text edit at a host-initiated hide, then reopen and inspect recovery. If unload does not preserve them, add an explicit bounded flush request before hiding, including the case where the page does not answer. Record evidence separately for each platform and webview engine; one engine does not prove the others.

## Candidate display evidence, 2026-10-06

One independently reviewed launcher Hide observation uses frozen product `a64c6184739aa9b7c4c85f00124ef56292277b02`, separate clean fixture `55cd6ba8c` and guest-only driver `74fcfbcf` with helper `708ffa14`. It drives Linux WebKitGTK under Xvfb/Openbox with the inspector enabled and 2 CPUs/4 GiB. Source, binary and bundle identities matched before and after; driver, guest, export and completion statuses were zero, with no OOM and the guest idle afterward.

The launcher inspector found one workspace card, one native record's `Window 1` row and one enabled Hide button, then invoked that button's click handler. The pending stroke was absent from storage and the file before the action. Its page ended 39 ms after input, inside the board's 200 ms wait and the same run's 151 ms late-kill loss control. Pagehide fired, recovery storage held the stroke, and reopening showed the stroke and recovery banner while the file also held the stroke. Immediate and late kills at 26 and 151 ms lost their separate strokes without pagehide; a settled control retained its stroke, and the resting control took 1,109 ms to reach the file.

This one inspected, programmatic launcher button-handler observation selects no conditional product repair. It does not establish arbitrary pointer or keyboard gestures, inspector-disabled operation, other webview engines or a general latency bound. It is separate from the `cs window hide` observations below. Its independent verdict and five primary arm rows are in `dev/v0103-team/reviews/review-Review103-Desktop103-item7-launcher-hide-attempt01-artifact-1.md` and `dev/v0103-team/evidence/Desktop103/observe/item7-launcher-hide/attempt-01/export/work/results.jsonl` in the development tree.

## Candidate cs-hide evidence, 2026-10-06

Independently reviewed runs054 and055 use frozen candidate product `a64c6184739aa9b7c4c85f00124ef56292277b02` with separate unchanged fixture `c5845fce0`. Both drive actual Linux WebKitGTK windows under Xvfb/Openbox with recorded load and 2 CPUs/4 GiB, retained before/after source and binary identities, zero driver and verdict statuses, and no OOM. The fixture's owned checkout guard was `e3d3e9685`; those later diagnostic changes were not the driver bytes used for these runs.

The inspected classic unattached text arm held the whole edit in its editor, with neither its full marker nor prefix in localStorage and no marker in the file before `cs window hide`. The page exited 33 ms after typing ended, recorded pagehide, and retained the whole edit in the recovery buffer. Reopening offered Restore; the file still lacked the edit. Immediate and 400 ms no-unload kills lost their separate edits, while a settled control kept its edit. The uninspected hide at 165 ms also kept its edit in recovery, but lacks the timed pre-hide editor/storage proof.

The inspected pending-stroke arm recorded Undo enabled and no stroke in storage or the file before hide. Its page exited 44 ms after stroke end, recorded pagehide, and retained the stroke in recovery and the file; reopening showed the recovery banner. Immediate and 151 ms no-unload kills lost their separate strokes, while a settled control kept its stroke. The uninspected hide at 72 ms also kept its stroke, without a timed pre-hide probe or pagehide witness. These uninspected arms corroborate preservation without independently establishing the mechanism.

These two seeds establish no loss at `cs window hide` on this candidate and engine, so they select no conditional product repair. They do not establish arbitrary edits, a hide before an attached tab sends its edit, inspector-disabled operation, macOS WKWebView, Windows WebView2 or a latency bound. The separate launcher observation above does not broaden these two runs. Earlier inconclusive and older-product attempts remain separate. The independent verdict and primary arm results are in `dev/v0103-team/reviews/review-Review103-Desktop103-candidate-hide-054-055-1.md` and `dev/v0103-team/evidence/Desktop103/observe/runs/{054-item7-text-hide,055-item7-stroke-hide}/export/work/results.jsonl` in the development tree.

## Earlier display evidence, 2026-10-06

The observation drivers are integrated through `6de4e0246`, independently reviewed with their retained artifacts. They drive actual native WebKitGTK 2.52.6 windows under Xvfb/Openbox and software rendering. These observations use the older product build `64b1a7c8a`, not the candidate; the inspector server is enabled, including for an arm without an attached inspector.

One counted text run at the corrected fixture tip observed a classic, unattached text edit kept in full in the recovery buffer after both inspected and uninspected `cs window hide` arms. The marker was absent from disk and from the reopened editor; the recovery banner offered the kept text through the user's Restore action. Both no-unload kill controls lost the marker. The inspected arm observed pagehide. Attached-session text was also kept, but does not isolate unload as its cause.

The independently source-verified pending-stroke result is run026: the inspected hide arm kept the stroke while both kill controls lost theirs. That hide completed at 97 ms, before the late kill at 150 ms; the uninspected hide also kept its stroke but completed at 191 ms, beyond the control that established it was still pending. Five earlier positive reports lack retained driver bytes and are not equivalent independent evidence. Three attempts at the corrected tip were inconclusive because a timing control missed its bound; they prove neither loss nor successful whole-run recovery. No loss justifying the conditional product repair is established. At that point a hide before an attached tab had sent its text edit, candidate-native runs, launcher hide, macOS WKWebView, Windows WebView2 and inspector-disabled operation were unproved.

## Record before this decision

Every section below records the state before the dated decision above and is preserved as history. The dated decision governs the current scope.

Previous status: moved to v0.103.0 on 2026-10-05, before the v0.102.0 GA, still raised for a decision: the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Record before the move: carried into v0.102.0 at the v0.101.0 GA on 2026-10-02, still raised for a decision.

Record before the release: raised for a decision on 2026-09-29 by the lead's notes on the independent review of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reviews/review-Frontend-18.md` in the development tree, finding 1, older than that range), whose fix round built the page's side and left the hides that request no page flush (`dev/v0101-team/reports/report-Frontend-33.md`, the review's first finding). Read at `e07f3862f`; whether a webview fires an unload event when the desktop destroys it is owed on a display, and the code's own comments disagree. Not run. Recommendation, by the lead's rule for this landing: accept for v0.101.0, since a stroke or a text tab's last edit can be lost with no word. On 2026-09-29 the owner ruled that the item waits on that reading on a display: it is accepted for v0.101.0 if a hide that the desktop makes without the page fires no unload event, which a delayed `cs window hide` shows by no recovery banner and no stroke at the next open, and it is withdrawn if the event fires, which a banner shows. Until the owner takes the reading the item stays raised and nothing is built on it.

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
