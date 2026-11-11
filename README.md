# Chan

Chan is a supercharged terminal emulator, free and open source. It is scriptable from the shell as well as from the keyboard and the mouse. It works the same locally and on remote machines. It has a multiplexer of its own and also speaks tmux control mode (`tmux -CC`). A remote devserver is reached over any TCP tunnel you already have (an ssh port forward, a VM, a container) or through a chan gateway, an always-on deployment you host yourself. Around the terminal it turns any directory into a workspace: search, a Markdown editor with diagrams and slide decks, a file browser, a graph of the project, and teams of coding agents in named tabs. Nothing is an online service: the desktop app, the headless devserver and the gateway all build from this repository.

Download binaries from [chan.app](https://chan.app) or build locally using the Makefile here. The user manual is at [chan.app/manual](https://chan.app/manual/).

Contributors and agents: start at [.agents/README.md](.agents/README.md); the practical guide is [CONTRIBUTING.md](CONTRIBUTING.md).

## Guides

- [docs/extensions.md](docs/extensions.md) - how Chan uses extensions and how to build one.
- [docs/config-reference.md](docs/config-reference.md) - every persisted configuration file and field.
- [docs/metrics.md](docs/metrics.md) - the process metrics: what the Dashboard's Metrics slide, `chan metrics` and `/api/metrics` report, and the optional Varlink interface.

## Design documents

The architecture is documented next to the code it describes. [design.md](design.md) is the whole-system reference: the layers of the product, the components, the runtime shapes (local, a devserver over a tunnel, a devserver through a gateway) and the invariants. Each crate or surface below carries its own design of record.

Core:

- [crates/chan](crates/chan/design.md) - the CLI binary: dispatch, process lifecycle, service supervision, self-upgrade.
- [crates/chan-workspace](crates/chan-workspace/design.md) - the core: filesystem gates, workspace registry, search, graph, state placement, locking.
- [crates/chan-server](crates/chan-server/design.md) - the serving layer: per-tenant HTTP/WS, SPA embed, MCP host, devserver builder.
- [crates/chan-library](crates/chan-library/design.md) - the host: workspace and terminal tenants under one server, the window registry, terminal sessions, tmux connections.
- [crates/chan-shell](crates/chan-shell/design.md) - `cs`: the control-socket wire contract and the client that speaks it.
- [crates/chan-llm](crates/chan-llm/design.md) - the MCP tool sandbox exposed to external agent CLIs.
- [crates/chan-systemd](crates/chan-systemd/design.md) - the systemd boundary: notify, watchdog, fdstore, unit render and classification.
- [crates/chan-tmux](crates/chan-tmux/design.md) - the tmux control-mode protocol: stream framing, notifications, commands, layouts.
- [crates/chan-report](crates/chan-report/design.md) - repository reports: the walker, the JSONL schema, the COCOMO model.
- [crates/chan-metrics](crates/chan-metrics/design.md) - the process-wide counters and the metered I/O wrapper the serving and transport code feed.
- [crates/chan-winpipe](crates/chan-winpipe/design.md) - the Win32 boundary of chan's named pipes: the account SID, owner-only pipes, the account serving a pipe.
- [crates/fetch-models](crates/fetch-models/design.md) - build-only helper that produces the embedded-model tarball.

Desktop and web:

- [desktop](desktop/design.md) - the Tauri shell: windows, exact-origin trust, native IPC.
- [web/packages/workspace-app/src](web/packages/workspace-app/src/design.md) - the web frontend: the SPAs and how each is served, the color system.
- [web/packages/workspace-app/src/editor](web/packages/workspace-app/src/editor/design.md) - the CM6 editor surface.
- [web/packages/launcher](web/packages/launcher/design.md) - the launcher SPA and its three-surface serving.

Tunnel:

- [crates/chan-tunnel-proto](crates/chan-tunnel-proto/design.md) - the shared wire contracts.
- [crates/chan-tunnel-client](crates/chan-tunnel-client/design.md) - the dial-side client embedded by `chan devserver`.
- [crates/chan-wireguard](crates/chan-wireguard/design.md) - the in-process WireGuard peer and TCP stack the devserver's dial can run through.
- [crates/chan-tunnel-server](crates/chan-tunnel-server/design.md) - the terminator embedded by the gateway.
- [crates/chan-revtunnel](crates/chan-revtunnel/design.md) - reverse port forwarding from a devserver to the connected desktop (`cs tunnel`); distinct from the gateway tunnel.
- [crates/chan-tls](crates/chan-tls/design.md) - the TLS trust decision the tunnel dial, the desktop's gateway clients and the WireGuard agent share.

Gateway (separate Cargo workspace; the self-hosted account, sign-in, and proxy surface):

- [gateway](gateway/design.md) - the whole-gateway reference: publication, account and desktop lifecycles, control and data planes, entry, and isolation.
- [gateway/crates/identity](gateway/crates/identity/design.md) - sign-in, PATs, discovery, desktop entry: the public account surface (gw.{domain}).
- [gateway/crates/profile](gateway/crates/profile/design.md) - the authoritative user store.
- [gateway/crates/devserver-proxy](gateway/crates/devserver-proxy/design.md) - the public data-plane edge for tunneled devservers ({proxy}.proxy.{domain}).
- [gateway/crates/devserver-control](gateway/crates/devserver-control/design.md) - the fleet control plane: proxy directory, admission, kill routing.
- [gateway/crates/gateway-common](gateway/crates/gateway-common/design.md) - the contracts the gateway services share.
- [gateway/crates/admin](gateway/crates/admin/design.md) - the operator CLI.
