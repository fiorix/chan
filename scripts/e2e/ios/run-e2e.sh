#!/usr/bin/env bash
# Unified 4-tier E2E test runner for chan-ios (F1-F9).
#
# Modes:
#   --all         Run all 4 tiers (default; exits 0 only when 100% pass)
#   --tier N      Run only tier N (1, 2, 3, or 4)
#   --self-test   Run baseline-safe harness & infrastructure gates (exits 0 on baseline)
#   --probe-red   Verify every detector fires exit 1 (or exit 2 for prereq) on injected faults
#
# Exit codes:
#   0  selected checks passed (or all red probes detected failures in --probe-red)
#   1  one or more test assertions failed
#   2  missing prerequisite or infrastructure setup failure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"

MODE="all"
TIER=""
SKIP_SIM_BUILD=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --all) MODE="all"; shift ;;
        --tier)
            MODE="tier"
            TIER="${2:?--tier requires 1, 2, 3, or 4}"
            case "$TIER" in
                1|2|3|4) ;;
                *) echo "run-e2e: invalid tier '$TIER' (expected 1|2|3|4)" >&2; exit 2 ;;
            esac
            shift 2
            ;;
        --self-test) MODE="self-test"; shift ;;
        --probe-red) MODE="probe-red"; shift ;;
        --skip-sim-build) SKIP_SIM_BUILD=1; shift ;;
        -h|--help)
            echo "usage: run-e2e.sh [--all | --tier 1|2|3|4 | --self-test | --probe-red] [--skip-sim-build]" >&2
            exit 0
            ;;
        *)
            echo "run-e2e: unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

for cmd in cargo node python3; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "verdict prereq $cmd 2 PREREQ missing command $cmd"
        exit 2
    fi
done

FAIL_COUNT=0
PREREQ_COUNT=0
PASS_COUNT=0

mkdir -p "$REPO/target/e2e-ios"
RUN_DIR="$(mktemp -d "$REPO/target/e2e-ios/run.XXXXXX")"

trap 'if [ "$FAIL_COUNT" -eq 0 ] && [ "$PREREQ_COUNT" -eq 0 ]; then rm -rf "${RUN_DIR:?}"; fi' EXIT

run_cmd_verdict() {
    local tier="$1"
    local name="$2"
    shift 2
    local cmd_name="${1:-}"
    local log_file
    log_file="$(mktemp "$RUN_DIR/${name}.log.XXXXXX")"
    local rc=0
    "$@" >"$log_file" 2>&1 || rc="$?"
    if [ "$rc" -eq 0 ]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "verdict $tier $name 0 PASS ($SHA)"
        rm -f "$log_file"
    elif [ "$cmd_name" != "make" ] && [ "$rc" -eq 2 ]; then
        PREREQ_COUNT=$((PREREQ_COUNT + 1))
        echo "verdict $tier $name 2 PREREQ see $log_file"
    elif [ "$rc" -eq 127 ]; then
        PREREQ_COUNT=$((PREREQ_COUNT + 1))
        echo "verdict $tier $name 2 PREREQ see $log_file"
    else
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "verdict $tier $name 1 FAIL see $log_file"
        sed -n '1,40p' "$log_file" >&2 || true
    fi
}

run_stream_verdicts() {
    local log_file
    log_file="$(mktemp "$RUN_DIR/stream.log.XXXXXX")"
    local rc=0
    "$@" >"$log_file" 2>&1 || rc="$?"
    cat "$log_file"
    local p f pr
    p="$(grep -Ec '^verdict [^ ]+ [^ ]+ 0 PASS ' "$log_file" || true)"
    f="$(grep -Ec '^verdict [^ ]+ [^ ]+ 1 FAIL ' "$log_file" || true)"
    pr="$(grep -Ec '^verdict [^ ]+ [^ ]+ 2 PREREQ ' "$log_file" || true)"
    PASS_COUNT=$((PASS_COUNT + p))
    FAIL_COUNT=$((FAIL_COUNT + f))
    PREREQ_COUNT=$((PREREQ_COUNT + pr))
    if [ "$rc" -eq 2 ]; then
        if [ "$pr" -eq 0 ]; then
            PREREQ_COUNT=$((PREREQ_COUNT + 1))
            echo "verdict stream stream-prereq 2 PREREQ command exited rc=2 without verdict (see $log_file)"
        fi
    elif [ "$rc" -ne 0 ]; then
        if [ "$f" -eq 0 ]; then
            FAIL_COUNT=$((FAIL_COUNT + 1))
            echo "verdict stream stream-crash 1 FAIL command exited rc=$rc without FAIL verdict (see $log_file)"
        fi
    elif [ "$((p + f + pr))" -eq 0 ]; then
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "verdict stream stream-empty 1 FAIL command exited rc=0 with zero verdicts (see $log_file)"
    fi
    if [ "$rc" -eq 0 ] && [ "$((p + f + pr))" -gt 0 ]; then
        rm -f "$log_file"
    fi
}

