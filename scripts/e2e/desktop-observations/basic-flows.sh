#!/usr/bin/env bash
# Do the basic flows land on chan-desktop's own engine? This stage asks it
# of an image pasted into the editor and into the Rich Prompt with the
# clipboard shape WKWebView hands the page: a paste event that advertises
# Files and exposes no items, no files and no text. The page cannot read
# such an image itself; it has to ask the desktop for it.
#
# This drives a real chan-desktop on WebKitGTK under Xvfb, with a window
# manager and a private session bus. The X CLIPBOARD holds a generated PNG
# (xclip stays its owner). The injected event is defined exactly as the
# editor's vitest defines the failing shape, so the real desktop command,
# its capability grant, the clipboard read through arboard and the upload
# all run. The shape is injected: WebKitGTK stands in for WKWebView here,
# and what WKWebView itself hands the page stays an owner check on macOS.
#
# Arms, in order (basic-flows.mjs runs them through the engine's remote
# inspector and records what each saw):
#   ipc-read                  the page asks the desktop for the clipboard
#                             image directly; decides nothing by itself and
#                             names where a fault sits.
#   editor paste-native-shape the subject: the image must embed in the
#                             note, land beside it with the fixture's
#                             pixels, raise no notice, and the note's file
#                             must name it.
#   editor paste-file-item    control: a paste whose items carry the image
#                             as a File, which the handler reads from the
#                             event without asking the desktop. It must
#                             land, or the readers cannot see a landed image.
#   editor paste-text-only    control: the clipboard holds text only, owned
#                             through GTK as an app's text copy is
#                             (clipboard-text-owner.py; xclip would answer
#                             the image request with its text), and the same
#                             native shape is pasted. Where the subjects
#                             held, it must say "No image found on the
#                             clipboard" and land nothing, which shows their
#                             images came from the X clipboard.
#   prompt paste-native-shape the subject over a terminal running cat: the
#                             image must embed in the composer and land in
#                             its draft, and after Ctrl+Enter (X input) the
#                             terminal must show its bare absolute path.
#   prompt paste-file-item    control, as in the editor.
#   trusted-shape             recorded, decides nothing: a real Ctrl+V into
#                             the note with the PNG on the clipboard, and
#                             the shape WebKitGTK itself hands the page.
#
# Every verdict line names the WebKitGTK version and the page's user agent.
# A fault counts only where the injected shape reached the page as built,
# the clipboard offered the PNG and the same surface's control landed its
# image; anything less is inconclusive. Exit codes are lib.sh's.
#
# Needs what lib.sh needs, node 22 or newer, xclip, python3-gi with GTK 3,
# pkg-config, dbus-daemon and ImageMagick's magick, and a built
# chan-desktop and chan with the web bundles.
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name. The directive
# stands before the first command so that it covers the file.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup basic-flows
obs_need node xclip pkg-config dbus-daemon magick
python3 -c 'import gi; gi.require_version("Gtk", "3.0")' 2>/dev/null || obs_refuse "python3-gi with GTK 3 is not installed"
WEBKIT_VERSION="$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null)" || obs_refuse "pkg-config names no webkit2gtk-4.1"
export WEBKIT_VERSION
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
obs_log "engine: WebKitGTK $WEBKIT_VERSION"

WS="$OBS_WORK/ws"
mkdir -p "$WS/notes"
printf '# Paste\n\nseed\n' > "$WS/notes/paste.md"
RESULTS="$OBS_WORK/results.jsonl"
: > "$RESULTS"
PAGE="/workspace-"

# The fixture: two colours side by side, so a swapped channel, a flipped
# row or a lost half shows in the decoded pixels.
FIXTURE="$OBS_WORK/fixture.png"
magick -size 20x24 xc:'#d03020' -size 20x24 xc:'#2050c0' +append "$FIXTURE" \
    || obs_inconclusive "the fixture image could not be made"
obs_log "fixture $(magick identify -format '%wx%h %k colours' "$FIXTURE") sha256 $(sha256sum "$FIXTURE" | cut -c1-16)"
# The pixel comparison the verdict rests on must tell the fixture from its
# mirror image and match the fixture to itself.
magick "$FIXTURE" -flop "$OBS_WORK/fixture-mirrored.png"
if magick compare -metric AE "$FIXTURE" "$OBS_WORK/fixture-mirrored.png" null: 2>/dev/null; then
    obs_inconclusive "the pixel comparison cannot tell the fixture from its mirror image"
fi
magick compare -metric AE "$FIXTURE" "$FIXTURE" null: 2>/dev/null || obs_inconclusive "the pixel comparison does not match the fixture to itself"

page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "$PAGE" "$1"; }
workspace_xid() { obs_x_window_titled "$WS"; }

# One workspace window, handed to the running desktop.
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
obs_wait 60 "the native workspace window" workspace_xid
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers
CHAN_WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w')" | tr -d '"')"
export CHAN_WINDOW_ID
[ -n "$CHAN_WINDOW_ID" ] || obs_inconclusive "the workspace page names no window id"
# The tenant whose socket can address the window is the workspace's.
CHAN_CONTROL_SOCKET=""
find_socket() {
    local sock
    for sock in $(obs_control_sockets); do
        if CHAN_CONTROL_SOCKET="$sock" cs pane list --window "$CHAN_WINDOW_ID" --json >/dev/null 2>&1; then
            CHAN_CONTROL_SOCKET="$sock"
            return 0
        fi
    done
    return 1
}
obs_wait 60 "a control socket that addresses the window" find_socket
find_socket
export CHAN_CONTROL_SOCKET
obs_log "window $CHAN_WINDOW_ID through $(basename "$CHAN_CONTROL_SOCKET")"
XID="$(workspace_xid)"
xdotool windowactivate --sync "$XID" 2>/dev/null || true

node "$HERE/basic-flows.mjs" run --inspector "$INSPECTOR" --page "$PAGE" --xid "$XID" \
    --ws "$WS" --note notes/paste.md --chan-home "$CHAN_HOME" --fixture "$FIXTURE" \
    --chan "$CHAN_BIN" --work "$OBS_WORK" --results "$RESULTS" \
    || obs_inconclusive "the arms' runner failed with status $?; the last record is in $RESULTS"

obs_log "results: $RESULTS; desktop log: $OBS_WORK/desktop.log; screenshots: $OBS_WORK/shots"
obs_verdict
node "$HERE/basic-flows.mjs" verdict --results "$RESULTS" --webkit "$WEBKIT_VERSION" 2>&1 | obs_masked
obs_judge "${PIPESTATUS[0]}" "an image pasted with WKWebView's empty-Files clipboard shape did not land on chan-desktop (WebKitGTK $WEBKIT_VERSION); the lines above name each surface's reading"
