#!/usr/bin/env bash
# Does a restart of a raw devserver close the native windows a directly
# connected desktop has open on it?
#
# A restart is meant to keep a window and give it the restarted devserver in
# place. Two readings of the source say it may instead close and rebuild
# them: a graceful stop can push a window set emptied by its own drain, and
# a devserver started after a kill can push a window set before its
# workspaces are mounted again. Neither timing has been seen.
#
# This runs a real `chan devserver run` and a real chan-desktop under Xvfb,
# connects the desktop to the devserver directly, opens one workspace
# window and one terminal window on it, and restarts the devserver twice:
# once with SIGTERM and a start, once with SIGKILL and a start. An X window
# keeps its id for as long as it lives, so a native window that survives
# keeps its id and one that was closed and rebuilt comes back under a new
# one. The desktop's own log says which feed frame closed it.
#
# Speaks for WebKitGTK and a direct connection only: no gateway, no other
# engine. Needs what lib.sh needs. Exit codes are lib.sh's; the fault is
# "a native window of the devserver was destroyed across a restart".
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name. The directive
# stands before the first command so that it covers the file.
# shellcheck disable=SC2329
set -euo pipefail

# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

obs_setup devserver-restart
obs_need node
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display

DEV_HOME="$OBS_WORK/devserver-home"
PORT="${PORT:-$((20000 + RANDOM % 20000))}"
BASE="http://127.0.0.1:$PORT"
WS="$OBS_WORK/ws"
mkdir -p "$DEV_HOME" "$WS"
printf '# note\n' > "$WS/a.md"
RESULTS="$OBS_WORK/results.txt"
: > "$RESULTS"
DEV_PID=""
DEV_RUN=0

# The devserver keeps its own chan home, as one on another machine would.
start_devserver() {
    DEV_RUN=$((DEV_RUN + 1))
    CHAN_HOME="$DEV_HOME" CHAN_LOG="${OBS_DEVSERVER_LOG:-warn,chan_server=info}" \
        "$CHAN_BIN" devserver run --service=none --bind 127.0.0.1 --port "$PORT" > "$OBS_WORK/devserver.$DEV_RUN.log" 2>&1 &
    DEV_PID=$!
    OBS_PIDS+=("$DEV_PID")
    obs_wait 60 "devserver run $DEV_RUN to listen" grep -q "listening on http://" "$OBS_WORK/devserver.$DEV_RUN.log"
}

api() {
    # api <method> <path> [json-body]: body, then the status on its own line.
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        curl -sS -m 10 -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
            --data "$body" -w '\n%{http_code}' "$BASE$path"
    else
        curl -sS -m 10 -X "$method" -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}' "$BASE$path"
    fi
}

connected() {
    chan devserver ls --json 2>/dev/null | python3 -c '
import json, sys
rows = json.load(sys.stdin)["devservers"]
sys.exit(0 if [r for r in rows if r["label"] == "lab" and r["status"] == "connected"] else 1)'
}

# The native windows of the devserver: every viewable X window that is not
# the launcher, as "<x id> <title>", sorted by id.
native_windows() { obs_x_windows | grep -v -e "^$LAUNCHER_XID " | sort; }
native_ids() { native_windows | cut -d' ' -f1 | tr '\n' ' '; }

snapshot() {
    # snapshot <name>: the native windows, what each of the desktop's pages
    # shows its user, and the devserver's window set, now.
    native_windows > "$OBS_WORK/x.$1.txt"
    { api GET /api/library/windows 2>/dev/null || true; } | obs_masked > "$OBS_WORK/feed.$1.json"
    node "$HERE/inspect.mjs" "$INSPECTOR" all "JSON.stringify({at: new Date().toISOString(), path: location.pathname, text: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 400)})" 2>&1 | obs_masked > "$OBS_WORK/pages.$1.jsonl" || true
    obs_shot "$1"
    obs_log "$1: native windows: $(native_ids)"
}

