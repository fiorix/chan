# A live drawing's scene snapshot applied before the drawing library's init is wiped

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the plan for the fix that keeps a drawing on disk from becoming a scene nobody drew ([the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md); `dev/v0101-team/followups/followup-Frontend-Lead-9.md` in the development tree, section 5, "The session's snapshot in each case", its case 2), which read the app at `b1ef073ae` and the drawing library's source at the installed `@excalidraw/excalidraw` 0.18.1, and read that the board could show empty until the next remote update; read again in the app at `dcc5670e0`, where the snapshot is still wiped and the board now shows the drawing of the tab's finished load in its place. Not run.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended. The owner accepted in one answer every recommendation the lead had put to them that day; for this item it was to accept it for this version, built after the work that makes the canvas seed only from the whole of a finished load, the next work of [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md).

## What was seen

With scene sync on, a drawing's canvas binds its scene session as soon as the drawing library hands over its imperative API (`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte:304-312`). The binding applies the session's snapshot at once when the session already holds one (`bindCanvas`, `src/state/sceneSync.svelte.ts:395-411`), and a snapshot that arrives later is applied to a bound canvas the same way (`onSnapshot`, `:776-801`, the apply at `:798-801`); both go through the canvas's `updateScene` (`applyRemote`, `ExcalidrawCanvas.svelte:177-214`). The record read in the library's source that the API is handed over in the library's constructor, before its init, and that the init then replaces every element with the initial data the board was rendered with; the canvas's stand-in for the library cites the same lines (`src/__tests__/excalidrawLibrary.ts:5-14`). So a snapshot applied between the handover and the init is wiped by the init.

How that order is reached, from a later record (`dev/v0101-team/followups/followup-Frontend-Lead-10.md` in the development tree, section 5, "Finding 4's order is reachable"), read again at `d1fe06c86`. A live drawing moved to another pane keeps its session and its snapshot through the remount: a canvas's release lingers 250 ms so that a cross-pane move keeps the socket and the snapshot, and the new canvas's acquire takes the lingering session back (`SCENE_RELEASE_LINGER_MS`, `src/state/sceneSync.svelte.ts:58-61`; `release`, `:529-541`; `acquireSceneSession`, `:950-971`; the host's effect, `src/components/FileEditorTab.svelte:397-414`). The new canvas binds at the library's handover of its API (`ExcalidrawCanvas.svelte:304-312`, `:403-407`), and the bind replays the snapshot the session already holds (`bindCanvas`, `src/state/sceneSync.svelte.ts:399-411`), which is before the library's init by the reading of the library above (read). More narrowly, a mode switch of a loaded tab to its canvas starts a session while the new canvas awaits its imports (`ExcalidrawCanvas.svelte:426-440`), and a snapshot that arrives before them is replayed at the handover the same way (inferred). This paragraph was added on 2026-09-27.

What the board shows after that, read at `dcc5670e0`:

- **The drawing of the tab's finished load.** A session attaches only to a tab whose load has finished (`isSceneSyncEligible`, `src/state/sceneSync.svelte.ts:115-123`). If the canvas was created after the load, the init's initial data is that buffer (`ExcalidrawCanvas.svelte:396-400`, `:439`); if it was created during the load, the canvas's seed at the library's first change applies the buffer, since the buffer then differs from the one the canvas was created with (`:362-365`, `:343-357`). The record read the second case at `b1ef073ae`, before that seed existed, as an empty board.
- **Not the session's state.** What the session held beyond the loaded file, such as a peer's edit the file did not yet carry, stays off the board until the session applies another snapshot, which it gets on each attach (`crates/chan-server/src/routes/scene.rs:12-13`); an update applies only the elements it carries (`onUpdate`, `src/state/sceneSync.svelte.ts:812-822`).

The record reads no file as exposed, inferred and not run. While the session is attached the classic save stays quiet (`isDocSavePaused`, `src/state/tabs.svelte.ts:5703-5704`). The board then offers the session every element whose version differs from what the snapshot recorded (`sceneDeltas`, `ExcalidrawCanvas.svelte:8-17`; the snapshot's versions noted at `:201`; `pushDeltas`, `:219-246`), the loaded file's older copies included, and the authority merges each element by the drawing library's version rule (`crates/chan-server/src/routes/scene.rs:7-11`), where, as the review of that fix read it, an older copy loses. An element only the session holds is not on the board, so nothing offers its deletion.

## Desired contract

With scene sync on, once a drawing's session holds a snapshot, the board shows the session's state, whether the session bound before or after the drawing library's init, and nothing the board offers the session after its init is an element the snapshot had already beaten.

## What to do

Apply the session's snapshot only once the library is past its init: bind the session when the library stops reporting its loading state, the point at which the canvas seeds (the record's proposal, binding after the library's first change), or replay the snapshot at the seed. Decide what a live board seeds from, since the seed puts the tab's buffer on the board and its elements are then offered to the session as local changes. The stand-in has no session today, so it needs one that can hold a snapshot at the handover. Red first: a mounted test over the stand-in in which the session holds a snapshot when the library hands over its API, and the board after the init lacks the snapshot's elements.

## Boundaries

`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte` (the bind effect and `seed`), `src/state/sceneSync.svelte.ts` (`bindCanvas`) if the replay moves, `src/__tests__/excalidrawLibrary.ts` and the canvas's tests. The server's scene sessions are unchanged.

## Acceptance

1. With a session that holds a snapshot when the library hands over its API, the board after the library's init holds the snapshot's elements and appState; pinned by a mounted test over the stand-in, red first.
2. The same for a snapshot that arrives between the handover and the init.
3. After the init, the board offers the session no element whose version the snapshot had beaten; pinned by the same tests.
4. A reading on a display with scene sync on: two drawings opened in a row from the file tree, the second with a peer's edit its file does not carry, show that edit.
