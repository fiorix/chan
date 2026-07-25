# Gateway setup: local, mirroring production

The gateway can run as a set of `sdme` containers, but a private bridge alone is not a trusted transport. This guide describes the production-shaped layout for hosts that also provide an authenticated, encrypted service overlay.

It mirrors the production definitions in the sibling `chan-prod-setup` repo. Per "show the pattern, copy little", it walks ONE worked service container end to end and points at `chan-prod-setup` for the rest, rather than duplicating every prod config here.

> A faster inner loop exists for rapid iteration: `packaging/gateway/scripts/dev/run.sh` runs the services as host `cargo run` binaries over `*.localtest.me` (see [`packaging/gateway/scripts/dev/README.md`](../../packaging/gateway/scripts/dev/README.md)). That is handy while editing code, but it is NOT the prod-like shape. This guide is the all-container stack.

> **Load-bearing transport requirement:** an ordinary sdme `--network-zone` supplies network-namespace/L2 isolation, not authenticated encryption. It is therefore not sufficient grounds for `CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay`; never set that value just to make a cleartext non-loopback bind pass validation. The all-container commands below assume WireGuard, mTLS, or an equivalent authenticated and encrypted overlay is already in place. Without one, use the checked-in local runner: it keeps every cleartext Rust listener on literal loopback and puts verified TLS edges in the same host namespace.

## Why the all-container, prod-like stack

The gateway's cross-tenant isolation is carried by two host-scoped cookies: `__Host-id_session` (host-only on `id.<domain>`) and `__Host-devserver_gate` (host-only on `{user}.devserver.<domain>`, scoped `Path=/` for the whole devserver). No `.<domain>`-wide cookie exists, so a browser never auto-attaches an identity session to a fetch on another tenant's subdomain. The whole-host devserver cookie is safe because the grant is whole-devserver; user-to-user isolation rides the host-only cookie plus the `aud` claim. That design, plus the reverse-proxy header hygiene (hop-by-hop stripping, dropped inbound Host/Cookie/Authorization, recomputed `X-Forwarded-*`), only fully exercises behind a real TLS terminator with real subdomains. Running the same containers and the same nginx as prod is how you exercise it.

## Topology

```mermaid
flowchart TD
    browser["browser (https)"]
    lima["127.0.0.1:443 (Lima forwards the VM :443 to the macOS host)"]
    browser --> lima

    subgraph zone["chan-svc authenticated + encrypted service overlay"]
        nginx["chan-nginx: TLS terminator (the only published container, :80 / :443)"]
        chanid["chan-id :7000"]
        profile["chan-profile :7001"]
        control["chan-devserver-control :7003 + :7101"]
        proxy["chan-devserver-proxy :7002 + :7100"]
        psql["chan-psql :5432 (also published :5432 for host cargo test)"]
    end

    lima --> nginx
    nginx -->|"id.localtest.me"| chanid
    nginx -->|"devserver.localtest.me apex (healthz)"| proxy
    nginx -->|"/v1/tunnel (h2c, grpc_pass) -> :7100"| proxy
    nginx -->|"*.devserver.localtest.me (tenant + WS upgrade)"| proxy

    chanid -->|"PROFILE_SERVICE_URL"| profile
    chanid -->|"DEVSERVER_ADMIN_URL"| control
    profile -->|"DEVSERVER_ADMIN_URL"| control
    proxy -->|"DEVSERVER_CONTROL_URL (h2c control session)"| control
    proxy -->|"IDENTITY_URL"| chanid
    profile -->|"DATABASE_URL"| psql
```

chan-nginx terminates TLS at the overlay edge and fans the routes out across the `chan-svc` containers; this is the one route map for the stack (the nginx section below mirrors it). The tunnel vhost must negotiate h2 externally before forwarding h2c to `:7100`; browser/public vhosts terminate ordinary HTTP. nginx never routes the devserver-control ports: :7003 (the aggregate admin tree) and :7101 (the h2c proxy-control listener) are overlay-internal only.

Services bind their default ports (`7000/7001/7002/7100/7003/7101`) INSIDE their containers and resolve each other by overlay identity (for example identity reads `chan-profile:7001`). Every cleartext non-loopback service must set `CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay`, and that assertion is valid only after the encrypted overlay exists. Nothing binds on the macOS host except what Lima forwards (nginx `:443`, and Postgres `:5432` for host-run tests).

## Prerequisites: sdme

Install sdme. On Linux, on the host:

```sh
curl -fsSL https://sdme.io/install.sh | sudo sh
```

