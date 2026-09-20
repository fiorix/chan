# The chan CLI crate is one 13,736-line file

Status: raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog, where the split was first deferred at 5,227 lines. The counts below were measured on `main` at `fa0df75ad`.

## What was seen

`crates/chan/src/lib.rs` is 13,736 lines and holds the whole CLI: 16 clap derive types, 42 `cmd_*` functions, 62 structs and enums, 248 top-level functions, and 18 top-level platform or feature `cfg` gates, several of which define one `cmd_*` function twice (`cmd_upgrade_desktop` for supported and unsupported platforms, the `cmd_index_*` family with and without the `embeddings` feature). Its test module starts at line 9012, so about a third of the file is tests.

The crate already has a module idiom the file never followed: `update.rs` (2,372 lines), `skill.rs`, `help.rs`, `devserver_daemon.rs`, `build_id.rs` and `test_env.rs` sit beside it. The head-start branch the backlog names for the first attempt no longer exists.

It is the largest of eight Rust files over 7,000 lines (`chan-workspace/src/workspace.rs`, `chan-server/src/control_socket.rs`, `chan-library/src/terminal_sessions.rs`, `desktop/src-tauri/src/main.rs`, `chan-server/src/routes/files.rs`, `chan-library/src/host.rs`, `chan-server/src/devserver.rs`), so whatever convention the split settles on is one the project will reuse.

## Desired contract

Owner ruling, 2026-09-20: analysis before any code moves. An agent analyses the file's content and proposes a split that is idiomatic at the project level; the file is no longer realistically maintainable, and it deserves a careful reading before it is broken down.

The analysis is the first deliverable and the owner reads it before the second starts. It maps the file by responsibility, records which helpers and types cross those responsibilities, reads how the crate's existing modules and the project's other crates lay out comparable code, and proposes a module tree with the order of moves. The split is the second deliverable: a series of behaviour-preserving commits, each one a move.

## Boundaries

`crates/chan/src/` only. The other seven large files are context for the convention, not scope. The crate's public surface stays as it is (`main.rs`, the desktop and the integration tests under `crates/chan/tests/` consume it, and `test_env` is `pub`), no behaviour changes, and no dependency changes, so `Cargo.lock` and the Nix hash are untouched.

## Acceptance

1. The analysis names a destination for every top-level item in the file and the order of moves, and the owner has read it before the first move lands.
2. Every move commit is behaviour-preserving: `cargo test -p chan` runs the same number of tests before and after, all passing, and the diff of each commit is relocation plus the `mod` and `use` lines it needs.
3. `chan --help` and every subcommand's `--help` are byte-identical before and after the series.
4. The series compiles for Windows and with `--no-default-features`, because the gate is Linux-only and the file carries platform and feature gates a Linux build does not exercise.
5. No file in `crates/chan/src/` exceeds the bound the analysis set, tests included.
