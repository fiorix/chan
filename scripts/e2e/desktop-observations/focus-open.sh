#!/usr/bin/env bash
# Does a browser's Focus, Show or Open on a window that a desktop has hidden
# leave both a browser window and a native window on the one record?
#
# A browser on a devserver's launcher has no desktop to ask, so its Focus
# opens a browser window for the record and then clears the record's hidden
# state. The desktop also watches that record. The arms distinguish a hide
# made by this desktop from one made by the devserver, since the desktop
# tracks its own hides separately.
#
# This runs a real `chan devserver run`, a real chan-desktop under Xvfb
# connected to it directly, and one headless Chrome on the devserver's own
# launcher (focus-open-browser.mjs). Each arm serves a workspace of its own,
# opens its one window natively, hides it, makes one gesture in the browser,
# and reads, six seconds on: the record on the devserver (hidden, connected,
# how many sockets hold it), the X windows of the devserver by id, and the
# pages the browser opened.
#
# Arms, as "<gesture>:<who hid>", in the order OBS_ARMS gives. The hide is
# `server` (the devserver's own visibility route, as another client's hide
# arrives) or `desktop` (the Hide button of the desktop's own launcher):
#
#   focus   the launcher deck's Focus on the hidden window
#   show    the launcher deck's Show
#   open    the launcher row's Open button
#   deck    Show in the window deck of a browser window of the same
#           workspace, opened from the launcher after the hide
#
# And one arm of another shape, `led-terminal`: a second terminal window of
# the devserver, hidden through the devserver, while the desktop holds the
# devserver's first terminal. All terminal windows share one tenant, which
# the desktop's window then leads, so the browser's launcher should offer
# this window no deck action and a disabled Show, and Open alone. The arm
# records what the row and the deck offer, clicks Open, and reads the same
# three things.
#
# Default: focus:server focus:desktop show:server open:server deck:server
# led-terminal.
#
# Two controls, each of which must hold or the run is inconclusive:
#
#   no-desktop  before any desktop is connected, the browser's New terminal
#               opens a terminal of the devserver, one page and one holder,
#               and once that page is closed the row's Open opens it again.
#               The decision keeps this path whatever else changes.
#   hidden      in every arm, before the gesture: the record reads hidden,
#               no socket holds it, and X no longer shows its window.
#
# An arm's outcome is one of: both (a browser page on the record AND a
# visible native window with the target's pre-hide title, and the target
# record connected with its original desktop holder plus a browser holder),
# browser, native, neither, not-offered (the page did not offer the
# gesture, which is an answer: a launcher offers a window's actions only
# for a tenant without a leader or one whose leader it opened).
#
# The fault is `both`, in any arm. Other valid outcomes end 0 if at least
# one gesture was offered; helper errors, unlinked X windows and an all-
# not-offered run are inconclusive. No contract yet says which single
# window a gesture should give; that is the decision this observation is for.
#
# Speaks for WebKitGTK, a direct connection, and Chrome as the browser.
# "In front" and "focused" mean nothing under Xvfb and are not read.
#
# Needs what lib.sh needs, CHROME_BIN, and puppeteer-core under the browser
# smoke's node_modules. Exit codes are lib.sh's.
#
# The devserver and window readers use the same protocol as the restart
# observation driver.
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name. The directive
# stands before the first command so that it covers the file.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup focus-open
obs_need node
OBS_SMOKE_DIR="${OBS_SMOKE_DIR:-$HERE/../browser-smoke}"
export OBS_SMOKE_DIR
[ -d "$OBS_SMOKE_DIR/node_modules/puppeteer-core" ] || obs_refuse "no puppeteer-core under $OBS_SMOKE_DIR/node_modules (npm ci in scripts/e2e/browser-smoke, or set OBS_SMOKE_DIR)"
[ -n "${CHROME_BIN:-}" ] && [ -x "$CHROME_BIN" ] || obs_refuse "CHROME_BIN names no Chrome (scripts/e2e/browser-smoke/provision.sh installs one)"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display

