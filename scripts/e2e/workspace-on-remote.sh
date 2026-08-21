#!/usr/bin/env bash
# End-to-end proof of the remote workspace arms against REAL processes:
# `chan workspace serve|close|forget WS --on TARGET` from a plain shell, a
# real `chan devserver run` on a loopback port, and a real chan-desktop
# running headless under Xvfb that registers, connects, resolves the
# target, and drives the devserver's management API.
#
# What it proves: serve mounts (the devserver lists the path as on, and a
# second serve is idempotent); a live terminal makes close and forget refuse
# with the terminal count and leave the row alone; closing the terminal lets
# close unmount (row stays registered, off), serve remount, and forget drop
# the row; a port-shaped --on and a label-shaped --devserver are parse
# refusals; an unknown target and a duplicate label refuse naming what
# exists. What it cannot prove: an ssh control-terminal connect, the gateway
# arm of the desktop's add-workspace call, and Windows named pipes.
#
# Needs `xvfb-run`, a built chan-desktop (CHAN_DESKTOP_BIN, default
# target/release/chan-desktop; this script does not build the desktop, which
# needs the web bundles), curl, and python3 for the JSON assertions. Exits 2
# when the environment cannot run it. Everything runs under a throwaway
# CHAN_HOME, HOME, XDG_RUNTIME_DIR and port; the work dir is kept on failure.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
CHAN_DESKTOP_BIN="${CHAN_DESKTOP_BIN:-$REPO/target/release/chan-desktop}"
PORT="${PORT:-$((20000 + RANDOM % 20000))}"

log() { printf 'workspace-on-remote: %s\n' "$*" >&2; }
refuse() { log "cannot run: $*"; exit 2; }
fail() {
    log "FAIL: $*"
    log "work dir kept at $WORK"
    exit 1
}

command -v xvfb-run >/dev/null 2>&1 || refuse "xvfb-run is not installed"
command -v curl >/dev/null 2>&1 || refuse "curl is not installed"
command -v python3 >/dev/null 2>&1 || refuse "python3 is not installed"
[ -x "$CHAN_DESKTOP_BIN" ] || refuse "no chan-desktop binary at $CHAN_DESKTOP_BIN (set CHAN_DESKTOP_BIN)"

if [ -z "${CHAN_BIN:-}" ]; then
    log "building chan at $SHA"
    (cd "$REPO" && cargo build --locked -p chan >/dev/null)
    CHAN_BIN="$REPO/target/debug/chan"
fi
[ -x "$CHAN_BIN" ] || refuse "no chan binary at $CHAN_BIN"

WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-workspace-on-remote.XXXXXX")"
export CHAN_HOME="$WORK/chan-home"
export HOME="$WORK/home"
export XDG_RUNTIME_DIR="$WORK/run"
export TMPDIR="$WORK/tmp"
mkdir -p "$CHAN_HOME" "$HOME" "$XDG_RUNTIME_DIR" "$TMPDIR"
chmod 700 "$XDG_RUNTIME_DIR"
# A test launched from inside a chan terminal must not inherit session
# state, handoff hints, or credentials.
for v in $(compgen -v | grep -E '^CHAN_' | grep -vE '^CHAN_(HOME|BIN|DESKTOP_BIN)$'); do unset "$v"; done
export CHAN_UPDATE_CHECK=0
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1

