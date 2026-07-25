# chan-gateway-admin: design

## Problem

Operators need to manage users, tokens, and live tunnels without SSH plus direct database access. A CLI is faster for routine tasks (block a user, check an audit log, kill a tunnel) than a web UI; it composes with shell loops, jq pipelines, and CI.

## Architecture

Single Rust binary that talks HTTP to profile-service and devserver-control. No database access; the CLI only consumes the existing admin HTTP routes.

The `tokio` runtime is `current_thread` (commands are sequential and short-lived; a multi-threaded runtime is unnecessary overhead). `clap` derives the command tree.

Two HTTP clients live inside the binary:

- `AdminClient`: profile-service (`CHAN_ADMIN_PROFILE_URL`). Resolves `<ident>` and calls the admin tree.
- `WorkspaceClient`: devserver-control (`CHAN_ADMIN_WORKSPACE_URL`). Talks to `/admin/v1/*` and decodes the SSE snapshot streams for `tunnel watch` and `proxy watch`.

Both clients use plain `reqwest` with a shared bearer configuration; the CLI sets a 15-second per-call timeout (no global timeout on the watch stream so it can idle between snapshots).

## Operational contracts

### Identity resolution

User-facing identifiers resolve by uuid, email substring, or exact username, in that order. Ambiguous and missing matches are distinct operator errors.

### User block

The block flow lives server-side: profile-service fans out to devserver-control in the same operation. The CLI still calls both for robustness against split deployments where the CLI's devserver-control URL may differ from the profile container's view of devserver-control, but the second call is idempotent (`killed: 0` is fine when profile already swept the registrations).

Order:

1. `POST /v1/admin/users/{id}/block` on profile-service. This sets `blocked_at`, revokes every live PAT, writes an `auth_audit` row and, server-side, fires devserver-control `kill_user_tunnels` for the user. If profile fails the CLI stops here.
2. `POST /admin/v1/users/{user}/tunnels/kill` on devserver-control. Belt-and-braces. A failure here surfaces as a warning on stderr but does not change the profile-side outcome.

The ordering ensures a partial failure leaves the user in a "blocked but maybe a tunnel still alive" state rather than the inverse, which is the safer direction.

### Feature flags

Manage feature flags and per-user overrides via profile-service's admin tree. `flag list` and `flag overrides <key>` render a table / `--json`; `flag create` is idempotent (re-issuing for the same key bumps `default_enabled` and description); `flag grant <key> <ident> [--enabled|--disabled]` upserts the per-user override, and `flag revoke` clears it. `<ident>` resolution is the same uuid / email / username pipeline as the user subcommand. Default for `flag grant` is `--enabled`; `--disabled` lets an operator record a deny override against a default-on flag.

### Tunnel and proxy watch

devserver-control's `/admin/v1/tunnels/watch` and `/admin/v1/proxies/watch` are SSE streams. `watch_loop` consumes the stream, parses `event: snapshot` blocks, and re-renders. TTY mode clears the screen between renders (`\x1b[2J\x1b[H`) so the output behaves like `watch -n1`. `--json` emits one JSON line per event for `jq` piping.

`tunnel ps` and `proxy ps` read the matching one-shot snapshots (`/admin/v1/tunnels`, `/admin/v1/proxies`). Tunnel rows carry the owning node's `proxy_id` and `proxy_base_url` so an operator can tell which proxy holds a registration; proxy rows carry the node's status, package version, tunnel count, and liveness timestamps.

### Output

Default rendering uses `comfy_table` with the `NOTHING` preset (no Unicode lines), targeting 80 columns. Columns are chosen per command (e.g. `USER`, `DEVSERVER`, `PROXY`, `PEER`, `UPTIME`, `CONNECTED` for `tunnel ps`). UUIDs are truncated to 8 chars in table mode.

`--json` emits prettified JSON via `serde_json::to_string_pretty` because operators copy-paste output into tickets; the small overhead is fine for CLI workloads.

## Key decisions

### Per-service bearers

The CLI accepts independent `CHAN_ADMIN_PROFILE_TOKEN`, `CHAN_ADMIN_IDENTITY_TOKEN`, and `CHAN_ADMIN_OPERATOR_TOKEN` credentials. `--profile-token`, `--identity-token`, and `--operator-token` are bound to one destination each; `--token` remains only as a compatibility alias for the controller operator token. The CLI never reuses one service's credential against another service.

### Exit codes are part of the contract

0 / 1 / 2 / 3 are documented in the README and used by shell wrappers (CI, smoke tests, ops scripts). Adding a new exit code is a public-API change; rotating the existing meanings is not allowed.

### --json everywhere

Every read command supports `--json` so the CLI can be piped into jq. Adding a new subcommand without `--json` would be a regression in operability; reviewers should reject such PRs.

### No interactive features

No menus, no TUI. All commands are non-interactive except for `user delete` which prompts `[y/N]` (skippable with `--yes`). The CLI is meant to compose with `xargs` and `parallel`.

### Minimal local URL encoding

Path segments contain only `[a-z0-9_.-]` (validated upstream), so the CLI ships a tiny inline `urlencoding::encode_path` rather than pulling in a real urlencoding crate. The full RFC 3986 table is overkill for a value that already passed username / workspace-name validation.

## Invariants

- The CLI is read-mostly. State changes go through documented HTTP routes; there are no direct database writes.
- A blocked user always has every PAT revoked; the profile block flow handles this server-side, and also fires devserver-control eviction in the same transaction.
- `user delete` cascades through profile-service's FK chain; the CLI does not orchestrate the deletion across multiple endpoints.
- `tunnel kill` is idempotent: a second kill of the same registration returns 404, which the CLI surfaces as exit 3.
- Output is deterministic on TTY-vs-`--json` choice. No mixed output on a single command.

## Error model

Errors surface as `anyhow::Error` chains; the top-level dispatch calls `eprintln!("error: {e:#}")` and exits with the code from `exit_code_for`. `ClientError` is the typed boundary between HTTP responses and the CLI:

| `ClientError`     | Exit | Notes                                  |
|-------------------|------|----------------------------------------|
| `NotFound`        | 3    | upstream returned 404                  |
| `BadInput(s)`     | 2    | upstream returned 400 (with body)      |
| `Upstream{...}`   | 1    | any other non-2xx status               |

Network failures (`reqwest::Error`) reach `exit_code_for` as plain `anyhow::Error` instances, which exit 1.

## What is not wired

- Shell completion (`clap` has `--generate` for it; not generated yet)
- A persistent config file for admin defaults
- Batch operations (`--input batch.jsonl`)
- Inline editor for `user update --email` (the CLI takes a flag, no `$EDITOR` round trip)
