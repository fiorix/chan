# Gateway setup: local, mirroring production

The gateway can run as a set of `sdme` containers, but a private bridge alone is not a trusted transport. This guide describes the production-shaped layout for hosts that also provide an authenticated, encrypted service overlay.

It mirrors the reference deployment in the sibling `chan-prod-setup` repo. Per "show the pattern, copy little", it describes the topology and one worked flow end to end, and points at the checked-in manifests ([`packaging/kube/`](../../packaging/kube/README.md)) and `chan-prod-setup` for the rest, rather than duplicating every config here.

> A faster inner loop exists for rapid iteration: `packaging/gateway/scripts/dev/run.sh` runs the services as host `cargo run` binaries over `*.localtest.me` (see [`packaging/gateway/scripts/dev/README.md`](../../packaging/gateway/scripts/dev/README.md)). That is handy while editing code, but it is NOT the prod-like shape. This guide is the containerized stack.

> **Load-bearing transport requirement:** an ordinary sdme `--network-zone` supplies network-namespace/L2 isolation, not authenticated encryption. It is therefore not sufficient grounds for `CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay`; never set that value just to make a cleartext non-loopback bind pass validation. The container commands below assume WireGuard, mTLS, or an equivalent authenticated and encrypted overlay is already in place wherever cleartext crosses a namespace boundary. Without one, use the checked-in local runner: it keeps every cleartext Rust listener on literal loopback and puts verified TLS edges in the same host namespace.

## Why the prod-like stack

The gateway's cross-tenant isolation is carried by two host-scoped cookies: `__Host-id_session` (host-only on the identity origin `gw.<domain>`) and `__Host-devserver_gate` (host-only on the tenant host `{owner}--{disc}.{proxy}.usr.<domain>`, scoped `Path=/` for the whole devserver). No parent-domain cookie exists, so a browser never auto-attaches an identity session to a fetch on another tenant's host. The whole-host devserver cookie is safe because the grant is whole-devserver; user-to-user isolation rides the host-only cookie plus the `aud` claim. That design, plus the reverse-proxy header hygiene (hop-by-hop stripping, dropped inbound Host/Cookie/Authorization, recomputed `X-Forwarded-*`), only fully exercises behind a real TLS terminator with real subdomains. Running the same services in the same two-plane shape as production is how you exercise it.

## Topology: two planes

Production splits the gateway into an **account and control plane** and a **proxy data plane**, and the local stack mirrors that split:

