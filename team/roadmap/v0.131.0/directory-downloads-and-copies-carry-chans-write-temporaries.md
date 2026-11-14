# Directory downloads and copies carry chan's write temporaries

Status: accepted for v0.131.0 by the owner on 2026-11-14 (`dev/v0131/decisions.md`, point 11: "as you recommend"); not started.

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
