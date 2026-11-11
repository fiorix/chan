#!/usr/bin/env bash
# End-to-end proof of the desktop's WireGuard fabric against a REAL
# chan-desktop under Xvfb: a gateway row naming a wg-quick file whose peer
# is the crate's `wg-peer` example, a loopback Tunnel standing in for a
# gateway host. The desktop's tunnel, its loopback proxy, its HTTP legs and
# its WebKitGTK webviews are the real ones; only the gateway is a stand-in
# that answers 404 to everything and prints what it was asked.
#
# What it proves, one verdict line and exit status per arm:
#   tunnel     the desktop starts the tunnel from the row's file, and the
#              peer sees the handshake complete (the keepalive the file asks
#              for makes it happen at start, before any connection).
#   proxy      the desktop's loopback proxy is listening.
#   discovery  the gateway connect's discovery GET reaches the peer's
#              listener through the proxy and the tunnel, from the desktop's
#              tunnel address, and the desktop reads the peer's 404.
#   probes     from outside the desktop, a plain forward and a CONNECT
#              through the proxy both reach the peer.
#   window     `chan serve` opens a workspace window whose page and `/ws`
#              socket load through the proxied webview: the embedded server
#              answers the socket route 101 and the proxy bridged upgrades.
#              It also reports the most connections to the proxy seen at
#              once while it runs, so the proxy's cap can be judged.
#   launcher   the launcher's socket route (`/api/library/local-theme/watch`)
#              is answered 101 through the same path.
#   refusals   the proxy refused nothing in the run.
#   config     the gateway row and its file survive the desktop's rewrite of
#              its config at start.
#   tunnel-page a tenant window stays on chan's connecting page through a
#               lost session, names the loss, then reaches the tenant again.
#   wrong-key  (--wrong-key only) the desktop's log and gateway row name
#              the missing handshake, endpoint and file without key values;
#              the desktop sends repeated initiations,
#              the peer never handshakes, one session expiry logs at WARN
#              within 100 s of tunnel start, and no ERROR-level line appears.
#
# Two modes prove the always-bound proxy and the live fabric instead of
# the connected-peer arms:
#   --live-adopt    the row starts without a file, and the file arrives
#                   through the library's gateway update route, with the
#                   per-launch bearer read from the launcher page through
#                   WebKitGTK's remote inspector.
#     proxy-first   the proxy listens with tunnels=0 and no tunnel started.
#     launcher-bearer  the launcher page's bearer, read through the
#                   inspector once Ctrl+Shift+P in the terminal window the
#                   start opened has built the launcher; an unauthenticated
#                   list answers 401.
#     adopt         the update answers the live status, the tunnel starts
#                   and the peer sees a handshake, in the same desktop
#                   process with the same proxy address.
#     tenant        the gateway connect answers 409 naming the stand-in's
#                   discovery 404, its discovery GET and a fetch from the
#                   launcher page reach the peer from the desktop's tunnel
#                   address, and the same fetch, sent before the update, did
#                   not.
#     retire        clearing the file retires the tunnel, a CONNECT to the
#                   peer through the proxy is refused, the peer is asked
#                   nothing more and the file leaves the config.
#   --no-wireguard  no gateway row at all: proxy-first, then the window,
#                   launcher and refusals arms, which prove the always-bound
#                   proxy is the local windows' path on Linux.
#   --enroll        a gateway that enrolls WireGuard keys: the row starts
#                   with no key and no file, its gateway is the stand-in
#                   identity `stub-identity.mjs`, and the desktop's browser
#                   is a stand-in `xdg-open` that records the URL it is given
#                   and walks the redirect with curl. Two peers start once
#                   the desktop has minted the key they both admit.
#     proxy-first, launcher-bearer  as for --live-adopt.
#     key           the library's key route answers the row with a public
#                   key, not enrolled, and the key file is owner-only in an
#                   owner-only directory.
#     authorize     Connect answers 204 and the desktop opens one authorize
#                   URL carrying that key, which the identity records; the
#                   walk is redirected to the desktop's callback, which
#                   answers 303.
#     adopt         the redeem's parameters are stored on the row with its
#                   one owner-only key file and no client file, the running
#                   fabric starts both tunnels and both peers handshake;
#                   each ingress projects up, the row reads connected, in the
#                   same desktop process with the same proxy address; the
#                   private key is in the key file and in no other file of
#                   the run.
#     tenant        disabled rows at each node's mapped name: discovery and
#                   a launcher fetch under its wildcard reach only its own
#                   peer at the shared inner address. Before enrollment,
#                   neither request reaches any peer.
#   --reconcile     enrolls p1/p2, adds p3 to discovery, then connects again.
#     reconcile     p3 starts and routes its names without another sign-in,
#                   key rewrite, desktop/proxy restart or p1/p2 tunnel restart;
#                   all three nodes still route independently.
#
# What it cannot prove: a real gateway's TLS and identity behind the proxy
# (the peer answers 404 to everything, and --enroll's identity has no OAuth
# or consent page), the macOS and Windows webviews, and a peer behind NAT or
# at a changing address.
#
# Usage: desktop-wireguard.sh [--unresolved-endpoint | --wrong-key | --live-adopt | --no-wireguard | --enroll | --reconcile]
#   --unresolved-endpoint proves startup and the proxy with a missing name;
#                         it runs instead of the connected-peer arms.
#   --wrong-key           proves the missing-handshake error and expiry with
#                         a wrong peer public key instead of the connected arms;
#                         needs node 22 or later for the gateway-list read.
#   --live-adopt          proves the live fabric (above); needs node 22 or
#                         later for the inspector reads.
#   --no-wireguard        proves the always-bound proxy with no gateway row.
#   --enroll              proves enrollment at sign-in (above); needs node 22
#                         or later for the identity and the inspector reads.
#   --reconcile           also proves adding an ingress without another sign-in.
#   The modes are exclusive: one is taken, and anything after it is refused.
#   CHAN_DESKTOP_BIN  a built debug chan-desktop (default
#                     target/debug/chan-desktop). It is not built here: it
#                     needs the web bundles, `make web` then
#                     `cargo build -p chan-desktop`.
#   CHAN_BIN          a built chan (default: built here with --locked)
#   WG_PEER_BIN       a built wg-peer example (default: built here)
#
# Needs xvfb-run, dbus-run-session, curl and Node 22 or later, and ss for the window arm's
# connection count (reported as unmeasured without it). Exits 2 when a
# prerequisite is missing rather than passing. Everything runs under a
# throwaway CHAN_HOME, HOME, XDG_RUNTIME_DIR and TMPDIR. The desktop and
# its webviews use Xvfb and a private session bus, with no caller display
# or bus inherited. The work dir is deleted on success or refusal and kept
# on test failure. The kept work dir holds the run's client file with a
# private key that is worthless once the peer process is gone, but treat
# it as a credential until deleted. A kept --live-adopt work dir also
# holds the launcher bearer of a desktop that is gone, in bearer.header,
# read by curl so it is on no command line. A kept --enroll work dir holds
# the desktop's key file under chan-home, worthless once the peer is gone.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
CHAN_DESKTOP_BIN="${CHAN_DESKTOP_BIN:-$REPO/target/debug/chan-desktop}"
GATEWAY_ID="gw-e2e00001"
UNRESOLVED=0
WRONG_KEY=0
LIVE_ADOPT=0
NO_WIREGUARD=0
ENROLL=0
RECONCILE=0
case "${1:-}" in
    --unresolved-endpoint) UNRESOLVED=1; shift ;;
    --wrong-key) WRONG_KEY=1; shift ;;
    --live-adopt) LIVE_ADOPT=1; shift ;;
    --no-wireguard) NO_WIREGUARD=1; shift ;;
    --enroll) ENROLL=1; shift ;;
    --reconcile) ENROLL=1; RECONCILE=1; shift ;;
esac
[ "$#" = 0 ] || { printf 'unknown arguments: %s\n' "$*" >&2; exit 2; }

log() { printf 'desktop-wireguard: %s\n' "$*" >&2; }
refuse() {
    log "cannot run: $*"
    [ -z "${WORK:-}" ] || rm -rf -- "$WORK"
    exit 2
}
fail() {
    log "FAIL: $*"
    log "work dir kept at $WORK"
    exit 1
}
FAILED=0
verdict() {
    # verdict <arm> <rc> <detail>: one line per arm, with the arm's own status.
    local arm="$1" rc="$2"; shift 2
    if [ "$rc" = 0 ]; then
        printf 'desktop-wireguard: %s rc=0 PASS %s\n' "$arm" "$*"
    else
        printf 'desktop-wireguard: %s rc=%s FAIL %s\n' "$arm" "$rc" "$*"
        FAILED=$((FAILED + 1))
    fi
}

command -v xvfb-run >/dev/null 2>&1 || refuse "xvfb-run is not installed"
command -v dbus-run-session >/dev/null 2>&1 || refuse "dbus-run-session is not installed"
command -v curl >/dev/null 2>&1 || refuse "curl is not installed"
command -v python3 >/dev/null 2>&1 || refuse "python3 is not installed"
command -v node >/dev/null 2>&1 || refuse "node 22 or later is not installed"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 22 ] || refuse "node 22 or later is required for inspect.mjs"
[ -x "$CHAN_DESKTOP_BIN" ] || refuse "no chan-desktop binary at $CHAN_DESKTOP_BIN (set CHAN_DESKTOP_BIN)"
INSPECT="$REPO/scripts/e2e/desktop-observations/inspect.mjs"
[ -f "$INSPECT" ] || refuse "no inspector helper at $INSPECT"

