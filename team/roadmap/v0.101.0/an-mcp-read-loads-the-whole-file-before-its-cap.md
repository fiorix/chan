# An MCP tool reads a whole file before its size cap applies

Status: raised for a decision on 2026-09-27 by the plan for the cancellation of a started MCP tool ([a-started-mcp-tool-cannot-be-cancelled](a-started-mcp-tool-cannot-be-cancelled.md); `dev/v0101-team/followups/followup-Runtime-Lead-16.md` in the development tree, section 6), which read `read_media`'s read and its cap at `836d2508a` and took `read_file`'s from a code map, and ran nothing; read again in code at `d1fe06c86`, where both hold, and not run. Recommendation: accept for v0.101.0, as a stat before the read; it is a bound and not a cancel.

## What was seen

`read_media` reads the file whole and only then compares its length with its cap. `read_media_content_sync` in `crates/chan-llm/src/mcp.rs` calls `Workspace::read` (`:682-685`), which reads the regular file to its end into memory (`crates/chan-workspace/src/workspace.rs:1752-1754`; `crates/chan-workspace/src/rooted_fs.rs:557-566`), and then refuses it with `media too large` when its length passes `max_media_bytes` (`mcp.rs:686-695`), whose default the tool's description gives as 10 MiB (`:555-558`).

`read_file` has the same shape against its own cap, which cuts the text rather than refusing it: the tool reads the whole text with its stat (`exec_read_file`, `crates/chan-llm/src/tools.rs:267-272`; `read_text_with_stat`, `rooted_fs.rs:615-634`) and then truncates it to `READ_FILE_CAP_BYTES`, 256 KiB (`tools.rs:273-285`, the constant at `:31-38`).

Both run on the blocking pool with the workspace in the tool's context for the whole call (`run_tool`, `mcp.rs:621-646`; `read_media_content`, `:648-668`), and a workspace holds its root's writer lock until it is dropped (`_lock`, `workspace.rs:864-865`). So a file of several gigabytes is read to its end, into memory, holding its workspace, and with it the root's writer lock, for the whole read, and only then refused or cut. A close of the root waits for the last handle and the lock to go, up to a 5 s deadline, and then logs that the writer lock is still held (`shutdown_with_budget`, `crates/chan-library/src/host.rs:626-662`; `wait_for_workspace_release`, `:4503-4523`; `WORKSPACE_SHUTDOWN_RELEASE_TIMEOUT`, `:49`), so the lock outlives the close until the read returns. The request's cancellation is checked twice before the read and not during it (`mcp.rs:656-663`), and `crates/chan-llm/design.md:67` says that a body already executing can retain the workspace until it returns.

The cancellation [a-started-mcp-tool-cannot-be-cancelled](a-started-mcp-tool-cannot-be-cancelled.md) builds stops a tool body at a boundary inside a walk, a search or a report scan. A single read is one call with no such boundary, so, as the record reads it, a cancel flag cannot shorten it; that item leaves `read_media` with the checks it has.

## Desired contract

A tool that reads one file reads no more of it than its cap needs: `read_media` refuses a file over its cap without reading it, and `read_file` reads at most its cap and still reports the file's size and that it was cut. A read then holds its workspace, and a close of its root waits on it, for a time bounded by the cap and not by the file.

## What to do

Stat the file before the read: `read_media` refuses a file whose size passes its cap before it reads a byte, and `read_file` reads at most its cap, taking the size it reports from the stat. A suggestion beyond the record: bound the read itself as well, since a file can grow between the stat and the read. It is a bound and not a cancel: a read within the cap still runs to its end, and a single read that blocks on a root that stopped answering is not shortened. Red first: a test with a file over each cap that observes how much of the file the tool read; today it reads the whole file.

## Boundaries

`crates/chan-llm/src/mcp.rs` (`read_media_content_sync`), `crates/chan-llm/src/tools.rs` (`exec_read_file`), the chan-workspace reads they call if a bounded read needs one (`Workspace::read`, `read_text_with_stat`), the cancellation paragraph of `crates/chan-llm/design.md`, and their tests. The cancellation of a running tool body is [a-started-mcp-tool-cannot-be-cancelled](a-started-mcp-tool-cannot-be-cancelled.md).

## Acceptance

1. `read_media` of a file over its cap answers `media too large` having read none of the file; pinned red first.
2. `read_file` of a file over its cap reads at most its cap and answers the file's size, the truncated text and its note, as now; pinned red first.
3. A file within each cap reads as it does now.
4. `crates/chan-llm/design.md` says that a tool's read of one file is bounded by its cap.
