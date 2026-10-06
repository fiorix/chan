#!/usr/bin/env bash
# Does a hide the desktop makes without asking the page keep a text edit
# that is still inside its recovery debounce?
#
# `cs window hide` buries a window with no call into its page, and the
# watcher then destroys the webview. A text tab's recovery write waits 500 ms
# after an edit, so an edit typed just before the hide survives only if the
# engine runs the page's unload handler as the webview goes.
#
# This drives a real chan-desktop under Xvfb. Each arm opens a fresh note,
# types a marker through X input, ends the page in the arm's way, opens the
# window again and reads the new page. The page itself is the instrument,
# read through the engine's remote inspector: before the hide it says
# whether the editor holds the whole marker and whether any of it is already
# in localStorage; once the page is gone the launcher's page, which shares
# its origin's storage, says whether a `pagehide` witness planted before the
# typing fired and whether a recovery buffer holds the whole marker; and
# after the reopen the new page says whether the document holds it.
#
# Arms:
#   settled      the hide comes 2.5 s after the typing, past the recovery
#                debounce and the autosave. The marker must be kept; a miss
#                is an instrument fault.
#   hide         the subject. Counts only if the page said, before the hide,
#                that the editor held the whole marker and storage held none
#                of it, the file on disk did not hold it, and the native
#                window was gone less than 500 ms after the first keystroke,
#                before any recovery timer for it could fire.
#   uninspected  the subject again with no inspector attached before the
#                hide, so the inspector's presence cannot be what kept the
#                edit. Its preconditions are the timing and the file only.
#   kill         the page's web process is killed in place of the hide. No
#                unload handler can run there, so the pagehide witness must
#                be silent; a witness that speaks here says nothing where it
#                speaks. What the document holds afterwards is recorded and
#                is no control: an attached tab's edits also reach the
#                server's document session, on the order of a tenth of a
#                second after they are typed, so a killed page's text is
#                kept or lost by when the kill came.
#
# Text only: a drawing's pending stroke is not covered here. Speaks for
# WebKitGTK only. Needs what lib.sh needs, node 22 or newer, and a built
# chan-desktop and chan with the web bundles. Exit codes are lib.sh's.
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name. The directive
# stands before the first command so that it covers the file.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup hide-flush
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

page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "$PAGE" "$1"; }
workspace_xid() { obs_x_window_titled "$WS"; }
no_workspace_window() { ! workspace_xid; }

# 1. One workspace window, handed to the running desktop.
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

# What the reopened page holds of a marker.
after_expression() {
    cat <<JS
(() => {
  const marker = "$1";
  const stored = Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) || ""]);
  const banner = document.querySelector(".recovery-banner");
  return {
    storageKeysWithWholeMarker: stored.filter(([, v]) => v.includes(marker)).map(([k]) => k),
    storageKeysWithMarkerPrefix: stored.filter(([, v]) => v.includes(marker.slice(0, 3))).map(([k]) => k),
    recoveryBanner: banner ? banner.innerText.trim().slice(0, 160) : null,
    editorHasWholeMarker: [...document.querySelectorAll(".cm-content")].some((e) => e.innerText.includes(marker)),
    tabs: [...document.querySelectorAll("[role=tab]")].map((t) => t.textContent.trim()).slice(0, 6),
  };
})()
JS
}

# run_arm <name> <mode> <marker> [options of the timed step...]
run_arm() {
    local arm="$1" mode="$2" marker="$3" note="$1.md" xid step disk_gone disk_after after
    shift 3
    local -a extra=("$@")
    printf 'seed\n' > "$WS/$note"
    obs_wait 60 "a native workspace window for $arm" workspace_xid
    obs_wait 60 "the workspace page for $arm" page_answers
    (cd "$WS" && cs open "$note") > "$OBS_WORK/$arm.open.out" 2>&1 || obs_inconclusive "cs open $note failed: $(cat "$OBS_WORK/$arm.open.out")"
    note_is_focused() { page_eval "(document.activeElement?.className || '') + '|' + [...document.querySelectorAll('.cm-content')].map((e) => e.innerText).join('')" | grep -q 'cm-content.*seed'; }
    obs_wait 30 "the note's editor to hold the keyboard for $arm" note_is_focused
    # Past the layout save, so the reopened window restores this tab, and
    # past every timer an earlier edit could have left.
    sleep 3
    xid="$(workspace_xid)"
    xdotool windowactivate --sync "$xid" 2>/dev/null || true
    sleep 0.3
    obs_shot "$arm-1-before"
    step="$(node "$HERE/hide-flush-step.mjs" --inspector "$INSPECTOR" --page "$PAGE" --witness-page "Chan Launcher" \
        --xid "$xid" --marker "$marker" --note-file "$WS/$note" \
        --mode "$mode" --window "$CHAN_WINDOW_ID" --chan "$CHAN_BIN" --desktop-pid "$OBS_DESKTOP_PID" "${extra[@]}")" \
        || obs_log "$arm: the timed step reported a problem: $step"
    disk_gone=false
    grep -q "$marker" "$WS/$note" && disk_gone=true
    head -c 64 "$WS/$note" | od -An -c | head -2 > "$OBS_WORK/$arm.file-after-step.txt"
    if [ "$mode" = kill ]; then
        sleep 1
        obs_shot "$arm-2-killed"
        cs window hide "$CHAN_WINDOW_ID" > "$OBS_WORK/$arm.hide.out" 2>&1 || true
    fi
    obs_wait 30 "the native window to go for $arm" no_workspace_window
    sleep 1
    cs window open "$CHAN_WINDOW_ID" > "$OBS_WORK/$arm.reopen.out" 2>&1 || obs_inconclusive "cs window open failed: $(cat "$OBS_WORK/$arm.reopen.out")"
    obs_wait 60 "the reopened native window for $arm" workspace_xid
    obs_wait 60 "the reopened page for $arm" page_answers
    sleep 4
    after="$(page_eval "$(after_expression "$marker")")" || obs_inconclusive "$arm: the reopened page did not answer"
    obs_shot "$arm-3-reopened"
    disk_after=false
    grep -q "$marker" "$WS/$note" && disk_after=true
    printf '{"arm":"%s","step":%s,"diskHadMarkerWhenWindowGone":%s,"after":%s,"diskHasMarkerAfterReopen":%s}\n' \
        "$arm" "${step:-null}" "$disk_gone" "$after" "$disk_after" >> "$RESULTS"
    obs_log "$arm: $(tail -1 "$RESULTS" | cut -c1-600)"
}

