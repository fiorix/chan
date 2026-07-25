# devserver tunnel e2e (cross-container, sdme)

An end-to-end test that drives authenticated desktop entry handoffs through a real `devserver-control-service`, `devserver-proxy-service`, and `chan devserver --tunnel-url`, running in two separate sdme containers, over the gateway tunnel, into a mounted workspace. An authenticated `200` from the mounted workspace's `/api/health` is the data-path proof, so debug builds do not need a separately staged SPA bundle. The same binary owner/grantee sessions exercise both native-trust mutation routes: the immutable owner reaches the desktop-bridge guard, while a grantee is rejected by `require_local_mutation`. The production chan-gateway run (`--tunnel-url` against `devserver.chan.app`) is a separate follow-up.

## What it proves

```
stub identity ─▶ signed admission + POST entry credential (owner/grantee)
                         │                         │
                 devserver-control          host curl over TLS
                         │                         │
                         └──────▶ devserver-proxy :7002 (loopback)
                                      │ opaque session + CSRF cookies
                  ▼
              TLS forwarder :7444 ─▶ tunnel :7100 loopback (h2c)
                  ▲
                  │  chan devserver dialed in and registered (PAT validated)
              chan devserver  ─▶  workspace `notes` mounted at /notes-<hash8>
```

The request `GET /notes-<hash8>/api/health` at the exact `{owner}--{disc}.{proxy_id}` origin returns `200` with the live workspace instance id. The bearer-gated identity response pins the immutable owner UUID, full devserver id, exact proxy origin, fixed `/_chan/entry` exchange URL, and a separate 30-second Ed25519 credential. The credential carries no name, email, or role, never appears in a URL, and succeeds exactly once in a bounded form POST from the configured identity origin. The real proxy exchanges it for opaque session + CSRF cookies.

With those authenticated sessions, the harness sends both `PUT` and `DELETE` to `/api/library/devservers/{id}/native-trust`. The caller whose subject UUID equals the immutable owner UUID gets the expected `409` no-desktop result. The binary grantee gets the exact `403` from `require_local_mutation`; no mutable viewer/editor role exists.

The controller, proxy, and chan binaries (including the tunnel-client/-proto crates) are real release builds. Two narrow pieces are fixtures because the rig does not stand up postgres-backed identity/profile or an edge TLS proxy:

- **stub identity** (`stub-identity.py`): accepts one exact internal bearer and tunnel PAT, signs a controller-bound admission lease for the proxy-generated registration UUID, and exposes owner/grantee desktop entry responses. It runs on the proxy container's loopback.
- **credential helper** (`mint-signed-credential.py`): signs the current Ed25519 admission and entry wire formats with per-run keys. The controller/proxy receive only verifying keys.
- **TLS forwarders** (`tls-forward.py`): expose the proxy's loopback-only listeners through a per-run CA. Public HTTP negotiates only HTTP/1.1 and the tunnel negotiates only h2. No `protected-overlay` assertion is made for the ordinary sdme bridge.

## Topology: why one zone, two containers

Two SEPARATE sdme zones are not reachable with sdme-only privileges, and `zone-isolation-probe.sh` documents why. Measured sdme 0.9.0 network behaviour here:

| path                              | result                                   |
|-----------------------------------|------------------------------------------|
| host → container                  | OK                                       |
| container → host (TCP)            | BLOCKED (ICMP only; host INPUT firewall) |
| container → container, same zone  | OK                                       |
| container → container, cross zone | BLOCKED                                  |
| `-p` published port, cross zone   | BLOCKED                                  |

Each zone bridge (`vz-<zone>`) reuses `169.254.0.0/16`, and the host drops container-initiated TCP to itself and forwards nothing between zone bridges. So a container can only initiate TCP to a **same-zone** peer. The tunnel is `chan devserver → devserver-proxy` (client → server), so the two must share a zone. Bridging two isolated zones would need host `iptables`/forwarding changes (root); the e2e's sudo is `sdme`-only (`NOPASSWD /usr/local/bin/sdme`).

The containers are still fully separate (own netns, fs, process tree); the tunnel genuinely crosses between two containers. Only the L2 zone is shared. Running the proxy and devserver in two ACTUAL zones is a host-networking follow-up (open the firewall / add inter-zone forwarding as root), tracked for Alex alongside the production `--tunnel-url` e2e.

## Run

```sh
# 1. Build the two release binaries inside the toolchain container (one-time,
#    ~10 min cold; reuses the cargo cache after). No host rust toolchain needed.
packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/build-bins.sh

# 2. Run the e2e (builds the chan-e2e-run runtime rootfs on first run).
packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/run.sh

# tear down
packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/run.sh --clean

# the network finding, standalone
packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/zone-isolation-probe.sh
```

`run.sh` leaves the containers up on PASS for inspection (`sudo sdme join gw-e2e-proxy`, `sudo sdme logs gw-e2e-ds`).

## Files

| file                      | role                                             |
|---------------------------|--------------------------------------------------|
| `build-bins.sh`           | container-build of the three release binaries    |
| `chan-e2e-run.sdme`       | runtime rootfs (ubuntu, iproute2, curl, python3) |
| `run.sh`                  | stand up containers, register, drive the request |
| `stub-identity.py`        | tunnel validation + authenticated entry stub     |
| `mint-signed-credential.py` | mint Ed25519 admission and entry credentials   |
| `tls-forward.py`            | exact-ALPN TLS edges for public HTTP and h2     |
| `zone-isolation-probe.sh` | demonstrate same-zone OK / cross-zone BLOCKED    |

## Config the harness sets

| name                    | value                                              |
|-------------------------|----------------------------------------------------|
| `APEX_HOST`             | `devserver.localtest.me`                           |
| `WILDCARD_SUFFIX`       | `.devserver.localtest.me`                          |
| `FORWARDED_PROTO`       | `https`                                             |
| proxy public / tunnel   | loopback `:7002` / `:7100`; TLS edge `:7443` / `:7444` |
| `IDENTITY_URL`          | `http://127.0.0.1:7799` (loopback stub)            |
| `CHAN_DEVSERVER_LISTEN` | `1` (bind mgmt API; host reads the mounted prefix) |
| tenant                  | user `alice`, workspace `notes`                    |
| desktop entry origins   | `alice--<id-prefix>.p1.devserver.localtest.me:7443` |
