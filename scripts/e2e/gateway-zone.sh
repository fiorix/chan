#!/usr/bin/env bash
# gateway-zone.sh -- full-stack gateway e2e: the distributed proxy
# control plane (one devserver-control controller plus proxy nodes
# p1-p3), multi-devserver routing, entry mints, fleet-wide cap
# enforcement, tunnel reconnect, and controller/proxy failure
# scenarios against the REAL identity + profile + devserver-control +
# devserver-proxy services and REAL `chan devserver` processes.
#
# Topology: everything on host loopback, one process per service.
# Identity, profile, the OAuth stub, and the controller bind
# 127.0.0.1. The three proxies share one public port and one tunnel
# inner ports on their own loopback aliases (p1=127.0.0.2, p2=127.0.0.3,
# p3=127.0.0.4) because the controller's origin template pins one
# port for the whole fleet. Per-run CA-backed TLS edges front identity and
# every proxy public/tunnel listener. `localtest.me` wildcard DNS plus curl
# --resolve stand in for public DNS: every node host is pinned to its
# proxy's alias, so a request can be aimed at any node for any host.
#
# TCP and TLS shims (spawned like any service) model
# the edge pieces the fleet needs:
#   - one control relay per proxy (127.0.0.1:1784{2,3,4}) in front of
#     the controller's h2c listener; killing relay-p2 drops exactly
#     p2's control stream for the disconnect scenario,
#   - one round-robin ingress shim that preserves TLS and distributes tunnel
#     dials across three node TLS terminators, each forwarding h2c to its proxy.
#
# The devservers run host-local rather than in sdme zone containers:
# on this host the kernel firewall drops container->host TCP (see
# packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/zone-
# isolation-probe.sh), so a zone topology would need the whole stack
# including Postgres inside the zone. The multi-devserver semantics
# under test are identical either way.
#
# Requirements:
#   - a running Postgres reachable at $E2E_DATABASE_URL (default
#     postgres://chan:chan@127.0.0.1:5432/chan_gateway_test); the
#     harness isolates itself in schema $E2E_SCHEMA of that database
#     and drops it on every run,
#   - node + npm on PATH (the SQL helper self-installs the `pg`
#     package into the work dir once),
#   - gateway service binaries + the chan binary; missing ones are
#     cargo-built on demand,
#   - internet DNS for localtest.me (or a resolver override).
#
# Usage:
#   scripts/e2e/gateway-zone.sh            # everything: core suite + all scenarios
#   scripts/e2e/gateway-zone.sh core       # the core suite only
#   scripts/e2e/gateway-zone.sh <scenario> # stack bring-up + that scenario only
#   E2E_KEEP=1 scripts/e2e/gateway-zone.sh # leave the stack running
#
# Scenarios: self-contained assert groups that run against the
# brought-up stack after the core region. Register one by defining
# scenario_<name>() at the SCENARIO FUNCTIONS marker near the bottom
# and appending <name> to $SCENARIOS below.
#
# Output: plain-text assertion log at $WORK/assertions.log (echoed),
# service logs under $WORK/logs/. The run aborts with exit 1 on the
# FIRST failed assertion; exit 0 means every assertion passed.
set -uo pipefail
unset FORCE_COLOR

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${E2E_WORK:-$REPO/target/gateway-zone-e2e}"
LOGS="$WORK/logs"
E2E_DATABASE_URL="${E2E_DATABASE_URL:-postgres://chan:chan@127.0.0.1:5432/chan_gateway_test}"
E2E_SCHEMA="${E2E_SCHEMA:-gateway_zone_e2e}"
E2E_KEEP="${E2E_KEEP:-}"

# Fixed loopback ports; override only on collision. The proxies share
# PROXY_PORT/TUNNEL_PORT on their per-node aliases; the ingress shim
# owns TUNNEL_PORT on 127.0.0.1.
ID_INNER_PORT="${E2E_ID_INNER_PORT:-17800}"
ID_PORT="${E2E_ID_PORT:-17900}"
ID_INTERNAL_PORT="${E2E_ID_INTERNAL_PORT:-17804}"
PROFILE_PORT="${E2E_PROFILE_PORT:-17801}"
PROXY_INNER_PORT="${E2E_PROXY_INNER_PORT:-17802}"
PROXY_PORT="${E2E_PROXY_PORT:-17902}"
TUNNEL_INNER_PORT="${E2E_TUNNEL_INNER_PORT:-17810}"
TUNNEL_PORT="${E2E_TUNNEL_PORT:-17910}"
OAUTH_PORT="${E2E_OAUTH_PORT:-17830}"
CTL_ADMIN_PORT="${E2E_CTL_ADMIN_PORT:-17840}"
CTL_PROXY_PORT="${E2E_CTL_PROXY_PORT:-17841}"
DS_PORTS=(17821 17822 17823 17824 17825 17826 17827 17828 17829 17831 17832)

# Fleet shape: three proxy nodes on their own loopback aliases.
PROXY_IDS=(p1 p2 p3)
node_ip() { # node_ip <proxy-id> -> loopback alias
    case "$1" in
    p1) printf 127.0.0.2 ;;
    p2) printf 127.0.0.3 ;;
    p3) printf 127.0.0.4 ;;
    *) return 1 ;;
    esac
}
node_relay_port() { # node_relay_port <proxy-id> -> control relay listen port
    case "$1" in
    p1) printf 17842 ;;
    p2) printf 17843 ;;
    p3) printf 17844 ;;
    *) return 1 ;;
    esac
}
node_tunnel_url() { printf 'https://%s:%s/v1/tunnel' "$(node_ip "$1")" "$TUNNEL_PORT"; }
SHIM_TUNNEL_URL="https://127.0.0.1:$TUNNEL_PORT/v1/tunnel"

# Headless Chrome for the consent-flow asserts (the puppeteer cache
# layout, overridable).
CHROME_BIN="${E2E_CHROME_BIN:-$(ls -d "$HOME"/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome 2>/dev/null | head -1)}"
ALICE_EMAIL="e2e-alice@example.com"
CAROL_EMAIL="e2e-carol@example.com"
DAVE_EMAIL="e2e-dave@example.com"
ERIN_EMAIL="e2e-erin@example.com"

DOMAIN=localtest.me
ID_NAME="id.$DOMAIN"
ID_HOST="$ID_NAME:$ID_PORT"
APEX="devserver.$DOMAIN"
APEX_ORIGIN="https://$APEX:$PROXY_PORT"
TUNNEL_ORIGIN="https://$APEX:$TUNNEL_PORT"

# Per-run credentials (the stack is torn down with the run). Every controller
# scope and proxy identity is deliberately distinct.
TOK_PROFILE="e2e-profile-bearer"
TOK_INTERNAL="e2e-internal-bearer"
TOK_SESSION_INTERNAL="e2e-session-internal-000000000000001"
TOK_PROFILE_ADMIN="e2e-profile-admin-0000000000000001"
TOK_IDENTITY_ADMIN="e2e-identity-admin-000000000000001"
TOK_ACCOUNT_ADMIN="e2e-account-admin-0000000000000001"
TOK_CONTROL_OPERATOR="e2e-control-operator-00000000000001"
TOK_CONTROL_IDENTITY="e2e-control-identity-00000000000001"
TOK_CONTROL_PROFILE="e2e-control-profile-000000000000001"
proxy_token() { # proxy_token <proxy-id>
    case "$1" in
    p1) printf 'e2e-proxy-p1-00000000000000000001' ;;
    p2) printf 'e2e-proxy-p2-00000000000000000002' ;;
    p3) printf 'e2e-proxy-p3-00000000000000000003' ;;
    *) return 1 ;;
    esac
}
# The fleet-wide cap under test, enforced by the controller: two
# devservers of one user register, a third is refused.
MAX_DEVSERVERS=2

# Scenario dispatch: "all" (default) = core suite + every registered
# scenario; "core" = the inline suite only; a registered name = stack
# bring-up + that scenario only. Lanes append their scenario name here.
SCENARIOS="sweeper watchdog roster upload windowclose matrix sharedingress movenode ctlrestart proxydown ctloutage ctrlplane"
SCENARIO="${1:-all}"
RUN_CORE=1
case "$SCENARIO" in all | core) ;; *) RUN_CORE=0 ;; esac

ASSERT_LOG="$WORK/assertions.log"
PIDS=()

log() { printf '%s\n' "$*"; }
assert_pass() { printf 'PASS %s\n' "$*" | tee -a "$ASSERT_LOG"; }
assert_fail() {
    printf 'FAIL %s\n' "$*" | tee -a "$ASSERT_LOG"
    log "RESULT: aborting on the first failed assertion (see $ASSERT_LOG)"
    exit 1
}

cleanup() {
    [ -n "$E2E_KEEP" ] && {
        log "E2E_KEEP set: stack left running (pids: ${PIDS[*]:-none})"
        return
    }
    for pid in "${PIDS[@]:-}"; do
        # A SIGSTOPped process (the movenode scenario freezes one
        # devserver on purpose) ignores SIGTERM until it is continued;
        # without the CONT it would survive teardown holding its port.
        [ -n "$pid" ] && kill -CONT "$pid" 2>/dev/null
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
    done
    wait 2>/dev/null
}
trap cleanup EXIT

# ---------------------------------------------------------------
# Tooling
# ---------------------------------------------------------------

need() { command -v "$1" >/dev/null || { log "missing required tool: $1"; exit 2; }; }
need curl
need node
need npm
need openssl
need basenc
need sha256sum

mapfile -t ADMISSION_KEYS < <("$REPO/packaging/gateway/scripts/generate-admission-keypair.py")
mapfile -t ENTRY_KEYS < <("$REPO/packaging/gateway/scripts/generate-admission-keypair.py")
[ "${#ADMISSION_KEYS[@]}" = 2 ] && [ "${#ENTRY_KEYS[@]}" = 2 ] || {
    log "Ed25519 key generation failed"
    exit 2
}
ADMISSION_SIGNING_KEY="${ADMISSION_KEYS[0]}"
ADMISSION_VERIFYING_KEY="${ADMISSION_KEYS[1]}"
ENTRY_SIGNING_KEY="${ENTRY_KEYS[0]}"
ENTRY_VERIFYING_KEY="${ENTRY_KEYS[1]}"

mkdir -p "$WORK" "$LOGS"
: > "$ASSERT_LOG"
TLS_DIR="$WORK/tls"
mkdir -p "$TLS_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj '/CN=chan gateway-zone e2e CA' \
    -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" >/dev/null 2>&1 || exit 2
openssl req -newkey rsa:2048 -nodes -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:id.$DOMAIN,DNS:$APEX,DNS:*.$APEX,DNS:*.p1.$APEX,DNS:*.p2.$APEX,DNS:*.p3.$APEX,IP:127.0.0.1,IP:127.0.0.2,IP:127.0.0.3,IP:127.0.0.4" \
    -keyout "$TLS_DIR/edge.key" -out "$TLS_DIR/edge.csr" >/dev/null 2>&1 || exit 2
openssl x509 -req -days 1 -sha256 -copy_extensions copy \
    -in "$TLS_DIR/edge.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" \
    -CAcreateserial -out "$TLS_DIR/edge.crt" >/dev/null 2>&1 || exit 2

# Kill leftovers from a previous run (idempotency): every process we
# spawn records a pidfile under $WORK/pids.
mkdir -p "$WORK/pids"
for f in "$WORK"/pids/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f")"
    kill "$pid" 2>/dev/null && log "killed leftover $(basename "$f" .pid) (pid $pid)"
    rm -f "$f"
done

# Belt and braces: free every port the run binds. A stray listener
# (e.g. a hand-started debug service) would otherwise swallow the
# traffic while our own spawn dies on the bind conflict.
free_port() { # free_port <port>
    local pids
    pids="$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | sort -u)"
    local pid
    for pid in $pids; do
        kill "$pid" 2>/dev/null && log "freed port $1 (killed stray pid $pid)"
    done
}
for p in "$ID_INNER_PORT" "$ID_PORT" "$ID_INTERNAL_PORT" "$PROFILE_PORT" \
    "$PROXY_INNER_PORT" "$PROXY_PORT" "$TUNNEL_INNER_PORT" "$TUNNEL_PORT" "$OAUTH_PORT" \
    "$CTL_ADMIN_PORT" "$CTL_PROXY_PORT" 17842 17843 17844 "${DS_PORTS[@]}"; do
    free_port "$p"
done

# SQL + browser helpers: node deps self-installed into the work dir
# once (pg for seeding, puppeteer-core to drive the host Chrome).
if [ ! -d "$WORK/node_modules/pg" ] || [ ! -d "$WORK/node_modules/puppeteer-core" ]; then
    log "installing pg + puppeteer-core into $WORK (once)"
    (cd "$WORK" && npm install --no-fund --no-audit --loglevel=error pg puppeteer-core >/dev/null) || {
        log "npm install pg puppeteer-core failed"
        exit 2
    }
fi
cat > "$WORK/sql.mjs" <<'EOF'
// Tiny SQL runner: node sql.mjs <database-url> "<sql>" -- executes one
// statement batch, prints rows as tab-separated values.
import pg from "pg";
const [url, sql] = process.argv.slice(2);
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
    const r = await c.query(sql);
    const rows = Array.isArray(r) ? r.flatMap((x) => x.rows) : r.rows;
    for (const row of rows) console.log(Object.values(row).join("\t"));
} finally {
    await c.end();
}
EOF
sql() { node "$WORK/sql.mjs" "$1" "$2"; }

# TCP shim: relays each inbound connection to one target, round-robin
# across the target list. One instance per proxy fronts the
# controller's h2c listener (so a scenario can drop exactly one
# proxy's control stream by killing a relay) and one instance fronts
# the three tunnel listeners (the shared-apex ingress edge). Either
# side closing tears down the other, so a killed relay or a dead
# upstream reads as a clean stream death on both ends.
cat > "$WORK/tcp-shim.mjs" <<'EOF'
import net from "node:net";
const [listen, ...targets] = process.argv.slice(2);
const [lip, lport] = listen.split(":");
let next = 0;
net.createServer((client) => {
    const [tip, tport] = targets[next++ % targets.length].split(":");
    const up = net.connect(Number(tport), tip);
    client.on("error", () => up.destroy());
    client.on("close", () => up.destroy());
    up.on("error", () => client.destroy());
    up.on("close", () => client.destroy());
    client.pipe(up);
    up.pipe(client);
}).listen(Number(lport), lip);
EOF

# TLS edge: terminate one externally reachable listener onto a loopback-only
# service port. Public HTTP and tunnel h2c listeners have different protocol
# contracts, so their ALPN sets must not overlap: forwarding negotiated h2 into
# an HTTP/1-only public listener produces an immediate protocol EOF. A per-run
# CA keeps every client verification-on.
cat > "$WORK/tls-shim.mjs" <<'EOF'
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
const [listen, target, certFile, keyFile, protocol] = process.argv.slice(2);
if (!(["http1", "h2"].includes(protocol))) {
    throw new Error("usage: tls-shim.mjs LISTEN TARGET CERT KEY http1|h2");
}
const [lip, lport] = listen.split(":");
const [tip, tport] = target.split(":");
tls.createServer({
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
    ALPNProtocols: protocol === "h2" ? ["h2"] : ["http/1.1"],
}, (client) => {
    const up = net.connect(Number(tport), tip);
    client.on("error", () => up.destroy());
    client.on("close", () => up.destroy());
    up.on("error", () => client.destroy());
    up.on("close", () => client.destroy());
    client.pipe(up);
    up.pipe(client);
}).listen(Number(lport), lip);
EOF

# ---------------------------------------------------------------
# Binaries (cargo-build on demand; warm target = cheap no-op)
# ---------------------------------------------------------------

# E2E_GW_BIN / E2E_CHAN_BIN point at prebuilt binaries (e.g. built
# from a committed ref while the working tree holds in-flight edits).
GW_BIN="${E2E_GW_BIN:-$REPO/gateway/target/debug}"
CHAN_BIN="${E2E_CHAN_BIN:-$REPO/target/debug/chan}"
for b in identity-service profile-service devserver-control-service devserver-proxy-service; do
    pkg="${b%-service}"
    [ -x "$GW_BIN/$b" ] || (cd "$REPO/gateway" && cargo build -p "$pkg" >/dev/null) || exit 2
done
# The operator CLI (package `admin`) seeds the PATs below through
# identity's /admin/v1/tokens surface.
[ -x "$GW_BIN/chan-gateway-admin" ] ||
    (cd "$REPO/gateway" && cargo build -p admin >/dev/null) || exit 2
# --no-default-features drops the ML/embeddings deps; the devserver
# serves workspaces without them (same shape the pre-push no-default
# build checks).
[ -x "$CHAN_BIN" ] || (cd "$REPO" && cargo build -p chan --no-default-features >/dev/null) || exit 2

# ---------------------------------------------------------------
# Database: fresh schema inside the existing database
# ---------------------------------------------------------------

log "resetting schema $E2E_SCHEMA"
sql "$E2E_DATABASE_URL" \
    "DROP SCHEMA IF EXISTS $E2E_SCHEMA CASCADE; CREATE SCHEMA $E2E_SCHEMA;" || exit 2
# Services reach the schema via search_path in the URL options. One explicit
# migration-only identity invocation owns all DDL; app processes run external.
DB_URL="$E2E_DATABASE_URL?options=-csearch_path%3D$E2E_SCHEMA"
env DATABASE_URL="$DB_URL" CHAN_GATEWAY_MIGRATIONS=only \
    "$GW_BIN/identity-service" > "$LOGS/migrate.log" 2>&1 || {
    log "migration-only identity failed; last log lines:"
    tail -20 "$LOGS/migrate.log" || true
    exit 2
}

# ---------------------------------------------------------------
# Services
# ---------------------------------------------------------------

spawn() { # spawn <name> <cmd...>
    local name="$1"
    shift
    "$@" > "$LOGS/$name.log" 2>&1 &
    local pid=$!
    PIDS+=("$pid")
    echo "$pid" > "$WORK/pids/$name.pid"
    log "started $name (pid $pid)"
}

wait_http() { # wait_http <name> <url> [tries]
    local name="$1" url="$2" tries="${3:-50}"
    for _ in $(seq "$tries"); do
        if curl --noproxy '*' --cacert "$TLS_DIR/ca.crt" -fsS -o /dev/null \
            --max-time 2 "$url"; then return 0; fi
        sleep 0.2
    done
    log "$name did not answer at $url; last log lines:"
    tail -5 "$LOGS/$name.log" || true
    return 1
}

# Readiness probe with an optional Host header: the proxies answer
# /readyz only on the apex host, and the controller holds 503 for its
# full 30s convergence window, so these waits run long and the
# expected 503s stay quiet.
wait_ready() { # wait_ready <name> <url> [host] [tries]
    local name="$1" url="$2" host="${3:-}" tries="${4:-240}"
    for _ in $(seq "$tries"); do
        if curl --noproxy '*' --cacert "$TLS_DIR/ca.crt" -fsS -o /dev/null --max-time 2 \
            ${host:+-H "Host: $host"} "$url" 2>/dev/null; then return 0; fi
        sleep 0.4
    done
    log "$name did not become ready at $url; last log lines:"
    tail -5 "$LOGS/$name.log" || true
    return 1
}

# Stub GitHub: identity's provider endpoints point here so the
# browser phase can sign in without real OAuth.
spawn stub-oauth node "$REPO/scripts/e2e/stub-oauth.mjs" "$OAUTH_PORT" "$ALICE_EMAIL"

spawn profile env \
    BIND_ADDR="127.0.0.1:$PROFILE_PORT" \
    DATABASE_URL="$DB_URL" \
    CHAN_GATEWAY_MIGRATIONS=external \
    PROFILE_AUTH_TOKEN="$TOK_PROFILE" \
    PROFILE_ADMIN_TOKEN="$TOK_PROFILE_ADMIN" \
    DEVSERVER_PROFILE_ADMIN_TOKEN="$TOK_CONTROL_PROFILE" \
    DEVSERVER_ADMIN_URL="http://127.0.0.1:$CTL_ADMIN_PORT" \
    RUST_LOG=info \
    "$GW_BIN/profile-service"

