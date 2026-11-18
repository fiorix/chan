#!/usr/bin/env bash
# Does the status pill cover a terminal notice's Dismiss button on WebKitGTK:
# start an index rebuild, raise a CLI reload notice, click Dismiss at its
# centre, and read what took the click. Passes when the notice is gone.
#
# Run under xvfb-run with a fixed screen, in a disposable guest, never beside
# a live chan session. Build the web bundles, chan and chan-desktop first.
#
#   CHAN_DESKTOP_BIN=target/debug/chan-desktop CHAN_BIN=target/debug/chan \
#       xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' \
#       bash scripts/e2e/desktop-observations/pillcover-dismiss.sh /tmp/pc-out
#
# Bound: about 900 s (index cooldown and rebuild dominate). Exit 0 the
# notice dismissed, 1 the pill (or anything else) took the centre click or a
# clickable Dismiss stayed, 2 the environment cannot run it, 3 inconclusive.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

output=${1:?usage: pillcover-dismiss.sh <output-dir>}
RUN=pcov$(date +%s%N | tail -c 7)
DIR="seed-$RUN"
TAB="pillcover-notice-$RUN"
COMMAND="exec sleep 600"

: "${DISPLAY:?run under xvfb-run}"
obs_setup pillcover-dismiss
obs_need node xdotool xdpyinfo import sha256sum pkg-config
mkdir -m 700 "$output"
sha256sum "$HERE/pillcover-dismiss.sh" "$HERE/inspect.mjs" "$HERE/lib.sh" > "$output/instrument-sha256.txt"
INSPECTOR="127.0.0.1:$((20000 + RANDOM % 20000))"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
openbox > "$OBS_WORK/openbox.log" 2>&1 &
OBS_PIDS+=("$!")
obs_wait 20 "the window manager" xprop -root _NET_SUPPORTING_WM_CHECK
obs_start_desktop

WS="$OBS_WORK/ws"
mkdir -p "$WS" "$WS/$DIR"
for i in 1 2 3; do printf '# seed %s\n\nRebuild trigger.\n' "$i" > "$WS/$DIR/note-$i.md"; done
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
obs_wait 60 "the native workspace window" obs_x_local_window_titled "$WS"
xid="$(obs_x_local_window_titled "$WS")"
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

dpkg-query -W libwebkit2gtk-4.1-0 > "$output/engine-package.txt" 2>/dev/null \
    || dpkg-query -W libwebkitgtk-6.0-4 > "$output/engine-package.txt" 2>/dev/null \
    || echo "webkitgtk unknown" > "$output/engine-package.txt"
ldd "$CHAN_DESKTOP_BIN" > "$output/desktop-ldd.txt"
"$CHAN_DESKTOP_BIN" --version > "$output/desktop-version.txt" 2>&1 || true
obs_log "window $xid is visible on $DISPLAY; engine $(cat "$output/engine-package.txt")"

pill_box() { page_eval "(() => { const bar = document.querySelector('.app-statusbar'); if (!bar) return null; const t = bar.textContent ?? ''; if (!/rebuilding|reindexing|indexing|embedding/i.test(t)) return null; const b = bar.getBoundingClientRect(); return { text: t.trim().slice(0, 80), box: [b.left, b.top, b.right, b.bottom] }; })()"; }
notice_present() { page_eval "!!document.querySelector('.cli-reload-notice')" | grep -q true; }

# The index section shows only while it works: wait until it is gone, so the
# rebuild below is the one the click is judged under.
obs_log "waiting for the index to idle"
idle_deadline=$((SECONDS + 180))
until [ "$(pill_box 2>/dev/null || echo null)" = "null" ]; do
    [ "$SECONDS" -lt "$idle_deadline" ] || obs_inconclusive "the index never idled"
    sleep 2
done

