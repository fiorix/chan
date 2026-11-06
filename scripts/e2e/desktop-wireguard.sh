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
#
# What it cannot prove: a real gateway's TLS and identity behind the proxy
# (the peer answers 404 to everything), the macOS and Windows webviews, and
# a peer behind NAT or at a changing address.
#
# Usage: desktop-wireguard.sh [--unresolved-endpoint | --live-adopt | --no-wireguard]
#   --unresolved-endpoint proves startup and the proxy with a missing name;
#                         it runs instead of the connected-peer arms.
#   --live-adopt          proves the live fabric (above); needs node 22 or
#                         later for the inspector reads.
#   --no-wireguard        proves the always-bound proxy with no gateway row.
#   The modes are exclusive.
#   CHAN_DESKTOP_BIN  a built debug chan-desktop (default
#                     target/debug/chan-desktop). It is not built here: it
#                     needs the web bundles, `make web` then
#                     `cargo build -p chan-desktop`.
#   CHAN_BIN          a built chan (default: built here with --locked)
#   WG_PEER_BIN       a built wg-peer example (default: built here)
#
# Needs xvfb-run and curl, and ss for the window arm's connection count
# (reported as unmeasured without it). Exits 2 when a prerequisite is
# missing rather than passing. Everything runs under a throwaway CHAN_HOME, HOME,
# XDG_RUNTIME_DIR and TMPDIR, with no Wayland display and GTK held to X11,
# so the desktop renders on the Xvfb display only and never on the
# caller's compositor; the work dir is deleted on success and kept
# on failure. The kept work dir holds the run's client file with a private
# key that is worthless once the peer process is gone, which the exit path
# ends, but treat it as a credential until it is deleted. A kept
# --live-adopt work dir also holds the launcher bearer of a desktop that is
# gone, in bearer.header, read by curl so it is on no command line.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
CHAN_DESKTOP_BIN="${CHAN_DESKTOP_BIN:-$REPO/target/debug/chan-desktop}"
GATEWAY_ID="gw-e2e00001"
UNRESOLVED=0
LIVE_ADOPT=0
NO_WIREGUARD=0
if [ "${1:-}" = --unresolved-endpoint ]; then UNRESOLVED=1; shift; fi
if [ "${1:-}" = --live-adopt ]; then LIVE_ADOPT=1; shift; fi
if [ "${1:-}" = --no-wireguard ]; then NO_WIREGUARD=1; shift; fi
[ "$#" = 0 ] || { printf 'unknown arguments: %s\n' "$*" >&2; exit 2; }
[ $((UNRESOLVED + LIVE_ADOPT + NO_WIREGUARD)) -le 1 ] || { printf 'the modes are exclusive\n' >&2; exit 2; }

log() { printf 'desktop-wireguard: %s\n' "$*" >&2; }
refuse() { log "cannot run: $*"; exit 2; }
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
command -v curl >/dev/null 2>&1 || refuse "curl is not installed"
[ -x "$CHAN_DESKTOP_BIN" ] || refuse "no chan-desktop binary at $CHAN_DESKTOP_BIN (set CHAN_DESKTOP_BIN)"
INSPECT="$REPO/scripts/e2e/desktop-observations/inspect.mjs"
if [ "$LIVE_ADOPT" = 1 ]; then
    command -v node >/dev/null 2>&1 || refuse "node is not installed (--live-adopt reads the launcher through inspect.mjs)"
    [ -f "$INSPECT" ] || refuse "no inspector helper at $INSPECT"
