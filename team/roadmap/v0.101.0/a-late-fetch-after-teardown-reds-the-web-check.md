# A late fetch after a test's teardown reds the web check

Status: accepted for v0.101.0 by the owner on 2026-09-24; raised during v0.101.0 on 2026-09-23. From the intake gate of the first three v0.101.0 lanes: `make web-check` failed once on the integration candidate with every test passing, and passed on the same sha when rerun. The mechanism below is a source reading against `main` at `5fe07b465`; which promise dropped its handler was not established.

## What was seen

The gate's vitest run of `@chan/workspace-app` ended with 432 files and 4570 tests passed and two unhandled rejections, `TypeError: Failed to parse URL from /api/workspace` and the same for `/api/fs?dir=`, both attributed to `src/components/fullWindowCoverContract.test.ts` after its last test, `drops its cover`. Vitest fails the run on an unhandled rejection whatever the test counts say, so `make web-check` went red and the gate stopped at step 16 of 19. The run took 544 seconds with three other lanes compiling in the same container; the rerun on the same sha, on a quieter box, was green, and the lane whose `web/` tree the candidate carried had been green on it as well.

By reading: the test mounts `App` over a demo workspace (`installDemoWorkspace`, `web/packages/workspace-app/src/demo/install.ts`), which points the transport's fetch at an in-memory router, and its `afterEach` unmounts the components and calls `uninstallDemoWorkspace`, which sets that fetch back to null. Nothing waits for the app's bootstrap to settle first. The two URLs are the ones `bootstrap` (`web/packages/workspace-app/src/state/store.svelte.ts`) fetches in order: `api.workspace()` through `workspaceWithRetry`, which retries with a 250 ms step backoff on a transient error, then `api.list("")` in `refreshTree`. A fetch from that chain, or from anything else the mounted app schedules, that runs after the teardown reaches Node's own `fetch`, which rejects a relative URL, and by then no test holds the promise, so vitest reports it as unhandled. Under load the chain is more likely to straddle the teardown, which is why the gate saw it and the rerun did not.

## Desired contract

A test's teardown leaves no continuation of the app's bootstrap able to reach the transport afterwards, so the web check's verdict does not depend on how loaded the box is.

A second signature of the same family, seen on 2026-09-24 on an integration candidate with no change under `web/` (`dev/v0101-tasks/evidence/int/gate-4f451ef.log`): every test passed (432 files, 4570 tests) and vitest reported one uncaught exception, `ReferenceError: window is not defined` from `persistStateToHash` (`store.svelte.ts:3059`) called by the `schedulePersistStateToHash` debounce timer, attributed to `src/components/graphDepthProbeFailure.svelte.test.ts` after its environment was torn down. The debounce timer is armed by a layout mutation during the test and outlives the test's `window`. The fix below should cover any timer or continuation the app arms, not only the bootstrap's fetch.

## What to do

Either make the cover test wait for the bootstrap to settle before it unmounts, or give the bootstrap chain a cancellation that unmounting the app triggers, and make the demo transport's uninstall fail loudly on any later call, with a fetch that throws a named error instead of falling through to the real one, so a leak reads as the test that leaked it. Acceptance: a test that fails on a transport call after teardown, green with the fix and red without it; and `make web-check` green on the box while the other lanes' gates run beside it.