spawn_identity() {
    spawn identity env \
        BIND_ADDR="127.0.0.1:$ID_INNER_PORT" \
        INTERNAL_BIND_ADDR="127.0.0.1:$ID_INTERNAL_PORT" \
        BASE_URL="https://$ID_HOST" \
        DATABASE_URL="$DB_URL" \
        CHAN_GATEWAY_MIGRATIONS=external \
        PROFILE_SERVICE_URL="http://127.0.0.1:$PROFILE_PORT" \
        PROFILE_AUTH_TOKEN="$TOK_PROFILE" \
        PROFILE_ADMIN_TOKEN="$TOK_PROFILE_ADMIN" \
        DEVSERVER_POLICY_REQUIRED=false \
        IDENTITY_INTERNAL_TOKEN="$TOK_INTERNAL" \
        IDENTITY_SESSION_INTERNAL_TOKEN="$TOK_SESSION_INTERNAL" \
        IDENTITY_ADMIN_TOKEN="$TOK_IDENTITY_ADMIN" \
        IDENTITY_ACCOUNT_ADMIN_TOKEN="$TOK_ACCOUNT_ADMIN" \
        DEVSERVER_IDENTITY_ADMIN_TOKEN="$TOK_CONTROL_IDENTITY" \
        DEVSERVER_ADMIN_URL="http://127.0.0.1:$CTL_ADMIN_PORT" \
        DEVSERVER_ADMISSION_SIGNING_KEY="$ADMISSION_SIGNING_KEY" \
        DEVSERVER_ADMISSION_VERIFYING_KEYS="$ADMISSION_VERIFYING_KEY" \
        DEVSERVER_ENTRY_SIGNING_KEY="$ENTRY_SIGNING_KEY" \
        DEVSERVER_PROXY_ORIGIN="$APEX_ORIGIN" \
        DEVSERVER_TUNNEL_ORIGIN="$TUNNEL_ORIGIN" \
        GITHUB_CLIENT_ID=e2e-dummy \
        GITHUB_CLIENT_SECRET=e2e-dummy \
        IDENTITY_OAUTH_ENDPOINTS_BASE="http://127.0.0.1:$OAUTH_PORT" \
        RUST_LOG=info \
        "$GW_BIN/identity-service"
}
spawn_identity

# The controller is a function because the restart scenarios respawn
# it against the same template.
spawn_controller() {
    spawn controller env \
        BIND_ADDR="127.0.0.1:$CTL_ADMIN_PORT" \
        PROXY_BIND_ADDR="127.0.0.1:$CTL_PROXY_PORT" \
        DEVSERVER_OPERATOR_ADMIN_TOKENS="$TOK_CONTROL_OPERATOR" \
        DEVSERVER_IDENTITY_ADMIN_TOKENS="$TOK_CONTROL_IDENTITY" \
        DEVSERVER_PROFILE_ADMIN_TOKENS="$TOK_CONTROL_PROFILE" \
        DEVSERVER_PROXY_CREDENTIALS="p1=$(proxy_token p1);p2=$(proxy_token p2);p3=$(proxy_token p3)" \
        DEVSERVER_ADMISSION_VERIFYING_KEYS="$ADMISSION_VERIFYING_KEY" \
        DEVSERVER_PROXY_BASE_URL_TEMPLATE="https://{proxy_id}.$APEX:$PROXY_PORT" \
        MAX_DEVSERVERS_PER_USER="$MAX_DEVSERVERS" \
        RUST_LOG=info \
        "$GW_BIN/devserver-control-service"
}
spawn_controller

# One control relay per proxy, in front of the controller's h2c
# listener; the proxies dial their own relay so the disconnect
# scenario can drop exactly one stream.
for id in "${PROXY_IDS[@]}"; do
    spawn "relay-$id" node "$WORK/tcp-shim.mjs" \
        "127.0.0.1:$(node_relay_port "$id")" "127.0.0.1:$CTL_PROXY_PORT"
done

# The shared-apex ingress edge preserves TLS and distributes connections across
# the three node TLS listeners.
spawn ingress-shim node "$WORK/tcp-shim.mjs" \
    "127.0.0.1:$TUNNEL_PORT" \
    "127.0.0.2:$TUNNEL_PORT" "127.0.0.3:$TUNNEL_PORT" "127.0.0.4:$TUNNEL_PORT"

spawn_proxy() { # spawn_proxy <proxy-id>
    local id="$1" ip
    ip="$(node_ip "$id")"
    spawn "proxy-$id" env \
        BIND_ADDR="$ip:$PROXY_INNER_PORT" \
        TUNNEL_BIND_ADDR="$ip:$TUNNEL_INNER_PORT" \
        IDENTITY_URL="http://127.0.0.1:$ID_INTERNAL_PORT" \
        IDENTITY_INTERNAL_TOKEN="$TOK_INTERNAL" \
        IDENTITY_PUBLIC_ORIGIN="https://$ID_HOST" \
        DEVSERVER_ADMISSION_VERIFYING_KEYS="$ADMISSION_VERIFYING_KEY" \
        DEVSERVER_ENTRY_VERIFYING_KEYS="$ENTRY_VERIFYING_KEY" \
        DASHBOARD_URL="https://$ID_HOST/workspaces" \
        DEVSERVER_TUNNEL_ORIGIN="$TUNNEL_ORIGIN" \
        DEVSERVER_PROXY_BASE_URL="https://$id.$APEX:$PROXY_PORT" \
        DEVSERVER_CONTROL_URL="http://127.0.0.1:$(node_relay_port "$id")" \
        DEVSERVER_PROXY_TOKEN="$(proxy_token "$id")" \
        DEVSERVER_PROXY_ID="$id" \
        FORWARDED_PROTO=https \
        RUST_LOG=info \
        "$GW_BIN/devserver-proxy-service"
}
for id in "${PROXY_IDS[@]}"; do
    spawn_proxy "$id"
done

spawn identity-edge node "$WORK/tls-shim.mjs" \
    "127.0.0.1:$ID_PORT" "127.0.0.1:$ID_INNER_PORT" \
    "$TLS_DIR/edge.crt" "$TLS_DIR/edge.key" http1
for id in "${PROXY_IDS[@]}"; do
    ip="$(node_ip "$id")"
    spawn "public-edge-$id" node "$WORK/tls-shim.mjs" \
        "$ip:$PROXY_PORT" "$ip:$PROXY_INNER_PORT" \
        "$TLS_DIR/edge.crt" "$TLS_DIR/edge.key" http1
    spawn "tunnel-edge-$id" node "$WORK/tls-shim.mjs" \
        "$ip:$TUNNEL_PORT" "$ip:$TUNNEL_INNER_PORT" \
        "$TLS_DIR/edge.crt" "$TLS_DIR/edge.key" h2
done

wait_http profile "http://127.0.0.1:$PROFILE_PORT/healthz" || exit 2
wait_http identity "http://127.0.0.1:$ID_INNER_PORT/healthz" || exit 2
# Controller readiness intentionally waits the full convergence
# window: the fleet reports ready only after every proxy's snapshot
# has sat complete for 30s. Proxies report ready on FleetReady.
wait_ready controller "http://127.0.0.1:$CTL_ADMIN_PORT/readyz" || exit 2
for id in "${PROXY_IDS[@]}"; do
    wait_ready "proxy-$id" "https://$(node_ip "$id"):$PROXY_PORT/readyz" "$APEX" || exit 2
done

# healthz answering is not enough: a stray listener could serve it
# while our own spawn died on the bind conflict. The spawned pid
# itself must still be alive.
require_alive() { # require_alive <name>
    local pid
    pid="$(cat "$WORK/pids/$1.pid")"
    if ! kill -0 "$pid" 2>/dev/null; then
        log "$1 (pid $pid) died at startup; log tail:"
        tail -5 "$LOGS/$1.log" || true
        exit 2
    fi
}
for svc in stub-oauth profile identity identity-edge controller relay-p1 relay-p2 relay-p3 \
    ingress-shim proxy-p1 proxy-p2 proxy-p3 public-edge-p1 public-edge-p2 public-edge-p3 \
    tunnel-edge-p1 tunnel-edge-p2 tunnel-edge-p3; do
    require_alive "$svc"
done
log "stack is up (controller ready, p1-p3 at FleetReady)"

# ---------------------------------------------------------------
# Seed: alice (cap suite, two live devservers), bob (a claimed share
# that never dials), carol and dave (fleet clients on the third node
# and through the shared ingress)
# ---------------------------------------------------------------
# PATs mint through the operator surface (`chan-gateway-admin token
# create` -> identity /admin/v1/tokens), so the harness exercises the
# same path an operator provisioning a user does; the devserver row
# registers as a side effect of the mint (label = PAT label). The
# devserver id stays derivable client-side: lowercase hex
# sha256(secret), the api_tokens cross-service contract.

admin_json() {
    "$GW_BIN/chan-gateway-admin" \
        --profile-url "http://127.0.0.1:$PROFILE_PORT" \
        --workspace-url "http://127.0.0.1:$CTL_ADMIN_PORT" \
        --identity-url "http://127.0.0.1:$ID_INTERNAL_PORT" \
        --profile-token "$TOK_PROFILE_ADMIN" \
        --operator-token "$TOK_CONTROL_OPERATOR" \
        --identity-token "$TOK_IDENTITY_ADMIN" \
        --json "$@"
}

admin_mint() { # admin_mint <email> <label> -> "secret dsid"
    local out secret dsid
    out="$(admin_json token create "$1" \
        --scope tunnel --scope desktop.connect --label "$2" \
        2>> "$LOGS/admin-mint.log")" || return 1
    secret="$(printf %s "$out" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).secret||"")}catch{console.log("")}})')"
    case "$secret" in chan_pat_*) ;; *) return 1 ;; esac
    dsid="$(printf %s "$secret" | sha256sum | awk '{print $1}')"
    echo "$secret $dsid"
}

mint_into() { # mint_into <email> <label> <pat-var> <devserver-id-var>
    local email="$1" label="$2" pat_var="$3" dsid_var="$4" row pat dsid
    row="$(admin_mint "$email" "$label")" || return 1
    read -r pat dsid <<< "$row"
    [[ "$pat" == chan_pat_* && "$dsid" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf -v "$pat_var" '%s' "$pat"
    printf -v "$dsid_var" '%s' "$dsid"
}

# The browser phase signs in through the stub OAuth with this email;
# profile's upsert-by-identity attaches the github identity to this
# pre-seeded row by email match. oauth_login gates the callback and
# ships default-off, so the e2e schema flips the default.
sql "$E2E_DATABASE_URL" "SET search_path TO $E2E_SCHEMA;
    UPDATE feature_flags SET default_enabled = true WHERE key = 'oauth_login';" || exit 2
seed_user() { # seed_user <email> -> "id username"
    local id
    id="$(sql "$E2E_DATABASE_URL" "SET search_path TO $E2E_SCHEMA;
        INSERT INTO users (id, email, username)
        VALUES (gen_random_uuid(), '$1',
                'u' || substr(md5(random()::text), 1, 12))
        RETURNING id;")"
    printf '%s %s' "$id" "$(sql "$E2E_DATABASE_URL" \
        "SET search_path TO $E2E_SCHEMA; SELECT username FROM users WHERE id = '$id';")"
}
read -r ALICE_ID ALICE_USER <<< "$(seed_user "$ALICE_EMAIL")"
read -r CAROL_ID CAROL_USER <<< "$(seed_user "$CAROL_EMAIL")"
read -r DAVE_ID DAVE_USER <<< "$(seed_user "$DAVE_EMAIL")"
read -r ERIN_ID ERIN_USER <<< "$(seed_user "$ERIN_EMAIL")"
log "seeded users alice=$ALICE_USER carol=$CAROL_USER dave=$DAVE_USER erin=$ERIN_USER"

# The mint IS an assertion (v0.68 item 8: admin token create end to
# end); everything downstream then proves the minted PATs actually
# dial, route, and gate. Alice gets A/B (live) + C (cap probe); carol
# gets D (p3) + E (shared ingress); dave gets F (shared ingress) + G
# (admission probe for the failure scenarios).
if mint_into "$ALICE_EMAIL" e2e-a PAT_A DS_A &&
    mint_into "$ALICE_EMAIL" e2e-b PAT_B DS_B &&
    mint_into "$ALICE_EMAIL" e2e-c PAT_C DS_C &&
    mint_into "$CAROL_EMAIL" e2e-d PAT_D DS_D &&
    mint_into "$CAROL_EMAIL" e2e-e PAT_E DS_E &&
    mint_into "$DAVE_EMAIL" e2e-f PAT_F DS_F &&
    mint_into "$DAVE_EMAIL" e2e-g PAT_G DS_G; then
    assert_pass "admin mint: token create provisioned 7 PATs via /admin/v1/tokens"
else
    assert_fail "admin mint: chan-gateway-admin token create failed (logs/admin-mint.log)"
fi
# Guard probes: the surface refuses a wrong bearer outright and
# answers an unknown email with the same 404 the CLI narrates.
guard_status="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$ID_INTERNAL_PORT/admin/v1/tokens" \
    -H "authorization: Bearer wrong-$TOK_IDENTITY_ADMIN" \
    -H "content-type: application/json" \
    -d "{\"email\":\"$ALICE_EMAIL\"}")"
if [ "$guard_status" = "401" ]; then
    assert_pass "admin mint: wrong bearer refused (401)"
else
    assert_fail "admin mint: wrong bearer expected 401, got $guard_status"
fi
unknown_status="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "http://127.0.0.1:$ID_INTERNAL_PORT/admin/v1/tokens" \
    -H "authorization: Bearer $TOK_IDENTITY_ADMIN" \
    -H "content-type: application/json" \
    -d '{"email":"e2e-nobody@example.com"}')"
if [ "$unknown_status" = "404" ]; then
    assert_pass "admin mint: unknown email is 404"
else
    assert_fail "admin mint: unknown email expected 404, got $unknown_status"
fi
disc() { printf %s "${1:0:12}"; }
log "devservers: A=$(disc "$DS_A") B=$(disc "$DS_B") C=$(disc "$DS_C") (cap candidate) D=$(disc "$DS_D") E=$(disc "$DS_E") F=$(disc "$DS_F") G=$(disc "$DS_G")"

# Bob shares a devserver with alice (claimed grant): the consent
# picker's "shared with you" row. Bob's devserver never dials in, so
# it renders offline; the pick list does not require liveness.
DS_BOB="$(openssl rand -hex 32)"
BOB_ID="$(sql "$E2E_DATABASE_URL" "SET search_path TO $E2E_SCHEMA;
    INSERT INTO users (id, email, username)
    VALUES (gen_random_uuid(), 'e2e-bob@example.com', 'e2ebobhandle')
    RETURNING id;")"
BOB_USER="$(sql "$E2E_DATABASE_URL" \
    "SET search_path TO $E2E_SCHEMA; SELECT username FROM users WHERE id = '$BOB_ID';")"
sql "$E2E_DATABASE_URL" "SET search_path TO $E2E_SCHEMA;
    INSERT INTO devservers (owner_user_id, devserver_id, label)
    VALUES ('$BOB_ID', '$DS_BOB', 'bob-box');
    INSERT INTO devserver_grants
        (owner_user_id, devserver_id, grantee_email, grantee_user_id, accepted_at)
    VALUES ('$BOB_ID', '$DS_BOB', '$ALICE_EMAIL', '$ALICE_ID', now());" || exit 2
log "seeded bob ($BOB_USER) sharing $(disc "$DS_BOB") with alice"

# ---------------------------------------------------------------
# Aggregate admin helpers (the controller owns the fleet view)
# ---------------------------------------------------------------

admin_read() { # admin_read <path> -> controller admin JSON (fails on 503)
    curl -fsS -H "Authorization: Bearer $TOK_CONTROL_OPERATOR" "http://127.0.0.1:$CTL_ADMIN_PORT$1"
}

jrows() { # jrows <field...>: one line per JSON array row, fields space-separated
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{
        const fs=process.argv.slice(1);
        for(const r of JSON.parse(d)) console.log(fs.map(f=>String(r[f]??"")).join(" "));
    }catch{}})' "$@"
}

admin_tunnels() { # admin_tunnels -> JSON list of alice's live tunnels
    admin_read "/admin/v1/owners/$ALICE_ID/tunnels"
}

tunnel_count() { admin_tunnels | grep -o '"devserver_id"' | wc -l; }

wait_tunnels() { # wait_tunnels <expected-count> [tries]
    local want="$1" tries="${2:-75}"
    for _ in $(seq "$tries"); do
        [ "$(tunnel_count)" = "$want" ] && return 0
        sleep 0.4
    done
    return 1
}

tunnel_field() { # tunnel_field <dsid> <field> -> aggregate row field (empty if absent)
    admin_read /admin/v1/tunnels | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        const [id,f]=process.argv.slice(1);
        try{const r=JSON.parse(d).find(x=>x.devserver_id===id);console.log(r?String(r[f]??""):"")}catch{console.log("")}})' \
        "$1" "$2"
}

# One read, one row: the peer address and connect time together
# fingerprint the underlying tunnel connection, so a scenario can
# prove a registration survived an event (a redial would change both).
tunnel_fingerprint() { # tunnel_fingerprint <dsid> -> "peer_addr connected_at"
    admin_read /admin/v1/tunnels | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        const id=process.argv[1];
        try{const r=JSON.parse(d).find(x=>x.devserver_id===id);console.log(r?`${r.peer_addr} ${r.connected_at}`:"")}catch{console.log("")}})' \
        "$1"
}

fleet_count() { admin_read /admin/v1/tunnels | grep -o '"devserver_id"' | wc -l; }

wait_fleet() { # wait_fleet <expected-total-rows> [tries]
    local want="$1" tries="${2:-75}"
    for _ in $(seq "$tries"); do
        [ "$(fleet_count)" = "$want" ] && return 0
        sleep 0.4
    done
    return 1
}

json_array_len() {
    node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d);console.log(Array.isArray(v)?v.length:-1)}catch{console.log(-1)}})'
}

owner_tunnels() { admin_read "/admin/v1/owners/$1/tunnels"; }
owner_tunnel_count() { owner_tunnels "$1" | json_array_len; }

wait_owner_tunnels() { # wait_owner_tunnels <owner-id> <expected-count> [tries]
    local owner="$1" want="$2" tries="${3:-75}"
    for _ in $(seq "$tries"); do
        [ "$(owner_tunnel_count "$owner")" = "$want" ] && return 0
        sleep 0.4
    done
    return 1
}

owner_sessions() {
    admin_read "/admin/v1/browser-sessions?owner_user_id=$1"
}
owner_session_count() { owner_sessions "$1" | json_array_len; }

wait_owner_sessions() { # wait_owner_sessions <owner-id> <expected-count> [tries]
    local owner="$1" want="$2" tries="${3:-75}"
    for _ in $(seq "$tries"); do
        [ "$(owner_session_count "$owner")" = "$want" ] && return 0
        sleep 0.4
    done
    return 1
}

# host_for derives a devserver's tenant host from its aggregate row,
# so every probe targets the owning node the controller reports
# rather than an assumption baked into the harness.
host_for() { # host_for <user> <dsid> -> "<user>--<disc>.<node>.$APEX" (empty if not live)
    local node
    node="$(tunnel_field "$2" proxy_id)"
    [ -n "$node" ] && printf '%s--%s.%s.%s' "$1" "$(disc "$2")" "$node" "$APEX"
}

# ---------------------------------------------------------------
# Devservers (host-local foreground processes)
# ---------------------------------------------------------------

# Alice's devservers announce the SAME display name so the T5 dedup
# assertion below exercises the owner-scoped -2 suffix; redials
# re-announce it, which must be label-stable (no suffix creep).
DS_DISPLAY_NAME="e2e-box"

spawn_devserver() { # spawn_devserver <name> <port> <pat> <tunnel-url>
    local name="$1" port="$2" pat="$3" turl="$4"
    mkdir -p "$WORK/home-$name"
    spawn "ds-$name" env \
        CHAN_HOME="$WORK/home-$name" \
        CHAN_TUNNEL_TOKEN="$pat" \
        SSL_CERT_FILE="$TLS_DIR/ca.crt" \
        "$CHAN_BIN" devserver --service=none \
        --bind 127.0.0.1 --port "$port" \
        --tunnel-url="$turl" \
        --tunnel-devserver-name="$DS_DISPLAY_NAME"
}

# ---------------------------------------------------------------
# Fleet bring-up: one real tunnel through each proxy's own listener
# ---------------------------------------------------------------

# Before any client dials, the converged fleet must show three active
# proxy rows with empty snapshots; that is the state the controller
# spent its convergence window assembling.
proxies_json="$(admin_read /admin/v1/proxies)" || {
    log "cannot read /admin/v1/proxies; aborting"
    exit 1
}
fleet_shape="$(printf %s "$proxies_json" | jrows proxy_id status tunnel_count proxy_base_url | sort)"
expected_shape="p1 active 0 https://p1.$APEX:$PROXY_PORT
p2 active 0 https://p2.$APEX:$PROXY_PORT
p3 active 0 https://p3.$APEX:$PROXY_PORT"
if [ "$fleet_shape" = "$expected_shape" ]; then
    assert_pass "fleet: /admin/v1/proxies shows three active rows with empty snapshots"
else
    assert_fail "fleet: expected three active zero-row proxies, got:
$fleet_shape"
fi

spawn_devserver a "${DS_PORTS[0]}" "$PAT_A" "$(node_tunnel_url p1)"
spawn_devserver b "${DS_PORTS[1]}" "$PAT_B" "$(node_tunnel_url p2)"
spawn_devserver d "${DS_PORTS[3]}" "$PAT_D" "$(node_tunnel_url p3)"

if wait_fleet 3 150 && wait_tunnels 2 75; then
    assert_pass "tunnels: three devservers registered, one through each proxy"