DEV_HOME="$OBS_WORK/devserver-home"
PORT="${PORT:-$((20000 + RANDOM % 20000))}"
[ "127.0.0.1:$PORT" != "$INSPECTOR" ] || PORT=$((PORT + 1))
BASE="http://127.0.0.1:$PORT"
mkdir -p "$DEV_HOME"
RESULTS="$OBS_WORK/results.jsonl"
: > "$RESULTS"
DEV_PID=""

start_devserver() {
    CHAN_HOME="$DEV_HOME" CHAN_LOG="${OBS_DEVSERVER_LOG:-warn,chan_server=info}" \
        "$CHAN_BIN" devserver run --service=none --bind 127.0.0.1 --port "$PORT" > "$OBS_WORK/devserver.log" 2>&1 &
    DEV_PID=$!
    OBS_PIDS+=("$DEV_PID")
    obs_wait 60 "the devserver to listen" grep -q "listening on http://" "$OBS_WORK/devserver.log"
}

api() {
    # api <method> <path> [json-body]: body, then the status on its own line.
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        curl -sS -m 10 -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
            --data "$body" -w '\n%{http_code}' "$BASE$path"
    else
        curl -sS -m 10 -X "$method" -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}' "$BASE$path"
    fi
}

connected() {
    chan devserver ls --json 2>/dev/null | python3 -c '
import json, sys
rows = json.load(sys.stdin)["devservers"]
sys.exit(0 if [r for r in rows if r["label"] == "lab" and r["status"] == "connected"] else 1)'
}

native_windows() {
    obs_x_windows | awk -v base=" $BASELINE_IDS " 'index(base, " " $1 " ") == 0' | sort
}
native_ids() { native_windows | cut -d' ' -f1 | tr '\n' ' '; }
# The target's title is captured while its record is the only newly minted
# window. Match the whole title so a late window from another arm cannot
# count as the target's native side.
target_native_ids() { native_windows | awk -v title="$1" 'substr($0, index($0, " ") + 1) == title { print $1 }'; }
# x_state <id>: "shown", "hidden" or "gone", as X answers for the id.
x_state() {
    if ! xdotool getwindowname "$1" >/dev/null 2>&1; then
        echo gone
    elif obs_x_windows | cut -d' ' -f1 | grep -qx -- "$1"; then
        echo shown
    else
        echo hidden
    fi
}

