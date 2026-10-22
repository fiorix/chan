# The indexer sends an apply frame per file, so a burst's graph refresh follows the stream's pace

Status: built on 2026-10-22 on the seat's branch; the section Build and proof holds the evidence; it closes at the GA as shipped.

## What was seen

The server's indexer bridge (`crates/chan-server/src/indexer.rs`) sends one `graph_applied` frame through the bus (`bus.rs`, `send_graph_applied`) per change the watcher worker applies, its one send site; a full index build sends none. The workspace app's shared graph refresh re-arms a 250 ms quiet window at each frame and fetches the graph when the window ends. The graph-refresh item's reading of an 81-file write: beside an idle host the frames arrive within the window and the burst costs two shared fetches and three graph tab loads; beside a compile load in the integration guest the gaps pass the window and the same write costs 56 shared fetches and 57 graph tab loads over 31.6 s against 9.6 s quiet. Browser check 163's own 81-file write streams about 85 frames at about 100 ms gaps over 10 to 13 s. A stream whose gaps stay under the window defers the shared refresh for its whole length (a large copy outside version control, minutes), and each frame resets every open window's timer.

## Desired contract

A quiet-separated due set costs one post-apply shared graph fetch per window when it completes within ten seconds of its first returned path. A longer set publishes partial frames at most ten seconds after its oldest unpublished receipt, including while another apply is blocked. An isolated save publishes as soon as its apply and status handling finish. The raw-watch fetch is counted separately. Raw watch frames re-arm the page's quiet window, so a continuous stream of changes defers the shared refresh until it pauses; an apply frame does not shorten that.

## What to do

A design first, read by the review seat before code, since the frame's producer changes: the bridge sends one `graph_applied` frame when the worker's due set drains, naming every path applied since its last frame; the frame's shape is unchanged for the page and its path list grows. The design names its producers (the 81-file write at check 163's pace and at the item's loaded pace, a large copy outside version control), states the deferral each gets and the bound for a stream that keeps the due set full, and names the pins (one frame per drain naming every applied path; a single save's frame unchanged). Before landing, the fetch count and the deferral are measured with the graph-refresh item's reading driver at the check's pace and under the compile load the item's reading used.

## Boundaries

`crates/chan-server/src/indexer.rs` at the apply path, `bus.rs` and their tests; the chan-server design text at the frame's entry. Not changed: the page's quiet window and its handler, the graph routes, the watch frames.

## Acceptance

1. The design names its producers, the deferral and its bound, read by the review seat before code.
2. The pins red first at the parent; the chan-server suite green at the commit, and chan-workspace's if the apply path there moves.
3. The 81-file write measured at the check's pace and under load at the commit: the expected post-apply shared fetch count per window is one idle, or two where the drain's span passes ten seconds, and about four under the recorded load, with the raw-watch fetch counted separately. Record the measured due-set membership, fetch counts and deferral beside the base; run check 163 alone at the landing in the integration guest, beside the base.

## Lead's contract 2026-10-22

The lead's Q1 ruling counts the raw-watch fetch apart: a burst costs that fetch and a post-apply fetch per quiet-separated drain, against the base's per-file publication. Q2 takes a ten-second oldest-unpublished-receipt bound, as re-ruled after independent review. The trade keeps the idle 81-file drain whole and limits a longer drain to about one partial frame per ten seconds; the recorded loaded span predicts about four post-apply fetches, not one. A new receipt does not re-arm the deadline. The bound covers completed work while another apply is blocked, not the blocked apply itself or a runtime that is not scheduled. Paired renames share a frame unless the bound falls between their applies. A newly queued change belongs to the next collected set even while the current set runs; the bridge does not wait for the whole pending map to empty.

The page's quiet window, raw-watch handler and single-request policy are unchanged. Continuous raw changes can defer the page's shared refresh until they pause, even while the server publishes partial apply frames. Check 163's synchronous 81-file fill and the reading driver's finite write are distinct from a minutes-long non-VCS copy; the latter can span arbitrarily many due sets, each with the publication bound above. Acceptance 3 remains the lead's measured proof at integration, after the index-status poller repair.

## Build and proof 2026-10-22

Built the per-due-set path accumulator and its ten-second oldest-receipt deadline in chan-server. Every joined apply contributes its returned paths, including error outcomes. A timer publishes completed paths while a later blocking apply is held; taking a batch clears both its paths and deadline. The worker preserves its per-file statuses, weak workspace ownership and apply order. The existing bus alone sorts, deduplicates and suppresses empty lists; its wire and the page are unchanged. The seven existing single-change pins retain their payloads and count one after drain settlement. Added pins cover paired and separate-drain renames, an arrival during a drain, a later apply error, overlapping subtree/file paths, an isolated save, a held tail and an active stream, with constructed instants for the maximum-wait rule.

The paired-rename pin failed at parent `be09d2e1abf4bba8e716550a955cae946ef9bece`, cargo exit 101: the source frame escaped while the destination was held. The focused command `cargo test -p chan-server --lib indexer::graph_applied_tests -- --test-threads=2 --nocapture` passed 21 tests with no failures or ignores after the fixture correction and again after the mutation campaign. Ten separate guard mutants each failed its named assertion with exit 101: per-change publication, publication before the tail apply, missing paths, dropped error paths, paths carried across drains, waiting for the whole pending map to empty, an isolated save delayed to the next tick, a deadline re-armed by each receipt, a deadline checked only after the join, and paths retained after a timed flush. An additional narrower omission control dropped exactly one accumulated path and failed the paired-rename payload assertion. No mutant survived; the fixed source was restored and its diff matched byte for byte.

Evidence is under `dev/v0109-team/evidence/Runtime109/gapcoa/build30/`: `precommit-export/` holds the parent red, focused logs, each mutant's source/command/status and the restored diff; `final-export/committed/` is the committed gate's record for fmt, warnings-denied clippy, the complete chan-server and chan suites, and chan-server with a symlinked `TMPDIR`. The initial overlap fixture incorrectly used a directory rename, which requests a rebuild, and timed out; its corrected fixture constructs a subtree removal and child update in one due set. The parent wrapper's unavailable `rg` and the mutation runner's initial syntax error are retained separately from product results. Verification runs in the runtime guest at two CPUs and 6 GiB and is contended; it makes no performance claim.

Acceptance 1 is covered by the design and the lead's reviewed Q1/Q2 rulings above; the code pins cover acceptance 2, with the committed suite results recorded in the hand-back and gate logs. Acceptance 3 remains unrun by this seat: the lead measures the idle and loaded 81-file producer and runs check 163 beside the base at integration after the index-status poller repair. The expected one idle and about four loaded post-apply fetches are predictions, not measured results of this build.
