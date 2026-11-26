#!/usr/bin/env bash
# A click on a URL a terminal underlines, on the desktop's WebKitGTK page:
# the link menu opens, and its "Open in browser" reaches the system opener.
# The stock desktop's opener is intercepted by a private `xdg-open` first on
# PATH, which records its arguments and opens nothing.
#
# Exit codes follow lib.sh: 0 the menu opened and the opener got the URL, 1
# a fault was observed (terminal-link.json names each), 2
# the environment or the driver's setup could not run (no menu was asked
# for), 3 inconclusive.
#
# The result names the tree by OBS_SHA, which lib.sh reads from git. A tree
# synced without .git can name its commit by setting OBS_SHA; lib.sh keeps
# it and adds -status-unknown, since it cannot read that tree's status.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup terminal-link-native
obs_need node
output="$OBS_WORK/out"
mkdir -m 700 "$output"
sha256sum "$HERE/terminal-link-native.sh" "$HERE/terminal-link-native.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"

# The system opener, recorded. tauri-plugin-opener reaches the browser
# through xdg-open on Linux.
mkdir -m 700 "$OBS_WORK/bin"
export TERMINAL_LINK_OPENED="$output/xdg-open.log"
cat > "$OBS_WORK/bin/xdg-open" <<'SHIM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TERMINAL_LINK_OPENED"
SHIM
chmod 700 "$OBS_WORK/bin/xdg-open"
export PATH="$OBS_WORK/bin:$PATH"
[ "$(command -v xdg-open)" = "$OBS_WORK/bin/xdg-open" ] || obs_refuse "the private xdg-open is not first on PATH"

INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
WS="$OBS_WORK/ws"
mkdir -p "$WS"
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_refuse "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
workspace_xid() { obs_x_local_window_titled "$WS"; }
obs_wait 60 "the native workspace window" workspace_xid
xid="$(workspace_xid)"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
obs_wait 60 "the workspace page to answer the inspector" page_eval "document.readyState"
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
export CHAN_BIN
{
    printf 'source=%s\n' "$OBS_SHA"
    pkg-config --modversion webkit2gtk-4.1 2>/dev/null || dpkg-query -W libwebkit2gtk-4.1-0 2>/dev/null || echo "webkit2gtk version unknown"
    "$CHAN_DESKTOP_BIN" --version
} > "$output/provenance.txt"
obs_log "window $xid on $DISPLAY; results in $output"
obs_verdict
node "$HERE/terminal-link-native.mjs" --inspector "$INSPECTOR" --xid "$xid" --workspace "$WS" --output "$output"
verdict=$?
if [ "$verdict" -eq 2 ]; then obs_refuse "the driver's setup did not run; see $output/terminal-link.json"; fi
obs_judge "$verdict" "the link menu or the system opener failed on chan-desktop; see $output/terminal-link.json"
