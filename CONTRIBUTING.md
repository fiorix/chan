# Contributing to chan

Thanks for the interest; contributions are welcome. This file is the practical guide: setting up, building and testing, the pre-push gate, and how a change gets from a branch to `main`.

What it leaves out is in three other files:

- [`README.md`](README.md) - what chan is, how it is made and how the repository is laid out.
- [`design.md`](design.md) - the whole-system design. The design document of each crate and surface is indexed in the README.
- [`.agents/README.md`](.agents/README.md) - the project's standards for contributors and coding agents, and the order to read them in.

## Setup

```bash
git clone https://github.com/fiorix/chan
cd chan
./scripts/install-hooks   # symlinks the pre-push gate
```

The Rust toolchain is pinned in [`rust-toolchain.toml`](rust-toolchain.toml). `cargo` auto-installs the pinned version through rustup on first use, so contributor and CI lint sets stay locked together.

The web apps need Node.js and npm; [`.nvmrc`](.nvmrc) declares the Node.js major. Their dependencies install under `web/`:

```bash
cd web && npm install
```

## Build and test

```bash
make web                                    # both web bundles: the workspace app and the launcher
cargo build                                 # the root workspace
cargo test                                  # its tests
cargo fmt --check                           # formatting
cargo clippy --all-targets -- -D warnings   # lints, with warnings denied as in CI
make web-check                              # svelte-check, vitest and the production build
```

The `chan` binary serves both web bundles through `rust-embed`. A debug build reads them from disk on every request, so a web change needs `make web` and a browser reload, with no cargo rebuild. A release build bakes them in at compile time, so there a web change needs the binary rebuilt too.

To run these gates in a Linux container that mirrors CI (natively on Linux, or via `lima` + `sdme` on macOS), and to validate the gateway's `.deb` packaging end to end, see [`docs/contributing/linux-and-macos.md`](docs/contributing/linux-and-macos.md). For chan-desktop on Windows, and for developing on a Windows machine, see [`docs/contributing/windows-and-linux.md`](docs/contributing/windows-and-linux.md).

## Pre-push gate

`./scripts/install-hooks` wires `make pre-push`, the gate CI runs: static lints for the shell scripts and workflows, the build-matrix and Nix hash contracts, formatting, clippy and rustdoc with warnings denied, the tests, the no-default-features build, the gateway workspace's own checks on Linux (formatting, lints, rustdoc, the database-free tests and a build of the crates a release ships), the web checks, a release devserver boot smoke and the native desktop package. Linux produces an AppImage; macOS produces an ad-hoc-signed `.app`. The step list, what each host skips, and the isolated-gate model for multi-agent rounds are in [`.agents/skills/gate/SKILL.md`](.agents/skills/gate/SKILL.md). Run it locally before pushing; CI fails fast otherwise.

Two steps need a word. The static linters download shellcheck and actionlint at pinned, checksummed versions into `${XDG_CACHE_HOME:-~/.cache}/chan/lint-tools` (`CHAN_LINT_TOOLS_DIR` moves it); only a cold cache needs network, and severity and excludes live in [`.shellcheckrc`](.shellcheckrc). `make nix-hash-check` fails when `Cargo.lock` changed and the Nix `cargoHash` pins were not harvested for it: harvest on a Linux host with `make nix-sdme-check NIX_PACKAGE=chan` (or `make nix-check` where Nix is installed), then pin with `make nix-hash-pin CARGO_HASH=sha256-...`. Neither harvest runs on macOS or Windows, so harvest in a Linux VM or container or ask a maintainer; [`packaging/nix/README.md`](packaging/nix/README.md) has the detail.

Do not bypass with `--no-verify` unless explicitly agreed. Hook failures get fixed in a NEW commit, not amended into the previous one.

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

These are load-bearing for chan's identity; PRs that breach them get bounced for discussion before merge. Each is stated in full, with its reasons, in [`.agents/principles.md`](.agents/principles.md).

* **Workspace boundary**: every filesystem operation on user content routes through a `chan_workspace` facade: `Workspace` for a registered workspace, `MiniWorkspace` for the standalone terminal window's file surface. No direct `std::fs::*` on user content from anywhere else.
* **Single binary, no runtime deps**: no Node.js, Python, or native daemons at runtime. The frontend embeds at build time.
* **Local-first by default**: the HTTP server binds `127.0.0.1` behind a persisted bearer token. A non-loopback bind (`chan serve --host`, `chan devserver run --bind`) and the gateway tunnel (`--tunnel-url` with `--tunnel-token`) are explicit opt-ins.
* **MCP-only for agents**: external agents (Claude, Codex, Gemini) connect via the in-process MCP server over a Unix-domain socket, a named pipe on Windows. Do not add HTTP-side agent surfaces or in-app agent UI.
* **Pinned toolchain**: code that needs a newer Rust bumps `rust-toolchain.toml` in the SAME commit and fixes any new clippy findings.

## Gateway (server-side, Postgres)

`gateway/` is a separate nested Cargo workspace: the self-hosted account, sign-in and reverse-proxy services (profile, identity, devserver-proxy, devserver-control + devserver-control-proto, wireguard-agent, admin, gateway-common). It is NOT a member of the root workspace, so a root `cargo build` never touches it and the core build stays free of Postgres and the sqlx/oauth2 stack. On Linux, `make pre-push` crosses that boundary: it checks the gateway workspace's formatting, lints and rustdoc, runs its database-free tests and builds the six crates a release ships. The gateway's own workflow ([`.github/workflows/gateway-ci.yml`](.github/workflows/gateway-ci.yml)) has three jobs: the gateway gate builds and checks the profile SPA, runs Rust formatting, clippy and rustdoc, and runs all gateway tests against PostgreSQL 16; the packaging job checks Kubernetes manifests and package isolation and runs the database-role suite against its own PostgreSQL 16 service; the containers job builds all four OCI service images without publishing them. A release ships the gateway as six `.deb` packages for linux amd64/arm64 and four container images, versioned in lockstep with the root (bump `gateway/Cargo.toml` in the same commit as the root version).

Unlike the core, the gateway is Postgres-backed. Its integration tests (`profile`, `identity`) create a throwaway schema per test under `TEST_DATABASE_URL`. The supported, reproducible local setup runs Postgres in an `sdme` container and works on both Linux and macOS; see [`gateway/docs/dev-setup.md`](gateway/docs/dev-setup.md). CI uses a GitHub Actions PostgreSQL service container. Any Postgres with a `chan_gateway_test` database also works:

```bash
export TEST_DATABASE_URL=postgres://chan:chan@127.0.0.1:5432/chan_gateway_test

(cd web && npm ci && npm run build -w @chan/profile)   # gateway identity SPA (rust-embed input)
cd gateway
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                             # profile + identity need the DB
```

Because the shared pre-push hook is intentionally Postgres-free, it never runs the gateway's database-backed integration tests, and off Linux it skips the gateway altogether. Run the block above by hand before pushing gateway changes. Gateway CI runs on pushes to `main` and pull requests whose paths match its build inputs, and by manual dispatch. Its filter covers `gateway/**`, the root crates the gateway compiles by path, the root `Cargo.toml`, `Makefile` and Rust toolchain pin, the web package manifest and lockfile and the profile SPA, the gateway Docker build inputs, `packaging/gateway/**`, `packaging/kube/**`, `packaging/sdme/chan-devserver-provision.sh`, and the workflow itself. The workflow holds the exact path list; `make build-matrix-check` requires it to name every one of those root crates.

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
