# An unreadable workspace file locks every window that boots behind the preflight cover

Status: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the review seat on 2026-10-13 from its read of check 131's control test (F1 and its proposed repair B in `reviews/review-Review106-chk131-test-1.md` in the round's bus); written down the same day by the lead as a row of its own, outside that item; owner the frontend seat with the server; not reached in the v0.106.0 round

## What was seen

A Markdown file the server cannot read (permission denied) makes the indexer's per-file apply fail and store `IndexStatus::Error`; the preflight route maps that status to a failed index step and a locked snapshot; a workspace window that boots while the status reads `Error` raises the preflight cover, which shows the step as failed with the message and no control, and the app drops every command but the close confirmation and every chord while the cover is up. The status stays `Error` until some other change is applied, so the window stays covered with no close and no escape for as long as nothing else in the workspace changes. Measured in the review seat's guest with check 131 against a built `chan`: the sticky arm held the cover for the whole 20 s poll. A window already loaded before the error is not touched. An unreadable file is easy to meet where a container writes into a workspace as another user; that case was not constructed. The transient cousin, a file that vanishes between the metadata check and the read, is check 131's own item and its repair A.

## Desired contract

A failure of the watcher's per-file apply to index one of the user's own files is a warning about that file, not a health failure of the index: the status stays idle, the warning names the file, and the preflight does not lock a window on it. The index's own failures (the graph, the index or the journal failing to write) keep setting `Error` and locking the preflight as they do today.

## What to do

Read `chan-workspace`'s `index_file_serial_or_source_error`, which already holds the two failure kinds apart (the user's file unreadable, against the graph, index or journal failing) and `index_file`, which flattens them; carry the split to the watcher's per-file apply so the first kind warns and leaves the status idle and the second kind sets `Error` as today. The watcher logs the skipped file and the reason; the preflight stays ready and unlocked without a new warning surface. Design before code; the review seat reads the design.

## Boundaries

`crates/chan-server/src/indexer.rs` (the per-file apply), `crates/chan-workspace/src/workspace.rs` (`index_file` and its error kinds), their tests; `routes/preflight.rs` and `PreflightOverlay.svelte` only if the decision adds a warning surface. Not changed: the lock on the index's own failures; check 131's repair A.

## Acceptance

1. A test in which an unreadable file is applied by the watcher: the warning names the file, the status reads idle, `GET /api/preflight` reads ready and unlocked; red first at the base on the status.
2. A test in which the index's own write fails: the status reads `Error` and the preflight locked, as today.
3. A constructed browser run of a window booting beside an unreadable file: no cover, the commands delivered.

## Reached with an ordinary file 2026-10-13

The hygiene seat's reading of the suite's check 64 after check 59 (`dev/v0106-team/tasks/task-Hygiene106-Lead106-26.md`; the row `chk64o`) met this fault with no permission change: check 59 writes `bad-utf8.md`, a Markdown file that is not valid UTF-8; the server's indexer reports `bad-utf8.md: io error: stream did not contain valid UTF-8`; the next page to boot shows the full-viewport cover "Preparing workspace, Build search index, failed, bad-utf8.md" (screenshots at the integration tip `143219483`, Chrome for Testing 155), and stays covered after an unrelated check ran between them; the page's editor is mounted behind the cover and what the test typed never reached the document authority. So a file in an older encoding, or any file named as Markdown whose bytes are not UTF-8, is enough: once it is created or changed while the server runs, every window opened afterwards is held behind the cover with no control, until some other file is indexed. Not read yet: whether a workspace that already holds such a file locks at the server's start (the full rebuild's path), which decides how bad this is for a user who has one.

The lead's ruling: this row is ordered in the round as a reading and a design, by the runtime seat (the indexer's per-file apply and `chan-workspace`'s `index_file` are its crates; the frontend seat's lane is full): the start-up path measured first, then the design the row's "What to do" names, to the review seat before any code. Whether the repair is built in the round depends on the review queue; if it is not, the row stays designed and not built and the owner is told plainly at the candidate.

## The start-up path measured 2026-10-13