# record <id|workspace> <value>: the devserver's record of one window,
# reduced to what the arms read. By workspace there must be exactly one
# window. Fails when there is no such record.
record() {
    api GET /api/library/windows | python3 -c '
import json, sys
by, value = sys.argv[1:3]
body = sys.stdin.read().rsplit("\n", 1)[0]
rows = json.loads(body)
if by == "id":
    rows = [r for r in rows if r.get("window_id") == value]
else:
    rows = [r for r in rows if r.get("workspace_path") == value]
if len(rows) != 1:
    sys.exit(1)
r = rows[0]
print(json.dumps({
    "window_id": r["window_id"],
    "kind": r.get("kind"),
    "ordinal": r.get("ordinal"),
    "origin": r.get("origin"),
    "hidden": bool(r.get("hidden")),
    "connected": bool(r.get("connected")),
    "holders": len(r.get("holders") or []),
    "holderTags": r.get("holders") or [],
}))' "$1" "$2"
}
field() { python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }
json_string() { python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'; }
one_holder() { printf '%s' "$1" | python3 -c 'import json, sys; tags = json.load(sys.stdin)["holderTags"]; sys.exit(0 if len(tags) == 1 else 1)'; }
holder_tag() { printf '%s' "$1" | python3 -c 'import json, sys; print(json.load(sys.stdin)["holderTags"][0])'; }

# The browser, kept open for the run and asked one line at a time.
coproc BROWSER { node "$HERE/focus-open-browser.mjs" 2> "$OBS_WORK/browser.err"; }
OBS_PIDS+=("$BROWSER_PID")
# Bash closes coprocess descriptors in command substitutions. The driver
# asks through command substitutions, so ordinary duplicates keep the same
# pipes available there.
exec {BROWSER_READ}<&"${BROWSER[0]}"
exec {BROWSER_WRITE}>&"${BROWSER[1]}"
ask() {
    local reply
    printf '%s\n' "$*" >&"$BROWSER_WRITE"
    IFS= read -r -t 120 reply <&"$BROWSER_READ" || obs_inconclusive "the browser did not answer within 120s; its stderr: $(obs_masked < "$OBS_WORK/browser.err" | tail -3 | tr '\n' ' ')"
    printf '%s\n' "$reply"
}
# page_window <page index>: the window id in that page's address, or
# nothing while the page is still blank. A page the browser opens for a
# window may be blank first and navigate after.
page_window() {
    local listed
    # Asked in a command substitution: the browser's pipes are not there in
    # a pipeline's subshell.
    listed="$(ask pages)"
    printf '%s' "$listed" | python3 -c '
import json, sys, urllib.parse as u
page = next((p for p in json.load(sys.stdin)["pages"] if p["index"] == int(sys.argv[1]) and p["url"]), None)
print(u.parse_qs(u.urlsplit(page["url"]).query).get("w", [""])[0] if page else "")' "$1"
}
# says <json> <python expression over v>: a yes or no question of an answer.
says() { printf '%s' "$1" | python3 -c 'import json, sys; v = json.load(sys.stdin); sys.exit(0 if eval(sys.argv[1]) else 1)' "$2" "${@:3}"; }

# 1. The devserver and the browser's launcher, before any desktop.
start_devserver
# The bearer comes from the devserver's own 0600 config, never from a log.
TOKEN="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["devserver_token"])' "$DEV_HOME/devserver/config.json" 2>/dev/null || true)"
[ -n "$TOKEN" ] || obs_inconclusive "no devserver_token in $DEV_HOME/devserver/config.json"
LAUNCHER="$(ask "launcher $BASE/?t=$TOKEN")"
says "$LAUNCHER" 'v["ok"]' || obs_inconclusive "the browser did not open the devserver's launcher: $(printf '%s' "$LAUNCHER" | obs_masked)"
# The launcher's page number among the browser's pages, for its deck.
LP="$(printf '%s' "$LAUNCHER" | field page)"

# Control: with no desktop, the browser opens a terminal of the devserver
# and, once that page is closed, opens it again from its row.
control_no_desktop() {
    local made made_page wid held rows again after
    made="$(ask newterm)"
    printf '%s\n' "$made" | obs_masked > "$OBS_WORK/no-desktop.new.json"
    says "$made" 'v["ok"] and len(v["popups"]) == 1' || obs_inconclusive "no-desktop: New terminal opened no single page: $(printf '%s' "$made" | obs_masked)"
    made_page="$(printf '%s' "$made" | python3 -c 'import json, sys; print(json.load(sys.stdin)["popups"][0]["index"])')"
    names_a_window() { [ -n "$(page_window "$made_page")" ]; }
    obs_wait 30 "no-desktop: the new page's address to name its window" names_a_window
    wid="$(page_window "$made_page")"
    held_by_one() { says "$(record id "$wid")" 'v["connected"] and v["holders"] == 1'; }
    obs_wait 30 "no-desktop: the new terminal held by one socket" held_by_one
    held="$(record id "$wid")"
    ask "close $made_page" >/dev/null
    released() { says "$(record id "$wid")" 'not v["connected"]'; }
    obs_wait 30 "no-desktop: the terminal released once its page is closed" released
    # Open, from the row, when the launcher lists that one terminal alone.
    rows="$(ask terms)"
    again=null
    after=null
    says "$rows" 'v["ok"] and len(v["rows"]) == 1' || obs_inconclusive "no-desktop: the launcher does not list one terminal row alone, so the Open control cannot identify the row: $(printf '%s' "$rows" | obs_masked | cut -c1-300)"
    again="$(ask "termclick 0 Open window")"
    says "$again" 'v["ok"] and len(v["popups"]) == 1' || obs_inconclusive "no-desktop: Open on the terminal's row opened no single page: $(printf '%s' "$again" | obs_masked)"
    obs_wait 30 "no-desktop: the reopened terminal held by one socket" held_by_one
    after="$(record id "$wid")"
    ask "close $(printf '%s' "$again" | python3 -c 'import json, sys; print(json.load(sys.stdin)["popups"][0]["index"])')" >/dev/null
    obs_wait 30 "no-desktop: the terminal released again" released
    printf '{"arm":"no-desktop","window":"%s","new":%s,"held":%s,"reopen":%s,"heldAgain":%s}\n' "$wid" "$made" "$held" "$again" "$after" | obs_masked >> "$RESULTS"
    obs_log "no-desktop: $(tail -1 "$RESULTS" | cut -c1-500)"
}
control_no_desktop

# 2. The desktop, connected to the devserver directly.
obs_start_desktop
obs_log "desktop build: $(grep -m1 -o 'build[^ ]*git-[0-9a-f]*[^ ]*' "$OBS_WORK/desktop.log" | sed 's/\x1b\[[0-9;]*m//g' || echo unknown)"
an_x_window() { [ -n "$(obs_x_windows)" ]; }
obs_wait 60 "the launcher window" an_x_window
obs_wait 30 "chan devserver ls to answer" chan devserver ls
sleep 5
BASELINE_IDS="$(obs_x_windows | cut -d' ' -f1 | tr '\n' ' ')"
obs_log "the desktop's own windows, not watched: $BASELINE_IDS"
chan devserver register "$BASE/?t=$TOKEN" --name lab > "$OBS_WORK/register.out" 2>&1 || obs_inconclusive "register: $(obs_masked < "$OBS_WORK/register.out")"
chan devserver connect lab > "$OBS_WORK/connect.out" 2>&1 || obs_inconclusive "connect: $(obs_masked < "$OBS_WORK/connect.out")"
obs_wait 60 "the devserver to connect" connected
a_native_window() { [ -n "$(native_ids)" ]; }
obs_wait 90 "the devserver's first terminal as a native window" a_native_window
sleep 5

# The desktop's own Hide, on the lone window row of a workspace's card in
# the desktop's launcher page: expand the card, then click the button.
desktop_hide_step() {
    node "$HERE/inspect.mjs" "$INSPECTOR" eval "Chan Launcher" "(() => {
  const card = [...document.querySelectorAll('.ws-card')].find((c) => (c.querySelector('.ws-head .row-name')?.textContent ?? '').includes('$1'));
  if (!card) return 'no card';
  const chevron = card.querySelector('button.chevron[aria-expanded=\"false\"]');
  if (chevron) { chevron.click(); return 'expanded'; }
  const hide = card.querySelector('.ws-windows .row button[aria-label^=\"Hide window\"]');
  if (!hide) return 'no hide button';
  hide.click();
  return 'clicked';
})()" | grep -qx '"clicked"'
}

