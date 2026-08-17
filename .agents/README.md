# Agents

The canonical home for agent and contributor standards in this repo. Read this file first, then follow the read order below.

## What This Project Is

`chan` is an IDE in a single binary. It is a terminal emulator and multiplexer, usable locally or over a remote connection, together with a workspace manager that provides search, terminals, a text editor, file browser, graph, and dashboard as tiling tabs and panes. A workspace can be any directory and is commonly associated with a git repository; a window can also run without one, as terminals and a file surface over the machine's own filesystem.

External agents run in embedded terminals and can connect through the in-process MCP server; they coordinate through `cs` (the chan-shell control client), and Team Work provisions agent teams into named tabs. The CLI manages the workspace registry and contents, search, the devserver, and self-upgrade.

The server binds `127.0.0.1` by default behind a persisted bearer token; the opt-in tunnel publishes the devserver at its gateway tenant origin for sign-in and sharing. One devserver process owns its library's writes; sessions on it are multi-participant (a leader/follower roster with handover).

The CLI ships as one binary with both SPA bundles (the workspace app and the launcher) embedded via rust-embed; the Linux release tarball is statically linked (musl). A release also ships the desktop app, the gateway, and the downstream packages; see [skills/release/SKILL.md](skills/release/SKILL.md).

## Read Order

1. [principles.md](principles.md) - the load-bearing project invariants.
2. [writing-rules.md](writing-rules.md) - documentation and comment style.
3. [patterns.md](patterns.md) - contributor patterns for code changes.
4. [playbook.md](playbook.md) - cross-phase operational lessons.
5. [skills/](skills/) - executable workflows (test server, release, gate, archive-round) plus vendored general skill profiles.

Subsystem guides: [desktop.md](desktop.md) (chan-desktop), [gateway.md](gateway.md) (the cloud gateway workspace), [orchestration/](orchestration/README.md) (the cs control surface and Team Work). The development process itself (rounds, roles, the roadmap and release trees) is [`../team/README.md`](../team/README.md).

## Layout

The crate, `web/`, `desktop/`, and `gateway/` split is self-explanatory from the tree on disk. Two directories are not: `web-launcher/` is the gitignored build output of `web/packages/launcher` (the launcher SPA's rust-embed input, not a source tree), and `team/` is the development-process tree (the multi-agent model in `team/README.md`, accepted scope in `team/roadmap/`, release history in `team/release/`). The whole-system architecture (crate boundaries, runtime topology, bind vs tunnel, the devserver) lives in [`../design.md`](../design.md), and the per-crate design-doc index, by category, is in the root [`README.md`](../README.md); do not duplicate either here.

## Build & Test

```bash
cargo build
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

The Rust toolchain is pinned in `rust-toolchain.toml` (1.95.0). `cargo` auto-installs through rustup on first use, so contributor and CI clippy lint sets stay locked together. Bumping Rust = edit `rust-toolchain.toml` and fix any new clippy findings in the same commit.

The pre-push hook (`./scripts/install-hooks` to install) runs `make pre-push`, the same gate as CI: static shell and workflow lints, the build-matrix and sdme contracts, formatting, clippy, tests, the no-default-features build, the separate gateway workspace, the web checks, and a release devserver smoke plus the native desktop package. The sdme-contract and gateway steps are the LINUX arm's: the Nix driver calls GNU coreutils and the gateway builds inside an sdme container, so `pre-push` skips them on macOS and Windows (where those targets refuse outright and name `make ci-macos` / `make ci-windows`), which keeps the git hook usable on those hosts instead of guaranteed-red. The authoritative step list and the isolated/own-gate model for multi-agent rounds live in [skills/gate/SKILL.md](skills/gate/SKILL.md).

## Documentation

- **Design and architecture**: [`design.md`](../design.md), the whole-system reference. Update it in the same commit as any change that affects crate boundaries, server contracts, state ownership, window capabilities, or the frontend embed / serve story. That rule lives here rather than in the document itself: `design.md` is the first file most readers open, and it opens as a description of the system, not as instructions to the people editing it. The full per-crate design-doc index, by category, is in the root [`README.md`](../README.md).
- **chan-workspace design**: [`crates/chan-workspace/design.md`](../crates/chan-workspace/design.md). Read before proposing chan-workspace changes.
- **Issue tracker**: GitHub repo `fiorix/chan`.
