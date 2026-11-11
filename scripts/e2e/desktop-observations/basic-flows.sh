#!/usr/bin/env bash
# Do the basic flows work on chan-desktop's own engine? This asks it of an
# image pasted and dropped into the editor and into the Rich Prompt, of the
# terminal's input, output and text paste on both backends, of typing and
# saving in the editor, and of opening a file, a search hit and the panes.
#
# This drives a real chan-desktop on WebKitGTK under Xvfb, with a window
# manager and a private session bus. The X CLIPBOARD holds a generated PNG,
# owned by xclip or through GTK (clipboard-owner.py); X input comes from
# xdotool, and a real drop from a small GTK drag source (drag-source.py).
#
# Arms, by group (BASIC_FLOWS_ARMS, a comma list, all nine by default;
# basic-flows.mjs runs them through the engine's remote inspector and
# records what each saw):
#   native   the clipboard shape WKWebView hands the page, injected: a paste
#            event that advertises Files and exposes no items, no files and
#            no text, defined exactly as the editor's vitest defines it, so
#            the real desktop command, its capability grant, the clipboard
#            read through arboard and the upload all run. WebKitGTK stands
#            in for WKWebView here; what WKWebView itself hands the page
#            stays an owner check on macOS.
#              ipc-read            the page asks the desktop for the
#                                  clipboard image directly; decides nothing
#                                  by itself and names where a fault sits.
#              paste-native-shape  the subject, on the editor (the image
#                                  embeds, lands beside the note with the
#                                  fixture's pixels, raises no notice, and
#                                  the note's file names it) and on the
#                                  composer over a terminal running cat
#                                  (it embeds, lands in the draft, and after
#                                  Ctrl+Enter by X input the terminal shows
#                                  its bare absolute path).
#              paste-text-only     control: the clipboard holds text only,
#                                  owned through GTK as an app's text copy
#                                  is (xclip would answer the image request
#                                  with its text), and the native shape is
#                                  pasted. Where the subjects held, it must
#                                  say "No image found on the clipboard"
#                                  and land nothing.
#   trusted  a real Ctrl+V into the note and into the composer under three
#            owners in turn: GTK's image copy (Gtk.Clipboard.set_image, which
#            offers image/png, bmp, jpeg, tiff and the rest GdkPixbuf
#            writes, as a screenshot tool's copy does), a GTK owner of
#            image/png alone, and xclip with image/png. The image must land
#            as above; nothing landed is a fault that names the owner, the
#            surface and the clipboard shape WebKitGTK handed the page. The
#            terminal menu's Paste row is chosen under each owner with the
#            composer open and recorded only: the row writes the
#            clipboard's text to the terminal, so it decides nothing here.
#   drop     the fixture as a File, dropped on the note's last line and on
#            the composer's as synthetic DragEvents whose DataTransfer holds
#            it: the handler's own drop branch. It must land as above, and the
#            window must stay on its page (the same document at the same
#            origin and path; the app keeps its own state in the URL's
#            search and fragment).
#   xdnd     the same drops for real, by XDND from the GTK drag source, which
#            offers the fixture's file as text/uri-list as a file manager
#            does (workspace windows leave wry's native drag handler off, so
#            the page sees the drop). Last, a real drop on the tab strip,
#            which no drop zone owns, must leave the window on its page and
#            upload nothing.
#   terminal on each backend (the preference written through the API and
#            the window reloaded, the backend read from the mounted
#            terminal): `echo M$((6*7))` typed by X input must put M42 in
#            the PTY's scrollback; then, into cat -v under bracketed paste
#            with echo off, a text with a space and a newline on the X
#            clipboard pasted by Ctrl+Shift+V and by the terminal menu's
#            Paste row must reach the PTY once and whole, in one bracketed
#            pair. A pair handed to the PTY by `cs terminal write` is the
#            readers' control.
#   editor   text typed by X input into a note's rendered mode, then a
#            Markdown heading typed in its source mode after Ctrl+E (and a
#            Ctrl+S, which chan leaves unbound), must each reach the file;
#            after a reload the editor must show both, in its mode and in
#            the other. Run under document sessions, where the server writes
#            the file, and with them off, where the page's autosave does.
#   open     a double-click by X input on a Files row must open the file in
#            the active pane's editor.
#   search   a token typed into Search (opened by Ctrl+Alt+S) must show the
#            fresh file holding it once the index answers it, and Enter must
#            open the file with the token in the editor.
#   panes    Ctrl+Alt+/ must split the pane, a click on the first pane's body
#            must make it active, a drag by X input must move a tab to the
#            other pane's strip, and Ctrl+Shift+W must close that pane's tabs
#            and then the pane; read through `cs pane list --json`.
# In every selection with an image group, a paste whose items carry the
# image as a File (which the handler reads from the event without asking
# the desktop) runs on each surface as the control: it must land, or the
# readers cannot see a landed image. It runs again on the composer after
# the other arms there.
#
# Every verdict line names the WebKitGTK version and the page's user agent.
# A fault counts only where the event reached the page as the arm built it,
# the clipboard offered what the arm needs and the same surface's controls
# landed their images; anything less is inconclusive. Exit codes are
# lib.sh's.
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

BASIC_FLOWS_ARMS="${BASIC_FLOWS_ARMS:-native,trusted,drop,xdnd,terminal,editor,open,search,panes}"
for group in ${BASIC_FLOWS_ARMS//,/ }; do
    case "$group" in
    native | trusted | drop | xdnd | terminal | editor | open | search | panes) ;;
    *)
        echo "basic-flows: cannot run: unknown arm group $group in BASIC_FLOWS_ARMS (native, trusted, drop, xdnd, terminal, editor, open, search, panes)" >&2
        exit 2
        ;;
    esac
done
obs_setup basic-flows
obs_log "arms: $BASIC_FLOWS_ARMS"
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
workspace_xid() { obs_x_local_window_titled "$WS"; }

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
    --chan "$CHAN_BIN" --work "$OBS_WORK" --results "$RESULTS" --arms "$BASIC_FLOWS_ARMS" \
    || obs_inconclusive "the arms' runner failed with status $?; the last record is in $RESULTS"

obs_log "results: $RESULTS; desktop log: $OBS_WORK/desktop.log; screenshots: $OBS_WORK/shots"
obs_verdict
node "$HERE/basic-flows.mjs" verdict --results "$RESULTS" --webkit "$WEBKIT_VERSION" 2>&1 | obs_masked
obs_judge "${PIPESTATUS[0]}" "a basic flow on chan-desktop (WebKitGTK $WEBKIT_VERSION) did not hold; the FAULT lines above name each arm and what it saw"
