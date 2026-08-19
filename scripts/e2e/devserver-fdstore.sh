#!/usr/bin/env bash
# Continuous fdstore parking e2e against a REAL `systemctl --user` unit.
#
# Proves the devserver terminal-survival contract end to end: shared-terminal
# and workspace PTYs survive (1) a bare `systemctl --user restart`, including distinct live
# and spawn metadata, (2) `chan devserver restart`, (3) a watchdog kill
# (SIGSTOP the main process), and (4) a kill -9 crash restart including a
# session spawned after the previous boot; session close, `stop`,
# `restart --force`, and a bare `systemctl --user stop` all end the shells
# and empty the store. The fd store count is asserted after every phase so
# restart/adoption cycles can never grow it.
#
# The fixed user unit chan-devserver.service is snapshotted (unit file,
# drop-ins, enabled state, active state) and restored on exit, failure,
# or interruption. An ACTIVE pre-existing unit is refused unless
# CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1, because stopping a real devserver
# kills its live terminals even though the unit itself is restored.
#
# Everything runs against a throwaway CHAN_HOME and a throwaway port.
#
# Run this inside an sdme container, never on a host serving live
# terminals. The throwaway CHAN_HOME and port do not isolate the part
# that matters: the suite drives the FIXED user unit above, and
# restarting, stopping, or killing that unit ends every PTY it carries,
# including the terminal running the test. CHAN_FDSTORE_E2E_ALLOW_TAKEOVER
# is for a container where nothing else owns the unit, not for a host
# where the refusal is inconvenient.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_NAME="chan-devserver.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
DROPIN_DIR="$UNIT_FILE.d"

log() { printf 'devserver-fdstore: %s\n' "$*" >&2; }
fail() {
    log "FAIL: $*"
    log "work dir kept at $WORK"
    exit 1
}

# Cleanup ordering, shared by success and the EXIT trap. The unit
# restoration reads $SNAP inside $WORK, so success must run the
# restoration FIRST and delete the throwaway work dir only afterwards;
# every non-success exit keeps $WORK for diagnosis. restore_unit_state
# is defined (or stubbed by the self-test) before any path can call this.
CLEANUP_RAN=0
on_exit() {
    [ "$CLEANUP_RAN" = 1 ] && return
    CLEANUP_RAN=1
    restore_unit_state
}
finish_success() {
    on_exit
    rm -rf "$WORK"
}

# Self-test seam for the ordering above (systemd is never touched):
#   CHAN_FDSTORE_E2E_SELFTEST=cleanup-order scripts/e2e/devserver-fdstore.sh
if [ "${CHAN_FDSTORE_E2E_SELFTEST:-}" = "cleanup-order" ]; then
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/chan-fdstore-selftest.XXXXXX")"
    SNAP="$WORK/unit-snapshot"
    mkdir -p "$SNAP"
    printf 'unit\n' > "$SNAP/unit"
    RESTORED_SAW_SNAPSHOT=0
    restore_unit_state() {
        if [ -f "$SNAP/unit" ]; then
            RESTORED_SAW_SNAPSHOT=1
        fi
    }
    finish_success
    if [ "$RESTORED_SAW_SNAPSHOT" != 1 ]; then
        log "SELFTEST FAIL: restoration ran after its snapshot was deleted"
        exit 1
    fi
    if [ -d "$WORK" ]; then
        log "SELFTEST FAIL: success must remove the work dir after restoring"
        exit 1
    fi
    if [ "$CLEANUP_RAN" != 1 ]; then
        log "SELFTEST FAIL: the EXIT guard must observe the success cleanup"
        exit 1
    fi
    log "selftest cleanup-order OK"
    trap - EXIT INT TERM
    exit 0
fi

command -v systemctl >/dev/null || { log "SKIP: no systemctl"; exit 0; }
command -v systemd-detect-virt >/dev/null \
    || { log "REFUSE: systemd-detect-virt is required to prove container isolation"; exit 1; }
systemd-detect-virt --container >/dev/null 2>&1 \
    || { log "REFUSE: this destructive fixed-unit suite must run inside a container"; exit 1; }
systemctl --user show-environment >/dev/null 2>&1 \
    || { log "SKIP: no systemd user session"; exit 0; }
