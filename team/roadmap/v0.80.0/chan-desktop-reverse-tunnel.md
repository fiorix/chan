# Chan desktop reverse tunnel

Status: REGISTERED for v0.80.0, NOT specced.

## Goal

Let a terminal on a devserver ask its connected `chan-desktop` client to listen on a local TCP or UDP port and tunnel traffic back to the machine running the devserver. The motivating case is exposing a devserver-hosted development server through the desktop machine.

The command should run in the foreground and follow a familiar reverse-tunnel shape:

```text
cs tunnel --proto tcp|udp [local-address:]local-port:remote-port
```

Decide the exact address order and whether to match `ssh -R` syntax when this item is specced. The listener should default to loopback.

## Related desktop routing

Desktop window commands issued inside a connected devserver terminal should route to that desktop client. For example, `cs window new` currently fails with:

```text
Error: window management requires the chan desktop app
```

That command should work when the terminal belongs to a workspace opened by `chan-desktop`.

## Acceptance

- A TCP test connects to the desktop listener and reaches a server on the devserver host.
- UDP receives equivalent end-to-end coverage.
- Tunnel teardown follows the foreground command's lifetime.
- `cs tunnel` fails clearly when no desktop client is available.
- Desktop window management works from a connected devserver terminal.
