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

# The document may open in source mode; the grid lives in rendered mode.
rendered_mode() {
    page_eval "!!document.querySelector('.cm-md-wiki-pill')" | grep -q true
}
obs_wait 60 "the opened document to render" rendered_mode || {
    page_eval "window.dispatchEvent(new CustomEvent('chan:command', {detail: {name: 'app.editor.toggleMode'}}))" >/dev/null 2>&1 || true
    obs_wait 60 "the rendered document after the mode toggle" rendered_mode
}

# A caret inside the table source suppresses the widget; read the cells,
# which exist only once the grid is drawn with the caret elsewhere.
read_cells() {
    page_eval "(() => { const tds = [...document.querySelectorAll('.cm-md-table td')]; return tds.length ? tds.map((td) => td.textContent) : null; })()"
}
CELLS=""
deadline=$((SECONDS + 120))
while [ "$SECONDS" -lt "$deadline" ]; do
    CELLS="$(read_cells 2>/dev/null || true)"
    if [ -n "$CELLS" ] && [ "$CELLS" != "null" ]; then break; fi
    sleep 1
done
printf '%s\n' "$CELLS" > "$OBS_WORK/cells.json"
obs_shot grid

obs_verdict
node - "$OBS_WORK/cells.json" <<'JS'
import { readFileSync } from "node:fs";
const raw = readFileSync(process.argv[2], "utf8").trim();
let cells = null;
try { cells = JSON.parse(raw); } catch { cells = null; }
if (!Array.isArray(cells) || !cells.length) {
  console.error("wikilink-labels: INCONCLUSIVE: the grid rendered no cells to read");
  process.exit(3);
}
const label = cells[0] ?? "";
const code = cells[1] ?? "";
if (label !== "note") {
  console.error(`wikilink-labels: FAULT: the label cell shows ${JSON.stringify(label)}, not "note" (WebKitGTK)`);
  process.exit(10);
}
if (label.includes("[[") || code !== "[[note]]") {
  console.error(`wikilink-labels: FAULT: brackets leak: ${JSON.stringify(cells)} (WebKitGTK)`);
  process.exit(10);
}
console.error(`wikilink-labels: PASS: cells ${JSON.stringify(cells)} (WebKitGTK)`);
JS
obs_judge "$?" "a table cell on chan-desktop keeps a wikilink's brackets or misses its label (WebKitGTK); the reading is above"
