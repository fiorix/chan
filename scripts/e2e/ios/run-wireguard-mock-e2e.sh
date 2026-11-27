#!/usr/bin/env bash
# Live WireGuard + mock chan-gateway loopback E2E runner.
# Runs two wg-peer UDP processes forwarding to mock-gateway.mjs and drives
# live PKCE mobile enrollment, ConnectProxy forwarding, and sibling-tunnel survival.
#
# Exit codes:
#   0  all assertions passed (normal mode)
#   1  assertion failure / probe failure (expected outcome in --probe-red)
#   2  missing prerequisite or infrastructure setup failure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"

PROBE_RED=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --probe-red) PROBE_RED=1; shift ;;
        -h|--help)
            echo "usage: run-wireguard-mock-e2e.sh [--probe-red]" >&2
            exit 0
            ;;
        *)
            echo "run-wireguard-mock-e2e: unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

for cmd in cargo node; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "verdict tier2 wg-prereq 2 PREREQ missing required command: $cmd"
        exit 2
    fi
done

mkdir -p "$REPO/target/e2e-ios"
WORK="$(mktemp -d "$REPO/target/e2e-ios/wg-mock.XXXXXX")"

MOCK_PID=""
P1_PID=""
P2_PID=""

kill_child() {
    local pid="$1"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
}

cleanup() {
    kill_child "$P1_PID"
    kill_child "$P2_PID"
    kill_child "$MOCK_PID"
}
trap cleanup EXIT

wait_for_line() {
    local timeout_s="$1"
    local file="$2"
    local pattern="$3"
    local deadline=$((SECONDS + timeout_s))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if [ -f "$file" ] && grep -Eq "$pattern" "$file"; then
            return 0
        fi
        sleep 0.1
    done
    return 1
}

if ! cargo build --manifest-path "$REPO/Cargo.toml" --locked -p chan-wireguard --example wg-peer >"$WORK/build-wg-peer.log" 2>&1; then
    echo "verdict tier2 wg-peer-build 2 PREREQ failed to build wg-peer example" >&2
    cat "$WORK/build-wg-peer.log" >&2
    exit 2
fi

WG_PEER_BIN="$REPO/target/debug/examples/wg-peer"
if [ ! -x "$WG_PEER_BIN" ]; then
    echo "verdict tier2 wg-peer-bin 2 PREREQ wg-peer binary missing at $WG_PEER_BIN" >&2
    exit 2
fi

# Generate an ephemeral X25519 keypair in Node without external tools.
KEY_JSON="$(node -e '
const { generateKeyPairSync } = require("node:crypto");
const { publicKey, privateKey } = generateKeyPairSync("x25519");
const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
const privRaw = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
console.log(JSON.stringify({ pub: pubRaw, priv: privRaw }));
')"
CLIENT_PUB="$(node -e "const d = JSON.parse(process.argv[1]); console.log(d.pub);" "$KEY_JSON")"
CLIENT_PRIV="$(node -e "const d = JSON.parse(process.argv[1]); console.log(d.priv);" "$KEY_JSON")"

# Seed placeholder peer file before mock-gateway starts; updated after wg-peer binds.
node "$SCRIPT_DIR/ios-wireguard-oracle.mjs" fixture "$WORK/peers.json" wg-e2e.invalid <(
    printf 'peer: ready url=http://10.7.0.2:8080 udp=127.0.0.1:9 public_key=%s\n' \
        "$(node -e 'console.log(Buffer.alloc(32, 1).toString("base64"))')"
) <(
    printf 'peer: ready url=http://10.7.0.2:8080 udp=127.0.0.1:10 public_key=%s\n' \
        "$(node -e 'console.log(Buffer.alloc(32, 2).toString("base64"))')"
) 2>/dev/null || {
    # Fallback explicit seed when process substitution isn't desired
    printf '{"endpoint":"127.0.0.1:9","server_public_key":"%s","addresses":["10.7.0.1/32"],"allowed_ips":["10.7.0.2/32"],"persistent_keepalive":5,"hosts":[],"ingresses":[{"id":"p1","endpoint":"127.0.0.1:9","server_public_key":"%s","hosts":[{"name":"p1.wg-e2e.invalid","addresses":["10.7.0.2"]}]},{"id":"p2","endpoint":"127.0.0.1:10","server_public_key":"%s","hosts":[{"name":"p2.wg-e2e.invalid","addresses":["10.7.0.2"]}]}]}\n' \
        "$(node -e 'console.log(Buffer.alloc(32, 1).toString("base64"))')" \
        "$(node -e 'console.log(Buffer.alloc(32, 1).toString("base64"))')" \
        "$(node -e 'console.log(Buffer.alloc(32, 2).toString("base64"))')" >"$WORK/peers.json"
}

