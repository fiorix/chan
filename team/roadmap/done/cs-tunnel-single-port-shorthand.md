# `cs tunnel <port>` forwards that port to itself

Status: SHIPPED in [v0.83.0](../release/release-v0.83.0.md). A lone port is shorthand for both ends of the tunnel spec.

## What

`cs tunnel 3000` is refused:

```
$ cs tunnel 3000
error: invalid value '3000' for '<SPEC>': expected [bind-address:]desktop-port:devserver-port, for example 8080:3000
```

The overwhelmingly common case is forwarding a port to the same number on the other end, and it is the one case the spec makes you type twice. A single port becomes shorthand for the pair: `cs tunnel 3000` means `cs tunnel 3000:3000`.

## What is already known (grounding, verified 2026-08-02)

One parser owns the whole spec grammar and the CLI defers to it:

- `parse_spec` (`crates/chan-revtunnel/src/spec.rs:124`) is the only parser. `parse_tunnel_spec_arg` (`crates/chan-shell/src/cli.rs:1780`) is a one-line clap adapter over it, so the CLI needs no grammar change of its own.
- It peels an optional bind address first: a bracketed IPv6 literal by `[`/`]`, otherwise by taking everything before the second-from-last colon (`s.rmatch_indices(':').nth(1)`). What remains is `rest`.
- `rest.split_once(':')` then yields the two ports, and a `rest` with no colon returns `SpecError::MissingPorts`. That single call is the whole refusal.

The behavior the shorthand must not disturb:

- Desktop port 0 is a live feature: `0:3000` asks the desktop OS for a free port (`spec.rs:198`, `desktop_port_zero_is_an_ephemeral_bind_request`).
- Devserver port 0 is refused, because there is nothing to dial (`spec.rs:250`, `SpecError::ZeroDevserverPort`).
- A two-field spec is always `desktop-port:devserver-port`, never `address:port`. `1.2.3.4:8080` has one colon, so the address peel does not fire, `rest` keeps its colon, and it fails as `BadDesktopPort("1.2.3.4")`. The shorthand fires only when `rest` has NO colon, so this stays exactly as it is.

## Contract

- After the bind-address peel, a `rest` containing no colon is a single port used for both ends. `3000` is `3000:3000`; `[::1]:3000` is `[::1]:3000:3000`.
- `cs tunnel 0` is refused. Expanding it gives devserver port 0, which `ZeroDevserverPort` already rejects with the right message; that error stands and needs no new variant.
- Two-field and three-field specs are untouched. In particular `1.2.3.4:8080` keeps failing as an invalid desktop port, because the shorthand cannot fire on a `rest` that still holds a colon.
- `SpecError::MissingPorts` (`spec.rs:94`) stops being reachable for a lone port, so its message updates to describe the grammar that now exists.
- The three places that state the grammar to a user move together: the clap `value_name` help at `cli.rs:407`, `CS_TUNNEL` at `crates/chan-shell/src/help.rs:1493`, and the `CS_TUNNEL_AFTER` examples at `:1507`. `chan dump-skill` renders the same strings, so it follows for free.

## Rough size

XS. One branch in `parse_spec`, one error message, the help and long-help strings, and their tests.

## Open

None.

## Acceptance

- `cs tunnel 3000` binds desktop port 3000 and dials devserver port 3000, and the acknowledgement names both.
- `spec.rs:221` `missing_or_partial_port_pairs_are_rejected` currently pins `tcp("8080")` as `MissingPorts`. That case moves to a new test asserting the expansion; `8080:`, `:3000`, and the empty and whitespace inputs stay rejected exactly as they are.
- `0` is refused with the devserver-port-zero message, while `0:3000` still requests an ephemeral desktop port.
- `1.2.3.4:8080` still fails naming `1.2.3.4` as an invalid desktop port.
- `[::1]:3000` parses as bind `::1` with 3000 on both ends.
- `cs tunnel --help` and `chan dump-skill` both describe the shorthand.
