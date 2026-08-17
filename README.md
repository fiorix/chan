# Chan

This is the source code of Chan, an IDE in a single binary: a terminal emulator and multiplexer plus a workspace manager. Download binaries from [chan.app](https://chan.app) or build locally using the Makefile here.

Contributors and agents: start at [.agents/README.md](.agents/README.md); the practical guide is [CONTRIBUTING.md](CONTRIBUTING.md).

## Design documents

The architecture is documented next to the code it describes. [design.md](design.md) is the whole-system reference (crate boundaries, runtime topology, bind vs tunnel, the devserver); each crate or surface below carries its own design of record.

Core:

- [crates/chan](crates/chan/design.md) - the CLI binary: dispatch, process lifecycle, service supervision, self-upgrade.
- [crates/chan-workspace](crates/chan-workspace/design.md) - the core: filesystem gates, workspace registry, search, graph, state placement, locking.
- [crates/chan-server](crates/chan-server/design.md) - the serving layer: per-tenant HTTP/WS, SPA embed, MCP host, devserver builder.
- [crates/chan-library](crates/chan-library/design.md) - multi-tenant orchestration: `WorkspaceHost`, the window registry, the launcher slot.
- [crates/chan-shell](crates/chan-shell/design.md) - `cs`: the control-socket wire contract and the client that speaks it.
- [crates/chan-llm](crates/chan-llm/design.md) - the MCP tool sandbox exposed to external agent CLIs.
- [crates/chan-systemd](crates/chan-systemd/design.md) - the systemd boundary: notify, watchdog, fdstore, unit render and classification.
- [crates/chan-report](crates/chan-report/design.md) - repository reports: the walker, the JSONL schema, the COCOMO model.
- [crates/fetch-models](crates/fetch-models/design.md) - build-only helper that produces the embedded-model tarball.

Desktop and web:

- [desktop](desktop/design.md) - the Tauri shell: windows, exact-origin trust, native IPC.
- [web/packages/workspace-app/src](web/packages/workspace-app/src/design.md) - the web frontend: the two SPAs, serving topology, the color system.
- [web/packages/workspace-app/src/editor](web/packages/workspace-app/src/editor/design.md) - the CM6 editor surface.
- [web/packages/launcher](web/packages/launcher/design.md) - the launcher SPA and its three-surface serving.

Tunnel:

- [crates/chan-tunnel-proto](crates/chan-tunnel-proto/design.md) - the shared wire contracts.
- [crates/chan-tunnel-client](crates/chan-tunnel-client/design.md) - the dial-side client embedded by `chan devserver`.
- [crates/chan-tunnel-server](crates/chan-tunnel-server/design.md) - the terminator embedded by the gateway.
- [crates/chan-revtunnel](crates/chan-revtunnel/design.md) - reverse port forwarding from a devserver to the connected desktop (`cs tunnel`); distinct from the gateway tunnel.

Gateway (separate Cargo workspace; the chan.app account, sign-in, and proxy surface):

- [gateway/crates/identity](gateway/crates/identity/design.md) - sign-in, PATs, discovery, desktop entry: the public account surface (gw.{domain}).
- [gateway/crates/profile](gateway/crates/profile/design.md) - the authoritative user store.
- [gateway/crates/devserver-proxy](gateway/crates/devserver-proxy/design.md) - the public data-plane edge for tunneled devservers ({proxy}.usr.{domain}).
- [gateway/crates/devserver-control](gateway/crates/devserver-control/design.md) - the fleet control plane: proxy directory, admission, kill routing.
- [gateway/crates/gateway-common](gateway/crates/gateway-common/design.md) - the contracts the gateway services share.
- [gateway/crates/admin](gateway/crates/admin/design.md) - the operator CLI.
