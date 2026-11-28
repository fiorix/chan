#!/usr/bin/env bash
# The Tab order across panes on the real WebKitGTK desktop: two panes with a
# recording terminal each, pane B active, and browser check 353's walks
# made by real key presses through XTEST. A Tab walk must never land in
# pane A's terminal, a key typed after it must never reach A's PTY, a press
# on A's terminal must still make A active with the keyboard, and Tab
# inside a terminal that holds the keyboard must reach its program.
# tab-order-native.mjs drives the page through the engine's inspector and
# tab-order-verdict.mjs judges it. This starts its own X display and
# window manager. Exit 0 held; 1 a fault was observed (the driver exits 10
# through its judge); 2 refused; 3 inconclusive. Run only in an isolated
# guest.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

usage() { printf 'Usage: %s <out-dir>\n' "$0" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
output=$1

export CHAN_BIN
obs_setup tab-order-native
obs_need node xdotool pkg-config
mkdir -m 700 "$output"
sha256sum "$HERE/tab-order-native.sh" "$HERE/tab-order-native.mjs" "$HERE/tab-order-verdict.mjs" \
    "$HERE/lib.sh" "$HERE/../browser-smoke/lib/pty-recorder.mjs" \
    "$HERE/../browser-smoke/lib/terminal-attach.mjs" "$HERE/../browser-smoke/lib/token-mask.mjs" \
    > "$output/instrument-sha256.txt"

Xvfb -displayfd 3 -screen 0 1600x1000x24 -nolisten tcp \
  3> "$OBS_WORK/display" > "$OBS_WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
OBS_PIDS+=("$XVFB_PID")
display_ready() { kill -0 "$XVFB_PID" && test -s "$OBS_WORK/display"; }
obs_wait 20 "this run's X server to allocate a display" display_ready
read -r DISPLAY_NUMBER < "$OBS_WORK/display"
[[ "$DISPLAY_NUMBER" =~ ^[0-9]+$ ]] || obs_inconclusive "Xvfb returned an invalid display number"
export DISPLAY=":$DISPLAY_NUMBER"

openbox > "$OBS_WORK/openbox.log" 2>&1 &
OBS_PIDS+=("$!")
obs_wait 20 "the window manager" xprop -root _NET_SUPPORTING_WM_CHECK

INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_desktop

WEBKIT_VERSION="$(pkg-config --modversion webkit2gtk-4.1)" || obs_refuse "pkg-config names no webkit2gtk-4.1"
obs_log "engine: WebKitGTK $WEBKIT_VERSION; display $DISPLAY"
echo "$WEBKIT_VERSION" > "$output/engine-package.txt"

WS="$OBS_WORK/ws"
mkdir -p "$WS"
timeout --signal=TERM --kill-after=5s 60s "$CHAN_BIN" serve "$WS" > "$OBS_WORK/serve.out" 2>&1 \
    || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
workspace_xid() { obs_x_local_window_titled "$WS"; }
obs_wait 60 "the native workspace window" workspace_xid
xid="$(workspace_xid)"
xdotool getwindowgeometry --shell "$xid" > "$output/window-geometry.txt"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers
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
obs_log "window $xid is visible on $DISPLAY"
# The ERR trap fires under `set +e` too: only obs_verdict lets the
# driver's own status, a fault among them, reach obs_judge.
obs_verdict
node "$HERE/tab-order-native.mjs" --inspector "$INSPECTOR" --xid "$xid" --output "$output"
verdict=$?
obs_judge "$verdict" "a terminal outside the active pane took a Tab walk or a typed key, or a press or a terminal's own Tab broke; see tab-order.json"
