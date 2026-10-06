# The File Browser keeps a tree whose root is gone

Status: accepted for repair in v0.103.0, with a controlled test of each recovery gap.

## Owner decision, 2026-10-06

Prove the socket-ready, transient listing failure and broadcast-lag gaps with controlled tests before changing them. Refresh the tree when a workspace event socket becomes ready, retry transient root-availability listing failures within a bound, and resynchronize after broadcast lag. Coordinate the reconnect behavior with the survey repair and the failure evidence with the three-check diagnostics. Increasing the browser timeout does not repair a missing recovery path.

## Record before this decision

Previous status: moved to v0.103.0 on 2026-10-05, the day it was raised, before the v0.102.0 GA, still raised for a decision: the owner has not ruled on it and did not take it into v0.102.0, which shipped on 2026-10-05.

Record before the move: raised on 2026-10-05 by a reading of one red of a browser smoke check on the v0.102.0 integration branch, the check that removes a workspace's root under an open window and waits for the File Browser to say so; the lead lists it for the owner. `raised | decide`: not accepted and not built. The red was recorded in one whole run of the suite, which was not taken alone; the code below was read at `adf953f6c`, and nothing was run for this item. That the red run was this fault is not shown.

## Owner ruling

Not put to the owner as a survey. The owner was told of it in writing on 2026-10-05, beside the browser suite's state at the version's first release candidate, as a state a user can meet for which nothing is built in a candidate; no ruling is recorded.

## What was seen

Browser smoke check 98 seeds a tree of directories and notes, opens a window of its own on it, expands the tree in the File Browser, removes the workspace's root with `rm -rf`, activates the File Browser's tab and waits thirty seconds for the words `Workspace root unavailable` (`scripts/e2e/browser-smoke/checks/98-workspace-root-loss.mjs`). At `adf953f6c` it was red once, in the second of two whole runs of the suite on 2026-10-05: the wait ran out, and the check ended after 43.0 s. The picture the check takes of its own page at the failure shows the File Browser's tab active, the root's directories and the expanded tree drawn as before the removal, and no message. That run was not taken alone: it held the lock of the guest's web jobs under a memory cap of 4 GiB, and a Rust gate of another range was compiling in the guest while the root was removed. The same check was green in the first whole run at that commit, in 17.0 s, and alone there, in 13.7 s, and green at `22c1e8fc8` in a whole run taken alone, in 15.5 s, and alone, in 11.0 s. The runs are recorded on [the-browser-smoke-suite-is-red-at-the-base](the-browser-smoke-suite-is-red-at-the-base.md).

What makes the message, read in the code. The File Browser shows it only when its root has no rows and its store's flag `rootUnavailable` is set (`web/packages/workspace-app/src/components/FileTree.svelte`). One place sets the flag: `refreshTree`, when the listing of the root is refused with a 404 that carries the code `workspace_root_missing` (`web/packages/workspace-app/src/state/store.svelte.ts`; `isWorkspaceRootMissingError`, `web/packages/workspace-app/src/api/errors.ts`). After a root is lost that listing is asked once. The watcher's supervisor polls its roots every 250 ms and emits one `Removed` for a root that has just gone missing, once for each loss (`WATCH_RETRY_INTERVAL` and the timeout arm of `watch_supervisor_loop`, `crates/chan-workspace/src/watch.rs`). The server sends it as one frame on the tenant's event broadcast. The page takes that frame, or a provider error, as its cue and calls `refreshTree` once, and a listing that fails in any way but the coded refusal is dropped with no second try (`onWatchEvent` and `reconcileWorkspaceRootAvailability`, `store.svelte.ts`).

