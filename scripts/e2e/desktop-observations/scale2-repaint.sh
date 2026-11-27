#!/usr/bin/env bash
# The check-296 reset on the real WebKitGTK desktop at GDK_SCALE=2. One
# ghostty terminal paints pages, the canvas drawing state drops by a
# same-size reset, and the window refocus runs the app's forced passes;
# the driver reads painted pixels per quarter plus the transform before
# and after. Run once per tree at /work/chan, base first, then tip: the
# base keeps the half-scale paint (an observed fault), the tip repaints
# at full scale. Exit 0 held; the wrapper exits 1 on an observed fault
# (the driver exits 10 through its judge), 3 when inconclusive, 2 when
# refused. Run only in an isolated guest.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

usage() { printf 'Usage: %s <out-dir>\n' "$0" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
output=$1

export CHAN_BIN
obs_setup scale2-repaint
obs_need node xdotool
mkdir -m 700 "$output"
sha256sum "$HERE/scale2-repaint.sh" "$HERE/scale2-repaint.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"

Xvfb -displayfd 3 -screen 0 1600x1000x24 -nolisten tcp \
  3> "$OBS_WORK/display" > "$OBS_WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
OBS_PIDS+=("$XVFB_PID")
display_ready() { kill -0 "$XVFB_PID" && test -s "$OBS_WORK/display"; }
obs_wait 20 "this run's X server to allocate a display" display_ready
read -r DISPLAY_NUMBER < "$OBS_WORK/display"
[[ "$DISPLAY_NUMBER" =~ ^[0-9]+$ ]] || obs_inconclusive "Xvfb returned an invalid display number"
export DISPLAY=":$DISPLAY_NUMBER"

# The scale under test: the desktop and everything it spawns see it.
export GDK_SCALE=2
export GDK_DPI_SCALE=1

openbox > "$OBS_WORK/openbox.log" 2>&1 &
OBS_PIDS+=("$!")
obs_wait 20 "the window manager" xprop -root _NET_SUPPORTING_WM_CHECK

INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_desktop

WEBKIT_VERSION="$(pkg-config --modversion webkit2gtk-4.1)" || obs_refuse "pkg-config names no webkit2gtk-4.1"
obs_log "engine: WebKitGTK $WEBKIT_VERSION; display $DISPLAY; GDK_SCALE=$GDK_SCALE"
echo "$WEBKIT_VERSION" > "$output/engine-package.txt"

WS="$OBS_WORK/ws"
mkdir -p "$WS"
timeout --signal=TERM --kill-after=5s 60s "$CHAN_BIN" serve "$WS" > "$OBS_WORK/serve.out" 2>&1 \
    || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
workspace_xid() { obs_x_local_window_titled "$WS"; }
obs_wait 60 "the native workspace window" workspace_xid
xid="$(workspace_xid)"
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
import -window "$xid" "$output/window-before.png"
set +e
node "$HERE/scale2-repaint.mjs" --inspector "$INSPECTOR" --xid "$xid" --output "$output"
verdict=$?
set -e
import -window "$xid" "$output/window-after.png"
obs_verdict
obs_judge "$verdict" "scale-2 repaint differs base to tip in the wrong direction"
