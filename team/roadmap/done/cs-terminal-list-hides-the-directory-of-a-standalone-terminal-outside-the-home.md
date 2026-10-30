# cs terminal list hides the directory of a standalone terminal outside the home

Status: shipped in [v0.116.0](../../release/release-v0.116.0.md); the section Built and verified 2026-10-30 holds the evidence.

Record before the release: raised by the owner on 2026-10-30 from the Linux reading of the default-terminal handoff; fixed on `desktop/terminal-prototypes` the same day (the section Built and verified); closes at the GA.

## What was seen

On Linux, a default-terminal launch handed to a running chan-desktop opened a standalone terminal window whose shell started in the requested directory (`/proc/<pid>/cwd` read `/tmp/chan-proto/proj`), yet `cs terminal list --json` over the desktop's control socket listed that session with `cwd: null`, while the window's seeded default terminal, started in the home directory, listed `/home/<user>`. The owner's ruling: the field must be populated, all the more when the session sits in the right directory.

## Evidence

Read at `e63b637f1`; every file below reads the same on `main` at `a4b5844b9`, so this is not the branch's regression but a property the handoff made visible.

- The start directory reaches the session. The handoff mints the window and parks an `open_term_new` frame whose `cwd` is the directory in the standalone filesystem's wire form (`crates/chan-library/src/host.rs`, `open_throwaway_terminal_window`; `crates/chan-server/src/control_socket.rs`, `StandaloneFilesResolver::term_new_frame`). The page spawns the terminal with `?cwd=<wire>&app=files` (`web/packages/workspace-app/src/terminal/session.ts`), the terminal route resolves it through the standalone capability root to an absolute directory (`crates/chan-server/src/routes/terminal.rs`, `resolve_standalone_files_cwd`), and the registry spawns the PTY there and keeps it as the session's `spawn_opts.cwd` (`crates/chan-library/src/terminal_sessions.rs`).
- The list hides it. The summary's `cwd` is `Session::cwd()`, which reads the child's live directory and reports it only when it lies inside the registry root. The shared standalone terminal tenant's registry root is the home directory (`terminal_tenant_root(None)` in `crates/chan-library/src/tenant.rs`, passed as the registry's `workspace_root` by `crates/chan-server/src/lib.rs`), so a shell anywhere outside the home reads as a shell with no directory. The root filter dates from the first cwd report, which only ever served workspace tenants, where the root is the workspace.
- The same hiding applies to every standalone-window terminal outside the home, not only the handoff's: `cs terminal new <path>` into a standalone window, a terminal opened from the file browser or an editor at a directory outside the home, and any standalone terminal that changes directory out of the home.
- The documented meaning of the field (`session_summaries` in `terminal_sessions.rs`, `.agents/orchestration/README.md`) is the session's current directory when it can be read from the child; none of the six `term_list_*` control-socket tests asserts a `cwd` value.

## Desired contract

A standalone terminal's `cs terminal list` row, and the `/ws` cwd frames the page reads for its path actions, report the shell's live directory when it lies under the registry root or under the directory the session was spawned in. A directory under neither stays unreported, so a workspace terminal that leaves its workspace still reads as it did; the report is the live directory, never the start directory kept after a `cd` away. Shells start where they did; the handoff protocol, the frames and their wire form do not change.

## Boundaries

`crates/chan-library/src/terminal_sessions.rs` only: `Session::cwd`, the doc comments of `AttachHandle::cwd` and `session_summaries`, and one new test. A workspace tenant is unchanged in practice, because every spawn request there resolves its directory inside the workspace root before the registry sees it. Not taken: a second boundary root on the registry config for the standalone tenant (plumbing through every registry construction site for the same reading), and a fallback to the start directory when the live one is outside the root (it would report a stale directory after `cd`).

## Acceptance

1. A unit test spawns an exec program with a start directory outside the registry root and reads that directory from `cwd()`; a second program that changes to `/` reads `None`. The test is red before the change and green after; the sibling `tenant_exec_program_starts_in_the_registry_root` stays green.
2. `cargo test -p chan-library`, the `routes::terminal::` and `term_list` tests of chan-server, `cargo fmt --check` and clippy with warnings denied, green.
3. With the rebuilt desktop, a default-terminal handoff into a directory outside the home lists that directory in `cs terminal list --json`.

## Built and verified 2026-10-30

`Session::cwd` accepts the live directory when it lies under the registry root or under `spawn_opts.cwd`, the resolved start directory the registry keeps for every spawn and restore; the doc comments say so. The new test `cwd_report_answers_inside_the_session_start_directory` (Linux, like its sibling) failed before the change with `left: None, right: Some(<start directory>)` and passes after it, with the negative control reading `None`.

Acceptance 2: `cargo test -p chan-library` 763 passed, 0 failed; chan-server `routes::terminal::` 98 passed and `term_list` 6 passed, 0 failed; `cargo fmt --check` clean; `cargo clippy -p chan-library -p chan-server -p chan-desktop --all-targets -- -D warnings` with `RUSTFLAGS=-D warnings` clean.

Acceptance 3: the debug desktop rebuilt with the change, on the Linux host under Hyprland with the isolated rig of the handoff item: after a bare `xdg-terminal-exec` from `/tmp/chan-proto/proj` and an `xdg-terminal-exec --dir=/tmp/chan-proto/proj2`, `cs terminal list --json` over the desktop's control socket lists `Terminal-2` with `cwd` `/tmp/chan-proto/proj` and `Terminal-3` with `/tmp/chan-proto/proj2` beside `Terminal-1` with the home directory, and `/proc/<pid>/cwd` of each shell agrees. The listings are in the `chan-dev` repository under `releases/v0116/terminal-prototypes-linux/logs/`.
