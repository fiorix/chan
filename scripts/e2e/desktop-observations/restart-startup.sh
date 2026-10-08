#!/usr/bin/env bash
# One bounded, disposable direct WebKitGTK restart or removal control.
# Functions passed to obs_wait are used dynamically.
# shellcheck disable=SC2329
set -euo pipefail
umask 077

arm=${1:?one named arm required}
case "$arm" in
graceful-fast|kill-fast|graceful-delayed|kill-delayed|off-control|discard-control) ;;
*) printf 'invalid arm\n' >&2; exit 3 ;;
esac
if [[ ${2:-} != --bounded ]]; then
    bounded_status=0
    timeout --signal=TERM --kill-after=10s 300s bash "$0" "$arm" --bounded || bounded_status=$?
    case "$bounded_status" in 124|137|143) printf 'INCONCLUSIVE: whole-arm timeout\n' >&2; exit 3 ;; esac
    exit "$bounded_status"
fi
run_kind=${RESTART_RUN_KIND:?name rehearsal or counted}
case "$run_kind" in rehearsal|counted) ;; *) printf 'invalid run kind\n' >&2; exit 3 ;; esac
# How a delayed arm is read: baseline looks for the incomplete startup feed
# and what it did to the window; admission is for a devserver that refuses
# its window feed while it starts, and needs that refusal proved.
mode=${RESTART_MODE:-baseline}
case "$mode" in baseline|admission) ;; *) printf 'invalid mode\n' >&2; exit 3 ;; esac
[[ $mode == baseline || $arm != *-fast ]] || { printf 'admission mode has no fast arm\n' >&2; exit 3; }
package=$(cd "$(dirname "$0")" && pwd)
source_repo=${RESTART_SOURCE_REPO:-}
output_parent=${RESTART_OUTPUT_PARENT:-}
base=${RESTART_SOURCE_SHA:?pin the clean fixture checkout}
observer_repo=${RESTART_OBSERVER_REPO:?pin the private observer checkout}
observer_sha=${RESTART_OBSERVER_SHA:?pin its diagnostic commit}
[[ $package == "$source_repo/scripts/e2e/desktop-observations" ]] || { printf 'driver must run from pinned fixture checkout\n' >&2; exit 3; }
[[ -n $source_repo && -n $output_parent && -n ${CHAN_BIN:-} && -n ${CHAN_DESKTOP_BIN:-} ]] || { printf 'source, output and binary paths required\n' >&2; exit 3; }
[[ -z ${OBS_SHA:-} || $OBS_SHA == "$base" ]] || { printf 'observation source identity mismatch\n' >&2; exit 3; }
[[ $source_repo == /* && $output_parent == /* && ! -e $output_parent && ! -L $output_parent ]] || { printf 'source/output paths must be absolute and output fresh\n' >&2; exit 3; }
source_head=$(git -C "$source_repo" rev-parse HEAD) || { printf 'source checkout HEAD read failed\n' >&2; exit 3; }
source_status=$(git -C "$source_repo" status --porcelain) || { printf 'source checkout status read failed\n' >&2; exit 3; }
[[ $source_head == "$base" && -z $source_status ]] || { printf 'source checkout is not clean at the pinned candidate\n' >&2; exit 3; }
[[ $CHAN_BIN == /* && $CHAN_DESKTOP_BIN == /* ]] || { printf 'absolute binary paths required\n' >&2; exit 3; }
[[ ${RESTART_CLI_SHA256:-} =~ ^[0-9a-f]{64}$ && ${RESTART_NATIVE_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || { printf 'binary hash pins required\n' >&2; exit 3; }
[[ $(sha256sum "$CHAN_BIN" | cut -d' ' -f1) == "$RESTART_CLI_SHA256" && $(sha256sum "$CHAN_DESKTOP_BIN" | cut -d' ' -f1) == "$RESTART_NATIVE_SHA256" ]] || { printf 'binary hash pin mismatch\n' >&2; exit 3; }
cli_version=$("$CHAN_BIN" --version)
native_version=$("$CHAN_DESKTOP_BIN" --version)
[[ $cli_version != *-dirty* && $native_version != *-dirty* ]] || { printf 'dirty binary stamp refused\n' >&2; exit 3; }
[[ $cli_version == *"git-${observer_sha:0:9}"* && $native_version == *"git-${observer_sha:0:9}"* ]] || { printf 'CLI source identity mismatch\n' >&2; exit 3; }
mkdir "$output_parent"
chmod 700 "$output_parent"
[[ $(git -C "$observer_repo" rev-parse HEAD) == "$observer_sha" && -z $(git -C "$observer_repo" status --porcelain) ]] || { printf 'observer checkout identity mismatch\n' >&2; exit 3; }
sha256sum "$package"/restart-* "$source_repo/scripts/e2e/desktop-observations/lib.sh" > "$output_parent/fixture.sha256"
printf '%s\n' "$base" "$observer_sha" > "$output_parent/source-commits"
sha256sum "$CHAN_BIN" "$CHAN_DESKTOP_BIN" > "$output_parent/binaries.sha256"

# lib.sh provides the disposable home, Xvfb/openbox and native process fixture.
# Its obs_setup resets CHAN_* except the binaries, so publish the label path later.
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
source "$source_repo/scripts/e2e/desktop-observations/lib.sh"
TMPDIR="$output_parent"
export TMPDIR
obs_setup "restart-$arm"
obs_need python3 sha256sum setsid timeout pgrep node
private="$OBS_WORK/private"
((${#private} + 10 < 108)) || obs_inconclusive 'output path too long for gate socket; use a shorter parent'
mkdir "$private"
chmod 700 "$private"
export CHAN_RESTART_LABEL_FILE="$private/selected-label"
[[ ! -e $CHAN_RESTART_LABEL_FILE && ! -L $CHAN_RESTART_LABEL_FILE ]] || obs_inconclusive 'selected label file already exists'
feed_pid='' row_pid='' server_group='' server_owner='' server_pid=''

stop_group() {
    local group=$1 owner=$2
    [[ -n $group ]] || return 0
    kill -s TERM -- "-$group" 2>/dev/null || true
    sleep 0.3
    kill -s KILL -- "-$group" 2>/dev/null || true
    [[ -z $owner ]] || wait "$owner" 2>/dev/null || true
}
restart_on_exit() {
    local status=$?
    trap - EXIT ERR
    set +e
    if [[ ! -e $OBS_WORK/summary.json ]]; then
        printf '{"arm":"%s","run_kind":"%s","outcome":"inconclusive","reason":"driver-or-prerequisite-exit","status":3}\n' "$arm" "$run_kind" > "$OBS_WORK/summary.json"
    fi
    for pid in "$feed_pid" "$row_pid"; do
        [[ -z $pid ]] || { kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; }
    done
    stop_group "$server_group" "$server_owner"
    (exit "$status")
    obs_on_exit
}
trap restart_on_exit EXIT
trap 'exit 3' TERM INT

narrow() {
    local reason=$1 outcome=${2:-inconclusive}
    printf '{"arm":"%s","run_kind":"%s","outcome":"%s","reason":"%s","status":3}\n' "$arm" "$run_kind" "$outcome" "$reason" > "$OBS_WORK/summary.json"
    obs_inconclusive "$reason"
}
clock_sample() {
    python3 - "$private/clock.jsonl" "$1" <<'PY'
import json, sys, time
with open(sys.argv[1], 'a') as out:
    out.write(json.dumps({'stage': sys.argv[2], 'wall_ns': time.time_ns(), 'mono_ns': time.monotonic_ns()}) + '\n')
PY
}
api() {
    local method=$1 path=$2 out=$3 body=${4:-} status
    if [[ -n $body ]]; then
        status=$(curl -sS -m 10 -X "$method" -H @"$private/auth" -H 'Content-Type: application/json' --data "$body" -o "$out" -w '%{http_code}' "$base_url$path")
    else
        status=$(curl -sS -m 10 -X "$method" -H @"$private/auth" -o "$out" -w '%{http_code}' "$base_url$path")
    fi
    printf '%s\n' "$status" > "$out.status"
}
require_http() { [[ $(<"$1.status") == "$2" ]] || narrow "http-$3-unexpected"; }
exposure_ready() {
    python3 "$package/restart-observer.py" events --pin "$private/pin.json" --desktop-log "$OBS_WORK/desktop.log" --output "$private/native-events.probe.jsonl" || return 1
    python3 "$package/restart-evidence.py" exposed --pin "$private/pin.json" --rows "$private/rows.selected.jsonl" --feed "$private/feed.raw" --events "$private/native-events.probe.jsonl"
}
# The admission mode releases on a proved refusal. It also releases on a
# set published inside the hold, the fault it exists to find, so that the
# verdict names it and the arm does not end on a wait.
hold_observed() {
    python3 "$package/restart-observer.py" events --pin "$private/pin.json" --desktop-log "$OBS_WORK/desktop.log" \
        --output "$private/native-events.probe.jsonl" --feed-output "$private/native-feed.probe.jsonl" || return 1
    python3 "$package/restart-evidence.py" refused --rows "$private/rows.selected.jsonl" --feed "$private/feed.raw" \
        --native-feed "$private/native-feed.probe.jsonl" --gate "$private/new.log" && return 0
    python3 "$package/restart-evidence.py" exposed --pin "$private/pin.json" --rows "$private/rows.selected.jsonl" --feed "$private/feed.raw" --events "$private/native-events.probe.jsonl"
}
page_ready() {
    node "$source_repo/scripts/e2e/desktop-observations/inspect.mjs" "$WEBKIT_INSPECTOR_HTTP_SERVER" eval "w=$window_id&" \
        '({ready: document.readyState === "complete" && !!document.querySelector(".cm-editor"), text: document.querySelector(".cm-content")?.textContent ?? ""})' > "$private/page.probe.json" 2> "$private/page.probe.log" || return 1
    python3 - "$private/page.probe.json" <<'INNER'
import json, sys
page = json.load(open(sys.argv[1]))
sys.exit(0 if page.get("ready") and "restart-fixture-ready" in page.get("text", "") else 1)
INNER
}
# start_server LABEL SECONDS COMMAND...: SECONDS is how long the server may
# live before its own timeout ends it, whatever becomes of this driver.
start_server() {
    local label=$1 lifetime=$2; shift 2
    local pidfile="$private/$label.pgid"
    CHAN_HOME="$dev_home" setsid --fork --wait sh -c '
        printf "%s\n" "$$" > "$1"
        lifetime=$2
        shift 2
        exec timeout --signal=TERM --kill-after=5 "$lifetime" "$@"
    ' _ "$pidfile" "$lifetime" "$@" > "$private/$label.log" 2>&1 &
    server_owner=$!
    obs_wait 10 "$label process group" test -s "$pidfile"
    server_group=$(<"$pidfile")
    [[ $server_group =~ ^[0-9]+$ && $(ps -o pgid= -p "$server_group" | tr -d ' ') == "$server_group" ]] || narrow 'server-group-invalid'
    if [[ $label == new && $arm == *-delayed ]]; then
        obs_wait 10 'restore gate arrival' grep -q 'RESTART_GATE arrived' "$private/$label.log"
        obs_wait 10 'management during restore gate' curl -fsS -m 2 -H @"$private/auth" "$base_url/api/devserver/workspaces"
    else
        obs_wait 60 "$label listener" grep -q 'listening on http://' "$private/$label.log"
    fi
    obs_wait 10 "$label exact server PID" python3 "$package/restart-evidence.py" server-pid --group "$server_group" --binary "$CHAN_BIN"
    server_pid=$(python3 "$package/restart-evidence.py" server-pid --group "$server_group" --binary "$CHAN_BIN")
    printf '%s\n' "$server_pid" > "$private/$label.pid"
}
server_gone() {
    local state
    state=$(ps -o stat= -p "$server_pid" 2>/dev/null || true)
    [[ -z $state || $state == Z* ]]
}
stop_old_server() {
    local signal=$1
    kill -s "$signal" "$server_pid" || narrow 'old-server-signal-failed'
    obs_wait 30 'named old server exit' server_gone
    wait "$server_owner" 2>/dev/null || true
    pgrep -g "$server_group" >/dev/null 2>&1 && narrow 'old-server-group-still-live'
    server_group='' server_owner='' server_pid=''
}
connected() {
    timeout --signal=TERM --kill-after=2 5 "$CHAN_BIN" devserver ls --json 2>/dev/null | python3 -c '
import json, sys
rows=json.load(sys.stdin)["devservers"]
sys.exit(0 if any(row.get("label")=="lab" and row.get("status")=="connected" for row in rows) else 1)'
}
native_windows() { obs_x_windows | awk -v base=" $baseline_ids " 'index(base, " " $1 " ") == 0' | sort; }
native_count() { [[ $(native_windows | wc -l) -eq $1 ]]; }
capture_x() { obs_x_windows > "$private/$1.x"; }
checkpoint() {
    local stage=$1 expected=$2
    local -a page_args=()
    [[ ${3:-0} != 1 ]] || page_args+=(--page-ready)
    python3 "$package/restart-observer.py" checkpoint --pin "$private/pin.json" --stage "$stage" \
        --terminal-xid "$terminal_xid" --display-xid "$display_xid" --output "$private/checkpoints.jsonl" "${page_args[@]}"
    python3 "$package/restart-evidence.py" check-checkpoint --checkpoints "$private/checkpoints.jsonl" \
        --stage "$stage" --selected "$expected" || narrow "$stage-checkpoint-failed"
}
selected_gone() { ! xdotool getwindowname "$selected_xid" >/dev/null 2>&1; }
terminal_ready() {
    api GET /api/library/windows "$private/probe-terminal.json" || return 1
    [[ $(<"$private/probe-terminal.json.status") == 200 ]] || return 1
    python3 - "$private/probe-terminal.json" <<'PY'
import json, sys
rows=json.load(open(sys.argv[1]))
good=[r for r in rows if r.get('kind')=='terminal' and r.get('connected') is True and len(r.get('holders') or [])==1]
sys.exit(0 if len(good)==1 else 1)
PY
}
selected_ready() {
    api GET /api/library/windows "$private/probe-selected.json" || return 1
    [[ $(<"$private/probe-selected.json.status") == 200 ]] || return 1
    python3 - "$private/probe-selected.json" "$workspace" <<'PY'
import json, sys
rows=json.load(open(sys.argv[1]))
good=[r for r in rows if r.get('workspace_path')==sys.argv[2] and r.get('connected') is True and len(r.get('holders') or [])==1]
sys.exit(0 if len(good)==1 else 1)
PY
}
row_ready() {
    api GET /api/devserver/workspaces "$private/probe-row.json" || return 1
    [[ $(<"$private/probe-row.json.status") == 200 ]] || return 1
    python3 - "$private/probe-row.json" "$workspace" <<'PY'
import json, sys
rows=json.load(open(sys.argv[1]))
good=[r for r in rows if r.get('path')==sys.argv[2] and r.get('status')=='running' and r.get('on') is True and r.get('token')]
sys.exit(0 if len(good)==1 else 1)
PY
}

clock_sample before
obs_start_display
dev_home="$OBS_WORK/devserver-home"
mkdir "$dev_home"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
base_url="http://127.0.0.1:$port"
# A control arm's one server answers from here through the last restore
# read; a restart arm's old server is stopped long before 180 seconds.
old_server_seconds=180
[[ $arm != *-control ]] || old_server_seconds=600
start_server old "$old_server_seconds" "$CHAN_BIN" devserver run --service=none --bind 127.0.0.1 --port "$port"
python3 - "$dev_home/devserver/config.json" "$private/token" "$private/auth" <<'PY'
import json, sys
token=json.load(open(sys.argv[1]))['devserver_token']
open(sys.argv[2],'w').write(token+'\n')
open(sys.argv[3],'w').write('Authorization: Bearer '+token+'\n')
PY
inspector_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export WEBKIT_INSPECTOR_HTTP_SERVER="127.0.0.1:$inspector_port"
obs_start_desktop
obs_wait 60 'Desktop launcher X window' obs_x_window_titled 'Chan Desktop'
capture_x before-connect
baseline_ids=$(awk '{print $1}' "$private/before-connect.x" | tr '\n' ' ')
[[ -n $baseline_ids ]] || narrow 'no-desktop-baseline-x'
timeout --signal=TERM --kill-after=5 30 "$CHAN_BIN" devserver register "$base_url/?t=$(<"$private/token")" --name lab > "$private/register.log" 2>&1 || narrow 'register-failed'
timeout --signal=TERM --kill-after=5 30 "$CHAN_BIN" devserver connect lab > "$private/connect.log" 2>&1 || narrow 'connect-failed'
obs_wait 60 'direct devserver connection' connected
obs_wait 60 'one native terminal control' native_count 1
obs_wait 30 'terminal record and holder' terminal_ready
capture_x after-terminal
api GET /api/library/windows "$private/terminal-records.json"
require_http "$private/terminal-records.json" 200 'terminal-records'
python3 "$package/restart-evidence.py" pin-controls --before-windows "$private/before-connect.x" \
    --after-windows "$private/after-terminal.x" --records "$private/terminal-records.json" \
    --output "$private/controls.json" || narrow 'terminal-or-launcher-pin-failed'
terminal_xid=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["terminal_x_id"])' "$private/controls.json")
display_xid=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["launcher_x_id"])' "$private/controls.json")

workspace=$(mktemp -d "$OBS_WORK/ws-restart-XXXXXX")
printf '# restart-fixture-ready\n' > "$workspace/a.md"
timeout --signal=TERM --kill-after=5 45 "$CHAN_BIN" workspace serve "$workspace" --on lab > "$private/serve.log" 2>&1 || narrow 'workspace-serve-failed'
obs_wait 45 'selected management row mounted/on' row_ready
api GET /api/devserver/workspaces "$private/rows.baseline.json"
require_http "$private/rows.baseline.json" 200 'baseline-row'
python3 "$package/restart-evidence.py" pin-row --rows "$private/rows.baseline.json" --root "$workspace" --output "$private/row-pin.json" || narrow 'baseline-row-pin-failed'
capture_x before-target
awk '{print $1}' "$private/before-target.x" > "$private/before-target.ids"
body=$(python3 -c 'import json,sys;print(json.dumps({"kind":"workspace","workspace_path":sys.argv[1]}))' "$workspace")
api POST /api/library/windows "$private/mint.json" "$body"
require_http "$private/mint.json" 200 'workspace-mint'
obs_wait 60 'selected workspace native X window' native_count 2
obs_wait 30 'selected record and holder' selected_ready
capture_x after-target
api GET /api/library/windows "$private/records.baseline.json"
require_http "$private/records.baseline.json" 200 'baseline-record'
python3 "$package/restart-observer.py" pin --records "$private/records.baseline.json" --root "$workspace" \
    --unique-name "${workspace##*/}" --before-ids "$private/before-target.ids" \
    --windows "$private/after-target.x" --desktop-pid "$OBS_DESKTOP_PID" \
    --label-file "$CHAN_RESTART_LABEL_FILE" --output "$private/pin.json" || narrow 'selected-record-to-x-pin-failed'
selected_xid=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["x_id"])' "$private/pin.json")
# Open a real page before stopping the server, then use the same page probe
# after reconnect. A socket holder alone does not prove page readiness.
window_id=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["window_id"])' "$private/pin.json")
export CHAN_WINDOW_ID="$window_id" CHAN_WORKSPACE_PATH="$workspace"
find_selected_socket() {
    local sock
    while IFS= read -r sock; do
        if CHAN_CONTROL_SOCKET="$sock" timeout -k 2s 5s "$CHAN_BIN" shell pane list --window "$window_id" --json >/dev/null 2>&1; then
            export CHAN_CONTROL_SOCKET="$sock"
            return 0
        fi
    done < <(find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name 'chan-control-*.sock')
    return 1
}
obs_wait 15 'selected workspace control socket' find_selected_socket
find_selected_socket
chan shell open "$workspace/a.md" > "$private/open-note.log" 2>&1 || narrow 'baseline-open-note-failed'
obs_wait 30 'baseline real editor page' page_ready

