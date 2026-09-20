# An extension spawned by the installed devserver gets a bare PATH, and the warning hides why it failed

Status: raised for v0.101.0 from a field investigation of an extension that never appeared in the catalog on a machine running the devserver as a systemd user service. The cause was established there by reproducing the spawn under the service's exact environment; the code claims below are a source reading against `main` at `d3de0180b`.

## What was seen

chan spawns an extension with `Command::new` and no shell (`crates/chan-server/src/extensions.rs`), so the child inherits the server's environment verbatim and nothing sources a shell profile the way a chan terminal does. The unit chan renders (`crates/chan-systemd/src/lib.rs`) emits only the `Environment=` assignments it holds and never a `PATH=`, so a devserver started by that unit runs with systemd's own default PATH. An administrator cannot simply add one: `classify_installed` in the same file accepts only `CHAN_HOME`, `CHAN_TUNNEL_TOKEN`, `CHAN_TUNNEL_URL` and `CHAN_TUNNEL_DEVSERVER_NAME` as chan-owned keys, and any other key makes chan refuse to manage its own unit ("refusing to overwrite foreign or administrator-edited systemd unit", `crates/chan/src/lib.rs`). The declaration cannot carry one either: `ExtensionFile` is `deny_unknown_fields` over name, command, args and capabilities.

An extension that resolves a helper on PATH therefore exits before printing its handshake line, and the operator is told almost nothing. `ExtensionRuntime::start_in` logs `extension ignored` with the error's `Display`, which renders only the outermost context, so the journal says the handshake could not be read and never says the child closed its stdout without the marker. In the field case that opacity was most of the investigation: the extension failed at every devserver start, and the working fix was a systemd drop-in adding the user's own bin directory to PATH.

## Desired contract

An extension spawned by a chan-installed devserver resolves the helpers a user would reasonably expect it to, or, where chan will not promise that, the failure names its own cause in one log line and the documentation says plainly that a service-spawned extension inherits no shell PATH.

## Boundaries

`crates/chan-server/src/extensions.rs` (the spawn, `read_handshake` and the ignored-extension warning), `crates/chan-systemd/src/lib.rs` (the rendered unit and its accepted environment keys), `crates/chan/src/lib.rs` (the foreign-unit refusal) and the extension authoring documentation under `docs/`.

## Acceptance

1. A test in which the child closes stdout without the marker shows the logged error naming that cause, not only the outer context.
2. The PATH question is settled one way and the choice is implemented: the rendered unit sets a PATH, or the declaration may carry an environment, or the documentation states the bare-PATH behaviour and the drop-in remedy.
3. A test starts an extension under a minimal environment and asserts the documented behaviour, so the case a service produces is covered without a service.
