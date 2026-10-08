# Native windows across a devserver restart, the open half

Status: accepted for v0.104.0 by the owner's word of 2026-10-08, as a new item from the record of [a-raw-devserver-restart-may-close-desktop-windows](../done/a-raw-devserver-restart-may-close-desktop-windows.md); the delayed arms are built first so the hazard is reachable, each arm says whether it reached the hazard or only the fixture, and every native observation names its engine.

## What was seen

v0.103.0 shipped the shutdown half of the restart item: a stopping devserver publishes no window set its shutdown shortened (the window list and new feed requests answer 503 during the stop). The restart half did not ship: on a desktop built from the candidate, a graceful restart and a kill-and-restart of a raw devserver each kept the workspace window once, and the hazard the item names, a restart whose window feed is incomplete, was observed in neither arm, because the fixture restores within a second. Open, as the v0.103.0 report's Follow-ups record: the incomplete-feed case (a restart whose window feed omits a window the desktop holds), the delayed arms that hold the restore open (designed in the v0103 round, never run), and the gateway path (a devserver behind a gateway restarted with windows open, the reading that acceptance 3 of [the-desktop-probe-takes-a-gateway-404-as-ready](../done/the-desktop-probe-takes-a-gateway-404-as-ready.md) names). The closed item's contract still holds: a graceful restart leaves a connected desktop's native windows of that devserver open, to be retargeted in place; only a discarded window, a workspace turned off, or a window the user buried closes.

## Desired contract

With the restore held open long enough for the desktop to see an incomplete feed, the desktop keeps the native windows of a restarting devserver and retargets each in place once the window set is complete; a workspace turned off and a discarded window still close; the same holds for a devserver behind a gateway, or the item says from the code why the gateway path differs.

## What to do

Build the delayed arms first (a restore held open by a fixture-controlled delay, long enough that the desktop's reconcile runs against a partial window set), then drive the incomplete-feed case through them, with the arm reporting whether it reached the hazard (a desktop reconcile against a feed that omits a held window) or only the fixture. Read the gateway path early and say whether it can be driven in a guest; if it can, run it; if not, say what covers it. Repair only what the arms show: if the desktop closes a window the incomplete feed omitted, repair the lifecycle meaning so an outage is distinguishable from a removal, red first. Linux WebKitGTK is the engine this host runs; macOS WKWebView and Windows WebView2 are not observed unless the owner takes a reading.

## Boundaries

`desktop/src-tauri/src/window_watcher.rs`, `window_watcher_wiring.rs` and the desktop's restart fixtures under `scripts/e2e/`; on the server side only through the lead, since `crates/chan-server/src/devserver.rs` and `routes/library.rs` are leased to the seat of [three-holds-keep-the-workspace-host-alive](three-holds-keep-the-workspace-host-alive.md). The desktop's wait for a restarting devserver and its retarget are not changed by this item.

## Acceptance

1. The delayed arms run on Linux WebKitGTK with the restore held open for a recorded duration, each arm's record saying whether it reached the hazard or the fixture.
2. The incomplete-feed case driven through a delayed arm: either the desktop keeps the omitted window and retargets it in place (observed, with its record), or the defect is shown and repaired red first.
3. A workspace turned off and a discarded window still close in the same arms.
4. The gateway path: run in a guest with its record, or a written reason it cannot be driven there and what stands in for it.
5. Every observation names its engine; readings on other engines are the owner's, listed in [the-owners-display-readings-need-a-checklist](the-owners-display-readings-need-a-checklist.md).