if [[ $arm == *-control ]]; then
    checkpoint pre-action shown
    python3 "$package/restart-feed.py" 127.0.0.1 "$port" "$private/token" 180 "$private/capture.stop" > "$private/feed.raw" 2>&1 &
    feed_pid=$!
    obs_wait 15 'validated control feed upgrade' grep -q 'valid=1' "$private/feed.raw"
    python3 - "$private/action.json" <<'PY'
import json,sys,time
open(sys.argv[1],'x').write(json.dumps({'at_ns':time.time_ns()})+'\n')
PY
    if [[ $arm == off-control ]]; then
        prefix=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["prefix"])' "$private/row-pin.json")
        api POST "/api/devserver/workspaces${prefix}/on" "$private/action-response.json" '{"on":false}'
        require_http "$private/action-response.json" 200 'workspace-off'
    else
        api DELETE "/api/library/windows/$window_id" "$private/action-response.json"
        require_http "$private/action-response.json" 204 'window-discard'
    fi
    for _ in $(seq 1 150); do selected_gone && break; sleep 0.2; done
    checkpoint after-action any
else
    checkpoint pre-stop shown
    case "$arm" in graceful-*) signal=TERM ;; kill-*) signal=KILL ;; esac
    stop_old_server "$signal"
    checkpoint after-stop any
    python3 "$package/restart-evidence.py" check-checkpoint --checkpoints "$private/checkpoints.jsonl" --stage after-stop --selected shown || narrow 'selected-x-lost-before-restart' 'stop-loss'
    capture_seconds=180
    python3 "$package/restart-feed.py" 127.0.0.1 "$port" "$private/token" "$capture_seconds" "$private/capture.stop" > "$private/feed.raw" 2>&1 &
    feed_pid=$!
    python3 "$package/restart-rows.py" "$port" "$private/token" "$workspace" "$capture_seconds" \
        "$private/rows.selected.jsonl" "$private/rows.raw.jsonl" "$private/capture.stop" > "$private/row-recorder.log" 2>&1 &
    row_pid=$!
    if [[ $arm == *-delayed ]]; then
        python3 - "$private/gate.nonce" <<'INNER'