command -v python3 >/dev/null || { log "SKIP: python3 required"; exit 0; }
command -v node >/dev/null || { log "SKIP: node required"; exit 0; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/chan-fdstore-e2e.XXXXXX")"
export CHAN_HOME="$WORK/home"
mkdir -p "$CHAN_HOME"
PORT=$((18700 + RANDOM % 250))
BASE="http://127.0.0.1:$PORT"
SHA="$(git -C "$REPO" rev-parse HEAD)"
log "commit under test: $SHA"
log "work dir: $WORK  port: $PORT"

# ---- snapshot the pre-existing unit state; refuse unprovable restores ----
SNAP="$WORK/unit-snapshot"
mkdir -p "$SNAP"
HAD_UNIT=0 HAD_DROPIN=0 WAS_ENABLED=0 WAS_ACTIVE=0
if [ -e "$UNIT_FILE" ]; then
    HAD_UNIT=1
    cp -a "$UNIT_FILE" "$SNAP/unit"
fi
if [ -e "$DROPIN_DIR" ]; then
    HAD_DROPIN=1
    cp -a "$DROPIN_DIR" "$SNAP/dropins"
fi
if systemctl --user is-enabled --quiet "$UNIT_NAME" 2>/dev/null; then
    WAS_ENABLED=1
fi
if systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    WAS_ACTIVE=1
fi
if [ "$HAD_UNIT" = 1 ] && [ ! -r "$SNAP/unit" ]; then
    log "REFUSE: cannot snapshot $UNIT_FILE; restoration would be unprovable"
    rm -rf "$WORK"
    exit 1
fi
if [ "$WAS_ACTIVE" = 1 ] && [ "${CHAN_FDSTORE_E2E_ALLOW_TAKEOVER:-0}" != 1 ]; then
    log "REFUSE: $UNIT_NAME is ACTIVE; stopping it kills its live terminals."
    log "Re-run with CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1 to take the unit over."
    rm -rf "$WORK"
    exit 1
fi

restore_unit_state() {
    set +e
    systemctl --user stop "$UNIT_NAME" >/dev/null 2>&1
    systemctl --user disable "$UNIT_NAME" >/dev/null 2>&1
    rm -f "$UNIT_FILE"
    rm -rf "$DROPIN_DIR"
    if [ "$HAD_UNIT" = 1 ]; then
        cp -a "$SNAP/unit" "$UNIT_FILE"
    fi
    if [ "$HAD_DROPIN" = 1 ]; then
        cp -a "$SNAP/dropins" "$DROPIN_DIR"
    fi
    systemctl --user daemon-reload >/dev/null 2>&1
    if [ "$WAS_ENABLED" = 1 ]; then
        systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1
    fi
    if [ "$WAS_ACTIVE" = 1 ]; then
        systemctl --user restart "$UNIT_NAME" >/dev/null 2>&1
    fi
    # Reap any e2e shells that outlived their case.
    pkill -f 'sleep 8631[0-9]' >/dev/null 2>&1
    set -e
}
# Restore EXACTLY once, always through on_exit (defined with
# finish_success above). INT/TERM must terminate (preserving a nonzero
# status), never resume the script after a restoration already ran.
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---- helpers ----
wait_until() { # seconds description cmd...
    local deadline=$(( $(date +%s) + $1 )) what="$2"
    shift 2
    until "$@"; do
        [ "$(date +%s)" -lt "$deadline" ] || fail "timed out waiting for $what"
        sleep 0.5
    done
}

unit_prop() { systemctl --user show "$UNIT_NAME" --property="$1" --value; }

store_count() {
    local n
    n="$(unit_prop NFileDescriptorStore)"
    [ -n "$n" ] || fail "systemd reports no NFileDescriptorStore property"
    printf '%s' "$n"
}

assert_store() {
    local want="$1" why="$2" got
    got="$(store_count)"
    [ "$got" = "$want" ] || fail "fd store count $got, want $want ($why)"
    log "store count $got as expected ($why)"
}

ready() { curl -fsS -m 2 "$BASE/api/devserver/info" >/dev/null 2>&1; }

devserver_token() {
    python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["devserver_token"])' \
        "$CHAN_HOME/devserver/config.json"
}

