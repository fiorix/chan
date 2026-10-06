#!/usr/bin/env bash
# Does a hide the desktop makes without asking the page keep a text edit
# that is still inside its recovery debounce?
#
# `cs window hide` buries a window with no call into its page, and the
# watcher then destroys the webview. A text tab's recovery write waits 500 ms
# after an edit, so an edit typed just before the hide survives only if the
# engine runs the page's unload handler as the webview goes.
#
# That is true of a tab that is NOT attached to a document session, and
# those are the tabs this driver types into: it sets the page's opt-out
# (`chan.docsync` = "0" in localStorage) and reopens the window before any
# note is opened. An attached tab also sends each edit to the server's
# document session shortly after it is typed, and once it is there the
# server keeps it whatever the page does next; on such a tab a kept edit
# says nothing about the unload, and this driver could not see the fault
# there.
#
# This drives a real chan-desktop under Xvfb. Each arm opens a fresh note,
# types a marker through X input, ends the page in the arm's way, opens the
# window again and reads the new page. The page itself is the instrument,
# read through the engine's remote inspector: before the hide it says
# whether the editor holds the whole marker and whether any of it is already
# in localStorage; once the page is gone the launcher's page, which shares
# its origin's storage, says whether a `pagehide` witness planted before the
# typing fired and whether a recovery buffer holds the whole marker; and
# after the reopen the new page says whether its storage or its editor
# holds it, and whether it shows a recovery banner. The banner says that
# changes were found, not which, so it is reported and decides nothing.
#
# Arms:
#   rest         nothing ends. It records how long the file takes to
#                receive an edit left alone. No rule rests on it: that is
#                the save's delay, not the recovery write's, and it does not
#                say whether a tab is attached.
#   settled      the hide comes 2.5 s after the typing, past the recovery
#                debounce and the autosave. The marker must be kept; a miss
#                is an instrument fault.
#   hide         the subject. Counts only if the page said, before the hide,
#                that the editor held the whole marker and storage held none
#                of it, the file did not hold it, the native window was gone
#                less than 500 ms after the first keystroke, and the page
#                ended no later than the late kill below.
#   uninspected  the subject again with no inspector attached to the page
#                and no witness planted during the timed step. It has no
#                reading of the page before the hide, so it corroborates
#                the hide arm and does not count by itself.
#   kill         the page's web process is killed in place of the hide. No
#                unload handler can run, so the marker must be lost and the
#                pagehide witness silent. A kept marker means the readers
#                cannot see a loss, or the edit was not pending.
#   kill-late    the same, with the kill held until 400 ms after the typing
#                ended, later than the hide arms' pages end and still inside
#                the debounce. An edit lost here was pending that long.
#
# An edit that a hide arm kept is a pending edit preserved only if that
# arm's page ended no later than the late kill: only then did a control of
# the same run show an edit that old still pending. The run ends 0 only when
# both hide arms kept their edit inside the late kill. With the hide arm
# inside it and the uninspected arm beyond it, the run is inconclusive as a
# whole and prints a PASS for the hide arm alone, with both times. Every
# run prints one line per hide arm; the hide arm's line says PASS only when
# the uninspected arm kept its edit too, since an edit the arm without the
# inspector lost is the reading to follow up. An edit both arms lost is the
# fault wherever the late kill fell; the lines say what was lost and when,
# and claim no more of the timing than that.
#
# Text only, and unattached tabs only: an attached tab and a drawing's
# stroke are not covered here (hide-stroke.sh has the stroke). Speaks for
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

# 2. Opt the page out of document sessions and reopen the window, so the
# page that opens the notes read the opt-out as it loaded.
page_eval "localStorage.setItem('chan.docsync', '0'); true" >/dev/null || obs_inconclusive "the page refused the document session opt-out"
cs window hide "$CHAN_WINDOW_ID" > "$OBS_WORK/optout.hide.out" 2>&1 || obs_inconclusive "cs window hide failed: $(cat "$OBS_WORK/optout.hide.out")"
obs_wait 30 "the native window to go for the opt-out" no_workspace_window
sleep 1
cs window open "$CHAN_WINDOW_ID" > "$OBS_WORK/optout.reopen.out" 2>&1 || obs_inconclusive "cs window open failed: $(cat "$OBS_WORK/optout.reopen.out")"
obs_wait 60 "the reopened native window" workspace_xid
opted_out() { page_eval "document.readyState + ':' + localStorage.getItem('chan.docsync')" | grep -qx '"complete:0"'; }
obs_wait 60 "the reopened page to carry the opt-out" opted_out
obs_log "the page's document sessions are off for this run"

