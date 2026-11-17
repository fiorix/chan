#!/usr/bin/env bash
# Does a table cell on chan-desktop's own engine show a wikilink's label?
#
# Seeds a workspace with a note and a table document whose cell holds
# [[note]], opens the table in a real chan-desktop under Xvfb, and reads
# the rendered grid through the engine's remote inspector. The fault is
# a rendered cell that keeps the brackets or misses the label.
#
# Speaks for WebKitGTK only. The inspector's Runtime.evaluate has no
# awaitPromise, so the driver evaluates synchronous expressions and
# polls from here; a function passed to an evaluate as a string is not
# called, so every reading below is an expression.
#
# Needs what lib.sh needs and node. Exit codes are lib.sh's.
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name. The directive
# stands before the first command so that it covers the file.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup wikilink-labels
obs_need node
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop

WS="$OBS_WORK/ws"
mkdir -p "$WS"
printf '# Note\n' > "$WS/note.md"
printf 'before\n\n| Name | Code |\n|------|------|\n| [[note]] | `[[note]]` |\n\nafter\n' > "$WS/table.md"

PAGE="/workspace-"
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "$PAGE" "$1"; }
workspace_xid() { obs_x_local_window_titled "$WS"; }
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

(cd "$WS" && cs open table.md) > "$OBS_WORK/open.out" 2>&1 || obs_inconclusive "cs open table.md failed: $(obs_masked < "$OBS_WORK/open.out")"

# The grid lives in rendered mode and carries no wiki pills: table cells
# render through the widget, so what proves the document rendered is the
# grid itself. A caret inside the table source suppresses the widget; a
# fresh open leaves the caret at the document's start, outside the table,
# so no caret move is needed. obs_wait exits on its own timeout, so the
# mode toggle below is an explicit check, not a fallback after one.
doc_state() {
    page_eval "(() => ({ source: !!document.querySelector('.md-source'), cells: [...document.querySelectorAll('.cm-md-table td')].map((td) => td.textContent) }))" 2>/dev/null || echo null
}
if [ "$(page_eval "!!document.querySelector('.md-source')" 2>/dev/null)" = "true" ]; then
    obs_log "the document opened in source mode; toggling to rendered once"
    page_eval "window.dispatchEvent(new CustomEvent('chan:command', {detail: {name: 'app.editor.toggleMode'}}))" >/dev/null 2>&1 || true
fi
CELLS=""
MODE="unreadable"
deadline=$((SECONDS + 180))
until [ -n "$CELLS" ] && [ "$CELLS" != "null" ] && [ "$CELLS" != "[]" ]; do
    [ "$SECONDS" -lt "$deadline" ] || break
    STATE="$(doc_state || echo null)"
    MODE="$(printf '%s' "$STATE" | node -e 'let s=""; process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{const o=JSON.parse(s);console.log(o&&o.source?"source":"rendered")}catch(e){console.log("unreadable")}})')"
    CELLS="$(printf '%s' "$STATE" | node -e 'let s=""; process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{const o=JSON.parse(s);console.log(JSON.stringify(o&&o.cells&&o.cells.length?o.cells:null))}catch(e){console.log("null")}})')"
    sleep 1
done
printf 'cells: %s\nmode at the end: %s\n' "$CELLS" "$MODE" > "$OBS_WORK/cells.json"
obs_log "cells: $CELLS (mode at the end: $MODE)"
obs_shot grid

obs_verdict
node - "$OBS_WORK/cells.json" <<'JS'
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").split("\n");
const mode = (lines.find((l) => l.startsWith("mode at the end:")) ?? "mode unknown").trim();
let cells = null;
try { cells = JSON.parse((lines[0] ?? "").replace(/^cells: /, "")); } catch { cells = null; }
if (!Array.isArray(cells) || !cells.length) {
  console.error(`wikilink-labels: INCONCLUSIVE: the grid rendered no cells to read (${mode})`);
  process.exit(3);
}
const label = cells[0] ?? "";
const code = cells[1] ?? "";
if (label !== "note") {
  console.error(`wikilink-labels: FAULT: the label cell shows ${JSON.stringify(label)}, not "note" (WebKitGTK, ${mode})`);
  process.exit(10);
}
if (label.includes("[[") || code !== "[[note]]") {
  console.error(`wikilink-labels: FAULT: brackets leak: ${JSON.stringify(cells)} (WebKitGTK, ${mode})`);
  process.exit(10);
}
console.error(`wikilink-labels: PASS: cells ${JSON.stringify(cells)} (WebKitGTK, ${mode})`);
JS
obs_judge "$?" "a table cell on chan-desktop keeps a wikilink's brackets or misses its label (WebKitGTK); the reading is above"