if [ -z "${CHAN_BIN:-}" ]; then
    log "building chan at $SHA"
    (cd "$REPO" && cargo build --locked -p chan >/dev/null)
    CHAN_BIN="$REPO/target/debug/chan"
fi
[ -x "$CHAN_BIN" ] || refuse "no chan binary at $CHAN_BIN"
if [ -z "${WG_PEER_BIN:-}" ]; then
    log "building the wg-peer example at $SHA"
    (cd "$REPO" && cargo build --locked -p chan-wireguard --example wg-peer >/dev/null)
    WG_PEER_BIN="$REPO/target/debug/examples/wg-peer"
fi
[ -x "$WG_PEER_BIN" ] || refuse "no wg-peer binary at $WG_PEER_BIN"
IDENTITY="$REPO/scripts/e2e/stub-identity.mjs"
ENROLLMENT_ORACLE="$REPO/scripts/e2e/wireguard-enrollment-oracle.mjs"
if [ "$ENROLL" = 1 ]; then
    command -v node >/dev/null 2>&1 || refuse "node is not installed (--enroll runs stub-identity.mjs and reads the launcher through inspect.mjs)"
    [ -f "$INSPECT" ] || refuse "no inspector helper at $INSPECT"
    [ -f "$IDENTITY" ] || refuse "no stand-in identity at $IDENTITY"
    [ -f "$ENROLLMENT_ORACLE" ] || refuse "no enrollment evidence reader at $ENROLLMENT_ORACLE"
fi

