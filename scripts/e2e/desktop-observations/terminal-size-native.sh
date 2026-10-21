#!/usr/bin/env bash
# Run the terminal size instrument in the desktop's WebKitGTK page. Invoke
# this under xvfb-run with a fixed screen size.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

output=$1
shift
backend_args=()
driver_args=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --backend)
            [ "$#" -ge 2 ] || obs_inconclusive "--backend needs xterm or ghostty"
            backend_args=(--backend "$2")
            shift 2
            ;;
        --backend=*)
            backend_args=(--backend "${1#*=}")
            shift
            ;;
        *)
            driver_args+=("$1")
            shift
            ;;
    esac
done
if [ "${#backend_args[@]}" -gt 0 ]; then
    case "${backend_args[1]}" in xterm|ghostty) ;; *) obs_inconclusive "--backend needs xterm or ghostty" ;; esac
fi
: "${DISPLAY:?run under xvfb-run}"
obs_setup terminal-size-native
obs_need node xvfb-run sha256sum
mkdir -m 700 "$output"
sha256sum "$HERE/terminal-size-native.sh" "$HERE/terminal-size-native.mjs" "$HERE/terminal-size-reader.mjs" "$HERE/terminal-size-page.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
openbox > "$OBS_WORK/openbox.log" 2>&1 &
OBS_PIDS+=("$!")
obs_wait 20 "the window manager" xprop -root _NET_SUPPORTING_WM_CHECK
obs_start_desktop

WS="$OBS_WORK/ws"
mkdir -p "$WS"
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
workspace_xid() { obs_x_window_titled "$WS"; }
obs_wait 60 "the native workspace window" workspace_xid
xid="$(workspace_xid)"
xdotool getwindowgeometry --shell "$xid" > "$output/window-geometry.txt"
xdpyinfo | grep 'dimensions:' > "$output/display-dimensions.txt"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
# shellcheck disable=SC2329
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers
xdotool windowactivate --sync "$xid"
import -window "$xid" "$output/window-before.png"
identify -format '%wx%h\n' "$output/window-before.png" > "$output/window-before-size.txt"
CHAN_WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w')" | tr -d '"')"
export CHAN_WINDOW_ID
[ -n "$CHAN_WINDOW_ID" ] || obs_inconclusive "the workspace page names no window id"
for socket in $(obs_control_sockets); do
    CHAN_CONTROL_SOCKET="$socket"
    export CHAN_CONTROL_SOCKET
    if cs pane list --window "$CHAN_WINDOW_ID" --json > "$OBS_WORK/panes.out" 2>&1; then break; fi
    CHAN_CONTROL_SOCKET=""
done
[ -n "${CHAN_CONTROL_SOCKET:-}" ] || obs_inconclusive "no private control socket addresses the workspace window"

dpkg-query -W libwebkit2gtk-4.1-0 > "$output/engine-package.txt"
ldd "$CHAN_DESKTOP_BIN" > "$output/desktop-ldd.txt"
"$CHAN_DESKTOP_BIN" --version > "$output/desktop-version.txt"
obs_log "window $xid is visible on $DISPLAY; engine $(cat "$output/engine-package.txt")"
set +e
node "$HERE/terminal-size-native.mjs" --inspector "$INSPECTOR" --xid "$xid" --output "$output" "${backend_args[@]}" "${driver_args[@]}"
verdict=$?
set -e
obs_verdict
obs_judge "$verdict" "native terminal size reader found a fault"