else
    assert_fail "tunnels: expected 3 aggregate rows (2 alice), got fleet=$(fleet_count) alice=$(tunnel_count)"
fi

# Ownership: every aggregate row names the proxy that accepted the
# tunnel, with the node base URL identity mints entry origins from.
ownership="$(admin_read /admin/v1/tunnels | jrows devserver_id user proxy_id proxy_base_url | sort)"
expected_ownership="$(printf '%s\n' \
    "$DS_A $ALICE_USER p1 https://p1.$APEX:$PROXY_PORT" \
    "$DS_B $ALICE_USER p2 https://p2.$APEX:$PROXY_PORT" \
    "$DS_D $CAROL_USER p3 https://p3.$APEX:$PROXY_PORT" | sort)"
if [ "$ownership" = "$expected_ownership" ]; then
    assert_pass "tunnels: aggregate rows carry the owning proxy_id and proxy_base_url"
else
    assert_fail "tunnels: ownership rows wrong, got:
$ownership"
fi
per_node="$(admin_read /admin/v1/proxies | jrows proxy_id status tunnel_count | sort | paste -sd' ')"
if [ "$per_node" = "p1 active 1 p2 active 1 p3 active 1" ]; then
    assert_pass "fleet: /admin/v1/proxies reports tunnel_count 1 on every node"
else
    assert_fail "fleet: expected tunnel_count 1 per node, got: $per_node"
fi

# T5 (--tunnel-devserver-name): alice's devservers announced the same
# display name; the gateway persists it as the label (over the PAT
# label) and dedups within the owner with a -2 suffix. The announce is
# an async post-registration follow-up (spaced against the identity
# validate throttle), so poll the rows.
ds_label() { # ds_label <dsid>
    sql "$E2E_DATABASE_URL" "SET search_path TO $E2E_SCHEMA;
        SELECT label FROM devservers WHERE devserver_id = '$1';"
}
labels_ok=0
for _ in $(seq 50); do
    label_a="$(ds_label "$DS_A")"
    label_b="$(ds_label "$DS_B")"
    sorted="$(printf '%s\n%s\n' "$label_a" "$label_b" | sort | paste -sd' ')"
    if [ "$sorted" = "$DS_DISPLAY_NAME $DS_DISPLAY_NAME-2" ]; then
        labels_ok=1
        break
    fi
    sleep 0.4
done
if [ "$labels_ok" = 1 ]; then
    assert_pass "tunnels: same announced name dedups to $DS_DISPLAY_NAME + $DS_DISPLAY_NAME-2"
else
    assert_fail "tunnels: expected labels $DS_DISPLAY_NAME/$DS_DISPLAY_NAME-2, got A='$label_a' B='$label_b'"
fi

# ---------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------

# Follow-up curls hit node wildcard hosts on the owning proxy's
# loopback alias; --resolve pins v4 so a v6-first resolver can't route
# past the per-node binds.
curl_node() { # curl_node <proxy-id> <host> <args...>
    local id="$1" host="$2"
    shift 2
    curl --noproxy '*' --cacert "$TLS_DIR/ca.crt" -sS \
        --resolve "$host:$PROXY_PORT:$(node_ip "$id")" "$@"
}

entry_for() { # entry_for <pat> <json-body> -> desktop entry response body
    curl -sS -X POST "http://127.0.0.1:$ID_INNER_PORT/desktop/v1/devserver/entry" \
        -H "Authorization: Bearer $1" \
        -H "content-type: application/json" \
        -d "$2"
}

json_get() { # json_get <key> (reads object on stdin)
    node -e 'let d="";process.stdin.on("data",c=>c&&(d+=c)).on("end",()=>{try{const v=JSON.parse(d)[process.argv[1]];process.stdout.write(v===undefined?"":String(v))}catch{}})' "$1"
}

post_entry_exchange() { # post_entry_exchange <body> <node> <host> <headers-file>
    local body="$1" node="$2" host="$3" headers="$4" url credential
    url="$(printf %s "$body" | json_get entry_exchange_url)"
    credential="$(printf %s "$body" | json_get entry_credential)"
    [ -n "$url" ] && [ -n "$credential" ] || return 2
    case "$url" in
    "https://$host:$PROXY_PORT/_chan/entry") ;;
    *) return 3 ;;
    esac
    case "$url" in *\?* | *"$credential"*) return 4 ;; esac
    curl_node "$node" "$host" -o /dev/null -w '%{http_code}' -D "$headers" \
        -X POST \
        -H "Origin: https://$ID_HOST" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        --data-urlencode "credential=$credential" \
        "$url"
}

# A: desktop entry with an explicit devserver_id mints on the owning
# node's disc host, and the entry URL routes through that node's
# tunnel (303 cookie mint, then a devserver-served response behind it). The
# harness captures Set-Cookie explicitly so each isolation probe controls the
# exact cookie presented instead of relying on a shared curl jar.
check_entry_routes() { # check_entry_routes <name> <pat> <user> <owner-id> <dsid>
    local name="$1" pat="$2" user="$3" owner_id="$4" dsid="$5"
    local body exchange_url node host hdrs cookie csrf code location location_ok=0
    body="$(entry_for "$pat" "{\"owner_user_id\":\"$owner_id\",\"devserver_id\":\"$dsid\"}")"
    exchange_url="$(printf %s "$body" | json_get entry_exchange_url)"
    node="$(tunnel_field "$dsid" proxy_id)"
    host="$user--$(disc "$dsid").$node.$APEX"
    if [ -z "$exchange_url" ] || [ -z "$node" ]; then
        assert_fail "entry($name): no exchange URL ($body) or no aggregate row for $dsid"
    fi
    case "$exchange_url" in
    "https://$host:$PROXY_PORT/_chan/entry") assert_pass "entry($name): minted on node host $host" ;;
    *) assert_fail "entry($name): expected node exchange host $host, got $exchange_url" ;;
    esac
    hdrs="$WORK/hdrs-$name.txt"
    code="$(post_entry_exchange "$body" "$node" "$host" "$hdrs")" || \
        assert_fail "entry($name): malformed desktop entry response or exchange URL"
    cookie="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-devserver_gate=[^;]*\).*/\1/p' "$hdrs" | head -1)"
    csrf="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-devserver_csrf=[^;]*\).*/\1/p' "$hdrs" | head -1)"
    location="$(sed -n 's/^[Ll]ocation: //p' "$hdrs" | tr -d '\r' | head -1)"
    printf %s "$cookie" > "$WORK/cookie-$name.txt"
    case "$location" in /*) case "$location" in //*) ;; *) location_ok=1 ;; esac ;; esac
    if [ "$code" = "303" ] && [ -n "$cookie" ] && [ -n "$csrf" ] \
        && [[ "$cookie" != *.* ]] && [[ "$csrf" != *.* ]] && [ "$location_ok" = 1 ] \
        && [[ "$location" != *credential* ]] && [[ "$location" != *"$(printf %s "$body" | json_get entry_credential)"* ]]; then
        assert_pass "entry($name): POST exchange mints opaque session/CSRF cookies with a clean relative Location"
    else
        assert_fail "entry($name): expected opaque 303 session and CSRF cookies with clean relative Location, got $code"
    fi
    code="$(curl_node "$node" "$host" -o "$WORK/root-$name.html" -w '%{http_code}' \
        -H "Cookie: $cookie" "https://$host:$PROXY_PORT/")"
    # 200 = launcher SPA served through the tunnel. A chan binary
    # built without the web bundles answers with its own "bundle not
    # built" banner instead; both are devserver-generated responses,
    # so either proves the request crossed
    # host -> proxy -> tunnel -> devserver (the proxy's own 404 is
    # a bare {"error":"not found"}).
    if [ "$code" = "200" ]; then
        assert_pass "entry($name): cookie admits; devserver root serves 200"
    elif grep -qi "bundle not built" "$WORK/root-$name.html"; then
        assert_pass "entry($name): cookie admits; devserver answered ($code no-bundle banner: chan built without web bundles)"
    else
        assert_fail "entry($name): expected the devserver root, got $code: $(head -c 120 "$WORK/root-$name.html")"
    fi
}

# Exercise the browser-facing exchange boundary adversarially with one fresh
# credential. Every rejection happens before consumption; the valid POST then
# succeeds exactly once and its replay is indistinguishable from an unknown
# credential.
check_entry_exchange_boundaries() {
    local body url credential node host code oversized hdrs
    body="$(entry_for "$PAT_A" "{\"owner_user_id\":\"$ALICE_ID\",\"devserver_id\":\"$DS_A\"}")"
    url="$(printf %s "$body" | json_get entry_exchange_url)"
    credential="$(printf %s "$body" | json_get entry_credential)"
    node="$(tunnel_field "$DS_A" proxy_id)"
    host="$ALICE_USER--$(disc "$DS_A").$node.$APEX"
    [ "$url" = "https://$host:$PROXY_PORT/_chan/entry" ] && [ -n "$credential" ] || \
        assert_fail "entry boundary: identity returned a malformed exchange handoff"

    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' \
        "https://$host:$PROXY_PORT/api/health?t=$credential")"
    [ "$code" = 404 ] && assert_pass "entry boundary: URL query credentials never authenticate" || \
        assert_fail "entry boundary: query credential expected 404, got $code"

    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' \
        -H "Origin: https://$ID_HOST" "$url")"
    [ "$code" = 404 ] && assert_pass "entry boundary: exchange is POST-only" || \
        assert_fail "entry boundary: GET expected 404, got $code"

    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' -X POST \
        -H 'Origin: http://attacker.invalid' \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "credential=$credential" "$url")"
    [ "$code" = 403 ] && assert_pass "entry boundary: wrong Origin is forbidden" || \
        assert_fail "entry boundary: wrong Origin expected 403, got $code"

    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' -X POST \
        -H "Origin: https://$ID_HOST" -H 'Origin: http://attacker.invalid' \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "credential=$credential" "$url")"
    [ "$code" = 403 ] && assert_pass "entry boundary: duplicate Origin headers are forbidden" || \
        assert_fail "entry boundary: duplicate Origin expected 403, got $code"

    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' -X POST \
        -H "Origin: https://$ID_HOST" -H 'Content-Type: text/plain' \
        --data-raw "credential=$credential" "$url")"
    [ "$code" = 415 ] && assert_pass "entry boundary: non-form content type is rejected" || \
        assert_fail "entry boundary: text/plain expected 415, got $code"

    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' -X POST \
        -H "Origin: https://$ID_HOST" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "credential=$credential" "$url")"
    [ "$code" = 415 ] && assert_pass "entry boundary: duplicate Content-Type headers are rejected" || \
        assert_fail "entry boundary: duplicate Content-Type expected 415, got $code"

    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' -X POST \
        -H "Origin: https://$ID_HOST" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "credential=$credential" --data-urlencode "credential=$credential" "$url")"
    [ "$code" = 400 ] && assert_pass "entry boundary: duplicate credential fields are rejected" || \
        assert_fail "entry boundary: duplicate credential expected 400, got $code"

    oversized="$(printf 'x%.0s' {1..8193})"
    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' -X POST \
        -H "Origin: https://$ID_HOST" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-raw "credential=$oversized" "$url")"
    [ "$code" = 413 ] && assert_pass "entry boundary: form bodies over 8192 bytes are rejected" || \
        assert_fail "entry boundary: oversized body expected 413, got $code"

    hdrs="$WORK/hdrs-entry-boundary.txt"
    code="$(post_entry_exchange "$body" "$node" "$host" "$hdrs")"
    [ "$code" = 303 ] || assert_fail "entry boundary: valid exchange expected 303, got $code"
    code="$(post_entry_exchange "$body" "$node" "$host" "$hdrs")"
    [ "$code" = 404 ] && assert_pass "entry boundary: credential succeeds once and replay is 404" || \
        assert_fail "entry boundary: replay expected 404, got $code"
}

# The core suite (sections A-I). Skipped when a single scenario is
# requested; the bring-up and its asserts above always run.
if [ "$RUN_CORE" = 1 ]; then

check_entry_routes a "$PAT_A" "$ALICE_USER" "$ALICE_ID" "$DS_A"
check_entry_routes b "$PAT_B" "$ALICE_USER" "$ALICE_ID" "$DS_B"
check_entry_exchange_boundaries

NODE_A="$(tunnel_field "$DS_A" proxy_id)"
NODE_B="$(tunnel_field "$DS_B" proxy_id)"
HOST_A="$ALICE_USER--$(disc "$DS_A").$NODE_A.$APEX"
HOST_B="$ALICE_USER--$(disc "$DS_B").$NODE_B.$APEX"

# B: a cookie minted for devserver A does not admit on B's disc host
# (drv/aud isolation), same 404 shape as unknown.
COOKIE_A="$(cat "$WORK/cookie-a.txt" 2>/dev/null || true)"
if [ -n "$COOKIE_A" ]; then
    code="$(curl_node "$NODE_B" "$HOST_B" -o /dev/null -w '%{http_code}' -H "Cookie: $COOKIE_A" "https://$HOST_B:$PROXY_PORT/x/")"
    if [ "$code" = "404" ]; then
        assert_pass "isolation: devserver A's cookie is 404 on B's disc host"
    else
        assert_fail "isolation: expected 404, got $code"
    fi
else
    assert_fail "isolation: no cookie captured for devserver A"
fi

# C: unknown disc (well-formed, not live) is 404 on the node host.
HOST_U="$ALICE_USER--000000000000.$NODE_A.$APEX"
code="$(curl_node "$NODE_A" "$HOST_U" -o /dev/null -w '%{http_code}' "https://$HOST_U:$PROXY_PORT/x/")"
if [ "$code" = "404" ]; then
    assert_pass "routing: unknown disc host is 404"
else
    assert_fail "routing: unknown disc expected 404, got $code"
fi

# D: the shared apex carries only health/readiness, and the pre-fleet
# bare user host is no longer a routing surface (tenant traffic lives
# on node hosts only): both are 404 on a node listener. The naked
# disc root still bounces to the dashboard.
code="$(curl_node p1 "$APEX" -o /dev/null -w '%{http_code}' "https://$APEX:$PROXY_PORT/x/")"
if [ "$code" = "404" ]; then
    assert_pass "routing: apex host carries no tenant surface (404)"
else
    assert_fail "routing: apex host expected 404, got $code"
fi
HOST_BARE="$ALICE_USER.$APEX"
code="$(curl_node p1 "$HOST_BARE" -o /dev/null -w '%{http_code}' "https://$HOST_BARE:$PROXY_PORT/x/")"
if [ "$code" = "404" ]; then
    assert_pass "routing: bare user host without a node label is 404"
else
    assert_fail "routing: bare user host expected 404, got $code"
fi
loc="$(curl_node "$NODE_A" "$HOST_A" -o /dev/null -w '%{redirect_url}' "https://$HOST_A:$PROXY_PORT/")"
if [ "$loc" = "https://$ID_HOST/workspaces" ]; then
    assert_pass "routing: naked root on $HOST_A bounces to the dashboard"
else
    assert_fail "routing: naked root on $HOST_A expected dashboard, got '$loc'"
fi

# E: node isolation: A's disc host presented to a non-owning node is
# 404 even carrying A's valid gate cookie, because the host's suffix
# names p1 and only p1's listener routes it. The full 3x3 form of
# this check is the matrix scenario.
if [ -n "$COOKIE_A" ]; then
    code="$(curl_node "$NODE_B" "$HOST_A" -o /dev/null -w '%{http_code}' -H "Cookie: $COOKIE_A" "https://$HOST_A:$PROXY_PORT/x/")"
    if [ "$code" = "404" ]; then
        assert_pass "routing: A's node host is 404 on a non-owning node"
    else
        assert_fail "routing: A's host on $NODE_B expected 404, got $code"
    fi
else
    assert_fail "routing: no cookie captured for the cross-node check"
fi

# Controller-routed revocation is exact: invalidate A's opaque session on p1
# without disturbing B's session on p2, with every connected proxy confirming.
COOKIE_B="$(cat "$WORK/cookie-b.txt" 2>/dev/null || true)"
revoke_code="$(curl -sS -o "$WORK/session-revoke.json" -w '%{http_code}' \
    -X POST "http://127.0.0.1:$CTL_ADMIN_PORT/admin/v1/sessions/revoke" \
    -H "Authorization: Bearer $TOK_CONTROL_OPERATOR" \
    -H "Content-Type: application/json" \
    -d "{\"scope\":\"exact\",\"subject_user_id\":\"$ALICE_ID\",\"owner_user_id\":\"$ALICE_ID\",\"devserver_id\":\"$DS_A\"}")"
revoked="$(json_get revoked < "$WORK/session-revoke.json")"
confirmed="$(json_get proxies_confirmed < "$WORK/session-revoke.json")"
if [ "$revoke_code" = "200" ] && [ "$revoked" = "2" ] && [ "$confirmed" = "3" ]; then
    assert_pass "sessions: exact revoke confirmed by all three proxies"
else
    assert_fail "sessions: exact revoke expected 200/revoked=2/confirmed=3, got $revoke_code: $(cat "$WORK/session-revoke.json")"
fi
code_a="$(curl_node "$NODE_A" "$HOST_A" -o /dev/null -w '%{http_code}' \
    -H "Cookie: $COOKIE_A" "https://$HOST_A:$PROXY_PORT/api/health")"
code_b="$(curl_node "$NODE_B" "$HOST_B" -o /dev/null -w '%{http_code}' \
    -H "Cookie: $COOKIE_B" "https://$HOST_B:$PROXY_PORT/api/health")"
if [ "$code_a" = "404" ] && [ "$code_b" = "200" ]; then
    assert_pass "sessions: revoked A is 404 while unrelated B remains admitted"
else
    assert_fail "sessions: exact revoke isolation expected A=404 B=200, got A=$code_a B=$code_b"
fi

# F: share landing `?d=` while signed out stashes and bounces to login.
code_loc="$(curl --noproxy '*' --cacert "$TLS_DIR/ca.crt" -sS \
    --resolve "$ID_NAME:$ID_PORT:127.0.0.1" \
    -o /dev/null -w '%{http_code} %{redirect_url}' \
    "https://$ID_HOST/s/$ALICE_USER?d=$(disc "$DS_A")")"
if [ "$code_loc" = "303 https://$ID_HOST/" ]; then
    assert_pass "share: unauthenticated /s/{owner}?d= bounces to login"
else
    assert_fail "share: expected 303 to /, got '$code_loc'"
fi

# G: cap: a third devserver for the same user is refused at
# MAX_DEVSERVERS_PER_USER=$MAX_DEVSERVERS, decided by the controller
# before HelloAck no matter which node the dial lands on (C dials the
# shared ingress). The live set stays at 2 and never contains C's id.
spawn_devserver c "${DS_PORTS[2]}" "$PAT_C" "$SHIM_TUNNEL_URL"
sleep 4
tunnels_json="$(admin_tunnels)"
n="$(printf %s "$tunnels_json" | grep -o '"devserver_id"' | wc -l)"
if [ "$n" = "2" ] && ! printf %s "$tunnels_json" | grep -q "$DS_C"; then
    assert_pass "cap: third devserver refused at cap $MAX_DEVSERVERS"
else
    assert_fail "cap: expected 2 tunnels without $DS_C, got: $tunnels_json"
fi

# H: kill + reconnect: admin-kill all of alice's tunnels through the
# controller; the devservers redial on their own and the node host
# routes again. Devserver C is stopped first: it is still retrying
# against the cap, and after the kill it could win a slot from A or B
# and flake the re-registration count.
if [ -f "$WORK/pids/ds-c.pid" ]; then
    kill "$(cat "$WORK/pids/ds-c.pid")" 2>/dev/null || true
    rm -f "$WORK/pids/ds-c.pid"
fi
curl -fsS -X POST -H "Authorization: Bearer $TOK_CONTROL_OPERATOR" \
    "http://127.0.0.1:$CTL_ADMIN_PORT/admin/v1/owners/$ALICE_ID/tunnels/kill" >/dev/null
if wait_tunnels 2 150; then
    assert_pass "reconnect: both devservers re-registered after admin kill"
    check_entry_routes a-reconnect "$PAT_A" "$ALICE_USER" "$ALICE_ID" "$DS_A"
else
    assert_fail "reconnect: devservers did not re-register: $(admin_tunnels)"
fi

# ---------------------------------------------------------------
# I: account-mode consent flow in headless Chrome: sign in via the
# stub OAuth, assert the picker-less account consent, read the
# chan:// handoff fragment, redeem the one-time code, then drive the
# roster and a roster-targeted desktop entry with the redeemed
# account PAT.
# ---------------------------------------------------------------

frag_get() { # frag_get <url> <key> -> percent-decoded value
    node -e 'const [u,k]=process.argv.slice(1);const h=u.split("#")[1]||"";
        for(const p of h.split("&")){const [a,...r]=p.split("=");
        if(a===k){console.log(decodeURIComponent(r.join("=").replace(/\+/g," ")));break}}' \
        "$1" "$2"
}

roster_row() { # roster_row <roster-json> <dsid> -> "owner online"
    printf %s "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        const id=process.argv[1];
        try{const r=JSON.parse(d).devservers.find(x=>x.devserver_id===id);
            console.log(r?`${r.owner} ${r.online}`:"")}catch{console.log("")}})' \
        "$2"
}

AUTH_PATH="/desktop/authorize?redirect_uri=chan%3A%2F%2Fauth%2Fcallback&state=e2e-nonce&label=chan-desktop+%40+e2e&scopes=desktop.account&expires_in=2592000"
if [ -x "$CHROME_BIN" ]; then
    # Run from a copy inside the work dir: ESM resolves node_modules
    # (puppeteer-core) relative to the script's own location.
    cp "$REPO/scripts/e2e/gateway-zone-browser.mjs" "$WORK/"
    browser_json="$(CHROME_BIN="$CHROME_BIN" ID_ORIGIN="https://$ID_HOST" \
        AUTH_PATH="$AUTH_PATH" \
        node "$WORK/gateway-zone-browser.mjs" 2> "$LOGS/browser.log")" || browser_json=""
    if [ -z "$browser_json" ]; then
        assert_fail "consent: browser run produced no output (see logs/browser.log)"
    fi
    # radios is an array; count it explicitly (json_get prints
    # node's inspect form for non-strings).
    radios_n="$(printf %s "$browser_json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(String(JSON.parse(d).radios.length))}catch{console.log("-1")}})')"
    consent_text="$(printf %s "$browser_json" | json_get consent_text)"
    handoff="$(printf %s "$browser_json" | json_get handoff_url)"
    if [ "$radios_n" = "0" ]; then
        assert_pass "consent: account consent renders no devserver picker"
    else
        assert_fail "consent: expected 0 devserver radios, found $radios_n"
    fi
    case "$consent_text" in
    *"access to your account on this gateway"*)
        assert_pass "consent: the account copy renders"
        ;;
    *)
        assert_fail "consent: account copy missing (see logs/browser.log)"
        ;;
    esac
    if [ -z "$(frag_get "$handoff" devserver_owner)" ] &&
        [ -z "$(frag_get "$handoff" devserver_id)" ]; then
        assert_pass "consent: fragment carries no devserver_* keys"
    else
        assert_fail "consent: unexpected devserver_* keys: $handoff"
    fi

    # Redeem the one-time code: 200 exactly once, 410 on replay.
    code="$(frag_get "$handoff" code)"
    redeem1="$(curl -sS -o "$WORK/redeem.json" -w '%{http_code}' \
        -X POST "http://127.0.0.1:$ID_INNER_PORT/desktop/authorize/redeem" \
        -H "content-type: application/json" -d "{\"code\":\"$code\"}")"
    redeem2="$(curl -sS -o /dev/null -w '%{http_code}' \
        -X POST "http://127.0.0.1:$ID_INNER_PORT/desktop/authorize/redeem" \
        -H "content-type: application/json" -d "{\"code\":\"$code\"}")"
    if [ "$redeem1" = "200" ] && [ "$redeem2" = "410" ]; then
        assert_pass "redeem: one-time code answers 200 once, 410 on replay"
    else
        assert_fail "redeem: expected 200 then 410, got $redeem1 then $redeem2"
    fi
    browser_pat="$(json_get secret < "$WORK/redeem.json")"

    # The redeemed account PAT reads the roster: own live rows plus
    # bob's claimed share.
    roster_json="$(curl -sS -H "Authorization: Bearer $browser_pat" \
        "http://127.0.0.1:$ID_INNER_PORT/desktop/v1/devservers")"
    row_a="$(roster_row "$roster_json" "$DS_A")"
    if [ "$row_a" = "$ALICE_USER true" ]; then
        assert_pass "roster: redeemed PAT lists devserver A online (owner row)"
    else
        assert_fail "roster: devserver A row wrong: '$row_a' in: $roster_json"
    fi
    row_b="$(roster_row "$roster_json" "$DS_B")"
    if [ "$row_b" = "$ALICE_USER true" ]; then
        assert_pass "roster: redeemed PAT lists devserver B online (owner row)"
    else
        assert_fail "roster: devserver B row wrong: '$row_b' in: $roster_json"
    fi
    row_bob="$(roster_row "$roster_json" "$DS_BOB")"
    if [ "$row_bob" = "$BOB_USER false" ]; then
        assert_pass "roster: bob's claimed binary grant listed (offline)"
    else
        assert_fail "roster: bob share row wrong: '$row_bob' in: $roster_json"
    fi

    # Entry mint targeted from the roster row, then the two-hop
    # routing check (the same shape check_entry_routes uses).
    entry_owner="${row_a%% *}"
    entry_body="$(entry_for "$browser_pat" "{\"owner\":\"$entry_owner\",\"owner_user_id\":\"$ALICE_ID\",\"devserver_id\":\"$DS_A\"}")"
    entry_url="$(printf %s "$entry_body" | json_get entry_exchange_url)"
    if [ -z "$entry_url" ]; then
        assert_fail "redeem: desktop entry with the redeemed PAT failed: $entry_body"
    fi
    # Same two-hop shape as check_entry_routes: capture the Secure
    # cookie ourselves and replay it explicitly.
    hdrs="$WORK/hdrs-browser.txt"
    hop1="$(post_entry_exchange "$entry_body" "$NODE_A" "$HOST_A" "$hdrs")" || \
        assert_fail "redeem: malformed entry exchange response"
    bcookie="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-devserver_gate=[^;]*\).*/\1/p' "$hdrs" | head -1)"
    hop2=""
    if [ "$hop1" = "303" ] && [ -n "$bcookie" ]; then
        hop2="$(curl_node "$NODE_A" "$HOST_A" -o "$WORK/root-browser.html" -w '%{http_code}' \
            -H "Cookie: $bcookie" "https://$HOST_A:$PROXY_PORT/")"
    fi
    if [ "$hop2" = "200" ] ||
        { [ -n "$hop2" ] && grep -qi "bundle not built" "$WORK/root-browser.html"; }; then
        assert_pass "redeem: account PAT opens the roster-picked devserver ($hop2)"
    else
        assert_fail "redeem: entry hops expected 303 then devserver answer, got $hop1/$hop2"
    fi
