# The app's wake path outlives its mount and a failed resume rejects unhandled

Status: raised during v0.101.0 on 2026-09-25 from the web surfaces lane's report (the timers its test teardown had to close) and the independent review of that lane, which cited the code at `main` `09f1b6aea`; accepted by the owner the same day and landed with its own lane. Reproduced in a mounted test: two Apps stacked by an unmount without release produced four unhandled rejections on one resume.

## What was seen

`App.svelte`'s `onMount` is async, so nothing it returns can serve as a cleanup. After the bootstrap it registered a `visibilitychange` listener it never removed, called `installWakeGapDetector(scheduleResume)` and discarded the disposer, so the 2 s probe interval ran for the document's life, and never cleared a pending resume timer. `scheduleResume` ran `void refreshTree()` and `void refreshWorkspace()` with no handler, so a refresh that failed after a wake (the devserver restarting, the tunnel answering 502, the network not yet back) surfaced as an unhandled rejection and an "Unhandled error" notice, duplicating the tree error already set. In production one App mounts per page, so the leak was bounded to the page's life; under vitest every mount that was not released kept resuming and the rejections failed the run.

## Desired contract

Unmounting the app disposes the wake-gap detector, removes the visibility listener and clears any pending resume timer, and an app unmounted during its bootstrap installs none of them. A failed resume refresh is logged once through the app's existing warning path and left to the next wake and the watcher's resync; nothing rejects unhandled.

## What shipped

A component-level release run from `onDestroy` (listener removed, detector disposed, pending resume cleared, a flag that makes the wake block a no-op after an unmount during bootstrap), and `.catch` handlers on the two resume refreshes that log `[chan] resume tree refresh failed` and `[chan] resume workspace refresh failed`. Two tests mount the real App over the demo transport: one unmounts and asserts the three releases and no resume armed afterwards; one wakes the app with the transport failing and asserts the two warnings and no unhandled rejection.

## Boundaries

`web/packages/workspace-app/src/App.svelte`'s wake block and its teardown, plus the test. The store-level watcher's own detector outlives App by design and is not part of this item.