So the message hangs on one frame and one listing, and three things each lose it. A frame skipped on a lagging socket: the broadcast holds 256 frames, a socket that falls behind skips the oldest, and the pump then owes it a sync of its surveys and nothing else (`pump_loop`, `crates/chan-server/src/routes/ws.rs`; the channel is made in `crates/chan-server/src/lib.rs`). A frame sent while the page swaps its event socket: no handler of the page hears it, and a socket that opens again sends its subscriptions and lists nothing in a workspace window (`onWatchReady`, `store.svelte.ts`; `fbWatchResyncAll`, `web/packages/workspace-app/src/state/fbWatch.svelte.ts`). The one listing running out the page's cap on a request, ten seconds (`REQUEST_TIMEOUT_MS`, `web/packages/workspace-app/src/api/transport.ts`), which is a failure of the other kind. Nothing on the path asks again: the poll emits once for a loss, so the miss lasts, and a longer wait in the check would not have passed.

## Why it matters

A user whose workspace's root directory is removed under an open window can be left with a File Browser that lists the old tree, with nothing on it saying that the root is gone. What ends that state, by the code: the tab's next return to visible, or a wake gap the page detects, after either of which the page lists the tree again and is answered the coded refusal (`scheduleResume`, `web/packages/workspace-app/src/App.svelte`), or a reload of the page. Until one of those, nothing does. It is of one family with [a-survey-is-refused-while-a-page-reconnects-after-a-wake-gap](a-survey-is-refused-while-a-page-reconnects-after-a-wake-gap.md) and [a-window-misses-a-layout-saved-while-its-socket-was-down](a-window-misses-a-layout-saved-while-its-socket-was-down.md): each is about what a page loses while its event socket is down, lagging or being swapped, with nothing read back when the socket opens again, there a survey and a layout and here the removal of the root.

## Desired contract

Not chosen: the owner's ruling decides whether anything is built. The reading proposes three changes, each closing one of the three ways, and each a hole by the code whatever the red run was. The page lists the tree at every open of its event socket in a workspace window, beside the resync of its subscriptions, which closes the swap and is the smallest. The page tries the cue's listing again, a bounded number of times, when it fails with anything but the coded refusal, which closes the lost request. The server owes a lagging socket a frame the page already takes as its cue, as it owes that socket a sync of its surveys, which closes the skipped frame. Each needs a red first, in a test of the store or of the socket's pump, before it is built. A longer wait in the check is not a repair.

## Boundaries

`refreshTree`, `reconcileWorkspaceRootAvailability`, `onWatchEvent` and `onWatchReady` in `web/packages/workspace-app/src/state/store.svelte.ts`, `fbWatchResyncAll` in `web/packages/workspace-app/src/state/fbWatch.svelte.ts` and `pump_loop` in `crates/chan-server/src/routes/ws.rs`, with their tests. Check 98, for what it keeps of a failure: the page's flag and error, its socket's state, the frames that arrived after the removal and the status and time of each listing, which changes what a red records and not what passes, and needs no red. Not the watcher's poll or its interval, the page's cap on a request, or the resume at a return to visible.

## Acceptance

Left open until the owner rules.

1. The ruling is recorded: built, and in which of the three changes, or kept as a written cost with what ends the state.
2. If it is built: for each way that is closed, a root removed while that way is open shows the File Browser's message with no return to visible and no reload; pinned red first where the test orders the removal, the frame and the socket's state, with no sleep deciding the order.

## Not established

Which of the three ways left the red run's page without its cue, or whether it was any of them: the check keeps its timelines only when it passes, and the run recorded nothing of the page's flag, its socket or its requests. Whether the root's frame was emitted in that run at all: the server logs nothing where the supervisor emits it. Whether the removal of a root that holds a whole run's files overruns the broadcast in practice: the red run's root held at least 255 files that another check had left, about the broadcast's depth if each removal is a frame, the watcher's filter was not read for them, and whole runs with the same leftovers passed. What part the Rust gate compiling beside the red run played. What a user who acts on a row of the kept tree is answered. The browser, its driver and the built bundle were not read. No report from use: the state is read from the code and from one picture.