# new_native <ids before>: the first native window of the devserver that
# was not among them; fails while there is none.
new_native() { native_ids | tr ' ' '\n' | grep . | grep -v -x -F -f <(printf '%s' "$1" | tr ' ' '\n' | grep . || true) | sed -n 1p | grep .; }
# hidden_and_released <window id> <x id>: the record hidden and held by no
# socket, and its native window no longer on the screen.
hidden_and_released() { says "$(record id "$1")" 'v["hidden"] and not v["connected"] and v["holders"] == 0' && [ "$(x_state "$2")" != shown ]; }
terminal_ids() {
    api GET /api/library/windows | python3 -c '
import json, sys
for r in json.loads(sys.stdin.read().rsplit("\n", 1)[0]):
    if r.get("kind") == "terminal":
        print(r["window_id"])'
}

# read_after <arm> <window id> <browser answer> <native ids before> <target title> <desktop holder> <target X id>:
# six seconds after a gesture, the record, the native windows that are new,
# whether a browser page is on the record, and the outcome those make. Sets
# POST, NATIVES_NEW, TARGET_NATIVES, BROWSER_PAGE and OUTCOME.
read_after() {
    local arm="$1" wid="$2" answer="$3" natives_pre="$4" target_title="$5" desktop_holder="$6" target_xid="$7" pages_now
    printf '%s\n' "$answer" | obs_masked > "$OBS_WORK/$arm.answer.json"
    # Long enough for a native window to be built after an un-hide.
    sleep 6
    POST="$(record id "$wid")" || obs_inconclusive "$arm: the record is gone after the gesture"
    printf '%s\n' "$POST" | obs_masked > "$OBS_WORK/$arm.record-after.json"
    NATIVES_NEW="$(native_ids | tr ' ' '\n' | grep . | grep -v -x -F -f <(printf '%s' "$natives_pre" | tr ' ' '\n' | grep . || true) | tr '\n' ' ' || true)"
    NATIVES_NEW="${NATIVES_NEW% }"
    TARGET_NATIVES="$(target_native_ids "$target_title" | tr '\n' ' ')"
    TARGET_NATIVES="${TARGET_NATIVES% }"
    obs_x_windows | obs_masked > "$OBS_WORK/$arm.x-after.txt"
    obs_shot "$arm-2-after"
    # Read from the pages open now: a page the gesture opened may have been
    # blank when it appeared.
    pages_now="$(ask pages)"
    printf '%s\n' "$pages_now" | obs_masked > "$OBS_WORK/$arm.pages.json"
    says "$pages_now" 'v.get("ok") is True' || obs_inconclusive "$arm: the browser page inventory failed: $(printf '%s' "$pages_now" | obs_masked)"
    BROWSER_PAGE="$(printf '%s' "$pages_now" | python3 -c '
import json, sys, urllib.parse as u
pages = [p for p in json.load(sys.stdin)["pages"] if p["url"] and not p["closed"]]
print("yes" if any(u.parse_qs(u.urlsplit(p["url"]).query).get("w", [""])[0] == sys.argv[1] for p in pages) else "no")' "$wid")"
    if [ -z "$TARGET_NATIVES" ] && { [ -n "$NATIVES_NEW" ] || [ "$(x_state "$target_xid")" = shown ]; }; then
        obs_inconclusive "$arm: X shows a native window after the gesture but its title does not identify the target; new X ids: ${NATIVES_NEW:-none}; original X id: $target_xid; raw ids and titles in $OBS_WORK/$arm.x-after.txt"
    fi
    if [ "$BROWSER_PAGE" = yes ] && [ -n "$TARGET_NATIVES" ]; then
        says "$POST" 'v["connected"] and len(v["holderTags"]) >= 2 and sys.argv[2] in v["holderTags"]' "$desktop_holder" || obs_inconclusive "$arm: browser and target-titled native windows are visible, but the target record lacks its original desktop holder plus another holder: $POST; target X ids: $TARGET_NATIVES"
        OUTCOME=both
    elif ! says "$answer" 'v.get("ok") is True'; then
        if says "$answer" 'v.get("notOffered") is True and "error" not in v and "threw" not in v' && [ "$BROWSER_PAGE" = no ] && [ -z "$TARGET_NATIVES" ]; then
            OUTCOME=not-offered
        else
            obs_inconclusive "$arm: the browser helper failed or contradicted the observed surfaces: $(printf '%s' "$answer" | obs_masked); target X ids: ${TARGET_NATIVES:-none}; browser page: $BROWSER_PAGE"
        fi
    elif [ "$BROWSER_PAGE" = yes ]; then
        OUTCOME=browser
    elif [ -n "$TARGET_NATIVES" ]; then
        OUTCOME=native
    else
        OUTCOME=neither
    fi
}

