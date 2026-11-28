#!/usr/bin/env bash
# Runs browser-smoke checks that need outbound network (check 355 plays a
# real YouTube embed) inside a guest, as root, one verb per call. The tree is
# the built copy at /work/chan (`make web` and `cargo build -p chan` done);
# outputs go under /work/out.
#
#   net            the guest's address, default route and resolver, and one
#                  HTTPS request to a neutral host
#   provision      the non-root test user, its copy of Chrome and the suite's
#                  packages (run.mjs --deps-only), each made only when absent
#   test PREFIXES  run.mjs as the test user under env -i with SMOKE_ONLY set,
#                  with the guest's network
#
# A guest runner that shares the host's network gives each test a private
# loopback with no route out (unshare -rn), which keeps a check's chan off
# the host's loopback and also keeps these checks from their network. This
# script runs the test in the guest's own network instead, so it refuses
# unless the guest has a network namespace of its own: a container
# (systemd-detect-virt) with the veth link systemd-nspawn names host0. There
# the guest's loopback is not the host's, and chan and Chrome bind only to
# it. Every process in the guest can reach out while the test runs.
#
# Exit status: test passes on the runner's (0 every check passed, 1 a check
# failed, 2 a skip, an error or an invalid selection) once results.json agrees
# with it; 3 is a refusal or a run without a matching final results.json.
set -euo pipefail
export HOME=/root
TREE=/work/chan
TEST_USER=chan-smoke
CHROME=/opt/chan-smoke-chrome/chrome
NEUTRAL=https://static.rust-lang.org/dist/channel-rust-1.95.0.toml.sha256

now() { date -u +%FT%TZ; }
refuse() {
    echo "refused: $* $(now)" >&2
    exit 3
}
user_home() { getent passwd "$TEST_USER" | cut -d: -f6; }
as_user() {
    runuser -u "$TEST_USER" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$(user_home)" "$@"
}
require_own_network() {
    [ "$(id -u)" -eq 0 ] || refuse "run as root inside the guest"
    systemd-detect-virt --container --quiet || refuse "not inside a container"
    ip -o link show dev host0 > /dev/null 2>&1 || refuse "no host0 link: this guest shares the host's network namespace"
}

case "${1:-}" in
net)
    require_own_network
    echo "netns=$(readlink /proc/self/ns/net)"
    ip -4 -o addr show dev host0 | awk '{print "addr=" $4}'
    echo "route=$(ip -4 route show default | head -n 1)"
    if getent hosts static.rust-lang.org > /dev/null; then echo "dns=ok"; else echo "dns=fail"; fi
    st=$(timeout 40 curl -sS -o /dev/null --max-time 30 -w '%{http_code}' "$NEUTRAL" 2>&1) || true
    echo "outbound_https=$st url=$NEUTRAL $(now)"
    ;;
provision)
    require_own_network
    cd "$TREE" || refuse "no tree at $TREE"
    [ -x target/debug/chan ] || refuse "no built chan at $TREE/target/debug/chan"
    if ! getent passwd "$TEST_USER" > /dev/null; then
        useradd --create-home --shell /bin/bash "$TEST_USER"
    fi
    [ "$(id -u "$TEST_USER")" -ne 0 ] || refuse "$TEST_USER is uid 0"
    if [ ! -x "$CHROME" ]; then
        chrome_source=$(node --input-type=module -e 'import { defaultChrome } from "./scripts/e2e/browser-smoke/lib/server.mjs"; const p = defaultChrome(); if (!p) process.exit(2); console.log(p);') \
            || refuse "no Chrome in root's puppeteer cache"
        install -d -m 755 "$(dirname "$CHROME")"
        cp -a "$(dirname "$chrome_source")/." "$(dirname "$CHROME")/"
        chmod -R a+rX "$(dirname "$CHROME")"
        echo "chrome_copied_from=$chrome_source"
    fi
    node scripts/e2e/browser-smoke/run.mjs --deps-only
    as_user bash -c '
        set -euo pipefail
        test "$(id -u)" -ne 0
        printf "test_uid=%s\n" "$(id -u)"
        node --version
        "$1" --version
        test -x "$2/target/debug/chan"
        test -r "$2/scripts/e2e/browser-smoke/node_modules/puppeteer-core/package.json"
    ' bash "$CHROME" "$TREE"
    echo "rc=0 provision $(now)"
    ;;
test)
    [ -n "${2:-}" ] || refuse "a test needs a selection"
    require_own_network
    cd "$TREE" || refuse "no tree at $TREE"
    [ -x "$CHROME" ] || refuse "no Chrome at $CHROME (run provision)"
    home=$(user_home)
    [ -n "$home" ] && [ -d "$home" ] || refuse "no test user $TEST_USER (run provision)"
    mkdir -p /work/out /work/tmp
    out=$(mktemp -d "/work/out/$(date -u +%Y%m%dT%H%M%SZ)-networked.XXXXXX") || refuse "no output directory"
    # The run's temp and runtime dirs: the runner refuses the user's own
    # runtime dir, and a short path keeps socket paths under their limit.
    run=$(mktemp -d /work/tmp/net.XXXXXX) || refuse "no run directory"
    trap 'rm -rf -- "$run" || true' EXIT
    chmod 711 "$run"
    install -d -m 700 -o "$TEST_USER" "$run/tmp" "$run/xdg" || refuse "no private dirs under $run"
    chown "$TEST_USER" "$out" || refuse "chown $out"
    echo "out=$out"
    rc=0
    runuser -u "$TEST_USER" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$home" \
        TMPDIR="$run/tmp" CHROME_BIN="$CHROME" \
        SMOKE_SKIP_BUILD=1 SMOKE_ONLY="$2" SMOKE_OUT_DIR="$out" XDG_RUNTIME_DIR="$run/xdg" \
        node scripts/e2e/browser-smoke/run.mjs || rc=$?
    if ! node - "$out/results.json" "$rc" << 'NODE'
const fs = require("node:fs");
try {
    const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const rc = Number(process.argv[3]);
    if (![0, 1, 2].includes(rc) || result.exitCode !== rc ||
        !result.finishedAt || result.status === "running") process.exit(1);
    if (rc === 0 && (result.status !== "passed" || result.ok !== true ||
        !Array.isArray(result.selectedChecks) || result.selectedChecks.length === 0 ||
        result.passed !== result.selectedChecks.length)) process.exit(1);
} catch (error) {
    console.error(`unavailable runner verdict: ${error.message}`);
    process.exit(1);
}
NODE
    then
        echo "runner status $rc has no matching final results.json" >&2
        exit 3
    fi
    echo "rc=$rc test $2 $(now)"
    exit "$rc"
    ;;
*)
    echo "usage: networked-guest.sh net|provision|test PREFIXES" >&2
    exit 3
    ;;
esac
