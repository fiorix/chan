#!/usr/bin/env bash
# Read the first native frame after a WebKitGTK window has been hidden, and
# after a separately labelled synthetic stop of its WebKit web process.
# Run only in a disposable desktop guest. The output retains private fixture
# files, so share verdicts and selected PNGs, not the whole work directory.
# Exit 0 if all four readings present, 1 if any first frame is blank, 3 if a
# precondition or instrument is inconclusive, 2 if prerequisites are absent.
# shellcheck disable=SC2329
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
source "$here/lib.sh"
obs_setup wake-present
obs_need node convert xsetroot timeout sha256sum dpkg-query pgrep comm
export WEBKIT_INSPECTOR_HTTP_SERVER="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
sha256sum "$here/wake-present.sh" "$here/../wake-pixels.py" "$here/lib.sh" > "$OBS_WORK/instrument.sha256"
dpkg-query -W libwebkit2gtk-4.1-0 > "$OBS_WORK/webkit-version.txt" || obs_inconclusive 'WebKitGTK package version unavailable'
frozen_pid=''
on_exit() {
    local rc=$?
    trap - EXIT
    if [[ -n $frozen_pid ]]; then kill -CONT "$frozen_pid" 2>/dev/null || true; fi
    set +e
    (exit "$rc")
    obs_on_exit
}
trap on_exit EXIT

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
inspect() { node "$here/inspect.mjs" "$WEBKIT_INSPECTOR_HTTP_SERVER" "$@"; }
web_pids() {
    pgrep -P "$OBS_DESKTOP_PID" -f WebKitWebProcess | sort -n || true
}
window_for() { obs_x_window_titled "$1"; }
# A remote window's native title uses the devserver label and the workspace
# basename, while its minted record keeps the absolute workspace path.
dev_window() {
    local -a ids=()
    mapfile -t ids < <(obs_x_windows | awk -v fragment="/ $(basename "$dev_ws") Window" 'index($0, fragment) { print $1 }')
    [[ ${#ids[@]} == 1 ]] || return 1
    printf '%s\n' "${ids[0]}"
}
desktop_window() {
    local xid
    while read -r xid; do
        if xprop -id "$xid" WM_CLASS 2>/dev/null | grep -qF '"chan-desktop", "Chan-desktop"'; then
            printf '%s\n' "$xid"
            return 0
        fi
    done < <(obs_x_windows | cut -d' ' -f1)
    return 1
}
page_ready() { inspect eval "$1" 'document.readyState' 2>/dev/null | grep -qx '"complete"'; }
page_state() { inspect eval "$1" 'JSON.stringify({url:location.origin+location.pathname,visibility:document.visibilityState,tabs:document.querySelectorAll("[role=tab]").length,tab:document.querySelector("[role=tab][aria-selected=true]")?.textContent})' 2>/dev/null; }
pixel_status() {
    local dir=$1 label=$2
    python3 "$here/../wake-pixels.py" --baseline "$dir/before.png" --blank "$dir/blank-control.png" --candidate "$dir/$label.png" --output "$dir/$label.json" || return $?
}
geometry() {
    local xid=$1 out=$2
    xdotool getwindowgeometry --shell "$xid" > "$out"
    # The values returned by xdotool are decimal assignments only.
    [[ $(sed -n 's/^X=//p' "$out") =~ ^[0-9]+$ && $(sed -n 's/^Y=//p' "$out") =~ ^[0-9]+$ ]]
}
capture() {
    local dir=$1 label=$2 raw
    raw=$dir/$label-root.png
    date +%s%3N > "$dir/$label.at-ms"
    import -window root "$raw" 2>> "$dir/import.log"
    convert "$raw" -crop "$crop" +repage "$dir/$label.png"
}
blank_control() {
    local dir=$1 rc=0
    pixel_status "$dir" blank-control > "$dir/blank-control.reader" || rc=$?
    [[ $rc == 10 ]]
}
hidden_state() {
    local xid=$1 title=$2 state
    if xdotool search --onlyvisible --name '.' 2>/dev/null | grep -qx "$xid"; then return 1; fi
    state=$(inspect eval "$title" 'document.visibilityState' 2>/dev/null) || return 1
    [[ $state == '"hidden"' ]]
}
freeze_state() { [[ $(sed -n 's/^State:[[:space:]]*\([A-Z]\).*/\1/p' "/proc/$1/status" 2>/dev/null) == T ]]; }
one_process_for() {
    local kind=$1 before=$2 after=$3 result
    result="$OBS_WORK/$kind-new-web-processes.txt"
    comm -13 <(sort -n "$before") <(sort -n "$after") > "$result"
    [[ $(wc -l < "$result") == 1 ]] || return 1
    cat "$result"
}
recover() {
    local dir=$1 xid=$2 title=$3 step rc
    for step in click tab resize hide-show reload; do
        case "$step" in
            click) xdotool mousemove --window "$xid" 40 75 click 1 ;;
            tab) xdotool key --window "$xid" ctrl+shift+bracketright ;;
            resize) xdotool windowsize "$xid" "$((width + 1))" "$height"; xdotool windowsize "$xid" "$width" "$height" ;;
            hide-show) xdotool windowminimize "$xid"; xdotool windowactivate --sync "$xid" ;;
            reload) xdotool key --window "$xid" ctrl+shift+r ;;
        esac
        sleep 0.4
        capture "$dir" "recovery-$step"
        rc=0
        pixel_status "$dir" "recovery-$step" > "$dir/recovery-$step.reader" || rc=$?
        page_state "$title" > "$dir/recovery-$step.page" || true
        if [[ $rc == 0 ]]; then printf '%s\n' "$step" > "$dir/first-recovery.txt"; return; fi
    done
    printf '%s\n' none > "$dir/first-recovery.txt"
}