# close_popups <answers...>: close every page the answers say was opened.
# The browser's pipes are not there in a pipeline's subshell, so the page
# numbers are collected first and the asking is done here.
close_popups() {
    local index
    for index in $(printf '%s ' "$@" | python3 -c '
import json, sys
decoder, text, at = json.JSONDecoder(), sys.stdin.read(), 0
while at < len(text):
    while at < len(text) and text[at].isspace():
        at += 1
    if at >= len(text):
        break
    value, at = decoder.raw_decode(text, at)
    for page in value.get("popups", []):
        print(page["index"])'); do
        ask "close $index" >/dev/null
    done
}

# gesture_arm <gesture> <who hid>
gesture_arm() {
    local gesture="$1" origin="$2" arm="$1-$2" name="ws-$1-$2" dir before_mint xid wid pre answer natives_pre target_title desktop_holder helper='{}'
    dir="$OBS_WORK/$name"
    mkdir -p "$dir"
    printf '# note\n' > "$dir/a.md"
    chan workspace serve "$dir" --on lab > "$OBS_WORK/$arm.serve.out" 2>&1 || obs_inconclusive "$arm: serve --on: $(obs_masked < "$OBS_WORK/$arm.serve.out")"
    before_mint=" $(native_ids)"
    answer="$(api POST /api/library/windows "{\"kind\":\"workspace\",\"workspace_path\":\"$dir\"}")"
    [ "${answer##*$'\n'}" = "200" ] || obs_inconclusive "$arm: minting the window answered: $(printf '%s' "$answer" | obs_masked)"
    obs_wait 90 "$arm: the window as a native window" new_native "$before_mint"
    sleep 4
    xid="$(new_native "$before_mint")"
    pre="$(record workspace "$dir")" || obs_inconclusive "$arm: the devserver does not list one window for $dir"
    wid="$(printf '%s' "$pre" | field window_id)"
    says "$pre" 'v["origin"] == "native" and v["connected"] and not v["hidden"]' || obs_inconclusive "$arm: the window is not a shown, connected, native record before the hide: $pre"
    one_holder "$pre" || obs_inconclusive "$arm: the new native record has no unique desktop holder before the hide: $pre"
    desktop_holder="$(holder_tag "$pre")"
    target_title="$(xdotool getwindowname "$xid")" || obs_inconclusive "$arm: the new native X window has no title"
    [[ "$target_title" == *"$name"* ]] && [ "$(target_native_ids "$target_title")" = "$xid" ] || obs_inconclusive "$arm: the new native X title does not uniquely identify $name: $xid $target_title"
    printf '%s\n' "$pre" | obs_masked > "$OBS_WORK/$arm.record-native.json"

    # The hide, and the control that it took.
    case "$origin" in
    server)
        answer="$(api POST "/api/library/windows/$wid/visibility" '{"hidden":true}')"
        [ "${answer##*$'\n'}" = "204" ] || obs_inconclusive "$arm: the devserver's hide answered: $(printf '%s' "$answer" | obs_masked)"
        ;;
    desktop)
        obs_wait 30 "$arm: the Hide button of the desktop's launcher" desktop_hide_step "$name"
        ;;
    *) obs_inconclusive "unknown hide $origin" ;;
    esac
    obs_wait 30 "$arm: the record hidden, held by nobody, and its native window off the screen" hidden_and_released "$wid" "$xid"
    sleep 2
    pre="$(record id "$wid")"
    printf '%s\n' "$pre" | obs_masked > "$OBS_WORK/$arm.record-before.json"
    natives_pre=" $(native_ids)"
    obs_shot "$arm-1-hidden"

    # The gesture, in the browser.
    case "$gesture" in
    focus) answer="$(ask "deck $LP Windows|$name|Focus")" ;;
    show) answer="$(ask "deck $LP Windows|$name|Show")" ;;
    open) answer="$(ask "click $name Open window")" ;;
    deck)
        # A browser window of the same workspace first, then its own deck.
        helper="$(ask "deck $LP New window|$name")"
        says "$helper" 'v["ok"] and len(v["popups"]) == 1' || obs_inconclusive "$arm: the launcher opened no browser window of the workspace: $(printf '%s' "$helper" | obs_masked)"
        sleep 5
        answer="$(ask "deck $(printf '%s' "$helper" | python3 -c 'import json, sys; print(json.load(sys.stdin)["popups"][0]["index"])') Windows|Hidden|Show")"
        ;;
    *) obs_inconclusive "unknown gesture $gesture" ;;
    esac
    read_after "$arm" "$wid" "$answer" "$natives_pre" "$target_title" "$desktop_holder" "$xid"
    printf '{"arm":"%s","gesture":"%s","hid":"%s","window":"%s","outcome":"%s","browserPage":"%s","newNative":"%s","targetNative":"%s","targetTitle":%s,"hiddenWindowNow":"%s","before":%s,"after":%s,"answer":%s}\n' \
        "$arm" "$gesture" "$origin" "$wid" "$OUTCOME" "$BROWSER_PAGE" "$NATIVES_NEW" "$TARGET_NATIVES" "$(printf '%s' "$target_title" | json_string)" "$(x_state "$xid")" "$pre" "$POST" "$answer" | obs_masked >> "$RESULTS"
    obs_log "$arm: outcome $OUTCOME; record before $pre, after $POST; new native windows: ${NATIVES_NEW:-none}; target X title: $target_title; target X ids: ${TARGET_NATIVES:-none}"
    # Close what the browser opened, so the next arm starts from one page.
    close_popups "$answer" "$helper"
    # A record the gesture left hidden is shown again through the devserver,
    # so a later arm's window deck lists one hidden window, its own.
    if says "$(record id "$wid")" 'v["hidden"]'; then
        api POST "/api/library/windows/$wid/visibility" '{"hidden":false}' > /dev/null
        sleep 4
    fi
}

