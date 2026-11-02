# chan-gateway-admin design

`chan-gateway-admin` is the operator CLI for the gateway. Operators need to manage users, tokens, OAuth sessions, tenant sessions, durable access policy, feature flags and live tunnels without direct database access, from a shell, in loops and pipelines and in CI. The CLI composes documented admin HTTP routes and nothing else. Its command surface, configuration and exit codes are in [README.md](README.md).

## Where it sits

One Rust binary that speaks HTTP to profile-service, identity-service and devserver-control. It has no database access and no server of its own. Three clients live inside it, one per destination, each with its own bearer and base URL: `AdminClient` for profile (user resolution and the profile admin tree), `IdentityClient` for identity (OAuth sessions, token mint, the composite policy and access routes) and `WorkspaceClient` for devserver-control (the `/admin/v1/*` tree and the SSE snapshot streams behind the watch commands). The CLI never reuses one service's credential against another destination.

The runtime is single-threaded because commands are sequential and short-lived; `clap` derives the command tree. Per-call timeouts are bounded, user deletion is allowed longer so the quiet-window settlement can complete, and watch streams have no global timeout.

## Operational contracts

### Identity resolution

A user-facing `<ident>` resolves by uuid, then email, then exact username. Ambiguous and missing matches are distinct operator errors. Email resolution scans every page of the substring result before declaring an exact email absent, deduplicating repeated ids across pages, so a match beyond the first page remains addressable; offset pagination is not a transaction snapshot, so a concurrent deletion can still shift later rows.

### Composite mutations

`user block` first persists the profile block, PAT revocation, audit and durable subject revocation, then calls identity's access-revoke composite for OAuth sessions, tenant sessions and owner tunnels. `user delete`, a policy decrease or suspend, and fleet pause also run through identity's composites. When a downstream cut is partial, the durable state is still reported on stdout, the diagnostic goes to stderr and the command exits non-zero; retrying repeats the required drain. Policy resume reads the current policy first and refuses to invent a limit when none exists. Fleet pause requires the explicit `--drain` acknowledgement because it always drains.

### Reads

OAuth-session reads use identity's bounded inventory. Tenant-session reads and watches use controller snapshots with subject, owner and proxy filters. Global audit uses profile's filtered pagination. `overview` calls the profile, identity and controller aggregate endpoints plus fleet status; it never lists rows to count them.

### Feature flags

`flag` manages flags and per-user overrides through profile's admin tree. `flag create` is idempotent, re-issuing for the same key updates the default and description; `flag grant` upserts a per-user override, enabled by default, with `--disabled` to record a deny override against a default-on flag; `flag revoke` clears the override so the user resolves the default again.

### Watches

The tunnel, proxy and tenant-session watch routes are SSE streams of full snapshots. The watch loop consumes each snapshot event and re-renders; TTY mode clears the screen between renders and `--json` emits one JSON document per event.

### Output

Default rendering is a plain ASCII `comfy_table` sized for an 80-column terminal, with columns chosen per command and UUIDs truncated in table mode. `--json` emits prettified JSON because operators paste output into tickets. stdout carries data and durable partial reports; stderr carries warnings and diagnostics.

## Key decisions

### Per-service bearers

`CHAN_ADMIN_PROFILE_TOKEN`, `CHAN_ADMIN_IDENTITY_TOKEN` and `CHAN_ADMIN_OPERATOR_TOKEN` are independent, and `--profile-token`, `--identity-token` and `--operator-token` are each bound to one destination. `--token` remains only as an alias for the controller operator token. A missing or empty bearer for a destination a command touches fails closed before any request leaves the CLI.

### Exit codes are part of the contract

0 success, 1 upstream, network, configuration or partial-drain error, 2 user input error, 3 not found. Shell wrappers rely on these, so adding a code is a public-API change and rotating the existing meanings is not allowed.

### `--json` everywhere

Every command supports `--json` so the CLI can be piped into jq. A new subcommand without `--json` is a regression in operability.

### No interactive features

No menus and no TUI. Every command is non-interactive except `user delete`, `user change-email` and `flag delete`, which prompt for confirmation and accept `--yes`. The CLI is meant to compose with `xargs` and `parallel`.

### Minimal local URL encoding

Path segments stay within the alphabet upstream validation already enforces for usernames and ids, so the CLI ships a tiny inline path encoder rather than a URL-encoding dependency.

## Invariants

- The CLI is read-mostly; every state change goes through a documented HTTP route and there are no database writes.
- A block or a stricter policy is durable before the CLI reports any live-drain result.
- `user delete` uses identity's convergent composite and never deletes profile state before controller settlement.
- `tunnel kill` is idempotent: a second kill of the same registration is a not-found, reported as exit 3.
- Output is deterministic for a given TTY-versus-`--json` choice; stdout is data, stderr is diagnostics.

## Error model

Errors surface as `anyhow` chains; the top-level dispatch prints the chain to stderr and exits with the code derived from the typed `ClientError` at the HTTP boundary (not found, bad input, or any other upstream status) and 1 for everything else, network failures included.

## What is not wired

- Shell completion.
- A persistent config file for admin defaults.
- Batch operations from an input file.
- An editor round trip for `user change-email`.
