# Editor recovery records live inside the workspace tree

Status: accepted for v0.104.0 by the owner's word of 2026-10-08, given directly to the lead during the round: chan's own control files move out of the workspace into chan's control directory, and the directories that already exist at workspace level are left alone, neither migrated nor deleted.

## What was seen

Serving a directory as a workspace writes a `.chan/` directory into it: the editor's recovery records, one bounded JSON file per document or drawing with unsaved authority, under `.chan/editor-sessions/v1/documents/<path>.json` and `.chan/editor-sessions/v1/scenes/<path>.json`, written by `crates/chan-server/src/doc_sessions/recovery.rs` (`recovery_path`, line 184 at the base) through the workspace facade's atomic writer and read back by its bounded reader; the scene sessions use the same tree. The facade treats `.chan` as internal (`chan-workspace/src/fs_ops.rs` line 82, the walkers and the watcher drop it, the graph and the file surfaces hide it), so chan itself never shows the directory, but the user's own tools do: it appears in `git status` of every served repository, and the repository of chan itself carries a `.gitignore` entry for it ("In-workspace state dir chan creates when the repo itself is served as a chan workspace", `.gitignore` line 76). On the owner's machine both served checkouts hold one. Every other per-workspace sidecar (the search index, the graph database, the session blobs, the persisted report) already lives under the chan home in the workspace's sidecar directory, `<chan home>/<metadata_key>/`, keyed by the registry row (`chan-workspace/design.md`: "the co-located chan home for workspace sidecars"), and `reset_workspace` wipes that directory and never touches the user's tree. The in-tree drafts directory (`.Drafts/` by default, a configured name) is a product feature by design and is not this item's; the owner says if it moves too.

## Owner decision, 2026-10-08

Move the recovery records out of the workspace into chan's own per-workspace control directory; users should not have to ignore or wonder about chan's control files. The `.chan/` directories that already exist at workspace level are not migrated and not deleted by chan: they are left as they are, no longer read or written, and the release note says a user may remove them. Given by the owner in the lead's terminal; no survey.

## Desired contract

Serving a workspace writes nothing into its tree but the user's own files and the configured drafts directory. Editor recovery records live under the workspace's sidecar directory in the chan home (`<chan home>/<metadata_key>/editor-sessions/v1/...`, the same tree shape), with the same atomic write and bounded read they have today; an open after a restart recovers from there; `reset_workspace` wipes them with the other sidecars; a record under a workspace's old `.chan/editor-sessions/` is neither read nor written.

## What to do

Give the recovery store a root in the sidecar directory through the workspace (an accessor for the sidecar path if none exists, in `chan-workspace`, keeping the atomic-writer and bounded-reader guarantees outside the user-content facade), change `recovery_path` and the scene sessions' use of it, and keep the record format. Red first: a pin that a saved recovery record lands under the sidecar directory and not under the root, and that the root holds no `.chan` after a session with unsaved edits; a preservation pin that an open after a restart recovers the record from the new place. Update `crates/chan-server/design.md` and `crates/chan-workspace/design.md` where they describe the records' place, the repository's `.gitignore` comment, and the changelog, whose entry tells users that an existing `.chan/editor-sessions/` in a workspace is no longer used and may be deleted.

## Boundaries

`crates/chan-server/src/doc_sessions/recovery.rs`, `doc_sessions/mod.rs` and `scene_sessions/mod.rs` with their tests; `crates/chan-workspace` where the sidecar path accessor is added; `crates/chan-server/design.md`, `crates/chan-workspace/design.md`, the root `.gitignore` comment and `CHANGELOG.md`. No migration code, no deletion of an existing in-workspace directory, no change to the drafts directory.

## Acceptance

1. A document and a drawing with unsaved authority write their recovery records under `<chan home>/<metadata_key>/editor-sessions/v1/`, and the workspace root holds no `.chan` entry afterwards; pinned red first.
2. An open after a restart recovers the record from the sidecar directory; pinned (a preservation pin, green before and after on the behavior, moved to the new place).
3. A record left at the old in-workspace path is not read: pinned by placing one there and asserting no recovery is offered.
4. `reset_workspace` removes the sidecar's `editor-sessions` with the rest; pinned.
5. fmt, clippy and the whole `chan-server` and `chan-workspace` suites green at the commit in the owning guest; the browser check that exercises editor recovery, if one exists, green alone; the two design documents and the changelog entry read by the reviewer.
