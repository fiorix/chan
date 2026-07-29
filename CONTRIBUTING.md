# Contributing to chan

Thanks for the interest. chan is a small, single-binary AI-native IDE for the modern engineer: a CLI plus an HTTP server that serves an embedded hybrid editor, terminal, file browser, and graph over a folder on disk. Contributions are welcome.

Agents and contributors: start at [`.agents/README.md`](.agents/README.md).

This file is the practical guide. For the architectural shape (workspace layout, workspace boundary, single-binary discipline, MCP-only stance), read [`.agents/README.md`](.agents/README.md) at the repo root.

## Setup

```bash
git clone https://github.com/fiorix/chan
cd chan
./scripts/install-hooks   # symlinks the pre-push gate
```

The Rust toolchain is pinned in [`rust-toolchain.toml`](rust-toolchain.toml) (1.95.0 at time of writing). `cargo` auto-installs the pinned version through rustup on first use, so contributor and CI lint sets stay locked together.

Frontend bundle dependencies (Node.js + npm) install under `web/`:

```bash
cd web && npm install
```

## Build and test

```bash
cargo build                                       # workspace build
cargo test                                        # all tests
cargo fmt --check                                 # formatting
cargo clippy --all-targets -- -D warnings         # lints (CI uses -D warnings)
cd web && npm run check                           # svelte-check
cd web && npm test -- --run                       # vitest
cd web && npm run build                           # SPA bundle
```

The release artifact is a single static binary with the frontend bundle embedded via `rust-embed`. Embedding happens at compile time, so any frontend change requires rebuilding `cargo build -p chan` to be visible.

To run these gates in a Linux container that mirrors CI (natively on Linux, or via `lima` + `sdme` on macOS), and to validate the gateway's `.deb` packaging end to end, see [`docs/contributing/linux-and-macos.md`](docs/contributing/linux-and-macos.md).

## Pre-push gate

Installing the pre-push hook (`./scripts/install-hooks`) wires the same gate that CI enforces: shellcheck + actionlint + the cross-platform build-matrix contract + fmt + clippy `-D warnings` + cargo test + `cargo build --no-default-features` + the separate gateway release build + `npm run check` + `npm test` + `npm run build` + a release devserver boot smoke + the native desktop package against the pinned Rust toolchain. Linux produces an AppImage; macOS produces an ad-hoc-signed `.app`. Run it locally before pushing; CI will fail fast otherwise.

The two static linters (`make shell-check`, `make workflow-check`) cover the shell scripts and GitHub workflows that no cargo or npm target reads. `make build-matrix-check` then asserts that the native macOS, Windows, and Linux package jobs plus the distro and container jobs still invoke the repository's real build targets. It is deliberately a wiring test: a Linux hook cannot execute AppKit or produce an NSIS installer, so the authoritative compile/package proof stays on native CI runners. `scripts/lint-static.sh` downloads both linters at a pinned version, verified against a checksum, into `${XDG_CACHE_HOME:-~/.cache}/chan/lint-tools`, so no system package or root is needed. Only a cold cache needs network; the cache deliberately sits outside `target/` so wiping `target/` or adding a worktree does not force a re-download. Set `CHAN_LINT_TOOLS_DIR` to move it. Severity and the exclude list live in [`.shellcheckrc`](.shellcheckrc), each exclude with its reason.

Do not bypass with `--no-verify` unless explicitly agreed. Hook failures get fixed in a NEW commit, not amended into the previous one.

## Gateway (server-side, Postgres)

`gateway/` is a separate nested Cargo workspace (the account / sign-in / reverse-proxy surface for chan.app: profile, identity, devserver-proxy, devserver-control + devserver-control-proto, admin, gateway-common). It is NOT a member of the root workspace, so a root `cargo build` never touches it and the core build stays free of Postgres and the sqlx/oauth2 stack. `make pre-push` explicitly crosses that boundary with `make gateway-build`, a Postgres-free release compile of every gateway service. The gateway's own integration gate (`.github/workflows/gateway-ci.yml`) adds Postgres-backed tests and builds all four OCI service images. The gateway ships only linux amd64/arm64 `.deb` packages, versioned in lockstep with the root (bump `gateway/Cargo.toml` in the same commit as the root version).

