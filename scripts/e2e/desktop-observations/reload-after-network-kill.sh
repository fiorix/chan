#!/usr/bin/env bash
# Does a local workspace window reload into its workspace after WebKit's
# network process dies? WebKit keeps session storage in that process, and
# the workspace page keeps its token only there (`chan.token`), so a page
# can outlive the storage it would reload from. chan-desktop answers a
# Reload whose page says it lost its token by navigating the window to its
# tokened URL, and reloads any other page in page, as it always has.
#
# One chan-desktop on WebKitGTK under Xvfb, with openbox and a private
# session bus; X input comes from xdotool (XTEST: GTK ignores keys sent with
# `xdotool key --window`), and reload-after-network-kill.mjs reads the
# pages through the engine's remote inspector. Legs, each recorded as
# held, failed or unavailable:
#   1  window A (`chan serve` on a throwaway workspace) is in its
#      workspace with a terminal attached, `chan.token` is in its session
#      storage and its URL carries no t.
#   2  control: a click into the window, then Ctrl+Shift+R with nothing
#      killed, lands in the workspace on the same terminal session.
#   7  two Reloads by the key with the token intact land in page: one
#      with Search open keeps the fragment and comes back with Search open
#      on its query, one pressed within a second of a tab opening.
#   3  WebKitNetworkProcess, found among the desktop's own descendants by
#      pid and executable path (never by name, never in this driver's own
#      ancestor chain), is killed by pid, and WebKit's next one recorded.
#   4  session storage read again: kept or lost. This decides nothing.
#   5  a click into window A, then Ctrl+Shift+R: the page lands in its
#      workspace with a working token (a request for the shells list
#      answers 200, keys typed into its terminal reach the shell it had on
#      the session it had), not on the missing-token page.
#   6  window B, opened after leg 5, with its own fixture; a second kill;
#      then the page's own `app.window.reload` command, judged as leg 5.
#      The terminal load-failure card's Reload window ends in that command
#      and shows only when the terminal view fails to load, so it is not
#      driven here.
# Which load a page came from is its Navigation Timing type: `reload` for
# an in-page reload, `navigate` for the desktop's navigation, which the
# fixture's first load shows the instrument can read.
#
# Where the engine keeps session storage across the kill, legs 5 and 6
# hold without the navigation, and the result line says the run does not
# show the fix. It speaks for WebKitGTK only: WKWebView and WebView2 are
# other engines with other process models.
#
# Exit codes are lib.sh's: 0 every leg held; 1 a leg failed (the verdict
# exits 10); 2 the environment cannot run the driver; 3 a leg was
# unavailable, a precondition failed or the driver met an error it does
# not expect. The run's record, results.jsonl and screenshots, lands in
# OUT-DIR, which the driver creates; no record holds a token or a URL.
#
#   reload-after-network-kill.sh OUT-DIR
#
# Needs what lib.sh needs, node 22 or newer, pkg-config and dbus-daemon,
# and a built chan-desktop and chan with the web bundles. Run it only in an
# isolated guest.
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

usage() { printf 'Usage: %s <out-dir>\n' "$0" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
output=$1

obs_setup reload-after-network-kill
obs_need node pkg-config dbus-daemon
mkdir -m 700 "$output"
sha256sum "$HERE/reload-after-network-kill.sh" "$HERE/reload-after-network-kill.mjs" "$HERE/lib.sh" "$HERE/inspect.mjs" \
    > "$output/instrument-sha256.txt"
WEBKIT_VERSION="$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null)" || obs_refuse "pkg-config names no webkit2gtk-4.1"
echo "$WEBKIT_VERSION" > "$output/engine-package.txt"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display

# A session bus of the run's own, so nothing the desktop asks of a bus
# reaches the caller's.
dbus-daemon --session --fork --address="unix:path=$XDG_RUNTIME_DIR/bus" --print-pid=3 3> "$OBS_WORK/bus.pid" > /dev/null \
    || obs_inconclusive "the private session bus did not start"
OBS_PIDS+=("$(cat "$OBS_WORK/bus.pid")")
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

obs_start_desktop
obs_log "desktop build: $(grep -m1 -o 'build[^ ]*git-[0-9a-f]*[^ ]*' "$OBS_WORK/desktop.log" | sed 's/\x1b\[[0-9;]*m//g' || echo unknown)"
obs_log "engine: WebKitGTK $WEBKIT_VERSION; desktop pid $OBS_DESKTOP_PID"

WS="$OBS_WORK/ws"
mkdir -p "$WS/notes"
printf '# Reload\n\nA workspace for the reload driver.\n' > "$WS/notes/reload.md"
timeout --signal=TERM --kill-after=5s 60s "$CHAN_BIN" serve "$WS" > "$OBS_WORK/serve.out" 2>&1 \
    || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
workspace_xid() { obs_x_local_window_titled "$WS"; }
obs_wait 60 "the native workspace window" workspace_xid
XID="$(workspace_xid)"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers
WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w')" | tr -d '"')"
[ -n "$WINDOW_ID" ] && [ "$WINDOW_ID" != null ] || obs_inconclusive "the workspace page names no window id"
# The tenant whose control socket addresses the window is the workspace's.
CHAN_CONTROL_SOCKET=""
find_socket() {
    local sock
    for sock in $(obs_control_sockets); do
        if CHAN_CONTROL_SOCKET="$sock" cs pane list --window "$WINDOW_ID" --json > /dev/null 2>&1; then
            CHAN_CONTROL_SOCKET="$sock"
            return 0
        fi
    done
    return 1
}
obs_wait 60 "a control socket that addresses the window" find_socket
find_socket
export CHAN_CONTROL_SOCKET
obs_log "window $WINDOW_ID (X $XID) through $(basename "$CHAN_CONTROL_SOCKET")"

# From here the driver decides its own exit code. The runner's lines go
# through the masker like every other line of the run.
obs_verdict
node "$HERE/reload-after-network-kill.mjs" run --inspector "$INSPECTOR" --desktop-pid "$OBS_DESKTOP_PID" \
    --desktop-bin "$CHAN_DESKTOP_BIN" --chan "$CHAN_BIN" --ws "$WS" --window "$WINDOW_ID" --xid "$XID" \
    --output "$output" --webkit "$WEBKIT_VERSION" 2>&1 | obs_masked >&2
run_status=${PIPESTATUS[0]}
[ "$run_status" = 0 ] || obs_inconclusive "the legs' runner failed with status $run_status; the last record is in $output/results.jsonl"
obs_log "results: $output/results.jsonl; screenshots: $output/shots; desktop log: $OBS_WORK/desktop.log"
node "$HERE/reload-after-network-kill.mjs" verdict --results "$output/results.jsonl" --webkit "$WEBKIT_VERSION" 2>&1 | obs_masked
obs_judge "${PIPESTATUS[0]}" "a Reload of a local window on WebKitGTK $WEBKIT_VERSION did not land as it must; the FAILED lines above name each leg"