else
    assert_fail "consent: headless Chrome not found (set E2E_CHROME_BIN)"
fi

fi # RUN_CORE

# ---------------------------------------------------------------
# SCENARIO FUNCTIONS: lanes append scenario_<name>() definitions
# below this marker (and register the name in $SCENARIOS at the top).
# Each function asserts via assert_pass/assert_fail against the
# running stack and must leave the stack usable (clean up what it
# stops/starts).
# ---------------------------------------------------------------

# Scenario: devserver registry sweeper (profile-service). Proves the
# mark/delete cycle against the real stack: a stale never-dialed row
# leaves the owner's list while the live devservers are marked in the
# SAME tick and survive, the swept row's grant cascades away, a
# stopped devserver's row ages out after the retention, and a redial
# after a sweep recreates the row through the tunnel name announce
# (the post-registration create_devserver upsert), labeled from
# --tunnel-devserver-name. Runs profile-service with
# DEVSERVER_RETENTION_MINUTES=1 for the duration, then restores the
# bring-up config and re-inserts whatever the 1-minute window swept.
scenario_sweeper() {
    sweeper_sql() { sql "$E2E_DATABASE_URL" "SET search_path TO $E2E_SCHEMA; $1"; }

    sweeper_owned() { # alice's owned devserver_ids, one per line
        # Fetch and extraction split on purpose: under pipefail an
        # empty list (grep exit 1) would otherwise read as a fetch
        # failure, and a fetch failure must NOT read as an empty list.
        local body
        body="$(curl -fsS -H "Authorization: Bearer $TOK_PROFILE" \
            "http://127.0.0.1:$PROFILE_PORT/v1/users/$ALICE_ID/grants/owned")" || return 1
        printf '%s' "$body" | grep -o '"devserver_id":"[0-9a-f]*"' | cut -d'"' -f4
        return 0
    }

    sweeper_respawn_profile() { # sweeper_respawn_profile [retention-minutes]
        local pid
        pid="$(cat "$WORK/pids/profile.pid" 2>/dev/null)"
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
        for _ in $(seq 25); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.2
        done
        spawn profile env \
            BIND_ADDR="127.0.0.1:$PROFILE_PORT" \
            DATABASE_URL="$DB_URL" \
            CHAN_GATEWAY_MIGRATIONS=external \
            PROFILE_AUTH_TOKEN="$TOK_PROFILE" \
            PROFILE_ADMIN_TOKEN="$TOK_PROFILE_ADMIN" \
            DEVSERVER_PROFILE_ADMIN_TOKEN="$TOK_CONTROL_PROFILE" \
            DEVSERVER_ADMIN_URL="http://127.0.0.1:$CTL_ADMIN_PORT" \
            ${1:+DEVSERVER_RETENTION_MINUTES="$1"} \
            RUST_LOG=info \
            "$GW_BIN/profile-service"
        wait_http profile "http://127.0.0.1:$PROFILE_PORT/healthz" || return 1
        require_alive profile
    }

    sweeper_wait_owned_gone() { # <dsid> [tries]; polls every 2s
        local dsid="$1" tries="${2:-45}" out
        for _ in $(seq "$tries"); do
            # Only a SUCCESSFUL fetch may declare the id gone: during
            # a profile respawn the list is unreachable, not empty.
            if out="$(sweeper_owned)"; then
                printf '%s\n' "$out" | grep -q "^$dsid$" || return 0
            fi
            sleep 2
        done
        return 1
    }

    # Snapshot the registry so the scenario can put back whatever the
    # 1-minute retention sweeps besides its own seeds (unshared offline
    # leftovers like the cap PAT's row; bob's shared row is protected
    # by its grant and survives the sweep).
    sweeper_sql "
        CREATE TABLE sweeper_snap_ds AS SELECT * FROM devservers;
        CREATE TABLE sweeper_snap_grants AS SELECT * FROM devserver_grants;" || {
        assert_fail "sweeper: registry snapshot failed"
    }

    # Two stranded rows, registered long ago and never dialed: one
    # bare, one carrying a grant. The sweeper's authorization invariant
    # (profile/src/sweeper.rs): rows carrying grants are never swept; a
    # grant leaves only through the owner-scoped revocation settlement
    # path, and only then does its parent row become eligible. The bare
    # row doubles as the proof that a tick actually ran before the
    # granted row's survival is asserted.
    local stale_id shared_id grant_id owned_now
    stale_id="$(openssl rand -hex 32)"
    shared_id="$(openssl rand -hex 32)"
    sweeper_sql "
        INSERT INTO devservers (owner_user_id, devserver_id, label, created_at)
        VALUES ('$ALICE_ID', '$stale_id', 'stale-e2e', now() - interval '10 minutes'),
               ('$ALICE_ID', '$shared_id', 'stale-shared-e2e', now() - interval '10 minutes');
        INSERT INTO devserver_grants (owner_user_id, devserver_id, grantee_email)
        VALUES ('$ALICE_ID', '$shared_id', 'e2e-protected@example.com');" || {
        assert_fail "sweeper: stale-row seed failed"
    }

    sweeper_respawn_profile 1 || {
        assert_fail "sweeper: profile restart with retention=1 failed"
    }

    # A tick lands within the first minute: the bare stale row must go,
    # the granted one must survive that same tick, and the two LIVE
    # devservers must be marked and survive (mark-before-delete,
    # observed end to end).
    if sweeper_wait_owned_gone "$stale_id"; then
        assert_pass "sweeper: stale never-dialed row left the owned list"
    else
        assert_fail "sweeper: stale row still listed after retention + tick"
    fi
    if owned_now="$(sweeper_owned)" &&
        printf '%s\n' "$owned_now" | grep -q "^$shared_id$"; then
        assert_pass "sweeper: granted row survived the tick that swept its bare twin"
    else
        assert_fail "sweeper: granted row was swept; grants must protect a row"
    fi

    # Remove the grant through the real owner-scoped delete (the
    # settlement path). The orphaned row is then eligible and the next
    # tick collects it.
    grant_id="$(sweeper_sql "SELECT id FROM devserver_grants
        WHERE devserver_id = '$shared_id' AND owner_user_id = '$ALICE_ID';")"
    if [ -n "$grant_id" ] && curl -fsS -X DELETE -o /dev/null \
        -H "Authorization: Bearer $TOK_PROFILE" \
        "http://127.0.0.1:$PROFILE_PORT/v1/users/$ALICE_ID/grants/$grant_id"; then
        assert_pass "sweeper: grant removed through the owner-scoped delete"
    else
        assert_fail "sweeper: grant delete failed (id '$grant_id')"
    fi
    if sweeper_wait_owned_gone "$shared_id"; then
        assert_pass "sweeper: ungranted row swept on the tick after settlement"
    else
        assert_fail "sweeper: ungranted row still listed after grant removal"
    fi
    if sweeper_owned | grep -q "^$DS_A$"; then
        assert_pass "sweeper: live devserver A survived the sweep tick"
    else
        assert_fail "sweeper: live devserver A vanished from the owned list"
    fi
    local seen_a
    seen_a="$(sweeper_sql "SELECT COUNT(*) FROM devservers
        WHERE devserver_id = '$DS_A' AND last_seen_at IS NOT NULL;")"
    if [ "$seen_a" = "1" ]; then
        assert_pass "sweeper: live devserver A carries a last_seen_at mark"
    else
        assert_fail "sweeper: devserver A has no last_seen_at mark"
    fi

    # Stop devserver B: its registration drops, then the row ages past
    # the retention (backdated so the next tick, at most 60s away,
    # collects it instead of a wall-clock wait).
    if [ -f "$WORK/pids/ds-b.pid" ]; then
        kill "$(cat "$WORK/pids/ds-b.pid")" 2>/dev/null
        rm -f "$WORK/pids/ds-b.pid"
    fi
    if wait_tunnels 1 75; then
        sweeper_sql "UPDATE devservers SET last_seen_at = now() - interval '2 minutes'
            WHERE devserver_id = '$DS_B';"
        if sweeper_wait_owned_gone "$DS_B"; then
            assert_pass "sweeper: stopped devserver's row left the owned list"
        else
            assert_fail "sweeper: stopped devserver B still listed after retention + tick"
        fi
    else
        assert_fail "sweeper: devserver B's tunnel did not drop after kill"
    fi

    # Redial: the tunnel returns and its name announce recreates the
    # registry row (create_devserver upsert), so the roster shows the
    # announced name with no mint in between. The announce is an async
    # post-registration follow-up (spaced against the validate
    # throttle), so poll for the row.
    spawn_devserver b "${DS_PORTS[1]}" "$PAT_B" "$(node_tunnel_url p2)"
    if wait_tunnels 2 150; then
        if ! admin_tunnels | grep -q "$DS_B"; then
            assert_fail "sweeper: redial registered but B's id missing: $(admin_tunnels)"
        fi
        local row_back=0 owned_after
        for _ in $(seq 30); do
            # Absence only counts from a successful fetch.
            if owned_after="$(sweeper_owned)" &&
                printf '%s\n' "$owned_after" | grep -q "^$DS_B$"; then
                row_back=1
                break
            fi
            sleep 1
        done
        if [ "$row_back" = 1 ]; then
            assert_pass "sweeper: redial's name announce recreated B's registry row"
        else
            assert_fail "sweeper: B's row did not come back after the redial announce"
        fi
    else
        assert_fail "sweeper: devserver B did not re-register after redial"
    fi

    # Restore: bring-up profile config (default retention) and every
    # row the 1-minute window swept; devservers before grants (FK).
    sweeper_respawn_profile || {
        assert_fail "sweeper: profile restore restart failed"
    }
    sweeper_sql "
        INSERT INTO devservers SELECT * FROM sweeper_snap_ds s
            WHERE NOT EXISTS (SELECT 1 FROM devservers d
                WHERE d.owner_user_id = s.owner_user_id
                  AND d.devserver_id = s.devserver_id);
        INSERT INTO devserver_grants SELECT * FROM sweeper_snap_grants g
            WHERE NOT EXISTS (SELECT 1 FROM devserver_grants x WHERE x.id = g.id);
        DROP TABLE sweeper_snap_ds;
        DROP TABLE sweeper_snap_grants;" || {
        assert_fail "sweeper: registry restore failed"
    }
    if sweeper_owned | grep -q "^$DS_B$"; then
        assert_pass "sweeper: registry restored (B's row back for later scenarios)"
    else
        assert_fail "sweeper: restore did not bring B's row back"
    fi
}

# Scenario: gateway devserver liveness watchdog (item 5). Holds devserver A's
# window-feed WS through A's owning proxy and proves the pieces the client
# watchdog depends on: the keepalive Ping is answered end to end (the proxy
# bridge forwards Ping/Pong, the devserver's axum /watch auto-pongs), a SIGSTOP'd
# proxy leaves the held socket a half-open zombie -- no Pong AND no onclose --
# while a fresh dial still routes (the dishonest-green asymmetry), and SIGCONT
# heals the socket. The SPA DisconnectOverlay and the desktop Unreachable
# rendering are unit-covered (workspace-app transportHeartbeat/disconnectOverlay,
# chan-desktop entry_from_devserver); this scenario cannot drive a browser
# because the rig's chan is built --no-default-features and serves no SPA bundle,
# so it asserts the server+proxy behaviour those clients sit on.
scenario_watchdog() {
    # A lone-scenario run skips the core suite, so mint devserver A's entry +
    # gate cookie here (the same two-hop check_entry_routes does).
    local host node body entry_url hdrs cookie
    node="$(tunnel_field "$DS_A" proxy_id)"
    host="$ALICE_USER--$(disc "$DS_A").$node.$APEX"
    if [ -z "$node" ]; then
        assert_fail "watchdog: devserver A has no aggregate row"
    fi
    body="$(entry_for "$PAT_A" "{\"owner_user_id\":\"$ALICE_ID\",\"devserver_id\":\"$DS_A\"}")"
    entry_url="$(printf %s "$body" | json_get entry_exchange_url)"
    if [ -z "$entry_url" ]; then
        assert_fail "watchdog: no entry_url minted for devserver A: $body"
    fi
    hdrs="$WORK/hdrs-watchdog.txt"
    post_entry_exchange "$body" "$node" "$host" "$hdrs" >/dev/null || \
        assert_fail "watchdog: entry exchange failed"
    cookie="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-devserver_gate=[^;]*\).*/\1/p' "$hdrs" | head -1)"
    if [ -z "$cookie" ]; then
        assert_fail "watchdog: no gate cookie minted for devserver A"
    fi

    # A fresh dial through the proxy still routes to the devserver (200, or the
    # no-bundle banner from a chan built without web assets) -- the poll-heals
    # path the launcher green dot rides even while a held socket is dead.
    local fresh
    fresh="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' -H "Cookie: $cookie" \
        "https://$host:$PROXY_PORT/")"
    case "$fresh" in
    200 | 404) assert_pass "watchdog: a fresh dial routes to the devserver ($fresh)" ;;
    *) assert_fail "watchdog: fresh dial did not reach the devserver (got $fresh)" ;;
    esac

    # The probe holds the feed WS and drives three phases (alive / proxy SIGSTOP
    # / SIGCONT), reporting per-phase whether a WS Ping is answered and whether
    # onclose fired.
    cat > "$WORK/watchdog-probe.mjs" <<'PROBE'
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(process.env.WORK + "/x.js");
const { WebSocket } = require("ws");
const { WORK, PROXY_IP, PROXY_PORT, PROXY_INNER_PORT, WD_HOST, WD_COOKIE, PROXY_PIDFILE } = process.env;
const PROXY_PID = Number(fs.readFileSync(PROXY_PIDFILE, "utf8").trim());
const log = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Send a WS Ping; resolve true iff a Pong comes back within `ms`.
function pingPong(ws, ms) {
  return new Promise((resolve) => {
    let done = false;
    const onPong = () => { if (!done) { done = true; ws.off("pong", onPong); resolve(true); } };
    ws.on("pong", onPong);
    try { ws.ping(); } catch {}
    setTimeout(() => { if (!done) { done = true; ws.off("pong", onPong); resolve(false); } }, ms);
  });
}
// Dial the proxy's cleartext INNER listener (PROXY_PORT is the TLS
// edge now), the same hop the edge forwards. The hardened WS gate
// demands exactly one Origin equal to `{forwarded_proto}://{aud}`:
// FORWARDED_PROTO=https here, and aud carries the Host header's
// port, so the Origin is what a browser at the edge would send.
const ws = new WebSocket(`ws://${PROXY_IP}:${PROXY_INNER_PORT}/api/library/windows/watch`, {
  headers: {
    Host: `${WD_HOST}:${PROXY_PORT}`,
    Cookie: WD_COOKIE,
    Origin: `https://${WD_HOST}:${PROXY_PORT}`,
  },
});
let firstFrame = false, closed = false;
ws.on("message", () => { firstFrame = true; });
ws.on("close", () => { closed = true; });
ws.on("error", () => {});
const opened = await new Promise((res) => {
  ws.on("open", () => res(true));
  setTimeout(() => res(false), 5000);
});
if (!opened) { log({ SUMMARY: { opened: false } }); process.exit(0); }
await sleep(1000);
const aliveKeepalive = await pingPong(ws, 3000);
log({ phase: "alive", firstFrame, pong: aliveKeepalive });

