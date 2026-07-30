#!/usr/bin/env bash
# Continuous fdstore parking e2e against a REAL `systemctl --user` unit.
#
# Proves the devserver terminal-survival contract end to end: a live PTY
# survives (1) a bare `systemctl --user restart`, (2) `chan devserver
# --restart`, (3) a watchdog kill (SIGSTOP the main process), and (4) a
# kill -9 crash restart including a session spawned after the previous
# boot; session close, `--stop`, `--restart --force`, and a bare
# `systemctl --user stop` all end the shells and empty the store. The fd
# store count is asserted after every phase so restart/adoption cycles
# can never grow it.
#
# The fixed user unit chan-devserver.service is snapshotted (unit file,
# drop-ins, enabled state, active state) and restored on exit, failure,
# or interruption. An ACTIVE pre-existing unit is refused unless
# CHAN_FDSTORE_E2E_ALLOW_TAKEOVER=1, because stopping a real devserver
# kills its live terminals even though the unit itself is restored.
#
# Everything runs against a throwaway CHAN_HOME and a throwaway port.
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

command -v systemctl >/dev/null || { log "SKIP: no systemctl"; exit 0; }
systemctl --user show-environment >/dev/null 2>&1 \
    || { log "SKIP: no systemd user session"; exit 0; }
command -v python3 >/dev/null || { log "SKIP: python3 required"; exit 0; }

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

child_alive() { kill -0 "$1" 2>/dev/null; }

# The session id must be reachable through a tenant roster after a boot:
# re-discover the shared terminal tenant via the windows feed each time
# (tenant tokens re-mint across restarts).
assert_session_listed() { # sid
    local sid="$1" token rows
    token="$(devserver_token)"
    rows="$(api GET /api/devserver/windows "$token")"
    local prefix ttoken
    prefix="$(printf '%s' "$rows" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
row = next(r for r in rows if r["kind"] == "terminal")
print(row["prefix"])')" || fail "no terminal window row listed"
    ttoken="$(printf '%s' "$rows" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
row = next(r for r in rows if r["kind"] == "terminal")
print(row["token"])')"
    api GET "$prefix/api/terminals/roster" "$ttoken" | grep -q "$sid" \
        || fail "session $sid missing from the tenant roster"
    log "session $sid listed in the roster"
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
cargo build -q -p chan --manifest-path "$REPO/Cargo.toml"
CHAN="$REPO/target/debug/chan"

# ---- first start, with a fast-watchdog drop-in in place from boot ----
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/50-e2e-watchdog.conf" <<'EOF'
[Service]
WatchdogSec=5
TimeoutStopSec=5
EOF
systemctl --user daemon-reload

log "starting the devserver unit"
"$CHAN" devserver --service=systemd --restart --bind=127.0.0.1 --port="$PORT"
wait_until 60 "first readiness" ready
assert_store 0 "fresh boot, nothing parked"

read -r SID1 PID1 WID1 <<<"$(spawn_windowed_sleep 86311)"
log "session1 $SID1 child $PID1 window $WID1"
assert_store 1 "one windowed session parked at spawn"
[ -f "$CHAN_HOME/devserver/fdstore-restart.json" ] \
    || fail "restart manifest missing after park"

# ---- case 1: bare systemctl restart ----
log "case 1: bare systemctl --user restart"
systemctl --user restart "$UNIT_NAME"
wait_until 60 "readiness after bare restart" ready
child_alive "$PID1" || fail "child died across bare restart"
assert_session_listed "$SID1"
assert_store 1 "adoption after bare restart must not grow the store"

# ---- case 2: chan devserver --restart ----
log "case 2: chan devserver --restart"
"$CHAN" devserver --service=systemd --restart --bind=127.0.0.1 --port="$PORT"
wait_until 60 "readiness after CLI restart" ready
child_alive "$PID1" || fail "child died across CLI restart"
assert_session_listed "$SID1"
assert_store 1 "adoption after CLI restart must not grow the store"

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
assert_session_listed "$SID1"
assert_store 1 "watchdog restart must not grow the store"

# ---- case 4: crash restore, including a post-boot spawn ----
log "case 4: kill -9 crash restore with a second session"
read -r SID2 PID2 WID2 <<<"$(spawn_windowed_sleep 86312)"
log "session2 $SID2 child $PID2 window $WID2"
assert_store 2 "second parked session"
OLD_RESTARTS="$(unit_prop NRestarts)"
OLD_MAIN="$(main_pid)"
kill -9 "$OLD_MAIN"
wait_restarted "$OLD_RESTARTS" "$OLD_MAIN" "crash"
child_alive "$PID1" || fail "session1 child died across crash restart"
child_alive "$PID2" || fail "session2 child died across crash restart"
assert_session_listed "$SID1"
assert_session_listed "$SID2"
assert_store 2 "crash adoption must not grow the store"

# ---- case 5: closing a session removes its store entry ----
log "case 5: session close removes the store entry"
TOKEN="$(devserver_token)"
ROWS="$(api GET /api/devserver/windows "$TOKEN")"
TPREFIX="$(printf '%s' "$ROWS" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
print(next(r for r in rows if r["kind"] == "terminal")["prefix"])')"
TTOKEN="$(printf '%s' "$ROWS" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
print(next(r for r in rows if r["kind"] == "terminal")["token"])')"
api DELETE "$TPREFIX/api/terminals/$SID2" "$TTOKEN" >/dev/null
wait_until 15 "session2 child death" sh -c "! kill -0 $PID2 2>/dev/null"
assert_store 1 "closed session left the store"

# ---- case 6: chan devserver --stop kills the child before the unit exits ----
log "case 6: chan devserver --stop"
"$CHAN" devserver --service=systemd --stop
child_alive "$PID1" && fail "child survived --stop's explicit drain"
systemctl --user is-active --quiet "$UNIT_NAME" && fail "unit still active after --stop"
assert_store 0 "stop released the store"

# ---- case 7: --restart --force kills sessions and restarts ----
log "case 7: --restart --force"
"$CHAN" devserver --service=systemd --restart --bind=127.0.0.1 --port="$PORT"
wait_until 60 "readiness before force" ready
read -r SID3 PID3 WID3 <<<"$(spawn_windowed_sleep 86313)"
log "session3 $SID3 child $PID3 window $WID3"
assert_store 1 "session parked before force"
"$CHAN" devserver --service=systemd --restart --force --bind=127.0.0.1 --port="$PORT"
wait_until 60 "readiness after force" ready
child_alive "$PID3" && fail "child survived --restart --force"
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
