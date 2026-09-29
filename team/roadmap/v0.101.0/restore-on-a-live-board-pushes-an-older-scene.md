# Restore on a live board puts an older scene on the board and pushes its appState over a peer's

Status: raised for a decision on LANDING-DATE by the independent review of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reviews/review-Frontend-18.md` in the development tree, finding 6, with the lead's notes, which raise it at the landing). The mechanism is older than that range, which makes an entry for a live board the usual result of a close inside a stroke's wait. Read at `e07f3862f`; inferred from the code read, not run. Recommendation, by the lead's rule for this landing: accept for v0.101.0, since a peer's background is written over.

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
