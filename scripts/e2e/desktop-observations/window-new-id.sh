#!/usr/bin/env bash
# The id `cs window new` prints must work with `--window` immediately. One disposable
# desktop under Xvfb with one workspace handed to it. Through the control
# socket of the workspace's tenant, and of the standalone terminals' tenant,
# `cs window new` opens a window; the first `cs pane list --window ID` after
# it returns must answer for the id that was printed, and that id must name
# the new connected registry row.
#
#   window-new-id.sh
#
# A refused first read is a fault even if a later read works. Both arms run
# before observed faults are reported. Delayed reads are diagnostic only:
# their sampled delay is an upper bound, logged as "at most". A missing
# tenant, a window that never connects, or a refusal of both the printed
# and listed ids throughout the diagnostic wait is inconclusive.
#
# Speaks for WebKitGTK only. Needs what lib.sh needs and a built chan-desktop
# and chan with the web bundles. Exit codes are lib.sh's.
# The small checks defined below are polled by name through obs_wait, and a
# linter cannot follow a function that is passed by name.
# shellcheck disable=SC2329
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_setup window-new-id
obs_start_display
obs_start_desktop
obs_log "desktop build: $(grep -m1 -o 'build[^ ]*git-[0-9a-f]*[^ ]*' "$OBS_WORK/desktop.log" | sed 's/\x1b\[[0-9;]*m//g' || echo unknown)"

WS="$OBS_WORK/ws"
mkdir -p "$WS"
workspace_xid() { obs_x_local_window_titled "$WS"; }
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
obs_wait 60 "the native workspace window" workspace_xid

# windows <socket>: the registry's windows, one "<window id> <kind> <status>"
# per line. A record carries its tenant's token, so the records are parsed
# here and never logged.
windows() {
    CHAN_CONTROL_SOCKET="$1" cs window list --json 2>/dev/null | python3 -c '
import json, sys
for w in json.load(sys.stdin):
    print(w["window_id"], w["kind"], "connected" if w["connected"] else "offline")'
}
takes() { CHAN_CONTROL_SOCKET="$1" cs pane list --window "$2" --json > /dev/null 2>&1; }
# Milliseconds from whole nanoseconds, which GNU date and uutils date print alike.
now_ms() { echo $(($(date +%s%N) / 1000000)); }

# socket_of <kind>: the control socket that addresses a connected window of
# that kind, which is its tenant's.
socket_of() {
    local sock id
    for sock in $(obs_control_sockets); do
        for id in $(windows "$sock" | awk -v kind="$1" '$2 == kind && $3 == "connected" { print $1 }'); do
            if takes "$sock" "$id"; then
                printf '%s\n' "$sock"
                return 0
            fi
        done
    done
    return 1
}

# arm <kind> <socket>: one `cs window new` through that tenant's socket.
ARM_FAULTS=()
arm() {
    local kind="$1" sock="$2" before printed listed returned first delay=""
    before="$(windows "$sock" | cut -d' ' -f1)"
    printed="$(CHAN_CONTROL_SOCKET="$sock" cs window new 2> "$OBS_WORK/$kind.new.err")" \
        || obs_inconclusive "$kind: cs window new failed: $(obs_masked < "$OBS_WORK/$kind.new.err")"
    returned="$(now_ms)"
    if takes "$sock" "$printed"; then first=0; delay=0; else first=$?; fi
    new_window() {
        listed="$(windows "$sock" | awk '$3 == "connected" { print $1 }' | grep -Fxv -f <(printf '%s\n' "$before") | sed -n 1p)"
        [ -n "$listed" ]
    }
    obs_wait 60 "$kind: the window registry to list the new window as connected" new_window
    new_window
    obs_shot "$kind-connected"
    if [ "$printed" != "$listed" ]; then
        obs_log "$kind: cs window new printed $printed, but the new connected window is $listed (first=$first)"
        ARM_FAULTS+=("$kind: printed $printed instead of new window $listed")
        return 0
    fi
    local deadline=$((SECONDS + 10))
    while [ -z "$delay" ] && [ "$SECONDS" -lt "$deadline" ]; do
        if takes "$sock" "$printed"; then delay=$(($(now_ms) - returned)); else sleep 0.1; fi
    done
    if [ "$first" = 0 ]; then
        obs_log "$kind: PASS: first=0: cs window new printed $printed and the first --window read took it (the registry lists $listed)"
        return 0
    fi
    if [ -n "$delay" ]; then
        obs_log "$kind: first=$first: cs window new printed $printed; --window first took it at most ${delay} ms after it returned (the registry lists $listed)"
        ARM_FAULTS+=("$kind: first=$first for $printed")
        return 0
    fi
    takes "$sock" "$listed" \
        || obs_inconclusive "$kind: --window takes neither the printed id $printed nor the listed id $listed"
    obs_log "$kind: first=$first: cs window new printed $printed, which --window refuses; it takes $listed, the id the registry lists for that window"
    ARM_FAULTS+=("$kind: first=$first for $printed; --window takes only listed id $listed")
}

obs_wait 60 "a control socket that addresses the workspace window" socket_of workspace
arm workspace "$(socket_of workspace)"
obs_wait 60 "a control socket that addresses the standalone terminal window" socket_of terminal
arm terminal "$(socket_of terminal)"
if ((${#ARM_FAULTS[@]})); then
    obs_fault "cs window new returned an incorrect or initially unusable id: ${ARM_FAULTS[*]}"
fi
