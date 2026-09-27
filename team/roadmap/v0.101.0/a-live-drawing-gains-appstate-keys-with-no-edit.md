# A live drawing whose stored appState lacks the serializer's keys is written with no edit

Status: accepted for v0.101.0 by the owner on 2026-09-27; raised for a decision on 2026-09-27 by the plan for the fix that seeds a drawing's board from its buffer as the drawing library restores it, the next work of [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md) (`dev/v0101-team/followups/followup-Frontend-Lead-10.md` in the development tree, section 5, "An older write without an edit"), which read the app at `71793f3ca` and the installed `@excalidraw/excalidraw` 0.18.1 as far as the authority's dirty mark, inferred the write from the flusher's description, and ran nothing; read again at `d1fe06c86`, where the canvas is as the last landing left it, and not run.

## Owner ruling

Accepted on 2026-09-27 for v0.101.0, as the lead recommended, in the owner's answer to it by its number. The recommendation placed it under the owner's ruling of 2026-09-26 that no surface but the Markdown editor writes a file without a user's edit.

## What was seen

With scene sync on, a live drawing's canvas pushes its appState to the session only when the appState it serialized differs, as JSON text, from the one the authority is known to hold (`pushDeltas`, `web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte:216-246`, the comparison at `:226-229`). The canvas's side is the appState of the library's serialization of the board (`flushSerialize`, `:367-384`; `serializeScene`, `:330-335`), which keeps a few persistent keys, the grid and the background (the comment at `:121-126`): as the record read the library, the grid's size, its step, grid mode and the background colour, each at the library's default where the file does not set it. The authority's side is set from every appState the canvas adopts, a snapshot's among them (`applyRemote`, `:209-213`). A snapshot carries the appState the authority parsed from the file as it stands (`Scene::parse`, `crates/chan-server/src/scene_sessions/scene.rs:224-228`), every attach gets one (`crates/chan-server/src/routes/scene.rs:11-13`), and the canvas applies it at its bind or when it arrives (`bindCanvas`, `src/state/sceneSync.svelte.ts:399-411`; `onSnapshot`, `:776-810`).

So after a snapshot of a file whose stored appState lacks some of those keys, or carries keys beyond them, the next serialization's keys differ from it and ride a push. The authority drops a pushed appState only when it equals the stored one as a value (`apply_push_with_limit`, `scene.rs:322`), so it takes this one as a change and marks the session dirty (`SceneAttachHandle::push`, `crates/chan-server/src/scene_sessions/mod.rs:1146-1172`, the mark at `:1164`), and its flusher then writes the file (the module's doc, `mod.rs:21-23`; inferred from it, as the record did, and not run). The file gains those keys in place of its appState, and the user drew nothing. Two kinds of file meet it: a file another program wrote, and a file whose appState is `{}`, which is the appState of chan's seed for a new diagram (`NEW_DIAGRAM_CONTENT`, `crates/chan-server/src/routes/drafts.rs:47-53`), though a draft itself never takes a scene session (`isSceneSyncEligible`, `sceneSync.svelte.ts:120-121`). A file whose appState holds exactly those keys can still be pushed when its JSON text differs, in key order for one, and the authority drops that push as equal, so nothing is written.

It falls under the owner's ruling of 2026-09-26 that no surface other than the Markdown editor writes a file without a user's edit, which [the-frontend-review-remainder-has-no-owner](the-frontend-review-remainder-has-no-owner.md) carries. The fix is in what the canvas compares before it pushes; the server's merge answers the push it is given.

## Desired contract

A live drawing nobody edits is not written: the canvas pushes an appState only when one of the keys the serializer keeps changed on the board, and a file whose stored appState lacks those keys or carries others stays as it is until a real edit, which may normalize it, as the ruling allows.

## What to do

Change what `pushDeltas` compares: the serialized appState against the authority's appState projected onto the keys the serializer keeps, with the library's default for a key the authority lacks, rather than against the authority's appState as text. A real change of one of those keys then still pushes. The server's scene sessions are unchanged. Red first: a canvas test over a bound session (`mountBound`, `src/editor/ExcalidrawCanvas.test.ts:271`) whose snapshot carries `appState: {}` and whose board nobody touches, asserting that no appState is pushed; at the code as it is, one is.

## Boundaries

`web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte` (`pushDeltas`, `flushSerialize` and the appState baseline) and its tests. The server's scene sessions and the seed of a drawing's board are unchanged.

## Acceptance

1. A live drawing whose stored appState is `{}`, opened and not touched, pushes no appState; pinned red first over a bound session.
2. The same for a stored appState that carries a key beyond the serializer's.
3. A change of the grid or the background on the board still pushes its appState.
4. A reading on a display with scene sync on: a live file whose `appState` is `{}`, opened and not touched, is not rewritten.