fi

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

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-desktop-wireguard.XXXXXX")"
export CHAN_HOME="$WORK/chan-home"
export HOME="$WORK/home"
export XDG_RUNTIME_DIR="$WORK/run"
export TMPDIR="$WORK/tmp"
mkdir -p "$CHAN_HOME/desktop" "$HOME" "$XDG_RUNTIME_DIR" "$TMPDIR"
chmod 700 "$XDG_RUNTIME_DIR"
# A test launched from inside a chan terminal must not inherit session
# state, handoff hints, or credentials.
for v in $(compgen -v | grep -E '^CHAN_' | grep -vE '^CHAN_(HOME|BIN|DESKTOP_BIN)$'); do unset "$v"; done
# The caller's Wayland session: WAYLAND_DISPLAY may be an absolute socket
# path and WAYLAND_SOCKET an inherited descriptor, and either would put the
# desktop and its webviews on the caller's compositor instead of Xvfb.
unset WAYLAND_DISPLAY WAYLAND_SOCKET
export GDK_BACKEND=x11
# The desktop publishes its handoff socket, and the chan processes here
# discover devservers, in XDG_RUNTIME_DIR. The caller's own
# (/run/user/<uid>) holds their live desktop's and devserver's sockets, so
# refuse to start anything unless it is a private directory.
private_runtime_dir_reason() {
    local dir="${XDG_RUNTIME_DIR:-}" actual own
    [ -n "$dir" ] || { echo "XDG_RUNTIME_DIR is unset"; return; }
    actual="$(realpath -e -- "$dir" 2>/dev/null)" || { echo "XDG_RUNTIME_DIR=$dir does not exist"; return; }
    own="/run/user/$(id -u)"
    own="$(realpath -e -- "$own" 2>/dev/null || echo "$own")"
    [ "$actual" != "$own" ] || echo "XDG_RUNTIME_DIR=$dir is this user's own runtime directory ($own)"
}
reason="$(private_runtime_dir_reason)"
[ -z "$reason" ] || refuse "$reason"
export CHAN_UPDATE_CHECK=0
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1
# The proxy's forwarding, CONNECT, bridged-upgrade and refusal lines come
# from chan_wireguard at debug, and the embedded server's request spans and
# response statuses, which name the socket routes, from chan_server and
# tower_http at debug.
export CHAN_LOG="chan_desktop=debug,chan_wireguard=debug,chan_server=debug,tower_http=debug,warn"