PIDS=()
descendants() {
    local parent child
    local -a pending=("$1")
    while [ "${#pending[@]}" -gt 0 ]; do
        parent="${pending[0]}"
        pending=("${pending[@]:1}")
        while IFS= read -r child; do
            [ -n "$child" ] || continue
            printf '%s\n' "$child"
            pending+=("$child")
        done < <(pgrep -P "$parent" || true)
    done
}
desktop_pid() {
    local child bin
    bin="$(readlink -f "$CHAN_DESKTOP_BIN")"
    for child in $(descendants "$XVFB_RUN_PID"); do
        [ "$(readlink -f "/proc/$child/exe" 2>/dev/null || true)" = "$bin" ] || continue
        printf '%s\n' "$child"
        return 0
    done
    return 1
}
cleanup() {
    # End the desktop first so dbus-run-session can end its daemon, then
    # end any surviving descendants of this run's xvfb-run process.
    local pid desktop i
    local -a tree=()
    if [ -n "${XVFB_RUN_PID:-}" ]; then
        mapfile -t tree < <(descendants "$XVFB_RUN_PID")
        desktop="$(desktop_pid || true)"
        [ -z "$desktop" ] || kill "$desktop" 2>/dev/null || true
        for i in {1..10}; do
            kill -0 "$XVFB_RUN_PID" 2>/dev/null || break
            sleep 0.2
        done
        for ((i=${#tree[@]}-1; i>=0; i--)); do
            kill "${tree[i]}" 2>/dev/null || true
        done
    fi
    # A frozen peer or devserver cannot receive TERM until resumed.
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        kill -s CONT "$pid" 2>/dev/null || true
    done
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        kill "$pid" 2>/dev/null || true
    done
    [ "${#PIDS[@]}" -gt 0 ] || return 0
    sleep 1
    for pid in "${tree[@]}"; do
        kill -9 "$pid" 2>/dev/null || true
    done
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        kill -9 "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-desktop-wireguard.XXXXXX")"
export CHAN_HOME="$WORK/chan-home"
export HOME="$WORK/home"
export XDG_RUNTIME_DIR="$WORK/run"
export TMPDIR="$WORK/tmp"
# A test launched from inside a chan terminal must not inherit session
# state, handoff hints, or credentials.
for v in $(compgen -v | grep -E '^CHAN_' | grep -vE '^CHAN_(HOME|BIN|DESKTOP_BIN)$'); do unset "$v"; done
# DISPLAY reaches X11 clients outside xvfb-run, while a session bus address
# reaches GTK and WebKitGTK clients inside it. Wayland names a socket or an
# inherited descriptor that could put the webviews on the caller's compositor.
unset DISPLAY DBUS_SESSION_BUS_ADDRESS WAYLAND_DISPLAY WAYLAND_SOCKET
export GDK_BACKEND=x11
# The desktop and devserver control sockets live in XDG_RUNTIME_DIR. This
# run derives a private path inside its work dir, but checks its resolved
# destination before creating or changing it to protect the caller's
# own (/run/user/<uid>) desktop and devserver sockets.
private_runtime_dir_reason() {
    local dir="${XDG_RUNTIME_DIR:-}" actual own
    [ -n "$dir" ] || { echo "XDG_RUNTIME_DIR is unset"; return; }
    actual="$(realpath -m -- "$dir")"
    own="/run/user/$(id -u)"
    own="$(realpath -e -- "$own" 2>/dev/null || echo "$own")"
    [ "$actual" != "$own" ] || echo "XDG_RUNTIME_DIR=$dir is this user's own runtime directory ($own)"
}
reason="$(private_runtime_dir_reason)"
[ -z "$reason" ] || refuse "$reason"
mkdir -p "$CHAN_HOME/desktop" "$HOME" "$XDG_RUNTIME_DIR" "$TMPDIR"
chmod 700 "$XDG_RUNTIME_DIR"
export CHAN_UPDATE_CHECK=0
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1
# The proxy's forwarding, CONNECT, bridged-upgrade and refusal lines come
# from chan_wireguard at debug, and the embedded server's request spans and
# response statuses, which name the socket routes, from chan_server and
# tower_http at debug.
export CHAN_LOG="chan_desktop=debug,chan_wireguard=debug,chan_server=debug,tower_http=debug,warn"

wait_for() {
    # wait_for <seconds> <description> <command...>: poll until the command
    # succeeds; returns 1 at the bound instead of exiting, so an arm can
    # record the miss as its own failure.
    local secs="$1" what="$2"; shift 2
    local deadline=$((SECONDS + secs))
    until "$@"; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            log "timed out waiting for $what"
            return 1
        fi
        sleep 0.5
    done
}
# tracing colours stderr even into a file; every read goes through a
# stripped copy, written whole rather than piped: `sed | grep -q` under
# pipefail reports sed's SIGPIPE once the log outgrows the pipe buffer.
CLEAN="$WORK/desktop.clean.log"
desktop_log() { sed 's/\x1b\[[0-9;]*m//g' "$WORK/desktop.log" > "$CLEAN"; }
logged() { desktop_log; grep -qE -- "$1" "$CLEAN"; }
count() { desktop_log; grep -cE -- "$1" "$CLEAN" || true; }
peer_logged() { grep -qE -- "$1" "$WORK/peer.log"; }
identity_logged() { grep -qE -- "$1" "$WORK/identity.log"; }

# Every enrolled peer has the same inner listener. Only the mapped node
# name can select the right tunnel; separate logs establish that routing.
ENROLL_PEERS=()
enrollment_oracle() { node "$ENROLLMENT_ORACLE" "$@" 2>>"$WORK/oracle.err"; }
enrollment_peer_logged() { grep -qE -- "$2" "$WORK/peer-$1.log"; }
start_enrollment_peer() {
    local id="$1" key="$2" log_file="$WORK/peer-$1.log"
    "$WG_PEER_BIN" --client-key "$key" > "$log_file" 2>&1 &
    PIDS+=("$!")
    wait_for 20 "peer $id" enrollment_peer_logged "$id" '^peer: ready' || fail "peer $id did not start; see $log_file"
    ENROLL_PEERS+=("$log_file")
}
identity_peers() {
    enrollment_oracle fixture "$WORK/identity-peer.json" "${ENROLL_PEERS[@]}" || fail "invalid peer fixture; see oracle.err"
}

# The desktop's browser for --enroll, an `xdg-open` first on its PATH, in
# the work dir's bin: it records the URL it is given and walks the answer's
# redirect to the desktop's callback with curl, recording both statuses.
# The callback URL carries the one-time code, so it is not recorded, and
# curl reads it from a config line on stdin rather than its command line.
stand_in_browser() {
    cat <<'SH'
#!/usr/bin/env bash
work="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\n' "$1" >> "$work/browser.urls"
answer="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' "$1" 2>>"$work/browser.err" || echo curl-failed)"
status="${answer%% *}" callback="${answer#* }" landing=none
if [ "$status" = 302 ] && [ -n "$callback" ]; then
    quoted="${callback//\\/\\\\}"
    quoted="${quoted//\"/\\\"}"
    landing="$(printf 'url = "%s"\n' "$quoted" | curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -K - 2>>"$work/browser.err" || echo curl-failed)"
fi
printf 'browser: authorize=%s callback=%s\n' "$status" "$landing" >> "$work/browser.log"
SH
}
session_warnings() {
    awk '$2 == "WARN" && $3 == "chan_wireguard::tunnel:" && $4 == "WireGuard" && $5 == "session" { n++ } END { print n+0 }' "$1"
}
session_expiry_logged() {
    desktop_log || return 1
    [ "$(session_warnings "$CLEAN")" -ge 1 ]
}
free_port() { python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }

log "work dir $WORK, chan $SHA"

# --enroll starts its peer in the arm, once the desktop has minted the key
# the peer must admit.
if [ "$ENROLL" = 0 ]; then
# 1. The far side: the peer, which writes the client's file.
DS_PORT="$(free_port)"
"$WG_PEER_BIN" "$WORK/client.conf" --forward "8081=127.0.0.1:$DS_PORT" > "$WORK/peer.log" 2>&1 &
PEER_PID=$!
PIDS+=("$PEER_PID")
wait_for 20 "the peer" peer_logged '^peer: ready' || fail "the peer did not start: $(cat "$WORK/peer.log")"
peer_logged 'forward=10\.7\.0\.2:8081->127\.0\.0\.1:' || fail "the peer did not open its forwarded listener"
PEER_URL="$(sed -n 's/^peer: ready url=\([^ ]*\).*/\1/p' "$WORK/peer.log" | head -1)"
[ -n "$PEER_URL" ] || fail "the peer printed no URL: $(cat "$WORK/peer.log")"
log "peer at $PEER_URL, client file $WORK/client.conf (mode $(stat -c %a "$WORK/client.conf"))"
if [ "$UNRESOLVED" = 1 ]; then
    sed -i 's/^Endpoint = .*/Endpoint = chan-endpoint-missing.invalid:51820/' "$WORK/client.conf"
elif [ "$WRONG_KEY" = 1 ]; then
    PEER_PUBLIC_KEY="$(sed -n 's/^PublicKey = //p' "$WORK/client.conf")"
    CLIENT_PRIVATE_KEY="$(sed -n 's/^PrivateKey = //p' "$WORK/client.conf")"
    WG_ENDPOINT="$(sed -n 's/^Endpoint = //p' "$WORK/client.conf")"
    WRONG_PUBLIC_KEY="$(head -c 32 /dev/urandom | base64)"
    [ -n "$PEER_PUBLIC_KEY" ] && [ -n "$CLIENT_PRIVATE_KEY" ] && [ -n "$WG_ENDPOINT" ] && [ -n "$WRONG_PUBLIC_KEY" ] || fail "the client file lacks a key or endpoint"
    sed -i "s|^PublicKey = .*|PublicKey = $WRONG_PUBLIC_KEY|" "$WORK/client.conf"
fi
fi

# 2. The desktop's config, one branch per mode: one enabled gateway behind
# the file, except that --live-adopt starts the row without its file,
# --no-wireguard has no row and --enroll has no peer yet.
if [ "$LIVE_ADOPT" = 1 ]; then
    cat > "$CHAN_HOME/desktop/config.json" <<JSON
{"gateways":[{"id":"$GATEWAY_ID","url":"$PEER_URL","label":"wg","enabled":true,"added_at":0,"native_trust":[]}]}
JSON
elif [ "$NO_WIREGUARD" = 1 ]; then
    printf '{"gateways":[]}\n' > "$CHAN_HOME/desktop/config.json"
elif [ "$ENROLL" = 1 ]; then
    # Discovery offers enrollment before the desktop mints its key; the
    # placeholders are replaced once both peers can admit that key.
    enrollment_oracle seed "$WORK/identity-peer.json" || fail "could not seed identity fixture"
    node "$IDENTITY" "$WORK/identity-peer.json" > "$WORK/identity.log" 2>&1 &
    PIDS+=("$!")
    wait_for 20 "the identity" identity_logged '^identity: ready' || fail "the identity did not start: $(cat "$WORK/identity.log")"
    IDENTITY_ORIGIN="$(sed -n 's/^identity: ready origin=\(http:[^ ]*\)$/\1/p' "$WORK/identity.log" | head -1)"
    [ -n "$IDENTITY_ORIGIN" ] || fail "the identity printed no origin: $(cat "$WORK/identity.log")"
    node -e '
        const [file, id, origin, count] = process.argv.slice(1);
        const gateways = [{id, url: origin, label: "wg", enabled: true, added_at: 0, native_trust: []}];
        for (let n = 1; n <= Number(count); n++) gateways.push({
            id: `gw-tenant-p${n}`, url: `http://p${n}.proxy.chan-e2e.invalid:8080`,
            label: `tenant-p${n}`, enabled: false, added_at: 0, native_trust: [],
        });
        require("fs").writeFileSync(file, JSON.stringify({gateways}) + "\n");
    ' "$CHAN_HOME/desktop/config.json" "$GATEWAY_ID" "$IDENTITY_ORIGIN" "$((2 + RECONCILE))"
    mkdir -p "$WORK/bin"
    stand_in_browser > "$WORK/bin/xdg-open"
    chmod 700 "$WORK/bin/xdg-open"
    export PATH="$WORK/bin:$PATH"
else
    cat > "$CHAN_HOME/desktop/config.json" <<JSON
{"gateways":[{"id":"$GATEWAY_ID","url":"$PEER_URL","label":"wg","enabled":true,"added_at":0,"native_trust":[],"wireguard":"$WORK/client.conf"}]}
JSON
fi
# The launcher's page is read through WebKitGTK's remote inspector, which
# the desktop's webviews serve only when this is set before they start.
INSPECTOR="127.0.0.1:$(free_port)"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"

# 3. The desktop, headless.
xvfb-run -a dbus-run-session "$CHAN_DESKTOP_BIN" > "$WORK/desktop.log" 2>&1 &
XVFB_RUN_PID=$!
PIDS+=("$XVFB_RUN_PID")

wait_for 90 "the desktop handoff socket" test -S "$XDG_RUNTIME_DIR/chan-desktop.sock" || { desktop_log; fail "the desktop did not come up: $(tail -5 "$CLEAN")"; }

# `chan serve` hands a workspace to the desktop only when its own
# environment names a display, and xvfb-run gives one to the desktop
# alone; without it serve starts a standalone server that never returns.
# The CLI calls below take the desktop's display, read from its process.
desktop_display() {
    local child
    child="$(desktop_pid)" || return 1
    tr '\0' '\n' < "/proc/$child/environ" | sed -n '/^DISPLAY=/p; /^DBUS_SESSION_BUS_ADDRESS=/p'
}
desktop_env="$(desktop_display)" || fail "no chan-desktop process under xvfb-run (pid $XVFB_RUN_PID)"
DISPLAY="$(printf '%s\n' "$desktop_env" | sed -n 's/^DISPLAY=//p')"
DBUS_SESSION_BUS_ADDRESS="$(printf '%s\n' "$desktop_env" | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')"
[ -n "$DISPLAY" ] || fail "the desktop's environment names no DISPLAY"
[ -n "$DBUS_SESSION_BUS_ADDRESS" ] || fail "the desktop's environment names no session bus"
export DISPLAY
log "the desktop runs on display $DISPLAY with bus $DBUS_SESSION_BUS_ADDRESS"

# The chan-desktop process under xvfb-run, found by its executable among
# xvfb-run's descendants.
desktop_pid() {
    local bin pid
    local -a queue=("$XVFB_RUN_PID")
    bin="$(readlink -f "$CHAN_DESKTOP_BIN")"
    while [ "${#queue[@]}" -gt 0 ]; do
        pid="${queue[0]}"
        queue=("${queue[@]:1}")
        if [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" = "$bin" ]; then
            printf '%s\n' "$pid"
            return 0
        fi
        mapfile -t -O "${#queue[@]}" queue < <(pgrep -P "$pid" || true)
    done
    return 1
}

proxy_addresses() { desktop_log; sed -n 's/.*gateway WireGuard proxy listening.*proxy=\(127\.0\.0\.1:[0-9]*\).*/\1/p' "$CLEAN"; }

finish_mode() {
    if [ "$FAILED" != 0 ]; then
        log "FAIL: $FAILED arm(s) failed at $SHA; work dir kept at $WORK"
        exit 1
    fi
    log "PASS at $SHA; work dir $WORK removed"
    cleanup
    trap - EXIT
    rm -rf "${WORK:?}"
    exit 0
}

# proxy-first: the proxy listens before any tunnel, and none started.
proxy_first_arm() {
    local arm_rc=0 started tunnels
    wait_for 30 "the proxy line with no tunnel" logged 'gateway WireGuard proxy listening.*tunnels=0( |$)' || arm_rc=1
    PROXY="$(proxy_addresses | head -1)"
    [ -n "$PROXY" ] || arm_rc=1
    tunnels="$(sed -n 's/.*gateway WireGuard proxy listening.* tunnels=\([0-9]*\).*/\1/p' "$CLEAN" | head -1)"
    started="$(count 'gateway WireGuard tunnel started')"
    [ "$started" = 0 ] || arm_rc=1
    verdict proxy-first "$arm_rc" "proxy at ${PROXY:-none} with tunnels=${tunnels:-none} (want 0), tunnel start lines $started (want 0)"
    [ -n "$PROXY" ] || fail "no proxy address: every later arm needs it"
}

# The launcher page's URL, `{origin}/?t={bearer}`, as the inspector reads it.
LAUNCHER_HREF=""
launcher_href() {
    local value
    value="$(node "$INSPECT" "$INSPECTOR" eval 'Chan Launcher' 'location.href' 2>>"$WORK/inspect.err")" || return 1
    value="${value#\"}"
    LAUNCHER_HREF="${value%\"}"
    case "$LAUNCHER_HREF" in http://127.0.0.1:*'/?t='?*) return 0 ;; esac
    return 1
}

# The launcher webview is built on its window's first toggle, and a
# desktop started with no workspace shows only its standalone terminal
# window, so no launcher page exists until someone opens it. The arm opens
# it the way a user does: Ctrl+Shift+P in that window, which the window's
# key bridge sends to the toggle_launcher_panel command. The chord is
# dispatched into the terminal page through the inspector.
page_listed() { node "$INSPECT" "$INSPECTOR" list 2>>"$WORK/inspect.err" | grep -qF -- "$1"; }
terminal_listed() { page_listed 'kind=terminal'; }
toggle_launcher() {
    node "$INSPECT" "$INSPECTOR" eval 'kind=terminal' \
        "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true})) && 'dispatched'" \
        >>"$WORK/inspect.out" 2>>"$WORK/inspect.err"
}

# A fetch from the launcher page, which goes through the webview's proxy.
launcher_fetch() {
    node "$INSPECT" "$INSPECTOR" eval 'Chan Launcher' \
        "fetch('$1', {mode: 'no-cors'}).then(() => 'sent', e => 'failed: ' + e.message)" \
        >>"$WORK/inspect.out" 2>>"$WORK/inspect.err"
}

# A library call with the launcher bearer: the status on stdout, the body
# in the named file. The bearer is read by curl from a file, so it is on
# no command line.
library_call() {
    local method="$1" path="$2" body="$3" out="$4"
    curl -sS --max-time 30 -o "$out" -w '%{http_code}' -X "$method" \
        -H @"$WORK/bearer.header" -H 'content-type: application/json' \
        ${body:+--data "$body"} "$ORIGIN$path" 2>>"$WORK/curl.err" || echo curl-failed
}

wrong_key_arm() {
    local arm_rc=0 startup_ok=no list_status=unread row_error=unread
    local expiry_deadline expiry_wait origin token initiations handshake expiry_warns error_lines
    wait_for 30 "the tunnel start line" logged "gateway WireGuard tunnel started.*gateway=$GATEWAY_ID" || arm_rc=1
    expiry_deadline=$((SECONDS + 100))
    wait_for 60 "the wrong-key discovery error" logged 'startup gateway connect failed' || arm_rc=1
    desktop_log || arm_rc=1
    if python3 -I "$REPO/scripts/e2e/wgwrongkey-oracle.py" startup "$CLEAN" "$WG_ENDPOINT" "$WORK/client.conf" > /dev/null 2>>"$WORK/oracle.err"; then
        startup_ok=yes
    else
        arm_rc=1
    fi
    # The per-launch bearer comes from the launcher webview, opened from the
    # standalone terminal as in the live-adopt arm.
    if ! page_listed 'Chan Launcher'; then
        wait_for 60 "the terminal window's page in the inspector" terminal_listed || arm_rc=1
        if ! toggle_launcher; then arm_rc=1; fi
    fi
    if wait_for 60 "the launcher page in the inspector" launcher_href; then
        origin="${LAUNCHER_HREF%%/\?t=*}"
        token="${LAUNCHER_HREF##*\?t=}"
        token="${token%%&*}"
        ORIGIN="$origin"
        ( umask 077; printf 'Authorization: Bearer %s\n' "$token" > "$WORK/bearer.header" )
        list_status="$(library_call GET '/api/library/gateways' '' "$WORK/wrong-key-gateways.json")"
        [ "$list_status" = 200 ] || arm_rc=1
        row_error="$(python3 -I "$REPO/scripts/e2e/wgwrongkey-oracle.py" wrong-key "$WORK/wrong-key-gateways.json" "$GATEWAY_ID" "$WG_ENDPOINT" "$WORK/client.conf" 2>>"$WORK/oracle.err")" || arm_rc=1
    else
        arm_rc=1
    fi

    expiry_wait=$((expiry_deadline - SECONDS))
    [ "$expiry_wait" -ge 0 ] || expiry_wait=0
    wait_for "$expiry_wait" "the session-expiry warning" session_expiry_logged || arm_rc=1
    desktop_log || arm_rc=1
    # Keys go to the scanner on stdin, never in argv, output or a verdict.
    if ! printf '%s\n' "$PEER_PUBLIC_KEY" "$WRONG_PUBLIC_KEY" "$CLIENT_PRIVATE_KEY" |
        python3 -I "$REPO/scripts/e2e/wgwrongkey-oracle.py" clean-log "$CLEAN" > /dev/null 2>>"$WORK/oracle.err"; then
        arm_rc=1
    fi
    initiations="$(count 'Sending handshake_initiation')"
    handshake="$(awk '/^status: / { last=$0 } END { print last }' "$WORK/peer.log")"
    expiry_warns="$(session_warnings "$CLEAN")"
    error_lines="$(awk '$2 == "ERROR" { n++ } END { print n+0 }' "$CLEAN")"
    [ "$initiations" -ge 2 ] || arm_rc=1
    case "$handshake" in 'status: handshake=never '*) ;; *) arm_rc=1 ;; esac
    [ "$expiry_warns" = 1 ] && [ "$error_lines" = 0 ] || arm_rc=1
    verdict wrong-key "$arm_rc" "startup named=$startup_ok, list HTTP $list_status, row '$(printf '%s' "$row_error" | cut -c1-80)', desktop sent $initiations initiations, peer ${handshake:-no status}, session warnings $expiry_warns (want 1), ERROR lines $error_lines (want 0)"
    unset PEER_PUBLIC_KEY WRONG_PUBLIC_KEY CLIENT_PRIVATE_KEY
    finish_mode
}

if [ "$WRONG_KEY" = 1 ]; then
    wrong_key_arm
fi

STARTED_BEFORE=0
started_grew() { [ "$(count 'gateway WireGuard tunnel started')" -gt "$STARTED_BEFORE" ]; }

# launcher-bearer: the bearer of the library's routes, from the launcher
# page, which the toggle chord opens when the start showed none.
launcher_bearer_arm() {
    local arm_rc=0 control toggled=no token
    if ! page_listed 'Chan Launcher'; then
        wait_for 60 "the terminal window's page in the inspector" terminal_listed || arm_rc=1
        if toggle_launcher; then toggled=yes; else arm_rc=1; fi
    fi
    wait_for 60 "the launcher page in the inspector" launcher_href || arm_rc=1
    ORIGIN="${LAUNCHER_HREF%%/\?t=*}"
    token="${LAUNCHER_HREF##*\?t=}"
    token="${token%%&*}"
    ( umask 077; printf 'Authorization: Bearer %s\n' "$token" > "$WORK/bearer.header" )
    control="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$ORIGIN/api/library/gateways" 2>>"$WORK/curl.err" || echo curl-failed)"
    [ "$control" = 401 ] || arm_rc=1
    verdict launcher-bearer "$arm_rc" "launcher page at ${ORIGIN:-none} (opened by the toggle chord: $toggled), an unauthenticated list answered $control (want 401)"
    [ "$arm_rc" = 0 ] || fail "no launcher bearer: the arms after it need it"
}

live_adopt_arms() {
    local arm_rc pid_before pid_after adopt_status adopt_body
    local listening addresses peer_requests probe retire_status retire_body
    local control_sent=no
    proxy_first_arm
    launcher_bearer_arm

    # The control for the tenant arm: before the file, the webview's fetch
    # to the peer has no route to it. Whether it was sent is the tenant
    # arm's to judge, since an unsent control proves nothing.
    if launcher_fetch "$PEER_URL/webview-probe-before"; then control_sent=yes; fi

    # adopt: the file arrives through the update route of the running desktop.
    arm_rc=0
    pid_before="$(desktop_pid || echo none)"
    STARTED_BEFORE="$(count 'gateway WireGuard tunnel started')"
    adopt_body="$WORK/adopt.json"
    adopt_status="$(library_call PUT "/api/library/gateways/$GATEWAY_ID" \
        "{\"url\":\"\",\"label\":\"wg\",\"wireguard\":\"$WORK/client.conf\"}" "$adopt_body")"
    [ "$adopt_status" = 200 ] || arm_rc=1
    grep -Eq '"wireguard_status":"(connecting|up)' "$adopt_body" 2>/dev/null || arm_rc=1
    if grep -q 'wireguard_restart_required' "$adopt_body" 2>/dev/null; then arm_rc=1; fi
    wait_for 30 "the tunnel start line" started_grew || arm_rc=1
    wait_for 30 "the handshake at the peer" peer_logged '^status: handshake=[0-9]' || arm_rc=1
    listening="$(count 'gateway WireGuard proxy listening')"
    addresses="$(proxy_addresses | sort -u | tr '\n' ' ')"
    [ "$listening" = 1 ] || arm_rc=1
    [ "$addresses" = "$PROXY " ] || arm_rc=1
    pid_after="$(desktop_pid || echo none)"
    [ "$pid_before" != none ] && [ "$pid_after" = "$pid_before" ] || arm_rc=1
    verdict adopt "$arm_rc" "PUT answered $adopt_status, status $(grep -Eo '"wireguard_status":[^,}]*' "$adopt_body" 2>/dev/null || echo none), tunnel start lines $STARTED_BEFORE -> $(count 'gateway WireGuard tunnel started'), proxy lines $listening at ${addresses% }, desktop pid $pid_before -> $pid_after, peer $(grep -E '^status: ' "$WORK/peer.log" | tail -1 | cut -d' ' -f2-)"

    # tenant: the HTTP leg and the webview leg reach the peer through the
    # adopted tunnel.
    arm_rc=0
    local connect_status
    connect_status="$(library_call POST "/api/library/gateways/$GATEWAY_ID/connect" "" "$WORK/connect.json")"
    # The stand-in gateway answers 404 to discovery, so the connect fails
    # there, and the desktop bridge answers a failed connect 409 with the
    # desktop's reason; any other status means the call itself was refused.
    # The response body and the gateway list independently name the 404.
    [ "$connect_status" = 409 ] || arm_rc=1
    local body_404=no
    if grep -q 'gateway discovery returned HTTP 404' "$WORK/connect.json" 2>/dev/null; then body_404=yes; else arm_rc=1; fi
    local list_status row_404=no row_error=unread
    list_status="$(library_call GET '/api/library/gateways' '' "$WORK/tenant-gateways.json")"
    [ "$list_status" = 200 ] || arm_rc=1
    if row_error="$(python3 -I "$REPO/scripts/e2e/wgwrongkey-oracle.py" tenant "$WORK/tenant-gateways.json" "$GATEWAY_ID" 2>>"$WORK/oracle.err")"; then
        row_404=yes
    else
        arm_rc=1
    fi
    wait_for 60 "the discovery request at the peer" peer_logged '^request: from=10\.7\.0\.1:[0-9]+ line=GET /\.well-known/chan-gateway' || arm_rc=1
    launcher_fetch "$PEER_URL/webview-probe" || arm_rc=1
    wait_for 30 "the webview's fetch at the peer" peer_logged '^request: from=10\.7\.0\.1:[0-9]+ line=GET /webview-probe ' || arm_rc=1
    if peer_logged 'line=GET /webview-probe-before '; then arm_rc=1; fi
    [ "$control_sent" = yes ] || arm_rc=1
    verdict tenant "$arm_rc" "connect answered $connect_status (want 409 naming the discovery 404); body names 404: $body_404, list HTTP $list_status, row names 404: $row_404 ('$(printf '%s' "$row_error" | cut -c1-80)'); discovery requests from the tunnel address $(grep -cE '^request: from=10\.7\.0\.1:[0-9]+ line=GET /\.well-known/chan-gateway' "$WORK/peer.log" || true) of $(grep -cE '^request: .*GET /\.well-known/chan-gateway' "$WORK/peer.log" || true), webview probe $(grep -cE '^request: from=10\.7\.0\.1:[0-9]+ line=GET /webview-probe ' "$WORK/peer.log" || true), the probe sent before the file: sent $control_sent, reached the peer $(grep -cE 'line=GET /webview-probe-before ' "$WORK/peer.log" || true) (want sent yes, reached 0)"

    # retire: clearing the file takes the tunnel out of the running proxy.
    arm_rc=0
    retire_body="$WORK/retire.json"
    retire_status="$(library_call PUT "/api/library/gateways/$GATEWAY_ID" \
        '{"url":"","label":"wg","wireguard":""}' "$retire_body")"
    [ "$retire_status" = 200 ] || arm_rc=1
    grep -q '"wireguard":null' "$retire_body" 2>/dev/null || arm_rc=1
    grep -q '"wireguard_status":null' "$retire_body" 2>/dev/null || arm_rc=1
    wait_for 30 "the retire line" logged "gateway WireGuard tunnel retired.*gateway=$GATEWAY_ID" || arm_rc=1
    peer_requests="$(grep -c '^request: ' "$WORK/peer.log" || true)"
    # The direct path to the peer's tunnel address has no host, so the
    # CONNECT fails (502) or times out (504).
    probe="$(curl -sS -o /dev/null -p --max-time 40 -w '%{http_connect}' -x "http://$PROXY" "$PEER_URL/retired-probe" 2>>"$WORK/curl.err" || true)"
    case "$probe" in 502|504) ;; *) arm_rc=1 ;; esac
    [ "$(grep -c '^request: ' "$WORK/peer.log" || true)" = "$peer_requests" ] || arm_rc=1
    if grep -q "$WORK/client.conf" "$CHAN_HOME/desktop/config.json"; then arm_rc=1; fi
    verdict retire "$arm_rc" "PUT answered $retire_status, retire lines $(count 'gateway WireGuard tunnel retired'), CONNECT to the peer answered ${probe:-nothing} (want 502 or 504), peer requests $peer_requests -> $(grep -c '^request: ' "$WORK/peer.log" || true), file in config $(grep -c "$WORK/client.conf" "$CHAN_HOME/desktop/config.json" || true) (want 0)"
}