from pathlib import Path
import secrets, sys
Path(sys.argv[1]).write_text(secrets.token_hex(16))
INNER
        start_server new 180 env CHAN_RESTART_GATE_SOCKET="$private/gate.sock" CHAN_RESTART_GATE_NONCE="$(<"$private/gate.nonce")" \
            "$CHAN_BIN" devserver run --service=none --bind 127.0.0.1 --port "$port"
        if [[ $mode == admission ]]; then
            obs_wait 20 'Starting row, refused feed and declined native round' hold_observed
        else
            obs_wait 20 'Starting row, validated omission and consumed native pass' exposure_ready
        fi
        checkpoint held any
        python3 "$package/restart-evidence.py" release-gate --socket "$private/gate.sock" --nonce-file "$private/gate.nonce" || narrow 'gate-release-failed'
        obs_wait 2 'restore gate release recorded' grep -q 'RESTART_GATE released' "$private/new.log"
    else
        start_server new 180 "$CHAN_BIN" devserver run --service=none --bind 127.0.0.1 --port "$port"
    fi
    obs_wait 15 'validated restarted direct feed upgrade' grep -q 'valid=1' "$private/feed.raw"
    checkpoint first-feed any
    reconnect_deadline=$((SECONDS + 120))
    obs_wait 120 'selected restored running row' row_ready
    checkpoint mounted any
    reconnect_seconds_left=$((reconnect_deadline - SECONDS))
    ((reconnect_seconds_left > 0)) || narrow 'restore-reconnect-bound-exceeded'
    obs_wait "$reconnect_seconds_left" 'Desktop direct reconnect' connected
    reconnect_seconds_left=$((reconnect_deadline - SECONDS))
    ((reconnect_seconds_left > 0)) || narrow 'restore-reconnect-bound-exceeded'
    page_returned=0
    while ((SECONDS < reconnect_deadline)); do
        if page_ready && ((SECONDS <= reconnect_deadline)); then page_returned=1; break; fi
        sleep 0.2
    done
    # Page readiness proves survival. Its failure must not hide a closure
    # whose consumed pass and native destroy are already in the evidence.
    checkpoint reconnect any "$page_returned"
