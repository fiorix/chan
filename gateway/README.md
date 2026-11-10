# chan-gateway

The self-hosted server side of chan's tunnel: the identity, profile, devserver-control and devserver-proxy services that sit behind `gw.{domain}` and `proxy.{domain}`, plus the operator CLI.

A `chan devserver` dials out to a gateway with a personal access token, and the gateway publishes it at `{owner}--{disc}.{proxy}.proxy.{domain}/` behind sign-in (each workspace tenant mounted at `/{slug}-{8hex}/`), to the owner and to the accounts the owner shares it with, from any browser or desktop. The devserver machine needs no inbound port, no DNS and no TLS of its own.

`chan devserver run --tunnel-url` points at a gateway you stand up. `gw.chan.app` and `proxy.chan.app` are the maintainer's own deployment of this code: experimental, sign-in off by default, not a hosted product. Nobody can authenticate on a fresh deployment until an operator enrols them.

## What's here

Eight crates in a nested Cargo workspace; see [`design.md`](design.md) for the system design and lifecycles and [`CONTEXT.md`](CONTEXT.md) for the vocabulary.

- `profile`: internal HTTP API over Postgres. Users, OAuth identities, devserver grants, feature flags, durable user and fleet devserver policy, and auth audit.
- `identity`: `gw.{domain}`. OAuth2 sign-in with PKCE, indexed account sessions, personal access tokens, policy enforcement, the desktop API, and composite account and fleet admin operations.
- `devserver-control`: singleton, database-free control plane. Owns the dynamic proxy directory, signed-lease admission, the aggregate tunnel and tenant-session inventory, and command routing.
- `devserver-control-proto`: control protocol frames, validated ids and origins, and the shared tunnel and proxy view types.
- `devserver-proxy`: `{proxy}.proxy.{domain}`. Terminates each `chan devserver`'s yamux tunnel and reverse-proxies it back out at `{owner}--{disc}.{proxy}.proxy.{domain}/{slug}-{8hex}/*`, behind the always-on devserver gate (an unauthenticated request looks like an unknown workspace, so probes cannot enumerate). Every registration is admitted by devserver-control before the client sees `HelloAck::Ok`.
- `wireguard-agent`: runs on each proxy node that offers a WireGuard ingress and keeps the peers of the node's kernel WireGuard interface equal to the gateway's active peers, through `wg`.
- `admin`: operator CLI against profile's, identity's and devserver-control's admin trees.
- `gateway-common`: shared library (HTTP clients, the entry credential, the token bucket, static files, validators, internal-transport checks).

Personal access tokens (PATs, `chan_pat_...`) are the only credential the chan CLI and the tunnel side use; they carry the `tunnel` scope. Adding another OAuth provider is one new file under `crates/identity/src/providers/` plus wiring in `Config::from_env`. Microsoft and Apple are deliberately excluded: Microsoft because tenant admins can mint unverified-email accounts that defeat email-as-link-key, Apple because the OAuth setup is high-touch for the value at this scale.

## Layout

identity's SPA (`@chan/profile`) and the shared chrome (`@chan/web-shared`) live in the `./web` npm workspace at the repo root, so `gw.{domain}` and the workspace app read as the same product: Svelte 5, Vite, TypeScript, the same CSS variable palette.

## Dev

> macOS contributors: the recommended path runs Postgres inside a Lima VM via [sdme][sdme]; see [`docs/dev-setup.md`](docs/dev-setup.md) for the host-side aliases, container layout and credentials. The rest of this section assumes a Postgres reachable on `127.0.0.1` either way.

[sdme]: https://github.com/fiorix/sdme

### Postgres

One database covers everything; `profile` owns users, identities, devservers and grants, `identity` owns the `tower_sessions` table. Neither service migrates on boot: migrations are a dedicated step (`CHAN_GATEWAY_MIGRATIONS=only`) and the runtime services boot with `CHAN_GATEWAY_MIGRATIONS=external`. The setup script below runs both for you.

```sh
createdb chan_gateway
createdb chan_gateway_test         # used by `cargo test`
```

The gateway database must run a UTF-8 locale (for example `createdb --template=template0 --locale=C.UTF-8`): profile folds emails with PostgreSQL `lower()`, which folds only ASCII under a `C` or `POSIX` ctype.

### Frontend

