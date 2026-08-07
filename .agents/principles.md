# Project Principles

## Workspace is the boundary

All filesystem operations route through `chan_workspace::Workspace`, which sandboxes paths under the registered workspace root, refuses non-regular files (symlinks, FIFOs, sockets, devices), and performs atomic writes. Nothing in this repo should ever call `std::fs::*` on user content directly.

## Single binary, no runtime deps

No Node.js, no Python, no native daemons at runtime. Both frontend bundles (the workspace app from `web/dist` and the launcher from `web-launcher/dist`) embed via rust-embed: debug builds read them from disk per request, release builds bake them in. The Linux CLI tarball is statically linked (musl); distro packages link glibc and systemd. New dependencies must hold this line.

## Local-first by default, opt-in tunnel

The HTTP server binds `127.0.0.1` by default; non-loopback binds are explicit opt-ins (`chan open --host`, `chan devserver --bind`). Auth is a persisted bearer token appended to the launch URL: `chan open` mints a per-workspace token (0600, created on first run, reused across restarts), and the devserver keeps its own in `~/.chan/devserver/config.json`, rotated with `chan devserver --rotate-token` and self-rotated at the first cold start after it turns 30 days old. No TLS at the local hop.

Tunnel mode (`chan devserver --tunnel-token ...`, or `CHAN_TUNNEL_TOKEN` env var, plus the required `--tunnel-url` / `CHAN_TUNNEL_URL` and the optional `--tunnel-devserver-name`) keeps the local management listener and also dials the gateway tunnel ingress (`usr.{domain}/v1/tunnel`) through `chan-tunnel-client`. Registration is per-devserver: one tunnel publishes the whole library at the tenant origin `{owner}--{disc}.{proxy}.usr.{domain}/{workspace}/*` over yamux substreams. One chan devserver process owns its library's writes; the tunnel just relocates the inbound transport. Local management remains bearer-gated. Tunnel-origin requests bypass local bearer auth only after devserver-proxy authenticates the browser at the gateway edge and forwards the request over the authenticated tunnel with a signed caller assertion. Wire protocol lives in `crates/chan-tunnel-proto`.

## App-level vs core

The layering is a hard line: chan-workspace is the core (filesystem, search, graph, watch, report), chan-library is the multi-tenant orchestration layer (`WorkspaceHost`, the window registry, the launcher slot, terminal sessions), and chan-server is the serving layer (per-tenant HTTP/WS, SPA embed, MCP host, devserver builder). Don't push library concerns into chan-workspace, and don't reimplement library primitives in chan-server. When in doubt, read `crates/chan-workspace/design.md`.

## MCP server only, no in-app agent

There is no in-app Agent overlay and no chan-server `/api/llm/*` / `/api/assistant/*` HTTP surface. External agents (claude, codex, gemini, opencode) connect through the in-process MCP server exposed by `mcp_bridge.rs` over a Unix-domain socket (a named pipe on Windows). The `CHAN_MCP_*` discovery vars are injected by chan-library at terminal spawn and are off by default (a stray descriptor makes codex fail to start; it wants file-based config); opt in per server (the `terminal.mcp_env` config key), per attach (`?mcp_env=on`), or per team member (`--mcp-env on`). Chan does not write CLI-owned env namespaces or external agent config files; tools translate the `CHAN_` descriptor into their own MCP config shape. Do not reintroduce in-app agent UI or chan-server-side chat APIs without an explicit decision from the maintainer.