api() { # method path [bearer]
    local method="$1" path="$2" bearer="${3:-}"
    if [ -n "$bearer" ]; then
        curl -fsS -m 10 -X "$method" -H "Authorization: Bearer $bearer" "$BASE$path"
    else
        curl -fsS -m 10 -X "$method" "$BASE$path"
    fi
}

json_field() { # field  (stdin: json object)
    python3 -c 'import json,sys;print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

window_route() { # window-id  (prints "prefix token")
    local wid="$1" token rows
    token="$(devserver_token)"
    rows="$(api GET /api/library/windows "$token")"
    printf '%s' "$rows" | python3 -c '
import json, sys
wid = sys.argv[1]
rows = json.load(sys.stdin)
row = next(r for r in rows if r["window_id"] == wid)
print(row["prefix"], row["token"])' "$wid"
}

terminal_ws_url() { # sid window-id query-name query-group
    local sid="$1" wid="$2" query_name="$3" query_group="$4"
    local prefix ttoken
    read -r prefix ttoken <<<"$(window_route "$wid")"
    python3 -c '
import sys
from urllib.parse import urlencode

base, prefix, token, sid, wid, name, group = sys.argv[1:]
scheme = "wss" if base.startswith("https:") else "ws"
host = base.split("://", 1)[1]
query = urlencode({
    "cols": 80,
    "rows": 24,
    "tab_name": name,
    "tab_group": group,
    "window_id": wid,
    "session": sid,
    "since": 0,
    "agent_echo_since": 0,
    "t": token,
})
print(f"{scheme}://{host}{prefix}/api/terminal/ws?{query}")' \
        "$BASE" "$prefix" "$ttoken" "$sid" "$wid" "$query_name" "$query_group"
}

probe_terminal_metadata() { # sid window-id query-name query-group [name group]
    local sid="$1" wid="$2" query_name="$3" query_group="$4" ws_url
    shift 4
    ws_url="$(terminal_ws_url "$sid" "$wid" "$query_name" "$query_group")"
    NODE_NO_WARNINGS=1 node --experimental-websocket \
        "$REPO/scripts/e2e/terminal-metadata-ws.mjs" "$ws_url" "$@"
}

assert_probe_metadata() { # why live-name live-group spawn-name spawn-group [ack-name ack-group]
    local why="$1" live_name="$2" live_group="$3" spawn_name="$4" spawn_group="$5"
    local ack_name="${6:-}" ack_group="${7:-}"
    python3 -c '
import json, sys

why, live_name, live_group, spawn_name, spawn_group, ack_name, ack_group = sys.argv[1:]
payload = json.load(sys.stdin)
session = payload["session"]
want = {
    "name": live_name,
    "group": live_group,
    "spawn_name": spawn_name,
    "spawn_group": spawn_group,
}
got = {key: session.get(key) for key in want}
if got != want:
    raise SystemExit(f"{why}: session metadata {got!r}, want {want!r}")
if ack_name:
    ack = payload.get("renamed")
    want_ack = {"type": "renamed", "name": ack_name, "group": ack_group}
    if ack != want_ack:
        raise SystemExit(f"{why}: rename ack {ack!r}, want {want_ack!r}")
' "$why" "$live_name" "$live_group" "$spawn_name" "$spawn_group" \
        "$ack_name" "$ack_group"
    log "terminal metadata as expected ($why)"
}

manifest_has_metadata() { # sid live-name live-group spawn-name spawn-group
    python3 -c '
import json, sys

path, sid, live_name, live_group, spawn_name, spawn_group = sys.argv[1:]
with open(path) as handle:
    manifest = json.load(handle)
entry = next(row for row in manifest["sessions"] if row["meta"]["session_id"] == sid)
meta = entry["meta"]
want = {
    "tab_name": live_name,
    "tab_group": live_group,
    "spawn_name": spawn_name,
    "spawn_group": spawn_group,
}
got = {key: meta.get(key) for key in want}
raise SystemExit(0 if got == want else 1)
' "$CHAN_HOME/devserver/fdstore-restart.json" "$@"
}

# Mint a terminal window, spawn `sleep 8631N` in it, echo "sid pid".
spawn_windowed_sleep() { # magic-seconds
    local magic="$1" token window prefix ttoken wid sid pid
    token="$(devserver_token)"
    window="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' \
        -d '{"kind":"terminal"}' "$BASE/api/library/windows")"
    wid="$(printf '%s' "$window" | json_field window_id)"
    prefix="$(printf '%s' "$window" | json_field prefix)"
    ttoken="$(printf '%s' "$window" | json_field token)"
    sid="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $ttoken" \
        -H 'Content-Type: application/json' \
        -d "{\"name\":\"e2e-$magic\",\"command\":\"exec sleep $magic\",\"window_id\":\"$wid\"}" \
        "$BASE$prefix/api/terminals" | json_field session)"
    # Readiness barrier for the spawn: the child's cmdline is observable.
    wait_until 15 "child sleep $magic" sh -c "pgrep -f 'sleep ${magic%?}[${magic: -1}]' >/dev/null"
    pid="$(pgrep -f "sleep ${magic%?}[${magic: -1}]" | head -1)"
    printf '%s %s %s\n' "$sid" "$pid" "$wid"
}

