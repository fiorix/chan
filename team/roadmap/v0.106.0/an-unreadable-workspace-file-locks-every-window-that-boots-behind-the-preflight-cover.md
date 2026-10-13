# An unreadable workspace file locks every window that boots behind the preflight cover

Status: raised by the review seat on 2026-10-13 from its read of check 131's control test (F1 and its proposed repair B in `reviews/review-Review106-chk131-test-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat with the server; not reached in the v0.106.0 round

## What was seen

A Markdown file the server cannot read (permission denied) makes the indexer's per-file apply fail and store `IndexStatus::Error`; the preflight route maps that status to a failed index step and a locked snapshot; a workspace window that boots while the status reads `Error` raises the preflight cover, which shows the step as failed with the message and no control, and the app drops every command but the close confirmation and every chord while the cover is up. The status stays `Error` until some other change is applied, so the window stays covered with no close and no escape for as long as nothing else in the workspace changes. Measured in the review seat's guest with check 131 against a built `chan`: the sticky arm held the cover for the whole 20 s poll. A window already loaded before the error is not touched. An unreadable file is easy to meet where a container writes into a workspace as another user; that case was not constructed. The transient cousin, a file that vanishes between the metadata check and the read, is check 131's own item and its repair A.

## Desired contract

A failure to index one of the user's own files is a warning about that file, not a health failure of the index: the status stays idle, the warning names the file, and the preflight does not lock a window on it. The index's own failures (the graph, the index or the journal failing to write) keep setting `Error` and locking the preflight as they do today.

## What to do

Read `chan-workspace`'s `index_file_serial_or_source_error`, which already holds the two failure kinds apart (the user's file unreadable, against the graph, index or journal failing) and `index_file`, which flattens them; carry the split to the watcher's per-file apply so the first kind warns and leaves the status idle and the second kind sets `Error` as today. Decide what the preflight shows for a workspace whose files cannot all be read (a warning line, not a lock). Design before code; the review seat reads the design.

## Boundaries

`crates/chan-server/src/indexer.rs` (the per-file apply), `crates/chan-workspace/src/workspace.rs` (`index_file` and its error kinds), their tests; `routes/preflight.rs` and `PreflightOverlay.svelte` only if the decision adds a warning surface. Not changed: the lock on the index's own failures; check 131's repair A.

## Acceptance

1. A test in which an unreadable file is applied by the watcher: the warning names the file, the status reads idle, `GET /api/preflight` reads ready and unlocked; red first at the base on the status.
2. A test in which the index's own write fails: the status reads `Error` and the preflight locked, as today.
3. A constructed browser run of a window booting beside an unreadable file: no cover, the commands delivered.

## Reached with an ordinary file 2026-10-13

The hygiene seat's reading of the suite's check 64 after check 59 (`dev/v0106-team/tasks/task-Hygiene106-Lead106-26.md`; the row `chk64o`) met this fault with no permission change: check 59 writes `bad-utf8.md`, a Markdown file that is not valid UTF-8; the server's indexer reports `bad-utf8.md: io error: stream did not contain valid UTF-8`; the next page to boot shows the full-viewport cover "Preparing workspace, Build search index, failed, bad-utf8.md" (screenshots at the integration tip `143219483`, Chrome for Testing 155), and stays covered after an unrelated check ran between them; the page's editor is mounted behind the cover and what the test typed never reached the document authority. So a file in an older encoding, or any file named as Markdown whose bytes are not UTF-8, is enough: once it is created or changed while the server runs, every window opened afterwards is held behind the cover with no control, until some other file is indexed. Not read yet: whether a workspace that already holds such a file locks at the server's start (the full rebuild's path), which decides how bad this is for a user who has one.

The lead's ruling: this row is ordered in the round as a reading and a design, by the runtime seat (the indexer's per-file apply and `chan-workspace`'s `index_file` are its crates; the frontend seat's lane is full): the start-up path measured first, then the design the row's "What to do" names, to the review seat before any code. Whether the repair is built in the round depends on the review queue; if it is not, the row stays designed and not built and the owner is told plainly at the candidate.
