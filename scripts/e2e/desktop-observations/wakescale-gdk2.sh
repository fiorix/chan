#!/usr/bin/env bash
# Wakescale acceptance 5: the same canvas reset as check 296, on the real
# WebKitGTK desktop at GDK_SCALE=2, base against tip. A same-size canvas
# reset is the specification's reset on every engine, so unlike the sleep
# it needs no wake to reproduce: blank bitmap, identity transform. The
# driver below opens one ghostty terminal, paints pages, reads quarters and
# transform, resets, and refocuses the window (the app's forced passes run
# on focus); at the tip the repaint lands at full scale, at the base it
# stays in the top-left quarter. Run once per tree at /work/chan: base
# first, then tip. Exit 0 held, 10 observed fault, 2 refused, 3
# inconclusive; the lifecycle shell maps 10 through obs_judge.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

usage() { printf 'Usage: %s <out-dir>\n' "$0" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
output=$1

obs_setup wakescale-gdk2
obs_need node xdotool
mkdir -m 700 "$output"
sha256sum "$HERE/wakescale-gdk2.sh" "$HERE/wakescale-gdk2.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"

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

WS="$OBS_WORK/ws"
mkdir -p "$WS"
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off"
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

dpkg-query -W libwebkit2gtk-4.1-0 > "$output/engine-package.txt" 2>/dev/null || true
set +e
node "$HERE/wakescale-gdk2.mjs" --inspector "$INSPECTOR" --xid "$xid" --output "$output"
verdict=$?
set -e
obs_verdict
obs_judge "$verdict" "scale-2 repaint differs base to tip in the wrong direction"
