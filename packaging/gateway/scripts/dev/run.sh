#!/usr/bin/env bash
# packaging/gateway/scripts/dev/run.sh
#
# Foreground runner for the local dev stack. Starts profile,
# identity, devserver-control, and CHAN_DEV_PROXIES devserver-proxy
# nodes (default 1, max 3) concurrently with their generated env
# files sourced; multiplexes stdout/stderr to this terminal with a
# per-service prefix; Ctrl-C cleanly stops them all.
#
# The controller holds a 30s convergence window on boot, so a fresh
# stack takes about half a minute before proxies report ready and
# admit tunnels.
#
# Builds in cargo `dev` profile. First run can take a couple of
# minutes; subsequent runs are incremental.

set -euo pipefail

cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd -P)"
SECRETS_DIR="$SCRIPT_DIR/secrets"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)/gateway"
TLS_SHIM="$SCRIPT_DIR/tls-shim.mjs"
TLS_CERT="$SECRETS_DIR/tls/edge.crt"
TLS_KEY="$SECRETS_DIR/tls/edge.key"

PROXIES=${CHAN_DEV_PROXIES:-1}
case "$PROXIES" in
    1 | 2 | 3) ;;
    *)
        echo "error: CHAN_DEV_PROXIES must be 1, 2 or 3 (got '$PROXIES')" >&2
        exit 2
        ;;
esac

envs=(profile identity devserver-control)
for ((n = 1; n <= PROXIES; n++)); do
    envs+=("devserver-proxy.p$n")
done
for f in "${envs[@]}"; do
    if [[ ! -f "$SECRETS_DIR/$f.env" ]]; then
        echo "error: $SECRETS_DIR/$f.env missing; run packaging/gateway/scripts/dev/setup.sh first" >&2
        exit 1
    fi
done
command -v node >/dev/null || { echo "error: node is required for local TLS edges" >&2; exit 1; }
[[ -f "$TLS_SHIM" && -f "$TLS_CERT" && -f "$TLS_KEY" ]] \
    || { echo "error: local TLS material missing; run setup.sh" >&2; exit 1; }

# Build everything up front so the services don't race to
# compile the same dependency graph from cold.
echo "==> cargo build (workspace)"
(cd "$ROOT" && cargo build --quiet \
    --bin profile-service \
    --bin identity-service \
    --bin devserver-control-service \
    --bin devserver-proxy-service)

pids=()
cleanup() {
    echo
    echo "==> stopping services"
    for pid in "${pids[@]:-}"; do
        kill -INT "$pid" 2>/dev/null || true
    done
    # Give them a beat to drain; then SIGTERM stragglers.
    sleep 1
    for pid in "${pids[@]:-}"; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    rm -f "$SCRIPT_DIR/.run.pid"
}
trap cleanup EXIT INT TERM

# Publish our pgid so an external caller (or another shell) can
# `kill -INT -- -<pgid>` if Ctrl-C ever fails to reach us.
echo "$$" > "$SCRIPT_DIR/.run.pid"

start_service() {
    local name=$1 bin=$2 env=$3 color=$4
    (
        set -a
        # shellcheck disable=SC1090
        . "$env"
        set +a
        cd "$ROOT"
        # Prefix every line so multiplexed output stays readable.
        cargo run --quiet --bin "$bin" 2>&1 \
            | awk -v name="$name" -v c="$color" '
                BEGIN { reset = "\033[0m" }
                { printf "%s%-12s%s | %s\n", c, "[" name "]", reset, $0; fflush() }
              '
    ) &
    pids+=($!)
}

start_tls_edge() {
    local name=$1 listen=$2 target=$3 protocol=$4 color=$5
    (
        node "$TLS_SHIM" "$listen" "$target" "$TLS_CERT" "$TLS_KEY" "$protocol" 2>&1 \
            | awk -v name="$name" -v c="$color" '
                BEGIN { reset = "\033[0m" }
                { printf "%s%-12s%s | %s\n", c, "[" name "]", reset, $0; fflush() }
              '
    ) &
    pids+=($!)
}

# Order: profile first; setup.sh has already run migrations. Identity starts
# second; the controller before the
# proxies so their control streams attach on first try; proxies last
# so their tunnel handshakes go to a live identity.
start_service profile      profile-service     "$SECRETS_DIR/profile.env"     $'\033[36m'
sleep 1
start_service identity     identity-service    "$SECRETS_DIR/identity.env"    $'\033[33m'
start_tls_edge identity-tls 127.0.0.1:17000 127.0.0.1:16900 http1 $'\033[33m'
sleep 1
start_service devserver-control devserver-control-service "$SECRETS_DIR/devserver-control.env" $'\033[32m'
sleep 1
proxy_colors=($'\033[35m' $'\033[34m' $'\033[31m')
for ((n = 1; n <= PROXIES; n++)); do
    start_service "devserver-proxy.p$n" devserver-proxy-service \
        "$SECRETS_DIR/devserver-proxy.p$n.env" "${proxy_colors[$((n - 1))]}"
    start_tls_edge "proxy-tls.p$n" "127.0.0.$n:17002" "127.0.0.$n:16902" http1 \
        "${proxy_colors[$((n - 1))]}"
    start_tls_edge "tunnel-tls.p$n" "127.0.0.$n:17100" "127.0.0.$n:16910" h2 \
        "${proxy_colors[$((n - 1))]}"
    sleep 1
done

echo
echo "==> services starting"
echo "    profile         127.0.0.1:17001"
echo "    identity        https://gw.localtest.me:17000 (TLS) 127.0.0.1:17004 (internal)"
echo "    devserver-control 127.0.0.1:17003 (admin) 127.0.0.1:17101 (h2c control)"
for ((n = 1; n <= PROXIES; n++)); do
    echo "    devserver-proxy.p$n https://p$n.proxy.localtest.me:17002 (TLS node) 127.0.0.$n:17100 (TLS tunnel)"
done
echo
echo "    (proxies: $PROXIES; set CHAN_DEV_PROXIES=3 for the full fleet)"
echo "Open the dashboard: https://gw.localtest.me:17000"
echo "Ctrl-C to stop."
echo

# Poll the pid list every second; bail when any service dies.
# `wait -n` would be cleaner but macOS's bash 3.2 doesn't have it.
exit_code=0
while :; do
    for pid in "${pids[@]}"; do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "==> pid $pid exited; shutting down"
            wait "$pid" 2>/dev/null
            exit_code=$?
            exit "$exit_code"
        fi
    done
    sleep 1
done
