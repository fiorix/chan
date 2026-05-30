# MCP Discovery

chan-server exposes its MCP bridge over a Unix-domain socket while
`chan serve` is running. It does not publish that socket into external
agent config files on startup.

In particular, chan does not write:

* `~/.claude.json`
* `~/.codex/config.toml`
* `~/.gemini/settings.json`

Chan-launched terminal sessions are the supported discovery path. When
the MCP bridge is available, terminal processes receive:

```text
CHAN_MCP_SERVER_NAME=chan
CHAN_MCP_SOCKET=...
CHAN_MCP_COMMAND=...
CHAN_MCP_COMMAND_JSON=...
CHAN_MCP_SERVER_JSON=...
```

External agent CLIs launched from that terminal can translate the
`CHAN_` descriptor into their own MCP configuration shape.

## Descriptor shape

The command descriptor points at the current Chan host binary running a small
bridge subcommand. In CLI-hosted sessions that is usually `chan`; in packaged
desktop sessions it may be `chan-desktop`:

```
chan __mcp-proxy <unix-socket-path>
```

The socket path is the active `chan serve` process's MCP bridge socket.
chan-server rebinds it on each startup; terminal sessions get the live
value through `CHAN_MCP_SOCKET` and `CHAN_MCP_SERVER_JSON`.

## Out of scope (today)

* Publishing chan into global or user-scoped agent config files.
* Removing stale entries created by older chan versions. Existing
  entries remain a manual cleanup item.
* Auto-discovery of agents outside chan-launched terminal sessions.