# The named field of a library entry as text: the entry the file holds or,
# given an id, the row with that id in the list it holds; "absent" when
# there is no such field and "unread" when the file is not JSON.
entry_field() {
    node -e '
        const [file, field, id] = process.argv.slice(1);
        let entry = JSON.parse(require("fs").readFileSync(file, "utf8"));
        if (id) entry = entry.find((row) => row.id === id) ?? {};
        process.stdout.write(field in entry ? String(entry[field]) : "absent");
    ' "$@" 2>/dev/null || echo unread
}

# The origin and path of a URL the desktop opened, and its
# wireguard_public_key decoded.
authorize_read() {
    node -e '
        const url = new URL(process.argv[1]);
        process.stdout.write(`${url.origin}${url.pathname} ${url.searchParams.get("wireguard_public_key") ?? "absent"}`);
    ' "$1" 2>/dev/null || echo "unread unread"
}

enrollment_ready() {
    [ "$(library_call GET /api/library/gateways '' "$WORK/rows.json")" = 200 ] &&
        enrollment_oracle projection "$WORK/rows.json" "$WORK/identity-peer.json" "$GATEWAY_ID"
}

# The inspector returns promises as remote objects, without awaiting them.
# Record completion in the page so a negative probe cannot race its fetch.
enrollment_probe_settled() {
    node "$INSPECT" "$INSPECTOR" eval 'Chan Launcher' \
        "window.__chanWireguardEnrollmentProbe?.url === '$1' && window.__chanWireguardEnrollmentProbe.done === true" \
        > "$WORK/probe-state.json" 2>>"$WORK/inspect.err" || return 1
    grep -qx true "$WORK/probe-state.json"
}
enrollment_fetch() {
    node "$INSPECT" "$INSPECTOR" eval 'Chan Launcher' \
        "(() => { const probe = window.__chanWireguardEnrollmentProbe = {url: '$1', done: false}; fetch(probe.url, {mode: 'no-cors'}).then(() => { probe.done = true; }, () => { probe.done = true; }); return 'dispatched'; })()" \
        > "$WORK/probe-start.json" 2>>"$WORK/inspect.err" || return 1
    grep -qx '"dispatched"' "$WORK/probe-start.json" || return 1
    wait_for 30 'the webview probe to settle' enrollment_probe_settled "$1"
}