PIDS=()
cleanup() {
    # Each pid is ours (the peer, xvfb-run). xvfb-run leaves Xvfb and the
    # desktop as its children, so they are ended through it, never by name.
    local pid
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        pkill -TERM -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
    done
    sleep 1
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        pkill -KILL -P "$pid" 2>/dev/null || true
        kill -9 "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT

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

log "work dir $WORK, chan $SHA"

# 1. The far side: the peer, which writes the client's file.
"$WG_PEER_BIN" "$WORK/client.conf" > "$WORK/peer.log" 2>&1 &
PIDS+=("$!")
wait_for 20 "the peer" peer_logged '^peer: ready' || fail "the peer did not start: $(cat "$WORK/peer.log")"
PEER_URL="$(sed -n 's/^peer: ready url=\([^ ]*\).*/\1/p' "$WORK/peer.log" | head -1)"
[ -n "$PEER_URL" ] || fail "the peer printed no URL: $(cat "$WORK/peer.log")"
log "peer at $PEER_URL, client file $WORK/client.conf (mode $(stat -c %a "$WORK/client.conf"))"
if [ "$UNRESOLVED" = 1 ]; then
    sed -i 's/^Endpoint = .*/Endpoint = chan-endpoint-missing.invalid:51820/' "$WORK/client.conf"
fi

# 2. The desktop's config: one enabled gateway behind the file.
cat > "$CHAN_HOME/desktop/config.json" <<JSON
{"gateways":[{"id":"$GATEWAY_ID","url":"$PEER_URL","label":"wg","enabled":true,"added_at":0,"native_trust":[],"wireguard":"$WORK/client.conf"}]}
JSON
# --live-adopt starts the row without its file; --no-wireguard has no row.
if [ "$LIVE_ADOPT" = 1 ]; then
    cat > "$CHAN_HOME/desktop/config.json" <<JSON
{"gateways":[{"id":"$GATEWAY_ID","url":"$PEER_URL","label":"wg","enabled":true,"added_at":0,"native_trust":[]}]}
JSON
elif [ "$NO_WIREGUARD" = 1 ]; then
    printf '{"gateways":[]}\n' > "$CHAN_HOME/desktop/config.json"
fi
# The launcher's page is read through WebKitGTK's remote inspector, which
# the desktop's webviews serve only when this is set before they start.
INSPECTOR=""
if [ "$LIVE_ADOPT" = 1 ]; then
    INSPECTOR="127.0.0.1:$((20000 + RANDOM % 20000))"
    export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
fi

# 3. The desktop, headless.
xvfb-run -a "$CHAN_DESKTOP_BIN" > "$WORK/desktop.log" 2>&1 &
XVFB_RUN_PID=$!
PIDS+=("$XVFB_RUN_PID")
wait_for 90 "the desktop handoff socket" test -S "$XDG_RUNTIME_DIR/chan-desktop.sock" || { desktop_log; fail "the desktop did not come up: $(tail -5 "$CLEAN")"; }

# `chan serve` hands a workspace to the desktop only when its own
# environment names a display, and xvfb-run gives one to the desktop
# alone; without it serve starts a standalone server that never returns.
# The CLI calls below take the desktop's display, read from its process.
desktop_display() {
    local child bin
    bin="$(readlink -f "$CHAN_DESKTOP_BIN")"
    for child in $(pgrep -P "$XVFB_RUN_PID" || true); do
        [ "$(readlink -f "/proc/$child/exe" 2>/dev/null || true)" = "$bin" ] || continue
        tr '\0' '\n' < "/proc/$child/environ" | sed -n 's/^DISPLAY=//p'
        return 0
    done
    return 1
}
DISPLAY="$(desktop_display)" || fail "no chan-desktop process under xvfb-run (pid $XVFB_RUN_PID)"
[ -n "$DISPLAY" ] || fail "the desktop's environment names no DISPLAY"
export DISPLAY
log "the desktop runs on display $DISPLAY"

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

STARTED_BEFORE=0
started_grew() { [ "$(count 'gateway WireGuard tunnel started')" -gt "$STARTED_BEFORE" ]; }

live_adopt_arms() {
    local arm_rc control pid_before pid_after adopt_status adopt_body
    local listening addresses peer_requests probe retire_status retire_body
    local toggled=no control_sent=no
    proxy_first_arm

    # The bearer of the library's routes, from the launcher page, which the
    # toggle chord opens when the start showed none.
    arm_rc=0
    if ! page_listed 'Chan Launcher'; then
        wait_for 60 "the terminal window's page in the inspector" terminal_listed || arm_rc=1
        if toggle_launcher; then toggled=yes; else arm_rc=1; fi
    fi
    wait_for 60 "the launcher page in the inspector" launcher_href || arm_rc=1
    ORIGIN="${LAUNCHER_HREF%%/\?t=*}"
    local token="${LAUNCHER_HREF##*\?t=}"
    token="${token%%&*}"
    ( umask 077; printf 'Authorization: Bearer %s\n' "$token" > "$WORK/bearer.header" )
    control="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$ORIGIN/api/library/gateways" 2>>"$WORK/curl.err" || echo curl-failed)"
    [ "$control" = 401 ] || arm_rc=1
    verdict launcher-bearer "$arm_rc" "launcher page at ${ORIGIN:-none} (opened by the toggle chord: $toggled), an unauthenticated list answered $control (want 401)"
    [ "$arm_rc" = 0 ] || fail "no launcher bearer: the adopt arm needs it"

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
    [ "$connect_status" = 409 ] || arm_rc=1
    grep -q 'gateway discovery returned HTTP 404' "$WORK/connect.json" 2>/dev/null || arm_rc=1
    wait_for 60 "the discovery request at the peer" peer_logged '^request: from=10\.7\.0\.1:[0-9]+ line=GET /\.well-known/chan-gateway' || arm_rc=1
    wait_for 30 "the desktop to read the 404" logged 'gateway discovery.*404' || arm_rc=1
    launcher_fetch "$PEER_URL/webview-probe" || arm_rc=1
    wait_for 30 "the webview's fetch at the peer" peer_logged '^request: from=10\.7\.0\.1:[0-9]+ line=GET /webview-probe ' || arm_rc=1
    if peer_logged 'line=GET /webview-probe-before '; then arm_rc=1; fi
    [ "$control_sent" = yes ] || arm_rc=1
    verdict tenant "$arm_rc" "connect answered $connect_status (want 409 naming the discovery 404); discovery requests from the tunnel address $(grep -cE '^request: from=10\.7\.0\.1:[0-9]+ line=GET /\.well-known/chan-gateway' "$WORK/peer.log" || true) of $(grep -cE '^request: .*GET /\.well-known/chan-gateway' "$WORK/peer.log" || true), desktop read 404 $(count 'gateway discovery.*404'), webview probe $(grep -cE '^request: from=10\.7\.0\.1:[0-9]+ line=GET /webview-probe ' "$WORK/peer.log" || true), the probe sent before the file: sent $control_sent, reached the peer $(grep -cE 'line=GET /webview-probe-before ' "$WORK/peer.log" || true) (want sent yes, reached 0)"

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

if [ "$LIVE_ADOPT" = 1 ]; then
    live_adopt_arms
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

if [ "$FAILED" != 0 ]; then
    log "FAIL: $FAILED arm(s) failed at $SHA; work dir kept at $WORK"
    exit 1
fi
log "PASS at $SHA; work dir $WORK removed"
cleanup
trap - EXIT
rm -rf "${WORK:?}"