# Register a throwaway workspace, mint a window in its tenant, and spawn a
# windowed PTY there. Prints "sid pid window-id" like spawn_windowed_sleep.
spawn_workspace_sleep() { # magic-seconds workspace-root
    local magic="$1" root="$2" token payload window prefix ttoken wid sid pid
    token="$(devserver_token)"
    payload="$(python3 -c 'import json,sys;print(json.dumps({"path": sys.argv[1]}))' "$root")"
    curl -fsS -m 60 -X POST -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' -d "$payload" \
        "$BASE/api/devserver/workspaces" >/dev/null
    payload="$(python3 -c '
import json, sys
print(json.dumps({"kind": "workspace", "workspace_path": sys.argv[1]}))
' "$root")"
    window="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $token" \
        -H 'Content-Type: application/json' -d "$payload" \
        "$BASE/api/library/windows")"
    wid="$(printf '%s' "$window" | json_field window_id)"
    prefix="$(printf '%s' "$window" | json_field prefix)"
    ttoken="$(printf '%s' "$window" | json_field token)"
    sid="$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $ttoken" \
        -H 'Content-Type: application/json' \
        -d "{\"name\":\"e2e-$magic\",\"command\":\"exec sleep $magic\",\"window_id\":\"$wid\"}" \
        "$BASE$prefix/api/terminals" | json_field session)"
    wait_until 15 "workspace child sleep $magic" \
        sh -c "pgrep -f 'sleep ${magic%?}[${magic: -1}]' >/dev/null"
    pid="$(pgrep -f "sleep ${magic%?}[${magic: -1}]" | head -1)"
    printf '%s %s %s\n' "$sid" "$pid" "$wid"
}

child_alive() { kill -0 "$1" 2>/dev/null; }

# The session id must be reachable through its exact window's tenant roster
# after a boot (tenant tokens re-mint across restarts).
assert_session_listed() { # sid window-id
    local sid="$1" wid="$2" prefix ttoken
    read -r prefix ttoken <<<"$(window_route "$wid")" \
        || fail "window $wid is not listed"
    api GET "$prefix/api/terminals/roster" "$ttoken" | grep -q "$sid" \
        || fail "session $sid missing from window $wid tenant roster"
    log "session $sid listed in window $wid tenant roster"
}

main_pid() {
    local pid
    pid="$(unit_prop MainPID)"
    [ -n "$pid" ] && [ "$pid" != 0 ] || fail "unit has no MainPID"
    printf '%s' "$pid"
}