# Each discovery and webview request has a before snapshot of every peer.
# A wrong peer receiving even one matching request fails the same probe.
enrollment_tenant_arm() {
    local phase="$1" peer_count="$2" first="$3" last="$4" route="$5"
    local n id target snapshot path status arm_rc body
    for ((n=first; n<=last; n++)); do
        arm_rc=0
        id="p$n"
        target="$id"
        [ "$route" != none ] || target=none
        snapshot="$WORK/$phase-$id-before.json"
        body="$WORK/$phase-$id-connect.json"
        path="/webview-$phase-$id"
        enrollment_oracle snapshot "$WORK" "$peer_count" "$snapshot" || fail "could not snapshot peers"
        status="$(library_call POST "/api/library/gateways/gw-tenant-$id/connect" '' "$body")"
        [ "$status" = 409 ] || arm_rc=1
        if [ "$route" = none ]; then
            if grep -q 'gateway discovery returned HTTP 404' "$body"; then arm_rc=1; fi
        else
            grep -q 'gateway discovery returned HTTP 404' "$body" || arm_rc=1
        fi
        enrollment_oracle routed "$WORK" "$peer_count" "$snapshot" "$target" '/.well-known/chan-gateway' || arm_rc=1
        enrollment_fetch "http://probe.$id.proxy.chan-e2e.invalid:8080$path" || arm_rc=1
        enrollment_oracle routed "$WORK" "$peer_count" "$snapshot" "$target" "$path" || arm_rc=1
        verdict "tenant-$phase-$id" "$arm_rc" "connect HTTP $status (want 409); discovery and webview request must reach $target only, all $peer_count peer logs checked"
    done
}

enrollment_parameters() {
    enrollment_oracle stored "$CHAN_HOME/desktop/config.json" "$WORK/identity-peer.json" "$GATEWAY_ID" "$1"
}

enrollment_starts() {
    desktop_log
    enrollment_oracle started "$CLEAN" "$WORK/identity-peer.json" "$GATEWAY_ID" "$1"
}

