#!/usr/bin/env bash
# Does a PDF exported from the real desktop hold the pictures a drawing
# shows on the page, and does `cs export` give what the window's own
# Export to PDF gives?
#
# The drawing check requires the picture in the visible window before it
# judges the PDF. Command export has a 90 s progress bound and a 15 minute
# absolute bound (crates/chan-server/src/window_bus.rs).
#
# This runs a real chan-desktop under Xvfb on a workspace seeded by
# make-seed.py and exports through the desktop's own window, by the command
# and by the window's Export to PDF. The PDFs' page pixels are read with the
# browser smoke's reader (pdf-read.mjs), the window's own with
# window-colours.py.
#
# Arms, in the order OBS_ARMS gives (default: drawing deck two-windows):
#
#   drawing      drawing-picture.md: one ordinary image and a drawing that
#                holds one rotated and one cropped picture. Counts only if
#                the window, captured before any export, shows the ordinary
#                image and both pictures and none of what the crop cuts
#                away. The fault is a PDF that holds the ordinary image and
#                lacks a picture of the drawing, or holds what the crop cuts
#                away. A PDF without the ordinary image is another fault
#                than this one, and the arm says so as inconclusive.
#   deck         deck.md, three slides. The fault is a command export that
#                has not ended 16 minutes on, or a command PDF whose page
#                count differs from the window's own export's, or that lacks
#                a seeded colour the window's own export holds.
#   two-windows  the deck again by the command, with a second window of the
#                workspace open, once naming the first window and once
#                naming none. Notes which window rendered and how long it
#                took. It reports the hang as the deck arm does and judges
#                nothing else.
#
# An export that ends with an error inside its bound is not the hang: the
# arm records the error's text and is inconclusive, because what it would
# compare was not written.
#
# Elapsed times are recorded and never judged: a slow export is the stall
# investigation's.
#
# Speaks for WebKitGTK only, and for this seed only: a small document and a
# three slide deck. It cannot say that a deck of another size or with other
# content exports, nor anything about a window that is minimized or on
# another desktop, which Xvfb has no meaning for.
#
# Needs what lib.sh needs, and pdf-lib under the browser smoke's
# node_modules (`npm ci` in scripts/e2e/browser-smoke). Exit codes are
# lib.sh's.
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name. The directive
# stands before the first command so that it covers the file.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup pdf-export
obs_need node timeout comm
OBS_SMOKE_DIR="${OBS_SMOKE_DIR:-$HERE/../browser-smoke}"
export OBS_SMOKE_DIR
[ -d "$OBS_SMOKE_DIR/node_modules/pdf-lib" ] || obs_refuse "no pdf-lib under $OBS_SMOKE_DIR/node_modules (npm ci in scripts/e2e/browser-smoke, or set OBS_SMOKE_DIR)"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
# The window's own export is saved by the desktop into the Downloads folder
# of its home, with no dialog (desktop/src-tauri/src/download.rs).
DOWNLOADS="$HOME/Downloads"
mkdir -p "$DOWNLOADS" "$HOME/.config"
printf 'XDG_DOWNLOAD_DIR="%s"\n' "$DOWNLOADS" > "$HOME/.config/user-dirs.dirs"
obs_start_display
obs_start_desktop
obs_log "desktop build: $(grep -m1 -o 'build[^ ]*git-[0-9a-f]*[^ ]*' "$OBS_WORK/desktop.log" | sed 's/\x1b\[[0-9;]*m//g' || echo unknown)"

WS="$OBS_WORK/ws"
python3 "$HERE/make-seed.py" "$WS" || obs_inconclusive "the seed was not written"
mkdir -p "$WS/out"
COLOURS="$WS/colours.json"
RESULTS="$OBS_WORK/results.jsonl"
: > "$RESULTS"
PAGE="/workspace-"
# Longer than the export's own absolute bound of 15 minutes.
EXPORT_BOUND=960

page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "$PAGE" "$1"; }
workspace_xid() { obs_x_window_titled "$WS"; }
page_answers() { page_eval "document.readyState" | grep -q complete; }

chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
obs_wait 60 "the native workspace window" workspace_xid
obs_wait 60 "the workspace page to answer the inspector" page_answers
FIRST_WINDOW="$(page_eval "new URLSearchParams(location.search).get('w')" | tr -d '"')"
[ -n "$FIRST_WINDOW" ] || obs_inconclusive "the workspace page names no window id"
export CHAN_WINDOW_ID="$FIRST_WINDOW"
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

# What the page's document holds of the seed, as a record beside the
# window's pixels. Nothing waits on it and nothing is judged by it: the arm
# makes no assumption about the SVG a drawing becomes, and counts on what
# the window shows.
page_pictures() {
    cat <<'JS'
(() => {
  const shown = (el) => el.getClientRects().length > 0;
  const plain = [...document.querySelectorAll("img")].filter((el) => shown(el) && (el.getAttribute("src") || "").includes("plain.png"));
  return {
    svgImages: document.querySelectorAll("svg image").length,
    svgUses: document.querySelectorAll("svg use").length,
    inlineSvgs: document.querySelectorAll("svg").length,
    plain: plain.map((el) => ({ complete: el.complete, natural: el.naturalWidth })),
    viewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
  };
})()
JS
}

# export_by_command <name> <document> [window id, or "none"]: the command
# export, bounded by this driver beyond the export's own bound. Appends
# "<name> <status> <elapsed ms> <pdf path or -> <window that rendered or ->"
# to the export list; the fourth field is "yes" for a PDF that was written.
export_by_command() {
    local name="$1" doc="$2" window="${3:-$FIRST_WINDOW}" status=0 started elapsed rendered
    started="$(obs_now_ms)"
    if [ "$window" = none ]; then
        (cd "$WS" && env -u CHAN_WINDOW_ID timeout "$EXPORT_BOUND" "$CHAN_BIN" shell export "$doc" --out "out/$name.pdf") \
            > "$OBS_WORK/$name.out" 2> "$OBS_WORK/$name.err" || status=$?
    else
        (cd "$WS" && CHAN_WINDOW_ID="$window" timeout "$EXPORT_BOUND" "$CHAN_BIN" shell export "$doc" --out "out/$name.pdf") \
            > "$OBS_WORK/$name.out" 2> "$OBS_WORK/$name.err" || status=$?
    fi
    elapsed=$(($(obs_now_ms) - started))
    rendered="$(sed -n 's/^export rendered in window //p' "$OBS_WORK/$name.err" | sed -n 1p)"
    obs_log "$name: cs export ended $status after ${elapsed} ms, rendered in ${rendered:--}: $(obs_masked < "$OBS_WORK/$name.err" | tr '\n' ' ' | cut -c1-300)"
    printf '%s %s %s %s %s\n' "$name" "$status" "$elapsed" "$([ -s "$WS/out/$name.pdf" ] && echo yes || echo -)" "${rendered:--}" >> "$OBS_WORK/exports.txt"
}

# The steps of the window's own export, each a click the page takes as its
# user's: the file browser, the document's row, the action menu, the item.
tree_is_open() { page_eval "document.querySelectorAll('[role=\"treeitem\"]').length > 0" | grep -qx true; }
open_tree() {
    tree_is_open && return 0
    page_eval "window.dispatchEvent(new CustomEvent('chan:command', { detail: { name: 'app.files.toggle' } })), true" >/dev/null
    obs_wait 30 "the file browser" tree_is_open
}
click_row() {
    page_eval "(() => { const row = [...document.querySelectorAll('[role=\"treeitem\"] button.name')].find((b) => b.textContent.trim() === '$1'); if (!row) return false; row.click(); return true; })()" | grep -qx true
}
click_caret() {
    page_eval "(() => { const caret = document.querySelector('.pill-caret'); if (!caret) return false; caret.click(); return true; })()" | grep -qx true
}
click_export_item() {
    page_eval "(() => { const item = [...document.querySelectorAll('.action-menu-item')].find((b) => (b.textContent || '').includes('Export to PDF')); if (!item) return false; item.click(); return true; })()" | grep -qx true
}
status_message() { page_eval "(document.querySelector('[aria-label=\"status message\"]')?.textContent || '').trim().slice(0, 300)" | tr -d '"'; }

