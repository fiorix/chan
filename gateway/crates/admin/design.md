# chan-gateway-admin design

## Problem

Operators need to manage users, tokens, OAuth sessions, tenant sessions, durable access policy, and live tunnels without direct database access. The CLI composes with shell loops, jq pipelines, and CI.

## Architecture

Single Rust binary that talks HTTP to profile-service, identity-service, and devserver-control. No database access; the CLI only consumes documented admin HTTP routes.

The `tokio` runtime is `current_thread` (commands are sequential and short-lived; a multi-threaded runtime is unnecessary overhead). `clap` derives the command tree.

Three HTTP clients live inside the binary:

- `AdminClient`: profile-service (`CHAN_ADMIN_PROFILE_URL`). Resolves `<ident>` and calls the admin tree.
- `IdentityClient`: identity-service (`CHAN_ADMIN_IDENTITY_URL`). Calls OAuth-session and composite policy/access routes.
- `WorkspaceClient`: devserver-control (`CHAN_ADMIN_WORKSPACE_URL`). Talks to `/admin/v1/*` and decodes the SSE snapshot streams for `tunnel watch`, `proxy watch`, and `session tenant watch`.

Each client has its own bearer and destination. The CLI sets per-call timeouts (15 seconds on profile and identity calls, 10 or 15 seconds on controller calls), permits 65 seconds for user-deletion quiet-window settlement, and sets no global timeout on watch streams.

## Operational contracts

### Identity resolution

User-facing identifiers resolve by uuid, email substring, or exact username, in that order. Ambiguous and missing matches are distinct operator errors.

### Composite mutations

`user block` first persists profile block, PAT revocation, audit, and durable subject revocation. It then calls identity's access-revoke composite for OAuth sessions, tenant sessions, and owner tunnels. `user delete`, policy decrease/suspend, and fleet pause also run through identity composites. Durable state remains visible in stdout when a downstream cut is partial, the diagnostic goes to stderr, and the command exits 1. Retrying repeats the required drain.

Policy resume reads the current policy first and refuses 404 instead of inventing a limit. Fleet pause requires the explicit `--drain` acknowledgement and always calls the drain route.

### Session and aggregate reads

OAuth-session reads use identity's bounded inventory. Tenant-session reads and watches use controller snapshots with subject, owner, and proxy filters. Global audit uses profile's filtered pagination. `overview` calls the profile, identity, and controller aggregate endpoints plus fleet status; it never lists rows to count them.

### Feature flags

Manage feature flags and per-user overrides via profile-service's admin tree. `flag list` and `flag overrides <key>` render a table / `--json`; `flag create` is idempotent (re-issuing for the same key bumps `default_enabled` and description); `flag grant <key> <ident> [--enabled|--disabled]` upserts the per-user override, and `flag revoke` clears it. `<ident>` resolution is the same uuid / email / username pipeline as the user subcommand. Default for `flag grant` is `--enabled`; `--disabled` lets an operator record a deny override against a default-on flag.

### Tunnel, proxy, and tenant-session watch

devserver-control's tunnel, proxy, and browser-session watch routes are SSE streams. `watch_loop` consumes `event: snapshot` blocks and re-renders. TTY mode clears the screen between renders (`\x1b[2J\x1b[H`). `--json` emits one prettified JSON document per event.

`tunnel ps` and `proxy ps` read the matching one-shot snapshots (`/admin/v1/tunnels`, `/admin/v1/proxies`). Tunnel rows carry the owning node's `proxy_id` and `proxy_base_url` so an operator can tell which proxy holds a registration; proxy rows carry the node's status, package version, tunnel count, and liveness timestamps.

### Output

Default rendering uses `comfy_table` with the `NOTHING` preset (no Unicode lines), targeting 80 columns. Columns are chosen per command (e.g. `USER`, `DEVSERVER`, `PROXY`, `CAP`, `PEER`, `UPTIME`, `CONNECTED` for `tunnel ps`). UUIDs are truncated to 8 chars in table mode.

`--json` emits prettified JSON via `serde_json::to_string_pretty` because operators copy-paste output into tickets; the small overhead is fine for CLI workloads.

## Key decisions

### Per-service bearers

The CLI accepts independent `CHAN_ADMIN_PROFILE_TOKEN`, `CHAN_ADMIN_IDENTITY_TOKEN`, and `CHAN_ADMIN_OPERATOR_TOKEN` credentials. `--profile-token`, `--identity-token`, and `--operator-token` are bound to one destination each; `--token` remains only as a compatibility alias for the controller operator token. The CLI never reuses one service's credential against another service.

### Exit codes are part of the contract

0 / 1 / 2 / 3 are documented in the README and used by shell wrappers (CI, smoke tests, ops scripts). Adding a new exit code is a public-API change; rotating the existing meanings is not allowed.

### --json everywhere

Every read command supports `--json` so the CLI can be piped into jq. Adding a new subcommand without `--json` would be a regression in operability; reviewers should reject such PRs.

### No interactive features

No menus, no TUI. All commands are non-interactive except `user delete`, `user change-email`, and `flag delete`, which prompt `[y/N]` (skippable with `--yes`). The CLI is meant to compose with `xargs` and `parallel`.

### Minimal local URL encoding

Path segments stay within the username / workspace-slug alphabet (`[a-z0-9-]` plus `_` and `.`, validated upstream), so the CLI ships a tiny inline `urlencoding::encode_path` rather than pulling in a real urlencoding crate. The full RFC 3986 table is overkill for a value that already passed username / workspace-name validation.

## Invariants

- The CLI is read-mostly. State changes go through documented HTTP routes; there are no direct database writes.
- A block or stricter policy is durable before the CLI reports any live-drain result.
- `user delete` uses identity's convergent composite and never deletes profile state before controller settlement.
- `tunnel kill` is idempotent: a second kill of the same registration returns 404, which the CLI surfaces as exit 3.
- Output is deterministic on TTY-vs-`--json` choice. stdout contains data; stderr contains diagnostics.

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
