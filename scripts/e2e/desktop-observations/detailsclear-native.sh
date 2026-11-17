#!/usr/bin/env bash
# The Workspace details command clears the tab that shows the details, not the focused dock, on WebKitGTK.
# The desktop guest counterpart of browser-smoke check 233: Xvfb, openbox,
# `chan serve` on a throwaway workspace seeded with two root files, chan-desktop
# with the WebKit remote inspector, then detailsclear-native.mjs drives the real
# app file browser and launcher and asserts the tab's inspector shows the
# workspace while the dock keeps its selection. Invoke under xvfb-run with a
# fixed screen size. Layout mirrors terminal-size-native.sh in this directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

output=$1
[ -n "${output:-}" ] || obs_inconclusive "detailsclear-native.sh needs an output directory"
: "${DISPLAY:?run under xvfb-run}"
obs_setup detailsclear-native
obs_need node sha256sum
mkdir -m 700 "$output"
sha256sum "$HERE/detailsclear-native.sh" "$HERE/detailsclear-native.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"
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
xdotool windowactivate --sync "$xid"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
# shellcheck disable=SC2329
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

ENGINE_VERSION="$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0 2>/dev/null || echo unknown)"
echo "$ENGINE_VERSION" > "$output/engine-version.txt"
SHA="${P6NET2_SHA:-$(git -C /work/chan rev-parse HEAD 2>/dev/null || echo unknown)}"
export CHAN_DESKTOP_BIN CHAN_BIN
obs_log "window $xid is visible on $DISPLAY; engine $ENGINE_VERSION; sha $SHA"
set +e
node "$HERE/detailsclear-native.mjs" --inspector "$INSPECTOR" --out "$output/recordings" --xid "$xid" \
  --window "$CHAN_WINDOW_ID" --workspace "$WS" --sha "$SHA" --engine-version "$ENGINE_VERSION" > "$output/driver.log" 2>&1
verdict=$?
set -e
echo "driver exit $verdict"
obs_judge "$verdict" "workspace details cleared the focused dock"