# What the reopened page holds of a marker.
after_expression() {
    cat <<JS
(() => {
  const marker = "$1";
  const stored = Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) || ""]);
  // A tab that is not showing keeps its banner in the document with no
  // rendered text, so the banner on screen is the one that has some.
  const banner = [...document.querySelectorAll(".recovery-banner")].find((b) => b.innerText.trim() !== "");
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
    if [ "$mode" = rest ]; then
        printf '{"arm":"%s","step":%s}\n' "$arm" "${step:-null}" >> "$RESULTS"
        obs_log "$arm: $(tail -1 "$RESULTS" | cut -c1-500)"
        return 0
    fi
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

run_arm rest rest Rq0xk
run_arm settled settled Sq1xk
run_arm hide hide Hq2xk
run_arm uninspected hide Uq3xk --uninspected
run_arm kill kill Kq4xk
run_arm kill-late kill Lq5xk --kill-after-ms 400

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

names = ("rest", "settled", "hide", "uninspected", "kill", "kill-late")
for name in names:
    if name not in arms or not arms[name].get("step"):
        inconclusive(f"the {name} arm has no record of its timed step")
    if arms[name]["step"].get("error"):
        inconclusive(f"the {name} arm's timed step failed: {arms[name]['step']['error']}")

# Kept is the whole marker in the recovery buffer, the editor or the file.
# A recovery banner alone is not: it says that changes were found, not
# which. It is reported beside the outcome.
def kept(row):
    after = row["after"]
    return (bool(after["storageKeysWithWholeMarker"]) or after["editorHasWholeMarker"]
            or row["diskHasMarkerAfterReopen"])

rest, settled, hide, blind, kill, late = (arms[n] for n in names)

# How long the file took to receive an edit left alone. Recorded, and no
# rule rests on it: it is the save's delay, not the recovery write's.
took = rest["step"]["fileTookMarkerAfterInputEndMs"]

# The readers see a kept edit.
if not settled["step"]["before"]["editorHasWholeMarker"]:
    inconclusive("typing did not reach the editor in the settled arm")
if not kept(settled):
    inconclusive("the settled arm lost its marker, so the readers cannot see a kept edit")

def not_pending(row, inspected):
    step = row["step"]
    if inspected:
        before = step["before"]
        if not before["editorHasWholeMarker"]:
            return "the editor did not hold the whole marker before the page ended"
        if before["storageKeysWithMarkerPrefix"]:
            return "part of the marker was already in localStorage before the page ended"
    if step["fileHadMarkerBeforeAction"] is not False:
        return "the marker was already in the file before the page ended, or the file could not be read"
    if "goneAfterFirstKeyMs" in step and step["goneAfterFirstKeyMs"] >= 500:
        return f"the window went {step['goneAfterFirstKeyMs']} ms after the first keystroke, past the 500 ms debounce"
    return None

# The readers see a lost edit, and the witness is silent without an unload.
for name, row in (("kill", kill), ("kill-late", late)):
    reason = not_pending(row, True)
    if reason:
        inconclusive(f"the {name} arm's edit was not shown to be pending: {reason}")
    if row["step"]["aftermath"]["pagehideWitness"] is not None:
        inconclusive(f"the pagehide witness spoke for the {name} arm's page, whose process was killed")
if kept(kill):
    inconclusive("the kill arm kept its marker, so the readers cannot see a lost edit, or the edit was already stored or sent")
# A killed page keeps only what it had stored or sent. An edit lost when its
# page is killed this long after the typing was still pending then.
killed_after = late["step"]["actionAfterInputEndMs"]
if killed_after >= 500:
    inconclusive(f"the kill-late arm's page was killed {killed_after} ms after its typing ended, past the debounce")
if kept(late):
    inconclusive(f"an edit whose page was killed {killed_after} ms after it was typed was kept, so an edit that old is no longer pending")

for name, row, inspected in (("hide", hide, True), ("uninspected", blind, False)):
    reason = not_pending(row, inspected)
    if reason:
        inconclusive(f"the {name} arm's edit was not shown to be pending: {reason}")
