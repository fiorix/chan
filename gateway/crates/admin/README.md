# chan-gateway-admin

Operator CLI for the chan-gateway suite. Manages users, personal access tokens, audit logs, live tunnel registrations, and the connected proxy fleet by calling profile-service and devserver-control admin routes over Bearer auth.

## Role in the system

Out-of-band admin surface. profile-service exposes `/v1/admin/*`; devserver-control exposes `/admin/v1/*`. This CLI is the human-friendly wrapper around both. Designed to run inside the chan infrastructure (an admin host that can reach the internal profile URL and the devserver-control admin port) or alongside the gateway services on a single host.

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

Each bearer is scoped to one service. `--token` is retained as a compatibility alias for `--operator-token`; it is not sent to profile or identity.

## Commands

```text
chan-gateway-admin user list   [--blocked|--active] [--email PAT] [--username U]
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

chan-gateway-admin token list   <ident>
chan-gateway-admin token revoke <token-uuid>
chan-gateway-admin token audit  <token-uuid> [--limit <n>]

chan-gateway-admin tunnel ps    [--user <ident>]
chan-gateway-admin tunnel kill  <user> <workspace>
chan-gateway-admin tunnel watch [--user <ident>]

chan-gateway-admin proxy ps
chan-gateway-admin proxy watch

chan-gateway-admin flag list
chan-gateway-admin flag create    <key> [--default-on|--default-off] [--description <text>]
chan-gateway-admin flag delete    <key> [--yes]
chan-gateway-admin flag grant     <key> <ident> [--enabled|--disabled]
chan-gateway-admin flag revoke    <key> <ident>
chan-gateway-admin flag overrides <key>
```

`<ident>` resolves in this order: a uuid (exact); an email substring (must match exactly one row); an exact username.

`--json` is available on every command; the default is a `comfy_table` ASCII table sized for an 80-column terminal.

## Exit codes

| Code | Meaning                                              |
|------|------------------------------------------------------|
| 0    | success                                              |
| 1    | upstream / network / config error                    |
| 2    | user input error (bad uuid, missing argument)        |
| 3    | not found (user / token id absent)                   |

Shell wrappers can rely on these exact codes.

## Design rationale

See [`design.md`](design.md).