run_vitest_ios() {
    local target_tier="$1"
    local expected_count=5
    local vitest_bin="${CHAN_E2E_VITEST_BIN:-$REPO/web/node_modules/.bin/vitest}"
    if [ ! -x "$vitest_bin" ]; then
        PREREQ_COUNT=$((PREREQ_COUNT + 1))
        echo "verdict $target_tier f5-vitest-${target_tier} 2 PREREQ $vitest_bin missing; run make web-launcher"
        return 2
    fi

    local json_file="$RUN_DIR/vitest-${target_tier}.json"
    local log_file="$RUN_DIR/vitest-${target_tier}.log"
    local verdict_file="$RUN_DIR/vitest-${target_tier}.verdicts"
    local rc=0
    (cd "$REPO/web" && "$vitest_bin" run --config ../scripts/e2e/ios/vitest.ios.config.mjs -t "^${target_tier} " --reporter=json --outputFile="$json_file") >"$log_file" 2>&1 || rc="$?"

    local parse_rc=0
    node -e '
const fs = require("node:fs");
const [tier, expectedStr, jsonPath, rcStr, sha, logPath] = process.argv.slice(1);
const expected = Number(expectedStr);
const rc = Number(rcStr);
const cleanLine = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 180);

if ((rc !== 0 && rc !== 1) || !fs.existsSync(jsonPath)) {
    console.log(`verdict ${tier} f5-vitest-runner-${tier} 1 FAIL vitest exited rc=${rc} without JSON report (see ${logPath})`);
    process.exit(1);
}

let data;
try {
    data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
} catch (err) {
    console.log(`verdict ${tier} f5-vitest-runner-${tier} 1 FAIL unparseable vitest JSON: ${cleanLine(err.message)} (${sha})`);
    process.exit(1);
}

const results = Array.isArray(data.testResults) ? data.testResults : [];
const suiteCrash = results.some((tr) => tr.status === "failed" && (tr.assertionResults || []).every((a) => a.status !== "failed"));
if (suiteCrash) {
    console.log(`verdict ${tier} f5-vitest-runner-${tier} 1 FAIL vitest suite failed outside test assertions (see ${logPath})`);
    process.exit(1);
}

const matched = results
    .flatMap((tr) => Array.isArray(tr.assertionResults) ? tr.assertionResults : [])
    .filter((a) => Array.isArray(a.ancestorTitles) && a.ancestorTitles[0] === tier);

if (matched.length !== expected) {
    console.log(`verdict ${tier} f5-vitest-count-${tier} 1 FAIL expected ${expected} tests in ${tier}, got ${matched.length} (${sha})`);
    process.exit(1);
}

let anyFail = false;
for (const a of matched) {
    if (a.status === "passed") {
        console.log(`verdict ${tier} ${a.title} 0 PASS (${sha})`);
    } else {
        anyFail = true;
        const msg = Array.isArray(a.failureMessages) && a.failureMessages.length > 0
            ? cleanLine(a.failureMessages[0])
            : `status=${a.status}`;
        console.log(`verdict ${tier} ${a.title} 1 FAIL ${msg} (${sha})`);
    }
}
process.exit(anyFail ? 1 : 0);
' "$target_tier" "$expected_count" "$json_file" "$rc" "$SHA" "$log_file" >"$verdict_file" || parse_rc="$?"

    cat "$verdict_file"
    local vp vf
    vp="$(grep -Ec '^verdict [^ ]+ [^ ]+ 0 PASS ' "$verdict_file" || true)"
    vf="$(grep -Ec '^verdict [^ ]+ [^ ]+ 1 FAIL ' "$verdict_file" || true)"
    PASS_COUNT=$((PASS_COUNT + vp))
    FAIL_COUNT=$((FAIL_COUNT + vf))
    if [ "$parse_rc" -ne 0 ] && [ "$vf" -eq 0 ]; then
        FAIL_COUNT=$((FAIL_COUNT + 1))
        echo "verdict $target_tier f5-vitest-parser-${target_tier} 1 FAIL vitest parser exited rc=$parse_rc without FAIL verdict (see $log_file)"
    fi
    if [ "$parse_rc" -eq 0 ]; then
        rm -f "$log_file" "$json_file" "$verdict_file"
    fi
    return "$parse_rc"
}