obs_start_display
xsetroot -solid '#ff00ff'
obs_start_desktop
obs_wait 60 'first visible chan-desktop X window' desktop_window

local_ws="$OBS_WORK/local-workspace"
mkdir "$local_ws"
web_pids > "$OBS_WORK/local-before.pids"
timeout 45 "$CHAN_BIN" serve "$local_ws" > "$OBS_WORK/local-serve.log" 2>&1 || obs_inconclusive 'local workspace serve failed'
obs_wait 60 'local workspace X window' window_for "$local_ws"
obs_wait 60 'local workspace page' page_ready '/workspace-'
local_id=$(inspect eval '/workspace-' "new URLSearchParams(location.search).get('w')" | tr -d '"')
[[ -n $local_id ]] || obs_inconclusive 'local window has no page window ID'
local_page="w=$local_id&"
web_pids > "$OBS_WORK/local-after.pids"

dev_home="$OBS_WORK/devserver-home"
dev_ws="$OBS_WORK/dev-workspace"
mkdir "$dev_home" "$dev_ws"
port=$(free_port)
CHAN_HOME="$dev_home" "$CHAN_BIN" devserver run --service=none --bind 127.0.0.1 --port "$port" > "$OBS_WORK/devserver.log" 2>&1 &
OBS_PIDS+=("$!")
obs_wait 60 'fixture devserver listener' grep -q 'listening on http://' "$OBS_WORK/devserver.log"
python3 - "$dev_home/devserver/config.json" "$OBS_WORK/devserver.token" "$OBS_WORK/token-header" <<'PY'
import json, sys
token = json.load(open(sys.argv[1]))['devserver_token']
with open(sys.argv[2], 'w') as token_file:
    token_file.write(token + '\n')
with open(sys.argv[3], 'w') as header:
    header.write('Authorization: Bearer ' + token + '\n')
