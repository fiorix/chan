#!/usr/bin/env bash
# Shared setup for the desktop observation drivers: a throwaway home, a
# virtual X display with a window manager, a real chan-desktop, and the
# readers the drivers take their verdicts from. Sourced, never run.
#
# The drivers speak for one engine only, the WebKitGTK the Linux desktop
# ships on. WKWebView and WebView2 are different engines and are not
# covered by a run of these.
#
# Exit codes every driver uses:
#   0  the contract held
#   1  the fault was observed
#   2  the environment cannot run the driver
#   3  inconclusive: a control arm or an instrument failed, or the driver
#      itself met an error it does not expect
# A 2 or a 3 is not a pass. Exit 1 is reached through obs_fault alone: the
# exit trap below turns any other exit with status 1, such as the shell's
# own for an unset variable, into 3, and a verdict script reports a fault
# with its own status 10 (obs_judge), so that its crashing cannot.

OBS_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OBS_SHA="${OBS_SHA:-$(git -C "$OBS_REPO" rev-parse HEAD 2>/dev/null || echo unknown)}"
CHAN_DESKTOP_BIN="${CHAN_DESKTOP_BIN:-$OBS_REPO/target/debug/chan-desktop}"
CHAN_BIN="${CHAN_BIN:-$OBS_REPO/target/debug/chan}"
OBS_PIDS=()
# Set by obs_fault, and by nothing else, immediately before the exit that
# reports an observed fault.
OBS_FAULT_OBSERVED=0

# The binary under test, by the two names its commands go by. `cs` is
# `chan shell`, which needs CHAN_CONTROL_SOCKET and CHAN_WINDOW_ID from a
# driver that runs outside a chan terminal.
chan() { "$CHAN_BIN" "$@"; }
cs() { "$CHAN_BIN" shell "$@"; }

# Every line a driver logs is masked here, so no call site has to remember.
obs_log() { printf '%s: %s\n' "${OBS_NAME:-desktop-observation}" "$*" | obs_masked >&2; }
obs_refuse() { obs_log "cannot run: $*"; exit 2; }
obs_inconclusive() {
    obs_log "INCONCLUSIVE: $*"
    obs_log "work dir at ${OBS_WORK:-unknown}"
    exit 3
}

# obs_fault <message>: the one way a driver reports an observed fault.
obs_fault() {
    obs_log "FAULT: $*"
    obs_log "work dir at ${OBS_WORK:-unknown}"
    OBS_FAULT_OBSERVED=1
    exit 1
}

# Mask a launch, tenant or devserver token and URL holder/fragment state
# wherever a log or a report may carry one: in a URL, in the devserver's marker
# line, and in the JSON of a window or workspace record.
obs_masked() {
    sed -E 's/([?&]t=)[^&[:space:]"]+/\1<token>/g; s/([?&]h=)[^&#[:space:]"]+/\1<holder>/g; s/(#s=)[^&[:space:]"]+/\1<state>/g; s/(CHAN_DEVSERVER_TOKEN=)[^[:space:]]+/\1<token>/g; s/("(devserver_)?token"[[:space:]]*:[[:space:]]*")[^"]*"/\1<token>"/g'
}

obs_now_ms() { date +%s%3N; }

# obs_wait <seconds> <description> <command...>: poll until the command
# succeeds; inconclusive when it has not within the bound.
obs_wait() {
    local secs="$1" what="$2"; shift 2
    local deadline=$((SECONDS + secs))
    until "$@" >/dev/null 2>&1; do
        [ "$SECONDS" -lt "$deadline" ] || obs_inconclusive "timed out after ${secs}s waiting for $what"
        sleep 0.2
    done
}

obs_need() {
    local tool
    for tool in "$@"; do
        command -v "$tool" >/dev/null 2>&1 || obs_refuse "$tool is not installed"
    done
}

# obs_setup <name>: the work dir, an environment that shares nothing with
# the caller's chan session, and the cleanup of what this run starts.
obs_setup() {
    OBS_NAME="$1"
    obs_need Xvfb openbox xdotool xprop import python3 curl
    [ -x "$CHAN_DESKTOP_BIN" ] || obs_refuse "no chan-desktop binary at $CHAN_DESKTOP_BIN (set CHAN_DESKTOP_BIN)"
    [ -x "$CHAN_BIN" ] || obs_refuse "no chan binary at $CHAN_BIN (set CHAN_BIN)"
    OBS_WORK="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-$OBS_NAME.XXXXXX")"
    local v
    for v in $(compgen -v | grep -E '^CHAN_' | grep -vE '^CHAN_(BIN|DESKTOP_BIN)$'); do unset "$v"; done
    export CHAN_HOME="$OBS_WORK/chan-home"
    export HOME="$OBS_WORK/home"
    export XDG_RUNTIME_DIR="$OBS_WORK/run"
    export TMPDIR="$OBS_WORK/tmp"
    unset XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS
    mkdir -p "$CHAN_HOME" "$HOME" "$XDG_RUNTIME_DIR" "$TMPDIR" "$OBS_WORK/shots"
    chmod 700 "$XDG_RUNTIME_DIR"
    export CHAN_UPDATE_CHECK=0
    export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
    export LIBGL_ALWAYS_SOFTWARE=1
    export GDK_BACKEND=x11
    # A command of the driver that fails where no check expects it ends the
    # run as inconclusive, and this trap can name the line. The exit trap
    # is what holds the rule for errors this one never sees.
    set -E
    trap 'obs_driver_failed "$?" "$LINENO" "${BASH_SOURCE[0]:-driver}"' ERR
    obs_log "work dir $OBS_WORK, drivers at $OBS_SHA"
}