- **The gateway pod**: postgres, profile, identity, and devserver-control run as one pod sharing a network namespace, so they reach each other over loopback and no inter-service port is published. devserver-control rides inside the pod deliberately: identity and profile reach it on loopback instead of depending on cross-container name resolution. identity has two listeners: the public one behind the TLS edge, and an internal token-validate listener that is never routed publicly.
- **A TLS edge for the identity origin**: an nginx terminator serving `gw.<domain>`; `:80` answers only ACME and a `301` (the OAuth flow never runs over cleartext), `:443` proxies to identity's public listener.
- **The proxy plane**: each proxy node runs devserver-proxy behind its own TLS edge. That edge serves the `usr.<domain>` tunnel apex (`/v1/tunnel` is negotiated as h2 externally and `grpc_pass`ed as h2c into the proxy's tunnel listener) and the node's tenant wildcard `*.{proxy}.usr.<domain>` (ordinary HTTP plus WebSocket upgrade). The node connects back to the plane above over the authenticated overlay, and can reach exactly two things there: devserver-control's proxy-control listener and identity's internal token-validate listener. Nothing else (postgres, profile, identity's public listener) is reachable from a proxy node; production treats proxy nodes as compromisable, and `packaging/kube/network-policy.yaml` encodes the same reachability contract for clusters.

```mermaid
flowchart TB
    browser["browser (https)"]
    devsrv["chan devserver (tunnel dial)"]
    subgraph account["account + control plane"]
        gwnginx["TLS edge: gw.<domain>"]
        pod["gateway pod: postgres + profile + identity + control (loopback)"]
    end
    subgraph node["proxy node"]
        pnginx["TLS edge: usr.<domain> apex + *.p1.usr.<domain>"]
        proxy["devserver-proxy"]
    end
    browser -->|"sign-in"| gwnginx --> pod
    browser -->|"tenant"| pnginx --> proxy
    devsrv -->|"/v1/tunnel (h2c)"| pnginx
    proxy -->|"overlay: control session + token validate ONLY"| pod
```

Admission fails closed: the proxy admits a tunnel registration only after identity validates the PAT and devserver-control verifies the identity-signed admission lease, so a proxy that cannot reach the control plane serves nothing. devserver-control also rejects a proxy whose package version differs from its own, so every service and every node must run the same release tag.

## Prerequisites: sdme

Install sdme. On Linux, on the host:

```sh
curl -fsSL https://sdme.io/install.sh | sudo sh
```

On macOS, sdme runs inside a Lima VM; install Lima and then sdme inside the VM, per [macOS only: Lima shim](#macos-only-lima-shim). Either way the `sdme ...` commands below then work (on macOS through the alias).

## Bring up the gateway pod

The checked-in manifests are the source of truth: [`packaging/kube/README.md`](../../packaging/kube/README.md) covers building the service images (`packaging/docker/build.sh`), generating the secret set (every bearer, both Ed25519 key pairs, the per-proxy credential map), applying `sdme/gateway-pod.yaml`, and proving the stack healthy. The same README documents the cluster-manifest shape for real deployments and the database-role pipeline (the owner credential exists only in the migration job; identity and profile run app roles with `CHAN_GATEWAY_MIGRATIONS=external`).

The sdme pod is a functional-validation shape: its containers share one network namespace, so it proves wiring and behavior, not credential isolation. The per-service env contract lives in `gateway/crates/*/packaging/*.env`.

## The TLS edges

nginx terminates TLS for both host families; locally one nginx container can wear both, while production gives each proxy node its own edge. The route map is the topology above: `gw.<domain>` to identity's public listener with `proxy_pass`; the `usr.<domain>` apex health surface and the `*.{proxy}.usr.<domain>` tenant wildcard to devserver-proxy's HTTP listener; `/v1/tunnel` to the proxy's tunnel listener with `grpc_pass` (h2c). The internal listeners (identity token-validate, control's admin tree and proxy-control port) are never routed by nginx.

The one dev difference is the certificate. Production uses certbot with a dns-01 plugin for the wildcard (http-01 cannot issue wildcards; any DNS provider with a certbot plugin works). Locally, issue a local-CA wildcard with [`mkcert`](https://github.com/FiloSottile/mkcert) and mount it into the nginx container:

```sh
mkcert -install
mkcert "*.localtest.me" "*.usr.localtest.me" "*.p1.usr.localtest.me" localtest.me
```

`*.localtest.me` resolves every subdomain, at any depth, to `127.0.0.1` via public DNS, so no `/etc/hosts` or dnsmasq is needed.

## The overlay

Whatever crosses a namespace boundary in cleartext must ride an authenticated, encrypted overlay; WireGuard between the proxy node's container and the account plane is the reference shape. Give the proxy reachability to only the two internal listeners it needs, mirroring `network-policy.yaml`. Every cleartext non-loopback service sets `CHAN_GATEWAY_INTERNAL_TRANSPORT=protected-overlay`, and that assertion is valid only after the overlay exists.

## The worked flow

Sign in at `https://gw.localtest.me` (or your chosen identity origin). Both feature flags ship default-off, so enrol yourself after the first sign-in with the admin CLI, run from wherever it can reach profile's service API (inside the pod when your image set carries it, or `cargo run -p admin --` from `gateway/` pointed at a reachable profile listener):

```sh
chan-gateway-admin flag grant oauth_login      <your-email>
chan-gateway-admin flag grant share_workspaces <your-email>
```

Publish a devserver from the sibling `chan` repo over the TLS tunnel apex. Registration is per-devserver: one tunnel carries the whole library, so add a workspace first and then dial:

```sh
cargo run -p chan -- workspace add <workspace-dir>
export CHAN_TUNNEL_TOKEN=chan_pat_...     # mint under the dashboard Tokens tab
cargo run -p chan -- devserver --tunnel-url=https://usr.localtest.me/v1/tunnel
```

Clicking Open on the dashboard lands on the tenant origin, `https://<owner>--<disc>.p1.usr.localtest.me/<slug>-<8hex>/` (the workspace's tenant mount inside the devserver).

## From local to a real host

Because the local stack already has the prod shape, going to a real host changes only what is environment-specific, exactly as `chan-prod-setup` automates (`configure.sh`, then `make secrets` / `make all` / `make proxy-node`):

- **DNS.** Real records for `gw.<domain>`, the `usr.<domain>` tunnel apex, and each node's `*.{proxy}.usr.<domain>` wildcard.
- **Certificates.** Swap mkcert for certbot with your DNS provider's dns-01 plugin on each edge.
- **Secrets.** Real per-service secrets from `/var/lib/chan/secrets` instead of the inlined dev values; `COOKIE_SECURE=true`.
- **Lockstep.** Deploy every service and every proxy node on the same release tag; a version-mismatched node is rejected at the control handshake.

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

`devserver-proxy` and all `cargo test --lib` unit tests need no database; only `profile` and `identity` integration tests do. The pod's postgres is internal to the pod, so host-run tests use a separately published local Postgres (the dev runner's, or a one-off container with `-p 5432:5432` seeding `chan_gateway` and `chan_gateway_test`). Per-test schema isolation means a `cargo test` run never clobbers the `chan_gateway` DB a running stack uses. CI (`gateway-ci.yml`) runs the same gate with a `postgres:16` service on `ubuntu-latest` (x86_64), the canonical lane; local sdme is the fast loop.

### Connection reaper (test infra)

A flaky `cargo test` can panic mid-test and orphan sqlx pool connections; the role goes idle holding slots and the next run hits `PoolTimedOut`. `tests-shared/pg_reaper.rs` (wired into every DB-backed `TestApp::new()`) opens one durable connection and `pg_terminate_backend()`s its own role's idle peers on first use, then holds that connection so the role never falls fully idle. It recovers the realistic case automatically. The one case it cannot is **full exhaustion** (all non-superuser slots pinned): it panics pointing here. Reap manually as the postgres superuser against whichever Postgres your tests target, for example:

```sh
psql -U postgres -h 127.0.0.1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='chan';"
```

Safe whenever no live stack is connected to `chan_gateway`.

## sdme cheatsheet

- **Full container name**: pass the name you created (`chan-gateway`, ...). sdme also accepts an unambiguous prefix, but the full name keeps the examples copy-pasteable.
- **Full paths after `--`**: `machinectl shell` sets no `PATH`. Use `/usr/bin/psql`, `/usr/bin/runuser`, `/usr/bin/systemctl`.
- **Interactive shell**: `sdme join chan-gateway` drops you into a real shell inside the pod.
- **Pod exec**: `sdme exec chan-gateway --oci -- <cmd>` runs a command inside the pod's shared namespace (the health probes in the kube README use this).

## Troubleshooting

- **A service can't reach another** -- inside the pod they resolve over loopback; across containers they resolve by name only on the shared zone. Check `sdme ps` and the hostname-based URLs in each unit's env.
- **Browser rejects the local cert** -- run `mkcert -install` so the local CA is trusted, and reissue the wildcard if you changed the domain.
- **Signed-in but the tenant 404s** -- confirm nginx serves https and `FORWARDED_PROTO=https` is set on devserver-proxy; a scheme mismatch makes the `__Host-devserver_gate` cookie fail to attach.
- **The proxy admits nothing** -- fail-closed is working: check that the proxy reaches devserver-control over the overlay, that its bearer matches control's per-proxy credential map, and that both sides run the same release tag.
- **Tests pass locally but break on CI** -- same migration set must run (`migrations/0001..N` in order); a forgotten file shows up as missing-column errors on first use.
