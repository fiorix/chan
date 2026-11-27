#!/usr/bin/env bash
# Automated iOS Simulator UI & smoke runner against local mock-gateway.mjs + wg-peer.
# Generates a standalone xcodegen XCUITest project in a throwaway directory so
# mobile/ios/gen/apple/project.yml remains untouched.
#
# Exit codes:
#   0  all Simulator UI, wire, and stability assertions passed
#   1  assertion failure, unimplemented behavior, or app crash
#   2  missing prerequisite or CoreSimulator/xcodebuild infrastructure failure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"

SKIP_BUILD=0
PROBE_RED=0
SIM_NAME="${IOS_SIM:-iPhone 17}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --skip-build) SKIP_BUILD=1; shift ;;
        --probe-red) PROBE_RED=1; shift ;;
        --sim) SIM_NAME="${2:?--sim requires a simulator name or UDID}"; shift 2 ;;
        -h|--help)
            echo "usage: run-simulator-smoke.sh [--skip-build] [--probe-red] [--sim NAME]" >&2
            exit 0
            ;;
        *)
            echo "run-simulator-smoke: unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

for cmd in xcodebuild xcodegen xcrun node plutil python3 openssl perl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "verdict tier4 sim-prereq 2 PREREQ missing required tool: $cmd"
        exit 2
    fi
done

if ! python3 -c 'import socket; socket.getaddrinfo("localtest.me", 80)' >/dev/null 2>&1; then
    echo "verdict tier4 sim-prereq 2 PREREQ localtest.me DNS resolution failed"
    exit 2
fi

SIM_LIST_OUT=""
if ! SIM_LIST_OUT="$(xcrun simctl list devices available -j 2>&1)"; then
    echo "verdict tier4 sim-prereq 2 PREREQ xcrun simctl unavailable: $SIM_LIST_OUT"
    exit 2
fi

UDID="$(node -e '
const data = JSON.parse(process.argv[1]);
const target = process.argv[2];
const all = Object.values(data.devices || {}).flat();
const match = all.find((d) => d.isAvailable && (d.udid === target || d.name === target));
if (match) console.log(match.udid);
' "$SIM_LIST_OUT" "$SIM_NAME")"

if [ -z "$UDID" ]; then
    echo "verdict tier4 sim-prereq 2 PREREQ simulator device not available: $SIM_NAME"
    exit 2
fi

mkdir -p "$REPO/target/e2e-ios"
WORK="$(mktemp -d "$REPO/target/e2e-ios/sim-smoke.XXXXXX")"
mkdir -p "$WORK/chan-home"

MOCK_PID=""

kill_child() {
    local pid="$1"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi
}

