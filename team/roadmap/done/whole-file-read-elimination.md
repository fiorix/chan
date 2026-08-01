# Eliminate the whole-file read class

> Status: shipped in [v0.82.0](../../release/release-v0.82.0.md): the four whole-file HTTP read paths and the in-workspace copy stream through the bounded reader, incremental indexing declines oversized files before taking the workspace lock, and downloads advertise byte ranges with a strong validator. The moved-Markdown link rewrite still reads a whole body and carries forward.
Status: SHIPPED in v0.82.0.

## Outcome

The uncapped whole-file allocations in plain binary reads, workspace directory archives, and File Browser copy are gone. These paths now stream through fixed-size queues with bounded memory. Incremental indexing declines oversized Markdown and text files before taking the workspace derived-state lock, and buffered editor opens use the same size threshold reported to clients.

Download responses now support byte ranges and strong validators. Response framing is fixed against the size of the open file handle, so a successful body cannot disagree with its declared `Content-Length`.

No write limit changed. Transfer concurrency, scheduling, and admission control remain capability work in `team/roadmap/v0.83.0/large-transfer-capability.md`.

## Shipped contract

- `Workspace::read_bytes_bounded` and `read_bytes_bounded_slice` stream from one open regular-file handle through a fixed-depth queue. The slice is clamped to the size observed on that handle.
- Plain GETs for Image, PDF, and `NotEditableText` all use the same bounded response path. An unknown suffix no longer falls back to `Workspace::read`.
- Workspace directory downloads stream each tar member from a bounded reader and set the member size from the reader's open-handle stat. No member is first materialized in a `Vec<u8>`.
- `Workspace::copy` preflights the open source size against the existing `BYTES_WRITE_LIMIT`, then streams into the atomic sink. Refusal leaves neither a destination nor an orphan temp file, and a later small copy succeeds.
- Incremental `Workspace::index_file` stats included `.md` and `.txt` files before `write_serial` and returns successfully above `TEXT_WRITE_LIMIT`. Lock-owning callers repeat the same check. `TEXT_WRITE_LIMIT` is also the buffered editor-open ceiling and the server-reported `max_editable_bytes`; there is no second threshold.
- Full and partial binary responses advertise `Accept-Ranges: bytes`. Satisfiable ranges return 206 with clamped `Content-Range` and `Content-Length`; unsatisfiable ranges return 416. A strong size/mtime-nanosecond ETag changes when the representation changes.

## Response framing decision

The open file handle defines one stable representation. Its stat fixes the response length before headers are sent. Growth after that stat is excluded by stopping at the declared length. Shrinkage before the declared bytes are read fails the body instead of completing short.

This preserves useful `Content-Length` and range semantics without allowing an unbounded changing file to extend a response. A successful response always contains exactly the declared bytes. Unit coverage forces both races: growth is truncated to the original representation, and shrinkage surfaces a stream error.

## Verification

Baseline regressions demonstrated the original behavior before implementation: an oversized incremental index waited while `write_serial` was held, a bounded stream completed silently after truncation, a `BYTES_WRITE_LIMIT + 1` copy succeeded, and source guards found whole-file reads in the plain binary and tar-member paths.

The crate gate passed after the final production edit:

- `cargo fmt -p chan-workspace -p chan-server --check`
- `cargo clippy -p chan-workspace -p chan-server --all-targets -- -D warnings`
- `cargo test -p chan-workspace -p chan-server`: chan-server 940 passed; chan-workspace library 646 passed and 2 ignored; integration and documentation tests passed

Extended browser smoke 62 passed against exact source commit `378908cb` in 54,241 ms. The worktree was clean. No cargo, rustc, Chrome, Vitest, or browser-smoke Node process was live before launch. Although the trailing load average was `2.20 2.58 4.38`, two one-second samples showed no runnable or blocked work and 94% CPU idle. Fixtures were sparse files under the user's home directory, not `/tmp`.

All resource values below are from the real server PID at 25 ms intervals. RSS is bytes; thread and FD columns are `baseline -> peak (growth)`. The enforced growth ceilings were 25,165,824 RSS bytes, 8 threads, and 12 FDs.

| Case | Fixture | Result | RSS baseline -> peak (growth) | Threads | FDs |
| --- | ---: | --- | ---: | ---: | ---: |
| Plain unknown-suffix GET | 3,221,225,472 bytes | 200; first byte 41.600 ms | 81,244,160 -> 83,062,784 (1,818,624) | 26 -> 27 (1) | 37 -> 38 (1) |
| Plain PNG GET | 536,870,912 bytes | 200; first byte 45.100 ms | 83,103,744 -> 83,103,744 (0) | 26 -> 27 (1) | 36 -> 37 (1) |
| Plain PDF GET | 536,870,912 bytes | 200; first byte 46.600 ms | 83,103,744 -> 83,107,840 (4,096) | 26 -> 27 (1) | 35 -> 36 (1) |
| Directory tar GET | 3,221,225,472-byte member | 200; first byte 41.700 ms | 83,128,320 -> 83,337,216 (208,896) | 26 -> 27 (1) | 34 -> 36 (2) |
| File Browser copy refusal | 67,108,864 bytes | 413 in 41.300 ms; no destination; 4-byte follow-up succeeded | 83,341,312 -> 83,472,384 (131,072) | 26 -> 26 (0) | 34 -> 34 (0) |
| Incremental-index isolation | 3,221,225,472-byte Markdown considered; separate 12-byte probe moved | 200 in 46.300 ms; threshold 2,097,152 bytes | 83,488,768 -> 83,488,768 (0) | 26 -> 26 (0) | 37 -> 37 (0) |

The 16-byte range fixture returned byte 0 for `bytes=0-0`, byte 15 for `bytes=-1`, and bytes 12 through 15 for `bytes=12-99`, with correct 206 framing. Its strong ETag changed after a size-changing rewrite. After all sparse streaming cases, the process retained 2,351,104 RSS bytes, zero threads, and zero FDs relative to the suite baseline.

## Follow-up: moved Markdown link rewriting remains unbounded

`Workspace::rename_with_link_rewrite` rewrites outgoing links inside the moved Markdown file itself. That path calls `read_text_with_stat` on the moved body and therefore still reads the whole file into one `String`.

An otherwise idle-box measurement of a sparse 3 GiB Markdown rename took 52,644.6 ms. This is the same whole-file-read defect class fixed above, on a rename/link-rewrite path outside the four shipped callers. It is deliberately left unfixed here to hold the item boundary, not because the behavior is benign. Follow-up work must bound or decline that body read without silently corrupting relative-link rewrite semantics.

## Boundary

`BYTES_WRITE_LIMIT` remains 50 MiB and `TEXT_WRITE_LIMIT` remains 2 MiB. This item adds no transfer semaphore, scheduler, resumable upload, free-space preflight, or `/api/attachments` change. Those limits remain safety barriers until the v0.83.0 admission mechanism exists.