PY
timeout 30 "$CHAN_BIN" devserver register "http://127.0.0.1:$port/?t=$(< "$OBS_WORK/devserver.token")" --name wake-present 2>&1 | obs_masked > "$OBS_WORK/register.log" || obs_inconclusive 'devserver registration failed'
timeout 30 "$CHAN_BIN" devserver connect wake-present > "$OBS_WORK/connect.log" 2>&1 || obs_inconclusive 'devserver connect failed'
connected() { "$CHAN_BIN" devserver ls --json 2>/dev/null | python3 -c 'import json,sys; s=json.load(sys.stdin)["devservers"]; sys.exit(0 if any(r.get("label")=="wake-present" and r.get("status")=="connected" for r in s) else 1)'; }
obs_wait 60 'devserver connected' connected
web_pids > "$OBS_WORK/dev-before.pids"
timeout 45 "$CHAN_BIN" workspace serve "$dev_ws" --on wake-present > "$OBS_WORK/dev-serve.log" 2>&1 || obs_inconclusive 'devserver workspace serve failed'
body=$(python3 -c 'import json,sys; print(json.dumps({"kind":"workspace","workspace_path":sys.argv[1]}))' "$dev_ws")
status=$(curl -sS -m 20 -X POST -H @"$OBS_WORK/token-header" -H 'Content-Type: application/json' --data "$body" -o "$OBS_WORK/mint.json" -w '%{http_code}' "http://127.0.0.1:$port/api/library/windows") || obs_inconclusive 'devserver window mint transport failed'
[[ $status == 200 ]] || obs_inconclusive "devserver window mint returned $status"
obs_wait 60 'devserver workspace X window' dev_window
dev_id=$(python3 - "$OBS_WORK/mint.json" <<'PY'
import json, sys
row = json.load(open(sys.argv[1]))
print(row.get('window_id') or row.get('window', {}).get('window_id') or '')
PY
)
[[ -n $dev_id ]] || obs_inconclusive 'devserver mint has no window ID'
dev_page="w=$dev_id&"
obs_wait 60 'devserver workspace page' page_ready "$dev_page"
web_pids > "$OBS_WORK/dev-after.pids"

