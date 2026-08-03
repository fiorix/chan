# ADR 0001: Desktop owns aggregate command-launcher authority

Status: Accepted

## Context

Chan needs one command launcher from workspace windows, standalone terminals,
the launcher window, and remote devserver content. The visual and keyboard UX
should be identical, but those webviews do not have equal authority. In
particular, a remote devserver page must not receive Chan Desktop's aggregate
Computers inventory, root launcher bearer, or global query text.

## Decision

Chan uses one shared command-deck component with two authority hosts.

On Chan Desktop, one reusable `command-launcher` Tauri overlay is owned by the
desktop process. It loads the trusted local launcher origin and holds Desktop's
aggregate Computers authority. An invoking webview contributes only a bounded
catalog of serializable contextual command descriptors. Selection sends the
stable command id back to that same live webview, which revalidates it against
its current catalog before execution. The source receives only request and
execution ids; it never receives the Desktop inventory, launcher bearer, or
query.

Outside Chan Desktop, the deck stays inline. A tenant bearer may mint a
five-minute sliding capability only when the requested window is live in that
same tenant. The capability exposes a token-redacted snapshot and approved
actions only for the host's own library. It inherits the verified tunnel role,
is revoked when the invoking window disconnects, and cannot enumerate an
aggregate remote feed. Reload remints authority; only the serializable draft
survives.

The launcher has contextual and Computers entry modes, not separate launcher
products. Search may jump across menu levels, but confirmations and authority
checks remain mandatory.

## Consequences

- Remote content can ask Desktop to show the launcher and can execute only its
  own revalidated contextual commands. Desktop actions never cross into it.
- Desktop can control local and connected computer libraries from one trusted
  overlay, including control-terminal focus and devserver reconnect actions.
- Browser windows can control only their invoking library; readonly tunnel
  viewers may inspect and focus but may not mutate.
- Drafts are keyed by invoking window and entry mode. Hide, focus loss, and
  reload preserve them; successful execution, true window close, and app exit
  clear them.
- A transparent macOS Tauri window requires `macOSPrivateApi`. This is compatible
  with Chan's direct signed distribution but not a Mac App Store build.