identity's SPA is `@chan/profile`, a member of the `./web` npm workspace at the repo root. Build it from there (or `make gateway-spa`):

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

Use the checked-in local-stack scripts from the repository root. They generate distinct scoped bearers and Ed25519 admission and entry keypairs, run identity once with `CHAN_GATEWAY_MIGRATIONS=only`, then start every service with `CHAN_GATEWAY_MIGRATIONS=external`:

```sh
cp packaging/gateway/scripts/dev/env.example packaging/gateway/scripts/dev/.env
# Add the GitHub OAuth client id and secret to .env.
packaging/gateway/scripts/dev/setup.sh
packaging/gateway/scripts/dev/run.sh
```

Identity serves browser routes on `https://gw.localtest.me:17000` through the generated local TLS edge and exposes its separate internal listener on `127.0.0.1:17004`; proxies use the internal listener for validation. Import `packaging/gateway/scripts/dev/secrets/tls/ca.crt` into the development browser. The setup script is idempotent; pass `--force` only when every generated credential and the local CA should rotate. The dev port layout is in [`packaging/gateway/scripts/dev/README.md`](../packaging/gateway/scripts/dev/README.md).

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

Tests use real Postgres with per-test schema isolation. Identity tests mock the GitHub OAuth endpoints and profile-service via wiremock.

Three packaging suites run outside cargo, from the repository root, and Gateway CI runs all three on every run. `python3 packaging/kube/test-manifests.py` checks the Kubernetes manifests against the packaged scripts, including the database-roles ConfigMap's embedded copies of the prepare and reconcile scripts, and needs PyYAML. `make gateway-packaging-isolation-test` runs the gateway postinsts in all 120 orders of the account-plane packages, the WireGuard agent's at every position, `configure.sh`'s refusals and whole runs of it against a scratch root, and the sdme provisioner refusals; it is Linux-only and needs only make, bash, git, openssl and python3.

The third, `packaging/gateway/scripts/test-database-roles.sh`, runs the database role scripts against a real server and rewrites the cluster-wide `chan_gateway_identity` and `chan_gateway_profile` roles, so it never runs against a shared PostgreSQL. Its only local route is `make gateway-database-roles-test`: it boots the `chan-psql` rootfs (`packaging/gateway/scripts/dev/sdme/chan-psql.sdme`, built on first use) in a disposable sdme guest with a private network, runs the suite inside it against the working tree's scripts and migrations, and removes the guest. PostgreSQL is not installed on the host for this. Gateway CI runs the suite against a `postgres:16` service container, the major the Kubernetes manifests deploy.

## Releases

The gateway ships on the monorepo's release line: the gateway crates are versioned in lockstep with the root (`chan`), and a `v*` tag triggers the repo-root `.github/workflows/release.yml`, whose `gateway-linux-packages` job builds six .deb packages (`chan-gateway-profile`, `chan-gateway-identity`, `chan-gateway-devserver-control`, `chan-gateway-devserver-proxy`, `chan-gateway-admin`, `chan-gateway-wireguard-agent`) for amd64 and arm64 and uploads them alongside the rest of the release.

There is no gateway-local release script: bump `gateway/Cargo.toml` in the same commit as the root `Cargo.toml` version, then cut the release from the monorepo root. The release workflow's `context` job asserts the tag matches the gateway version.

To build .debs locally on macOS:

```sh
brew install zig
rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
cargo install cargo-zigbuild cargo-deb
../packaging/gateway/scripts/build-debs.sh
ls dist/                                   # twelve .deb files (6 packages x 2 archs)
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

`configure.sh` asks for the database owner, the public origins, this node's id, the WireGuard ingresses ([WireGuard ingress](#wireguard-ingress) below; Enter leaves enrollment off) and the OAuth credentials, generates every other secret, and writes each env file whole. A bad answer stops it with an error before it prepares database roles or writes a file. Every run asks every question again, generates new bearers, database role passwords and signing keys, and replaces each file, keeping the one it replaces beside it as `<file>.bak.<stamp>` (mode 0600, root). It carries nothing over, so a hand edit survives only in the backup: on a gateway that is already running, edit the env files instead of running it again.

The database role policy is version 2 at schema migration 18. Identity can lock the user and fleet-policy rows during PAT minting and can update only their `updated_at` columns; it cannot change account state or admission policy. For an existing deployment, set `DATABASE_ROLE_POLICY_VERSION=2` and `EXPECTED_SQLX_MIGRATION=18` in `migrate.env`, `identity.env` and `profile.env` before installing the new packages, because the postinst scripts require those exact lines and reject any other migration marker and policy version 1 (a v0.124.0 deployment carries migration 16 and policy 1; v0.125.0, v0.126.0 and v0.127.0 carry migration 17 and policy 2); after installation, restart `chan-gateway-migrate` before restarting identity and profile. The migration unit prepares the roles, runs pending schema migrations, and reapplies the exact grants before publishing the ready marker. Restart the migration unit even when no schema migration is pending; its completed oneshot state does not rerun reconciliation by itself.

Migration 18 keeps one WireGuard peer per public key, with one address set unique across the gateway, and drops the peer table's `host` column. Where a database holds one key or one address enrolled on two ingress hosts, it deletes the earlier enrollment of each pair, and that desktop enrolls again at its next sign-in. Each enrollment it deletes gets a `wireguard_released` row in its token's audit, with the migration's `installed_on` time as the row's `ts`.

A profile still running from a release that carries migration 17 names the dropped column in every WireGuard statement: on the migrated schema its enrollment and peer-list routes answer 500 and its sweeper releases no address. Where identity and profile are upgraded apart, on separate hosts or in a rolling update, upgrade profile with the migration, before or together with identity. Until profile runs this release, a sign-in that enrolls a key fails with `wireguard_enroll_failed` and every agent keeps the peer list it last read, so a revoke does not reach the interfaces.

A deployment that enrolls WireGuard peers also rewrites identity's enrollment variables when it sets the migration marker in `identity.env`. Identity does not start while `WIREGUARD_HOST_ID`, `WIREGUARD_ENDPOINT`, `WIREGUARD_PUBLIC_KEY` or `WIREGUARD_HOSTS` holds a value, and its one message names every one that is set. The one ingress they describe becomes one entry of the list, `WIREGUARD_INGRESSES=<node id>=<WIREGUARD_PUBLIC_KEY>@<WIREGUARD_ENDPOINT>`. The id is that node's `DEVSERVER_PROXY_ID`, whatever `WIREGUARD_HOST_ID` was: identity builds the names the ingress carries from it, and the node's `WIREGUARD_AGENT_HOST_ID` must equal it. The address `WIREGUARD_HOSTS` mapped its names to becomes `WIREGUARD_INGRESS_ADDRESSES`, `WIREGUARD_ALLOWED_IPS` and `WIREGUARD_PERSISTENT_KEEPALIVE` keep their values, and the four old lines go. To turn enrollment off instead, remove or comment out `WIREGUARD_ALLOWED_IPS` and `WIREGUARD_PERSISTENT_KEEPALIVE` with the four: either one left set is a partial set, which stops startup too. `configure.sh` converts nothing: run over such a file, it shows the four lines and asks for the list. [WireGuard ingress](#wireguard-ingress) below has the rest. With the list set, identity answers 404 to an agent whose `WIREGUARD_AGENT_HOST_ID` is not an id in it, and that agent keeps the peers it has and applies no later enrollment or revoke; with enrollment off, identity relays the peer list to every agent, so revokes keep reaching the nodes.

The binaries listen on loopback by default: identity public `7000`, identity internal `7004`, profile `7001`, control `7003`/`7101`, and proxy `7002`/`7100`. Front only identity `7000` and proxy `7002`/`7100` with TLS. Never publish identity `7004` or either control listener.

Kubernetes and sdme deployment is in [`packaging/kube/README.md`](../packaging/kube/README.md).

### WireGuard ingress

A gateway can enroll a desktop's WireGuard key at sign-in, so that the desktop reaches the proxy nodes through WireGuard. It is optional, and it has three parts: each proxy node that offers it terminates WireGuard in a kernel interface of its own and runs the WireGuard agent, identity lists those nodes, and profile allocates each enrolled key's addresses. The design is in [`design.md`](design.md#wireguard-ingress).

1. **On each node, bring up the interface** ([`crates/wireguard-agent/README.md`](crates/wireguard-agent/README.md#bring-up-the-interface-first) shows the commands). Each node has its own private key and a UDP listen port that desktops can reach. Every node gives its interface the same tunnel address, `10.7.0.1` below, and the node's TLS edge must answer on it for the node's names, as it does on the node's public address.
2. **In `profile.env`, set the pool**, for example `WIREGUARD_POOL_V4=10.7.0.0/24`. An enrolled key gets one address set from it for the whole gateway, so the pool bounds the gateway's enrolled keys, not one node's. The shared tunnel address must stay outside allocation: profile never allocates a pool's network address or its first host address, which is why `10.7.0.1` fits here, and any other address goes in `WIREGUARD_POOL_RESERVED`. Neither service checks this, since identity cannot read profile's pool.
3. **In `identity.env`, list the ingresses.** `WIREGUARD_INGRESSES` holds one `id=public_key@endpoint` entry per node, with `;` between entries. `WIREGUARD_INGRESS_ADDRESSES` holds the tunnel addresses, at most one IPv4 and one IPv6, comma-separated. `WIREGUARD_ALLOWED_IPS` holds the comma-separated CIDRs a desktop routes through a tunnel, which must contain those addresses. The three are required together, and identity does not start with only some of them:

   ```sh
   WIREGUARD_INGRESSES=p1=<p1 public key>@p1.proxy.example.com:51820;p2=<p2 public key>@p2.proxy.example.com:51820
   WIREGUARD_INGRESS_ADDRESSES=10.7.0.1
   WIREGUARD_ALLOWED_IPS=10.7.0.1/32
   ```

   An entry's `id` is that node's `DEVSERVER_PROXY_ID`, its key is what `wg show <interface> public-key` prints on the node, and its endpoint is the `host:port` where desktops reach the interface, an IPv6 address in brackets. The value is written bare in `identity.env`, which systemd reads to the end of the line; in a shell `export`, or a file a shell sources, it goes in single quotes, because a shell ends an assignment at the first `;`. identity derives the names each ingress carries, `{id}.{proxy host}` and `*.{id}.{proxy host}` under the host of `DEVSERVER_PROXY_ORIGIN`, so there is no host map to write. The first entry is the one ingress chan-desktop uses: it enrolls there and reaches every other node outside the tunnel, on the public path. `WIREGUARD_PERSISTENT_KEEPALIVE` is optional, in seconds, 25 by default and `0` for none; set without the three, it stops startup as a partial set does. [`crates/identity/README.md`](crates/identity/README.md#wireguard-enrollment) has the whole grammar and what identity refuses.
4. **On each node, install and start the agent.** The package depends on `wireguard-tools` and listens on nothing. Install it, fill `/etc/chan-gateway/wireguard-agent.env`, then start it:

   ```sh
   sudo apt install ./chan-gateway-wireguard-agent_*.deb
   sudo systemctl enable --now chan-gateway-wireguard-agent
   ```

   In the env file, `IDENTITY_URL` is identity's internal listener, `WIREGUARD_AGENT_TOKEN` is identity's value, the same on every node, `WIREGUARD_AGENT_HOST_ID` is the node's `DEVSERVER_PROXY_ID`, which must be one of the ids in identity's list, and `WIREGUARD_INTERFACE` names the interface. `configure.sh` generates the bearer into `identity.env`, and on a host that has the agent package installed it asks for the interface name and writes this file as well, with the node id it was given as the host id.

`configure.sh` asks for steps 2 and 3 and writes both files in one run. Before the OAuth questions it prints this node's entry with the key left to fill in and asks `WireGuard ingresses (empty to leave enrollment off): `; the answer is the whole list in the grammar above, and spaces around an id, a key or an endpoint are dropped. Only after a list it asks `WireGuard address pool [10.7.0.0/24]: `. It does not ask for the tunnel address: it takes the pool's first host address, `10.7.0.1` for the default pool, writes it as `WIREGUARD_INGRESS_ADDRESSES` and as a /32 in `WIREGUARD_ALLOWED_IPS`, and ends by printing the `Address = 10.7.0.1/24` each node's interface carries. It checks both answers by the rules identity and profile apply at startup and stops with `error: ...` before it prepares database roles or writes a file. It is stricter than they are about a port of more than five digits, whitespace outside ASCII, and a pool with host bits set or narrower than /30.

With an empty answer it writes the three identity values and the pool as commented examples. It asks for no IPv6: an IPv6 pool is a hand edit afterwards, `WIREGUARD_POOL_V6` in `profile.env` with the IPv6 tunnel address and its /128 added to `WIREGUARD_INGRESS_ADDRESSES` and `WIREGUARD_ALLOWED_IPS` in `identity.env`. A later run asks both questions again and keeps neither answer: over files that have enrollment on it first shows the list and the pool they set, and an empty answer then turns enrollment off. When the list lacks the node the script runs on and the agent's package is installed there, it says at the end that identity answers that agent 404.

Restart profile and identity after editing their files; both read them at start. Every agent reads the same list of active peers, so an enrolled key works on every node, and revoking its PAT, the PAT's expiry or a block of its user removes it from every node, each at its agent's next poll (five seconds by default). Adding a node later is steps 1 and 4 on that node and one more entry in `WIREGUARD_INGRESSES`, with an identity restart; profile does not change. Taking a node out is its entry removed, its agent stopped and its interface taken down: an agent left running there is answered 404 and keeps every peer it has, revoked ones included. Both ends log that at warn: identity names the host id it refuses, and the agent says that it keeps its last list. The decision and its costs are in [ADR 0004](docs/adr/0004-one-wireguard-ingress-per-proxy-node.md).

## Admin

`chan-gateway-admin` (`crates/admin/`) is the operator CLI for users, PATs, OAuth sessions, tenant sessions, durable devserver policy, auth history, fleet state and live tunnels. It calls the independently scoped profile, identity and devserver-control admin trees over protected internal HTTP.

### Setup

Each admin destination has its own credential; rotate them independently:

- profile-service: `PROFILE_ADMIN_TOKEN=<random>`
- identity-service: `IDENTITY_ADMIN_TOKEN=<random>`
- devserver-control: `DEVSERVER_OPERATOR_ADMIN_TOKENS=<random>`

Do not reuse one bearer across services. `configure.sh` writes all three URLs and their scoped credentials to the root-only `/etc/chan-gateway/admin.env`. As root, load that file before running the admin CLI:

```sh
set -a
. /etc/chan-gateway/admin.env
set +a
```

For other layouts, export the matching scoped variables and point each URL at its internal service address:

```sh
export CHAN_ADMIN_PROFILE_TOKEN=<PROFILE_ADMIN_TOKEN>
export CHAN_ADMIN_IDENTITY_TOKEN=<IDENTITY_ADMIN_TOKEN>
export CHAN_ADMIN_OPERATOR_TOKEN=<one DEVSERVER_OPERATOR_ADMIN_TOKENS value>
export CHAN_ADMIN_PROFILE_URL=http://127.0.0.1:7001    # optional, default
export CHAN_ADMIN_IDENTITY_URL=http://127.0.0.1:7004   # packaged default, internal listener
export CHAN_ADMIN_WORKSPACE_URL=http://127.0.0.1:7003  # optional, default
```

Product account callers use `IDENTITY_SESSION_INTERNAL_TOKEN` only for OAuth-session `whoami` and `IDENTITY_ACCOUNT_ADMIN_TOKEN` only for access revoke, profile delete and per-user devserver policy. They never receive `IDENTITY_INTERNAL_TOKEN` or `IDENTITY_ADMIN_TOKEN`.

Build or install:

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

The two seeded flags govern the rollout posture. `oauth_login` gates the OAuth callback; an account without the override is denied at sign-in. `share_workspaces` is the SPA-side toggle for the devserver sharing UI; flipping it off hides the Devservers tab. Only `oauth_login` is enforced server-side, by identity; neither flag is enforced inside profile. Both default to off, so a fresh deploy has to grant the first user out-of-band (or pre-create users via `chan-gateway-admin user create` and then `flag grant`).

The user account survives a block; deletion is via the SPA's "Delete account" disclosure (account holder only) or `chan-gateway-admin user delete`. Account delete also evicts every live tunnel for that user.

## Troubleshooting

- `pool timed out while waiting for an open connection` even though TCP works: Postgres likely ran out of non-superuser connection slots (`FATAL: remaining connection slots are reserved for roles with the SUPERUSER attribute`). Restart it (`sudo systemctl restart postgresql`) and re-run. Each service caps its pool at four connections, but leftover pools from prior runs plus test crashes can pile up.
- `Access to localhost was denied` or 403 on macOS port 7000: AirPlay Receiver claims that port. Disable it in System Settings, General, AirDrop & Handoff, or change `BIND_ADDR` and `BASE_URL` to a different port (and re-register the OAuth callback URL).

## License

Apache-2.0. See [LICENSE](LICENSE).
