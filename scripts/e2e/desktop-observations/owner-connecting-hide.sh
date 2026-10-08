#!/usr/bin/env bash
# Owner reading, run sheet row 4: a window hidden on its connecting page
# while its devserver does not answer stays hidden through a disconnect and
# a connect, and comes back as the same window when reopened. One disposable
# desktop, a fixture devserver with its own home and a generated workspace,
# on Linux WebKitGTK with the inspector.
#
# A Reload does not reach the connecting page, and a connect while the
# devserver is down builds no window: a window is on that page only while it
# is being built. So this driver disconnects, connects, and freezes the
# fixture devserver (SIGSTOP) at the line the desktop logs when it starts
# building the window; hides the window there; ends the frozen devserver and
# starts it again; and connects once more.
#
#   owner-connecting-hide.sh OUTPUT_PARENT
#
# OUTPUT_PARENT is a fresh absolute directory with a path of at most 44
# characters (a socket lives under it). CHAN_BIN and CHAN_DESKTOP_BIN
# name the binaries under test (lib.sh has the defaults). The fixture
# devserver's token stays in a private directory under the output and is
# never printed. Exit status, as lib.sh has it: 0 the hide held; 1 a fault
# was observed (the window opened by itself, its record after the reconnect
# is not one hidden window, or the reopened window is not the same shown
# one); 2 the environment cannot run this, an output path too long for the
# socket included; 3 inconclusive, which is also what an output parent that
# is relative or already exists gets, before anything starts.
# Functions passed to obs_wait are used dynamically.
# shellcheck disable=SC2329
set -euo pipefail
umask 077

output=${1:?fresh absolute output parent required}
if [[ ${2:-} != --bounded ]]; then
    bounded_status=0
    timeout --signal=TERM --kill-after=10s 300s bash "$0" "$output" --bounded || bounded_status=$?
    case "$bounded_status" in 124 | 137 | 143)
        printf 'INCONCLUSIVE: whole-run timeout\n' >&2
        exit 3
        ;;
    esac
    exit "$bounded_status"