fi

touch "$private/capture.stop"
feed_status=0
wait "$feed_pid" || feed_status=$?
feed_pid=
printf '%s\n' "$feed_status" > "$private/feed.status"
[[ $feed_status == 0 ]] || narrow 'validated-feed-recorder-failed'
if [[ -n $row_pid ]]; then
    row_status=0
    wait "$row_pid" || row_status=$?
    row_pid=
    printf '%s\n' "$row_status" > "$private/row-recorder.status"
    [[ $row_status == 0 ]] || narrow 'management-row-recorder-failed'
fi
api GET /api/library/windows "$private/records.after.json"
require_http "$private/records.after.json" 200 'after-records'
api GET /api/devserver/workspaces "$private/rows.after.json"
require_http "$private/rows.after.json" 200 'after-rows'
if [[ $arm == off-control ]]; then
    api POST "/api/devserver/workspaces${prefix}/on" "$private/restore-response.json" '{"on":true}'
    require_http "$private/restore-response.json" 200 'workspace-back-on'
    obs_wait 45 'same workspace restored running' row_ready
    obs_wait 30 'selected record restored with holder' selected_ready
    api GET /api/library/windows "$private/records.restored.json"
    require_http "$private/records.restored.json" 200 'restored-records'
    api GET /api/devserver/workspaces "$private/rows.restored.json"
    require_http "$private/rows.restored.json" 200 'restored-rows'