run_cargo_verdict() {
    local tier="$1"
    local name="$2"
    shift 2
    run_cmd_verdict "$tier" "$name" bash -c 'cd "$1" && shift && exec cargo "$@"' _ "$REPO" "$@"
}

run_make_verdict() {
    local tier="$1"
    local name="$2"
    shift 2
    if ! command -v make >/dev/null 2>&1; then
        PREREQ_COUNT=$((PREREQ_COUNT + 1))
        echo "verdict $tier $name 2 PREREQ missing command make"
        return 0
    fi
    run_cmd_verdict "$tier" "$name" make -C "$REPO" "$@"
}

run_self_test() {
    echo "=== E2E Self-Test Mode ($SHA) ==="
    run_make_verdict self-test e2e-check e2e-check
    run_make_verdict self-test shell-check shell-check
    run_make_verdict self-test ios-check ios-check
    run_make_verdict self-test ios-lint ios-lint
    run_cargo_verdict self-test ios-e2e-harness test --manifest-path "$REPO/Cargo.toml" -p chan-ios --test ios_e2e_harness
    run_make_verdict self-test ios-unit-tests ios-test
    run_cmd_verdict self-test node-unit-tests node --test "$SCRIPT_DIR"/*.test.mjs
    run_stream_verdicts "$SCRIPT_DIR/run-wireguard-mock-e2e.sh"
}

expect_red() {
    local name="$1"
    shift
    local rc=0
    local log_file
    log_file="$(mktemp "$RUN_DIR/probe-${name}.log.XXXXXX")"
    "$@" >"$log_file" 2>&1 || rc="$?"
    if [ "$rc" -eq 1 ]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "verdict probe-red $name 0 PASS detector exited rc=1 as required"
        rm -f "$log_file"
        return 0
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "verdict probe-red $name 1 FAIL expected rc=1, got rc=$rc (see $log_file)" >&2
    return 1
}

expect_prereq() {
    local name="$1"
    shift
    local rc=0
    local log_file
    log_file="$(mktemp "$RUN_DIR/probe-${name}.log.XXXXXX")"
    "$@" >"$log_file" 2>&1 || rc="$?"
    if [ "$rc" -eq 2 ]; then
        PASS_COUNT=$((PASS_COUNT + 1))
        echo "verdict probe-red $name 0 PASS detector exited rc=2 as required"
        rm -f "$log_file"
        return 0
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "verdict probe-red $name 1 FAIL expected rc=2, got rc=$rc (see $log_file)" >&2
    return 1
}

run_probe_red() {
    echo "=== E2E Probe-Red Mode ($SHA) ==="
    expect_red probe-wireguard-live "$SCRIPT_DIR/run-wireguard-mock-e2e.sh" --probe-red
    expect_red probe-contract-matrix node "$SCRIPT_DIR/ios-contract-matrix.mjs" --tier 1 --probe-red
    expect_red probe-contract-matrix-tier2 node "$SCRIPT_DIR/ios-contract-matrix.mjs" --tier 2 --probe-red
    expect_red probe-contract-matrix-tier3 node "$SCRIPT_DIR/ios-contract-matrix.mjs" --tier 3 --probe-red
    expect_red probe-oracle-missing-w node "$SCRIPT_DIR/ios-wireguard-oracle.mjs" window-url \
        "http://alice--0123456789ab.p1.localtest.me:8080/api/ws/index.html?h=0123456789abcdef0123456789abcdef" \
        '{"windowId":"w-1","kind":"workspace"}'
    expect_red probe-oracle-leaked-client-name node "$SCRIPT_DIR/ios-wireguard-oracle.mjs" window-url \
        "http://alice--0123456789ab.p1.localtest.me:8080/api/notes/index.html?w=w-1&h=0123456789abcdef0123456789abcdef&client_name=attacker" \
        '{"windowId":"w-1","kind":"workspace"}'
    expect_red probe-oracle-bad-peer node -e "
        import('$SCRIPT_DIR/ios-wireguard-oracle.mjs').then(({ verifyPeerRouting }) => {
            verifyPeerRouting({ p1: [], p2: [] }, { p1: [], p2: [] }, 'p2', '/probe');
        });
    "
    expect_red probe-oracle-stopped-view node -e "
        import('$SCRIPT_DIR/ios-wireguard-oracle.mjs').then(({ verifyStoppedTunnelView }) => {
            verifyStoppedTunnelView({ wireguard_status: 'connecting' }, 'p1');
        });
    "
    expect_prereq probe-vitest-missing-prereq env CHAN_E2E_VITEST_BIN=/nonexistent/vitest "$SCRIPT_DIR/run-e2e.sh" --tier 1
}

run_tier1() {
    echo "=== Tier 1: Isolated Feature Happy Paths ($SHA) ==="
    run_cargo_verdict tier1 rust-ios-e2e-harness test --manifest-path "$REPO/Cargo.toml" -p chan-ios --test ios_e2e_harness
    run_cmd_verdict tier1 node-harness-tests node --test "$SCRIPT_DIR"/*.test.mjs
    run_make_verdict tier1 f9-ios-check-aarch64 ios-check
    run_make_verdict tier1 f9-ios-lint-clippy ios-lint
    run_make_verdict tier1 f9-ios-unit-suite ios-test
    if ! run_vitest_ios tier1; then :; fi
    run_stream_verdicts node "$SCRIPT_DIR/ios-contract-matrix.mjs" --tier 1
}

run_tier2() {
    echo "=== Tier 2: Boundary, Negative, and Live Loopback WireGuard ($SHA) ==="
    if ! run_vitest_ios tier2; then :; fi
    run_stream_verdicts "$SCRIPT_DIR/run-wireguard-mock-e2e.sh"
    run_stream_verdicts node "$SCRIPT_DIR/ios-contract-matrix.mjs" --tier 2
    run_cmd_verdict tier2 f9-neg-probe-red-wg-live bash -c "rc=0; '$SCRIPT_DIR/run-wireguard-mock-e2e.sh' --probe-red >/dev/null 2>&1 || rc=\$?; [ \"\$rc\" -eq 1 ]"
    run_cmd_verdict tier2 f9-neg-probe-red-oracle bash -c "rc=0; node '$SCRIPT_DIR/ios-wireguard-oracle.mjs' window-url 'http://x.localtest.me/api/n/index.html?h=0123456789abcdef0123456789abcdef' '{\"windowId\":\"w-1\",\"kind\":\"workspace\"}' >/dev/null 2>&1 || rc=\$?; [ \"\$rc\" -eq 1 ]"
    run_cmd_verdict tier2 f9-neg-sim-prereq-never-aliases-pass bash -c "rc=0; IOS_SIM=NonExistentSimXYZ '$SCRIPT_DIR/run-simulator-smoke.sh' --skip-build >/dev/null 2>&1 || rc=\$?; [ \"\$rc\" -eq 2 ]"
    run_cmd_verdict tier2 f9-neg-invalid-tier-exits-2 bash -c "rc=0; '$SCRIPT_DIR/run-e2e.sh' --tier 9 >/dev/null 2>&1 || rc=\$?; [ \"\$rc\" -eq 2 ]"
    run_cmd_verdict tier2 f9-neg-oracle-rejects-leaked-client-name bash -c "rc=0; node '$SCRIPT_DIR/ios-wireguard-oracle.mjs' window-url 'http://alice--0123456789ab.p1.localtest.me:8080/api/notes/index.html?w=w-1&h=0123456789abcdef0123456789abcdef&client_name=attacker' '{\"windowId\":\"w-1\",\"kind\":\"workspace\"}' >/dev/null 2>&1 || rc=\$?; [ \"\$rc\" -eq 1 ]"
}

run_tier3() {
    echo "=== Tier 3: Pairwise Cross-Feature Matrix ($SHA) ==="
    run_stream_verdicts node "$SCRIPT_DIR/ios-contract-matrix.mjs" --tier 3
}

run_tier4() {
    echo "=== Tier 4: Real-World End-to-End Scenarios S1-S6 ($SHA) ==="
    local sim_args=()
    if [ "$SKIP_SIM_BUILD" = 1 ]; then
        sim_args+=(--skip-build)
    fi
    run_stream_verdicts "$SCRIPT_DIR/run-simulator-smoke.sh" "${sim_args[@]}"
    run_cmd_verdict tier4 scenario-s2-wireguard-enroll-and-proxy "$SCRIPT_DIR/run-wireguard-mock-e2e.sh"
    run_cargo_verdict tier4 scenario-s6-adversarial-boundaries test --manifest-path "$REPO/Cargo.toml" -p chan-ios --test ios_e2e_harness
}

case "$MODE" in
    self-test) run_self_test ;;
    probe-red) run_probe_red ;;
    tier)
        case "$TIER" in
            1) run_tier1 ;;
            2) run_tier2 ;;
            3) run_tier3 ;;
            4) run_tier4 ;;
        esac
        ;;
    all)
        run_tier1
        run_tier2
        run_tier3
        run_tier4
        ;;
esac

echo "summary mode=$MODE sha=$SHA pass=$PASS_COUNT fail=$FAIL_COUNT prereq=$PREREQ_COUNT"

if [ "$PREREQ_COUNT" -gt 0 ]; then
    exit 2
fi
if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
fi
exit 0