// Freeze the proxy: the held client<->proxy TCP stays ESTABLISHED (kernel), but
// the frozen app forwards nothing -- the sleep-zombie condition. A few seconds
// here stays well under the controller's heartbeat deadline, so the freeze
// does not read as a control-plane failure.
process.kill(PROXY_PID, "SIGSTOP");
await sleep(1000);
const frozenPong = await pingPong(ws, 4000);
const closedWhileFrozen = closed;
log({ phase: "frozen", pong: frozenPong, closed: closedWhileFrozen });

process.kill(PROXY_PID, "SIGCONT");
await sleep(1500);
const recovered = await pingPong(ws, 5000);
log({ phase: "recovered", pong: recovered });

log({ SUMMARY: {
  opened: true, firstFrame, aliveKeepalive,
  frozenSilent: !frozenPong, frozenNoOnclose: !closedWhileFrozen, recovered,
} });
try { ws.terminate(); } catch {}
process.exit(0);
PROBE

    local out probe="$WORK/watchdog-probe.mjs" probe_ip
    probe_ip="$(node_ip "$node")"
    out="$(env WORK="$WORK" PROXY_IP="$probe_ip" PROXY_PORT="$PROXY_PORT" \
        PROXY_INNER_PORT="$PROXY_INNER_PORT" \
        WD_HOST="$host" WD_COOKIE="$cookie" \
        PROXY_PIDFILE="$WORK/pids/proxy-$node.pid" \
        node "$probe" 2>> "$LOGS/watchdog.log")"
    # Belt and braces: whatever the probe did, make sure the proxy is running
    # again so the stack stays usable for later scenarios / teardown.
    local ppid
    ppid="$(cat "$WORK/pids/proxy-$node.pid" 2>/dev/null)"
    [ -n "$ppid" ] && kill -CONT "$ppid" 2>/dev/null
    :

    local summary
    summary="$(printf %s "$out" | grep '"SUMMARY"' | tail -1)"
    if [ -z "$summary" ]; then
        assert_fail "watchdog: probe produced no summary (see logs/watchdog.log)"
    fi
    wd_field() { # wd_field <key>; prints SUMMARY.<key> from the probe JSON
        printf %s "$summary" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(String(JSON.parse(d).SUMMARY[process.argv[1]]))}catch{console.log("")}})' "$1"
    }

    if [ "$(wd_field opened)" = "true" ]; then
        assert_pass "watchdog: feed WS opened through the proxy"
    else
        assert_fail "watchdog: feed WS did not open through the proxy"
    fi
    [ "$(wd_field firstFrame)" = "true" ] &&
        assert_pass "watchdog: server pushed the window snapshot on connect" ||
        assert_fail "watchdog: no window snapshot frame on connect"
    [ "$(wd_field aliveKeepalive)" = "true" ] &&
        assert_pass "watchdog: keepalive Ping answered through the proxy (server auto-pong)" ||
        assert_fail "watchdog: keepalive Ping got no Pong on a live proxy"
    [ "$(wd_field frozenSilent)" = "true" ] &&
        assert_pass "watchdog: a frozen proxy silences the Ping (the read-deadline trigger)" ||
        assert_fail "watchdog: Ping answered while the proxy was frozen"
    [ "$(wd_field frozenNoOnclose)" = "true" ] &&
        assert_pass "watchdog: the frozen socket is a half-open zombie (no onclose)" ||
        assert_fail "watchdog: onclose fired during the freeze (expected a silent zombie)"
    [ "$(wd_field recovered)" = "true" ] &&
        assert_pass "watchdog: SIGCONT heals the socket (Ping answered again)" ||
        assert_fail "watchdog: socket did not recover after SIGCONT"
}

# Scenario: account-mode roster (browser-free). Mints a
# desktop.account PAT through the operator surface, then proves the
# roster read against the live stack: owned + shared rows with real
# liveness, the online flag flipping as a devserver stops and
# returns, ETag/If-None-Match 304 on an unchanged roster, and entry
# mints with the account PAT for an own live row (two-hop route) and
# the shared offline row (devserver_offline; the live shared mint is
# pinned in tests/desktop_entry.rs). Leaves the stack as found
# (devserver A redialed and online).
scenario_roster() {
    rrow() { # rrow <roster-json> <dsid> -> "owner online"
        printf %s "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
            const id=process.argv[1];
            try{const r=JSON.parse(d).devservers.find(x=>x.devserver_id===id);
                console.log(r?`${r.owner} ${r.online}`:"")}catch{console.log("")}})' \
            "$2"
    }
    roster_get() { # roster_get <outfile> [etag] -> http code; headers to $WORK/roster-hdrs.txt
        curl -sS -o "$1" -w '%{http_code}' -D "$WORK/roster-hdrs.txt" \
            ${2:+-H "If-None-Match: $2"} \
            -H "Authorization: Bearer $ROSTER_PAT" \
            "http://127.0.0.1:$ID_INNER_PORT/desktop/v1/devservers"
    }
    roster_etag() { # the header line is CRLF; strip the CR or the echoed If-None-Match breaks
        tr -d '\r' < "$WORK/roster-hdrs.txt" | sed -n 's/^[Ee][Tt]ag: //p' | head -1
    }

    local out account_dsid
    out="$("$GW_BIN/chan-gateway-admin" \
        --identity-url "http://127.0.0.1:$ID_INTERNAL_PORT" \
        --identity-token "$TOK_IDENTITY_ADMIN" --json \
        token create "$ALICE_EMAIL" \
        --scope desktop.account --label roster-e2e \
        2>> "$LOGS/admin-mint.log")" || out=""
    ROSTER_PAT="$(printf %s "$out" | json_get secret)"
    case "$ROSTER_PAT" in
    chan_pat_*) assert_pass "roster: admin mint of a desktop.account PAT" ;;
    *)
        assert_fail "roster: account PAT mint failed (logs/admin-mint.log)"
        ;;
    esac
    # A PAT is a devserver only when it carries the tunnel scope, so
    # this desktop.account mint registers no row; the id (sha256 of
    # the PAT) must never surface in the roster (asserted below).
    account_dsid="$(printf %s "$ROSTER_PAT" | sha256sum | awk '{print $1}')"

    # A tunnel/connect PAT must not read the roster.
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $PAT_A" \
        "http://127.0.0.1:$ID_INNER_PORT/desktop/v1/devservers")"
    if [ "$code" = "401" ]; then
        assert_pass "roster: tunnel/connect PAT is 401 on the roster"
    else
        assert_fail "roster: expected 401 for a wrong-scope PAT, got $code"
    fi

    local roster_json
    code="$(roster_get "$WORK/roster1.json")"
    roster_json="$(cat "$WORK/roster1.json")"
    if [ "$code" = "200" ]; then
        assert_pass "roster: account PAT reads the roster (200)"
    else
        assert_fail "roster: expected 200, got $code: $roster_json"
    fi
    if [ "$(rrow "$roster_json" "$DS_A")" = "$ALICE_USER true" ]; then
        assert_pass "roster: own live devserver A is online (owner row)"
    else
        assert_fail "roster: devserver A row wrong in: $roster_json"
    fi
    if [ "$(rrow "$roster_json" "$DS_C")" = "$ALICE_USER false" ]; then
        assert_pass "roster: own registered-but-dark devserver C is offline"
    else
        assert_fail "roster: devserver C row wrong in: $roster_json"
    fi
    if [ "$(rrow "$roster_json" "$DS_BOB")" = "$BOB_USER false" ]; then
        assert_pass "roster: bob's claimed binary grant listed (offline)"
    else
        assert_fail "roster: bob share row wrong: '$row_bob' in: $roster_json"
    fi
    if printf %s "$roster_json" | grep -q "$account_dsid"; then
        assert_fail "roster: the account PAT's mint registered a phantom devserver row"
    else
        assert_pass "roster: the account PAT mint registered no devserver row"
    fi

    local etag
    etag="$(roster_etag)"
    if [ -n "$etag" ]; then
        assert_pass "roster: the 200 carries an ETag"
    else
        assert_fail "roster: no ETag header on the roster 200"
    fi
    code="$(roster_get /dev/null "$etag")"
    if [ "$code" = "304" ]; then
        assert_pass "roster: If-None-Match answers 304 on an unchanged roster"
    else
        assert_fail "roster: expected 304 on the unchanged roster, got $code"
    fi

    # Stop devserver A: its row must flip offline (fresh 200s while
    # polling), and the pre-flip ETag must stop matching.
    if [ -f "$WORK/pids/ds-a.pid" ]; then
        kill "$(cat "$WORK/pids/ds-a.pid")" 2>/dev/null
        rm -f "$WORK/pids/ds-a.pid"
    fi
    local flipped=0
    for _ in $(seq 75); do
        code="$(roster_get "$WORK/roster2.json")"
        if [ "$code" = "200" ] &&
            [ "$(rrow "$(cat "$WORK/roster2.json")" "$DS_A")" = "$ALICE_USER false" ]; then
            flipped=1
            break
        fi
        sleep 0.4
    done
    if [ "$flipped" = 1 ]; then
        assert_pass "roster: stopping devserver A flips its row offline"
    else
        assert_fail "roster: devserver A never went offline in the roster"
    fi
    code="$(roster_get /dev/null "$etag")"
    if [ "$code" = "200" ]; then
        assert_pass "roster: the pre-flip ETag reads a fresh 200 after the change"
    else
        assert_fail "roster: stale ETag expected 200, got $code"
    fi

    # Redial devserver A and wait for the flip back so the stack is
    # left as found.
    spawn_devserver a "${DS_PORTS[0]}" "$PAT_A" "$(node_tunnel_url p1)"
    local back=0
    for _ in $(seq 150); do
        code="$(roster_get "$WORK/roster3.json")"
        if [ "$code" = "200" ] &&
            [ "$(rrow "$(cat "$WORK/roster3.json")" "$DS_A")" = "$ALICE_USER true" ]; then
            back=1
            break
        fi
        sleep 0.4
    done
    if [ "$back" = 1 ]; then
        assert_pass "roster: devserver A returns online after redial"
    else
        assert_fail "roster: devserver A did not come back online"
    fi

    # Entry mints with the account PAT: the own live row routes end
    # to end (the same two-hop shape check_entry_routes uses); the
    # shared row is registered but dark, so it answers the
    # devserver_offline reason.
    local entry_body entry_url node hdrs cookie hop1 hop2 host
    entry_body="$(entry_for "$ROSTER_PAT" "{\"owner\":\"$ALICE_USER\",\"owner_user_id\":\"$ALICE_ID\",\"devserver_id\":\"$DS_A\"}")"
    entry_url="$(printf %s "$entry_body" | json_get entry_exchange_url)"
    node="$(tunnel_field "$DS_A" proxy_id)"
    host="$ALICE_USER--$(disc "$DS_A").$node.$APEX"
    if [ -n "$entry_url" ]; then
        hdrs="$WORK/hdrs-roster-entry.txt"
        hop1="$(post_entry_exchange "$entry_body" "$node" "$host" "$hdrs")" || \
            assert_fail "roster: malformed own entry exchange"
        cookie="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-devserver_gate=[^;]*\).*/\1/p' "$hdrs" | head -1)"
        hop2=""
        if [ "$hop1" = "303" ] && [ -n "$cookie" ]; then
            hop2="$(curl_node "$node" "$host" -o "$WORK/root-roster.html" -w '%{http_code}' \
                -H "Cookie: $cookie" "https://$host:$PROXY_PORT/")"
        fi
        if [ "$hop2" = "200" ] ||
            { [ -n "$hop2" ] && grep -qi "bundle not built" "$WORK/root-roster.html"; }; then
            assert_pass "roster: account PAT entry routes to the own devserver ($hop2)"
        else
            assert_fail "roster: entry hops expected 303 then devserver answer, got $hop1/$hop2"
        fi
    else
        assert_fail "roster: entry mint for the own devserver failed: $entry_body"
    fi
    local shared_body shared_reason
    shared_body="$(entry_for "$ROSTER_PAT" "{\"owner\":\"$BOB_USER\",\"owner_user_id\":\"$BOB_ID\",\"devserver_id\":\"$DS_BOB\"}")"
    shared_reason="$(printf %s "$shared_body" | json_get reason)"
    if [ "$shared_reason" = "devserver_offline" ]; then
        assert_pass "roster: shared-row entry answers devserver_offline (box dark)"
    else
        assert_fail "roster: shared-row entry expected devserver_offline, got: $shared_body"
    fi
}

# Scenario: multipart upload through the proxy (the HTTP leg of
# `cs upload` and the SPA's drag-drop upload). The proxy's
# double-submit CSRF guard gates every mutation: a multipart POST to
# `/api/files/upload` carrying only the session cookies must be
# refused with the proxy's own 403 `forbidden` before it reaches the
# tunnel, and the same POST with the `__Host-devserver_csrf` cookie mirrored
# into `x-chan-csrf` (what the SPA's XHR helpers send) must cross
# host -> proxy -> tunnel -> devserver and land the bytes in the
# workspace on disk. Registers a scratch workspace on devserver A
# through the tunnel (owner assertions may mutate; the harness
# devservers bind loopback, so the mutable launcher surface is up)
# and removes it afterwards so the stack is left as found.
scenario_upload() {
    local host node body entry_url hdrs gate csrf cookies
    node="$(tunnel_field "$DS_A" proxy_id)"
    host="$ALICE_USER--$(disc "$DS_A").$node.$APEX"
    body="$(entry_for "$PAT_A" "{\"owner_user_id\":\"$ALICE_ID\",\"devserver_id\":\"$DS_A\"}")"
    entry_url="$(printf %s "$body" | json_get entry_exchange_url)"
    if [ -z "$entry_url" ]; then
        assert_fail "upload: no entry_url minted for devserver A: $body"
    fi
    hdrs="$WORK/hdrs-upload.txt"
    post_entry_exchange "$body" "$node" "$host" "$hdrs" >/dev/null || \
        assert_fail "upload: entry exchange failed"
    gate="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-devserver_gate=[^;]*\).*/\1/p' "$hdrs" | head -1)"
    csrf="$(sed -n 's/^[Ss]et-[Cc]ookie: __Host-devserver_csrf=\([^;]*\).*/\1/p' "$hdrs" | head -1)"
    if [ -n "$gate" ] && [ -n "$csrf" ]; then
        assert_pass "upload: entry 303 mints the gate + csrf cookie pair"
    else
        assert_fail "upload: expected __Host-devserver_gate + __Host-devserver_csrf on the entry 303"
    fi
    cookies="$gate; __Host-devserver_csrf=$csrf"

    # A workspace to upload into: a real folder on the devserver's host
    # (the whole harness shares loopback), registered + mounted through
    # the tunnel. Registration is idempotent, so an aborted earlier run
    # cannot strand this step.
    local ws_dir add_body prefix ws_id
    ws_dir="$WORK/upload-ws"
    rm -rf "$ws_dir"
    mkdir -p "$ws_dir"
    add_body="$(curl_node "$node" "$host" -X POST \
        "https://$host:$PROXY_PORT/api/library/workspaces" \
        -H "Cookie: $cookies" -H "x-chan-csrf: $csrf" \
        -H "content-type: application/json" \
        -d "{\"path\":\"$ws_dir\"}")"
    prefix="$(printf %s "$add_body" | json_get prefix)"
    ws_id="$(printf %s "$add_body" | json_get workspace_id)"
    if [ -n "$prefix" ] && [ -n "$ws_id" ]; then
        assert_pass "upload: workspace registered + mounted through the tunnel"
    else
        assert_fail "upload: workspace add through the tunnel failed: $add_body"
    fi

    # The guard half: no `x-chan-csrf` mirror -> the proxy's own 403
    # `forbidden` (the devserver never sees the request; its errors are
    # JSON-shaped, so the bare body pins the refusal to the proxy).
    local payload code
    payload="$WORK/upload-payload.txt"
    printf 'tunneled upload payload\n' > "$payload"
    code="$(curl_node "$node" "$host" -o "$WORK/upload-noheader.txt" -w '%{http_code}' \
        -X POST "https://$host:$PROXY_PORT/$prefix/api/files/upload" \
        -H "Cookie: $cookies" \
        -F "file=@$payload" -F "dir=")"
    if [ "$code" = "403" ] && grep -q '^forbidden$' "$WORK/upload-noheader.txt"; then
        assert_pass "upload: POST without the csrf mirror is the proxy's 403 forbidden"
    else
        assert_fail "upload: expected 403 forbidden, got $code: $(head -c 120 "$WORK/upload-noheader.txt")"
    fi

    # The fix half: the mirrored header admits the multipart POST and
    # the devserver writes the file into the workspace root.
    local uploaded_path
    code="$(curl_node "$node" "$host" -o "$WORK/upload-ok.json" -w '%{http_code}' \
        -X POST "https://$host:$PROXY_PORT/$prefix/api/files/upload" \
        -H "Cookie: $cookies" -H "x-chan-csrf: $csrf" \
        -F "file=@$payload" -F "dir=")"
    uploaded_path="$(json_get path < "$WORK/upload-ok.json")"
    if [ "$code" = "200" ] && [ -n "$uploaded_path" ]; then
        assert_pass "upload: csrf-mirrored multipart POST answers 200 ($uploaded_path)"
    else
        assert_fail "upload: expected 200 with a path, got $code: $(head -c 200 "$WORK/upload-ok.json")"
    fi
    if [ -n "$uploaded_path" ] && cmp -s "$payload" "$ws_dir/$uploaded_path"; then
        assert_pass "upload: the uploaded bytes landed in the workspace on disk"
    else
        assert_fail "upload: uploaded file missing or differs at $ws_dir/$uploaded_path"
    fi

    # Leave the stack as found: unregister the scratch workspace (the
    # DELETE unmounts first; it is a mutation, so it carries the mirror).
    code="$(curl_node "$node" "$host" -o /dev/null -w '%{http_code}' \
        -X DELETE "https://$host:$PROXY_PORT/api/library/workspaces/$ws_id" \
        -H "Cookie: $cookies" -H "x-chan-csrf: $csrf")"
    if [ "$code" = "204" ] || [ "$code" = "200" ]; then
        assert_pass "upload: scratch workspace removed (stack left as found)"
    else
        assert_fail "upload: scratch workspace removal expected 2xx, got $code"
    fi
}