# export_by_window <name> <document>: the window's own Export to PDF, read
# from the desktop's Downloads folder. Appends to the export list as
# export_by_command does, with status 0 for a saved file, 124 for none
# inside the bound and 1 for a message of the page with no file.
export_by_window() {
    local name="$1" doc="$2" status=124 started elapsed saved="" message="" deadline
    open_tree
    obs_wait 30 "the row of $doc in the file browser" click_row "$doc"
    obs_wait 15 "the action menu's caret" click_caret
    # This throwaway home starts with no matching export. A new pathname is
    # a stronger witness than mtime, which may not advance on every volume.
    find "$DOWNLOADS" -maxdepth 1 -type f -name '*.pdf' -print | sort > "$OBS_WORK/$name.before"
    started="$(obs_now_ms)"
    obs_wait 15 "the Export to PDF item" click_export_item
    deadline=$((SECONDS + EXPORT_BOUND))
    while [ "$SECONDS" -lt "$deadline" ]; do
        # The desktop writes a temporary file and renames it once complete,
        # so a PDF under its final name is a whole one.
        find "$DOWNLOADS" -maxdepth 1 -type f -name '*.pdf' -print | sort > "$OBS_WORK/$name.current"
        saved="$(comm -13 "$OBS_WORK/$name.before" "$OBS_WORK/$name.current" | sed -n 1p)"
        if [ -n "$saved" ]; then
            status=0
            break
        fi
        message="$(status_message || true)"
        if [ -n "$message" ] && printf '%s' "$message" | grep -qi -e 'fail' -e 'error' -e 'timed out' -e 'could not'; then
            status=1
            break
        fi
        sleep 0.5
    done
    elapsed=$(($(obs_now_ms) - started))
    if [ -n "$saved" ]; then
        cp "$saved" "$WS/out/$name.pdf"
    fi
    printf '%s\n' "$message" > "$OBS_WORK/$name.err"
    obs_log "$name: the window's own export ended $status after ${elapsed} ms: ${saved:-no file}; page message: ${message:-none}"
    printf '%s %s %s %s %s\n' "$name" "$status" "$elapsed" "$([ -s "$WS/out/$name.pdf" ] && echo yes || echo -)" "$FIRST_WINDOW" >> "$OBS_WORK/exports.txt"
}

# read_export <name>: the PDF's colours as one JSON value, or null.
read_export() {
    local pdf="$WS/out/$1.pdf" status=0
    [ -s "$pdf" ] || { echo null; return 0; }
    node "$HERE/pdf-read.mjs" "$pdf" "$COLOURS" > "$OBS_WORK/$1.read.json" 2> "$OBS_WORK/$1.read.err" || status=$?
    if [ "$status" = 0 ]; then
        cat "$OBS_WORK/$1.read.json"
    else
        obs_log "$1: the PDF could not be read ($status): $(cut -c1-300 "$OBS_WORK/$1.read.err")"
        echo null
    fi
}

# record <arm> <item> <screen json or null> <names of this arm's exports...>:
# one line of results for the arm, from the export list, each export's
# stderr or page message, and what the reader says of its PDF.
record() {
    local arm="$1" item="$2" screen="$3" name
    shift 3
    for name in "$@"; do
        read_export "$name" > "$OBS_WORK/$name.read.out"
    done
    python3 - "$OBS_WORK" "$arm" "$item" "$screen" "$@" <<'PY' | obs_masked >> "$RESULTS"
import json
import sys

work, arm, item, screen, *names = sys.argv[1:]
listed = {}
for line in open(f"{work}/exports.txt"):
    name, status, elapsed, wrote, rendered = line.split()
    listed[name] = (int(status), int(elapsed), wrote == "yes", rendered)
exports = []
for name in names:
    status, elapsed, wrote, rendered = listed[name]
    exports.append({
        "name": name,
        "status": status,
        "elapsedMs": elapsed,
        "wrote": wrote,
        "renderedIn": rendered,
        "message": open(f"{work}/{name}.err").read().strip()[:400],
        "read": json.load(open(f"{work}/{name}.read.out")),
    })
print(json.dumps({"arm": arm, "item": int(item), "screen": json.loads(screen), "exports": exports}))
PY
    obs_log "$arm: $(tail -1 "$RESULTS" | cut -c1-600)"
}