# Whether each hide arm's page ended no later than the late kill, which is
# what shows an edit that old was still pending.
gone = {"hide": hide["step"]["goneAfterInputEndMs"], "uninspected": blind["step"]["goneAfterInputEndMs"]}
inside = {name: ms <= killed_after for name, ms in gone.items()}

summary = {
    "wholeMarkerKeptAfterReopen": {"hide": kept(hide), "uninspected": kept(blind)},
    "goneAfterFirstKeyMs": {"hide": hide["step"]["goneAfterFirstKeyMs"], "uninspected": blind["step"]["goneAfterFirstKeyMs"]},
    "goneAfterTypingEndMs": gone,
    "endedInsideLateKill": inside,
    "restingEditReachedFileAfterMs": took,
    "killedPageLostEditWhenKilledMsAfterTypingEnd": {"kill": kill["step"]["actionAfterInputEndMs"], "kill-late": killed_after},
    "pagehideAtHostHide": hide["step"]["aftermath"]["pagehideWitness"] is not None,
    "recoveryBufferHeldWholeMarkerAfterHide": {
        "hide": bool(hide["step"]["aftermath"]["storageKeysWithWholeMarker"]),
        "uninspected": bool(blind["step"]["aftermath"]["storageKeysWithWholeMarker"]),
    },
    "fileHeldWholeMarkerAfterHide": {"hide": hide["step"]["fileHadMarkerAfterAction"], "uninspected": blind["step"]["fileHadMarkerAfterAction"]},
    "recoveryBannerAfterReopen": {"hide": hide["after"]["recoveryBanner"], "uninspected": blind["after"]["recoveryBanner"]},
}
print(json.dumps(summary))
outcomes = summary["wholeMarkerKeptAfterReopen"]
# Each hide arm by itself, whatever the run's status, so that a later
# reading can say exactly what was observed. Only the hide arm, which has
# the page's word before the hide, can pass by itself.
for name in ("hide", "uninspected"):
    if inside[name]:
        where = f"inside the {killed_after} ms late kill"
    else:
        where = f"beyond the {killed_after} ms late kill, where no control of this run showed an edit that old still pending"
    when = f"its page ended {gone[name]} ms after the typing, {where}"
    if not outcomes[name]:
        print(f"LOST, {name} arm: its edit was in neither the recovery buffer, the editor nor the file after the reopen; {when}")
    elif not inside[name]:
        print(f"KEPT, NOT CONTROLLED, {name} arm: {when}")
    elif name == "hide" and outcomes["uninspected"]:
        print(f"PASS, hide arm: kept an edit a control showed still pending; {when}")
    elif name == "hide":
        # No PASS in a run whose uninspected arm lost its edit: that loss is
        # the reading that matters, and this must not be the line quoted.
        print(f"KEPT, hide arm (inspector attached): {when}")
    else:
        print(f"KEPT, uninspected arm: {when}; it has no reading of the page before the hide and corroborates only")
# An edit both arms lost is the fault wherever the late kill fell. The
# lines above say what was lost and when; an arm beyond the late kill is
# not claimed to have been shown pending by it.
if not any(outcomes.values()):
    sys.exit(10)
if not all(outcomes.values()):
    if outcomes["hide"]:
        inconclusive("the uninspected arm lost its edit where the hide arm, with the inspector attached, kept its: the inspector's presence during the timed step may decide the outcome, and the uninspected loss is the observation to follow up")
    inconclusive("the hide arm, with the inspector attached, lost its edit where the uninspected arm kept its: the two arms disagree, and the run shows neither outcome")
# Both kept. Status 0 says that both hide arms preserved an edit inside the
# late kill, and nothing less.
if all(inside.values()):
    print("PASS: a host-side hide kept an unattached tab's text edit inside its recovery debounce, in both hide arms, each inside the late kill (WebKitGTK)")
    sys.exit(0)
if inside["hide"]:
    inconclusive("only the hide arm is inside the late kill: its PASS above stands for that arm, and the run as a whole does not show the uninspected case")
inconclusive(f"the hide arm's page ended {gone['hide']} ms after its typing, later than the {killed_after} ms at which a killed page was shown to have kept nothing, so its kept edit was not shown to be pending")
PY
obs_judge "$?" "a host-side hide lost an unattached tab's text edit in both hide arms (WebKitGTK); the lines above say what was lost and when each page ended"
