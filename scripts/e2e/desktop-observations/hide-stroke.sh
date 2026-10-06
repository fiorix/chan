#!/usr/bin/env bash
# Does a hide the desktop makes without asking the page keep a drawing's
# stroke that is still inside its board's wait?
#
# A drawing board serializes its scene, and pushes it to the server's scene
# session, 200 ms after its last change. A stroke drawn just before a
# `cs window hide` has therefore reached neither the file nor the server
# when the watcher destroys the webview, and it survives only if the engine
# runs the page's unload handler, which commits each board and writes its
# recovery buffer.
#
# This drives a real chan-desktop under Xvfb. Each arm opens a fresh empty
# board, draws one pen stroke through X pointer input, ends the page in the
# arm's way, opens the window again and reads the new page. The page is the
# instrument, read through the engine's remote inspector, as in
# hide-flush.sh; the board's Undo control turning enabled is its word that
# the stroke registered.
#
# Arms:
#   rest         nothing ends. It times how long the file takes to receive
#                a stroke left alone, which must be at least the 200 ms the
#                other arms take the board's wait to be.
#   settled      the hide comes 2.5 s after the stroke. The stroke must be
#                kept; a miss is an instrument fault.
#   kill         the page's web process is killed in place of the hide. No
#                unload handler can run, so the stroke must be lost and the
#                pagehide witness silent. A kept stroke means the readers
#                cannot see a loss, or the stroke was not pending.
#   kill-late    the same, with the kill held until 150 ms after the stroke
#                ended, later than the hide arms' pages end. A page killed
#                with no unload keeps only what it had already sent, so a
#                stroke lost here had not reached the server by then, which
#                the hide arms' timing bound otherwise only infers.
#   hide         the subject. Counts only if the page said, before the hide,
#                that the board held the stroke and storage held none of it,
#                the file did not hold it, and the native window was gone
#                less than 200 ms after the stroke's last pointer event.
#   uninspected  the subject again with no inspector attached to the page
#                before the hide.
#
# Speaks for WebKitGTK only. Needs what hide-flush.sh needs. Exit codes are
# lib.sh's.
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name. The directive
# stands before the first command so that it covers the file.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup hide-stroke
obs_need node
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
obs_log "desktop build: $(grep -m1 -o 'build[^ ]*git-[0-9a-f]*[^ ]*' "$OBS_WORK/desktop.log" | sed 's/\x1b\[[0-9;]*m//g' || echo unknown)"

WS="$OBS_WORK/ws"
mkdir -p "$WS"
RESULTS="$OBS_WORK/results.jsonl"
: > "$RESULTS"
PAGE="/workspace-"
STROKE="freedraw"

page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "$PAGE" "$1"; }
workspace_xid() { obs_x_window_titled "$WS"; }
no_workspace_window() { ! workspace_xid; }
page_answers() { page_eval "document.readyState" | grep -q complete; }

chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
obs_wait 60 "the native workspace window" workspace_xid
obs_wait 60 "the workspace page to answer the inspector" page_answers
CHAN_WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w')" | tr -d '"')"
export CHAN_WINDOW_ID
[ -n "$CHAN_WINDOW_ID" ] || obs_inconclusive "the workspace page names no window id"
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

# What the reopened page holds of a board's stroke.
after_expression() {
    cat <<JS
(() => {
  const stored = Object.keys(localStorage).filter((k) => k.includes("$1")).map((k) => [k, localStorage.getItem(k) || ""]);
  // A tab that is not showing keeps its banner in the document with no
  // rendered text, so the banner on screen is the one that has some.
  const banner = [...document.querySelectorAll(".recovery-banner")].find((b) => b.innerText.trim() !== "");
  return {
    storageKeysWithStroke: stored.filter(([, v]) => v.includes("$STROKE")).map(([k]) => k),
    recoveryBanner: banner ? banner.innerText.trim().slice(0, 160) : null,
    tabs: [...document.querySelectorAll("[role=tab]")].map((t) => t.textContent.trim()).slice(0, 8),
  };
})()
JS
}

