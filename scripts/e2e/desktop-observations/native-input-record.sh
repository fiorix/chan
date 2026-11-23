#!/usr/bin/env bash
# Run inside the isolated desktop guest under xvfb-run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

output=${1:-}
[ -n "${output:-}" ] || obs_inconclusive "native-input-record.sh needs an output directory"
: "${DISPLAY:?run under xvfb-run}"
obs_setup native-input-record
obs_need node xvfb-run sha256sum xdotool xclip xprop import xdpyinfo
mkdir -m 700 "$output"
KIT="$HERE/../browser-smoke/lib/native-input"
[ -f "$HERE/native-input-record.mjs" ] || obs_inconclusive "native input driver missing"
sha256sum "$HERE/native-input-record.sh" "$HERE/native-input-record.mjs" "$KIT/cases.mjs" "$KIT/page.mjs" "$KIT/schema.mjs" "$KIT/boot-wait.mjs" "$KIT/identity.mjs" "$HERE/lib.sh" "$HERE/inspect.mjs" > "$output/instrument-sha256.txt"
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
xdpyinfo | grep 'dimensions:' > "$output/display-dimensions.txt"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
# shellcheck disable=SC2329
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers
xdotool windowactivate --sync "$xid"
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

ENGINE_VERSION="$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0 2>/dev/null || echo unknown)"
echo "$ENGINE_VERSION" > "$output/engine-version.txt"
dpkg-query -W libwebkit2gtk-4.1-0 > "$output/engine-package.txt"
SHA="${NATIVE_INPUT_SHA:?NATIVE_INPUT_SHA names the worktree tip under test}"
export CHAN_DESKTOP_BIN CHAN_BIN
obs_log "window $xid is visible on $DISPLAY; engine $ENGINE_VERSION; sha $SHA"
obs_verdict
node "$HERE/native-input-record.mjs" --inspector "$INSPECTOR" --out "$output/recordings" --xid "$xid" --sha "$SHA" --engine-version "$ENGINE_VERSION" > "$output/driver.log" 2>&1
verdict=$?
echo "driver exit $verdict"
cat "$output/driver.log" | obs_masked
import -window "$xid" "$output/verdict.png" 2>/dev/null || true
obs_judge "$verdict" "webkit-record: see the FAIL lines above"
