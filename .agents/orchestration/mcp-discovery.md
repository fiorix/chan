# MCP Discovery

chan-server exposes its MCP bridge over a Unix-domain socket (a named pipe on Windows) while a chan server is running. It does not publish that socket into external agent config files.

In particular, chan does not write:

* `~/.claude.json`
* `~/.codex/config.toml`
* `~/.gemini/settings.json`
* `~/.config/opencode/opencode.json`

Chan-launched terminal sessions are the supported discovery path, and the env descriptor is OFF by default (a stray descriptor makes codex fail to start; it wants file-based config). Opt in per server (the `terminal.mcp_env` config key), per attach (`?mcp_env=on` on the terminal WebSocket), or per team member (`cs terminal team new --mcp-env on`). When opted in, terminal processes receive:

```text
CHAN_MCP_SERVER_NAME=chan
CHAN_MCP_SOCKET=...
CHAN_MCP_COMMAND=...
CHAN_MCP_COMMAND_JSON=...
CHAN_MCP_SERVER_JSON=...
```

External agent CLIs launched from that terminal can translate the `CHAN_` descriptor into their own MCP configuration shape.

## Descriptor shape

The command descriptor points at the chan binary itself running a small bridge subcommand:

```
chan __mcp-proxy <socket-path>
```

The socket path is the running server's MCP bridge endpoint, rebound on each startup; terminal sessions get the live value through `CHAN_MCP_SOCKET` and `CHAN_MCP_SERVER_JSON`. chan-desktop exposes the same bridge as `chan-desktop __mcp-proxy`.

## Out of scope

* Publishing chan into global or user-scoped agent config files.
* Auto-discovery for processes outside chan-launched terminal sessions.