# led_terminal_arm: what a browser is offered for a hidden terminal window
# while the desktop holds the devserver's first terminal.
led_terminal_arm() {
    local arm=led-terminal before_mint before_ids answer xid wid pre rows index listed natives_pre target_title desktop_holder
    before_mint=" $(native_ids)"
    before_ids="$(terminal_ids)"
    answer="$(api POST /api/library/windows '{"kind":"terminal"}')"
    [ "${answer##*$'\n'}" = "200" ] || obs_inconclusive "$arm: minting a terminal window answered: $(printf '%s' "$answer" | obs_masked)"
    obs_wait 90 "$arm: the terminal as a native window" new_native "$before_mint"
    sleep 4
    xid="$(new_native "$before_mint")"
    wid="$(terminal_ids | grep -v -x -F -f <(printf '%s\n' "$before_ids") | sed -n 1p || true)"
    [ -n "$wid" ] || obs_inconclusive "$arm: the devserver lists no new terminal window"
    pre="$(record id "$wid")"
    says "$pre" 'v["origin"] == "native" and v["connected"] and not v["hidden"]' || obs_inconclusive "$arm: the terminal is not a shown, connected, native record before the hide: $pre"
    one_holder "$pre" || obs_inconclusive "$arm: the new native terminal has no unique desktop holder before the hide: $pre"
    desktop_holder="$(holder_tag "$pre")"
    target_title="$(xdotool getwindowname "$xid")" || obs_inconclusive "$arm: the new native X window has no title"
    [[ "$target_title" == *"Terminal Window $(printf '%s' "$pre" | field ordinal)"* ]] && [ "$(target_native_ids "$target_title")" = "$xid" ] || obs_inconclusive "$arm: the new native X title does not uniquely identify the terminal's ordinal: $xid $target_title; record $pre"
    printf '%s\n' "$pre" | obs_masked > "$OBS_WORK/$arm.record-native.json"
    answer="$(api POST "/api/library/windows/$wid/visibility" '{"hidden":true}')"
    [ "${answer##*$'\n'}" = "204" ] || obs_inconclusive "$arm: the devserver's hide answered: $(printf '%s' "$answer" | obs_masked)"
    obs_wait 30 "$arm: the record hidden, held by nobody, and its native window off the screen" hidden_and_released "$wid" "$xid"
    sleep 2
    pre="$(record id "$wid")"
    printf '%s\n' "$pre" | obs_masked > "$OBS_WORK/$arm.record-before.json"
    natives_pre=" $(native_ids)"
    obs_shot "$arm-1-hidden"
    # What the browser's launcher offers: the one terminal row with a Show
    # button is the hidden one; and the windows its deck lists at all.
    rows="$(ask terms)"
    index="$(printf '%s' "$rows" | python3 -c '
import json, sys
rows = json.load(sys.stdin).get("rows", [])
hits = [i for i, r in enumerate(rows) if any(b["label"] == "Show window" for b in r["buttons"])]
print(hits[0] if len(hits) == 1 else "")')"
    [ -n "$index" ] || obs_inconclusive "$arm: the browser's launcher does not list one terminal row with a Show button: $(printf '%s' "$rows" | obs_masked | cut -c1-400)"
    listed="$(ask "deck $LP Windows|?")"
    answer="$(ask "termclick $index Open window")"
    read_after "$arm" "$wid" "$answer" "$natives_pre" "$target_title" "$desktop_holder" "$xid"
    printf '{"arm":"%s","gesture":"open","hid":"server","window":"%s","outcome":"%s","browserPage":"%s","newNative":"%s","targetNative":"%s","targetTitle":%s,"hiddenWindowNow":"%s","before":%s,"after":%s,"answer":%s,"row":%s,"deckWindows":%s}\n' \
        "$arm" "$wid" "$OUTCOME" "$BROWSER_PAGE" "$NATIVES_NEW" "$TARGET_NATIVES" "$(printf '%s' "$target_title" | json_string)" "$(x_state "$xid")" "$pre" "$POST" "$answer" \
        "$(printf '%s' "$rows" | python3 -c 'import json, sys; print(json.dumps(json.load(sys.stdin)["rows"][int(sys.argv[1])]))' "$index")" "$listed" | obs_masked >> "$RESULTS"
    obs_log "$arm: outcome $OUTCOME; the row offers $(tail -1 "$RESULTS" | python3 -c 'import json, sys; r = json.loads(sys.stdin.read()); print([(b["label"] or b["title"], "disabled" if b["disabled"] else "enabled") for b in r["row"]["buttons"]])'); record before $pre, after $POST; target X title: $target_title; target X ids: ${TARGET_NATIVES:-none}"
    close_popups "$answer"
}

