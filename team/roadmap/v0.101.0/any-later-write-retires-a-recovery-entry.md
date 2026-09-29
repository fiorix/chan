# Any later write of a file retires its recovery entry, and a live board's close causes one

Status: raised for a decision on 2026-09-29 by the independent review of the two closes that keep a drawing's last stroke ([two-closes-still-drop-a-drawings-last-stroke](two-closes-still-drop-a-drawings-last-stroke.md); `dev/v0101-team/reviews/review-Frontend-18.md` in the development tree, finding 5, with the lead's notes, which raise it at the landing). The rule is older than that range, which relies on it for every window that goes. Read at `e07f3862f`; each step is read and the sequences are inferred; not run. Recommendation, by the lead's rule for this landing: accept for v0.101.0, since a stroke is lost with no word.

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
