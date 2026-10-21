# A raw-body text write whose client goes silent holds its thread and workspace with no bound

Status: carried into v0.109.0 at the v0.108.0 GA on 2026-10-21, still raised for a decision.

Record before the release: raised at the v0.107.0 cut on 2026-10-17 by the lead as the second half of that version's stall item, carried by the owner's word at the cut; written down with the repair's shape; owner the runtime seat at the next version's launch.

## What was seen

Read at source during the v0.107.0 stall item (its design note, `reports/design-Runtime107-stlsil.md` in that round's bus, part B). The three raw-body consumers in `crates/chan-server/src/routes/files.rs` (`accumulate_text_body`, whose callers are the doc-session and scene-session diverts of the text PUT and the standalone text write; `write_streamed_text`; `write_draft_file`) wait on a bare `blocking_recv` with no cancel and no bound, where the upload lanes' consumer and the downloads wait under the tenant's `stall_signal()`. A client that sends part of a text body and goes silent without closing holds one blocking-pool thread and the closure's workspace (or the draft write's pin) for as long as the connection lives, and is not answered; a workspace reset or a metadata import answers Busy while it is held. Each handler also awaits the feed before the consumer, so bounding the consumer alone frees the thread and the workspace but leaves the request unanswered: the repair races the feed against the consumer, as the upload lane does. Not established: that a user has met it; a constructed run (a body paused past a shortened bound) is the acceptance's first step.

## Desired contract

A raw-body text write whose client goes silent ends at the same no-progress bound as a lane upload, takes the same answer (408 `upload_stalled` with one WARN line), and holds no thread or workspace past it.

## What to do

The three consumers take the tenant's `stall_signal()` through `consume_transfer_body`, which maps a stalled receive to `BodyStalled`; one helper in `files.rs` races the feed against the consumer at the three sites, dropping the feed with the body, so every consumer error is answered when the consumer returns. The stall policy, the bound and the lanes are not changed.

## Acceptance

1. Three router pins, red first on their own assertions: the workspace PUT (with the workspace count and a reset answering), the draft write, the standalone text write; each records its readings, releases the body, then judges.
2. One mutant per guard (the signal not taken; the race not raced; the helper bypassed at a site), each red alone.
3. The design text of the raw-body writes names the bound and the answer.
