# chan-gateway

The self-hostable server side of chan's tunnel: the identity, profile, devserver-control, and devserver-proxy services that sit behind `gw.{domain}` and `proxy.{domain}`.

A fleet of `chan devserver` instances dials in over the tunnel and this gateway reverse-proxies each one back out at `{owner}--{disc}.{proxy}.proxy.{domain}/` (each workspace tenant mounted at `/{slug}-{8hex}/`), turning them into a portable, multi-device workspace service you run on your own infrastructure (your own "Google Drive / Docs" equivalent, with chan's editor on top).

`chan devserver run --tunnel-url` points at a gateway you stand up. `gw.chan.app` and `proxy.chan.app` are the maintainer's own deployment of this code, which is experimental, ships with sign-in off by default, and is not a hosted product. Nobody can authenticate until an operator enrols them.

## What's here

Seven crates; see [`design.md`](design.md) for the system design and lifecycles, [`CONTEXT.md`](CONTEXT.md) for the vocabulary.

- `profile`: internal HTTP API over Postgres. Users, OAuth identities, devserver grants, feature flags, durable user/fleet devserver policy, and auth audit.
- `identity`: `gw.{domain}`. OAuth2 sign-in with PKCE, indexed account sessions, personal access tokens, policy enforcement, and composite account/fleet admin operations.
- `devserver-control`: singleton, database-free control plane. Owns the dynamic proxy directory, signed-cap admission, aggregate tunnel and tenant-session inventory, and command routing.
- `devserver-control-proto`: control protocol frames, validated ids/origins, and shared tunnel/proxy view types.
- `devserver-proxy`: `{proxy}.proxy.{domain}`. Terminates each `chan devserver`'s yamux tunnel and reverse-proxies it back out at `{owner}--{disc}.{proxy}.proxy.{domain}/{slug}-{8hex}/*`, behind the always-on devserver-gate (an unauthenticated request 404s like an unknown workspace, so probes can't enumerate). Every registration is admitted by devserver-control before the client sees `HelloAck::Ok`.
- `admin`: operator CLI against profile's, identity's, and devserver-control's admin trees.
- `gateway-common`: shared library (HTTP clients, devserver-gate JWT, token bucket, static files, validators).

Personal access tokens (PATs, `chan_pat_...`) are the only credential the chan CLI / chan-tunnel side uses; they carry the `tunnel` scope. Adding another OAuth provider is one new file under `crates/identity/src/providers/` plus wiring in `Config::from_env`. Microsoft and Apple are intentionally excluded (Microsoft because tenant admins can mint unverified-email accounts that defeat our email-as-link key; Apple because the OAuth setup is high-touch for the value at this scale).

## Layout

identity's SPA (`@chan/profile`) and the shared chrome (`@chan/web-shared`) live in the `./web` npm workspace at the repo root, so `gw.{domain}` and the editor read as the same product: Svelte 5 + Vite + TypeScript, dark default with the same CSS variable palette.

## Dev

> macOS contributors: the recommended path runs Postgres inside a Lima VM via [sdme][sdme]; see [`docs/dev-setup.md`](docs/dev-setup.md) for the host-side aliases, container layout, and credentials. The rest of this section assumes a Postgres reachable on `127.0.0.1` either way.

[sdme]: https://github.com/fiorix/sdme

### Postgres

One database covers everything; `profile` owns users / identities / devservers / grants, `identity` owns the `tower_sessions` table. Neither service migrates on boot: migrations are a dedicated step (`CHAN_GATEWAY_MIGRATIONS=only`), and the runtime services boot with `CHAN_GATEWAY_MIGRATIONS=external`. The setup script below runs both for you.

```sh
createdb chan_gateway
createdb chan_gateway_test         # used by `cargo test`
```

### Frontend

identity's SPA is `@chan/profile`, a member of the `./web` npm workspace at the repo root (alongside `@chan/web-shared`, the shared theme CSS / fetch wrapper / topbar). Build it from there (or `make gateway-spa`):

```sh
cd web
npm install
npm run build -w @chan/profile
```

`vite build` writes to `gateway/crates/identity/web/dist/`, embedded by the identity binary via `rust-embed`. devserver-proxy ships no SPA.

### GitHub OAuth app

Register one at https://github.com/settings/developers:

- Homepage URL: `https://gw.localtest.me:17000`
- Authorization callback URL: `https://gw.localtest.me:17000/auth/github/callback`

Save the client id and secret.

### Run

Use the checked-in local-stack scripts from the repository root. They generate distinct scoped bearers and Ed25519 admission/entry keypairs, run identity once with `CHAN_GATEWAY_MIGRATIONS=only`, then start identity and profile with `CHAN_GATEWAY_MIGRATIONS=external`:

```sh
cp packaging/gateway/scripts/dev/env.example packaging/gateway/scripts/dev/.env
# Add the GitHub OAuth client id and secret to .env.
packaging/gateway/scripts/dev/setup.sh
packaging/gateway/scripts/dev/run.sh
```

Identity serves browser routes on `https://gw.localtest.me:17000` through the generated local TLS edge and exposes its separate internal proxy/operator listener on `127.0.0.1:17004`. Proxies use the internal listener for validation. Import `packaging/gateway/scripts/dev/secrets/tls/ca.crt` into the development browser. The setup script is idempotent; pass `--force` only when every generated credential and the local CA should rotate.

devserver-proxy holds no database and reads no identity session, and admits no tunnel until its control session to devserver-control reaches `FleetReady`. Opening a workspace submits a separate, short-lived Ed25519 entry credential to the fixed `/_chan/entry` endpoint in a bounded form POST from identity's exact origin. The credential never appears in a URL and succeeds once; the proxy exchanges it for opaque `__Host-devserver_gate` plus `__Host-devserver_csrf` host-only cookies. For the full local stack use `../packaging/gateway/scripts/dev/setup.sh` + `../packaging/gateway/scripts/dev/run.sh`.

For frontend iteration without re-embedding:

```sh
cd web && npm run dev -w @chan/profile   # :5173, proxies to :7000
```

## Tests

```sh
export DATABASE_URL=postgres://chan:chan@127.0.0.1/chan_gateway
export TEST_DATABASE_URL=postgres://chan:chan@127.0.0.1/chan_gateway_test
cargo test
```

Tests use real Postgres (per-test schema isolation). Identity tests mock the GitHub OAuth endpoints and profile-service via wiremock.

## Releases

The gateway ships on the monorepo's release line: the gateway crates are versioned in lockstep with the root (`chan`), and a `v*` tag triggers the repo-root `.github/workflows/release.yml`, whose `gateway-linux-packages` job builds five .deb packages (`chan-gateway-profile`, `chan-gateway-identity`, `chan-gateway-devserver-control`, `chan-gateway-devserver-proxy`, `chan-gateway-admin`) for amd64 and arm64 and uploads them alongside the rest of the release.

There is no gateway-local release script: bump `gateway/Cargo.toml` in the same commit as the root `Cargo.toml` version, then cut the release from the monorepo root. The release workflow's `context` job asserts the tag matches the gateway version.

To build .debs locally on macOS (one-off, before relying on CI):

```sh
brew install zig
rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
cargo install cargo-zigbuild cargo-deb
../packaging/gateway/scripts/build-debs.sh
ls dist/                                   # ten .deb files (5 packages x 2 archs)
```

### Install on a Debian/Ubuntu host

```sh
sudo apt install ./chan-gateway-profile_*.deb \
                 ./chan-gateway-identity_*.deb \
                 ./chan-gateway-devserver-control_*.deb \
                 ./chan-gateway-devserver-proxy_*.deb
```

Each package has a distinct system user and a service-only env file under `/etc/chan-gateway/`. Use the repository configurator to create scoped credentials and the owner-only migration environment, then run the migration unit before starting the runtime services:

```sh
sudo packaging/gateway/scripts/configure.sh
sudo systemctl restart chan-gateway-migrate
sudo systemctl enable --now chan-gateway-profile
sudo systemctl enable --now chan-gateway-identity
sudo systemctl enable --now chan-gateway-devserver-control
sudo systemctl enable --now chan-gateway-devserver-proxy
```

The binaries listen on loopback by default: identity public `7000`, identity internal proxy/operator `7004`, profile `7001`, control `7003`/`7101`, and proxy `7002`/`7100`. Front only identity `7000` and proxy `7002`/`7100` with TLS. Never publish identity `7004` or either control listener.

## Admin

`chan-gateway-admin` (`crates/admin/`) is the operator CLI for users, PATs, OAuth sessions, tenant sessions, durable devserver policy, auth history, fleet state, and live tunnels. It calls the independently scoped profile, identity, and devserver-control admin trees over protected internal HTTP.

### Setup

Each admin destination has its own credential; rotate them independently:

- profile-service:   `PROFILE_ADMIN_TOKEN=<random>`
- identity-service:  `IDENTITY_ADMIN_TOKEN=<random>`
- devserver-control: `DEVSERVER_OPERATOR_ADMIN_TOKENS=<random>`

Do not reuse one bearer across services. `chan-gateway-admin` reads the matching scoped variable for each destination:

