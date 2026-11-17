# Directory downloads and copies carry chan's write temporaries

Status: shipped in [v0.131.0](../../release/release-v0.131.0.md): a terminal tenant's directory download (`cs download`) and both directory copy walkers skip chan's `.chan-write-*` temporaries by the predicate the listings use, while `.git`, other dotfiles and every other entry stay in the download, and a save that lands while a download walks no longer ends the stream (`v0131/writetemps` at `c4a65d8f8` and `9a3496ce2`, merged as `9ad18134f` and `0a94ab793`). Read by chan-server and chan-workspace tests over real held atomic writes and a deterministic save during the archive, with each reserved-name guard's removal red. The save race's red was taken against the new walk with its guard removed, so the old walk's abort rests on reading tar 0.4.45; no native macOS or Windows run was made.

Record before the release: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); implemented, with the proofs below.

Record: a follow-up of v0.130.0 with no row (its release record, "Follow-ups", the listing walks; `dev/v0130/reports/walktmp-1-handback.md`): the terminal tenant's directory download archives `.chan-write-*` temporaries and `.git` as they are; directory copies (`rooted_fs::copy_subtree`, `MiniWorkspace::copy_tree_plain`) copy a temporary present in the source; and the doc of `excluded_dirs::directory_names` says "every directory". The decisions document for v0.131.0 sorted it as a row of its own, keeping `.git` in the download; the owner took that recommendation. The case-insensitive spellings of the prefix were dropped there (chan writes lowercase only; a user's `.CHAN-WRITE-x` is their file).

## What is there now

Read at `f7457becb`, by reading.

- The terminal tenant's directory download (`GET /api/fs/{path}?download=1`, which serves `cs download`) builds its tar with `append_dir_all` over the directory (`crates/chan-server/src/routes/transfer.rs`, around lines 137 to 180 and 614): every entry by name, chan's own write temporaries among them. Those bytes are not in any listing, and a tarball a user shares can carry them. By reading, a save that renames its temporary while the download walks can also abort the stream.
- The two copy walkers, `copy_subtree` in `crates/chan-workspace/src/rooted_fs.rs` (around line 1517) and `copy_tree_plain` in `crates/chan-workspace/src/mini_workspace.rs` (around line 546), copy a temporary present in the source.
- v0.130.0 reserved the names in the one-level listings and the walks; these three paths were left.

## Desired contract

1. A directory download and both copy walkers skip chan's reserved write temporaries, by the same predicate the listings use.
2. `.git` and every other entry stay in the download: for a tenant with a shell, "download this directory" means the directory as it is.
3. A save that runs while a download walks does not abort the download.
4. The doc of `excluded_dirs::directory_names` says what the function covers.

## Boundaries

- `routes/transfer.rs`'s directory archive, the two copy walkers in chan-workspace, and the doc line.
- Not here: case-insensitive spellings of the prefix; workspace downloads, which already filter.

## Acceptance

1. chan-server and chan-workspace tests: a directory holding a `.chan-write-*` file and a `.git` directory downloads without the first and with the second; both copy walkers leave the temporary behind. Red on today's code.
2. A test that a temporary renamed away while the archive is built does not end the stream with an error, if the build can stage that race deterministically; otherwise a reading in a guest, recorded.

## Built, 2026-11-14

Directory archives and both copy walkers use `fs_ops::is_atomic_write_temp_name` before metadata access or descent. Their preflights use the same predicate, so a temporary is neither counted nor inspected before a walker excludes it. The terminal archive retains `.git`, other control directories, dotfiles and uppercase lookalikes; the workspace copy keeps its existing control-directory exclusions and the standalone copy keeps those directories. The archive walk preserves tar's traversal order, directory naming, symlink handling and special-entry headers. `excluded_dirs::directory_names` describes the listing walk it actually uses.

The server regressions hold a real atomic write open, archive its directory, and assert that its temporary file and a reserved stage are absent while ordinary entries remain. A second test commits the real save at the first tar header write, after enumeration, and verifies the complete archive and published contents. The copy tests hold live writes too; a separate preflight pin puts a symlink inside a reserved stage. A FIFO and dangling-symlink control preserves archive names and entry types.

Proofs are under `dev/v0131-team/evidence/Core131/writetemps/`. `red-workspace.log` has three assertion failures: both copies include reserved entries, and preflight enters a reserved stage. `red-server.log` has two assertion failures: reserved entries enter the tar, and the deterministic save race returns `NotFound`. `green-workspace.log` and `green-server.log` pass the focused workspace checks and all 55 transfer checks, including encoded-size and ceiling coverage. `mutation-results.json` records removal of each of the five reserved-name guards, each killed by its named assertion; `mutation-special-path.result.json` records the special-header path mutation killed by the FIFO control. `restored-workspace.log` and `restored-server.log` record passing checks after restoring every mutation.

The workspace and server design documents and the manual's Files download description state the exclusion. Full crate suites and native macOS/Windows execution were not run for this row. The concurrent-save case is deterministic in-process, so it needs no guest timing sample. Transfer ceilings and unrelated filesystem errors keep their existing behavior.

Note on the server red, added at the merge: `red-server.log` was taken with the explicit walk already in place and its reserved-name guard removed (the race test calls that walk by name and does not compile against the base's `append_dir_all`), so it proves the guard, not that `append_dir_all` itself aborted on a rename; that part rests on reading tar 0.4.45's walk, which queues every child before the first header.