arm_drawing() {
    local xid pictures screen
    (cd "$WS" && cs open drawing-picture.md) > "$OBS_WORK/drawing.open.out" 2>&1 || obs_inconclusive "cs open drawing-picture.md failed: $(cat "$OBS_WORK/drawing.open.out")"
    xid="$(workspace_xid)"
    # Ready is what the window shows: the ordinary image and the centre of
    # each picture, by their colours, in a capture of the window itself.
    window_shows_seed() {
        import -window "$xid" "ppm:$OBS_WORK/drawing.window.ppm" 2>> "$OBS_WORK/shots/import.log" || return 1
        python3 "$HERE/window-colours.py" "$OBS_WORK/drawing.window.ppm" "$COLOURS" \
            | python3 -c 'import json, sys; c = json.load(sys.stdin)["counts"]; sys.exit(0 if all(c[k] >= 50 for k in ("plain", "a_centre", "b_centre")) else 1)'
    }
    obs_wait 90 "the window to show the ordinary image and both pictures of the drawing" window_shows_seed
    # Past the paint the capture caught part of, then the capture that counts.
    sleep 2
    import -window "$xid" "ppm:$OBS_WORK/drawing.window.ppm" 2>> "$OBS_WORK/shots/import.log" || obs_inconclusive "the window could not be captured"
    obs_shot drawing-1-on-screen
    screen="$(python3 "$HERE/window-colours.py" "$OBS_WORK/drawing.window.ppm" "$COLOURS")" || obs_inconclusive "the window's capture could not be read"
    pictures="$(page_eval "$(page_pictures)" 2>/dev/null || echo null)"
    screen="{\"page\":$pictures,\"window\":$screen}"
    export_by_command drawing-command drawing-picture.md
    export_by_window drawing-window drawing-picture.md
    obs_shot drawing-2-after-exports
    record drawing 8 "$screen" drawing-command drawing-window
}

arm_deck() {
    export_by_command deck-command deck.md
    export_by_window deck-window deck.md
    obs_shot deck-after-exports
    record deck 15 null deck-command deck-window
}

arm_two_windows() {
    local second
    two_windows() { [ "$(obs_x_windows | grep -c -F -- "$WS" || true)" -ge 2 ]; }
    second="$(cs window new 2> "$OBS_WORK/two-windows.new.err" | sed -n 1p)" || obs_inconclusive "cs window new failed: $(cat "$OBS_WORK/two-windows.new.err")"
    [ -n "$second" ] || obs_inconclusive "cs window new printed no window id"
    obs_wait 60 "a second native window of the workspace" two_windows
    # Long enough for the second window's page to join the workspace.
    sleep 5
    obs_log "two-windows: first $FIRST_WINDOW, second $second"
    export_by_command two-first deck.md "$FIRST_WINDOW"
    export_by_command two-unnamed deck.md none
    obs_shot two-windows-after-exports
    record two-windows 15 "{\"first\":\"$FIRST_WINDOW\",\"second\":\"$second\"}" two-first two-unnamed
}

: > "$OBS_WORK/exports.txt"
for arm in ${OBS_ARMS:-drawing deck two-windows}; do
    case "$arm" in
    drawing) arm_drawing ;;
    deck) arm_deck ;;
    two-windows) arm_two_windows ;;
    *) obs_inconclusive "unknown arm $arm" ;;
    esac
done

obs_verdict
python3 - "$RESULTS" <<'PY'
import json
import sys

# The window's counts are of sampled pixels, about a quarter of those of a
# colour; a PDF's are of every pixel. The same two numbers serve both: each
# seeded area is thousands of pixels where it is shown at all.
PRESENT = 50   # pixels of a colour that count as shown
STRAY = 10     # fewer than this is none

rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
faults, open_questions = [], []


def say(text):
    print(f"pdf-export: {text}", file=sys.stderr)


for row in rows:
    arm = row["arm"]
    exports = {e["name"]: e for e in row["exports"]}
    for e in row["exports"]:
        if e["status"] == 124:
            faults.append(f"{arm}: {e['name']} had not ended at the driver's bound, beyond the export's own")
        elif e["status"] != 0 or not e["wrote"]:
            open_questions.append(f"{arm}: {e['name']} ended {e['status']} with no PDF: {e['message'] or 'no message'}")
        elif e["read"] is None:
            open_questions.append(f"{arm}: {e['name']} wrote a PDF the reader could not read")
    if arm == "drawing":
        window = row["screen"]["window"]["counts"]
        shown = all(window[k] >= PRESENT for k in ("plain", "a_field", "a_centre", "b_field", "b_centre"))
        if not shown or window["b_ring"] >= STRAY:
            open_questions.append(f"drawing: the window does not show the seed as written (pixels {window}), so no PDF is judged")
            continue
        say(f"drawing: the page's own document, recorded and not judged: {row['screen']['page']}")
        for e in row["exports"]:
            if e["read"] is None:
                continue
            got = e["read"]["totals"]
            if got["plain"] < PRESENT:
                open_questions.append(f"drawing: {e['name']} lacks the ordinary image (pixels {got}); that is another fault than a drawing's picture, and the drawing is not judged by this PDF")
                continue
            missing = [k for k in ("a_centre", "a_field", "b_centre", "b_field") if got[k] < STRAY]
            thin = [k for k in ("a_centre", "a_field", "b_centre", "b_field") if STRAY <= got[k] < PRESENT]
            if missing:
                faults.append(f"drawing: {e['name']} holds the ordinary image and lacks {missing} of the drawing's pictures (pixels {got})")
            elif got["b_ring"] >= PRESENT:
                faults.append(f"drawing: {e['name']} holds what the picture's crop cuts away (pixels {got})")
            elif thin or got["b_ring"] >= STRAY:
                open_questions.append(f"drawing: {e['name']} holds too few or stray pixels to call (pixels {got})")
            else:
                say(f"drawing: {e['name']} holds the ordinary image and both pictures, the crop applied (pixels {got})")
    if arm == "deck":
        command, window = exports.get("deck-command"), exports.get("deck-window")
        if not (command and window and command["read"] and window["read"]):
            continue
        cr, wr = command["read"], window["read"]
        say(f"deck: command {cr['pageCount']} pages in {command['elapsedMs']} ms, rendered in {command['renderedIn']}; window's own {wr['pageCount']} pages in {window['elapsedMs']} ms")
        if cr["pageCount"] != wr["pageCount"]:
            faults.append(f"deck: the command's PDF has {cr['pageCount']} pages and the window's own has {wr['pageCount']}")
        lacking = [k for k, n in wr["totals"].items() if n >= PRESENT and cr["totals"][k] < STRAY]
        if lacking:
            faults.append(f"deck: the command's PDF lacks {lacking}, which the window's own export holds")
        if wr["pageCount"] != 3:
            open_questions.append(f"deck: the window's own export has {wr['pageCount']} pages for three slides")
    if arm == "two-windows":
        for e in row["exports"]:
            say(f"two-windows: {e['name']} ended {e['status']} in {e['elapsedMs']} ms, rendered in {e['renderedIn']} (first {row['screen']['first']}, second {row['screen']['second']})")

for text in faults:
    say(f"FAULT: {text}")
for text in open_questions:
    say(f"INCONCLUSIVE: {text}")
if faults:
    sys.exit(10)
if open_questions or not rows:
    sys.exit(3)
say("PASS: every export ended inside its bound and every PDF holds what its arm asks (WebKitGTK, this seed)")
PY
obs_judge "$?" "an exported PDF is not what its page or the window's own export shows (WebKitGTK, this seed); the lines above name it"