for arm in ${OBS_ARMS:-focus:server focus:desktop show:server open:server deck:server led-terminal}; do
    case "$arm" in
    led-terminal) led_terminal_arm ;;
    *) gesture_arm "${arm%%:*}" "${arm##*:}" ;;
    esac
done
PAGES="$(ask pages)"
printf '%s\n' "$PAGES" | obs_masked > "$OBS_WORK/pages.final.json"
if [ -n "${BROWSER_WRITE:-}" ]; then
    printf 'quit\n' >&"$BROWSER_WRITE"
fi

obs_verdict
sed 's/\x1b\[[0-9;]*m//g' "$OBS_WORK/desktop.log" | grep -n -i -e 'window watcher' -e 'bury' -e 'hide' -e 'opening' | obs_masked > "$OBS_WORK/desktop.window-lines.txt"
python3 - "$RESULTS" <<'PY'
import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
arms = [r for r in rows if "outcome" in r]
for r in arms:
    print(f"focus-open: {r['arm']}: {r['outcome']} (holders {r['before']['holders']} -> {r['after']['holders']}, hidden {r['before']['hidden']} -> {r['after']['hidden']}, target native [{r['targetNative']}], all new native [{r['newNative']}], browser page {r['browserPage']})", file=sys.stderr)
if not arms:
    print("focus-open: INCONCLUSIVE: no arm reached its gesture", file=sys.stderr)
    sys.exit(3)
if all(r["outcome"] == "not-offered" for r in arms):
    print("focus-open: INCONCLUSIVE: the browser was offered none of the gestures, so nothing was observed of them", file=sys.stderr)
    sys.exit(3)
both = [r["arm"] for r in arms if r["outcome"] == "both"]
if both:
    print(f"focus-open: FAULT: one gesture left a browser page and a native window on one record in {both}", file=sys.stderr)
    sys.exit(10)
print("focus-open: PASS: no gesture left both a browser page and a native window on one record (WebKitGTK, direct connection, Chrome)", file=sys.stderr)
PY
obs_judge "$?" "a browser's gesture on a window the desktop had hidden left both a browser window and a native window on the one record (WebKitGTK, direct connection, Chrome)"