# run_arm <name> <mode> [options of the timed step...]
run_arm() {
    local arm="$1" mode="$2" board="$1.excalidraw" xid step after file_after
    shift 2
    local -a extra=("$@")
    printf '{"type":"excalidraw","version":2,"source":"chan-observation","elements":[],"appState":{},"files":{}}\n' > "$WS/$board"
    obs_wait 60 "a native workspace window for $arm" workspace_xid
    obs_wait 60 "the workspace page for $arm" page_answers
    (cd "$WS" && cs open "$board") > "$OBS_WORK/$arm.open.out" 2>&1 || obs_inconclusive "cs open $board failed: $(cat "$OBS_WORK/$arm.open.out")"
    board_is_ready() { page_eval "[...document.querySelectorAll('.excalidraw button')].filter((b) => b.getAttribute('aria-label') === 'Undo' && b.offsetParent !== null).map((b) => b.disabled).join()" | grep -qx '"true"'; }
    obs_wait 30 "an empty board on screen for $arm" board_is_ready
    # Past the layout save, so the reopened window restores this tab.
    sleep 3
    xid="$(workspace_xid)"
    xdotool windowactivate --sync "$xid" 2>/dev/null || true
    sleep 0.3
    step="$(node "$HERE/hide-flush-step.mjs" --inspector "$INSPECTOR" --page "$PAGE" --witness-page "Chan Launcher" \
        --xid "$xid" --marker "$STROKE" --note-file "$WS/$board" --stroke 500,300 \
        --mode "$mode" --window "$CHAN_WINDOW_ID" --chan "$CHAN_BIN" --desktop-pid "$OBS_DESKTOP_PID" "${extra[@]}")" \
        || obs_log "$arm: the timed step reported a problem: $step"
    obs_shot "$arm-2-after-step"
    if [ "$mode" = rest ]; then
        printf '{"arm":"%s","step":%s}\n' "$arm" "${step:-null}" >> "$RESULTS"
        obs_log "$arm: $(tail -1 "$RESULTS" | cut -c1-500)"
        return 0
    fi
    if [ "$mode" = kill ]; then
        sleep 1
        cs window hide "$CHAN_WINDOW_ID" > "$OBS_WORK/$arm.hide.out" 2>&1 || true
    fi
    obs_wait 30 "the native window to go for $arm" no_workspace_window
    sleep 1
    cs window open "$CHAN_WINDOW_ID" > "$OBS_WORK/$arm.reopen.out" 2>&1 || obs_inconclusive "cs window open failed: $(cat "$OBS_WORK/$arm.reopen.out")"
    obs_wait 60 "the reopened native window for $arm" workspace_xid
    obs_wait 60 "the reopened page for $arm" page_answers
    sleep 4
    after="$(page_eval "$(after_expression "$board")")" || obs_inconclusive "$arm: the reopened page did not answer"
    obs_shot "$arm-3-reopened"
    file_after=false
    grep -q "$STROKE" "$WS/$board" && file_after=true
    printf '{"arm":"%s","step":%s,"after":%s,"fileHasStrokeAfterReopen":%s}\n' "$arm" "${step:-null}" "$after" "$file_after" >> "$RESULTS"
    obs_log "$arm: $(tail -1 "$RESULTS" | cut -c1-700)"
}

run_arm rest rest
run_arm settled settled
run_arm hide hide
run_arm uninspected hide --uninspected
run_arm kill kill
run_arm kill-late kill --kill-after-ms 150

obs_log "results: $RESULTS; desktop log: $OBS_WORK/desktop.log; screenshots: $OBS_WORK/shots"
obs_verdict
python3 - "$RESULTS" <<'PY'
import json
import sys

arms = {}
for line in open(sys.argv[1]):
    row = json.loads(line)
    arms[row["arm"]] = row

def inconclusive(reason):
    print(f"INCONCLUSIVE: {reason}")
    sys.exit(3)

for name in ("rest", "settled", "hide", "uninspected", "kill", "kill-late"):
    if name not in arms or not arms[name].get("step"):
        inconclusive(f"the {name} arm has no record of its timed step")
    if arms[name]["step"].get("error"):
        inconclusive(f"the {name} arm's timed step failed: {arms[name]['step']['error']}")

def kept(row):
    after = row["after"]
    return bool(after["storageKeysWithStroke"]) or after["recoveryBanner"] is not None or row["fileHasStrokeAfterReopen"]

rest, settled, hide, blind, kill = (arms[n] for n in ("rest", "settled", "hide", "uninspected", "kill"))

# The board's wait, as this run met it, is at least the bound used below.
took = rest["step"]["fileTookMarkerAfterInputEndMs"]
if took < 200:
    inconclusive(f"the file took a resting stroke {took} ms after it ended, sooner than the 200 ms wait the bound assumes")

