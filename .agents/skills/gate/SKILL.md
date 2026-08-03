---
name: gate
description: >-
  Run the chan pre-push gate (shellcheck, actionlint, fmt, clippy, test,
  no-default-features build, gateway build, web checks, release devserver
  smoke, native desktop package) and the isolated/own-gate model for
  multi-agent rounds.
when_to_use: >-
  Before any push, when CI fails, or when you need to validate a
  change against the same checks CI runs.
---

# The pre-push gate

`scripts/pre-push` is the git hook; it `cd`s to the repo root and execs `make pre-push`. Keeping the target list in the Makefile keeps the local hook and CI from drifting. Install the hook with `./scripts/install-hooks`.

## What `make pre-push` runs

The gate runs, in order:

1. `make shell-check` (shellcheck over every tracked shell script)
2. `make workflow-check` (actionlint over `.github/workflows`, with shellcheck on the `run:` blocks)
3. `make build-matrix-check` (the static contract tying native CI, distro, and container jobs to their real build targets)
4. `cargo fmt --check`
5. `cargo clippy --all-targets -- -D warnings` (with `RUSTFLAGS=-D warnings`)
6. `cargo test --all-targets` (with `RUSTFLAGS=-D warnings`)
7. `cargo build --no-default-features` (with `RUSTFLAGS=-D warnings`)
8. `make gateway-build` (the SEPARATE gateway Cargo workspace; builds its SPA then its release crates)
9. `make web-check` (svelte-check + vitest + production build)
10. `make web-marketing-check` (marketing site build + smokes)
11. `make shortcuts-check`
12. `make host-build-check` (release CLI build plus a foreground-devserver health smoke, followed by a native AppImage on Linux or an ad-hoc-signed `.app` on macOS)

Steps 1 and 2 lint `packaging/`, `scripts/`, and the workflows; step 3 additionally proves that every shipped build surface still has an automatic native, distro, or container build edge. `scripts/lint-static.sh` fetches both linters at a pinned version, each verified against a checksum, into `${XDG_CACHE_HOME:-~/.cache}/chan/lint-tools` (override with `CHAN_LINT_TOOLS_DIR`). The cache is deliberately outside `target/`, which the gate discipline wipes: a per-worktree cache under `target/` would mean a fresh download for every isolated or GA gate. Only a cold cache needs network. The severity and the exclude list, with the reason for each exclude, live in `.shellcheckrc`.

`make pre-push` is host-native, not a cross-platform gate. The release gate runs on Linux, so it cannot see Windows or macOS breakage. `make windows-cross-check` deliberately remains outside `pre-push` and is a mandatory release-checklist step; it compiles and lints the CLI crate graph for Windows GNU but does not link or smoke a Windows binary. The mandatory `release.yml` dry run supplies the macOS compile. Neither release check changes the per-push gate.

The gateway is a separate Cargo workspace and is NOT a member of the root workspace. A `crates/`-scoped check misses it, plus the `chan-desktop` (`desktop/src-tauri`) construction sites. When a change touches a cross-workspace struct, build the whole repo, not just the default workspace.

## Discipline

- **Re-run after the last edit.** A check that ran before a later edit is stale. `cargo fmt --check` in particular must run AFTER the final edit, or an "own-gate-green" report is wrong.
- **Don't pipe the command you are verifying.** `cargo ... | tail` reports tail's exit 0 and hides cargo's failure. Run bare and check `$?`, or set `pipefail`.
- **The gate gates every push, including tags.** A backgrounded gated push can SIGPIPE (exit 141) and silently fail to update the remote. Push in the foreground, redirect to a file, and verify with `git ls-remote`.

## Isolated / own-gate model (multi-agent rounds)

In a multi-agent shared worktree, the full-tree `make pre-push` gates the COMMITTED state and is run by a single owner (e.g. the round's lead) from an isolated gate worktree, so it is immune to peers' in-flight working-tree changes.

Worker lanes report a scoped OWN-gate-green plus the pathspec they committed, and do not block on the main-tree pre-push: a concurrent peer's WIP causes false reds there. The scoped own-gate for frontend work must run `make web-check` (vitest included), not just svelte-check plus build, or stale source-pins slip past the scoped check and the integrated gate catches them later.

A lane that touches any shell script (`packaging/`, `scripts/`, `web/packages/marketing/src/install.sh`, a git hook) or any `.github/workflows` file owns `make shell-check` and `make workflow-check` in its scoped own-gate. Both run in seconds and neither is implied by a Rust, frontend, or desktop scoped gate, so without this the linters first fire at the lead's integrated gate, on someone else's clock.