# A CLI tab whose first socket's frames never reach the page: the page holds
# no session id, so the reload opens a plain shell and owes the notice.
page_eval "(() => { if (window.__pcov) return window.__pcov.dials.length; window.__pcov = { dials: [] }; const Native = window.WebSocket; window.WebSocket = new Proxy(Native, { construct(target, args) { const url = new URL(String(args[0])); if (url.pathname !== '/api/terminal/ws') return Reflect.construct(target, args); window.__pcov.dials.push({ command: url.searchParams.get('command'), session: url.searchParams.get('session') }); return { readyState: Native.CONNECTING, binaryType: 'arraybuffer', close() { this.readyState = Native.CLOSED; }, send() { throw new Error('held terminal socket cannot send'); } }; } }); return window.__pcov.dials.length; })()" > /dev/null
[ "$(page_eval "typeof window.__pcov" 2>/dev/null)" = '"object"' ] || obs_inconclusive "the WebSocket proxy did not install in the inspected page"
cs terminal new --window "$CHAN_WINDOW_ID" --tab-name "$TAB" --command "$COMMAND" > "$OBS_WORK/new-tab.out" 2>&1 || obs_inconclusive "the CLI tab was not created: $(cat "$OBS_WORK/new-tab.out")"
# The request queues; prove the tab exists server-side before waiting for
# its dial, so a lost request and a silent page fail in different places.
tab_listed() {
    CHAN_CONTROL_SOCKET="$CHAN_CONTROL_SOCKET" cs terminal list --json 2>/dev/null |
        python3 -c 'import json,sys; rows=[r for g in json.load(sys.stdin).get("groups", {}).values() for r in g]; print(any(r.get("name") == sys.argv[1] for r in rows))' "$TAB" 2>/dev/null | grep -q True
}
obs_wait 60 "the CLI tab to appear server-side" tab_listed
obs_log "waiting for the held dial"
held_deadline=$((SECONDS + 60))
until [ "$(page_eval "window.__pcov.dials.length" 2>/dev/null || echo 0)" -gt 0 ] 2>/dev/null; do
    if [ "$SECONDS" -ge "$held_deadline" ]; then
        obs_log "no dial observed; inspector pages: $(node "$HERE/inspect.mjs" "$INSPECTOR" list 2>/dev/null | head -c 600 || echo unreadable)"
        CHAN_CONTROL_SOCKET="$CHAN_CONTROL_SOCKET" cs terminal list --json > "$OBS_WORK/tabs-at-timeout.json" 2>&1 || true
        CHAN_CONTROL_SOCKET="$CHAN_CONTROL_SOCKET" cs pane list --window "$CHAN_WINDOW_ID" --json > "$OBS_WORK/panes-at-timeout.json" 2>&1 || true
        page_eval "document.readyState" > "$OBS_WORK/ready-at-timeout.txt" 2>&1 || true
        obs_inconclusive "the CLI tab never dialled (state in tabs-at-timeout.json, panes-at-timeout.json and the inspector list above)"
    fi
    sleep 1
done
page_eval "location.reload()" > /dev/null 2>&1 || true
obs_wait 60 "the CLI reload notice" notice_present
obs_shot "pillcover-notice.png"

# Start the rebuild the click is judged under: rename the seeded directory
# and wait for the pill. The 30 s index cooldown plus the rebuild fit the
# bound below.
mv "$WS/$DIR" "$WS/$DIR-renamed"
obs_log "waiting for the index pill"
pill=""
pill_deadline=$((SECONDS + 420))
until pill="$(pill_box 2>/dev/null)" && [ "$pill" != "null" ]; do
    [ "$SECONDS" -lt "$pill_deadline" ] || obs_inconclusive "the index pill never showed after the rename"
    sleep 2
done
printf '%s\n' "$pill" > "$output/pill.json"
obs_log "pill $pill"

hit_at() {
    page_eval "(() => { const node = document.querySelector('$1'); if (!node) return null; const b = node.getBoundingClientRect(); const point = { x: b.left + b.width / 2, y: b.top + b.height / 2 }; const cover = document.elementFromPoint(point.x, point.y); const describe = (n) => n ? { tag: n.tagName, classes: n.getAttribute('class'), role: n.getAttribute('role'), label: n.getAttribute('aria-label'), text: (n.textContent ?? '').trim().slice(0, 80) } : null; return { box: [b.left, b.top, b.right, b.bottom], cover: describe(cover), statusbar: !!(cover && cover.closest('.app-statusbar')), onButton: !!(cover && node.contains(cover)) }; })()"
}

# Control: with the pill up, the Dismiss button's centre must still be the
# button itself. Anything else names the covering element.
dismiss_hit="$(hit_at '.cli-reload-notice button[aria-label="Dismiss notice"]')"
printf '%s\n' "$dismiss_hit" > "$output/dismiss-hit.json"
obs_log "dismiss hit $dismiss_hit"
find_hit="$(hit_at '.terminal-find' || echo null)"
printf '%s\n' "$find_hit" > "$output/find-hit.json"
inspector_hit="$(hit_at '.inspector .close' || echo null)"
printf '%s\n' "$inspector_hit" > "$output/inspector-hit.json"
obs_shot "pillcover-before-click.png"

echo "$dismiss_hit" | grep -q '"statusbar":true' && obs_fault "Dismiss centre is covered by the status pill: $dismiss_hit"
echo "$dismiss_hit" | grep -q '"onButton":true' || obs_inconclusive "Dismiss centre hits neither the button nor the pill: $dismiss_hit"

point="$(echo "$dismiss_hit" | python3 -c 'import json,sys; b = json.load(sys.stdin)["box"]; print(int((b[0] + b[2]) / 2), int((b[1] + b[3]) / 2))')"
xdotool windowactivate --sync "$xid"
# shellcheck disable=SC2086
xdotool mousemove --sync $point click 1
sleep 1
obs_shot "pillcover-after-click.png"
if notice_present; then
    again="$(hit_at '.cli-reload-notice button[aria-label="Dismiss notice"]')"
    printf '%s\n' "$again" > "$output/dismiss-hit-after.json"
    echo "$again" | grep -q '"statusbar":true' && obs_fault "Dismiss stayed visible; the centre click landed on the status pill: $again"
    obs_fault "Dismiss stayed visible after a centre click on the button: $again"
fi

cs terminal close --tab-name "$TAB" > /dev/null 2>&1 || true
obs_log "pillcover-dismiss: PASS on $(cat "$output/engine-package.txt")"
obs_shot "pillcover-dismissed.png"
echo "pillcover-dismiss: PASS"
