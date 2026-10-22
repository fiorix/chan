# The multipart text fields wait without a bound on the async task

Status: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the release: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

A multipart upload's text fields are read on the async task before the file part, with no bound; a client that sends a field's start and goes silent holds the task, not a blocking-pool thread, for as long as the connection lives (the runtime seat's note at the stall item's design, 2026-10-16). Not established: what else the held task holds, and whether the connection's own idle bound ends it.

## Desired contract

A multipart upload whose client goes silent in its text fields is ended at the same bound as one silent in its file part, holding nothing past it.

## What to do

Read what the held task holds and what ends it; bound the field read by the tenant's stall signal as the lanes' consumer is, if the reading shows a hold past the connection's bound.

## Acceptance

1. The reading at source and constructed, with what the hold costs.
2. A repair and its pin if the hold is unbounded.

## Lead's rulings 2026-10-21

> (1) Taken as designed: the bound lives in `read_multipart_text_field`, fed the tenant's stall signal from each of the three upload entries through the shared prologue, an asynchronous per-chunk no-progress bound reset by each nonempty chunk (the file part's accounting), the 64 KiB and UTF-8 checks kept; fixed labels `multipart dir` and `multipart path`; a stalled field answers 408 `upload_stalled` through the existing mapper with one WARN in the file part's words and the accumulated byte count; every other metadata error keeps its 400 envelope and text; the registration and parser drop at the handler's return. The cancellation race is taken with it: each metadata wait also selects on `UploadControl::cancelled()`, a winning explicit cancel answering the existing 400 `upload_incomplete` with its one INFO line, since a carrier that answered `cancel_requested` and then left the request waiting for the bound would make upslot's "every started request" true in name only; precedence as the design recommends: a cancel ahead of a timer ready at the same poll, complete field data ahead of an expired timer when no cancel stands. Finalization and the admitted job's first-wins rule stay outside the prologue.

> (2) The adjacent gap is this item's: a client silent between parts or inside a part header is silent in its text fields in the row's sense. Taken in the design's recommended form: an ignored part before the file part is drained explicitly through the same bounded chunk reader (progress accounting, nothing accumulated), and each `next_field()` transition carries the stall bound as a deadline, documented in the crate's design text as a parser-operation bound (a part boundary and its header arrive within the bound). The body-level no-progress observer before multipart parsing is refused for this item: a larger extractor change the row does not state, with its own review if ever raised.

> No browser leg: the server pins with their real-socket arm are the guard, as stlraw's are; check 62 is unchanged.

> N5 ruled: the `BulkCancel` signal the lanes' consumer takes, not a bare `Duration`, so one tenant source carries the bound.

## Built 2026-10-22

The constructed reading at source and over a real connection establishes that an upload silent inside its destination text holds the async request, parser/body, tenant state and registration past the tenant bound, but no lane slot, blocking-pool thread, workspace strong handle or workspace-cell lock. Hyper finishes its header timer before the body, and multer has no body-idle timer. At `e547dcb28`, the 100 ms file-part control answers 408 at 101 ms; dir, path and cancelled-dir arms stay held past 2001/2002/2002 ms and release on client close. These are bounded observations; the unbounded hold follows from the await paths. The reading and source checks meet acceptance 1; their record is `reports/design-Runtime109-mpfld.md` and `evidence/Runtime109/mpfld/exported/read-1/` under the coordination root `dev/v0109-team/`.

The shared reader takes the tenant stall signal from workspace, terminal and standalone Files uploads. It bounds each field chunk on the async task, resets on nonempty progress, keeps the 64 KiB and UTF-8 checks for named metadata, and drains ignored contents without accumulating. Each part transition has a parser-operation deadline covering its boundary and header. Fixed labels and true byte counts reach the existing 408 `upload_stalled` mapper and one WARN. Every prologue wait selects tracked cancellation first, then ready data, then the timer; a cancellation answers 400 `upload_incomplete` with one INFO. Metadata refusals retain their 400 strings. Refusals drop the body/parser/registration before answering without admission, filesystem residue, extra workspace ownership or a held cell lock. Finalization and the admitted job keep their existing first-wins rules.

The pins cover all eight parser silence points, zero-byte named and ignored fields, all three tenant entries with and without tracking keys, cancellation before parsing and during each wait, ready-at-once precedence, chunk progress over several bounds, header progress across its single deadline, complete fields and file-first refusals, exact/over 64 KiB and split/invalid UTF-8, an ignored binary megabyte landing an actual upload, cumulative transition counts and a real socket answering 408 before the peer sends more. Paused Tokio time owns progress/deadline order; the socket arm asserts event order with a small real bound.

The retained first red compiles and fails eleven prologue-release assertions, but its wrapper exits 5 because its compiler-error search also matches Cargo's expected `error: test failed` summary. Corrected constructed reader controls and the second baseline run separate these outcomes: all eleven tests compile and fail their intended assertions, exit 101. The first green run passes eight and fails ten assertions because the paused runtime retains a fractional-millisecond fixture timestamp; advancing through the following timer tick repairs the test clock, with product source unchanged, and the second and third controls each pass all twenty tests. The first initial-timer mutation survives because its test supplies a nonempty chunk that resets the widened initial timer. Its surviving result and driver exit 1 remain in `evidence/Runtime109/mpfld/code20/checkpoint-18/exported/code20/`; the zero-byte pin covers that initial wait separately from the reset guard.

Limits: multer's header buffer is bounded in time by the transition deadline, not in size (N6). Attachments, contacts import, metadata import and standalone attachment readers retain their whole-field reads without a time bound and sit outside this item (N7). A file part waiting behind a full lane is governed by the lane's queued-silence policy, outside this pre-admission prologue (N8). No browser leg is assigned; the real-socket server pin is the transport guard and browser check 62 is unchanged.

The completed continuation control passes all 21 tests, exit 0. All fifteen mutations compile and fail their intended assertions, exit 101 each: the initial reader timer; each entry's tenant bound; progress reset; the stall mapper; warning level and duplication; cancellation at the field, drain and transition; an accumulating or missing drain; the transition timer; and retained registration. Each restores the exact source hashes. Focused clippy and formatting exit 0. The constructed result-reader controls distinguish a compiled assertion failure from a compiler error, an unexpected failure and a surviving mutation. The full raw record, per-case patches, commands, statuses, source hashes and final patch are in `evidence/Runtime109/mpfld/continuation20/complete/continuation20/`; its validated archive has SHA-256 `e18ecc7d8966c31b865ce10b0ccd7a97816cfbb6e10e603cb7bc14ff5c291985`. These pins and mutation checks meet acceptance 2. One guard has no pin: multer yields an empty chunk only as a field's last, after which the field ends, so the empty-chunk test around the timer reset in `consume_multipart_field` changes nothing, and a mutant that resets on an empty chunk too survives; the empty-body-frame pin holds through multer, which yields no empty chunk mid-field.

The committed verification record is `evidence/Runtime109/mpfld/gate20/`: formatting, workspace clippy with warnings denied, the whole server and CLI suites, and the server suite with a symlinked temporary directory, run as the guest's non-root build user with two build jobs and two test threads. The command, status and source records identify the checked commit. At `a735151d7`: formatting and clippy with warnings denied exit 0; the server suite passes 2,391 with 1 ignored (323 s), and again with `TMPDIR` through a symlink (396 s); the CLI suite passes 433 with 1 ignored; all contended under the guest's 2 CPU and 6 GiB caps.