```sh
export CHAN_ADMIN_PROFILE_TOKEN=<PROFILE_ADMIN_TOKEN>
export CHAN_ADMIN_IDENTITY_TOKEN=<IDENTITY_ADMIN_TOKEN>
export CHAN_ADMIN_OPERATOR_TOKEN=<one DEVSERVER_OPERATOR_ADMIN_TOKENS value>
export CHAN_ADMIN_PROFILE_URL=http://127.0.0.1:7001    # optional, default
export CHAN_ADMIN_IDENTITY_URL=http://127.0.0.1:7004   # optional, internal listener
export CHAN_ADMIN_WORKSPACE_URL=http://127.0.0.1:7003  # optional, default
```

Product account callers use `IDENTITY_SESSION_INTERNAL_TOKEN` only for OAuth-session `whoami` and `IDENTITY_ACCOUNT_ADMIN_TOKEN` only for access revoke, profile delete, and per-user devserver policy. They never receive `IDENTITY_INTERNAL_TOKEN` or `IDENTITY_ADMIN_TOKEN`.

Build / install:

```sh
cargo install --path crates/admin                 # local dev
# or use the .deb produced by ../packaging/gateway/scripts/build-debs.sh:
sudo apt install ./chan-gateway-admin_*.deb
```

### Recipes

```sh
# Block a user (revokes every live PAT, refuses fresh OAuth logins)
chan-gateway-admin user block alice@example.com --reason "spam reports"

# Reverse the block (existing tokens stay revoked; reissue if needed)
chan-gateway-admin user unblock alice@example.com

# Audit log for a user (login / logout / login_denied / blocked / ...)
chan-gateway-admin user audit alice@example.com

# Find a user (uuid, email substring, or exact username all work)
chan-gateway-admin user get alice

# List, with filters
chan-gateway-admin user list --blocked
chan-gateway-admin user list --email "@example.com"

# Personal access tokens
chan-gateway-admin token list alice@example.com
chan-gateway-admin token revoke <token-uuid>
chan-gateway-admin token audit  <token-uuid>

# Live tunnels (devserver-control's aggregate fleet view)
chan-gateway-admin tunnel ps
chan-gateway-admin tunnel ps --user alice
chan-gateway-admin tunnel kill alice <devserver-id>  # force one devserver offline; it may reconnect
chan-gateway-admin tunnel watch                    # SSE stream, top-style

# Durable user policy. Suspend preserves PAT rows and the stored limit.
chan-gateway-admin policy set alice --enabled --max-connected-devservers 3
chan-gateway-admin policy suspend alice
chan-gateway-admin policy resume alice

# OAuth and tenant-session inventory/revocation
chan-gateway-admin session oauth ps --user alice
chan-gateway-admin session tenant ps --owner alice
chan-gateway-admin session tenant revoke <admin-session-uuid>

# Persistent fleet incident control
chan-gateway-admin fleet pause --drain
chan-gateway-admin fleet status
chan-gateway-admin fleet resume

# Bounded cross-service aggregate view and global auth history
chan-gateway-admin overview --since 24h
chan-gateway-admin audit ps --user alice --action login

# Feature flags. Fresh deploys ship oauth_login=off and
# share_workspaces=off so nobody can sign in until you enrol them.
chan-gateway-admin flag list
chan-gateway-admin flag grant oauth_login  alice@example.com
chan-gateway-admin flag grant share_workspaces alice@example.com
chan-gateway-admin flag overrides oauth_login         # who has access
chan-gateway-admin flag revoke share_workspaces alice@example.com
chan-gateway-admin flag create my_feature --default-on --description "..."
```

Add `--json` to any subcommand for jq-friendly output.

The two seeded flags govern the rollout posture. `oauth_login` gates the OAuth callback; an account without the override is denied at sign-in with `?denied=oauth_login` in the redirect. `share_workspaces` is the SPA-side toggle for the devserver sharing UI; flipping it off hides the Devservers tab. Neither flag is enforced inside profile; only `oauth_login` is enforced server-side, by identity. Both default to off so a fresh deploy has to grant the first user out-of-band (or pre-create users via `chan-gateway-admin user create` and then `flag grant`).

The user account survives a block; deletion is via the SPA's "Delete account" disclosure (account holder only). Account delete also evicts every live tunnel for that user.

## Troubleshooting

- `pool timed out while waiting for an open connection` even though TCP works: Postgres likely ran out of non-superuser connection slots (`FATAL: remaining connection slots are reserved for roles with the SUPERUSER attribute`). Restart it (`sudo systemctl restart postgresql`) and re-run. We cap each service at 4 connections, but leftover pools from prior runs + test crashes can pile up.
- `Access to localhost was denied` / 403 on macOS port 7000: AirPlay Receiver claims that port. Disable it in System Settings -> General -> AirDrop & Handoff, or change `BIND_ADDR` / `BASE_URL` to a different port (and re-register the OAuth callback URL).

## License

Apache-2.0. See [LICENSE](LICENSE).
