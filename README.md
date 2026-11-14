# Chan

Chan is a supercharged terminal emulator, free and open source under the Apache 2.0 license.

It builds up in layers, and one binary carries all of them:

- **A terminal emulator.** Terminals open in tabs and split panes. The session behind a terminal lives in a server process, not in the window, so a window can reload, close or attach from another machine while the shell keeps running.
- **Scriptable from the shell, the keyboard and the mouse.** Every chan terminal has the `cs` command, which drives the window it runs in: open a file, split a pane, start a named terminal, type into another tab and read its scrollback. The same actions sit behind the command launcher and shortcuts, and behind menus and drag and drop.
- **A multiplexer of its own, and tmux.** Windows, panes, tabs and named sessions that outlive their views. A `tmux -CC` run in a chan terminal turns that tmux server's windows and panes into chan's.
- **Local and remote, the same.** The process that owns the terminals is a server with an HTTP and WebSocket API. The desktop app embeds it for local work; `chan devserver` runs it headless on another machine.
- **A devserver over a TCP tunnel.** A remote devserver is reached over whatever TCP path already exists: an ssh port forward, a VM, a container.
- **A devserver through a gateway.** For an always-on setup shared with other people, a devserver dials out to a chan gateway, a set of services you host yourself, which publishes it behind sign-in.

Around the terminal, chan turns any directory into a workspace: search, a Markdown editor with diagrams and slide decks, a file browser, a graph of the project, a dashboard, and teams of coding agents in named tabs.

Nothing is an online service: the desktop app, the headless devserver and the gateway all build from this repository. [design.md](design.md) states each layer in full.

## Install and build