# The readers see a kept stroke.
if not settled["step"]["before"]["editorHasWholeMarker"] or not kept(settled):
    inconclusive("the settled arm did not keep its stroke, so the readers cannot see a kept stroke")

def not_pending(row, inspected):
    step = row["step"]
    if inspected:
        before = step["before"]
        if not before["editorHasWholeMarker"]:
            return "the board did not hold the stroke before the page ended"
        if before["storageKeysWithMarkerPrefix"]:
            return "the stroke was already in localStorage before the page ended"
    if step["fileHadMarkerBeforeAction"] is not False:
        return "the stroke was already in the file before the page ended, or the file could not be read"
    if "goneAfterInputEndMs" in step and step["goneAfterInputEndMs"] >= 200:
        return f"the window went {step['goneAfterInputEndMs']} ms after the stroke ended, past the board's 200 ms wait"
    return None

# The readers see a lost stroke, and the witness is silent without an unload.
late = arms["kill-late"]
for name, row in (("kill", kill), ("kill-late", late)):
    reason = not_pending(row, True)
    if reason:
        inconclusive(f"the {name} arm's stroke was not shown to be pending: {reason}")
    if row["step"]["aftermath"]["pagehideWitness"] is not None:
        inconclusive(f"the pagehide witness spoke for the {name} arm's page, whose process was killed")
if kept(kill):
    inconclusive("the kill arm kept its stroke, so the readers cannot see a lost stroke")
# A killed page keeps only what it had sent. A stroke lost when its page is
# killed this long after it ended had not reached the server by then.
killed_after = late["step"]["actionAfterInputEndMs"]
if killed_after >= 200:
    inconclusive(f"the kill-late arm's page was killed {killed_after} ms after its stroke ended, past the board's wait")
if kept(late):
    inconclusive(f"a stroke whose page was killed {killed_after} ms after it ended was kept, so a stroke that old may already be with the server")

for name, row, inspected in (("hide", hide, True), ("uninspected", blind, False)):
    reason = not_pending(row, inspected)
    if reason:
        inconclusive(f"the {name} arm's stroke was not shown to be pending: {reason}")
if hide["step"]["goneAfterInputEndMs"] > killed_after:
    inconclusive(f"the hide arm's page ended {hide['step']['goneAfterInputEndMs']} ms after its stroke, later than the {killed_after} ms at which a killed page was shown to have sent nothing")

summary = {
    "strokeKeptAfterReopen": {"hide": kept(hide), "uninspected": kept(blind)},
    "goneAfterStrokeEndMs": {"hide": hide["step"]["goneAfterInputEndMs"], "uninspected": blind["step"]["goneAfterInputEndMs"]},
    "restingStrokeReachedFileAfterMs": took,
    "killedPageLostStrokeWhenKilledMsAfterStrokeEnd": {"kill": kill["step"]["actionAfterInputEndMs"], "kill-late": killed_after},
    "pagehideAtHostHide": hide["step"]["aftermath"]["pagehideWitness"] is not None,
    "recoveryBufferHeldStrokeAfterHide": {
        "hide": bool(hide["step"]["aftermath"]["storageKeysWithWholeMarker"]),
        "uninspected": bool(blind["step"]["aftermath"]["storageKeysWithWholeMarker"]),
    },
    "fileHeldStrokeAfterHide": {"hide": hide["step"]["fileHadMarkerAfterAction"], "uninspected": blind["step"]["fileHadMarkerAfterAction"]},
    "recoveryBannerAfterReopen": {"hide": hide["after"]["recoveryBanner"], "uninspected": blind["after"]["recoveryBanner"]},
    "fileHasStrokeAfterReopen": {"hide": hide["fileHasStrokeAfterReopen"], "uninspected": blind["fileHasStrokeAfterReopen"]},
}
print(json.dumps(summary))
outcomes = summary["strokeKeptAfterReopen"]
if all(outcomes.values()):
    print("PASS: a host-side hide kept a stroke inside its board's wait (WebKitGTK)")
    sys.exit(0)
if not any(outcomes.values()):
    print("FAULT: a host-side hide lost a stroke inside its board's wait (WebKitGTK)")
    sys.exit(1)
inconclusive("the two hide arms disagree, so the inspector's presence may decide the outcome")
PY
verdict=$?
[ "$verdict" = 0 ] || obs_log "work dir kept at $OBS_WORK"
exit "$verdict"