same_desktop() {
    local pid_before="$1" addresses
    [ "$pid_before" != none ] && [ "$(desktop_pid || echo none)" = "$pid_before" ] || return 1
    [ "$(count 'gateway WireGuard proxy listening')" = 1 ] || return 1
    addresses="$(proxy_addresses | sort -u | tr '\n' ' ')"
    [ "$addresses" = "$PROXY " ]
}

single_sign_in() {
    [ "$(grep -c . "$WORK/browser.urls")" = 1 ] &&
        [ "$(grep -c '^identity: authorize wireguard_public_key=' "$WORK/identity.log")" = 1 ] &&
        [ "$(grep -c '^identity: redeem pkce=ok wireguard=sent$' "$WORK/identity.log")" = 1 ] &&
        [ "$(grep -c '^identity: roster bearer=minted$' "$WORK/identity.log")" -ge 1 ]
}

enroll_arms() {
    local arm_rc keys key_file conf key_status client_key enrolled key_mode dir_mode
    local connect_status opened read_back sent_url sent_key recorded walk
    local pid_before key_before n
    local key_sent=no key_recorded=no
    keys="$CHAN_HOME/desktop/wireguard"
    key_file="$keys/$GATEWAY_ID.key"
    conf="$keys/$GATEWAY_ID.conf"
    proxy_first_arm
    launcher_bearer_arm

    # key: the gateway form's Generate WireGuard key, through the library.
    arm_rc=0
    key_status="$(library_call POST "/api/library/gateways/$GATEWAY_ID/wireguard-key" '' "$WORK/key.json")"
    [ "$key_status" = 200 ] || arm_rc=1
    client_key="$(entry_field "$WORK/key.json" wireguard_public_key)"
    [[ "$client_key" =~ ^[A-Za-z0-9+/]{43}=$ ]] || arm_rc=1
    enrolled="$(entry_field "$WORK/key.json" wireguard_enrolled)"
    [ "$enrolled" = false ] || arm_rc=1
    key_mode="$(stat -c %a "$key_file" 2>/dev/null || echo none)"
    dir_mode="$(stat -c %a "$keys" 2>/dev/null || echo none)"
    [ "$key_mode" = 600 ] && [ "$dir_mode" = 700 ] || arm_rc=1
    verdict key "$arm_rc" "POST answered $key_status, a public key of ${#client_key} characters, enrolled $enrolled (want false), key file mode $key_mode in a $dir_mode directory (want 600 in 700)"
    [ "$arm_rc" = 0 ] || fail "no WireGuard key: the sign-in needs it"

    start_enrollment_peer p1 "$client_key"
    start_enrollment_peer p2 "$client_key"
    identity_peers
    enrollment_tenant_arm before 2 1 2 none

    # authorize: Connect signs in in the browser, since the key is not
    # enrolled, and the stand-in browser walks it.
    arm_rc=0
    pid_before="$(desktop_pid || echo none)"
    STARTED_BEFORE="$(count 'gateway WireGuard tunnel started')"
    connect_status="$(library_call POST "/api/library/gateways/$GATEWAY_ID/connect" '' "$WORK/connect.json")"
    [ "$connect_status" = 204 ] || arm_rc=1
    wait_for 30 "the browser's walk" test -s "$WORK/browser.log" || arm_rc=1
    opened="$(grep -c . "$WORK/browser.urls" 2>/dev/null || true)"
    [ "$opened" = 1 ] || arm_rc=1
    read_back="$(authorize_read "$(head -1 "$WORK/browser.urls" 2>/dev/null)")"
    sent_url="${read_back%% *}"
    sent_key="${read_back#* }"
    [ "$sent_url" = "$IDENTITY_ORIGIN/desktop/authorize" ] || arm_rc=1
    if [ "$sent_key" = "$client_key" ]; then key_sent=yes; else arm_rc=1; fi
    recorded="$(sed -n 's/^identity: authorize wireguard_public_key=//p' "$WORK/identity.log" | tail -1)"
    if [ "$recorded" = "$client_key" ]; then key_recorded=yes; else arm_rc=1; fi
    walk="$(tail -1 "$WORK/browser.log" 2>/dev/null || true)"
    [ "$walk" = 'browser: authorize=302 callback=303' ] || arm_rc=1
    verdict authorize "$arm_rc" "connect answered $connect_status (want 204), URLs opened ${opened:-0} (want 1) at ${sent_url:-none}, its key is the row's: $key_sent, the identity recorded it: $key_recorded, ${walk:-no walk} (want 302 then 303)"

    # Both peers must handshake, and storage/projection must name exactly
    # the parameters served. A summary alone cannot prove a second tunnel.
    arm_rc=0
    for n in 1 2; do
        wait_for 30 "p$n handshake" enrollment_peer_logged "p$n" '^status: handshake=[0-9]' || arm_rc=1
    done
    wait_for 30 "both ingress statuses up" enrollment_ready || arm_rc=1
    enrollment_parameters "$key_file" || arm_rc=1
    enrollment_starts "$key_file" || arm_rc=1
    [ ! -e "$conf" ] || arm_rc=1
    same_desktop "$pid_before" || arm_rc=1
    single_sign_in || arm_rc=1
    enrollment_oracle private-key "$WORK" "$key_file" || arm_rc=1
    verdict adopt "$arm_rc" "two distinct peers handshook; exact stored parameters and ordered up statuses; one start per ingress, one sign-in, one key file, unchanged desktop and proxy"
    enrollment_tenant_arm enrolled 2 1 2 live

    if [ "$RECONCILE" = 1 ]; then
        [ "$FAILED" = 0 ] || fail "enrollment prerequisites failed before reconciliation"
        # A third peer admits the same client key. Until discovery changes,
        # its names must still have no route, even though the peer is live.
        key_before="$(sha256sum "$key_file") $(stat -c '%d:%i:%s:%y:%z:%a' "$key_file")"
        start_enrollment_peer p3 "$client_key"
        enrollment_tenant_arm before-reconcile 3 3 3 none
        identity_peers
        arm_rc=0
        connect_status="$(library_call POST "/api/library/gateways/$GATEWAY_ID/connect" '' "$WORK/reconcile-connect.json")"
        [ "$connect_status" = 204 ] || arm_rc=1
        wait_for 30 'p3 handshake' enrollment_peer_logged p3 '^status: handshake=[0-9]' || arm_rc=1
        wait_for 30 'three ingress statuses up' enrollment_ready || arm_rc=1
        enrollment_parameters "$key_file" || arm_rc=1
        enrollment_starts "$key_file" || arm_rc=1
        same_desktop "$pid_before" || arm_rc=1
        single_sign_in || arm_rc=1
        [ "$(sha256sum "$key_file") $(stat -c '%d:%i:%s:%y:%z:%a' "$key_file")" = "$key_before" ] || arm_rc=1
        [ "$(stat -c %a "$key_file")" = 600 ] && [ "$(stat -c %a "$keys")" = 700 ] || arm_rc=1
        [ ! -e "$conf" ] || arm_rc=1
        enrollment_oracle private-key "$WORK" "$key_file" || arm_rc=1
        verdict reconcile "$arm_rc" "connect HTTP $connect_status (want 204), p3 handshook and is stored/projected; p1/p2 start once, one sign-in, unchanged key/mode, desktop and proxy"
        enrollment_tenant_arm reconciled 3 1 3 live
    fi
}

if [ "$LIVE_ADOPT" = 1 ]; then
    live_adopt_arms
    finish_mode
fi
if [ "$ENROLL" = 1 ]; then
    enroll_arms
    finish_mode
fi
if [ "$NO_WIREGUARD" = 1 ]; then
    proxy_first_arm
fi

if [ "$UNRESOLVED" = 1 ]; then
    arm_rc=0
    proxy_logged=no
    lookup_logged=no
    wait_for 15 "the proxy before resolution" logged 'gateway WireGuard proxy listening' && proxy_logged=yes || arm_rc=1
    wait_for 20 "the resolver failure" logged 'endpoint did not resolve' && lookup_logged=yes || arm_rc=1
    # `chan devserver ls` is answered by the desktop's control socket, so
    # it shows the desktop itself serving requests while its gateway's
    # name does not resolve.
    set +e
    timeout 20 "$CHAN_BIN" devserver ls > "$WORK/startup.out" 2>&1
    control_rc=$?
    set -e
    [ "$control_rc" = 0 ] || arm_rc=1
    desktop_log
    proxy="$(sed -n 's/.*gateway WireGuard proxy listening.*proxy=\(127\.0\.0\.1:[0-9]*\).*/\1/p' "$CLEAN" | head -1)"
    [ -n "$proxy" ] || arm_rc=1
    response=none
    if [ -n "$proxy" ]; then
        # A malformed request is answered by the bound proxy without any
        # destination lookup or handshake.
        response="$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}' "http://$proxy/" || true)"
        [ "$response" = 400 ] || arm_rc=1
    fi
    verdict unresolved-startup "$arm_rc" "proxy line $proxy_logged (${proxy:-no address}), origin-form request answered ${response:-nothing} (want 400), lookup error logged $lookup_logged, desktop control rc=$control_rc: $(head -1 "$WORK/startup.out" | cut -c1-80)"
    [ "$arm_rc" = 0 ] || fail "unresolved endpoint startup"
    cleanup
    trap - EXIT
    rm -rf "${WORK:?}"
    exit 0