fi
capture_x final
python3 "$package/restart-observer.py" events --pin "$private/pin.json" --desktop-log "$OBS_WORK/desktop.log" \
    --output "$private/native-events.jsonl" --feed-output "$private/native-feed.jsonl" || narrow 'native-event-export-failed'
clock_sample after
[[ $(git -C "$source_repo" rev-parse HEAD) == "$base" && -z $(git -C "$source_repo" status --porcelain) ]] || narrow 'source-changed-during-arm'
[[ $(git -C "$observer_repo" rev-parse HEAD) == "$observer_sha" && -z $(git -C "$observer_repo" status --porcelain) ]] || narrow 'observer-changed-during-arm'
sha256sum -c "$output_parent/fixture.sha256" > "$private/fixture.after.log" || narrow 'fixture-changed-during-arm'
sha256sum -c "$output_parent/binaries.sha256" > "$private/binaries.after.log" || narrow 'binary-changed-during-arm'
verdict_args=(--arm "$arm" --run-kind "$run_kind" --pin "$private/pin.json" --controls "$private/controls.json" \
    --checkpoints "$private/checkpoints.jsonl" --events "$private/native-events.jsonl" \
    --feed "$private/feed.raw" --clock "$private/clock.jsonl" \
    --after-records "$private/records.after.json" --after-rows "$private/rows.after.json" \
    --final-windows "$private/final.x" \
    --output "$OBS_WORK/summary.json")
[[ $arm == *-control ]] && verdict_args+=(--action "$private/action.json")
[[ $arm == off-control ]] && verdict_args+=(--restored-records "$private/records.restored.json" --restored-rows "$private/rows.restored.json")
[[ $arm == *-fast || $arm == *-delayed ]] && verdict_args+=(--rows "$private/rows.selected.jsonl")
[[ $arm != *-delayed ]] || verdict_args+=(--gate "$private/new.log" --mode "$mode")
[[ $arm != *-delayed || $mode != admission ]] || verdict_args+=(--native-feed "$private/native-feed.jsonl")
verdict_status=0
python3 "$package/restart-evidence.py" verdict "${verdict_args[@]}" || verdict_status=$?
obs_verdict
case "$verdict_status" in
0) obs_log "arm result: $(<"$OBS_WORK/summary.json")"; exit 0 ;;
10) obs_fault "observed restart native startup closure; summary $OBS_WORK/summary.json" ;;
11) obs_fault "observed a window set published inside the restore hold; summary $OBS_WORK/summary.json" ;;
3) obs_inconclusive "narrow restart result; summary $OBS_WORK/summary.json" ;;
*) obs_inconclusive "restart reader failed with status $verdict_status" ;;
esac