# Scenario: window close through the tunnel -- chan-desktop's exact close
# sequence for a tunneled devserver window, over HTTP. The desktop's watcher
# reopens any listed record lacking a native window, so a close only sticks
# when the DELETE lands and the record leaves the registry; this pins that
# proxy leg end to end (desktop/src-tauri/src/devserver.rs sends these):
#   session: POST entry exchange -> opaque __Host-devserver_gate + csrf cookies
#   mint:    POST /api/library/windows          (Cookie + X-Chan-CSRF)
#   discard: DELETE /api/library/windows/{id}   (Cookie + X-Chan-CSRF)
#   verify:  GET /api/library/windows           (record gone)
scenario_windowclose() {
    local host node body entry_url hdrs gate csrf cookie code
    node="$(tunnel_field "$DS_A" proxy_id)"
    host="$ALICE_USER--$(disc "$DS_A").$node.$APEX"
    body="$(entry_for "$PAT_A" "{\"owner_user_id\":\"$ALICE_ID\",\"devserver_id\":\"$DS_A\"}")"
    entry_url="$(printf %s "$body" | json_get entry_exchange_url)"
    if [ -z "$entry_url" ]; then
        assert_fail "windowclose: no entry_url minted for devserver A: $body"
    fi
    hdrs="$WORK/hdrs-windowclose.txt"
    code="$(post_entry_exchange "$body" "$node" "$host" "$hdrs")" || \
        assert_fail "windowclose: entry exchange failed"
    gate="$(sed -n 's/^[Ss]et-[Cc]ookie: __Host-devserver_gate=\([^;]*\).*/\1/p' "$hdrs" | head -1)"
    csrf="$(sed -n 's/^[Ss]et-[Cc]ookie: __Host-devserver_csrf=\([^;]*\).*/\1/p' "$hdrs" | head -1)"
    if [ "$code" = "303" ] && [ -n "$gate" ] && [ -n "$csrf" ]; then
        assert_pass "windowclose: entry 303 mints the gate + csrf cookie pair"
    else
        assert_fail "windowclose: expected 303 + both cookies, got $code gate=${gate:+y} csrf=${csrf:+y}"
    fi
    cookie="__Host-devserver_gate=$gate; __Host-devserver_csrf=$csrf"

    # Mint a terminal window through the tunnel (the desktop's
    # mint_library_window shape) and confirm it lists.
    local wid
    code="$(curl_node "$node" "$host" -o "$WORK/windowclose-mint.json" -w '%{http_code}' \
        -X POST -H "Cookie: $cookie" -H "X-Chan-CSRF: $csrf" \
        -H "content-type: application/json" -d '{"kind":"terminal"}' \
        "https://$host:$PROXY_PORT/api/library/windows")"
    wid="$(json_get window_id < "$WORK/windowclose-mint.json")"
    if { [ "$code" = "200" ] || [ "$code" = "201" ]; } && [ -n "$wid" ]; then
        assert_pass "windowclose: window minted through the proxy ($wid)"
    else
        assert_fail "windowclose: mint expected 2xx + window_id, got $code: $(head -c 200 "$WORK/windowclose-mint.json")"
    fi
    curl_node "$node" "$host" -o "$WORK/windowclose-list0.json" -s \
        -H "Cookie: $cookie" "https://$host:$PROXY_PORT/api/library/windows"
    if grep -q "\"$wid\"" "$WORK/windowclose-list0.json"; then
        assert_pass "windowclose: minted record is in the windows list"
    else
        assert_fail "windowclose: minted record missing from list: $(head -c 200 "$WORK/windowclose-list0.json")"
    fi

    # The guard half: a DELETE without the csrf mirror is refused at the
    # proxy (bare-body 403) and the record survives -- so the mirrored
    # header below is what makes the close land.
    code="$(curl_node "$node" "$host" -o "$WORK/windowclose-nocsrf.txt" -w '%{http_code}' \
        -X DELETE -H "Cookie: $cookie" \
        "https://$host:$PROXY_PORT/api/library/windows/$wid")"
    if [ "$code" = "403" ] && grep -q '^forbidden$' "$WORK/windowclose-nocsrf.txt"; then
        assert_pass "windowclose: DELETE without the csrf mirror is the proxy's 403 forbidden"
    else
        assert_fail "windowclose: unmirrored DELETE expected 403 forbidden, got $code: $(head -c 120 "$WORK/windowclose-nocsrf.txt")"
    fi
    curl_node "$node" "$host" -o "$WORK/windowclose-list1.json" -s \
        -H "Cookie: $cookie" "https://$host:$PROXY_PORT/api/library/windows"
    if grep -q "\"$wid\"" "$WORK/windowclose-list1.json"; then
        assert_pass "windowclose: the refused DELETE left the record in place"
    else
        assert_fail "windowclose: record vanished without an admitted DELETE"
    fi

    # The close half: the desktop's DELETE (Cookie + X-Chan-CSRF) lands
    # and the record leaves the next list fetch -- the reconcile has
    # nothing to reopen, so the window stays closed.
    code="$(curl_node "$node" "$host" -o "$WORK/windowclose-del.txt" -w '%{http_code}' \
        -X DELETE -H "Cookie: $cookie" -H "X-Chan-CSRF: $csrf" \
        "https://$host:$PROXY_PORT/api/library/windows/$wid")"
    if [ "$code" = "200" ] || [ "$code" = "204" ]; then
        assert_pass "windowclose: csrf-mirrored DELETE answers $code"
    else
        assert_fail "windowclose: DELETE expected 2xx, got $code: $(head -c 200 "$WORK/windowclose-del.txt")"
    fi
    curl_node "$node" "$host" -o "$WORK/windowclose-list2.json" -s \
        -H "Cookie: $cookie" "https://$host:$PROXY_PORT/api/library/windows"
    if grep -q "\"$wid\"" "$WORK/windowclose-list2.json"; then
        assert_fail "windowclose: record still present after DELETE: $(head -c 200 "$WORK/windowclose-list2.json")"
    else
        assert_pass "windowclose: record gone from the next windows fetch"
    fi
}

# ---------------------------------------------------------------
# Fleet scenarios: the three-proxy matrix, shared-ingress
# distribution, and the controller/proxy failure modes.
# ---------------------------------------------------------------

# mint_gate_cookie <pat> <user> <dsid>: runs the entry two-hop and
# sets MC_NODE / MC_HOST / MC_COOKIE for the owning node. Scenarios
# capture these BEFORE breaking something, because the aggregate row
# they derive from may legitimately be gone afterwards.
mint_gate_cookie() {
    local pat="$1" user="$2" dsid="$3" body entry_url hdrs owner_id
    MC_NODE=""
    MC_HOST=""
    MC_COOKIE=""
    case "$user" in
    "$ALICE_USER") owner_id="$ALICE_ID" ;;
    "$CAROL_USER") owner_id="$CAROL_ID" ;;
    "$DAVE_USER") owner_id="$DAVE_ID" ;;
    *) return 1 ;;
    esac
    body="$(entry_for "$pat" "{\"owner_user_id\":\"$owner_id\",\"devserver_id\":\"$dsid\"}")"
    entry_url="$(printf %s "$body" | json_get entry_exchange_url)"
    MC_NODE="$(tunnel_field "$dsid" proxy_id)"
    [ -n "$entry_url" ] && [ -n "$MC_NODE" ] || return 1
    MC_HOST="$user--$(disc "$dsid").$MC_NODE.$APEX"
    hdrs="$WORK/hdrs-mc-$(disc "$dsid").txt"
    post_entry_exchange "$body" "$MC_NODE" "$MC_HOST" "$hdrs" >/dev/null || return 1
    MC_COOKIE="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-devserver_gate=[^;]*\).*/\1/p' "$hdrs" | head -1)"
    [ -n "$MC_COOKIE" ]
}

node_readyz() { # node_readyz <proxy-id> -> http code of the node's /readyz
    curl --noproxy '*' --cacert "$TLS_DIR/ca.crt" -sS -o /dev/null -w '%{http_code}' \
        --max-time 2 -H "Host: $APEX" \
        "https://$(node_ip "$1"):$PROXY_PORT/readyz" 2>/dev/null || true
}

# Scenario: the 3x3 node matrix plus aggregate admin completeness.
# Every live tunnel is probed through every node: the owning node
# answers 200, both non-owning nodes answer 404 (the host suffix
# names a node they are not, so the request never reaches a gate
# check). Afterwards the aggregate reads must still show exactly the
# fleet the harness placed.
scenario_matrix() {
    local pats=("$PAT_A" "$PAT_B" "$PAT_D")
    local dsids=("$DS_A" "$DS_B" "$DS_D")
    local users=("$ALICE_USER" "$ALICE_USER" "$CAROL_USER")
    local names=(A B D)
    local i id owner host cookie codes expected
    for i in 0 1 2; do
        mint_gate_cookie "${pats[$i]}" "${users[$i]}" "${dsids[$i]}" || {
            assert_fail "matrix: could not mint a gate cookie for devserver ${names[$i]}"
        }
        owner="$MC_NODE"
        host="$MC_HOST"
        cookie="$MC_COOKIE"
        codes=""
        expected=""
        for id in "${PROXY_IDS[@]}"; do
            codes+="$(curl_node "$id" "$host" -o /dev/null -w '%{http_code}' \
                -H "Cookie: $cookie" "https://$host:$PROXY_PORT/api/health") "
            if [ "$id" = "$owner" ]; then expected+="200 "; else expected+="404 "; fi
        done
        codes="${codes% }"
        expected="${expected% }"
        if [ "$codes" = "$expected" ]; then
            assert_pass "matrix: ${names[$i]} on $owner serves 200, the other nodes 404 ($codes)"
        else
            assert_fail "matrix: ${names[$i]} expected '$expected', got '$codes'"
        fi
    done

    # A green matrix can still hide a rejected gateway assertion in a
    # client log (the assertion is verified devserver-side), so poll
    # every client log before trusting the matrix.
    if grep -lhi "assertion" "$LOGS"/ds-*.log 2>/dev/null | grep -q .; then
        grep -hi "assertion" "$LOGS"/ds-*.log | tail -5
        assert_fail "matrix: a devserver client logged an assertion failure"
    else
        assert_pass "matrix: no assertion failures in any devserver client log"
    fi

    # Aggregate completeness: exactly the placed rows, each with the
    # owning proxy, and per-user reads that add up to the same set.
    local agg expected_ids
    agg="$(admin_read /admin/v1/tunnels | jrows devserver_id | sort | paste -sd' ')"
    expected_ids="$(printf '%s\n' "$DS_A" "$DS_B" "$DS_D" | sort | paste -sd' ')"
    if [ "$agg" = "$expected_ids" ]; then
        assert_pass "matrix: /admin/v1/tunnels aggregates exactly the three registrations"
    else
        assert_fail "matrix: aggregate rows wrong: $agg"
    fi
    local alice_n carol_n
    alice_n="$(tunnel_count)"
    carol_n="$(admin_read "/admin/v1/owners/$CAROL_ID/tunnels" | grep -o '"devserver_id"' | wc -l)"
    if [ "$alice_n" = "2" ] && [ "$carol_n" = "1" ]; then
        assert_pass "matrix: per-user reads stay complete across nodes (alice=2 carol=1)"
    else
        assert_fail "matrix: per-user reads wrong (alice=$alice_n carol=$carol_n)"
    fi
    local proxy_rows
    proxy_rows="$(admin_read /admin/v1/proxies | jrows proxy_id status tunnel_count package_version | sort)"
    if [ "$(printf '%s\n' "$proxy_rows" | wc -l)" = "3" ] &&
        printf '%s\n' "$proxy_rows" | awk '$2!="active"||$3!=1||$4==""{f=1} END{exit f}'; then
        assert_pass "matrix: /admin/v1/proxies shows three active rows with versions"
    else
        assert_fail "matrix: proxy rows wrong:
$proxy_rows"
    fi
}

# Scenario: shared-ingress distribution. Two more devservers (carol's
# E, dave's F) dial the round-robin shim on the shared apex, so their
# h2 connections land on different nodes; ownership must then stay
# put (the row's proxy_id and connection fingerprint do not drift), each
# tunnel routes only through its owning node, and an exact admin kill
# evicts the registration on the owning process.
scenario_sharedingress() {
    spawn_devserver e "${DS_PORTS[4]}" "$PAT_E" "$SHIM_TUNNEL_URL"
    spawn_devserver f "${DS_PORTS[5]}" "$PAT_F" "$SHIM_TUNNEL_URL"

    local ne="" nf="" i
    for i in $(seq 150); do
        ne="$(tunnel_field "$DS_E" proxy_id)"
        nf="$(tunnel_field "$DS_F" proxy_id)"
        [ -n "$ne" ] && [ -n "$nf" ] && break
        sleep 0.4
    done
    if [ -z "$ne" ] || [ -z "$nf" ]; then
        assert_fail "sharedingress: E/F did not register through the shared apex (E='$ne' F='$nf')"
    fi
    if [ "$ne" != "$nf" ]; then
        assert_pass "sharedingress: the edge distributed E and F across nodes (E=$ne F=$nf)"
    else
        assert_fail "sharedingress: E and F landed on the same node ($ne); round-robin broken"
    fi

    # Ownership is decided at admission and does not change afterwards.
    local re1 rf1
    re1="$(tunnel_fingerprint "$DS_E")"
    rf1="$(tunnel_fingerprint "$DS_F")"
    sleep 3
    if [ "$(tunnel_fingerprint "$DS_E")" = "$re1" ] &&
        [ "$(tunnel_fingerprint "$DS_F")" = "$rf1" ] &&
        [ "$(tunnel_field "$DS_E" proxy_id)" = "$ne" ] &&
        [ "$(tunnel_field "$DS_F" proxy_id)" = "$nf" ]; then
        assert_pass "sharedingress: ownership stays put after acceptance"
    else
        assert_fail "sharedingress: ownership drifted after acceptance"
    fi

    check_entry_routes sh-e "$PAT_E" "$CAROL_USER" "$CAROL_ID" "$DS_E"
    check_entry_routes sh-f "$PAT_F" "$DAVE_USER" "$DAVE_ID" "$DS_F"

    # E's node host on F's node is 404: distribution did not make
    # every node serve every tunnel.
    local host_e code
    host_e="$CAROL_USER--$(disc "$DS_E").$ne.$APEX"
    code="$(curl_node "$nf" "$host_e" -o /dev/null -w '%{http_code}' "https://$host_e:$PROXY_PORT/api/health")"
    if [ "$code" = "404" ]; then
        assert_pass "sharedingress: E's host is 404 on F's node"
    else
        assert_fail "sharedingress: E's host on $nf expected 404, got $code"
    fi

    # Exact kills route to the owning process only; the rest of the
    # fleet is untouched.
    local kcode
    kcode="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $TOK_CONTROL_OPERATOR" \
        "http://127.0.0.1:$CTL_ADMIN_PORT/admin/v1/tunnels/$CAROL_ID/$DS_E/kill")"
    if [ "$kcode" = "204" ]; then
        assert_pass "sharedingress: exact kill of E confirmed (204)"
    else
        assert_fail "sharedingress: exact kill of E expected 204, got $kcode"
    fi
    kcode="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $TOK_CONTROL_OPERATOR" \
        "http://127.0.0.1:$CTL_ADMIN_PORT/admin/v1/tunnels/$DAVE_ID/$DS_F/kill")"
    if [ "$kcode" = "204" ]; then
        assert_pass "sharedingress: exact kill of F confirmed (204)"
    else
        assert_fail "sharedingress: exact kill of F expected 204, got $kcode"
    fi
    # The 204 confirms the eviction on the owning process, so E's host
    # stops routing immediately; the redialing client cannot beat this
    # probe because it first has to rebuild its tunnel.
    code="$(curl_node "$ne" "$host_e" -o /dev/null -w '%{http_code}' "https://$host_e:$PROXY_PORT/api/health")"
    if [ "$code" = "404" ]; then
        assert_pass "sharedingress: the kill evicted E on its owning node"
    else
        assert_fail "sharedingress: E still routes on $ne after the kill ($code)"
    fi
    # Stop the clients so their automatic redial cannot re-register,
    # then the aggregate converges back to the three steady rows.
    for n in e f; do
        if [ -f "$WORK/pids/ds-$n.pid" ]; then
            kill "$(cat "$WORK/pids/ds-$n.pid")" 2>/dev/null || true
            rm -f "$WORK/pids/ds-$n.pid"
        fi
    done
    local gone=0
    for _ in $(seq 75); do
        if [ -z "$(tunnel_field "$DS_E" proxy_id)" ] && [ -z "$(tunnel_field "$DS_F" proxy_id)" ]; then
            gone=1
            break
        fi
        sleep 0.4
    done
    if [ "$gone" = 1 ] && [ "$(fleet_count)" = "3" ]; then
        assert_pass "sharedingress: only the killed rows left the aggregate"
    else
        assert_fail "sharedingress: aggregate did not return to 3 rows: $(admin_read /admin/v1/tunnels)"
    fi
}

# Scenario: a devserver moves between nodes. Dave's G first registers
# through p1, then a second instance of the SAME PAT dials p2 while
# the p1 instance is frozen (a half-open old connection, the worst
# case for a move: the old side is neither live nor cleanly gone).
# The controller admits the redial, replaces the live row, and
# commands the old registration down; ownership, the entry origin,
# the roster proxy_origin, and the data path must all move to p2
# together. Killing the frozen p1 instance afterwards is the retired
# side's late disconnect: it must not touch the replacement.
scenario_movenode() {
    # The roster read needs a desktop.account PAT (tunnel-scope PATs
    # are 401 there), so mint one for dave first.
    local out move_pat
    out="$("$GW_BIN/chan-gateway-admin" \
        --identity-url "http://127.0.0.1:$ID_INTERNAL_PORT" \
        --identity-token "$TOK_IDENTITY_ADMIN" --json \
        token create "$DAVE_EMAIL" \
        --scope desktop.account --label movenode-e2e \
        2>> "$LOGS/admin-mint.log")" || out=""
    move_pat="$(printf %s "$out" | json_get secret)"
    case "$move_pat" in
    chan_pat_*) assert_pass "movenode: admin mint of dave's account PAT" ;;
    *) assert_fail "movenode: account PAT mint failed (logs/admin-mint.log)" ;;
    esac
    move_origin() { # move_origin <roster-json> -> "online proxy_origin" for DS_G
        printf %s "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
            const id=process.argv[1];
            try{const r=JSON.parse(d).devservers.find(x=>x.devserver_id===id);
                console.log(r?`${r.online} ${r.proxy_origin}`:"")}catch{console.log("")}})' \
            "$DS_G"
    }
    move_roster() {
        curl -sS -H "Authorization: Bearer $move_pat" \
            "http://127.0.0.1:$ID_INNER_PORT/desktop/v1/devservers"
    }
    local want_p1 want_p2
    want_p1="true https://$DAVE_USER--$(disc "$DS_G").p1.$APEX:$PROXY_PORT"
    want_p2="true https://$DAVE_USER--$(disc "$DS_G").p2.$APEX:$PROXY_PORT"

    # Phase 1: G registers through p1 and everything names p1.
    spawn_devserver g "${DS_PORTS[6]}" "$PAT_G" "$(node_tunnel_url p1)"
    local node="" code fp
    for _ in $(seq 150); do
        node="$(tunnel_field "$DS_G" proxy_id)"
        [ "$node" = "p1" ] && break
        sleep 0.4
    done
    if [ "$node" = "p1" ] &&
        [ "$(tunnel_field "$DS_G" proxy_base_url)" = "https://p1.$APEX:$PROXY_PORT" ]; then
        assert_pass "movenode: G registered through p1 with p1's base URL"
    else
        assert_fail "movenode: G did not register on p1 (node='$node')"
    fi
    if [ "$(move_origin "$(move_roster)")" = "$want_p1" ]; then
        assert_pass "movenode: roster proxy_origin names p1's node origin"
    else
        assert_fail "movenode: roster proxy_origin wrong on p1: $(move_origin "$(move_roster)")"
    fi
    mint_gate_cookie "$PAT_G" "$DAVE_USER" "$DS_G" ||
        assert_fail "movenode: no entry mint for G on p1"
    if [ "$MC_NODE" = "p1" ]; then
        assert_pass "movenode: entry mints on p1's node host"
    else
        assert_fail "movenode: entry minted on '$MC_NODE', expected p1"
    fi
    code="$(curl_node p1 "$MC_HOST" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $MC_COOKIE" "https://$MC_HOST:$PROXY_PORT/api/health")"
    if [ "$code" = "200" ]; then
        assert_pass "movenode: G answers 200 on p1"
    else
        assert_fail "movenode: G on p1 expected 200, got $code"
    fi
    local host_p1="$MC_HOST" cookie_p1="$MC_COOKIE"

    # Phase 2: freeze the p1 instance, then the same PAT dials p2.
    # Freezing instead of killing keeps the old connection half-open,
    # so the controller sees a genuinely live duplicate and has to
    # command the old registration down; a frozen client also cannot
    # redial and flap ownership back while the move is asserted.
    local gpid
    gpid="$(cat "$WORK/pids/ds-g.pid")"
    kill -STOP "$gpid" 2>/dev/null
    spawn_devserver g2 "${DS_PORTS[7]}" "$PAT_G" "$(node_tunnel_url p2)"
    local flipped=0
    for _ in $(seq 150); do
        [ "$(tunnel_field "$DS_G" proxy_id)" = "p2" ] && {
            flipped=1
            break
        }
        sleep 0.4
    done
    if [ "$flipped" = 1 ] &&
        [ "$(tunnel_field "$DS_G" proxy_base_url)" = "https://p2.$APEX:$PROXY_PORT" ]; then
        assert_pass "movenode: ownership moved to p2 on the redial"
    else
        assert_fail "movenode: ownership never moved to p2"
    fi
    local rows_for_g
    rows_for_g="$(admin_read /admin/v1/tunnels | grep -o "$DS_G" | wc -l)"
    if [ "$rows_for_g" = "1" ]; then
        assert_pass "movenode: exactly one aggregate row exists for the moved devserver"
    else
        assert_fail "movenode: expected 1 row for G, found $rows_for_g"
    fi
    mint_gate_cookie "$PAT_G" "$DAVE_USER" "$DS_G" ||
        assert_fail "movenode: no entry mint for G after the move"
    if [ "$MC_NODE" = "p2" ]; then
        assert_pass "movenode: entry mints on p2's node host after the move"
    else
        assert_fail "movenode: post-move entry minted on '$MC_NODE', expected p2"
    fi
    code="$(curl_node p2 "$MC_HOST" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $MC_COOKIE" "https://$MC_HOST:$PROXY_PORT/api/health")"
    if [ "$code" = "200" ]; then
        assert_pass "movenode: the data path moved to p2 (200)"
    else
        assert_fail "movenode: G on p2 expected 200, got $code"
    fi
    code="$(curl_node p1 "$MC_HOST" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $MC_COOKIE" "https://$MC_HOST:$PROXY_PORT/api/health")"
    if [ "$code" = "404" ]; then
        assert_pass "movenode: p2's node host is 404 on p1"
    else
        assert_fail "movenode: G's new host on p1 expected 404, got $code"
    fi
    code="$(curl_node p1 "$host_p1" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $cookie_p1" "https://$host_p1:$PROXY_PORT/api/health")"
    if [ "$code" = "404" ]; then
        assert_pass "movenode: p1 no longer serves the moved devserver (404)"
    else
        assert_fail "movenode: G's old host on p1 expected 404, got $code"
    fi
    if [ "$(move_origin "$(move_roster)")" = "$want_p2" ]; then
        assert_pass "movenode: roster proxy_origin flipped to p2's node origin"
    else
        assert_fail "movenode: roster proxy_origin wrong after the move: $(move_origin "$(move_roster)")"
    fi

    # Phase 3: the retired side's late disconnect. The frozen p1
    # instance dies now, after the replacement owns the key; whatever
    # teardown its half-open connection produces must not remove the
    # p2 registration (downs are targeted by registration UUID).
    fp="$(tunnel_fingerprint "$DS_G")"
    kill -KILL "$gpid" 2>/dev/null
    rm -f "$WORK/pids/ds-g.pid"
    sleep 3
    if [ "$(tunnel_fingerprint "$DS_G")" = "$fp" ] &&
        [ "$(tunnel_field "$DS_G" proxy_id)" = "p2" ]; then
        assert_pass "movenode: late teardown from the retired side cannot remove the replacement"
    else
        assert_fail "movenode: the p2 registration did not survive the retired side's teardown"
    fi
    code="$(curl_node p2 "$MC_HOST" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $MC_COOKIE" "https://$MC_HOST:$PROXY_PORT/api/health")"
    if [ "$code" = "200" ]; then
        assert_pass "movenode: the replacement still routes after the late disconnect"
    else
        assert_fail "movenode: G on p2 after the late disconnect expected 200, got $code"
    fi

    # Leave the stack as found: stop the moved instance and let its
    # row drain so the fleet returns to the steady three.
    if [ -f "$WORK/pids/ds-g2.pid" ]; then
        kill "$(cat "$WORK/pids/ds-g2.pid")" 2>/dev/null || true
        rm -f "$WORK/pids/ds-g2.pid"
    fi
    local drained=0
    for _ in $(seq 75); do
        [ -z "$(tunnel_field "$DS_G" proxy_id)" ] && {
            drained=1
            break
        }
        sleep 0.4
    done
    if [ "$drained" = 1 ] && [ "$(fleet_count)" = "3" ]; then
        assert_pass "movenode: G's row drained; the fleet is back to the steady three"
    else
        assert_fail "movenode: G's row did not drain after stopping the client"
    fi
}