Download Chan Desktop for macOS, Windows or Linux, or the `chan` command for servers, from [chan.app](https://chan.app). The user manual is at [chan.app/manual](https://chan.app/manual/).

Building from source needs Rust through rustup and Node.js with npm. The Rust toolchain is pinned in [rust-toolchain.toml](rust-toolchain.toml) and installs itself on first use.

```bash
make chan           # the release CLI with both web apps embedded
make chan-desktop   # the desktop app for the host platform
make help           # every build, package and check target
```

## How it is made

One repository builds everything.

- **Rust.** The root Cargo workspace holds the `chan` binary and the libraries under it, layered in one direction. `chan-workspace` is the core: a sandboxed filesystem over a directory, the workspace registry, search and the graph, with no knowledge of HTTP. `chan-library` hosts workspaces and terminal sessions. `chan-server` wraps them in HTTP and WebSocket routes. `chan` and the desktop drive the stack.
- **Web.** An npm workspace holds the Svelte apps: the workspace app (terminal, editor, file browser, graph, dashboard) and the launcher. Both are embedded into the binary at build time, so nothing but the binary is needed at runtime: no Node.js, no Python, no daemons. The terminal core is Ghostty's libghostty-vt compiled to WebAssembly.
- **Desktop.** chan-desktop is a Tauri shell that embeds the same server and opens its windows as native webviews. The desktop binary is also the CLI when invoked as `chan` or `cs`.
- **Gateway.** The gateway is a Cargo workspace of its own, backed by Postgres. It is not a member of the root workspace, so the single binary never links Postgres or OAuth.

Chan is developed by small teams of AI coding assistants coordinated by the project owner, using chan's own Team Work tooling. [team/README.md](team/README.md) describes the process.

## Repository layout

- [crates/](crates) - the Rust crates of the root Cargo workspace: the `chan` binary and its libraries.
- [desktop/](desktop) - chan-desktop, the Tauri shell, also a member of the root workspace.
- [web/](web) - the npm workspace: the workspace app, the launcher, the terminal widget (`ghostty-web-ng`), the gateway's account app (`profile`), shared code (`web-shared`), and the chan.app site with the user manual (`marketing`).
- [gateway/](gateway) - the gateway's Cargo workspace: its services, the operator CLI, the database migrations and the decision records.
- [packaging/](packaging) - what the Makefile's package targets drive: distro packages, container images, Kubernetes manifests, Nix and FreeBSD builds.
- [scripts/](scripts) - the pre-push gate and the checks it runs, and the end-to-end suites under `scripts/e2e/`.
- [fixtures/](fixtures) - recorded inputs the tests read: tmux control-mode captures, a sample workspace for search.
- [docs/](docs) - the guides listed at the end of this file.
- [team/](team) - the development process: accepted scope in `team/roadmap/`, release records in `team/release/`.
- [.agents/](.agents) - the standards contributors and coding agents work to.

At the root, [design.md](design.md) is the whole-system design, [CONTEXT.md](CONTEXT.md) the product vocabulary, [CHANGELOG.md](CHANGELOG.md) the history, and the [Makefile](Makefile) the public command surface for builds, packages and checks.

## Contributing

Contributors and agents start at [.agents/README.md](.agents/README.md), which holds the project's standards and the order to read them in. [CONTRIBUTING.md](CONTRIBUTING.md) is the practical guide: setup, build and test, the pre-push gate and the pull-request workflow. Security reports go through [SECURITY.md](SECURITY.md).

## Design documents

The architecture is documented next to the code it describes. A `design.md` is the design of record for the directory it sits in: what the component owns, its boundaries and contracts, the invariants it holds, and the reasons behind them. These documents describe the system as it is; how it got there is in [CHANGELOG.md](CHANGELOG.md). Where a `README.md` sits beside one, the README is the practical side: what the component is for and how to run or use it.

Start with [design.md](design.md), the whole-system reference: the layers of the product, the components, the runtime shapes (local, a devserver over a tunnel, a devserver through a gateway) and the invariants. It stays above the level of routes, flags and timeouts. From there, read up the stack every window sits on (`chan-workspace`, `chan-library`, `chan-server`) and then the document for the part you are changing.

Core, the root Cargo workspace from the bottom up:

- [crates/chan-workspace](crates/chan-workspace/design.md) - the core: filesystem gates, workspace registry, search, graph, state placement, locking.
- [crates/chan-library](crates/chan-library/design.md) - the host: workspace and terminal tenants under one server, the window registry, terminal sessions, tmux connections.
- [crates/chan-server](crates/chan-server/design.md) - the serving layer: per-tenant HTTP/WS, SPA embed, MCP host, devserver builder.
- [crates/chan](crates/chan/design.md) - the CLI binary: dispatch, process lifecycle, service supervision, self-upgrade.
- [crates/chan-shell](crates/chan-shell/design.md) - `cs`: the control-socket wire contract and the client that speaks it.
- [crates/chan-llm](crates/chan-llm/design.md) - the MCP tool sandbox exposed to external agent CLIs.
- [crates/chan-tmux](crates/chan-tmux/design.md) - the tmux control-mode protocol: stream framing, notifications, commands, layouts.
- [crates/chan-report](crates/chan-report/design.md) - repository reports: the walker, the JSONL schema, the COCOMO model.
- [crates/chan-metrics](crates/chan-metrics/design.md) - the process-wide counters and the metered I/O wrapper the serving and transport code feed.
- [crates/chan-systemd](crates/chan-systemd/design.md) - the systemd boundary: notify, watchdog, fdstore, unit render and classification.
- [crates/chan-winpipe](crates/chan-winpipe/design.md) - the Win32 boundary of chan's named pipes: the account SID, owner-only pipes, the account serving a pipe.
- [crates/fetch-models](crates/fetch-models/design.md) - build-only helper that produces the embedded-model tarball.

Desktop and web, the surfaces a user sees:

- [desktop](desktop/design.md) - the Tauri shell: windows, exact-origin trust, native IPC.
- [web/packages/workspace-app/src](web/packages/workspace-app/src/design.md) - the web frontend: the SPAs and how each is served, the color system.
- [web/packages/workspace-app/src/editor](web/packages/workspace-app/src/editor/design.md) - the CM6 editor surface.
- [web/packages/launcher](web/packages/launcher/design.md) - the launcher SPA and its three-surface serving.

Tunnel, the transports between a desktop, a devserver and a gateway:

- [crates/chan-tunnel-proto](crates/chan-tunnel-proto/design.md) - the shared wire contracts.
- [crates/chan-tunnel-client](crates/chan-tunnel-client/design.md) - the dial-side client embedded by `chan devserver`.
- [crates/chan-wireguard](crates/chan-wireguard/design.md) - the in-process WireGuard peer and TCP stack the devserver's dial can run through.
- [crates/chan-tunnel-server](crates/chan-tunnel-server/design.md) - the terminator embedded by the gateway.
- [crates/chan-revtunnel](crates/chan-revtunnel/design.md) - reverse port forwarding from a devserver to the connected desktop (`cs tunnel`); distinct from the gateway tunnel.
- [crates/chan-tls](crates/chan-tls/design.md) - the TLS trust decision the tunnel dial, the desktop's gateway clients and the WireGuard agent share.

Gateway, a separate Cargo workspace (the self-hosted account, sign-in, and proxy surface):

- [gateway](gateway/design.md) - the whole-gateway reference: publication, account and desktop lifecycles, control and data planes, entry, and isolation.
- [gateway/crates/identity](gateway/crates/identity/design.md) - sign-in, PATs, discovery, desktop entry: the public account surface (gw.{domain}).
- [gateway/crates/profile](gateway/crates/profile/design.md) - the authoritative user store.
- [gateway/crates/devserver-proxy](gateway/crates/devserver-proxy/design.md) - the public data-plane edge for tunneled devservers ({proxy}.proxy.{domain}).
- [gateway/crates/devserver-control](gateway/crates/devserver-control/design.md) - the fleet control plane: proxy directory, admission, kill routing.
- [gateway/crates/wireguard-agent](gateway/crates/wireguard-agent/design.md) - the agent on a proxy node that makes a kernel WireGuard interface's peers follow the gateway's active peers.
- [gateway/crates/gateway-common](gateway/crates/gateway-common/design.md) - the contracts the gateway services share.
- [gateway/crates/admin](gateway/crates/admin/design.md) - the operator CLI.

## Guides

Using and extending chan:

- [docs/extensions.md](docs/extensions.md) - how Chan uses extensions and how to build one.
- [docs/config-reference.md](docs/config-reference.md) - every persisted configuration file and field.
- [docs/metrics.md](docs/metrics.md) - the process metrics: what the Dashboard's Metrics slide, `chan metrics` and `/api/metrics` report, and the optional systemd-report source.

Building and testing it:

- [docs/contributing/linux-and-macos.md](docs/contributing/linux-and-macos.md) - the gates in a Linux container that mirrors CI, on a Linux host or through a VM on macOS.
- [docs/contributing/windows-and-linux.md](docs/contributing/windows-and-linux.md) - building chan-desktop for Windows, and developing chan on a Windows machine.
- [gateway/docs/dev-setup.md](gateway/docs/dev-setup.md) - a local gateway in the production layout.
- [scripts/e2e/README.md](scripts/e2e/README.md) - the end-to-end suites and the rules for running them.
- [packaging/README.md](packaging/README.md) - how the packages and deployment artifacts are built.