By the hygiene seat (`dev/v0106-team/tasks/task-Hygiene106-Lead106-28.md`; `evidence/Hygiene106/idxlock-reading-1/`, the predictions frozen before the first run), in its guest's Chrome for Testing 155 with a debug `chan` built at `a5b938f71` (the indexer, the workspace crate, the preflight route and the overlay byte-equal to the integration tip's), each arm a fresh disposable server and workspace:

| Case | Index status and preflight | The page |
| --- | --- | --- |
| a valid note and a Markdown file that is not valid UTF-8, both present before the server starts | idle, one document indexed; ready, unlocked | no cover; a command splits the pane |
| a valid note and a Markdown file of mode 000 (a plain read by the server's user first shown refused), both present before the start | idle, one document indexed; ready, unlocked | no cover; the command works |
| the valid note alone (the control) | idle; ready, unlocked | no cover; the command works |
| the malformed file written after a page-less server had settled | error, `bad-utf8.md: io error: stream did not contain valid UTF-8`; failed, locked | the cover "Preparing workspace, Build search index, failed" with the file's error; the command has no effect |
| after that, a second valid file written | idle, two documents indexed; ready, unlocked | no cover; the command works |

So the two paths disagree about the same file. The full rebuild at the server's start skips a user's file it cannot read or decode and finishes idle (the graph walk skips the read failure, `crates/chan-workspace/src/workspace.rs` 3380 to 3383, and the search build records it in its summary, `index/facade.rs` 605 to 645 and 871 to 877); the watcher's per-file apply turns the same failure into `IndexStatus::Error` (`crates/chan-server/src/indexer.rs` 970 to 1031 and 1207 to 1272), which the preflight maps to a failed step and a lock (`routes/preflight.rs` 168 to 209, 270 to 295). What it means for a user: a workspace that already holds such a file opens normally; if such a file is written or changed while the server runs, a window opened afterwards boots behind the cover with no control and its commands blocked, until some other file is indexed or the server restarts. Narrower than feared (no lock at start-up), and still a window a person cannot use for a reason the product could have skipped, as its own rebuild does.

The lead's ruling on the design's direction, for the runtime seat's note and the review seat's read: the watcher's per-file apply is made to agree with the rebuild: a failure to read or decode one of the user's own files is skipped with a warning that names the file, the status stays idle and the preflight does not lock; a failure of the index's own state (the graph, the index or the journal) sets the error and locks as today. The split `chan-workspace` already holds between the two kinds is the carrier.

## The design written and its boundary ruled 2026-10-13

The runtime seat's design note is in the round's bus (`reports/design-Runtime106-idxlock.md`, with its hand-back `tasks/task-Runtime106-Lead106-28.md`), written from the measurement above and the source at `4aed59d16`, with no run of its own. It carries the split `chan-workspace` already holds to the watcher through one new entry point that returns a source failure apart from a failure of the index's own state: a file that cannot be read or decoded is forgotten from the graph and the search index as the per-file path already does, named in one log warning, and leaves the status idle; a failure of the graph, the index or the journal, a not-found from the journal's own directory among them, still sets `Error` and locks. Two product files, `crates/chan-workspace/src/workspace.rs` and `crates/chan-server/src/indexer.rs`; no change to the preflight route or its overlay; eight mutants named, each with the assertion it must fail.

Ruled by the lead on the seat's question, before the note was finished. The lead's earlier direction, that the watcher leave for such a file what the full rebuild leaves, is withdrawn: by source the rebuild has no single answer, no row on a fresh pass and the file's earlier search rows kept on a warm one. The item's agreement with the start-up path is skip and unlock, not equal rows; the rebuild and its failure policy are not changed here, and what the reading found about them is a row of its own. The warning is the server's log alone: a warning surface in the preflight needs rules for when a warning ends that this item does not have, so a workspace whose files cannot all be indexed says so only in the log, a stated cost. The desired contract and the "What to do" sentence above are narrowed to match.

Not built. The design goes to the review seat before any code, behind the ranges that are already built; the browser arm of acceptance 3 is the hygiene seat's rig. If the round's candidate is frozen first, the item ends designed and not built. It is frozen: the item ends designed, its design not read by the review seat (that read, its task 78, was cut and not reached in this version) and not built.
