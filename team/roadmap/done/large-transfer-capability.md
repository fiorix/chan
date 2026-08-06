# Large transfer capability

> Status: shipped in [v0.85.0](../../release/release-v0.85.0.md).

Status: REGISTERED for v0.85.0; grounded 2026-07-31; implementation in progress.

## What

Binary workspace writes are refused above 50 MiB. The goal is roughly 10 GB in both directions, which is not a matter of scaling an existing capability: creation is walled, so the distance is two orders of magnitude rather than a tuning step.

The refusal is also the only thing currently protecting the machine. chan-server has no admission control on transfer work: no semaphore, no concurrency layer, no queue. Raising the ceiling without first building something to replace it does not make transfers larger, it removes the guard.

That inverts the obvious sequence. The limit is the last thing to change, not the first.

## Why transfers can starve interactive work

Every file download occupies two threads: one blocking-pool task that bridges the file into the response body, and one reader thread spawned per transfer as a plain OS thread outside that pool. Only the bridge task draws from the blocking pool that editor autosave and terminal spawn queue on. Nothing distinguishes bulk work from interactive work, so a few concurrent transfers compete directly with the operations that must stay responsive.

Disk is contended the same way. A multi-gigabyte write commits with one `sync_all` over the whole file, and the editor's own save path fsyncs through the same discipline, so a large commit stalls saves at the journal rather than merely at the thread.

The requirement is therefore isolation, not a cap: terminal and editor work take priority over file transfer, and that priority must hold no matter which client is transferring.

## Shape

A dedicated bulk-transfer lane owns a fixed set of threads and a bounded job queue. Every bulk submission goes to the lane instead of the ambient blocking pool: workspace download, workspace upload, the streamed read response, and the terminal download, tar, and upload paths. The per-transfer reader thread is removed in favor of the lane thread reading inline, which also halves the thread cost of a download.

Admission is a permit taken when a transfer starts and released when its body is dropped. This is the shape the gateway already proves for its watcher and connection limits, including release on drop, so the mechanism is copied rather than invented.

The concurrency bound is two bulk transfers process-wide, and excess work queues up to a bounded depth. The queue is not unbounded: two active plus thirty-two waiting are admitted, and the thirty-fifth request is refused with HTTP 503 and `Retry-After: 1` before any body is read. An unbounded queue would violate the bounded-channel discipline the rest of this design rests on, and a bounded one has to refuse somewhere; the refusal is the bound made visible rather than an exception to it. A 503 here is not a transfer failure and not a file error, since nothing was read and nothing was written.

The bound lives on the server, so a browser, a second window, `curl`, MCP, and a shell inside a chan terminal all obey the same number. The transfer bubble renders queue position for callers that opt into tracking. Untracked callers are a permanent class rather than a defect: the SPA's two direct download anchors cannot carry a request header, and native desktop transfers dispatch through the desktop host so the request is issued outside the page. Both remain admitted and both still obey the bound; what they lack is a position display.

The runtime sets an explicit maximum blocking-thread count; the runtime builder declares no ceiling, so the tokio default applies.

Once the lane exists, the write ceiling is raised and threaded from configuration through `Library` into `Workspace`, reaching the terminal upload path that does not go through `Workspace`, and reported to the browser as one value so no client keeps an independent stale constant.

The editor-session recovery budget reads the same constant today, and this sentence previously listed it as another site the raised ceiling should reach. That reading is wrong and was corrected during delivery: recovery bounds a document held in memory for crash recovery, not a transfer, so raising it to the transfer ceiling would give recovery a multi-gigabyte budget for a reason that has nothing to do with recovery. Recovery is decoupled from the transfer constant instead, and until it is plumbed to its own configured value it keeps the smaller previous limit. That is deliberate and conservative: recovery may refuse a document the transfer paths would accept, and cannot accept one they would refuse. Plumbing it to its own value is registered for v0.86.0.

## Sequencing

1. Tunnel transport first. Tunnel bytes cross one HTTP/2 stream and then yamux substreams, and neither flow-control window is tuned, which puts remote throughput near a few megabytes per second regardless of anything above it. Tune the windows on both layers and settle the gateway's per-route byte and deadline policy for transfer routes: its defaults cap request and response bodies at 100 MiB each (`MAX_REQUEST_BYTES`, `MAX_RESPONSE_BYTES`) and deadline requests at 60 seconds (`REQUEST_TIMEOUT_SECS`).
2. The lane and its admission control.
3. The raised ceiling, last, once the lane is what protects the machine.

Whole-file-read elimination, shipped in v0.82.0, is a prerequisite for all of it.

## Contract

- Bulk transfer never draws from the thread pool that editor and terminal work draw from.
- Two concurrent bulk transfers process-wide; further work queues to a bounded depth of thirty-two, and the request past that bound is refused with HTTP 503 and `Retry-After: 1` before any body is read. Position is visible to callers that opt into tracking, and is a rank among that tenant's own waiting work rather than a global queue depth. The bound is server-authoritative and no client path can bypass it, including the paths that cannot be tracked.
- The runtime declares its blocking-thread ceiling explicitly.
- A raised write ceiling is configuration, validated, with a finite maximum and no value meaning unlimited. Every mirrored ceiling consumes one server-reported effective value.
- Remote transfer over the tunnel is a supported path, not an accident of defaults. The gateway states a transfer policy rather than applying its general body cap and deadline.
- Crash consistency is stated rather than inherited: the destination is old-or-complete and never partial, and the residual durability latency a multi-gigabyte commit can impose on co-journaled saves is stated explicitly rather than discovered. The position is below.

