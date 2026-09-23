# A canvas edit made during an outage can be lost

Status: shipped in [v0.100.0](../../release/release-v0.100.0.md): A canvas change counts as sent only when it was sent, every session kind registers all five contract members, and a degraded session has exactly one writer.

## What was seen

**A dropped push is recorded as sent.** `pushScene` in `web/packages/workspace-app/src/state/sceneSync.svelte.ts` returns `void` and drops silently on a closed socket, a missing snapshot or a read-only attach. `editor/ExcalidrawCanvas.svelte` marks the deltas as broadcast (`noteVersions`) before it calls the push, and `hasPendingLocal()` re-derives from that same map. A shape drawn while the scene socket is down is therefore marked as sent and never pushed again, and it reaches neither the authority nor the classic PUT, which the SPA suppresses while the server is unreachable (`isDocSavePaused`). It is then absent from the next flush and from the file. The server is not a participant: a push is the only way an element enters the scene authority, a reattach is a one-way snapshot, and with the socket up and the session merely degraded the classic PUT still carries the shape and the server adopts it, because `crates/chan-server/src/routes/files.rs` diverts a PUT into a live scene session. The rescue for the socket-down case already exists, the flush of locally newer elements on every snapshot in `sceneSync.svelte.ts`, and the premature mark is what defeats it.

**A degraded session keeps pushing.** A scene session that has degraded to classic autosave keeps pushing to the authority while the autosave PUTs the same file, so two writers race on one document.

**The contract under both.** `state/tabs.svelte.ts` defines five registration points for a live editing session: a save delegate, a release hook, a save-paused query, an unflushed query and a fallback-saved hook. `docSync.svelte.ts` fills all five. `sceneSync.svelte.ts` fills three, and its module header lists those three as if they were the contract. The two it leaves empty are load-bearing: `isDocUnflushed` answers false for every canvas tab, so the force-reload prompt does not warn that the authority holds unflushed scene state, and with no fallback-saved hook a degraded scene session never takes save ownership back.

## Desired contract

A local canvas change counts as sent only when it was sent. A session kind registers all five members at once or does not compile; a member that is deliberately a no-op is written as one. A degraded session has exactly one writer.

## Boundaries

`web/packages/workspace-app/src/state/sceneSync.svelte.ts`, `state/docSync.svelte.ts`, `state/tabs.svelte.ts` (the five registrars become one `registerLiveSessionKind` taking an object with all members required), `editor/ExcalidrawCanvas.svelte`, and the tests `state/sceneSync.test.ts`, `state/docSync.test.ts`, `state/forceReloadFromDisk.test.ts`. `pushScene` returns a boolean: false at both drop sites, true on the coalescing branch, and the canvas calls `noteVersions` only on true. Merging the two sync modules' socket lifecycles is a separate, larger question and is out of scope.

## Acceptance

1. A test draws an element while the scene socket is closed, reconnects, and asserts the element reaches the authority.
2. A canvas tab with unconfirmed pushes reports `isDocUnflushed === true`, and the force-reload prompt warns.
3. A degraded scene session stops pushing, and resumes after the fallback save hands ownership back.
4. Each live-session module registers a kind with all five members present, enforced by the type.