# 1. Devserver, then the desktop, connected to it directly.
start_devserver
# The bearer comes from the devserver's own 0600 config, never from a log.
TOKEN="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["devserver_token"])' "$DEV_HOME/devserver/config.json" 2>/dev/null || true)"
[ -n "$TOKEN" ] || obs_inconclusive "no devserver_token in $DEV_HOME/devserver/config.json"
obs_start_desktop
obs_log "desktop build: $(grep -m1 -o 'build[^ ]*git-[0-9a-f]*[^ ]*' "$OBS_WORK/desktop.log" | sed 's/\x1b\[[0-9;]*m//g' || echo unknown)"
an_x_window() { [ -n "$(obs_x_windows)" ]; }
obs_wait 60 "the launcher window" an_x_window
sleep 2
LAUNCHER_XID="$(obs_x_windows | sed -n 1p | cut -d' ' -f1)"
obs_wait 30 "chan devserver ls to answer" chan devserver ls
chan devserver register "$BASE/?t=$TOKEN" --name lab > "$OBS_WORK/register.out" 2>&1 || obs_inconclusive "register: $(obs_masked < "$OBS_WORK/register.out")"
chan devserver connect lab > "$OBS_WORK/connect.out" 2>&1 || obs_inconclusive "connect: $(obs_masked < "$OBS_WORK/connect.out")"
obs_wait 60 "the devserver to connect" connected

# 2. One workspace window and one terminal window on the devserver.
chan workspace serve "$WS" --on lab > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "serve --on: $(obs_masked < "$OBS_WORK/serve.out")"
MINT_WS="$(api POST /api/library/windows "{\"kind\":\"workspace\",\"workspace_path\":\"$WS\"}")"
[ "${MINT_WS##*$'\n'}" = "200" ] || obs_inconclusive "minting a workspace window answered: $(printf '%s' "$MINT_WS" | obs_masked)"
MINT_TERM="$(api POST /api/library/windows '{"kind":"terminal"}')"
[ "${MINT_TERM##*$'\n'}" = "200" ] || obs_inconclusive "minting a terminal window answered: $(printf '%s' "$MINT_TERM" | obs_masked)"
two_native() { [ "$(native_windows | wc -l)" -ge 2 ]; }
obs_wait 90 "two native windows of the devserver" two_native
sleep 5
snapshot before
BEFORE="$(native_ids)"

# restart_arm <name> <signal>: stop the devserver with the signal, start it
# again, and record which native windows lived through each step.
restart_arm() {
    local arm="$1" signal="$2" before stopped back
    before="$(native_ids)"
    [ -n "$before" ] || obs_inconclusive "$arm: no native window to watch"
    kill "-$signal" "$DEV_PID"
    local deadline=$((SECONDS + 30))
    while kill -0 "$DEV_PID" 2>/dev/null; do
        [ "$SECONDS" -lt "$deadline" ] || obs_inconclusive "$arm: the devserver did not exit within 30s of SIG$signal"
        sleep 0.2
    done
    # Long enough for a last frame of the stopped devserver to be acted on.
    sleep 5
    snapshot "$arm-stopped"
    stopped="$(native_ids)"
    start_devserver
    obs_wait 120 "the desktop to reconnect after $arm" connected
    obs_wait 120 "two native windows after $arm" two_native
    sleep 8
    snapshot "$arm-back"
    back="$(native_ids)"
    local kept="yes"
    [ "$before" = "$stopped" ] && [ "$before" = "$back" ] || kept="no"
    printf '%s signal=%s before=[%s] stopped=[%s] back=[%s] kept=%s\n' \
        "$arm" "$signal" "$before" "$stopped" "$back" "$kept" | tee -a "$RESULTS" >&2
}

# Both arms, in the order OBS_ARMS gives, so a run can show that neither
# outcome depends on which restart came first.
for arm in ${OBS_ARMS:-graceful kill}; do
    case "$arm" in
    graceful) restart_arm graceful TERM ;;
    kill) restart_arm kill KILL ;;
    *) obs_inconclusive "unknown arm $arm" ;;
    esac
done

obs_verdict
sed 's/\x1b\[[0-9;]*m//g' "$OBS_WORK/desktop.log" | grep -n -i -e 'window watcher' -e 'closing' -e 'reconnect' -e 'devserver' | obs_masked > "$OBS_WORK/desktop.window-lines.txt"
obs_log "results: $RESULTS; desktop log: $OBS_WORK/desktop.log; first set of native windows: $BEFORE"
if grep -q 'kept=no' "$RESULTS"; then
    obs_log "FAULT: a native window of the devserver was destroyed across a restart (WebKitGTK, direct connection)"
    obs_log "work dir kept at $OBS_WORK"
    exit 1
fi
obs_log "PASS: both restarts kept every native window of the devserver (WebKitGTK, direct connection)"
exit 0
