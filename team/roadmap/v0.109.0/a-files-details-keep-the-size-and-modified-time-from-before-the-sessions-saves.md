# A file's Details keep the size and modified time from before the session's saves

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's reading of the editor-save watch item's range; closes in the round.

## What was seen

A save noted without a window (every editor autosave through the doc and scene sessions, a workspace write through the API, an upload's replace arm, an attachment, a contact) sends no watch frame once the editor-save watch item lands, by that item's contract. The only relist a watch frame drives is the store's watch handler, and tree entries change only by a listing, so no window relists the saved file's directory: the listing's size and modified time for the file stay at their last listing. The readers are the Details card's size and modified rows and its Code section, which refetches its counts only when the entry's modified time changes, and a directory's latest-modified and bytes in the Details and workspace cards. A person editing with Details open sees the values from before the session's saves until a File Browser refresh, an outside change in that directory or the window's resume lists the directory again. On Linux by source and the editor-save item's bus pin; on FreeBSD the parent's catch-up relists the directory; the macOS and Windows backends are not established. Standalone Files is unaffected, since its commit synthesizes an attributed `fs` frame. Read at source; no browser check reads the Details grid.

## Desired contract

After a save the tree entry of the saved file carries the saved size and modified time in the saving window and in every window attached to the file's doc or scene session, so the Details card's rows and its Code section follow the session's saves without a relist.

## What to do

Patch the saved path's tree entry from the doc session's flush frame (its `mtime_ns`, which every participant window receives, and a `size` field added to the frame from the stat the server reads beside it, since the frame carries no size and the page knows the flushed bytes only when the session is clean) and the scene session's equivalent, and from a classic save's answer; a store pin red first at the parent on the entry's size and modified time after a flush frame and after a classic save's answer, and a server pin red first that the flush frame carries the saved size, with one mutant per guard. A window without the file open refreshes at its next listing, recorded as the limit.

## Boundaries

`state/store.svelte.ts` at the tree entry writers, `docSync.svelte.ts` at the flush frame, `state/tabs.svelte.ts` at the classic save's answer, `crates/chan-server/src/doc_sessions/mod.rs` and `scene_sessions/mod.rs` where they fan the flush frame, their tests, the server design's flush-frame sentence and the workspace app's `design.md` where it states what a save refreshes. Not changed: the watch path and the bus (a frame for a windowless save is outside the editor-save watch item's contract), the listing endpoints, the Details card.

## Acceptance

1. A pin red first at the parent: after a doc session's flush frame the tree entry of the saved file carries the frame's modified time and size; after a classic save's answer the same; one mutant each. A server pin red first at the parent: the flush frame carries the saved size; its mutant.
2. `make web-check` green at the commit; `cargo fmt --check`, clippy on all targets and `cargo test -p chan-server --all-targets` green at the commit.
