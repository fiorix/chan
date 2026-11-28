#!/usr/bin/env bash
# Does a table cell on chan-desktop's own engine show a wikilink's label?
# wikilink-labels.mjs seeds a note and a table document whose link cell
# holds [[note]], opens the table in the workspace window, and reads the
# table widget's grid from the page through the engine's remote inspector:
# the link cell must show the label as text, the code cell the link as
# typed. Speaks for WebKitGTK only.
#
#   wikilink-labels.sh OUTPUT-DIR
#
# OUTPUT-DIR must not exist; the driver makes it (mode 700) and keeps
# wikilink-labels.json (the observation, its lines and the verdict), a shot
# of the window, provenance and the instrument hashes there. The driver
# starts its own X server on a fixed 1600x1000 screen and its own window
# manager. Exit codes follow lib.sh: 0 the label held, 1 a fault was
# observed, 2 the environment or the driver's setup could not run (nothing
# was read), 3 inconclusive. Run only in an isolated guest.
#
# The result names the tree by OBS_SHA, which lib.sh reads from git. A tree
# synced without .git can name its commit by setting OBS_SHA; lib.sh keeps
# it and adds -status-unknown, since it cannot read that tree's status.
# shellcheck disable=SC2329 # obs_wait calls the readiness functions by name
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

usage() { printf 'Usage: %s <out-dir>\n' "$0" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
output=$1

export CHAN_BIN
obs_setup wikilink-labels
obs_need node xdotool
mkdir -m 700 "$output"
sha256sum "$HERE/wikilink-labels.sh" "$HERE/wikilink-labels.mjs" "$HERE/wikilink-labels-verdict.mjs" \
    "$HERE/lib.sh" "$HERE/inspect.mjs" "$HERE/../browser-smoke/lib/token-mask.mjs" > "$output/instrument-sha256.txt"

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

WS="$OBS_WORK/ws"
mkdir -p "$WS"
timeout --signal=TERM --kill-after=5s 60s "$CHAN_BIN" serve "$WS" > "$OBS_WORK/serve.out" 2>&1 \
    || obs_refuse "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
workspace_xid() { obs_x_local_window_titled "$WS"; }
obs_wait 60 "the native workspace window" workspace_xid
xid="$(workspace_xid)"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers
CHAN_WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w') || ''" | tr -d '"')"
export CHAN_WINDOW_ID
[ -n "$CHAN_WINDOW_ID" ] || obs_refuse "the workspace page names no window id"
for socket in $(obs_control_sockets); do
  CHAN_CONTROL_SOCKET="$socket"
  export CHAN_CONTROL_SOCKET
  if cs pane list --window "$CHAN_WINDOW_ID" --json > "$OBS_WORK/panes.out" 2>&1; then break; fi
  CHAN_CONTROL_SOCKET=""
done
[ -n "${CHAN_CONTROL_SOCKET:-}" ] || obs_refuse "no private control socket addresses the workspace window"
{
  printf 'source=%s\n' "$OBS_SHA"
  pkg-config --modversion webkit2gtk-4.1 2>/dev/null || dpkg-query -W libwebkit2gtk-4.1-0 2>/dev/null || echo "webkit2gtk version unknown"
  "$CHAN_DESKTOP_BIN" --version
} > "$output/provenance.txt"
obs_log "window $xid on $DISPLAY; results in $output"
# The ERR trap fires under `set +e` too: only obs_verdict lets the
# driver's own status, a fault among them, reach obs_judge.
obs_verdict
node "$HERE/wikilink-labels.mjs" --inspector "$INSPECTOR" --xid "$xid" --workspace "$WS" --output "$output"
verdict=$?
if [ "$verdict" -eq 2 ]; then obs_refuse "the driver's setup did not run; see $output/wikilink-labels.json"; fi
obs_judge "$verdict" "a table cell on chan-desktop does not show a wikilink's label as text (WebKitGTK); see $output/wikilink-labels.json"
