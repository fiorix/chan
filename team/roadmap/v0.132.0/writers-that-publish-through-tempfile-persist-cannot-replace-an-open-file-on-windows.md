# Writers that publish through tempfile's persist cannot replace an open file on Windows

Status: accepted for v0.132.0 by the owner on 2026-11-16 ("Take all four recommendations"); not started. Merged into `v0132/int` at `f2b702c50` and closed on the native Windows tests on the VM.

Record: found in v0.131.0's review of the model download's Windows fix (`dev/v0131-team/reviews/review-modelroots-4a.md`, note 8). The model download's ref writer was moved to `std::fs::rename` in that row because `tempfile`'s `persist` failed with os error 5 while a reader held the old file open (Windows test VM, job J201a r2).

## What is there now

`tempfile` 3.27's `persist` calls `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` directly. On Windows that fails with ERROR_ACCESS_DENIED when another handle holds the target open. Rust 1.95's `std::fs::rename` falls back on that error to `SetFileInformationByHandle` with `FileRenameInfoEx` and POSIX semantics, which replaces the file while the old handle keeps reading the old bytes. Writers that still publish through `persist`: `crates/chan-workspace/src/fs_ops.rs:960` (`atomic_write`, used for workspace saves), `crates/chan-server/src/atomic_file.rs:55`, and `persist_noclobber` in `crates/chan-server/src/routes/transfer.rs:1150` (a no-clobber publish, a separate case).

## Desired contract

1. On Windows, a chan write that replaces a file succeeds while another process holds the old file open with the sharing `std::fs::File::open` uses, and that reader keeps the old bytes.
2. Every replacing writer keeps today's sync, permissions and cleanup on failure.

## Boundaries

- No change on Unix, where rename already replaces an open file.
- `persist_noclobber`'s no-clobber semantics stay as they are.

## Acceptance

1. A native Windows test per writer: a reader holds the old file open, the write replaces it, the reader reads the old bytes and a fresh open reads the new ones; red on today's code.
2. The Windows-target lint and the native test selection carry the new tests.