wait_restarted() { # old-nrestarts old-mainpid why
    # Positive evidence of the AUTOMATIC restart first -- a changed restart
    # count or a replaced main pid -- and only then readiness. An unchanged
    # count with the old unit still active must keep waiting.
    local old_restarts="$1" old_pid="$2" why="$3"
    wait_until 90 "restart evidence after $why" sh -c "
        n=\$(systemctl --user show $UNIT_NAME --property=NRestarts --value)
        p=\$(systemctl --user show $UNIT_NAME --property=MainPID --value)
        [ \"\$n\" != \"$old_restarts\" ] || { [ \"\$p\" != \"$old_pid\" ] && [ \"\$p\" != 0 ]; }
    "
    wait_until 90 "active unit after $why" \
        systemctl --user is-active --quiet "$UNIT_NAME"
    wait_until 90 "readiness after $why" ready
}

# ---- build the exact commit under test ----
log "building chan (debug) at $SHA"
cargo build --locked -q -p chan --manifest-path "$REPO/Cargo.toml"
TARGET_DIR="${CARGO_TARGET_DIR:-$REPO/target}"
case "$TARGET_DIR" in
    /*) ;;
    *) TARGET_DIR="$REPO/$TARGET_DIR" ;;
esac
CHAN="$TARGET_DIR/debug/chan"

# ---- first start, with a fast-watchdog drop-in in place from boot ----
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/50-e2e-watchdog.conf" <<'EOF'
[Service]
WatchdogSec=5
TimeoutStopSec=5
EOF
systemctl --user daemon-reload

log "starting the devserver unit"
"$CHAN" devserver restart --service=systemd --bind=127.0.0.1 --port="$PORT"
wait_until 60 "first readiness" ready
assert_store 0 "fresh boot, nothing parked"

read -r SID1 PID1 WID1 <<<"$(spawn_windowed_sleep 86311)"
log "session1 $SID1 child $PID1 window $WID1"
assert_store 1 "one windowed session parked at spawn"
[ -f "$CHAN_HOME/devserver/fdstore-restart.json" ] \
    || fail "restart manifest missing after park"

SPAWN_NAME1="e2e-86311"
SPAWN_GROUP1="default"
LIVE_NAME1="e2e-live-86311"
LIVE_GROUP1="fdstore-live"
METADATA1="$(probe_terminal_metadata \
    "$SID1" "$WID1" "$SPAWN_NAME1" "$SPAWN_GROUP1" \
    "$LIVE_NAME1" "$LIVE_GROUP1")"
printf '%s' "$METADATA1" | assert_probe_metadata \
    "live rename before bare restart" \
    "$SPAWN_NAME1" "$SPAWN_GROUP1" "$SPAWN_NAME1" "$SPAWN_GROUP1" \
    "$LIVE_NAME1" "$LIVE_GROUP1"
wait_until 15 "distinct live/spawn metadata in restart manifest" \
    manifest_has_metadata \
    "$SID1" "$LIVE_NAME1" "$LIVE_GROUP1" "$SPAWN_NAME1" "$SPAWN_GROUP1"
log "restart manifest records distinct live and spawn metadata"

WORKSPACE="$WORK/workspace"
mkdir -p "$WORKSPACE"
printf '# fdstore workspace\n' > "$WORKSPACE/README.md"
read -r WS_SID1 WS_PID1 WS_WID1 <<<"$(spawn_workspace_sleep 86315 "$WORKSPACE")"
log "workspace session $WS_SID1 child $WS_PID1 window $WS_WID1"
assert_store 2 "shared and workspace sessions parked at spawn"

# ---- case 1: bare systemctl restart ----
log "case 1: bare systemctl --user restart"
systemctl --user restart "$UNIT_NAME"
wait_until 60 "readiness after bare restart" ready
child_alive "$PID1" || fail "child died across bare restart"
child_alive "$WS_PID1" || fail "workspace child died across bare restart"
assert_session_listed "$SID1" "$WID1"
assert_session_listed "$WS_SID1" "$WS_WID1"
METADATA1="$(probe_terminal_metadata \
    "$SID1" "$WID1" "stale-query-86311" "stale-query-group")"
printf '%s' "$METADATA1" | assert_probe_metadata \
    "fdstore adoption after bare restart" \
    "$LIVE_NAME1" "$LIVE_GROUP1" "$SPAWN_NAME1" "$SPAWN_GROUP1"
assert_store 2 "adoption after bare restart must not grow the store"

# ---- case 2: chan devserver restart ----
log "case 2: chan devserver restart"
"$CHAN" devserver restart --service=systemd --bind=127.0.0.1 --port="$PORT"
wait_until 60 "readiness after CLI restart" ready
child_alive "$PID1" || fail "child died across CLI restart"
child_alive "$WS_PID1" || fail "workspace child died across CLI restart"
assert_session_listed "$SID1" "$WID1"
assert_session_listed "$WS_SID1" "$WS_WID1"
assert_store 2 "adoption after CLI restart must not grow the store"

# ---- case 3: watchdog kill (SIGSTOP the main process) ----
log "case 3: watchdog restart via SIGSTOP"
OLD_PID="$(main_pid)"
OLD_RESTARTS="$(unit_prop NRestarts)"
kill -STOP "$OLD_PID"
wait_until 90 "watchdog to replace the main pid" \
    sh -c "[ \"\$(systemctl --user show $UNIT_NAME --property=MainPID --value)\" != \"$OLD_PID\" ]"
wait_until 90 "readiness after watchdog restart" ready
[ "$(unit_prop NRestarts)" != "$OLD_RESTARTS" ] || fail "NRestarts did not increase"
journalctl --user -u "$UNIT_NAME" -n 200 --no-pager 2>/dev/null | grep -qi "watchdog" \
    || log "note: journal shows no watchdog line (may be unreadable here)"
child_alive "$PID1" || fail "child died across watchdog restart"
child_alive "$WS_PID1" || fail "workspace child died across watchdog restart"
assert_session_listed "$SID1" "$WID1"
assert_session_listed "$WS_SID1" "$WS_WID1"
assert_store 2 "watchdog restart must not grow the store"

# ---- case 4: crash restore, including a post-boot spawn ----
log "case 4: kill -9 crash restore with a second session"
read -r SID2 PID2 WID2 <<<"$(spawn_windowed_sleep 86312)"
log "session2 $SID2 child $PID2 window $WID2"
assert_store 3 "second shared session parked alongside workspace session"
OLD_RESTARTS="$(unit_prop NRestarts)"
OLD_MAIN="$(main_pid)"
kill -9 "$OLD_MAIN"
wait_restarted "$OLD_RESTARTS" "$OLD_MAIN" "crash"
child_alive "$PID1" || fail "session1 child died across crash restart"
child_alive "$WS_PID1" || fail "workspace child died across crash restart"
child_alive "$PID2" || fail "session2 child died across crash restart"
assert_session_listed "$SID1" "$WID1"
assert_session_listed "$WS_SID1" "$WS_WID1"
assert_session_listed "$SID2" "$WID2"
assert_store 3 "crash adoption must not grow the store"

# ---- case 5: closing a session removes its store entry ----
log "case 5: session close removes the store entry"
read -r TPREFIX TTOKEN <<<"$(window_route "$WID2")"
api DELETE "$TPREFIX/api/terminals/$SID2" "$TTOKEN" >/dev/null
wait_until 15 "session2 child death" sh -c "! kill -0 $PID2 2>/dev/null"
assert_store 2 "closed session left the shared and workspace entries"

# ---- case 6: chan devserver stop kills the child before the unit exits ----
log "case 6: chan devserver stop"
"$CHAN" devserver stop --service=systemd
child_alive "$PID1" && fail "child survived stop's explicit drain"
child_alive "$WS_PID1" && fail "workspace child survived stop's explicit drain"
systemctl --user is-active --quiet "$UNIT_NAME" && fail "unit still active after stop"
assert_store 0 "stop released the store"

# ---- case 7: restart --force kills sessions and restarts ----
log "case 7: restart --force"
"$CHAN" devserver restart --service=systemd --bind=127.0.0.1 --port="$PORT"
wait_until 60 "readiness before force" ready
read -r SID3 PID3 WID3 <<<"$(spawn_windowed_sleep 86313)"
log "session3 $SID3 child $PID3 window $WID3"
assert_store 1 "session parked before force"
"$CHAN" devserver restart --service=systemd --force --bind=127.0.0.1 --port="$PORT"
wait_until 60 "readiness after force" ready
child_alive "$PID3" && fail "child survived restart --force"
assert_store 0 "force restart cleared the store"

# ---- case 8: bare systemctl stop HUPs the shells and empties the store ----
log "case 8: bare systemctl --user stop"
read -r SID4 PID4 WID4 <<<"$(spawn_windowed_sleep 86314)"
log "session4 $SID4 child $PID4 window $WID4"
assert_store 1 "session parked before bare stop"
systemctl --user stop "$UNIT_NAME"
wait_until 30 "session4 child death via store release HUP" \
    sh -c "! kill -0 $PID4 2>/dev/null"
assert_store 0 "bare stop released the store"

log "PASS: all 8 cases at $SHA"
# Restore the pre-existing unit state (the snapshot lives inside $WORK)
# BEFORE the throwaway work dir goes away.
finish_success