PIDS=()
cleanup() {
    local pid
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    sleep 0.5
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT

wait_for() {
    # wait_for <seconds> <description> <command...>: poll until the command succeeds.
    local secs="$1" what="$2"; shift 2
    local deadline=$((SECONDS + secs))
    until "$@"; do
        [ "$SECONDS" -lt "$deadline" ] || fail "timed out waiting for $what"
        sleep 0.5
    done
}

BASE="http://127.0.0.1:$PORT"
log "work dir $WORK, devserver port $PORT, chan $SHA"

# 1. A real devserver, token scraped from its stdout marker.
"$CHAN_BIN" devserver run --bind 127.0.0.1 --port "$PORT" > "$WORK/devserver.log" 2>&1 &
PIDS+=("$!")
wait_for 30 "the devserver to listen" grep -q "listening on http://" "$WORK/devserver.log"
TOKEN="$(grep -o 'CHAN_DEVSERVER_TOKEN=[^[:space:]]*' "$WORK/devserver.log" | head -1 | cut -d= -f2-)"
[ -n "$TOKEN" ] || fail "no CHAN_DEVSERVER_TOKEN marker in $WORK/devserver.log"

api() {
    # api <method> <path-or-url> [token] [json-body]
    local method="$1" target="$2" tok="${3:-$TOKEN}" body="${4:-}"
    case "$target" in http*) ;; *) target="$BASE$target" ;; esac
    if [ -n "$body" ]; then
        curl -sS -X "$method" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
            --data "$body" -w '\n%{http_code}' "$target"
    else
        curl -sS -X "$method" -H "Authorization: Bearer $tok" -w '\n%{http_code}' "$target"
    fi
}
json_field() {
    # json_field <json> <python expression over `d`>
    python3 -c 'import json,sys; d=json.loads(sys.argv[1]); v=eval(sys.argv[2]); print(v if v is not None else "")' "$1" "$2"
}
row_for() {
    # row_for <path>: the devserver workspace row as JSON, or empty.
    local out
    out="$(api GET /api/devserver/workspaces)"
    python3 -c 'import json,sys
rows=json.loads(sys.argv[1].rsplit("\n",1)[0]); p=sys.argv[2]
m=[r for r in rows if r.get("path")==p]
print(json.dumps(m[0]) if m else "")' "$out" "$1"
}

# 2. A real desktop, headless, with its handoff socket in our runtime dir.
xvfb-run -a "$CHAN_DESKTOP_BIN" > "$WORK/desktop.log" 2>&1 &
PIDS+=("$!")
wait_for 60 "the desktop handoff socket" test -S "$XDG_RUNTIME_DIR/chan-desktop.sock"
wait_for 30 "chan devserver ls to answer" "$CHAN_BIN" devserver ls

# 3. Register and connect the devserver by label.
"$CHAN_BIN" devserver register "$BASE/?t=$TOKEN" --name lab > "$WORK/register.out" 2>&1 || fail "register: $(cat "$WORK/register.out")"
"$CHAN_BIN" devserver connect lab > "$WORK/connect.out" 2>&1 || fail "connect: $(cat "$WORK/connect.out")"
connected() {
    local out
    out="$("$CHAN_BIN" devserver ls --json 2>/dev/null)" || return 1
    [ "$(json_field "$out" '[d["status"] for d in d["devservers"] if d["label"]=="lab"][0]')" = "connected" ]
}
wait_for 60 "the devserver to connect" connected

WS="$WORK/ws"
mkdir -p "$WS"
printf '# note\n' > "$WS/a.md"

run_arm() {
    # run_arm <label> <args...>: runs chan, records stdout/stderr/rc under $WORK.
    local label="$1"; shift
    set +e
    "$CHAN_BIN" "$@" > "$WORK/$label.out" 2> "$WORK/$label.err"
    echo $? > "$WORK/$label.rc"
    set -e
    log "$label: rc=$(cat "$WORK/$label.rc") stdout=$(tr '\n' ' ' < "$WORK/$label.out") stderr=$(tr '\n' ' ' < "$WORK/$label.err")"
}
expect_rc() { [ "$(cat "$WORK/$1.rc")" = "$2" ] || fail "$1: expected rc $2, got $(cat "$WORK/$1.rc") (stderr: $(cat "$WORK/$1.err"))"; }
expect_out() { grep -q -- "$2" "$WORK/$1.out" || fail "$1: stdout lacks '$2': $(cat "$WORK/$1.out")"; }
expect_err() { grep -q -- "$2" "$WORK/$1.err" || fail "$1: stderr lacks '$2': $(cat "$WORK/$1.err")"; }

