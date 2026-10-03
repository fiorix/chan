# Restore on a live board puts an older scene on the board and pushes its appState over a peer's

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 by the independent review of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](../done/two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reviews/review-Frontend-18.md` in the development tree, finding 6, with the lead's notes, which raise it at the landing). The mechanism is older than that range, which makes an entry for a live board the usual result of a close inside a stroke's wait. Read at `e07f3862f`; inferred from the code read, not run. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0 with [a-background-the-authority-never-took-turns-back](a-background-the-authority-never-took-turns-back.md), as one item on what a live board's appState promises: its trigger is rare, and its fix needs the file editor's host and `web/packages/workspace-app/src/editor/ExcalidrawCanvas.svelte` changed, which the owner keeps closed in v0.101.0 for every change but the guard of [a-drawing-library-crash-publishes-an-empty-scene](../done/a-drawing-library-crash-publishes-an-empty-scene.md). The shape is not ruled: what Restore means on a live board. When it was raised the lead recommended accepting it for v0.101.0, since a peer's background is written over. It is not part of v0.101.0.

On 2026-10-03 the owner ruled, as the lead recommended: Restore on a live board applies what the entry holds beyond the authority's scene as a local change over the snapshot.

## What was seen

Lines at `e07f3862f`, under `web/packages/workspace-app/src/` where no other path is named. A read of a drawing whose scene session is live serves the authority's scene with the mtime of its last write (`crates/chan-server/src/routes/files.rs:1367-1381`), so the next open offers an entry whenever the authority has not written since the entry's stamp and the entry's bytes differ from the scene's (`divergentBufferOrNull`, `state/editorBuffer.ts:294-316`). Restore writes the entry into the tab's buffer (`restoreFromBuffer`, `components/FileEditorTab.svelte:334-340`); the board, whose buffer is then not its own last serialization, seeds from it and replays nothing (`editor/ExcalidrawCanvas.svelte:570-579`); and its next flush offers every element whose version moved past what was sent and pushes an appState that differs from the authority's (`pushDeltas`, `:280-310`, the appState at `:287-290`).

The review's steps: two windows share a drawing; one reloads inside a stroke's wait; before the authority's next write a peer picks a background and draws in the other; the reloaded window offers the entry, and its user presses Restore. The board shows the entry's elements and lacks the peer's new one until an update names it, and the entry's background is pushed, which every window then takes. A reseed from a buffer older than the authority is named in `editor/design.md:92`.

## Desired contract

Restore on a live board does not put back over the authority what a peer changed after the entry's stamp, or it says what it replaces.

## What to do

As suggestions: offer a live board's entry as the elements and appState it holds beyond the authority's scene, applied as a local change over the snapshot, or offer none while a session holds the file and push the entry's own changes only.

## Boundaries

`web/packages/workspace-app/src/components/FileEditorTab.svelte` (the recovery banner and `restoreFromBuffer`) and `src/editor/ExcalidrawCanvas.svelte` where the seed meets a session, with their tests.

## Acceptance

1. Restore of an entry on a live board whose scene a peer changed after the entry's stamp pushes no appState older than the peer's and keeps the peer's elements on the board; pinned red first.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted after two repairs, on its reports, its status files and an independent review of each part. No browser was driven. This record was written that day from those.

Restore on a drawing's recovery banner merges only on a board that adopted a snapshot of a session that can still reach its authority. There it adds what the recovered scene holds beyond the live one, its new elements and its newer copies, takes no grid or background and restores no deletion. The entry is cleared only when the board took something of it, and the merged buffer is stored in its place in the same turn. When the recovered scene holds nothing newer, or cannot be read as a drawing, Restore changes nothing, keeps the entry and says why in the banner. On any other board Restore puts the entry's scene back whole, as before.

Left, as the owner's two limits state: Restore on a live board takes no appState and restores no delete. An entry whose only extra is a file the board lacks counts as applied.
