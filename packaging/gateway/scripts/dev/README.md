# Local dev stack

Bootstraps the chan-gateway services (postgres + profile + identity + devserver-control + one to three devserver-proxy nodes) against a workspace `cargo run` build. Public identity, proxy, and tunnel endpoints use a generated local CA; the Rust services remain loopback-only behind small Node TLS forwarders.

`*.localtest.me` resolves to `127.0.0.1` for every subdomain via public DNS, which sidesteps the `/etc/hosts` surgery you would otherwise need to test the wildcard-subdomain shape locally.

Dev port layout (offset by `+10000` from the prod-shaped ports so the runner can coexist with an existing Lima/sdme deployment on the default ports):

| Service          | Port    | URL                                            |
|------------------|---------|------------------------------------------------|
| profile          | `17001` | http://127.0.0.1:17001                         |
| identity         | `17000` | https://gw.localtest.me:17000                  |
| devserver-control | `17003` | http://127.0.0.1:17003 (aggregate admin)      |
|                  | `17101` | h2c proxy control listener                     |
| devserver-proxy.pN | `17002` | https://pN.usr.localtest.me:17002 (node) |
|                  | `17100` | 127.0.0.N:17100 (TLS tunnel; h2c behind edge)  |

Every proxy node exposes the same two TLS ports on its own loopback alias (p1 on `127.0.0.1`, p2 on `127.0.0.2`, p3 on `127.0.0.3`) because the controller's origin template pins one shared port for the whole fleet. The proxy binaries themselves bind inner `16902`/`16910` loopback ports. A `chan devserver` client dials one node's verified TLS listener, e.g. `https://127.0.0.2:17100/v1/tunnel` for p2.

Browsing a p1 tenant works out of the box because `*.localtest.me` resolves to `127.0.0.1`. Browsing a p2 or p3 tenant origin needs one `/etc/hosts` line per extra node (`127.0.0.2 p2.usr.localtest.me` plus one line per tenant host you open, or a local wildcard DNS such as dnsmasq), because public DNS resolves those hosts to `127.0.0.1`, where p1 answers and 404s them.

## One-time setup

1. Postgres reachable at `postgres://chan:chan@127.0.0.1/chan_gateway`. The dev runner uses the same database the integration tests expect (`chan_gateway`); if you do not have that DB yet, `createdb -U chan chan_gateway` against your local pg.

2. A GitHub OAuth dev app (Settings -> Developer settings -> OAuth Apps -> New OAuth App). Use: Homepage URL: `https://gw.localtest.me:17000`; authorization callback: `https://gw.localtest.me:17000/auth/github/callback`.

3. Drop the GitHub creds into `packaging/gateway/scripts/dev/.env`:
   ```
   cp packaging/gateway/scripts/dev/env.example packaging/gateway/scripts/dev/.env
   $EDITOR packaging/gateway/scripts/dev/.env   # paste GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET
   ```

4. Generate secrets + ensure DB migrations are applied:
   ```
   packaging/gateway/scripts/dev/setup.sh
   ```
   This writes service env files and a local CA under `packaging/gateway/scripts/dev/secrets/`, then applies migrations. Import `secrets/tls/ca.crt` into the browser/profile used for local development before opening the dashboard. Idempotent; `--force` rotates secrets and the CA.

## Run

```
packaging/gateway/scripts/dev/run.sh
```

Spawns profile, identity, devserver-control, and one devserver-proxy in the foreground. Set `CHAN_DEV_PROXIES=3` to boot the full three-node fleet (p1-p3 on their own loopback aliases). Logs from all services multiplex to stdout, prefixed by service. Ctrl-C sends SIGINT to all of them and waits for clean shutdown. The controller holds a 30s convergence window on boot, so a fresh stack takes about half a minute before proxies report ready and admit tunnels.

Then open:

* https://gw.localtest.me:17000 -- dashboard. Sign in with GitHub; GitHub redirects to the TLS callback, identity-service mints a Secure host-only session cookie, and the SPA loads.

The Devservers tab is empty until a `chan devserver` instance registers (see below).

### First-time sign-in: enrol yourself

Both feature flags ship default-off, so the first OAuth sign-in will land on `/?denied=oauth_login` and the Devservers tab stays hidden. Two-step bootstrap:

```sh
# 1. Try sign-in once. This creates your user row (the gate runs
#    after the row is upserted) and then 303s to the denied panel.
#    Pick up your email from the SPA panel or via:
PT=$(grep PROFILE_ADMIN_TOKEN secrets/profile.env | cut -d= -f2-)
CHAN_ADMIN_PROFILE_TOKEN="$PT" CHAN_ADMIN_PROFILE_URL=http://127.0.0.1:17001 \
  ../../target/debug/chan-gateway-admin user list

# 2. Grant the two seeded flags on your account, then sign in
#    again. Devservers tab + share UI appear.
CHAN_ADMIN_PROFILE_TOKEN="$PT" CHAN_ADMIN_PROFILE_URL=http://127.0.0.1:17001 \
  ../../target/debug/chan-gateway-admin flag grant oauth_login <your-email>
CHAN_ADMIN_PROFILE_TOKEN="$PT" CHAN_ADMIN_PROFILE_URL=http://127.0.0.1:17001 \
  ../../target/debug/chan-gateway-admin flag grant share_workspaces <your-email>
```

Subsequent users repeat step 2. To open sign-in for everyone, flip the default with `chan-gateway-admin flag create oauth_login --default-on`.

## Publishing a devserver

From the repository root:

```
# Create a PAT under the Tokens tab on the dashboard, copy it.
export CHAN_TUNNEL_TOKEN=chan_pat_...
export SSL_CERT_FILE="$PWD/packaging/gateway/scripts/dev/secrets/tls/ca.crt"

cargo run -p chan -- workspace add <some-workspace-dir>
cargo run -p chan -- devserver \
  --tunnel-url=https://127.0.0.1:17100/v1/tunnel \
  --tunnel-devserver-name=blog
```

One tunnel carries the devserver's whole library, so every workspace you add is reachable over the single registration. The client verifies the per-stack CA, then the tunnel TLS edge negotiates only h2 and forwards it to proxy p1's loopback h2c listener. Identity and proxy public edges negotiate only HTTP/1.1; keeping the ALPN sets disjoint prevents a public listener from receiving an h2 preface it does not serve. Once connected, clicking Open on a workspace targets `https://<user>--<disc>.p1.usr.localtest.me:17002/<slug>-<8hex>/` (the workspace's tenant mount inside the devserver).

## Notes

* Public DNS names are never accepted over cleartext. Local TLS is terminated only onto loopback listeners; the generated CA is a development trust root, not a production credential.
* Postgres state persists across runs. To wipe and start fresh: `dropdb chan_gateway && createdb chan_gateway && packaging/gateway/scripts/dev/setup.sh`.
* Stopping `run.sh` with Ctrl-C is clean. If a service hangs, kill the process group with `kill -INT -- -<pgid>` -- the dev runner publishes its pgid as `packaging/gateway/scripts/dev/.run.pid` for that case.