cleanup() {
    kill_child "$MOCK_PID"
    xcrun simctl terminate "$UDID" app.chan.ios >/dev/null 2>&1 || true
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

if [ "$SKIP_BUILD" = 0 ]; then
    if ! make -C "$REPO" web-launcher >"$WORK/web-launcher.log" 2>&1; then
        echo "verdict tier4 sim-build 2 PREREQ make web-launcher failed"
        cat "$WORK/web-launcher.log" >&2
        exit 2
    fi
    if ! make -C "$REPO" WEB_ALREADY_BUILT=1 ios-build >"$WORK/ios-build.log" 2>&1; then
        echo "verdict tier4 sim-build 2 PREREQ make ios-build failed"
        cat "$WORK/ios-build.log" >&2
        exit 2
    fi
fi

PRODUCTS_DIR="$(xcodebuild \
    -project "$REPO/mobile/ios/gen/apple/chan-ios.xcodeproj" \
    -scheme chan-ios_iOS \
    -configuration debug \
    -sdk iphonesimulator \
    -showBuildSettings 2>/dev/null | sed -n 's/^[[:space:]]*BUILT_PRODUCTS_DIR = //p' | head -n 1)"

APP_PATH="${PRODUCTS_DIR:+$PRODUCTS_DIR/Chan.app}"
if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
    echo "verdict tier4 sim-app-bundle 2 PREREQ Chan.app not found at ${APP_PATH:-unset}"
    exit 2
fi

PLIST_JSON="$(plutil -convert json -o - "$APP_PATH/Info.plist")"
PLIST_RC=0
node -e '
const assert = require("node:assert/strict");
const plist = JSON.parse(process.argv[1]);
assert.equal(plist.CFBundleShortVersionString, "0.135.0");
assert.equal(plist.CFBundleVersion, "0.135.0");
const minOs = Number(String(plist.MinimumOSVersion || "0").split(".")[0]);
assert.ok(minOs >= 17, `MinimumOSVersion ${plist.MinimumOSVersion} < 17`);
assert.equal(plist.NSAppTransportSecurity?.NSAllowsLocalNetworking, true);
' "$PLIST_JSON" >"$WORK/plist-check.log" 2>&1 || PLIST_RC="$?"

if [ "$PLIST_RC" = 0 ]; then
    echo "verdict tier4 sim-plist 0 PASS Chan.app Info.plist pins 0.135.0 and iOS >= 17.0 ($SHA)"
else
    echo "verdict tier4 sim-plist 1 FAIL Chan.app Info.plist check failed ($SHA)"
    cat "$WORK/plist-check.log" >&2
fi

xcrun simctl boot "$UDID" >/dev/null 2>&1 || true
if ! xcrun simctl bootstatus "$UDID" -b >"$WORK/bootstatus.log" 2>&1; then
    echo "verdict tier4 sim-boot 2 PREREQ failed waiting for simulator boot ($UDID)"
    cat "$WORK/bootstatus.log" >&2
    exit 2
fi

if ! openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -nodes -days 7 -sha256 -subj "/CN=Chan E2E Test CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$WORK/ca.key" -out "$WORK/ca.pem" >"$WORK/openssl-ca.log" 2>&1; then
    echo "verdict tier4 sim-tls-ca 2 PREREQ failed to generate ephemeral CA"
    cat "$WORK/openssl-ca.log" >&2
    exit 2
fi

if ! openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -nodes -subj "/CN=alice--0123456789ab.p1.localtest.me" \
    -keyout "$WORK/server.key" -out "$WORK/server.csr" >"$WORK/openssl-csr.log" 2>&1; then
    echo "verdict tier4 sim-tls-csr 2 PREREQ failed to generate server CSR"
    cat "$WORK/openssl-csr.log" >&2
    exit 2
fi

cat >"$WORK/ext.cnf" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:alice--0123456789ab.p1.localtest.me,DNS:*.p1.localtest.me,DNS:*.localtest.me,DNS:localtest.me,DNS:localhost,IP:127.0.0.1
EOF

if ! openssl x509 -req -in "$WORK/server.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" \
    -CAcreateserial -out "$WORK/server.pem" -days 7 -sha256 -extfile "$WORK/ext.cnf" \
    >"$WORK/openssl-sign.log" 2>&1; then
    echo "verdict tier4 sim-tls-sign 2 PREREQ failed to sign server cert"
    cat "$WORK/openssl-sign.log" >&2
    exit 2
fi
chmod 644 "$WORK/ca.pem" "$WORK/server.pem"

if ! xcrun simctl keychain "$UDID" add-root-cert "$WORK/ca.pem" >"$WORK/keychain.log" 2>&1; then
    echo "verdict tier4 sim-keychain 2 PREREQ simctl keychain add-root-cert failed"
    cat "$WORK/keychain.log" >&2
    exit 2
fi

xcrun simctl terminate "$UDID" app.chan.ios >/dev/null 2>&1 || true
xcrun simctl uninstall "$UDID" app.chan.ios >/dev/null 2>&1 || true
if ! xcrun simctl install "$UDID" "$APP_PATH" >"$WORK/install.log" 2>&1; then
    echo "verdict tier4 sim-install 2 PREREQ xcrun simctl install failed"
    cat "$WORK/install.log" >&2
    exit 2
fi

# Start mock-gateway with wg-peer launcher so Chan.app's real generated public key gets admitted.
if ! cargo build --manifest-path "$REPO/Cargo.toml" --locked -p chan-wireguard --example wg-peer >"$WORK/wg-peer-build.log" 2>&1; then
    echo "verdict tier4 sim-wg-peer 2 PREREQ failed to build wg-peer"
    exit 2
fi
WG_PEER_BIN="$REPO/target/debug/examples/wg-peer"
KEY_PUB="$(node -e '
const { generateKeyPairSync } = require("node:crypto");
const { publicKey } = generateKeyPairSync("x25519");
console.log(publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"));
')"

cat >"$WORK/peers.json" <<EOF
{"endpoint":"127.0.0.1:9","server_public_key":"$KEY_PUB","addresses":["10.7.0.1/32"],"allowed_ips":["10.7.0.2/32"],"persistent_keepalive":5,"hosts":[{"name":"p1.localtest.me","addresses":["10.7.0.2"]}],"ingresses":[{"id":"p1","endpoint":"127.0.0.1:9","server_public_key":"$KEY_PUB","hosts":[{"name":"p1.localtest.me","addresses":["10.7.0.2"]}]}]}
EOF

node "$SCRIPT_DIR/mock-gateway.mjs" \
    --auto-confirm \
    --peer-file "$WORK/peers.json" \
    --ledger "$WORK/ledger.json" \
    --wg-peer-bin "$WG_PEER_BIN" \
    --tls-cert "$WORK/server.pem" \
    --tls-key "$WORK/server.key" \
    >"$WORK/mock-gateway.log" 2>&1 &
MOCK_PID="$!"

if ! wait_for_line 10 "$WORK/mock-gateway.log" '^mock-gateway: ready origin=http://127\.0\.0\.1:[0-9]+( |$)'; then
    echo "verdict tier4 sim-mock-gateway 2 PREREQ mock-gateway did not start"
    exit 2
fi
MOCK_ORIGIN="$(sed -n 's/^mock-gateway: ready origin=\(http:\/\/127\.0\.0\.1:[0-9]*\).*/\1/p' "$WORK/mock-gateway.log" | head -n 1)"

cp -R "$SCRIPT_DIR/ChanUITests" "$WORK/ChanUITests"
if ! (cd "$WORK/ChanUITests" && xcodegen generate >"$WORK/xcodegen.log" 2>&1); then
    echo "verdict tier4 sim-xcodegen 2 PREREQ xcodegen failed"
    cat "$WORK/xcodegen.log" >&2
    exit 2
fi

CRASH_BEFORE="$(find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -name 'Chan-*.ips' 2>/dev/null | wc -l | tr -d ' ')"

XCODE_RC=0
TEST_RUNNER_CHAN_E2E_HOME="$WORK/chan-home" \
TEST_RUNNER_CHAN_E2E_GATEWAY_URL="$MOCK_ORIGIN" \
TEST_RUNNER_CHAN_E2E_LEDGER_URL="$MOCK_ORIGIN/_test/ledger" \
TEST_RUNNER_CHAN_E2E_VERDICT_FILE="$WORK/sim-verdicts.txt" \
TEST_RUNNER_CHAN_E2E_SSL_CERT_FILE="$WORK/ca.pem" \
TEST_RUNNER_CHAN_E2E_PROBE_RED="$PROBE_RED" \
xcodebuild test \
    -project "$WORK/ChanUITests/ChanUITests.xcodeproj" \
    -scheme ChanUITests \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$WORK/DerivedData" \
    >"$WORK/xcodebuild-test.log" 2>&1 || XCODE_RC="$?"

if [ ! -f "$WORK/sim-verdicts.txt" ]; then
    echo "verdict tier4 sim-xcuitest 2 PREREQ XCUITest did not produce verdict output (xcodebuild rc=$XCODE_RC)"
    cat "$WORK/xcodebuild-test.log" >&2
    exit 2
fi

cat "$WORK/sim-verdicts.txt"

NAV_ORACLE_RC=0
if [ -f "$WORK/ledger.json" ]; then
    node --input-type=module -e '
import fs from "node:fs";
import { verifyWindowNavigationParams } from "./scripts/e2e/ios/ios-wireguard-oracle.mjs";
const ledger = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const navs = Array.isArray(ledger.navigations) ? ledger.navigations : [];
for (const nav of navs) {
    const w = nav.params?.w;
    let spec;
    if (w === "w-hidden-ws") {
        spec = { windowId: w, kind: "workspace", startTerminal: true, libraryId: "lib-e2e001", pane: "#3b82f6" };
    } else if (w === "w-ctrl") {
        spec = { windowId: w, kind: "control", libraryId: "lib-e2e001" };
    } else if (typeof w === "string" && w.length > 0) {
        spec = { windowId: w, kind: "terminal", libraryId: "lib-e2e001" };
    } else {
        throw new Error(`unexpected recorded navigation without w param: ${nav.url}`);
    }
    verifyWindowNavigationParams(nav.url, spec);
}
if (navs.length > 0) {
    console.log(`verdict tier4 sim-nav-oracle 0 PASS validated ${navs.length} recorded navigation URL(s)`);
}
' "$WORK/ledger.json" >"$WORK/nav-oracle.log" 2>&1 || NAV_ORACLE_RC="$?"
    if [ "$NAV_ORACLE_RC" -ne 0 ]; then
        echo "verdict tier4 sim-nav-oracle 1 FAIL recorded navigation URL failed oracle check (see $WORK/nav-oracle.log)"
        cat "$WORK/nav-oracle.log" >&2
    elif [ -s "$WORK/nav-oracle.log" ]; then
        cat "$WORK/nav-oracle.log"
    fi
fi

CRASH_AFTER="$(find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -name 'Chan-*.ips' 2>/dev/null | wc -l | tr -d ' ')"
LOG_RC=0
perl -e 'alarm 15; exec @ARGV' xcrun simctl spawn "$UDID" log show --last 2m --predicate 'process == "Chan"' --style compact >"$WORK/sim-chan.log" 2>"$WORK/sim-log.err" || LOG_RC="$?"

CRASH_RC=0
if [ "$LOG_RC" -ne 0 ]; then
    CRASH_RC=1
    echo "verdict tier4 sim-no-crash 1 FAIL simctl log show failed or timed out (rc=$LOG_RC; see $WORK/sim-log.err)"
else
    SIM_LOG_PANICS=0
    GREP_RC=0
    SIM_LOG_PANICS="$(grep -Ec 'panicked at|RUST_BACKTRACE' "$WORK/sim-chan.log")" || GREP_RC="$?"
    if [ "$GREP_RC" -gt 1 ]; then
        CRASH_RC=1
        echo "verdict tier4 sim-no-crash 1 FAIL panic log scan failed (grep rc=$GREP_RC)"
    elif [ "$CRASH_AFTER" -gt "$CRASH_BEFORE" ] || [ "$SIM_LOG_PANICS" -gt 0 ]; then
        CRASH_RC=1
        echo "verdict tier4 sim-no-crash 1 FAIL Chan crash/panic detected (reports=$CRASH_BEFORE->$CRASH_AFTER panics=$SIM_LOG_PANICS)"
    else
        echo "verdict tier4 sim-no-crash 0 PASS zero Chan crashes or Rust panics during Simulator run"
    fi
fi

FAIL_COUNT="$(grep -Ec '^verdict [^ ]+ [^ ]+ 1 FAIL ' "$WORK/sim-verdicts.txt" || true)"
if [ "$PLIST_RC" -ne 0 ] || [ "$CRASH_RC" -ne 0 ] || [ "$NAV_ORACLE_RC" -ne 0 ] || [ "$FAIL_COUNT" -gt 0 ] || [ "$XCODE_RC" -ne 0 ]; then
    echo "Simulator smoke finished with failures (plist_rc=$PLIST_RC crash_rc=$CRASH_RC nav_oracle_rc=$NAV_ORACLE_RC ui_failures=$FAIL_COUNT xcode_rc=$XCODE_RC; logs at $WORK)"
    exit 1
fi

echo "Simulator smoke PASS at $SHA"
cleanup
trap - EXIT
rm -rf "${WORK:?}"
exit 0