fi
[[ $output == /* && ! -e $output && ! -L $output ]] || {
    printf 'output parent must be a fresh absolute directory\n' >&2
    exit 3
}
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$output"
# shellcheck source=/dev/null
source "$here/lib.sh"
TMPDIR="$output"
export TMPDIR
obs_setup owner-hide
obs_need node setsid timeout sha256sum
# The desktop binds its control socket in the runtime directory under the
# output, and a socket path holds at most 107 characters; with a longer one
# no socket is bound and the reopen below has nothing to speak to.
((${#XDG_RUNTIME_DIR} + 36 <= 107)) || obs_refuse "the output parent's path is too long for the control socket under it: at most 44 characters, this one has ${#output}"
sha256sum "$CHAN_BIN" "$CHAN_DESKTOP_BIN" > "$output/binaries.sha256"
{
    "$CHAN_BIN" --version
    "$CHAN_DESKTOP_BIN" --version
} > "$output/versions"
p="$OBS_WORK/private"
mkdir -m 700 "$p"
step() {
    printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$*" >> "$OBS_WORK/steps.log"
    obs_log "step: $*"
}
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
api() {
    local method=$1 path=$2 out=$3 body=${4:-} status
    if [[ -n $body ]]; then
        status=$(curl -sS -m 10 -X "$method" -H @"$p/auth" -H 'Content-Type: application/json' --data "$body" -o "$out" -w '%{http_code}' "$base_url$path") || return 1
    else
        status=$(curl -sS -m 10 -X "$method" -H @"$p/auth" -o "$out" -w '%{http_code}' "$base_url$path") || return 1
    fi
    printf '%s\n' "$status" > "$out.status"
    [[ $status == 200 ]]
}
inspect() { node "$here/inspect.mjs" "$WEBKIT_INSPECTOR_HTTP_SERVER" "$@"; }
# connecting_eval <expression>: evaluate on the selected window's connecting
# page alone. A connect builds the workspace window and its control terminal
# both on connecting pages, listed alike; the selected one is the page whose
# document names the workspace. Fails unless exactly one page answers.
connecting_eval() {
    inspect all "(() => { if (!location.pathname.endsWith('/connecting.html')) return null; if (!document.documentElement.innerHTML.includes('$name')) return null; return ($1); })()" 2> /dev/null | python3 -c '
import json, sys
values = [json.loads(line).get("value") for line in sys.stdin if line.strip()]
values = [value for value in values if value is not None]
if len(values) != 1:
    sys.exit(3)
print(json.dumps(values[0]))'
}
server_pid=''
start_server() {
    CHAN_HOME="$dev_home" "$CHAN_BIN" devserver run --service=none --bind 127.0.0.1 --port "$port" > "$p/server-$1.log" 2>&1 &
    server_pid=$!
    OBS_PIDS+=("$server_pid")
    obs_wait 60 "fixture devserver ($1) listening" grep -q 'listening on http://' "$p/server-$1.log"
}
connected() {
    timeout --signal=TERM --kill-after=2 5 "$CHAN_BIN" devserver ls --json 2> /dev/null > "$p/ls.json" || return 1
    python3 -c '
import json, sys
rows = json.load(open(sys.argv[1]))["devservers"]
sys.exit(0 if any(r.get("label") == "owner-hide" and r.get("status") == "connected" for r in rows) else 1)' "$p/ls.json"
}
not_connected() { ! connected; }
# The selected window's records, as the devserver publishes them; a record
# of a shown window carries no `hidden` field.
records() {
    api GET /api/library/windows "$p/records.$1.json" || return 1
    python3 - "$p/records.$1.json" "$workspace" "${window_id:-}" > "$OBS_WORK/records.$1.summary" << 'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
mine = [r for r in rows if r.get("workspace_path") == sys.argv[2]]
print(json.dumps({"all": len(rows), "for_workspace": len(mine), "hidden_any": sum(bool(r.get("hidden")) for r in rows),
                  "selected": [{"window_id_matches": r.get("window_id") == sys.argv[3], "hidden": bool(r.get("hidden")),
                                "connected": r.get("connected"), "holders": len(r.get("holders") or [])} for r in mine]}))
PY
    cat "$OBS_WORK/records.$1.summary"
}
record_field() { python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); r=s["selected"]; print(len(r), r[0][sys.argv[2]] if r else None)' "$OBS_WORK/records.$1.summary" "$2"; }
window_x() { obs_x_window_titled "$name"; }
window_gone() { ! window_x; }

obs_start_display
dev_home="$OBS_WORK/devserver-home"
mkdir "$dev_home"
port=$(free_port)
base_url="http://127.0.0.1:$port"
step 'start the fixture devserver with its own home'
start_server first
python3 - "$dev_home/devserver/config.json" "$p/token" "$p/auth" << 'PY'
import json, sys
token = json.load(open(sys.argv[1]))["devserver_token"]
open(sys.argv[2], "w").write(token + "\n")
open(sys.argv[3], "w").write("Authorization: Bearer " + token + "\n")
PY
WEBKIT_INSPECTOR_HTTP_SERVER="127.0.0.1:$(free_port)"
export WEBKIT_INSPECTOR_HTTP_SERVER
step 'start the disposable desktop'
obs_start_desktop
obs_wait 60 'Desktop launcher X window' obs_x_window_titled 'Chan Desktop'
step 'register and connect owner-hide'
timeout --signal=TERM --kill-after=5 30 "$CHAN_BIN" devserver register "$base_url/?t=$(< "$p/token")" --name owner-hide > "$p/register.log" 2>&1 || obs_inconclusive 'register failed'
timeout --signal=TERM --kill-after=5 30 "$CHAN_BIN" devserver connect owner-hide > "$p/connect-1.log" 2>&1 || obs_inconclusive 'connect failed'
obs_wait 60 'owner-hide connected' connected
name="ownerhide$RANDOM$RANDOM"
workspace="$OBS_WORK/$name"
python3 "$here/owner-fixtures.py" generate "$workspace" > "$p/generated.json"
step 'serve the generated workspace on owner-hide and open one window'
timeout --signal=TERM --kill-after=5 45 "$CHAN_BIN" workspace serve "$workspace" --on owner-hide > "$p/serve.log" 2>&1 || obs_inconclusive 'workspace serve failed'
body=$(python3 -c 'import json,sys;print(json.dumps({"kind":"workspace","workspace_path":sys.argv[1]}))' "$workspace")
minted() { api POST /api/library/windows "$p/mint.json" "$body"; }
obs_wait 45 'workspace window minted' minted
obs_wait 60 'selected workspace X window' window_x
window_id=''
records baseline > /dev/null || obs_inconclusive 'baseline records unreadable'
window_id=$(
    python3 - "$p/records.baseline.json" "$workspace" << 'PY'
import json, sys
mine = [r for r in json.load(open(sys.argv[1])) if r.get("workspace_path") == sys.argv[2]]
print(mine[0]["window_id"] if len(mine) == 1 else "")
PY
)
[[ -n $window_id ]] || obs_inconclusive 'not exactly one record for the workspace'
page_ready() { inspect eval "w=$window_id&" 'document.readyState' 2> /dev/null | grep -qx '"complete"'; }
obs_wait 45 'workspace page ready' page_ready
records baseline
[[ $(record_field baseline hidden) == '1 False' ]] || obs_inconclusive 'baseline record is not one shown window'
[[ $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["hidden_any"])' "$OBS_WORK/records.baseline.summary") == 0 ]] || obs_inconclusive 'a window is hidden at baseline'
obs_shot 01-baseline
step "baseline: window $window_id shown, hidden count 0"

step 'disconnect owner-hide: the sweep destroys the window, its record stays shown'
timeout --signal=TERM --kill-after=5 30 "$CHAN_BIN" devserver disconnect owner-hide > "$p/disconnect-0.log" 2>&1 || obs_inconclusive 'first disconnect failed'
obs_wait 20 'window destroyed by the sweep' window_gone
obs_wait 20 'owner-hide no longer connected' not_connected
records before-freeze
[[ $(record_field before-freeze hidden) == '1 False' ]] || obs_inconclusive 'the record is not one shown window before the freeze'
step 'connect, and freeze the devserver when the desktop starts building the window'
log_lines=$(wc -l < "$OBS_WORK/desktop.log")
(
    for _ in $(seq 1 3000); do
        if tail -n +"$((log_lines + 1))" "$OBS_WORK/desktop.log" | grep -q "build_workspace_window_with_completion.*$window_id"; then
            kill -s STOP "$server_pid"
            date +%s%N > "$p/frozen.at_ns"
            exit 0
        fi
        sleep 0.01
    done
    exit 1
) &
freezer=$!
date +%s%N > "$p/connect.at_ns"
timeout --signal=TERM --kill-after=5 30 "$CHAN_BIN" devserver connect owner-hide > "$p/connect-freeze.log" 2>&1 || obs_inconclusive 'connect before the freeze failed'
wait "$freezer" || obs_inconclusive 'the desktop never logged the build of the window after the connect'
step "devserver frozen $((($(< "$p/frozen.at_ns") - $(< "$p/connect.at_ns")) / 1000000)) ms after the connect was issued; its process state is $(awk '{print $3}' "/proc/$server_pid/stat")"
on_connecting() { connecting_eval 'document.getElementById("title")?.textContent ?? ""' > "$p/connecting.title.json" 2> /dev/null && grep -q . "$p/connecting.title.json"; }
landed=0
for _ in $(seq 1 20); do
    if on_connecting; then
        landed=1
        break
    fi
    if page_ready; then break; fi
    sleep 0.5
done
obs_shot 02-connecting
[[ $landed == 1 ]] || obs_inconclusive 'the freeze came too late: the window is not on its connecting page'
sleep 8
connecting_eval '({title: document.getElementById("title").textContent, attempt: document.getElementById("attempt").textContent, actionsHidden: document.getElementById("actions").hidden})' > "$OBS_WORK/connecting.state.json" 2>&1 || true
on_connecting || obs_inconclusive 'the window left its connecting page while the devserver was frozen'
step "on its connecting page with the devserver frozen: $(cut -c1-200 "$OBS_WORK/connecting.state.json")"
step 'hide it there, by the command its Disconnect button and its close send'
connecting_eval '(window.__TAURI__.core.invoke("request_close_window"), true)' > "$p/request-close.json" 2>&1 || obs_inconclusive 'could not send request_close_window from the selected connecting page'
obs_wait 20 'window hidden from its connecting page' window_gone
obs_shot 03-hidden
step 'hidden on the connecting page: its X window is gone; the devserver has not answered since the freeze'
step 'disconnect owner-hide in the same desktop'
timeout --signal=TERM --kill-after=5 30 "$CHAN_BIN" devserver disconnect owner-hide > "$p/disconnect.log" 2>&1 || obs_inconclusive 'devserver disconnect failed'
obs_wait 20 'owner-hide no longer connected' not_connected
kill -0 "$OBS_DESKTOP_PID" || obs_inconclusive 'the desktop process ended'
step 'end the frozen devserver (KILL) and start it again, same home and port'
kill -s KILL "$server_pid"
wait "$server_pid" 2> /dev/null || true
obs_forget_pid "$server_pid"
start_server second
records_premise() { records premise > /dev/null; }
obs_wait 60 'records readable from the restarted devserver' records_premise
records premise
[[ $(record_field premise hidden) == '1 False' ]] || obs_inconclusive "the restarted devserver does not publish the window as shown, so a hide that stays proves nothing: $(cat "$OBS_WORK/records.premise.summary")"
step 'premise: the restarted devserver still publishes the window as shown (the hide never reached it)'
timeout --signal=TERM --kill-after=5 30 "$CHAN_BIN" devserver connect owner-hide > "$p/connect-2.log" 2>&1 || obs_inconclusive 'second connect failed'
obs_wait 60 'owner-hide connected again' connected
records_ok() { records after-connect > /dev/null; }
obs_wait 30 'records readable after the reconnect' records_ok
step 'watch 30 seconds for the window to open by itself'
reopened=0
for _ in $(seq 1 30); do
    if window_x > /dev/null; then
        reopened=1
        break
    fi
    sleep 1
done
records after-connect
obs_shot 04-after-connect
kill -0 "$OBS_DESKTOP_PID" || obs_inconclusive 'the desktop process ended'
if [[ $reopened == 1 ]]; then
    obs_fault 'the window hidden on its connecting page opened by itself after the disconnect and connect'
fi
[[ $(record_field after-connect hidden) == '1 True' ]] || obs_fault "after the reconnect the record is not one hidden window: $(cat "$OBS_WORK/records.after-connect.summary")"
step 'after the reconnect: no X window, one record, hidden'

step 'reopen it once through cs window open'
find_socket() {
    local sock status
    while IFS= read -r sock; do
        status=0
        CHAN_CONTROL_SOCKET="$sock" timeout -k 2s 5s "$CHAN_BIN" shell window list --json > "$p/cs-window-list.json" 2> "$p/cs-window-list.err" < /dev/null || status=$?
        printf '%s %s status %s\n' "$(date -u +%T)" "${sock##*/}" "$status" >> "$p/cs-window-list.attempts"
        if [[ $status == 0 ]]; then
            export CHAN_CONTROL_SOCKET="$sock"
            return 0
        fi
    done < <(find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name 'chan-control-*.sock')
    return 1
}
export CHAN_WINDOW_ID="$window_id" CHAN_WORKSPACE_PATH="$workspace"
obs_wait 15 'a control socket that lists windows' find_socket
find_socket
timeout -k 2s 15s "$CHAN_BIN" shell window open "$window_id" > "$p/cs-window-open.log" 2>&1 < /dev/null || obs_inconclusive 'cs window open failed'
obs_wait 45 'the reopened X window' window_x
obs_wait 45 'the reopened workspace page' page_ready
records reopened
obs_shot 05-reopened
[[ $(record_field reopened hidden) == '1 False' && $(record_field reopened window_id_matches) == '1 True' ]] || obs_fault "after the reopen the record is not the same shown window: $(cat "$OBS_WORK/records.reopened.summary")"
step 'reopened: the same persisted id, shown, its workspace page ready'
obs_log 'the reading held on this run: hidden through the disconnect and connect, one record, reopened with the same id'
