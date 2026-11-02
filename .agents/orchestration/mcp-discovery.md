# MCP Discovery

chan-server exposes its MCP bridge over a Unix-domain socket (a named pipe on Windows) while a server runs, and never publishes it into an agent CLI's own config files (`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.config/opencode/opencode.json` and the like). The supported discovery path is the environment of a chan-launched terminal, and it is off by default because a stray descriptor makes codex refuse to start, since it wants file-based config. Opt in per server (`terminal.mcp_env` in the server config), per attach (`?mcp_env=on` on the terminal WebSocket), or per team (`mcp_env` in the team config, `cs terminal team new --mcp-env on`). Opted in, the terminal's processes receive:

```text
CHAN_MCP_SERVER_NAME=chan
CHAN_MCP_SOCKET=...
CHAN_MCP_COMMAND=...
CHAN_MCP_COMMAND_JSON=...
CHAN_MCP_SERVER_JSON=...
```

An agent CLI launched from that terminal translates the descriptor into its own MCP configuration shape.

## Descriptor shape

The command descriptor points at the running chan binary itself running a bridge subcommand:

```
chan __mcp-proxy <socket-path>
```

The socket path is the server's bridge endpoint, rebound on each start; sessions get the live value through `CHAN_MCP_SOCKET` and `CHAN_MCP_SERVER_JSON`. chan-desktop exposes the same bridge as `chan-desktop __mcp-proxy`.

## Out of scope

- Publishing chan into global or user-scoped agent config files.
- Discovery for processes outside chan-launched terminal sessions.
