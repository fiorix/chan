#!/usr/bin/env bash
# Read native tab activation and close actions on the real WebKitGTK desktop.
# The action probe and the DOM/session readers are independent instruments.
# shellcheck disable=SC2329
set -euo pipefail

VERBOSE=0
case "${1:-}" in
--verbose | -v) VERBOSE=1 ;;
--help | -h)
    printf 'Usage: %s [--verbose]\nRequires a built chan/chan-desktop, Xvfb, Openbox, Node, ImageMagick, D-Bus and Python GI AT-SPI. Run only in an isolated guest.\n' "$0"
    exit 0
    ;;
"") ;;
*) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup axclose
obs_need node pkg-config dbus-daemon timeout
python3 -c 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi' \
    > "$OBS_WORK/atspi-prerequisite.log" 2>&1 || obs_refuse "Python GI AT-SPI 2 is unavailable; see atspi-prerequisite.log"
WEBKIT_VERSION="$(pkg-config --modversion webkit2gtk-4.1)" || obs_refuse "pkg-config names no webkit2gtk-4.1"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"

# The server allocates its display and reports it only after binding. Testing
# an existing X socket before starting Xvfb would race another guest job.
Xvfb -displayfd 3 -screen 0 1600x1000x24 -nolisten tcp \
    3> "$OBS_WORK/display" > "$OBS_WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
OBS_PIDS+=("$XVFB_PID")
display_ready() { kill -0 "$XVFB_PID" && test -s "$OBS_WORK/display"; }
obs_wait 20 "this run's X server to allocate a display" display_ready
read -r DISPLAY_NUMBER < "$OBS_WORK/display"
[[ "$DISPLAY_NUMBER" =~ ^[0-9]+$ ]] || obs_inconclusive "Xvfb returned an invalid display number"
export DISPLAY=":$DISPLAY_NUMBER"
kill -0 "$XVFB_PID" || obs_inconclusive "the allocated X server exited"
obs_wait 20 "the allocated X display" timeout 2s xprop -root _NET_SUPPORTED
openbox > "$OBS_WORK/openbox.log" 2>&1 &
OPENBOX_PID=$!
OBS_PIDS+=("$OPENBOX_PID")
window_manager_ready() {
    kill -0 "$OPENBOX_PID" && timeout 2s xprop -root _NET_SUPPORTING_WM_CHECK | grep -Eq 'window id # 0x[0-9a-fA-F]+'
}
obs_wait 20 "the private window manager" window_manager_ready

dbus-daemon --session --fork --address="unix:path=$XDG_RUNTIME_DIR/bus" --print-pid=3 \
    3> "$OBS_WORK/bus.pid" > /dev/null || obs_inconclusive "the private session bus did not start"
OBS_PIDS+=("$(cat "$OBS_WORK/bus.pid")")
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export AXCLOSE_PRIVATE_BUS=1
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0
export CHAN_BIN
obs_start_desktop
obs_log "engine: WebKitGTK $WEBKIT_VERSION; display $DISPLAY"

WS="$OBS_WORK/ws"
mkdir -p "$WS"
PAGE="/workspace-"
page_eval() { timeout 15s node "$HERE/inspect.mjs" "$INSPECTOR" eval "$PAGE" "$1"; }
workspace_xid() { obs_x_local_window_titled "$WS"; }
timeout --signal=TERM --kill-after=5s 60s "$CHAN_BIN" serve "$WS" > "$OBS_WORK/serve.out" 2>&1 \
    || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
obs_wait 60 "the native workspace window" workspace_xid
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers
CHAN_WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w')" | tr -d '"')"
export CHAN_WINDOW_ID
[ -n "$CHAN_WINDOW_ID" ] || obs_inconclusive "the workspace page names no window id"

CHAN_CONTROL_SOCKET=""
find_socket() {
    local sock
    while IFS= read -r sock; do
        if CHAN_CONTROL_SOCKET="$sock" cs pane list --window "$CHAN_WINDOW_ID" --json >/dev/null 2>&1; then
            CHAN_CONTROL_SOCKET="$sock"
            return 0
        fi
    done < <(obs_control_sockets)
    return 1
}
obs_wait 60 "a control socket that addresses the window" find_socket
find_socket
export CHAN_CONTROL_SOCKET
XID="$(workspace_xid)"
timeout 10s xdotool windowsize --sync "$XID" 1600 1000 || obs_inconclusive "the workspace window could not be sized"
timeout 10s xdotool windowactivate --sync "$XID" || obs_inconclusive "the workspace window could not be activated"
obs_log "window $CHAN_WINDOW_ID through $(basename "$CHAN_CONTROL_SOCKET")"

CONTROLLER_ARGS=(--inspector "$INSPECTOR" --page "$PAGE" --xid "$XID" --work "$OBS_WORK" --ws "$WS" --engine "$WEBKIT_VERSION")
[ "$VERBOSE" = 0 ] || CONTROLLER_ARGS+=(--verbose)
obs_verdict
timeout --signal=TERM --kill-after=10s 1800s node "$HERE/axclose.mjs" "${CONTROLLER_ARGS[@]}" \
    > "$OBS_WORK/controller.log" 2>&1
CONTROLLER_STATUS=$?
printf '%s\n' "$CONTROLLER_STATUS" > "$OBS_WORK/controller.exit"
obs_masked < "$OBS_WORK/controller.log"
obs_log "results: $OBS_WORK/axclose-results.json; screenshots: $OBS_WORK/shots"
[ "$CONTROLLER_STATUS" != 2 ] || obs_refuse "native accessibility could not be exercised; see the controller evidence"
obs_judge "$CONTROLLER_STATUS" "a native tab action violated selection or close behavior; see axclose-results.json"