# Scenario: controller restart. The controller is killed and
# immediately respawned: admin reads hold 503 through the new
# convergence window, the reconnecting proxies' snapshots cancel
# their local eviction timers before the 30s grace expires, the fleet
# reconstructs every owner, and the existing tunnels survive (the
# reconstructed rows keep the same connection fingerprints; a redial
# would change both peer address and connect time).
scenario_ctlrestart() {
    local reg_a reg_b reg_d
    reg_a="$(tunnel_fingerprint "$DS_A")"
    reg_b="$(tunnel_fingerprint "$DS_B")"
    reg_d="$(tunnel_fingerprint "$DS_D")"
    if [ -z "$reg_a" ] || [ -z "$reg_b" ] || [ -z "$reg_d" ]; then
        assert_fail "ctlrestart: missing pre-restart aggregate rows"
    fi
    mint_gate_cookie "$PAT_A" "$ALICE_USER" "$DS_A" ||
        assert_fail "ctlrestart: could not mint a pre-restart cookie for A"
    local host_a="$MC_HOST" node_a="$MC_NODE" cookie_a="$MC_COOKIE"

    local pid
    pid="$(cat "$WORK/pids/controller.pid")"
    kill "$pid" 2>/dev/null
    for _ in $(seq 25); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
    done
    rm -f "$WORK/pids/controller.pid"
    spawn_controller

    local saw_readyz_503=0 saw_tunnels_503=0 mid="" code tcode i
    for i in $(seq 220); do
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 \
            "http://127.0.0.1:$CTL_ADMIN_PORT/readyz" 2>/dev/null || true)"
        [ "$code" = "503" ] && saw_readyz_503=1
        if [ "$saw_tunnels_503" = 0 ]; then
            tcode="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 \
                -H "Authorization: Bearer $TOK_CONTROL_OPERATOR" \
                "http://127.0.0.1:$CTL_ADMIN_PORT/admin/v1/tunnels" 2>/dev/null || true)"
            [ "$tcode" = "503" ] && saw_tunnels_503=1
        fi
        # A traffic probe about 8s into convergence: the data plane
        # never depends on the controller.
        if [ "$i" = 20 ] && [ -z "$mid" ]; then
            mid="$(curl_node "$node_a" "$host_a" -o /dev/null -w '%{http_code}' \
                -H "Cookie: $cookie_a" "https://$host_a:$PROXY_PORT/api/health")"
        fi
        [ "$code" = "200" ] && break
        sleep 0.4
    done
    if [ "$code" != "200" ]; then
        assert_fail "ctlrestart: controller did not converge (last readyz $code)"
    fi
    if [ "$saw_readyz_503" = 1 ]; then
        assert_pass "ctlrestart: /readyz held 503 during convergence"
    else
        assert_fail "ctlrestart: /readyz never read 503 during convergence"
    fi
    if [ "$saw_tunnels_503" = 1 ]; then
        assert_pass "ctlrestart: aggregate reads held 503 during convergence"
    else
        assert_fail "ctlrestart: /admin/v1/tunnels never read 503 during convergence"
    fi
    if [ "$mid" = "200" ]; then
        assert_pass "ctlrestart: existing traffic routed mid-convergence"
    else
        assert_fail "ctlrestart: mid-convergence traffic probe expected 200, got $mid"
    fi

    if wait_fleet 3 75; then
        assert_pass "ctlrestart: the fleet reconstructed all three owners"
    else
        assert_fail "ctlrestart: aggregate did not rebuild to 3 rows"
    fi
    if [ "$(tunnel_fingerprint "$DS_A")" = "$reg_a" ] &&
        [ "$(tunnel_fingerprint "$DS_B")" = "$reg_b" ] &&
        [ "$(tunnel_fingerprint "$DS_D")" = "$reg_d" ]; then
        assert_pass "ctlrestart: snapshots cancelled eviction; no registration died"
    else
        assert_fail "ctlrestart: connection fingerprints changed across the restart"
    fi
    local per_node
    per_node="$(admin_read /admin/v1/proxies | jrows proxy_id status tunnel_count | sort | paste -sd' ')"
    if [ "$per_node" = "p1 active 1 p2 active 1 p3 active 1" ]; then
        assert_pass "ctlrestart: proxy rows rebuilt with one tunnel each"
    else
        assert_fail "ctlrestart: proxy rows wrong after restart: $per_node"
    fi
    check_entry_routes ctlrestart-a "$PAT_A" "$ALICE_USER" "$ALICE_ID" "$DS_A"
}

# Scenario: one proxy's control stream drops. Killing relay-p2
# severs exactly p2's stream: p2 goes unready and refuses new
# admission immediately, p1/p3 stay ready, p2's existing traffic
# survives inside its 30s grace, the controller drops the dead
# session's rows while p1/p3 rows remain, and after grace p2 evicts
# its registrations. Healing the relay lets p2 rejoin and B redial.
scenario_proxydown() {
    mint_gate_cookie "$PAT_B" "$ALICE_USER" "$DS_B" ||
        assert_fail "proxydown: could not mint a pre-disconnect cookie for B"
    local host_b="$MC_HOST" node_b="$MC_NODE" cookie_b="$MC_COOKIE"
    if [ "$node_b" != "p2" ]; then
        assert_fail "proxydown: B is expected on p2, found on '$node_b'"
    fi

    local pid
    pid="$(cat "$WORK/pids/relay-p2.pid")"
    kill "$pid" 2>/dev/null
    rm -f "$WORK/pids/relay-p2.pid"
    log "proxydown: relay-p2 killed; p2's control stream is dead"

    local unready=0 code i
    for _ in $(seq 75); do
        code="$(node_readyz p2)"
        [ "$code" = "503" ] && {
            unready=1
            break
        }
        sleep 0.2
    done
    if [ "$unready" = 1 ]; then
        assert_pass "proxydown: p2 goes unready as soon as its control stream drops"
    else
        assert_fail "proxydown: p2 still reports ready without a control stream"
    fi
    for i in p1 p3; do
        code="$(node_readyz "$i")"
        if [ "$code" = "200" ]; then
            assert_pass "proxydown: $i stays ready"
        else
            assert_fail "proxydown: $i expected ready, got $code"
        fi
    done

    # Inside grace the data path is untouched. Probed FIRST, seconds
    # after the stream death: the admission and aggregate-drain polls
    # below can legitimately consume most of the 30s grace window.
    code="$(curl_node p2 "$host_b" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $cookie_b" "https://$host_b:$PROXY_PORT/api/health")"
    if [ "$code" = "200" ]; then
        assert_pass "proxydown: p2 traffic survives inside the grace window"
    else
        assert_fail "proxydown: B inside grace expected 200, got $code"
    fi

    # New admission on the disconnected node is refused: G dials p2
    # directly and never appears in the aggregate.
    spawn_devserver g "${DS_PORTS[6]}" "$PAT_G" "$(node_tunnel_url p2)"
    sleep 6
    if [ -z "$(tunnel_field "$DS_G" proxy_id)" ]; then
        assert_pass "proxydown: p2 refuses new admission while disconnected"
    else
        assert_fail "proxydown: G was admitted on a disconnected p2"
    fi
    if [ -f "$WORK/pids/ds-g.pid" ]; then
        kill "$(cat "$WORK/pids/ds-g.pid")" 2>/dev/null || true
        rm -f "$WORK/pids/ds-g.pid"
    fi

    # Only p2's registrations leave the aggregate.
    local gone=0
    for _ in $(seq 50); do
        [ -z "$(tunnel_field "$DS_B" proxy_id)" ] && {
            gone=1
            break
        }
        sleep 0.4
    done
    if [ "$gone" = 1 ] && [ "$(tunnel_field "$DS_A" proxy_id)" = "p1" ] &&
        [ "$(tunnel_field "$DS_D" proxy_id)" = "p3" ]; then
        assert_pass "proxydown: only p2's registrations left the aggregate"
    else
        assert_fail "proxydown: aggregate rows wrong after the disconnect"
    fi

    # After the 30s grace p2 evicts everything it owns.
    local evicted=0
    for _ in $(seq 175); do
        code="$(curl_node p2 "$host_b" -o /dev/null -w '%{http_code}' \
            -H "Cookie: $cookie_b" "https://$host_b:$PROXY_PORT/api/health")"
        [ "$code" = "404" ] && {
            evicted=1
            break
        }
        sleep 0.4
    done
    if [ "$evicted" = 1 ]; then
        assert_pass "proxydown: p2 evicted its registrations after grace"
    else
        assert_fail "proxydown: B still routes on p2 well past grace (last $code)"
    fi

    # Heal: the relay returns, p2 rejoins, B redials and is admitted.
    spawn "relay-p2" node "$WORK/tcp-shim.mjs" \
        "127.0.0.1:$(node_relay_port p2)" "127.0.0.1:$CTL_PROXY_PORT"
    if wait_ready proxy-p2 "https://$(node_ip p2):$PROXY_PORT/readyz" "$APEX"; then
        assert_pass "proxydown: p2 rejoined the fleet after the relay healed"
    else
        assert_fail "proxydown: p2 did not rejoin after the relay healed"
    fi
    local back=0
    for _ in $(seq 200); do
        [ "$(tunnel_field "$DS_B" proxy_id)" = "p2" ] && {
            back=1
            break
        }
        sleep 0.4
    done
    if [ "$back" = 1 ] && [ "$(fleet_count)" = "3" ]; then
        assert_pass "proxydown: B re-registered on p2; the fleet is whole again"
    else
        assert_fail "proxydown: B did not re-register on p2"
    fi
    code="$(curl_node p2 "$host_b" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $cookie_b" "https://$host_b:$PROXY_PORT/api/health")"
    if [ "$code" = "404" ]; then
        assert_pass "proxydown: pre-partition opaque session stays revoked after B returns"
    else
        assert_fail "proxydown: pre-partition session revived after recovery (got $code)"
    fi
    mint_gate_cookie "$PAT_B" "$ALICE_USER" "$DS_B" || \
        assert_fail "proxydown: could not mint a fresh post-recovery session"
    code="$(curl_node p2 "$MC_HOST" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $MC_COOKIE" "https://$MC_HOST:$PROXY_PORT/api/health")"
    if [ "$code" = "200" ]; then
        assert_pass "proxydown: fresh post-recovery session is admitted"
    else
        assert_fail "proxydown: fresh post-recovery session expected 200, got $code"
    fi
}

# Scenario: controller outage. The controller is killed and stays
# down past the grace window: every proxy goes unready, new admission
# stops fleet-wide, identity fails closed without fleet state,
# existing traffic survives inside grace, and after grace every proxy
# evicts its registrations. Restarting the controller then rebuilds
# the fleet from reconnecting proxies and redialing clients.
scenario_ctloutage() {
    mint_gate_cookie "$PAT_A" "$ALICE_USER" "$DS_A" ||
        assert_fail "ctloutage: could not mint a pre-outage cookie for A"
    local host_a="$MC_HOST" node_a="$MC_NODE" cookie_a="$MC_COOKIE"

    local pid
    pid="$(cat "$WORK/pids/controller.pid")"
    kill "$pid" 2>/dev/null
    for _ in $(seq 25); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
    done
    rm -f "$WORK/pids/controller.pid"
    log "ctloutage: controller is down and stays down past grace"

    # Every proxy goes unready once its control stream dies.
    local id code unready_n
    unready_n=0
    for _ in $(seq 75); do
        unready_n=0
        for id in "${PROXY_IDS[@]}"; do
            [ "$(node_readyz "$id")" = "503" ] && unready_n=$((unready_n + 1))
        done
        [ "$unready_n" = 3 ] && break
        sleep 0.2
    done
    if [ "$unready_n" = 3 ]; then
        assert_pass "ctloutage: all three proxies go unready without the controller"
    else
        assert_fail "ctloutage: only $unready_n/3 proxies went unready"
    fi

    # Existing traffic survives inside the grace window. Probed FIRST,
    # seconds after the outage: the admission checks below eat into
    # the 30s grace.
    code="$(curl_node "$node_a" "$host_a" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $cookie_a" "https://$host_a:$PROXY_PORT/api/health")"
    if [ "$code" = "200" ]; then
        assert_pass "ctloutage: existing traffic survives inside grace"
    else
        assert_fail "ctloutage: A inside grace expected 200, got $code"
    fi

    # Admission stops fleet-wide (G dials p1 directly and cannot
    # register), and identity fails closed: no fleet state, no entry.
    spawn_devserver g "${DS_PORTS[6]}" "$PAT_G" "$(node_tunnel_url p1)"
    sleep 6
    local ebody
    ebody="$(entry_for "$PAT_A" "{\"owner_user_id\":\"$ALICE_ID\",\"devserver_id\":\"$DS_A\"}")"
    if [ -z "$(printf %s "$ebody" | json_get entry_exchange_url)" ]; then
        assert_pass "ctloutage: identity mints no entry without fleet state"
    else
        assert_fail "ctloutage: identity minted an entry during the outage: $ebody"
    fi

    # Past grace every proxy evicts what it owns.
    local evicted=0
    for _ in $(seq 175); do
        code="$(curl_node "$node_a" "$host_a" -o /dev/null -w '%{http_code}' \
            -H "Cookie: $cookie_a" "https://$host_a:$PROXY_PORT/api/health")"
        [ "$code" = "404" ] && {
            evicted=1
            break
        }
        sleep 0.4
    done
    if [ "$evicted" = 1 ]; then
        assert_pass "ctloutage: proxies evicted their registrations after grace"
    else
        assert_fail "ctloutage: A still routes on $node_a well past grace (last $code)"
    fi
    if [ -f "$WORK/pids/ds-g.pid" ]; then
        kill "$(cat "$WORK/pids/ds-g.pid")" 2>/dev/null || true
        rm -f "$WORK/pids/ds-g.pid"
    fi

    # Recovery: the controller returns, proxies rejoin with empty
    # snapshots, the redialing clients are re-admitted after
    # convergence, and G never appears.
    spawn_controller
    if wait_ready controller "http://127.0.0.1:$CTL_ADMIN_PORT/readyz"; then
        assert_pass "ctloutage: controller reconverged after the outage"
    else
        assert_fail "ctloutage: controller did not reconverge"
    fi
    if wait_fleet 3 300; then
        assert_pass "ctloutage: clients re-registered after recovery"
    else
        assert_fail "ctloutage: fleet did not rebuild to 3 rows after recovery"
    fi
    local owners
    owners="$(admin_read /admin/v1/tunnels | jrows devserver_id proxy_id | sort)"
    if [ "$(printf '%s\n' "$owners" | awk -v a="$DS_A" '$1==a{print $2}')" = "p1" ] &&
        [ "$(printf '%s\n' "$owners" | awk -v b="$DS_B" '$1==b{print $2}')" = "p2" ] &&
        [ "$(printf '%s\n' "$owners" | awk -v d="$DS_D" '$1==d{print $2}')" = "p3" ]; then
        assert_pass "ctloutage: ownership rebuilt on the original nodes"
    else
        assert_fail "ctloutage: ownership wrong after recovery:
$owners"
    fi
    if [ -z "$(tunnel_field "$DS_G" proxy_id)" ]; then
        assert_pass "ctloutage: the outage admitted nothing (G never registered)"
    else
        assert_fail "ctloutage: G registered during the outage"
    fi
    check_entry_routes ctloutage-a "$PAT_A" "$ALICE_USER" "$ALICE_ID" "$DS_A"
}

