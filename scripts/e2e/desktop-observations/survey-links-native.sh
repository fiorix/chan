#!/usr/bin/env bash
# A survey's overlay press and its body links on the desktop's WebKitGTK
# page, the counterpart of browser checks 351 and 354: a press beside the
# card keeps the keyboard on it, and a body link shows the editor's
# drop-down, opens through its row, Enter or Ctrl+Enter, and never takes
# the window away (survey-links-native.mjs names each leg). The stock
# desktop's opener is intercepted by a private `xdg-open` first on PATH,
# which records its arguments and opens nothing.
#
#   survey-links-native.sh OUTPUT-DIR [--legs LEG,...]
#
# OUTPUT-DIR must not exist; the driver makes it (mode 700) and keeps
# survey-links.json, the opener's record, the PTY recorders, shots and the
# instrument hashes there. The driver starts its own X server on a fixed
# 1600x1000 screen and its own window manager. --legs runs a subset, in the
# driver's order. Exit codes follow lib.sh: 0 every leg held, 1 a fault was
# observed (survey-links.json names each), 2 the environment or the
# driver's setup could not run (no leg was read), 3 inconclusive. Run only
# in an isolated guest.
#
# The result names the tree by OBS_SHA, which lib.sh reads from git. A tree
# synced without .git can name its commit by setting OBS_SHA; lib.sh keeps
# it and adds -status-unknown, since it cannot read that tree's status.
# shellcheck disable=SC2329 # obs_wait calls the readiness functions by name
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

usage() { printf 'Usage: %s <out-dir> [--legs LEG,...]\n' "$0" >&2; exit 2; }
[ "$#" -ge 1 ] || usage
output=$1
shift

export CHAN_BIN
obs_setup survey-links-native
obs_need node xdotool
mkdir -m 700 "$output"
sha256sum "$HERE/survey-links-native.sh" "$HERE/survey-links-native.mjs" "$HERE/survey-links-verdict.mjs" \
    "$HERE/lib.sh" "$HERE/inspect.mjs" "$HERE/../browser-smoke/lib/pty-recorder.mjs" \
    "$HERE/../browser-smoke/lib/terminal-attach.mjs" "$HERE/../browser-smoke/lib/token-mask.mjs" \
    > "$output/instrument-sha256.txt"

# The system opener, recorded. tauri-plugin-opener reaches the browser
# through xdg-open on Linux.
mkdir -m 700 "$OBS_WORK/bin"
export SURVEY_LINKS_OPENED="$output/xdg-open.log"
cat > "$OBS_WORK/bin/xdg-open" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SURVEY_LINKS_OPENED"
SHIM
chmod 700 "$OBS_WORK/bin/xdg-open"
export PATH="$OBS_WORK/bin:$PATH"
[ "$(command -v xdg-open)" = "$OBS_WORK/bin/xdg-open" ] || obs_refuse "the private xdg-open is not first on PATH"

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
xdotool getwindowgeometry --shell "$xid" > "$output/window-geometry.txt"
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
node "$HERE/survey-links-native.mjs" --inspector "$INSPECTOR" --xid "$xid" --workspace "$WS" --output "$output" "$@"
verdict=$?
if [ "$verdict" -eq 2 ]; then obs_refuse "the driver's setup did not run; see $output/survey-links.json"; fi
obs_judge "$verdict" "a survey's press or body link failed on chan-desktop; see $output/survey-links.json"