Unlike the core, the gateway is Postgres-backed. Its integration tests (`profile`, `identity`) create a throwaway schema per test under `TEST_DATABASE_URL`. The supported, reproducible setup runs Postgres in an `sdme` container (the same way CI does) and works on both Linux and macOS; see [`gateway/docs/testing-on-linux-and-macos.md`](gateway/docs/testing-on-linux-and-macos.md). Any Postgres with a `chan_gateway_test` database also works:

```bash
export TEST_DATABASE_URL=postgres://chan:chan@127.0.0.1:5432/chan_gateway_test

(cd web && npm ci && npm run build -w @chan/profile)   # gateway identity SPA (rust-embed input)
cd gateway
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                             # profile + identity need the DB
```

Because the shared pre-push hook is intentionally Postgres-free, it compiles the gateway but does not run its database-backed integration tests. Run the block above by hand before pushing gateway changes; gateway-ci.yml runs the same gate (with a Postgres service) on PRs that touch `gateway/**`.

## Workflow

1. Fork; create a feature branch off `main`.
2. Make changes; keep commits focused.
3. Run the pre-push gate locally.
4. Open a PR against `fiorix/chan:main`.
5. CI runs the same gate. Resolve any failures.
6. Address review feedback as new commits.

### Commit message conventions

* Conventional Commits-flavored prefixes: `feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:` / `ci:`. Not strictly enforced, but the repo's history reads cleaner that way.
* Subject line < 70 chars; body wraps at ~72. Explain the **why**, not just the what. The subject states what the change IS: no archaeology, no plan/round/phase numbers or task ids in the headline (change history lives in `CHANGELOG.md`, `team/`, and the `dev/` tree).
* No em dashes; tables are pure ASCII targeting 80 columns; prose does not hard-wrap (one logical line per paragraph). See [`.agents/writing-rules.md`](.agents/writing-rules.md).

### Architectural ground rules

These are load-bearing for chan's identity; PRs that breach them get bounced for discussion before merge:

* **Workspace boundary**: every user-content filesystem operation routes through `chan_workspace::Workspace`. No direct `std::fs::*` on user content from anywhere else in the workspace.
* **Single binary, no runtime deps**: no Node.js, Python, or native daemons at runtime. The frontend embeds at build time.
* **Local-first by default**: the HTTP server binds `127.0.0.1` with a per-launch bearer token. Tunnel mode is opt-in via `--tunnel-token`.
* **MCP-only for agents**: external agents (Claude, Codex, Gemini) connect via the in-process MCP server over a Unix-domain socket. Do not add HTTP-side agent surfaces or in-app agent UI.
* **Pinned toolchain**: code that needs a newer Rust bumps `rust-toolchain.toml` in the SAME commit and fixes any new clippy findings.

## Reporting bugs

Use GitHub Issues. Include:

* `chan --version` output.
* Platform + OS version (macOS, Linux distro, etc.).
* Steps to reproduce, including workspace path layout when relevant (avoid attaching private workspace content).
* Expected vs actual behavior.

Security-sensitive reports go through [`SECURITY.md`](SECURITY.md), not the public issue tracker.

## Submitting a feature

For non-trivial features, open an Issue first to discuss shape and scope. chan keeps a tight feature surface; not every good idea fits. Better to align before writing the PR than after.

## Code review

We aim for quick turnarounds. Reviews focus on:

* Correctness + safety (esp. anything touching the workspace boundary).
* Test coverage proportional to the change.
* Doc updates for user-visible behavior.
* Simplicity: the smallest change that does the job.

## License

By contributing, you agree that your contributions are licensed under the Apache License, Version 2.0 (see [`LICENSE`](LICENSE)).
