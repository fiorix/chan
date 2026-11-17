#!/usr/bin/env bash
# File-browser Paste lands in the right-clicked row's folder, on WebKitGTK.
# The desktop guest counterpart of browser-smoke check 232: Xvfb, openbox,
# `chan serve` on a throwaway workspace seeded with notes/keep.txt and
# notes/sub, chan-desktop with the WebKit remote inspector, then
# fbpaste-native.mjs drives the real app file browser and asserts the landed
# file on disk and its selection. Invoke under xvfb-run with a fixed screen
# size. Layout mirrors terminal-size-native.sh in this directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. /work/chan/scripts/e2e/desktop-observations/lib.sh

output=$1
[ -n "${output:-}" ] || obs_inconclusive "fbpaste-native.sh needs an output directory"
: "${DISPLAY:?run under xvfb-run}"
obs_setup fbpaste-native
obs_need node xvfb-run sha256sum xdotool xprop import
mkdir -m 700 "$output"
sha256sum "$HERE/fbpaste-native.sh" "$HERE/fbpaste-native.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"
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
CHAN_WINDOW_ID="$(node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "new URLSearchParams(location.search).get('w')" | tr -d '"')"
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
node "$HERE/fbpaste-native.mjs" --inspector "$INSPECTOR" --out "$output/recordings" --xid "$xid" \
  --window "$CHAN_WINDOW_ID" --workspace "$WS" --sha "$SHA" --engine-version "$ENGINE_VERSION" > "$output/driver.log" 2>&1
verdict=$?
set -e
echo "driver exit $verdict"
obs_judge "$verdict" "file browser paste landed outside the right-clicked folder"
