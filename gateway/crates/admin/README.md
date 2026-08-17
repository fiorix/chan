# chan-gateway-admin

Operator CLI for the chan-gateway suite. Manages users, personal access tokens, OAuth and tenant sessions, durable devserver policy, audit logs, live tunnels, and the connected proxy fleet through the scoped HTTP admin contracts.

## Role in the system

Out-of-band admin surface. profile-service owns durable user data and aggregate auth history, identity-service owns OAuth sessions and composite policy/access mutations, and devserver-control owns tenant-session and tunnel authority. The CLI has no database access and never sends one service's bearer to another destination.

## Build

```bash
cargo build -p admin
```

## Install

From the workspace:

```bash
cargo install --path crates/admin
```

From a Debian package (built by `packaging/gateway/scripts/build-debs.sh`):

```bash
sudo apt install ./chan-gateway-admin_*.deb
```

## Env vars

| Name                      | Default                  | Notes              |
|---------------------------|--------------------------|--------------------|
| `CHAN_ADMIN_PROFILE_TOKEN` | none                    | profile-service operator bearer |
| `CHAN_ADMIN_IDENTITY_TOKEN` | none                   | identity-service operator bearer |
| `CHAN_ADMIN_OPERATOR_TOKEN` | none                   | devserver-control operator bearer |
| `CHAN_ADMIN_PROFILE_URL`  | `http://127.0.0.1:7001`  | profile-service    |
| `CHAN_ADMIN_IDENTITY_URL` | `http://127.0.0.1:7000`  | identity-service   |
| `CHAN_ADMIN_WORKSPACE_URL` | `http://127.0.0.1:7003` | devserver-control  |

Each bearer is scoped to one service. `--token` is retained as a compatibility alias for `--operator-token`; it is not sent to profile or identity. Every command requires the bearer of each service it touches; a missing or empty token fails closed before any request leaves the CLI.

## Commands

```text
chan-gateway-admin user list   [--blocked|--active] [--email PAT] [--username U] [--limit <n>] [--offset <n>]
chan-gateway-admin user get    <ident>
chan-gateway-admin user create --email <e> [--name <n>]
chan-gateway-admin user update <ident> --name <n>
chan-gateway-admin user change-email <ident> --email <e> [--yes]
chan-gateway-admin user rename <ident> <username>
chan-gateway-admin user delete <ident> [--yes]
chan-gateway-admin user block  <ident> [--reason <text>]
chan-gateway-admin user unblock <ident>
chan-gateway-admin user audit  <ident> [--limit <n>]
chan-gateway-admin user tokens <ident>

chan-gateway-admin token create <email> [--scope <s>]... [--label <l>] [--expires-days <n>]
chan-gateway-admin token list   <ident>
chan-gateway-admin token revoke <token-uuid>
chan-gateway-admin token audit  <token-uuid> [--limit <n>]

chan-gateway-admin tunnel ps    [--user <username>]
chan-gateway-admin tunnel kill  <user> <workspace>
chan-gateway-admin tunnel watch [--user <username>]

chan-gateway-admin proxy ps
chan-gateway-admin proxy watch

chan-gateway-admin flag list
chan-gateway-admin flag create    <key> [--default-on|--default-off] [--description <text>]
chan-gateway-admin flag delete    <key> [--yes]
chan-gateway-admin flag grant     <key> <ident> [--enabled|--disabled]
chan-gateway-admin flag revoke    <key> <ident>
chan-gateway-admin flag overrides <key>

chan-gateway-admin policy get <ident>
chan-gateway-admin policy set <ident> --enabled --max-connected-devservers <n>
chan-gateway-admin policy suspend <ident>
chan-gateway-admin policy resume <ident>

chan-gateway-admin session oauth ps [--user <ident>]
chan-gateway-admin session oauth revoke <session-uuid>
chan-gateway-admin session oauth revoke-user <ident>

chan-gateway-admin session tenant ps [--subject <ident>] [--owner <ident>] [--proxy <id>]
chan-gateway-admin session tenant watch [--subject <ident>] [--owner <ident>] [--proxy <id>]
chan-gateway-admin session tenant revoke <session-uuid>
chan-gateway-admin session tenant revoke-subject <ident>
chan-gateway-admin session tenant revoke-owner <ident>

chan-gateway-admin audit ps [--user <ident>] [--action <action>] [--since <rfc3339>] [--until <rfc3339>] [--limit <n>] [--offset <n>]

chan-gateway-admin fleet pause --drain
chan-gateway-admin fleet resume
chan-gateway-admin fleet status

chan-gateway-admin overview [--since <duration>]
```

`<ident>` resolves in this order: a uuid (exact); an email (exact, case-insensitive); a username (exact).

`token create` is the only token command that talks to identity-service (`POST /admin/v1/tokens`); every other token command goes through profile-service. `--scope` defaults to `tunnel`; repeat it for several scopes. The minted secret prints exactly once and is never retrievable again.

`flag create` defaults the flag to OFF when neither `--default-on` nor `--default-off` is given. `tunnel kill` forces one registration offline; the devserver peer is free to reconnect. `overview --since` takes an `s`, `m`, `h`, or `d` duration and defaults to `24h`.

`policy suspend` preserves the stored limit. `policy resume` requires an existing policy. `fleet pause` requires `--drain` and always invokes the fleet-wide tenant-session and tunnel cuts.

`--json` is available on every command; the default is a `comfy_table` ASCII table sized for an 80-column terminal. Data and durable partial reports go to stdout. Warnings and errors go to stderr.

## Exit codes

| Code | Meaning                                              |
|------|------------------------------------------------------|
| 0    | success                                              |
| 1    | upstream / network / config / partial-drain error    |
| 2    | user input error (bad uuid, missing argument)        |
| 3    | not found (user / token id absent)                   |

Shell wrappers can rely on these exact codes.

## Design rationale

See [`design.md`](design.md).