fi

# The tunnel, proxy, discovery and probes arms need a peer behind the
# proxy, which --no-wireguard has not; it runs from the window arm on.
if [ "$NO_WIREGUARD" = 0 ]; then
# tunnel: the start line in the desktop and the handshake at the peer.
arm_rc=0
wait_for 30 "the tunnel start line" logged "gateway WireGuard tunnel started.*gateway=$GATEWAY_ID" || arm_rc=1
wait_for 30 "the handshake at the peer" peer_logged '^status: handshake=[0-9]' || arm_rc=1
HANDSHAKE="$(grep -E '^status: handshake=' "$WORK/peer.log" | tail -1 | cut -d' ' -f2-)"
verdict tunnel "$arm_rc" "desktop start line $(count 'gateway WireGuard tunnel started'), peer ${HANDSHAKE:-no status yet}"

# proxy: the listening line names the address every later arm uses.
arm_rc=0
wait_for 30 "the proxy line" logged 'gateway WireGuard proxy listening' || arm_rc=1
desktop_log
PROXY="$(sed -n 's/.*gateway WireGuard proxy listening.*proxy=\(127\.0\.0\.1:[0-9]*\).*/\1/p' "$CLEAN" | head -1)"
[ -n "$PROXY" ] || arm_rc=1
verdict proxy "$arm_rc" "at ${PROXY:-none}"
[ -n "$PROXY" ] || fail "no proxy address: every later arm needs it"

# discovery: the connect at start asks the peer for the gateway document,
# through the proxy and the tunnel, and reads the 404.
arm_rc=0
wait_for 60 "the discovery request at the peer" peer_logged '^request: from=10\.7\.0\.1:[0-9]+ line=GET /\.well-known/chan-gateway' || arm_rc=1
wait_for 30 "the desktop to read the 404" logged 'gateway discovery.*404' || arm_rc=1
wait_for 10 "the peer's receive counter" peer_logged '^status: .*rx=[1-9]' || arm_rc=1
verdict discovery "$arm_rc" "peer saw $(grep -cE '^request: .*GET /\.well-known/chan-gateway' "$WORK/peer.log" || true) discovery request(s) from 10.7.0.1, desktop read 404: $(count 'gateway discovery.*404')"

# probes: the proxy from outside the desktop, both request shapes.
arm_rc=0
FORWARD="$(curl -sS -o /dev/null -w '%{http_code}' -x "http://$PROXY" "$PEER_URL/forward-probe" 2>>"$WORK/curl.err" || echo curl-failed)"
CONNECT="$(curl -sS -o /dev/null -p -w '%{http_code}' -x "http://$PROXY" "$PEER_URL/connect-probe" 2>>"$WORK/curl.err" || echo curl-failed)"
[ "$FORWARD" = 404 ] || arm_rc=1
[ "$CONNECT" = 404 ] || arm_rc=1
wait_for 10 "the probes at the peer" bash -c "grep -q 'GET /forward-probe' '$WORK/peer.log' && grep -q 'GET /connect-probe' '$WORK/peer.log'" || arm_rc=1
verdict probes "$arm_rc" "forward answered $FORWARD, CONNECT answered $CONNECT, both logged at the peer"
fi