obs_driver_failed() {
    trap - ERR
    obs_log "INCONCLUSIVE: the driver itself failed with status $1 at ${3##*/}:$2"
    obs_log "work dir at ${OBS_WORK:-unknown}"
    exit 3
}

# The exit trap, set when this file is sourced: it ends what the run
# started, and it keeps exit 1 for obs_fault. The shell exits 1 by itself
# for an unset variable under `set -u`, with no ERR trap run; that, and any
# other exit 1 obs_fault did not make, leaves as 3.
obs_on_exit() {
    local status=$?
    trap - ERR EXIT
    obs_cleanup
    if [ "$status" = 1 ] && [ "$OBS_FAULT_OBSERVED" != 1 ]; then
        obs_log "INCONCLUSIVE: the driver exited 1 without having observed a fault"
        obs_log "work dir at ${OBS_WORK:-unknown}"
        exit 3
    fi
    exit "$status"
}
trap obs_on_exit EXIT

# obs_verdict: from here on the driver decides its own exit code.
obs_verdict() {
    trap - ERR
    set +e
}

# obs_judge <status> <fault message>: end a driver by the status of its
# verdict script. The script says "fault observed" with 10 and nothing else
# does: a script that crashes exits 1 like any failed program, and that, as
# every status but 0, 3 and 10, is the instrument failing.
obs_judge() {
    case "$1" in
    0) exit 0 ;;
    10) obs_fault "$2" ;;
    3) obs_inconclusive "the verdict is on the line above" ;;
    *) obs_inconclusive "the verdict script itself failed with status $1" ;;
    esac
}

# obs_forget_pid <pid>: a process the run has waited out is no longer its
# to signal; its pid may since belong to another process.
obs_forget_pid() {
    local pid
    local -a remaining=()
    for pid in "${OBS_PIDS[@]:-}"; do
        [ "$pid" = "$1" ] || remaining+=("$pid")
    done
    OBS_PIDS=("${remaining[@]:-}")
}

obs_cleanup() {
    local pid
    for pid in "${OBS_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    sleep 0.5
    for pid in "${OBS_PIDS[@]:-}"; do
        [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    done
}

# A private X server and a window manager, so windows are mapped, focused
# and take keyboard input as they do on a desktop.
obs_start_display() {
    local n
    for n in $(seq 90 140); do
        [ -e "/tmp/.X11-unix/X$n" ] || [ -e "/tmp/.X$n-lock" ] || break
    done
    export DISPLAY=":$n"
    Xvfb "$DISPLAY" -screen 0 1600x1000x24 -nolisten tcp > "$OBS_WORK/xvfb.log" 2>&1 &
    OBS_PIDS+=("$!")
    obs_wait 20 "the X server" xprop -root _NET_SUPPORTED
    openbox > "$OBS_WORK/openbox.log" 2>&1 &
    OBS_PIDS+=("$!")
    obs_wait 20 "the window manager" xprop -root _NET_SUPPORTING_WM_CHECK
}

# The real desktop, logging what it does to its windows.
obs_start_desktop() {
    CHAN_LOG="${OBS_CHAN_LOG:-warn,chan_desktop=debug}" "$CHAN_DESKTOP_BIN" > "$OBS_WORK/desktop.log" 2>&1 &
    OBS_DESKTOP_PID=$!
    OBS_PIDS+=("$OBS_DESKTOP_PID")
    obs_wait 90 "the desktop handoff socket" test -S "$XDG_RUNTIME_DIR/chan-desktop.sock"
}

# Every viewable X window as "<id> <title>", one per line.
obs_x_windows() {
    local id
    for id in $(xdotool search --onlyvisible --name '.' 2>/dev/null); do
        printf '%s %s\n' "$id" "$(xdotool getwindowname "$id" 2>/dev/null)"
    done
}

# obs_x_window_titled <substring>: the id of the first viewable window whose
# title holds the substring; fails when there is none.
obs_x_window_titled() {
    obs_x_windows | grep -F -- "$1" | sed -n 1p | cut -d' ' -f1 | grep .
}

obs_shot() {
    import -window root "$OBS_WORK/shots/$1.png" 2>> "$OBS_WORK/shots/import.log" || obs_log "screenshot $1 failed"
}

# The control sockets of the desktop's tenants, which `cs` drives a window
# through from outside a chan terminal. A tenant binds its socket in the
# runtime directory under its process id.
obs_control_sockets() {
    find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name "chan-control-$OBS_DESKTOP_PID-*.sock" 2>/dev/null
}
