# Large transfer capability

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

The concurrency bound is two bulk transfers process-wide, and excess work queues rather than being refused. The bound lives on the server, so a browser, a second window, `curl`, MCP, and a shell inside a chan terminal all obey the same number. The transfer bubble renders queue position. Two direct download anchors in the SPA bypass the client-side queue, and both are routed so they cannot escape the server bound; the desktop host's native download registers with the client queue and reaches the same server route, so the bound covers it too.

The runtime sets an explicit maximum blocking-thread count; the runtime builder declares no ceiling, so the tokio default applies.

Once the lane exists, the write ceiling is raised and threaded from configuration through `Library` into `Workspace`, reaching the terminal upload path that does not go through `Workspace` and the editor-session recovery budget that reads the same constant, and reported to the browser as one value so no client keeps an independent stale constant.

## Sequencing

1. Tunnel transport first. Tunnel bytes cross one HTTP/2 stream and then yamux substreams, and neither flow-control window is tuned, which puts remote throughput near a few megabytes per second regardless of anything above it. Tune the windows on both layers and settle the gateway's per-route byte and deadline policy for transfer routes: its defaults cap request and response bodies at 100 MiB each (`MAX_REQUEST_BYTES`, `MAX_RESPONSE_BYTES`) and deadline requests at 60 seconds (`REQUEST_TIMEOUT_SECS`).
2. The lane and its admission control.
3. The raised ceiling, last, once the lane is what protects the machine.

Whole-file-read elimination, shipped in v0.82.0, is a prerequisite for all of it.

## Contract

- Bulk transfer never draws from the thread pool that editor and terminal work draw from.
- Two concurrent bulk transfers process-wide; further work queues, with position visible to the user. The bound is server-authoritative and no client path can bypass it.
- The runtime declares its blocking-thread ceiling explicitly.
- A raised write ceiling is configuration, validated, with a finite maximum and no value meaning unlimited. Every mirrored ceiling consumes one server-reported effective value.
- Remote transfer over the tunnel is a supported path, not an accident of defaults. The gateway states a transfer policy rather than applying its general body cap and deadline.
- Crash consistency is stated rather than inherited: a multi-gigabyte commit must not stall unrelated saves at the journal.

## Acceptance

- With two bulk transfers saturating the lane, an editor save and a terminal spawn complete without waiting on transfer work. This is the item's central claim and needs a measurement, not an assertion.
- A third concurrent transfer queues and reports its position rather than failing or running.
- A transfer started from `curl` or MCP is subject to the same bound as one started from the SPA.
- A file at the raised ceiling transfers end to end in both directions, locally and through the tunnel, with resident memory flat.
- One byte above the configured ceiling is refused, leaves the target byte-for-byte intact, and leaves no temporary file.
- Remote throughput after window tuning is measured and reported against the pre-tuning baseline.

## Deferred

Upload resume needs an offset-addressed session protocol and is its own item. Download resume has only its server half: single-range serving is in place, and no client issues ranged retries. Chunk-level pacing against a live interactive-pressure signal is a real improvement and there is an in-tree model for it in the reindex pacing, but it holds a lane thread longer rather than shorter, so it is only additive once the lane exists. Free-space pre-flight, page-cache hinting so bulk transfer stops evicting the index and graph pages, and incremental range syncing are grouped as disk citizenship and follow.