node "$SCRIPT_DIR/mock-gateway.mjs" \
    --auto-confirm \
    --no-session-auth \
    --peer-file "$WORK/peers.json" \
    --ledger "$WORK/ledger.json" \
    >"$WORK/mock-gateway.log" 2>&1 &
MOCK_PID="$!"

if ! wait_for_line 10 "$WORK/mock-gateway.log" '^mock-gateway: ready origin=http://127\.0\.0\.1:[0-9]+$'; then
    echo "verdict tier2 mock-gateway-start 2 PREREQ mock-gateway did not become ready" >&2
    cat "$WORK/mock-gateway.log" >&2
    exit 2
fi

MOCK_ORIGIN="$(sed -n 's/^mock-gateway: ready origin=\(http:\/\/127\.0\.0\.1:[0-9]*\).*/\1/p' "$WORK/mock-gateway.log" | head -n 1)"
MOCK_PORT="${MOCK_ORIGIN##*:}"

"$WG_PEER_BIN" --client-key "$CLIENT_PUB" --port 18081 --forward "8080=127.0.0.1:$MOCK_PORT" \
    >"$WORK/peer-p1.log" 2>&1 &
P1_PID="$!"

"$WG_PEER_BIN" --client-key "$CLIENT_PUB" --port 18082 --forward "8080=127.0.0.1:$MOCK_PORT" \
    >"$WORK/peer-p2.log" 2>&1 &
P2_PID="$!"

if ! wait_for_line 10 "$WORK/peer-p1.log" '^peer: ready '; then
    echo "verdict tier2 wg-peer-p1 2 PREREQ p1 did not become ready" >&2
    cat "$WORK/peer-p1.log" >&2
    exit 2
fi
if ! wait_for_line 10 "$WORK/peer-p2.log" '^peer: ready '; then
    echo "verdict tier2 wg-peer-p2 2 PREREQ p2 did not become ready" >&2
    cat "$WORK/peer-p2.log" >&2
    exit 2
fi

node "$SCRIPT_DIR/ios-wireguard-oracle.mjs" fixture "$WORK/peers.json" wg-e2e.invalid \
    "$WORK/peer-p1.log" "$WORK/peer-p2.log"

HARNESS_RC=0
CHAN_IOS_E2E_MOCK_ORIGIN="$MOCK_ORIGIN" \
CHAN_IOS_E2E_CLIENT_PRIV="$CLIENT_PRIV" \
CHAN_IOS_E2E_PROBE_RED="$PROBE_RED" \
    cargo test --manifest-path "$REPO/Cargo.toml" -p chan-ios --test ios_e2e_harness \
    -- --ignored live_wg_peer_matrix --nocapture >"$WORK/harness.log" 2>&1 || HARNESS_RC="$?"

if [ "$PROBE_RED" = 1 ]; then
    if [ "$HARNESS_RC" -ne 0 ]; then
        echo "verdict tier2 wg-live-probe-red 1 FAIL red probe correctly detected PKCE mismatch failure ($SHA)"
        cleanup
        trap - EXIT
        rm -rf "${WORK:?}"
        exit 1
    fi
    echo "verdict tier2 wg-live-probe-red 0 PASS unexpected pass in --probe-red mode ($SHA)" >&2
    exit 0
fi

if [ "$HARNESS_RC" -ne 0 ]; then
    echo "verdict tier2 wg-live-matrix 1 FAIL live_wg_peer_matrix failed (work kept at $WORK)" >&2
    cat "$WORK/harness.log" >&2
    exit 1
fi

# Verify ledger received proxied requests for p1, p2, and sibling survival, and NOT retired p1.
LEDGER_RC=0
node -e '
const fs = require("node:fs");
const assert = require("node:assert/strict");
const ledger = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const queries = ledger.requests.map((r) => `${r.path}${r.query}`);
assert.ok(queries.includes("/api/library/windows?via=p1"), "missing p1 proxied request");
assert.ok(queries.includes("/api/library/windows?via=p2"), "missing p2 proxied request");
assert.ok(queries.includes("/api/library/windows?via=p2-sibling"), "missing p2 sibling request after p1 retirement");
assert.ok(!queries.includes("/api/library/windows?via=p1-retired"), "retired p1 leaked a request");
' "$WORK/ledger.json" >"$WORK/ledger-check.log" 2>&1 || LEDGER_RC="$?"

if [ "$LEDGER_RC" -ne 0 ]; then
    echo "verdict tier2 wg-live-ledger 1 FAIL ledger verification failed (work kept at $WORK)" >&2
    cat "$WORK/ledger-check.log" >&2
    exit 1
fi

echo "verdict tier2 wg-live-matrix 0 PASS real wg-peer handshake, ConnectProxy forwarding, and sibling survival verified at $SHA"
cleanup
trap - EXIT
rm -rf "${WORK:?}"
exit 0