overall=0
run_arm() {
    local kind=$1 mode=$2 xid=$3 title=$4 new_pid=$5 dir rc=0 first=0 later=0 other
    dir="$OBS_WORK/shots/$kind-$mode"
    mkdir "$dir"
    if [[ $mode == synthetic-freeze && -z $new_pid ]]; then
        obs_log "INCONCLUSIVE precondition linux $kind $mode: no unambiguous new WebKitWebProcess child"
        return 3
    fi
    while read -r other; do
        [[ -n $other && $other != "$xid" ]] && xdotool windowminimize "$other" || true
    done < <(obs_x_windows | cut -d' ' -f1)
    timeout 15 xdotool windowactivate --sync "$xid"
    xdotool windowmove "$xid" 100 100
    xdotool windowsize "$xid" 900 650
    xdotool key --window "$xid" ctrl+shift+t
    sleep 0.5
    geometry "$xid" "$dir/before.geometry" || return 3
    x=$(sed -n 's/^X=//p' "$dir/before.geometry"); y=$(sed -n 's/^Y=//p' "$dir/before.geometry")
    width=$(sed -n 's/^WIDTH=//p' "$dir/before.geometry"); height=$(sed -n 's/^HEIGHT=//p' "$dir/before.geometry")
    [[ $width -ge 600 && $height -ge 300 ]] || return 3
    crop="420x70+$((x + 40))+$((y + 60))"
    page_state "$title" > "$dir/before.page" || return 3
    capture "$dir" before
    xdotool windowminimize "$xid"
    for _ in $(seq 1 10); do
        if hidden_state "$xid" "$title"; then break; fi
        sleep 0.2
    done
    if ! hidden_state "$xid" "$title"; then
        xdotool windowunmap "$xid"
        if ! hidden_state "$xid" "$title"; then
            obs_log "INCONCLUSIVE precondition linux $kind $mode: view not hidden after iconify/unmap"
            xdotool windowmap "$xid" || true
            return 3
        fi
        printf '%s\n' unmap > "$dir/trigger"
    else
        printf '%s\n' iconify > "$dir/trigger"
    fi
    capture "$dir" blank-control
    if ! blank_control "$dir"; then
        obs_log "INCONCLUSIVE precondition linux $kind $mode: blank control did not fail the pixel threshold"
        xdotool windowmap "$xid" || true
        return 3
    fi
    if [[ $mode == synthetic-freeze ]]; then
        kill -STOP "$new_pid" || return 3
        frozen_pid=$new_pid
    fi
    for _ in $(seq 1 24); do
        sleep 5
        if xdotool search --onlyvisible --name '.' 2>/dev/null | grep -qx "$xid"; then rc=3; fi
        if [[ $mode == synthetic-freeze ]] && ! freeze_state "$new_pid"; then rc=3; fi
    done
    if [[ $mode == synthetic-freeze ]]; then kill -CONT "$new_pid"; frozen_pid=''; hidden_state "$xid" "$title" || rc=3; fi
    if [[ $mode == hidden ]]; then hidden_state "$xid" "$title" || rc=3; fi
    if [[ $rc == 3 ]]; then
        obs_log "INCONCLUSIVE precondition linux $kind $mode: hidden or stopped state was lost during dwell"
        xdotool windowmap "$xid" || true
        return 3
    fi
    if [[ $(< "$dir/trigger") == unmap ]]; then xdotool windowmap "$xid"; fi
    timeout 15 xdotool windowactivate --sync "$xid"
    capture "$dir" first-after
    sleep 2
    capture "$dir" after-2s
    geometry "$xid" "$dir/after.geometry" || return 3
    cmp -s "$dir/before.geometry" "$dir/after.geometry" || {
        obs_log "INCONCLUSIVE precondition linux $kind $mode: X window geometry changed"
        return 3
    }
    pixel_status "$dir" first-after > "$dir/first-after.reader" || first=$?
    pixel_status "$dir" after-2s > "$dir/after-2s.reader" || later=$?
    page_state "$title" > "$dir/after.page" || true
    if [[ $first == 0 && $later == 0 ]]; then
        obs_log "PASS presented linux $kind $mode: first and 2s frames match; PNGs $dir"
        return 0
    fi
    if [[ $first == 10 || $later == 10 ]]; then
        if [[ $later == 0 ]]; then printf '%s\n' automatic-by-2s > "$dir/first-recovery.txt"; else recover "$dir" "$xid" "$title"; fi
        obs_log "FAIL blank linux $kind $mode: first=$first after-2s=$later recovery=$(< "$dir/first-recovery.txt"); PNGs $dir"
        return 1
    fi
    obs_log "INCONCLUSIVE precondition linux $kind $mode: pixel reader first=$first after-2s=$later"
    return 3
}
local_pid=$(one_process_for local "$OBS_WORK/local-before.pids" "$OBS_WORK/local-after.pids") || local_pid=''
dev_pid=$(one_process_for dev "$OBS_WORK/dev-before.pids" "$OBS_WORK/dev-after.pids") || dev_pid=''
# Both selectors enumerate only visible X windows. Keep their XIDs before an
# arm minimizes every other window; the IDs survive iconify and restore.
local_xid=$(window_for "$local_ws") || obs_inconclusive 'lost local X window before arms'
dev_xid=$(dev_window) || obs_inconclusive 'lost devserver X window before arms'
for kind in local devserver; do
    if [[ $kind == local ]]; then
        title=$local_page; pid=$local_pid; xid=$local_xid
    else
        title=$dev_page; pid=$dev_pid; xid=$dev_xid
    fi
    for mode in hidden synthetic-freeze; do
        arm_rc=0
        run_arm "$kind" "$mode" "$xid" "$title" "$pid" || arm_rc=$?
        if [[ $arm_rc == 3 ]]; then obs_log "INCONCLUSIVE precondition linux $kind $mode: arm could not finish; work dir $OBS_WORK/shots/$kind-$mode"; fi
        if [[ $arm_rc == 1 ]]; then overall=1; elif [[ $arm_rc != 0 && $overall == 0 ]]; then overall=3; fi
    done
done
obs_log "Xvfb has no real display sleep; the synthetic stop is not WebKit's own suspension. Work dir $OBS_WORK"
obs_verdict
if [[ $overall == 1 ]]; then obs_fault 'a shown WebKitGTK window presented a blank first frame'; fi
obs_judge "$overall" 'a shown WebKitGTK window presented a blank first frame'