On macOS, sdme runs inside a Lima VM; install Lima and then sdme inside the VM, per [macOS only: Lima shim](#macos-only-lima-shim). Either way the `sdme ...` commands below then work (on macOS through the alias). The examples use the explicit `limactl shell default sudo sdme ...` form; drop that prefix on Linux.

## Build the gateway .deb packages

The service containers install the gateway `.deb`s, the same way prod does, so build them first (once per source change) in the gateway-build container:

```sh
make linux-gateway     # root Makefile -> build-gateway.sh, uses gateway-build.sdme
```

`gateway-build.sdme` (in `packaging/gateway/scripts/dev/sdme/`) bakes the Rust toolchain, node/npm, and cargo-deb; no Postgres is needed at build time. The five packages (identity, profile, devserver-control, devserver-proxy, admin) land in the build's `dist/` staging dir, where the service containers pick them up.

## Postgres: chan-psql on the zone

Build and start the Postgres container on the `chan-svc` zone. The build file is a sanitized dev copy of the prod one (no host bind-mount, a throwaway `chan` superuser with password `chan`, both `chan_gateway` and `chan_gateway_test` seeded on first boot).

```sh
cd packaging/gateway/scripts/dev/sdme
limactl shell default sudo sdme fs build chan-psql-dev chan-psql.sdme
limactl shell default sudo sdme create --name chan-psql -r chan-psql-dev \
    --network-zone chan-svc -p 5432:5432
limactl shell default sudo sdme start chan-psql
```

Services reach it as `chan-psql:5432` on the zone; the published `:5432` (via Lima host networking) lets host-side `cargo test` use `127.0.0.1:5432`. The dev `create` drops prod's `--hardened` and secret bind (the dev rootfs self-seeds); `--network-zone chan-svc` is what puts it on the zone.

## The service containers

Each gateway service is its own container built from a tiny `.sdme` file that installs the matching `.deb` and enables its systemd unit. The prod files live in `chan-prod-setup/services/` (`chan-id.sdme`, `chan-profile.sdme`, `chan-devserver-control.sdme`, `chan-devserver-proxy.sdme`). Do not copy the old cleartext `*.localtest.me` example: public DNS origins are required to use TLS, even when they resolve into `127/8`. For a local stack, use the checked-in `packaging/gateway/scripts/dev/{setup,run}.sh` runner, which creates a local CA and keeps every cleartext Rust listener on a literal loopback address. A container topology must instead terminate TLS at the public edge and carry service-to-service cleartext only on an authenticated, encrypted overlay.

Use the checked-in env templates for the exact service contract: control has separate operator/identity/profile admin rings, a per-proxy credential map, and `DEVSERVER_ADMISSION_VERIFYING_KEYS`; proxy points `IDENTITY_URL` at identity's internal listener (`http://chan-id:7004`) and receives only its own controller bearer plus the entry-verifier ring. The database owner credential belongs only to the migration unit; identity and profile run with distinct app-role URLs and `CHAN_GATEWAY_MIGRATIONS=external`. See `chan-prod-setup/services/` for the prod topology, but reconcile its secrets against these templates before deployment.

## nginx container + TLS

nginx is its own container (`chan-nginx`), the TLS terminator and the only one that publishes ports. Mirror `chan-prod-setup/services/chan-nginx.sdme` and `chan-prod-setup/etc/nginx/`; the routes are the ones in [Topology](#topology) above (`id.<domain>` -> chan-id:7000 with `proxy_pass`, the `devserver.<domain>` apex + `*.devserver.<domain>` -> chan-devserver-proxy:7002, and `/v1/tunnel` -> chan-devserver-proxy:7100 with `grpc_pass` h2c).

The one dev difference is the certificate. Prod uses certbot with the dns-01 Cloudflare plugin to get a real `*.devserver.<domain>` wildcard (http-01 cannot issue wildcards). Locally, issue a local-CA wildcard with [`mkcert`](https://github.com/FiloSottile/mkcert) and mount it into the nginx container in place of `/etc/letsencrypt`:

```sh
mkcert -install
mkcert "*.localtest.me" "*.devserver.localtest.me" localtest.me
```

Create chan-nginx on the zone, publishing `:443`, with the mkcert cert and your `:443` vhosts bind-mounted in:

```sh
limactl shell default sudo sdme create --name chan-nginx -r chan-nginx-dev \
    --network-zone chan-svc -p 443:443 \
    --bind <mkcert-dir>:/etc/nginx/certs:ro
limactl shell default sudo sdme start chan-nginx
```

## Reach it from the browser (macOS)

`*.localtest.me` resolves to `127.0.0.1` for every subdomain via public DNS, so no `/etc/hosts` or dnsmasq is needed. Lima host networking exposes the chan-nginx `:443` on the macOS `localhost`, so the browser path is: `https://id.localtest.me` -> `127.0.0.1:443` (Lima) -> chan-nginx -> `chan-id:7000` on the zone. No `limactl` port-forward is needed: Lima host networking surfaces the published `:443` on the macOS `localhost` directly, the same way it does Postgres `:5432`.

Sign in at `https://id.localtest.me`. Both feature flags ship default-off, so enrol yourself after the first sign-in (run the admin CLI inside the profile container, or against the published profile port):

```sh
limactl shell default sudo sdme exec chan-profile -- \
    chan-gateway-admin flag grant oauth_login      <your-email>
limactl shell default sudo sdme exec chan-profile -- \
    chan-gateway-admin flag grant share_workspaces <your-email>
```

Register a test workspace from the sibling `chan` repo over the TLS apex:

```sh
export CHAN_TUNNEL_TOKEN=chan_pat_...     # mint under the dashboard Tokens tab
cargo run -p chan -- serve <workspace-dir> \
  --tunnel-url=https://devserver.localtest.me/v1/tunnel \
  --tunnel-workspace-name=blog
```

Clicking Open on the dashboard lands on `https://<user>.devserver.localtest.me/blog/`.

## From local to a real VPS

Because the local stack already IS the prod container shape, going to a real host changes only what is environment-specific, exactly as `chan-prod-setup` automates (`configure.sh` then `make all`):

- **DNS.** Real records for `id.<domain>`, the `devserver.<domain>` apex, and a wildcard `*.devserver.<domain>` pointed at the host; inbound `:80/:443` DNAT to chan-nginx in the zone.
- **Certificates.** Swap mkcert for certbot with your provider's dns-01 plugin to get the real `*.devserver.<domain>` wildcard (the wildcard forces dns-01; any DNS provider with a certbot plugin works).
- **Secrets.** Real per-service secrets bind-mounted from `/var/lib/chan/secrets` instead of the inlined dev values; `COOKIE_SECURE=true`.

The containers, the zone, the nginx routes, and the cookie isolation are identical to what you ran locally.

## macOS only: Lima shim

On macOS, sdme runs inside a Lima VM because it needs systemd. Lima uses host networking, so container ports show up on macOS `localhost` exactly as on a native Linux host. macOS `$HOME` is bind-mounted into the VM read-only via virtiofs: edit and build on macOS, sdme sees the result.

```sh
brew install lima
limactl start default        # Ubuntu, host networking
# install sdme inside the VM:
limactl shell default -- sh -c \
    'curl -fsSL https://sdme.io/install.sh | sudo sh'
alias sdme='limactl shell default sudo sdme'   # then every sdme example runs verbatim
```

The bare `limactl shell default sudo sdme ...` form works too (useful for scripts and agents, where the interactive alias does not resolve).

## Running tests

```sh
cd gateway
export TEST_DATABASE_URL=postgres://chan:chan@127.0.0.1:5432/chan_gateway_test
(cd ../web && npm ci && npm run build -w @chan/profile)   # gateway identity SPA (rust-embed input)
cargo test                             # profile + identity need the DB
```

`devserver-proxy` and all `cargo test --lib` unit tests need no database; only `profile` and `identity` integration tests do. Per-test schema isolation means a `cargo test` run never clobbers the `chan_gateway` DB a running stack uses. CI (`gateway-ci.yml`) runs the same gate with a `postgres:16` service on `ubuntu-latest` (x86_64), the canonical lane; local sdme is the fast loop.

### Connection reaper (test infra)

A flaky `cargo test` can panic mid-test and orphan sqlx pool connections; the role goes idle holding slots and the next run hits `PoolTimedOut`. `tests-shared/pg_reaper.rs` (wired into every DB-backed `TestApp::new()`) opens one durable connection and `pg_terminate_backend()`s its own role's idle peers on first use, then holds that connection so the role never falls fully idle. It recovers the realistic case automatically. The one case it cannot is **full exhaustion** (all non-superuser slots pinned): it panics pointing here. Reap manually as the postgres superuser:

```sh
limactl shell default sudo sdme exec chan-psql -- /bin/bash -c \
    "runuser -u postgres -- /usr/bin/psql -c \
        \"SELECT pg_terminate_backend(pid) \
            FROM pg_stat_activity WHERE usename='chan';\""
```

Safe whenever no live stack is connected to `chan_gateway`.

## sdme cheatsheet

- **Full container name**: pass the name you created (`chan-id`, `chan-psql`, ...). sdme also accepts an unambiguous prefix, but the full name keeps the examples copy-pasteable.
- **Full paths after `--`**: `machinectl shell` sets no `PATH`. Use `/usr/bin/psql`, `/usr/bin/runuser`, `/usr/bin/systemctl`.
- **Interactive shell**: `sdme join chan-id` drops you into a real shell inside the container; live `apt install ./chan-gateway-*.deb` works there without a rootfs rebuild.
- **Restart a unit**: `sdme exec chan-id -- /usr/bin/systemctl restart chan-gateway-identity`.

## Troubleshooting

- **`connection refused on localhost:5432`** -- `sdme ps` should list chan-psql Running; if stopped, `sdme start chan-psql`; if wedged under load, `sdme exec chan-psql -- /usr/bin/systemctl restart postgresql`.
- **A service can't reach another** -- they resolve by container hostname ON the `chan-svc` zone, so every service container (and chan-psql) must be created with `--network-zone chan-svc`; check `sdme ps` and the hostname-based URLs in each unit's env.
- **Browser rejects the local cert** -- run `mkcert -install` so the local CA is trusted, and reissue the wildcard if you changed the domain.
- **Signed-in but the workspace 404s** -- confirm nginx serves https and `FORWARDED_PROTO=https` is set on devserver-proxy; a scheme mismatch makes the `__Host-devserver_gate` cookie fail to attach.
- **Tests pass locally but break on CI** -- same migration set must run (`migrations/0001..N` in order); a forgotten file shows up as missing-column errors on first use.