# window: a workspace window through the proxied webview. Its page and
# assets are plain forwards to the embedded origin, and the SPA's socket is
# an absolute-form upgrade the proxy bridges; the server's 101 on the
# socket route only happens once the page ran. The desktop's own windows
# open and redial sockets on their own schedule, so a count of sockets
# proves nothing about this one: the arm needs serve's handoff line, a
# window the desktop opened after it (its label is `local::` and the
# window id), and a 101 on the socket that window's page tags with that
# id (`w=`).
WS_101='uri=/ws[ ?].*status=101'
arm_rc=0
WS="$WORK/ws"
mkdir -p "$WS"
printf '# note\n' > "$WS/a.md"
wait_for 30 "chan workspace ls to answer" "$CHAN_BIN" workspace ls >/dev/null || arm_rc=1
BEFORE_WS="$(count "$WS_101")"
BEFORE_BRIDGED="$(count 'proxy upgrade bridged')"
window_labels() { desktop_log; sed -n 's/.*WINGEO resolve label=\(local::w-[0-9a-f]*\) .*/\1/p' "$CLEAN" | sort -u; }
window_labels > "$WORK/labels.before"
# The most connections to the proxy at once while the arm runs, sampled
# every 0.2 s from the client ends (`dport`), so the proxy's 256-connection
# cap can be judged against what a local window holds.
PEAK="$WORK/proxy-peak"
SAMPLER=""
sample_proxy_connections() {
    local now peak=0
    while :; do
        now="$(ss -Htn state established "( dport = :${PROXY##*:} )" 2>/dev/null | wc -l || true)"
        if [ "$now" -gt "$peak" ]; then peak="$now"; printf '%s\n' "$peak" > "$PEAK"; fi
        sleep 0.2
    done
}
if command -v ss >/dev/null 2>&1; then
    printf '0\n' > "$PEAK"
    sample_proxy_connections &
    SAMPLER=$!
    PIDS+=("$SAMPLER")
fi
proxy_peak() {
    if [ -z "$SAMPLER" ]; then echo "unmeasured (no ss)"; return; fi
    kill "$SAMPLER" 2>/dev/null || true
    cat "$PEAK"
}
set +e
timeout 60 "$CHAN_BIN" serve "$WS" > "$WORK/serve.out" 2>&1
serve_rc=$?
set -e
[ "$serve_rc" = 0 ] || { arm_rc=1; log "serve rc=$serve_rc (124 is the 60 s bound): $(cat "$WORK/serve.out")"; }
grep -qE '^chan: opened .*/ws in chan-desktop\.$' "$WORK/serve.out" || arm_rc=1
SERVED=""
served_window_opened() { SERVED="$(window_labels | comm -13 "$WORK/labels.before" - | head -1)"; [ -n "$SERVED" ]; }
served_socket_answered() { [ -n "$SERVED" ] && logged "uri=/ws\\?([^ ]*&)?w=${SERVED#local::}(&| ).*status=101"; }
bridged_grew() { [ "$(count 'proxy upgrade bridged')" -gt "$BEFORE_BRIDGED" ]; }
wait_for 60 "the served window" served_window_opened || arm_rc=1
wait_for 60 "the window's page through the proxy" logged 'forwarding.*target=127\.0\.0\.1:[0-9]+ route="direct"' || arm_rc=1
wait_for 60 "the served window's socket answered 101" served_socket_answered || arm_rc=1
wait_for 10 "the served window's upgrade bridged at the proxy" bridged_grew || arm_rc=1
SERVED_SOCKET=no
served_socket_answered && SERVED_SOCKET=yes
verdict window "$arm_rc" "serve rc=$serve_rc: $(tr '\n' ' ' < "$WORK/serve.out" | cut -c1-80); served window ${SERVED:-none}, its /ws answered 101: $SERVED_SOCKET; /ws 101s $BEFORE_WS -> $(count "$WS_101"), upgrades bridged $BEFORE_BRIDGED -> $(count 'proxy upgrade bridged'); proxy connections at once at most $(proxy_peak)"

# launcher: its sockets (`/api/library/local-theme/watch`, one per panel)
# are served by the launcher router, the embedded server's root fallback
# outside the traced tenant routers, so they never appear in the request
# spans. Every upgrade the proxy bridged beyond the tenant routes' 101s is
# therefore a launcher socket; the server logs a 101 before the proxy logs
# its bridge, so the difference cannot be inflated by timing.
TRACED_101='status=101'
launcher_sockets() { echo $(( $(count 'proxy upgrade bridged') - $(count "$TRACED_101") )); }
launcher_bridged() { [ "$(launcher_sockets)" -ge 1 ]; }
arm_rc=0
wait_for 60 "a launcher socket bridged" launcher_bridged || arm_rc=1
verdict launcher "$arm_rc" "upgrades bridged $(count 'proxy upgrade bridged'), tenant routes answered 101 $(count "$TRACED_101"), launcher sockets $(launcher_sockets)"

# refusals: nothing the webviews sent was refused.
REFUSED="$(count 'proxy request refused')"
BRIDGED="$(count 'proxy upgrade bridged')"
arm_rc=0
[ "$REFUSED" = 0 ] || arm_rc=1
[ "$BRIDGED" -ge 2 ] || arm_rc=1
verdict refusals "$arm_rc" "refused $REFUSED, forwarded $(count 'proxy: forwarding'), CONNECT $(count 'CONNECT established'), upgrades bridged $BRIDGED"
if [ "$REFUSED" != 0 ]; then
    desktop_log | grep -E 'proxy request refused' | sed 's/^.*proxy request refused//' | sort | uniq -c | sort -rn | head -5 >&2
fi

# config: the desktop rewrites its config at start; the row and the file
# must come through. --no-wireguard has no row.
if [ "$NO_WIREGUARD" = 0 ]; then
arm_rc=0
grep -q "\"$GATEWAY_ID\"" "$CHAN_HOME/desktop/config.json" || arm_rc=1
grep -q "$WORK/client.conf" "$CHAN_HOME/desktop/config.json" || arm_rc=1
verdict config "$arm_rc" "row $GATEWAY_ID and its file in $CHAN_HOME/desktop/config.json"
fi

# tunnel-page: a real devserver behind the peer's second tunnel listener.
page_fail() { verdict tunnel-page 1 "$*"; fail "$*"; }
page_inspect() {
    node "$INSPECT" "$INSPECTOR" all \
        "({href:location.href,workspace:document.documentElement.innerHTML.includes('ws2'),reason:[...document.querySelectorAll('.log-row.fail .log-msg')].at(-1)?.textContent||'',attempt:Number(document.getElementById('attempt')?.textContent||0),actionsHidden:document.getElementById('actions')?.hidden})" \
        > "$WORK/page-inspect.jsonl" 2>> "$WORK/inspect.err" || return 1
}
page_state() {
    page_inspect && python3 -I "$REPO/scripts/e2e/desktop-wireguard-page-oracle.py" "$1" "$WORK/page-inspect.jsonl" > "$WORK/page-state.json" 2>> "$WORK/page-oracle.err"
}
log_since() {
    desktop_log
    sed -n "$(( $1 + 1 )),\$p" "$CLEAN" > "$WORK/desktop-since.log"
}
logged_since() { log_since "$1" && grep -qE -- "$2" "$WORK/desktop-since.log"; }
wgds_connected() {
    timeout 5 "$CHAN_BIN" devserver ls --json > "$WORK/wgds-ls.json" 2>> "$WORK/wgds.err" || return 1
    python3 -I -c 'import json,sys; rows=json.load(open(sys.argv[1]))["devservers"]; sys.exit(0 if any(r.get("label")=="wgds" and r.get("status")=="connected" for r in rows) else 1)' "$WORK/wgds-ls.json"
}
page_ready() {
    node "$INSPECT" "$INSPECTOR" eval "w=$WINDOW_ID&" 'document.readyState' 2>> "$WORK/inspect.err" | grep -qx '"complete"'
}
tenant_ready() {
    node "$INSPECT" "$INSPECTOR" eval "w=$WINDOW_ID&" 'document.readyState === "complete" && !location.pathname.endsWith("/connecting.html")' 2>> "$WORK/inspect.err" | grep -qx 'true'
}
if [ "$NO_WIREGUARD" = 0 ]; then
    DEV_HOME="$WORK/devserver-home"
    mkdir -m 700 "$DEV_HOME"
    CHAN_HOME="$DEV_HOME" "$CHAN_BIN" devserver run --service=none --bind 127.0.0.1 --port "$DS_PORT" > "$WORK/devserver.log" 2>&1 &
    DEV_PID=$!
    PIDS+=("$DEV_PID")
    wait_for 60 "wgds devserver" grep -q 'listening on http://' "$WORK/devserver.log" || page_fail "devserver did not listen"
    ( umask 077; python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["devserver_token"])' "$DEV_HOME/devserver/config.json" > "$WORK/devserver.token" )
    ( umask 077; printf 'Authorization: Bearer %s\n' "$(< "$WORK/devserver.token")" > "$WORK/devserver.header" )
    timeout 30 "$CHAN_BIN" devserver register "http://10.7.0.2:8081/?t=$(< "$WORK/devserver.token")" --name wgds > "$WORK/wgds-register.log" 2>&1 || page_fail "wgds register failed"
    timeout 30 "$CHAN_BIN" devserver connect wgds > "$WORK/wgds-connect.log" 2>&1 || page_fail "wgds connect failed"
    wait_for 60 "wgds connected" wgds_connected || page_fail "wgds not connected"
    wait_for 30 "tunnel forwarding to wgds" logged 'forwarding .*target=10\.7\.0\.2:8081 route="tunnel"' || page_fail "no tunnel forward to wgds"
    mkdir -p "$WORK/ws2"
    printf '# ws2\n' > "$WORK/ws2/a.md"
    timeout 45 "$CHAN_BIN" workspace serve "$WORK/ws2" --on wgds > "$WORK/ws2-serve.log" 2>&1 || page_fail "workspace serve on wgds failed"
    python3 -I -c 'import json,sys; print(json.dumps({"kind":"workspace","workspace_path":sys.argv[1]}))' "$WORK/ws2" > "$WORK/ws2-mint-body.json"
    mint_status="$(curl -sS -m 30 -H @"$WORK/devserver.header" -H 'Content-Type: application/json' --data @"$WORK/ws2-mint-body.json" -o "$WORK/ws2-mint.json" -w '%{http_code}' "http://127.0.0.1:$DS_PORT/api/library/windows" 2>> "$WORK/curl.err" || true)"
    [ "$mint_status" = 200 ] || page_fail "ws2 window mint answered $mint_status"
    curl -sS -m 10 -H @"$WORK/devserver.header" -o "$WORK/ws2-records.json" "http://127.0.0.1:$DS_PORT/api/library/windows" 2>> "$WORK/curl.err" || page_fail "ws2 records unreadable"
    WINDOW_ID="$(python3 -I -c 'import json,sys; rows=json.load(open(sys.argv[1])); mine=[r for r in rows if r.get("workspace_path")==sys.argv[2]]; print(mine[0]["window_id"] if len(mine)==1 else "")' "$WORK/ws2-records.json" "$WORK/ws2")"
    [ -n "$WINDOW_ID" ] || page_fail "ws2 has no unique window record"
    wait_for 45 "initial ws2 page" tenant_ready || page_fail "initial ws2 tenant page not ready"
    frozen=0
    for attempt_no in 1 2; do
        timeout 30 "$CHAN_BIN" devserver disconnect wgds > "$WORK/wgds-disconnect-$attempt_no.log" 2>&1 || page_fail "wgds disconnect failed"
        start_line="$(wc -l < "$WORK/desktop.log")"
        (
            for _ in $(seq 1 3000); do
                line="$(tail -n +"$((start_line + 1))" "$WORK/desktop.log" | sed 's/\x1b\[[0-9;]*m//g' | grep -m1 -E "build_workspace_window_with_completion.*window=lib-[^ ]+::$WINDOW_ID( |$)" || true)"
                if [ -n "$line" ]; then
                    printf '%s\n' "$line" > "$WORK/page-build-line"
                    kill -s STOP "$DEV_PID"
                    exit 0
                fi
                sleep 0.01
            done
            exit 1
        ) &
        freezer=$!
        PIDS+=("$freezer")
        timeout 30 "$CHAN_BIN" devserver connect wgds > "$WORK/wgds-reconnect-$attempt_no.log" 2>&1 || page_fail "wgds reconnect failed"
        wait "$freezer" || page_fail "the desktop never built a lib- window"
        if wait_for 10 "the ws2 connecting page" page_state initial; then
            frozen=1
            break
        fi
        kill -s CONT "$DEV_PID"
        wait_for 45 "ws2 page after a late freeze" tenant_ready || page_fail "late freeze left ws2 unreadable"
    done
    [ "$frozen" = 1 ] || page_fail "the freeze missed the connecting page twice"
    kill -s STOP "$PEER_PID"
    kill -s CONT "$DEV_PID"
    DARK_AT="$(date +%s)"
    DARK_LINE="$(wc -l < "$WORK/desktop.log")"
    wait_for 130 "WireGuard session loss" logged_since "$DARK_LINE" 'WARN .*WireGuard session lost' || page_fail "no session-loss warning within 130 s"
    LOSS_AT="$(date +%s)"
    wait_for 10 "the lost-session reason on ws2" page_state lost || page_fail "ws2 did not show the tunnel loss within 10 s"
    wait_for 20 "the proxy session refusal" logged_since "$DARK_LINE" 'proxy refused a connection through a tunnel with no session' || page_fail "no proxy session refusal after peer stopped"
    wait_for 20 "the proxy 502 refusal" logged_since "$DARK_LINE" 'proxy request refused .*status=502' || page_fail "no proxy 502 after peer stopped"
    refused_502="$(grep -cE 'proxy request refused .*status=502' "$WORK/desktop-since.log" || true)"
    reason="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["reason"])' "$WORK/page-state.json")"
    BACK_LINE="$(wc -l < "$WORK/desktop.log")"
    kill -s CONT "$PEER_PID"
    BACK_AT="$(date +%s)"
    wait_for 60 "the tenant page after peer recovery" tenant_ready || page_fail "ws2 did not return to the tenant page"
    wait_for 60 "WireGuard recovery warning" logged_since "$BACK_LINE" 'WireGuard session established' || page_fail "no WireGuard recovery warning"
    wait_for 60 "forwarding after peer recovery" logged_since "$BACK_LINE" 'forwarding .*target=10\.7\.0\.2:8081 route="tunnel"' || page_fail "no tunnel forwarding after peer recovery"
    verdict tunnel-page 0 "loss after $((LOSS_AT - DARK_AT)) s; reason '$(printf '%s' "$reason" | cut -c1-80)'; 502s $refused_502; tenant after $(($(date +%s) - BACK_AT)) s"
fi

if [ "$FAILED" != 0 ]; then
    log "FAIL: $FAILED arm(s) failed at $SHA; work dir kept at $WORK"
    exit 1
fi
log "PASS at $SHA; work dir $WORK removed"
cleanup
trap - EXIT
rm -rf "${WORK:?}"
