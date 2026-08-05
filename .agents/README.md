# Agents

The canonical home for agent and contributor standards in this repo. Read this file first, then follow the read order below.

## What This Project Is

`chan` is the user-facing AI-native IDE for the modern engineer: a CLI plus an HTTP server that serves an embedded hybrid workspace (editor, terminal, Team Work, file browser, graph, dashboard) over a folder on disk. You drive projects in Markdown and put AI to work on them; agents run in the terminal and coordinate through `cs` and the in-process MCP server. The CLI subcommands manage the workspace registry, workspace contents, search, and the running server. The server is loopback-only, single-user, single-machine.

The release artifact is a single static binary with the frontend bundle embedded via rust-embed.

## Read Order

1. [principles.md](principles.md) - the load-bearing project invariants.
2. [writing-rules.md](writing-rules.md) - documentation and comment style.
3. [patterns.md](patterns.md) - contributor patterns for code changes.
4. [playbook.md](playbook.md) - cross-phase operational lessons.
5. [skills/](skills/) - executable workflows (test server, release, gate, archive-round) plus vendored general skill profiles.

Subsystem guides: [desktop.md](desktop.md) (chan-desktop), [gateway.md](gateway.md) (the cloud gateway workspace).

## Layout

The crate, `web/`, `desktop/`, and `gateway/` split is self-explanatory from the tree on disk. The per-module and per-route inventory plus the Component architecture, dependency/layering, and runtime-topology diagrams live in [`../design.md`](../design.md) (do not duplicate them here), including which crates are root-workspace members vs the one nested `gateway/` workspace and the uniffi path for native shells.

## Build & Test

```bash
cargo build
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

The Rust toolchain is pinned in `rust-toolchain.toml` (1.95.0). `cargo` auto-installs through rustup on first use, so contributor and CI clippy lint sets stay locked together. The pre-push hook (`./scripts/install-hooks` to install) runs the same gate as CI under the pinned compiler with `RUSTFLAGS=-D warnings` plus `cargo build --no-default-features`, opens with shellcheck over the tracked shell scripts and actionlint over the workflows (`make shell-check`, `make workflow-check`), and finishes with a release devserver boot smoke plus the native Linux/macOS desktop package. Its build-matrix contract also fails when an automatic macOS, Windows, Linux, distro, or container lane is disconnected from the real build target. Bumping Rust = edit `rust-toolchain.toml` and fix any new clippy findings in the same commit. See [skills/gate/SKILL.md](skills/gate/SKILL.md) for the full pre-push gate and the isolated/own-gate model.

## Documentation

- **Design and architecture**: [`design.md`](../design.md). Single load-bearing reference for the workspace layout and the chan-workspace contract. The full per-crate design-doc index, by category, is in the root [`README.md`](../README.md).
- **chan-workspace design**: [`crates/chan-workspace/design.md`](../crates/chan-workspace/design.md). Read before proposing chan-workspace changes.
- **chan-tunnel-proto design**: [`crates/chan-tunnel-proto/design.md`](../crates/chan-tunnel-proto/design.md).
- **Issue tracker**: GitHub repo `fiorix/chan`.