### Crash consistency and journal isolation

A bulk transfer commits through the same discipline in both tenants: a same-directory temporary file, incremental validation and bounding as it is written, `sync_all` on the complete temporary, an atomic rename over the target, then a parent-directory sync. The workspace path implements this in `fs_ops`; the standalone-terminal path, which never touches `Workspace`, implements the same shape independently. A transfer that is interrupted, cancelled, or refused therefore leaves the destination byte-for-byte as it was and leaves no temporary behind. The destination is old-or-complete, never partial.

The durability cost of that guarantee is stated rather than hidden. A multi-gigabyte commit issues exactly one `sync_all`, after the entire feed rather than progressively, and on a filesystem that shares a journal with the workspace, an unrelated small write committing in the same window can wait behind it. The wait is bounded by that single sync rather than by the transfer's whole duration, and it affects durability latency only: no unrelated write loses data, is reordered, or observes a partial state. The bound has not been measured and no number is offered. That there is exactly one sync is what makes this clause precisely true rather than roughly true: introducing progressive syncing would falsify the sentence the whole position rests on.

The two clauses of the Contract line have different evidence status, and the difference is worth stating. That the destination is old-or-complete and never partial is testable and is tested, at least nine times across three crates, each asserting both that no partial target exists and that no temporary is left behind: `workspace_upload_rejects_overflow_progressively_without_a_partial_target`, `disconnected_workspace_upload_keeps_replacement_and_removes_temp`, `terminal_stream_upload_overflow_removes_temp_and_target`, `terminal_stream_upload_disconnect_removes_temp_and_target`, `a_cancelled_terminal_upload_stops_between_chunks_and_leaves_nothing`, `the_upload_writer_observes_cancellation_between_chunks_at_its_seam`, `copy_refuses_above_binary_budget_without_partial_destination`, `write_bytes_accepts_the_exact_ceiling_and_refuses_one_byte_over`, and `transfer_cap_admits_the_exact_ceiling_and_refuses_one_byte_over` for both tenants. The residual-latency statement is a stated position and is not testable, correctly.

This is a known and accepted property of the current design, not an oversight. Progressive syncing, weaker durability for bulk writes, and filesystem-specific strategies were each considered and rejected for this release: the first two trade a guarantee users have today for latency they mostly do not observe, and the third makes behaviour depend on where the workspace happens to live. Reducing that residual is a future item, not a correction.

## Acceptance

- With two bulk transfers saturating the lane, an editor save and a terminal spawn complete without waiting on transfer work. This is the item's central claim and needs a measurement, not an assertion.
- A third concurrent transfer queues and reports its position rather than failing or running.
- A transfer started from `curl` or MCP is subject to the same bound as one started from the SPA.
- A file at the raised ceiling transfers end to end in both directions, locally and through the tunnel, with resident memory flat.
- One byte above the configured ceiling is refused, leaves the target byte-for-byte intact, and leaves no temporary file.
- Remote throughput after window tuning is measured and reported against the pre-tuning baseline.

## Recorded measurement

`scripts/e2e/revtunnel-large-transfer.sh` run once on the branch at `fix(server): fail a cancelled download instead of ending it clean`, in a quiet window with every lane holding cargo work and the run serialized under the shared lock, so the figure is not competing with a build. Only `CHANGELOG.md` and documentation separate that commit from the branch head, so the figure measures the code that ships:

```
fixture_bytes=2147483648 iterations=3
cargo_status=0 elapsed_seconds=155 peak_rss_kb=142636
```

Each of the three iterations moved 2147483648 of 2147483648 bytes with a sha256 identical to the source, in 4323, 5729, and 5424 ms.

Peak resident set is roughly 139 MiB against a 2 GiB payload. It does not track fixture size, which is the criterion: a whole-file read would report a figure near `fixture_bytes`. The transfer streams rather than buffers.

That figure also checks itself. The scenario is built with `--no-run` before the measured region opens, so a compile landing inside the region would report a compiler's resident set, which on this workspace runs an order of magnitude above 139 MiB. A figure at 139 MiB is therefore evidence from the record that the region held the scenario alone, rather than a property the reader has to take on trust from the script.

`elapsed_seconds` is not a transfer time and must not be divided into `fixture_bytes`. It covers the whole measured test run, of which the three transfers are about 15.5 seconds; the rest is the scenario's own bring-up and its per-iteration hash verification of each 2 GiB result. Compilation is outside it by construction. A throughput computed from the elapsed figure understates the transfer by roughly an order of magnitude, and that is the comparison a later reader is most likely to reach for.

What the run does not measure, stated so the number is not read wider than it is. The scenario is the reverse tunnel in one direction: an origin serving `/payload.bin`, forwarded through the tunnel, fetched by `curl`. It is therefore not a measurement of the local non-tunnel path, not of the upload direction, and not of a file at the configured ceiling, since the fixture is 2 GiB and the default ceiling is 10 GiB. The acceptance line asks for both directions, locally and through the tunnel, at the raised ceiling; this run discharges the tunnel download at 2 GiB and no more.

## Deferred

Upload resume needs an offset-addressed session protocol and is its own item. Download resume has only its server half: single-range serving is in place, and no client issues ranged retries. Chunk-level pacing against a live interactive-pressure signal is a real improvement and there is an in-tree model for it in the reindex pacing, but it holds a lane thread longer rather than shorter, so it is only additive once the lane exists. Free-space pre-flight, page-cache hinting so bulk transfer stops evicting the index and graph pages, and incremental range syncing are grouped as disk citizenship and follow.