run_arm settled settled Sq1xk
run_arm hide hide Hq2xk
run_arm uninspected hide Uq3xk --uninspected
run_arm kill kill Kq4xk

obs_log "results: $RESULTS; desktop log: $OBS_WORK/desktop.log; screenshots: $OBS_WORK/shots"
obs_verdict
python3 - "$RESULTS" <<'PY'
import json
import sys

arms = {}
for line in open(sys.argv[1]):
    row = json.loads(line)
    arms[row["arm"]] = row

def kept(row):
    after = row["after"]
    return bool(after["storageKeysWithWholeMarker"]) or after["editorHasWholeMarker"] or row["diskHasMarkerAfterReopen"]

def inconclusive(reason):
    print(f"INCONCLUSIVE: {reason}")
    sys.exit(3)

for name in ("settled", "hide", "uninspected", "kill"):
    if name not in arms or not arms[name].get("step"):
        inconclusive(f"the {name} arm has no record of its timed step")
    if arms[name]["step"].get("error"):
        inconclusive(f"the {name} arm's timed step failed: {arms[name]['step']['error']}")

settled, hide, blind, kill = (arms[n] for n in ("settled", "hide", "uninspected", "kill"))

# The readers see a kept edit.
if not settled["step"]["before"]["editorHasWholeMarker"]:
    inconclusive("typing did not reach the editor in the settled arm")
if not kept(settled):
    inconclusive("the settled arm lost its marker, so the readers cannot see a kept edit")

# The witness sees a page that ended with no unload: it must be silent
# there, or it says nothing where it speaks.
if not kill["step"]["before"]["editorHasWholeMarker"]:
    inconclusive("typing did not reach the editor in the kill arm")
if kill["step"]["aftermath"]["pagehideWitness"] is not None:
    inconclusive("the pagehide witness spoke for a page whose process was killed")

def not_pending(row, inspected):
    step = row["step"]
    if inspected:
        before = step["before"]
        if not before["editorHasWholeMarker"]:
            return "the editor did not hold the whole marker before the hide"
        if before["storageKeysWithMarkerPrefix"]:
            return "part of the marker was already in localStorage before the hide"
    if step["fileHadMarkerBeforeAction"] is not False:
        return "the marker was already in the file before the hide, or the file could not be read"
    if step["goneAfterFirstKeyMs"] >= 500:
        return f"the window went {step['goneAfterFirstKeyMs']} ms after the first keystroke, past the 500 ms debounce"
    return None

for name, row, inspected in (("hide", hide, True), ("uninspected", blind, False)):
    reason = not_pending(row, inspected)
    if reason:
        inconclusive(f"the {name} arm's edit was not shown to be pending: {reason}")

summary = {
    "wholeMarkerKeptAfterReopen": {"hide": kept(hide), "uninspected": kept(blind)},
    "goneAfterFirstKeyMs": {"hide": hide["step"]["goneAfterFirstKeyMs"], "uninspected": blind["step"]["goneAfterFirstKeyMs"]},
    "pagehideAtHostHide": hide["step"]["aftermath"]["pagehideWitness"] is not None,
    "recoveryBufferHeldWholeMarkerAfterHide": {
        "hide": bool(hide["step"]["aftermath"]["storageKeysWithWholeMarker"]),
        "uninspected": bool(blind["step"]["aftermath"]["storageKeysWithWholeMarker"]),
    },
    "fileHeldWholeMarkerAfterHide": {"hide": hide["step"]["fileHadMarkerAfterAction"], "uninspected": blind["step"]["fileHadMarkerAfterAction"]},
    "recoveryBannerAfterReopen": {"hide": hide["after"]["recoveryBanner"], "uninspected": blind["after"]["recoveryBanner"]},
    # Not a control: what a page that got no unload at all left behind.
    "killedPage": {"wholeMarkerKeptAfterReopen": kept(kill), "fileHeldWholeMarkerAfterKill": kill["step"]["fileHadMarkerAfterAction"]},
}
print(json.dumps(summary))
outcomes = summary["wholeMarkerKeptAfterReopen"]
if all(outcomes.values()):
    print("PASS: a host-side hide kept a text edit inside its recovery debounce (WebKitGTK)")
    sys.exit(0)
if not any(outcomes.values()):
    print("FAULT: a host-side hide lost a text edit inside its recovery debounce (WebKitGTK)")
    sys.exit(1)
inconclusive("the two hide arms disagree, so the inspector's presence may decide the outcome")
PY
verdict=$?
[ "$verdict" = 0 ] || obs_log "work dir kept at $OBS_WORK"
exit "$verdict"
