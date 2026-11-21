#!/usr/bin/env bash
# Keyboard ownership on the desktop's WebKitGTK page, in this order: a real
# press on the Rich Prompt's Submit keeps the composer's keyboard and the
# next key types; a press in another pane moves no focus and leaves the
# active pane; the deck opened by its chord runs a row and returns into
# Search; with the Computers launcher shown, a deck run leaves the page's
# focus where it was; and, last, a deck opened from a focused composer and
# dismissed under the launcher leaves it there too.
#
# This runs under xvfb-run with a fixed screen, like terminal-size-native.sh.
# Drivers: argv are passed to keyboard-focus-native.mjs unchanged;
# --keep-going records every fault and runs on, for a red tree.
# Exit codes follow lib.sh: 0 every step held, 1 a fault was observed (the
# run's keyboard-focus.json names each in "faults"), 2 the environment
# cannot run this driver, 3 inconclusive.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

output=""
driver_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -ge 2 ] || obs_inconclusive "--output needs a directory"
      output="$2"
      shift 2
      ;;
    --output=*)
      output="${1#--output=}"
      shift
      ;;
    *)
      driver_args+=("$1")
      shift
      ;;
  esac
done
[ -n "$output" ] || obs_inconclusive "no --output directory given"
: "${DISPLAY:?run under xvfb-run}"
obs_setup keyboard-focus-native
xdotool --help >/dev/null 2>&1 || obs_refuse "xdotool is not installed"
mkdir -m 700 "$output"
sha256sum "$HERE/keyboard-focus-native.sh" "$HERE/keyboard-focus-native.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
openbox > "$OBS_WORK/openbox.log" 2>&1 &
OBS_PIDS+=("$!")
obs_wait 20 "the window manager" xprop -root _NET_SUPPORTING_WM_CHECK
obs_start_desktop
WS="$OBS_WORK/ws"
mkdir -p "$WS"
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
workspace_xid() { obs_x_local_window_titled "$WS"; }
obs_wait 60 "the native workspace window" workspace_xid
xid="$(workspace_xid)"
xdotool getwindowgeometry --shell "$xid" > "$output/window-geometry.txt"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
obs_wait 60 "the workspace page to answer the inspector" page_eval "document.readyState"
CHAN_WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w') || ''" | tr -d '"')"
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
"$CHAN_DESKTOP_BIN" --version > "$output/desktop-version.txt"
obs_log "window $xid is visible on $DISPLAY; engine $(cat "$output/engine-package.txt")"
obs_verdict
node "$HERE/keyboard-focus-native.mjs" --inspector "$INSPECTOR" --xid "$xid" --output "$output" "${driver_args[@]}"
verdict=$?
obs_judge "$verdict" "keyboard focus fault observed on chan-desktop; see keyboard-focus.json"