# Scenario: product control plane. Exercises durable per-user policy, signed
# limits, session inventory and revocation, account cuts, fleet pause
# persistence, and aggregate reports against the three real proxies.
scenario_ctrlplane() {
    local cp_log="$LOGS/ctrlplane-admin.log"
    : > "$cp_log"

    cp_stop() {
        local name="$1" pid
        [ -f "$WORK/pids/$name.pid" ] || return 0
        pid="$(cat "$WORK/pids/$name.pid")"
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 25); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.2
        done
        rm -f "$WORK/pids/$name.pid"
    }

    cp_policy_value() {
        node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d).policy[process.argv[1]];process.stdout.write(String(v))}catch{}})' "$1"
    }

    cp_unrevoked_tokens() {
        node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).filter(x=>x.revoked_at===null).length)}catch{console.log(-1)}})'
    }

    cp_oauth_rows() {
        admin_json session oauth ps --user "$ERIN_EMAIL" 2>> "$cp_log"
    }

    cp_run_oauth_login() {
        cp "$REPO/scripts/e2e/gateway-zone-browser.mjs" "$WORK/"
        CHROME_BIN="$CHROME_BIN" ID_ORIGIN="https://$ID_HOST" LOGIN_ONLY=1 \
            node "$WORK/gateway-zone-browser.mjs" >> "$LOGS/ctrlplane-browser.log" 2>&1
    }

    # The core suite runs with the two-slot deployment ceiling. Raise it to
    # three for this isolated scenario, then reconstruct controller authority.
    MAX_DEVSERVERS=3
    cp_stop controller
    spawn_controller
    if wait_ready controller "http://127.0.0.1:$CTL_ADMIN_PORT/readyz"; then
        assert_pass "ctrlplane: controller reconverged with deployment ceiling 3"
    else
        assert_fail "ctrlplane: controller did not reconverge with deployment ceiling 3"
    fi

    local policy
    policy="$(admin_json policy set "$ERIN_EMAIL" --enabled \
        --max-connected-devservers 3 2>> "$cp_log")" ||
        assert_fail "ctrlplane: policy set to three failed"
    if [ "$(printf %s "$policy" | cp_policy_value enabled)" = "true" ] &&
        [ "$(printf %s "$policy" | cp_policy_value max_connected_devservers)" = "3" ]; then
        assert_pass "ctrlplane: durable user policy set enabled with limit 3"
    else
        assert_fail "ctrlplane: policy response did not contain enabled limit 3: $policy"
    fi

    local CP_PAT1 CP_PAT2 CP_PAT3 CP_PAT4 CP_DS1 CP_DS2 CP_DS3 CP_DS4
    if mint_into "$ERIN_EMAIL" ctrlplane-1 CP_PAT1 CP_DS1 &&
        mint_into "$ERIN_EMAIL" ctrlplane-2 CP_PAT2 CP_DS2 &&
        mint_into "$ERIN_EMAIL" ctrlplane-3 CP_PAT3 CP_DS3 &&
        mint_into "$ERIN_EMAIL" ctrlplane-4 CP_PAT4 CP_DS4; then
        assert_pass "ctrlplane: four distinct PATs minted under enabled policy"
    else
        assert_fail "ctrlplane: PAT mint under enabled policy failed"
    fi

    spawn_devserver cp1 "${DS_PORTS[7]}" "$CP_PAT1" "$(node_tunnel_url p1)"
    spawn_devserver cp2 "${DS_PORTS[8]}" "$CP_PAT2" "$(node_tunnel_url p2)"
    spawn_devserver cp3 "${DS_PORTS[9]}" "$CP_PAT3" "$(node_tunnel_url p3)"
    if wait_owner_tunnels "$ERIN_ID" 3 200; then
        local cp_nodes
        cp_nodes="$(owner_tunnels "$ERIN_ID" | jrows proxy_id | sort | paste -sd' ')"
        if [ "$cp_nodes" = "p1 p2 p3" ]; then
            assert_pass "ctrlplane: three devservers admitted across all three proxies"
        else
            assert_fail "ctrlplane: expected p1 p2 p3 ownership, got: $cp_nodes"
        fi
    else
        assert_fail "ctrlplane: expected three admitted devservers, got $(owner_tunnel_count "$ERIN_ID")"
    fi

    spawn_devserver cp4 "${DS_PORTS[10]}" "$CP_PAT4" "$SHIM_TUNNEL_URL"
    sleep 6
    if [ "$(owner_tunnel_count "$ERIN_ID")" = "3" ] &&
        ! owner_tunnels "$ERIN_ID" | grep -q "$CP_DS4"; then
        assert_pass "ctrlplane: fourth concurrent admission refused at signed limit 3"
    else
        assert_fail "ctrlplane: fourth admission was not refused: $(owner_tunnels "$ERIN_ID")"
    fi
    cp_stop ds-cp4

    check_entry_routes ctrlplane-limit-1 "$CP_PAT1" "$ERIN_USER" "$ERIN_ID" "$CP_DS1"
    check_entry_routes ctrlplane-limit-2 "$CP_PAT2" "$ERIN_USER" "$ERIN_ID" "$CP_DS2"
    if wait_owner_sessions "$ERIN_ID" 2; then
        assert_pass "ctrlplane: controller converged two tenant sessions before policy reduction"
    else
        assert_fail "ctrlplane: expected two tenant sessions before policy reduction"
    fi

    local cp_oauth_enabled=0
    if [ -x "$CHROME_BIN" ]; then
        cp_stop stub-oauth
        spawn stub-oauth node "$REPO/scripts/e2e/stub-oauth.mjs" "$OAUTH_PORT" "$ERIN_EMAIL" 424243
        if wait_http stub-oauth "http://127.0.0.1:$OAUTH_PORT/user" 25 &&
            cp_run_oauth_login; then
            if [ "$(cp_oauth_rows | json_array_len)" = "1" ]; then
                cp_oauth_enabled=1
                assert_pass "ctrlplane: OAuth login created one indexed operator session"
            else
                assert_fail "ctrlplane: OAuth login did not create one indexed session"
            fi
        else
            assert_fail "ctrlplane: OAuth fixture failed with local Chrome present"
        fi
    else
        assert_pass "ctrlplane: OAuth browser checks skipped because local Chrome is unavailable"
    fi

    local reduced reduced_evicted reduced_sessions
    reduced="$(admin_json policy set "$ERIN_EMAIL" --enabled \
        --max-connected-devservers 1 2>> "$cp_log")" ||
        assert_fail "ctrlplane: policy reduction to one failed"
    reduced_evicted="$(printf %s "$reduced" | json_get tunnels_evicted)"
    reduced_sessions="$(printf %s "$reduced" | json_get tenant_sessions_revoked)"
    if [ "$reduced_evicted" = "3" ] && [ "$reduced_sessions" = "2" ] &&
        wait_owner_tunnels "$ERIN_ID" 1 200 && wait_owner_sessions "$ERIN_ID" 0; then
        assert_pass "ctrlplane: limit reduction drained 3 tunnels and 2 sessions; one tunnel reconnected"
    else
        assert_fail "ctrlplane: reduction did not converge: $reduced"
    fi
    sleep 5
    [ "$(owner_tunnel_count "$ERIN_ID")" = "1" ] &&
        assert_pass "ctrlplane: reduced limit remained exact under reconnect contention" ||
        assert_fail "ctrlplane: reduced limit admitted more than one reconnect"

    local winner winner_pat
    winner="$(owner_tunnels "$ERIN_ID" | jrows devserver_id | head -1)"
    case "$winner" in
    "$CP_DS1") winner_pat="$CP_PAT1" ;;
    "$CP_DS2") winner_pat="$CP_PAT2" ;;
    "$CP_DS3") winner_pat="$CP_PAT3" ;;
    *) assert_fail "ctrlplane: unknown reconnect winner '$winner'" ;;
    esac
    check_entry_routes ctrlplane-suspend "$winner_pat" "$ERIN_USER" "$ERIN_ID" "$winner"
    wait_owner_sessions "$ERIN_ID" 1 ||
        assert_fail "ctrlplane: pre-suspend tenant session did not converge"

    local tokens_before tokens_before_n tokens_before_live
    tokens_before="$(admin_json token list "$ERIN_EMAIL" 2>> "$cp_log")" ||
        assert_fail "ctrlplane: pre-suspend token list failed"
    tokens_before_n="$(printf %s "$tokens_before" | json_array_len)"
    tokens_before_live="$(printf %s "$tokens_before" | cp_unrevoked_tokens)"

    local suspended
    suspended="$(admin_json policy suspend "$ERIN_EMAIL" 2>> "$cp_log")" ||
        assert_fail "ctrlplane: policy suspend failed"
    if [ "$(printf %s "$suspended" | cp_policy_value enabled)" = "false" ] &&
        [ "$(printf %s "$suspended" | cp_policy_value max_connected_devservers)" = "1" ] &&
        [ "$(printf %s "$suspended" | json_get tunnels_evicted)" = "1" ] &&
        [ "$(printf %s "$suspended" | json_get tenant_sessions_revoked)" = "1" ] &&
        wait_owner_tunnels "$ERIN_ID" 0 && wait_owner_sessions "$ERIN_ID" 0; then
        assert_pass "ctrlplane: suspend preserved limit 1 and drained tunnel and tenant session"
    else
        assert_fail "ctrlplane: suspend did not converge: $suspended"
    fi
    local tokens_suspended
    tokens_suspended="$(admin_json token list "$ERIN_EMAIL" 2>> "$cp_log")" ||
        assert_fail "ctrlplane: suspended token list failed"
    if [ "$(printf %s "$tokens_suspended" | json_array_len)" = "$tokens_before_n" ] &&
        [ "$(printf %s "$tokens_suspended" | cp_unrevoked_tokens)" = "$tokens_before_live" ]; then
        assert_pass "ctrlplane: suspend preserved every PAT row and revocation state"
    else
        assert_fail "ctrlplane: suspend changed PAT rows"
    fi
    sleep 6
    [ "$(owner_tunnel_count "$ERIN_ID")" = "0" ] &&
        assert_pass "ctrlplane: suspended PATs could not reconnect" ||
        assert_fail "ctrlplane: a suspended PAT reconnected"

    local resumed
    resumed="$(admin_json policy resume "$ERIN_EMAIL" 2>> "$cp_log")" ||
        assert_fail "ctrlplane: policy resume failed"
    if [ "$(printf %s "$resumed" | cp_policy_value enabled)" = "true" ] &&
        [ "$(printf %s "$resumed" | cp_policy_value max_connected_devservers)" = "1" ] &&
        wait_owner_tunnels "$ERIN_ID" 1 200; then
        assert_pass "ctrlplane: resume preserved limit and an existing PAT reconnected"
    else
        assert_fail "ctrlplane: resume did not restore one existing PAT: $resumed"
    fi

    winner="$(owner_tunnels "$ERIN_ID" | jrows devserver_id | head -1)"
    case "$winner" in
    "$CP_DS1") winner_pat="$CP_PAT1" ;;
    "$CP_DS2") winner_pat="$CP_PAT2" ;;
    "$CP_DS3") winner_pat="$CP_PAT3" ;;
    *) assert_fail "ctrlplane: unknown post-resume winner '$winner'" ;;
    esac
    check_entry_routes ctrlplane-block "$winner_pat" "$ERIN_USER" "$ERIN_ID" "$winner"
    wait_owner_sessions "$ERIN_ID" 1 ||
        assert_fail "ctrlplane: pre-block tenant session did not converge"

    local blocked
    blocked="$(admin_json user block "$ERIN_EMAIL" --reason ctrlplane-e2e 2>> "$cp_log")" ||
        assert_fail "ctrlplane: account block failed"
    if wait_owner_tunnels "$ERIN_ID" 0 && wait_owner_sessions "$ERIN_ID" 0; then
        assert_pass "ctrlplane: block drained owned tunnels and tenant sessions"
    else
        assert_fail "ctrlplane: block left live tunnel or tenant state: $blocked"
    fi
    if [ "$cp_oauth_enabled" = "1" ]; then
        [ "$(cp_oauth_rows | json_array_len)" = "0" ] &&
            assert_pass "ctrlplane: block revoked the indexed OAuth session" ||
            assert_fail "ctrlplane: block left an indexed OAuth session"
    fi
    local tokens_blocked
    tokens_blocked="$(admin_json token list "$ERIN_EMAIL" 2>> "$cp_log")" ||
        assert_fail "ctrlplane: blocked token list failed"
    if [ "$(printf %s "$tokens_blocked" | json_array_len)" = "$tokens_before_n" ] &&
        [ "$(printf %s "$tokens_blocked" | cp_unrevoked_tokens)" = "0" ]; then
        assert_pass "ctrlplane: block retained PAT rows and revoked every PAT"
    else
        assert_fail "ctrlplane: block did not revoke every PAT"
    fi

    admin_json user unblock "$ERIN_EMAIL" 2>> "$cp_log" >/dev/null ||
        assert_fail "ctrlplane: account unblock failed"
    sleep 6
    if [ "$(owner_tunnel_count "$ERIN_ID")" = "0" ]; then
        assert_pass "ctrlplane: unblock did not resurrect revoked PATs"
    else
        assert_fail "ctrlplane: an old PAT reconnected after unblock"
    fi

    local pre_pause pause_report
    pre_pause="$(fleet_count)"
    [ "$pre_pause" -ge 1 ] ||
        assert_fail "ctrlplane: fleet had no live tunnel before pause"
    pause_report="$(admin_json fleet pause --drain 2>> "$cp_log")" ||
        assert_fail "ctrlplane: fleet pause failed"
    if [ "$(printf %s "$pause_report" | json_get admissions_enabled)" = "false" ] &&
        wait_fleet 0 200 &&
        [ "$(admin_read /admin/v1/browser-sessions | json_array_len)" = "0" ]; then
        assert_pass "ctrlplane: fleet pause persisted and drained every tunnel and tenant session"
    else
        assert_fail "ctrlplane: fleet pause did not drain: $pause_report"
    fi
    if admin_mint "$ERIN_EMAIL" ctrlplane-paused >/dev/null 2>&1; then
        assert_fail "ctrlplane: PAT mint succeeded while fleet was paused"
    else
        assert_pass "ctrlplane: fleet pause refused PAT creation"
    fi
    sleep 6
    [ "$(fleet_count)" = "0" ] &&
        assert_pass "ctrlplane: existing PATs could not readmit while paused" ||
        assert_fail "ctrlplane: a tunnel readmitted while fleet was paused"

    cp_stop identity
    spawn_identity
    wait_http identity "http://127.0.0.1:$ID_INNER_PORT/healthz" ||
        assert_fail "ctrlplane: identity did not restart"
    require_alive identity
    local paused_after_restart
    paused_after_restart="$(admin_json fleet status 2>> "$cp_log")" ||
        assert_fail "ctrlplane: fleet status failed after identity restart"
    if [ "$(printf %s "$paused_after_restart" | json_get admissions_enabled)" = "false" ]; then
        assert_pass "ctrlplane: identity restart did not clear durable fleet pause"
    else
        assert_fail "ctrlplane: fleet pause cleared across identity restart"
    fi
    if admin_mint "$ERIN_EMAIL" ctrlplane-paused-restart >/dev/null 2>&1; then
        assert_fail "ctrlplane: PAT mint succeeded after paused identity restart"
    else
        assert_pass "ctrlplane: restarted identity still refused PAT creation while paused"
    fi

    local fleet_resumed
    fleet_resumed="$(admin_json fleet resume 2>> "$cp_log")" ||
        assert_fail "ctrlplane: fleet resume failed"
    if [ "$(printf %s "$fleet_resumed" | json_get admissions_enabled)" = "true" ] &&
        wait_fleet 3 300; then
        assert_pass "ctrlplane: fleet resume restored normal admission"
    else
        assert_fail "ctrlplane: fleet resume did not restore the steady fleet: $fleet_resumed"
    fi

    local CP_PAT5 CP_DS5
    mint_into "$ERIN_EMAIL" ctrlplane-5 CP_PAT5 CP_DS5 ||
        assert_fail "ctrlplane: fresh PAT mint failed after fleet resume"
    spawn_devserver cp5 "${DS_PORTS[10]}" "$CP_PAT5" "$(node_tunnel_url p1)"
    if wait_owner_tunnels "$ERIN_ID" 1 200; then
        assert_pass "ctrlplane: fresh post-resume PAT admitted normally"
    else
        assert_fail "ctrlplane: fresh post-resume PAT did not connect"
    fi

    check_entry_routes ctrlplane-exact-erin "$CP_PAT5" "$ERIN_USER" "$ERIN_ID" "$CP_DS5"
    check_entry_routes ctrlplane-exact-carol "$PAT_D" "$CAROL_USER" "$CAROL_ID" "$DS_D"
    if wait_owner_sessions "$ERIN_ID" 1 && wait_owner_sessions "$CAROL_ID" 1; then
        assert_pass "ctrlplane: two exact tenant sessions converged on separate owners"
    else
        assert_fail "ctrlplane: exact tenant session fixtures did not converge"
    fi

    if [ "$cp_oauth_enabled" = "1" ]; then
        cp_run_oauth_login || assert_fail "ctrlplane: first exact OAuth fixture failed"
        cp_run_oauth_login || assert_fail "ctrlplane: second exact OAuth fixture failed"
        [ "$(cp_oauth_rows | json_array_len)" = "2" ] &&
            assert_pass "ctrlplane: two fresh OAuth sessions indexed after restart" ||
            assert_fail "ctrlplane: expected two indexed OAuth sessions after restart"
    fi

    local overview oauth_rows tenant_rows tunnel_rows
    overview="$(admin_json overview --since 24h 2>> "$cp_log")" ||
        assert_fail "ctrlplane: gateway overview failed"
    oauth_rows="$(admin_json session oauth ps 2>> "$cp_log")" ||
        assert_fail "ctrlplane: OAuth session list failed"
    tenant_rows="$(admin_json session tenant ps 2>> "$cp_log")" ||
        assert_fail "ctrlplane: tenant session list failed"
    tunnel_rows="$(admin_json tunnel ps 2>> "$cp_log")" ||
        assert_fail "ctrlplane: tunnel list failed"
    local overview_oauth overview_tenant overview_tunnels
    read -r overview_oauth overview_tenant overview_tunnels <<< "$(printf %s "$overview" |
        node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d).sessions;console.log(`${v.oauth} ${v.tenant} ${v.tunnels}`)})')"
    if [ "$overview_oauth" = "$(printf %s "$oauth_rows" | json_array_len)" ] &&
        [ "$overview_tenant" = "$(printf %s "$tenant_rows" | json_array_len)" ] &&
        [ "$overview_tunnels" = "$(printf %s "$tunnel_rows" | json_array_len)" ]; then
        assert_pass "ctrlplane: overview OAuth, tenant, and tunnel counts matched authoritative lists"
    else
        assert_fail "ctrlplane: overview session counts did not match authoritative lists: $overview"
    fi

    local tenant_id tenant_revoke
    tenant_id="$(owner_sessions "$ERIN_ID" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d)[0].id)}catch{}})')"
    tenant_revoke="$(admin_json session tenant revoke "$tenant_id" 2>> "$cp_log")" ||
        assert_fail "ctrlplane: exact tenant session revoke failed"
    if [ "$(printf %s "$tenant_revoke" | json_get tenant_sessions_revoked)" = "1" ] &&
        wait_owner_sessions "$ERIN_ID" 0 && wait_owner_sessions "$CAROL_ID" 1; then
        assert_pass "ctrlplane: exact tenant revoke removed only its target"
    else
        assert_fail "ctrlplane: exact tenant revoke was not isolated: $tenant_revoke"
    fi
    local erin_node erin_host erin_cookie carol_node carol_host carol_cookie erin_code carol_code
    erin_node="$(tunnel_field "$CP_DS5" proxy_id)"
    erin_host="$ERIN_USER--$(disc "$CP_DS5").$erin_node.$APEX"
    erin_cookie="$(cat "$WORK/cookie-ctrlplane-exact-erin.txt")"
    carol_node="$(tunnel_field "$DS_D" proxy_id)"
    carol_host="$CAROL_USER--$(disc "$DS_D").$carol_node.$APEX"
    carol_cookie="$(cat "$WORK/cookie-ctrlplane-exact-carol.txt")"
    erin_code="$(curl_node "$erin_node" "$erin_host" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $erin_cookie" "https://$erin_host:$PROXY_PORT/api/health")"
    carol_code="$(curl_node "$carol_node" "$carol_host" -o /dev/null -w '%{http_code}' \
        -H "Cookie: $carol_cookie" "https://$carol_host:$PROXY_PORT/api/health")"
    if [ "$erin_code" = "404" ] && [ "$carol_code" = "200" ]; then
        assert_pass "ctrlplane: revoked tenant cookie failed while unrelated cookie remained admitted"
    else
        assert_fail "ctrlplane: exact tenant cookie isolation expected 404/200, got $erin_code/$carol_code"
    fi

    if [ "$cp_oauth_enabled" = "1" ]; then
        local oauth_id oauth_revoke oauth_user_revoke
        oauth_id="$(cp_oauth_rows | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d)[0].id)}catch{}})')"
        oauth_revoke="$(admin_json session oauth revoke "$oauth_id" 2>> "$cp_log")" ||
            assert_fail "ctrlplane: exact OAuth session revoke failed"
        if [ "$(printf %s "$oauth_revoke" | json_get oauth_sessions_revoked)" = "1" ] &&
            [ "$(cp_oauth_rows | json_array_len)" = "1" ]; then
            assert_pass "ctrlplane: exact OAuth revoke removed one of two sessions"
        else
            assert_fail "ctrlplane: exact OAuth revoke was not isolated: $oauth_revoke"
        fi
        oauth_user_revoke="$(admin_json session oauth revoke-user "$ERIN_EMAIL" 2>> "$cp_log")" ||
            assert_fail "ctrlplane: OAuth user-wide revoke failed"
        if [ "$(printf %s "$oauth_user_revoke" | json_get oauth_sessions_revoked)" = "1" ] &&
            [ "$(cp_oauth_rows | json_array_len)" = "0" ]; then
            assert_pass "ctrlplane: OAuth user-wide revoke removed the remaining session"
        else
            assert_fail "ctrlplane: OAuth user-wide revoke did not converge: $oauth_user_revoke"
        fi
    fi

    local final_overview audit_since audit_rows audit_count audit_users history_count
    final_overview="$(admin_json overview --since 24h 2>> "$cp_log")" ||
        assert_fail "ctrlplane: final overview failed"
    audit_since="$(printf %s "$final_overview" | json_get since)"
    audit_rows="$(admin_json audit ps --action login --since "$audit_since" \
        --limit 200 2>> "$cp_log")" ||
        assert_fail "ctrlplane: global login history failed"
    audit_count="$(printf %s "$audit_rows" | json_array_len)"
    audit_users="$(printf %s "$audit_rows" |
        node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(new Set(JSON.parse(d).map(x=>x.user_id)).size)}catch{console.log(-1)}})')"
    read -r history_count history_users <<< "$(printf %s "$final_overview" |
        node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d).users;console.log(`${v.login_events_since} ${v.logged_in_since}`)})')"
    if [ "$audit_count" = "$history_count" ] && [ "$audit_users" = "$history_users" ]; then
        assert_pass "ctrlplane: global login history matched overview event and distinct-user counts"
    else
        assert_fail "ctrlplane: login history and overview diverged: history=$audit_count/$audit_users overview=$history_count/$history_users"
    fi
}

run_scenarios() { # run_scenarios <all|name>
    local which="$1" ran=0 s
    for s in $SCENARIOS; do
        if [ "$which" = all ] || [ "$which" = "$s" ]; then
            log ""
            log "==== scenario: $s ===="
            "scenario_$s"
            ran=1
        fi
    done
    if [ "$which" != all ] && [ "$ran" = 0 ]; then
        assert_fail "unknown scenario '$which' (registered: ${SCENARIOS:-none})"
    fi
}
[ "$SCENARIO" != core ] && run_scenarios "$SCENARIO"

log ""
log "==== assertion summary ($ASSERT_LOG) ===="
cat "$ASSERT_LOG"
log "RESULT: all assertions passed"
