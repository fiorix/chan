#!/usr/bin/env bash
# A 30 s main-thread stall under a fast stream on the native Linux desktop,
# under Xvfb: the terminal must keep its socket and parse what WebKitGTK
# queued, whole and in order. See terminal-stall-native.mjs for the readings.
#   terminal-stall-native.sh OUTPUT_DIR
set -euo pipefail
umask 077
[ "$#" = 1 ] || { echo "usage: $0 OUTPUT_DIR" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"
mkdir -p "$1"
OUTPUT="$(realpath "$1")"
obs_setup terminal-stall
obs_need node seq
INSPECTOR="127.0.0.1:$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
workspace="$OBS_WORK/workspace-stall"
mkdir -p "$workspace"
printf '# Stall\n' > "$workspace/README.md"
chan serve "$workspace" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive 'workspace handoff failed'
workspace_xid() { obs_x_local_window_titled "$workspace"; }
obs_wait 60 'native workspace window' workspace_xid
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval '/workspace-' "$1"; }
page_answers() { page_eval 'document.readyState' | grep -q complete; }
obs_wait 60 'native workspace inspector' page_answers
CHAN_WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w')" | tr -d '"')"
[ -n "$CHAN_WINDOW_ID" ] || obs_inconclusive 'native page has no window id'
export CHAN_WINDOW_ID
CHAN_CONTROL_SOCKET=''
for socket in $(obs_control_sockets); do
    if CHAN_CONTROL_SOCKET="$socket" cs pane list --window "$CHAN_WINDOW_ID" --json > "$OBS_WORK/panes.out" 2>&1; then
        CHAN_CONTROL_SOCKET="$socket"
        break
    fi
done
[ -n "$CHAN_CONTROL_SOCKET" ] || obs_inconclusive 'private control socket not found'
export CHAN_CONTROL_SOCKET
obs_verdict
node "$HERE/terminal-stall-native.mjs" "$INSPECTOR" "$OBS_WORK" "$CHAN_BIN" "$OUTPUT"
status=$?
obs_shot terminal-stall-final
cp -p "$OBS_WORK/shots/terminal-stall-final.png" "$OUTPUT/" 2>/dev/null || true
obs_masked < "$OBS_WORK/desktop.log" > "$OUTPUT/desktop.log" || true
obs_judge "$status" "terminal stall contract failed; see $OUTPUT/results.json"