# 4a. serve mounts; a second serve is idempotent.
run_arm serve workspace serve "$WS" --on lab
expect_rc serve 0
expect_out serve "served $WS on devserver lab"
ROW="$(row_for "$WS")"; [ -n "$ROW" ] || fail "serve: devserver lists no row for $WS"
[ "$(json_field "$ROW" 'd["on"]')" = "True" ] || fail "serve: row is not on: $ROW"
PREFIX="$(json_field "$ROW" 'd["prefix"]')"
TENANT_TOKEN="$(json_field "$ROW" 'd["token"]')"
[ -n "$PREFIX" ] && [ -n "$TENANT_TOKEN" ] || fail "serve: row lacks prefix/token: $ROW"
run_arm serve-again serve "$WS" --on lab
expect_rc serve-again 0
expect_out serve-again "mounted at $PREFIX"

# 4b. A live terminal makes close and forget refuse, row untouched.
CREATED="$(api POST "$PREFIX/api/terminals" "$TENANT_TOKEN" '{"name":"e2e","command":"sleep 600"}')"
[ "${CREATED##*$'\n'}" = "201" ] || fail "terminal create: $CREATED"
SESSION="$(json_field "${CREATED%$'\n'*}" 'd["session"]')"
[ -n "$SESSION" ] || fail "terminal create returned no session: $CREATED"
run_arm forget-refused workspace forget "$WS" --on lab
expect_rc forget-refused 1
expect_err forget-refused "live terminal(s)"
run_arm close-refused close "$WS" --on lab
expect_rc close-refused 1
expect_err close-refused "live terminal(s)"
ROW="$(row_for "$WS")"; [ "$(json_field "$ROW" 'd["on"]')" = "True" ] || fail "refused close changed the row: $ROW"

# 4c. Close the terminal: close unmounts (still registered), serve remounts, forget drops the row.
DELETED="$(api DELETE "$PREFIX/api/terminals/$SESSION" "$TENANT_TOKEN")"
case "${DELETED##*$'\n'}" in 200|204) ;; *) fail "terminal delete: $DELETED" ;; esac
wait_for 20 "the terminal to end" test "$(api GET "$PREFIX/api/terminals/roster" "$TENANT_TOKEN" | python3 -c 'import json,sys; t=sys.stdin.read().rsplit("\n",1)[0]; print(len(json.loads(t)) if t.strip().startswith("[") else 0)')" = "0"
run_arm close workspace close "$WS" --on lab
expect_rc close 0
expect_out close "closed: $WS"
ROW="$(row_for "$WS")"; [ -n "$ROW" ] || fail "close forgot the row: $WS"
[ "$(json_field "$ROW" 'd["on"]')" = "False" ] || fail "close left the row on: $ROW"
run_arm reserve serve "$WS" --on lab
expect_rc reserve 0
ROW="$(row_for "$WS")"; [ "$(json_field "$ROW" 'd["on"]')" = "True" ] || fail "remount left the row off: $ROW"
run_arm forget workspace forget "$WS" --on lab
expect_rc forget 0
expect_out forget "forgot: $WS"
[ -z "$(row_for "$WS")" ] || fail "forget left the row: $(row_for "$WS")"

# 4d. Refusals: flag grammar, unknown target, duplicate label.
run_arm on-port serve "$WS" --on 8787
expect_rc on-port 2
expect_err on-port -- "--devserver"
run_arm devserver-label serve "$WS" --devserver=lab
expect_rc devserver-label 2
expect_err devserver-label -- "--on"
run_arm on-nope serve "$WS" --on nope
expect_rc on-nope 1
expect_err on-nope "no registered devserver matches"
"$CHAN_BIN" devserver register "http://127.0.0.1:$((PORT + 1))" --name lab > "$WORK/register-dup.out" 2>&1 || fail "register dup: $(cat "$WORK/register-dup.out")"
run_arm on-dup serve "$WS" --on lab
expect_rc on-dup 1
expect_err on-dup "more than one registered devserver"

log "PASS at $SHA (work dir $WORK removed)"
cleanup
trap - EXIT
rm -rf "$WORK"
