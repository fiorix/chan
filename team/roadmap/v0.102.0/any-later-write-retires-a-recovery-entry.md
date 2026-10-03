# Any later write of a file retires its recovery entry, and a live board's close causes one

Status: accepted by the owner on 2026-09-29 for a later version than v0.101.0, so it is held under v0.102.0; raised during v0.101.0 on 2026-09-29 by the independent review of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](../done/two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reviews/review-Frontend-18.md` in the development tree, finding 5, with the lead's notes, which raise it at the landing). The rule is older than that range, which relies on it for every window that goes. Read at `e07f3862f`; each step is read and the sequences are inferred; not run. Ruled on 2026-10-03: see Owner ruling.

## Owner ruling

Accepted on 2026-09-29 for a later version. The owner accepted in one answer every recommendation the lead had put to them that day, and with that answer closed v0.101.0's intake under one rule: a raised item enters v0.101.0 only when it loses a user's data or weakens security and its fix is small and local, a test-only or infrastructure item only when it makes the release gate or a release job unreliable, and an item whose fix changes a contract or reopens excluded scope, or whose fault is a wrong state with a rare trigger, goes to v0.102.0. Under that rule this item goes to v0.102.0 with [a-desktop-recovery-entry-ends-with-its-run](a-desktop-recovery-entry-ends-with-its-run.md), as one design of the recovery buffer: the rule serves every editor, so its fix changes what the recovery buffer promises each of them; the rule is older than v0.100.0, and the changelog states it for v0.101.0. The shape is not ruled: the rule by which an entry is stale, and where the buffer lives. When it was raised the lead recommended accepting it for v0.101.0, since a stroke is lost with no word. It is not part of v0.101.0.

On 2026-10-03 the owner ruled, as the lead recommended: an entry is stale only once the file holds what the entry holds. The rule compares content, not the file's mtime.

## What was seen

Lines at `e07f3862f`. The next open of a file drops a recovery entry whose stamp is older than the file's mtime (`divergentBufferOrNull`, `web/packages/workspace-app/src/state/editorBuffer.ts:308-314`), on the premise that the page's clock and the file's mtime are one machine's clock (`:291-293`). A live board's authority writes the file 800 ms after it turns dirty, on a 200 ms tick (`crates/chan-server/src/scene_sessions/mod.rs:71`, `:81`), and asks for a write at once when its last attachment detaches (`SceneAttachHandle`'s drop, `mod.rs:1216-1227`); a read of a drawing whose session is live carries the scene's disk mtime (`crates/chan-server/src/routes/files.rs:1367-1381`). The review's three ways, each inferred:

- **A live board.** One window pushes stroke A, and the authority has not written it; stroke B is inside its wait when the window closes. The close hands B's push to the socket and stamps an entry that holds A and B; if B's frame does not leave before the window dies, the socket's close detaches the last attachment and the authority writes A at once, after the stamp. The next open drops the entry: B is in no file and was never offered.
- **A save on the wire.** Without a session, a save of older content that lands after the stamp drops the entry the same way.
- **Two clocks.** A page reaching a devserver on another machine whose clock runs ahead drops every entry stamped within that lead of the file's last write (the fix round's report, `dev/v0101-team/reports/report-Frontend-33.md`, "Ruling 7", its fifth line).

`web/packages/workspace-app/src/editor/design.md:88` names the rule and the live board's write at its last detach.

## Desired contract

A recovery entry is retired only once the file holds what the entry holds, or its user is told that it was retired.

## What to do

As suggestions: compare the entry with the file's content or the authority's version rather than with the file's mtime, or keep an entry whose content the file lacks and offer it. The rule serves every editor, so the choice is the owner's.

## Boundaries

`web/packages/workspace-app/src/state/editorBuffer.ts` (`divergentBufferOrNull`) and its callers in the editor's host, with their tests.

## Acceptance

1. A write of the file after an entry's stamp that lacks the entry's last change leaves the entry offered at the next open; pinned red first.
2. An entry whose content the file holds is not offered; pinned.

## What shipped

Built on 2026-10-03 on the v0.102.0 integration branch and not on `main`, in a range the lead accepted on its report, its status files and the lead's own reading of its product diff. This record was written that day from those. No browser and no display was driven.

A recovery entry is retired by content and never by the file's mtime (`divergentBufferOrNull`, `web/packages/workspace-app/src/state/editorBuffer.ts`): the next open offers an entry from another page load whenever its content differs from the file's, however late the file was written. Pinned both ways for a text file and for a drawing. Its cost, kept by the lead's ruling: a live drawing's authority writes the file in its own serialization, which never equals the board's byte for byte, so a window closed between a stroke and its acknowledgement offers a restore even when the push arrived. Restore then puts back the scene the file holds and Discard drops it; nothing is lost either way, where the old rule was silent in the case that lost the stroke too. With it, a save dismisses an offered banner only when it puts the buffer's content on disk. The editor's design takes its sentence in a later range.
