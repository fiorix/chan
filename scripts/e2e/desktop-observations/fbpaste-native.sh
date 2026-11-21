#!/usr/bin/env bash
# File-browser Paste lands in the right-clicked row's folder, on WebKitGTK.
# The desktop guest counterpart of browser-smoke check 232: Xvfb, openbox,
# `chan serve` on a throwaway workspace the shell seeds with keep.txt at the
# root beside an empty notes folder, chan-desktop with the WebKit remote
# inspector, then fbpaste-native.mjs drives the real app file browser and
# asserts the landed file on disk and its selection. Invoke under xvfb-run
# with a fixed screen size. Layout mirrors terminal-size-native.sh in this
# directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

output=$1
[ -n "${output:-}" ] || obs_inconclusive "fbpaste-native.sh needs an output directory"
: "${DISPLAY:?run under xvfb-run}"
obs_setup fbpaste-native
obs_need node sha256sum
mkdir -m 700 "$output"
sha256sum "$HERE/fbpaste-native.sh" "$HERE/fbpaste-native.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
openbox > "$OBS_WORK/openbox.log" 2>&1 &
OBS_PIDS+=("$!")
obs_wait 20 "the window manager" xprop -root _NET_SUPPORTING_WM_CHECK
obs_start_desktop

WS="$OBS_WORK/ws"
mkdir -p "$WS/notes"
printf 'keep me\n' > "$WS/keep.txt"
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
workspace_xid() { obs_x_local_window_titled "$WS"; }
obs_wait 60 "the native workspace window" workspace_xid
xid="$(workspace_xid)"
xdotool windowactivate --sync "$xid"
# shellcheck disable=SC2329
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
# shellcheck disable=SC2329
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers

ENGINE_VERSION="$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0 2>/dev/null || echo unknown)"
echo "$ENGINE_VERSION" > "$output/engine-version.txt"
SHA="$OBS_SHA"
obs_log "window $xid is visible on $DISPLAY; engine $ENGINE_VERSION; sha $SHA"
obs_verdict
node "$HERE/fbpaste-native.mjs" --inspector "$INSPECTOR" --out "$output/recordings" --xid "$xid" \
  --workspace "$WS" --sha "$SHA" --engine-version "$ENGINE_VERSION" > "$output/driver.log" 2>&1
verdict=$?
echo "driver exit $verdict"
cat "$output/driver.log" | obs_masked
obs_judge "$verdict" "file browser paste landed outside the right-clicked folder"
