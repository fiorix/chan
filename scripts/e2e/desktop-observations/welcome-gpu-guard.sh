#!/usr/bin/env bash
# Observe the welcome's GPU guard in the Linux desktop WebKitGTK page.
# The GPU-less collection needs host cpu.stat samples; judge them in a second invocation.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

mode="${1:-}"
output="${2:-}"
reading=gpu-less
samples=
verbose=()
dry_run="${OBS_CONTROL_DRY_RUN:-0}"
for arg in "${@:3}"; do
    case "$arg" in
    --control) reading=control ;;
    -v) verbose=(-v) ;;
    *)
        if [ "$mode" = judge ] && [ -z "$samples" ]; then
            samples="$arg"
        else
            obs_inconclusive "unknown driver argument: $arg"
        fi
        ;;
    esac
done
[[ "$dry_run" = 0 || "$dry_run" = 1 ]] || obs_inconclusive "OBS_CONTROL_DRY_RUN must be 0 or 1"
[ "$dry_run" = 0 ] || [ "$reading" = control ] || obs_inconclusive "OBS_CONTROL_DRY_RUN needs --control"
if [ "$mode" = judge ]; then
    [ -n "$output" ] && [ -f "$output/observations.json" ] || obs_inconclusive "judge needs an observation directory"
    if [ "$reading" = gpu-less ]; then
        [ -f "$samples" ] || obs_inconclusive "the GPU-less judge needs host samples"
    else
        samples=-
    fi
    OBS_NAME=welcome-gpu-guard
    OBS_WORK="$output"
    obs_need node
    set +e
    node "$HERE/welcome-gpu-guard.mjs" read "$output" "$samples" "$reading" > "$output/reader.log" 2>&1
    verdict=$?
    set -e
    cat "$output/reader.log" | obs_masked >&2
    obs_verdict
    obs_judge "$verdict" "the welcome's GPU guard made the wrong decision"
fi

[ "$mode" = collect ] && [ -n "$output" ] || obs_inconclusive "usage: welcome-gpu-guard.sh collect OUTPUT [--control] [-v] | judge OUTPUT HOST-SAMPLES | judge OUTPUT --control; OBS_CONTROL_DRY_RUN=1 drives three control choices and exits 3"
if [ "$reading" = gpu-less ]; then : "${DISPLAY:?run under xvfb-run with a fixed screen}"; fi
export CHAN_BIN
obs_setup welcome-gpu-guard "$reading"
obs_need node sha256sum python3
mkdir -m 700 "$output"
sha256sum "$HERE/welcome-gpu-guard.sh" "$HERE/welcome-gpu-guard.mjs" "$HERE/lib.sh" "$HERE/inspect.mjs" > "$output/instrument-sha256.txt"
if [ "$reading" = control ]; then
    obs_need weston
    if [ "$dry_run" = 1 ]; then obs_need dpkg-query; else obs_need pacman; fi
    [ "$dry_run" = 1 ] || [ -d /dev/dri ] || obs_refuse "the control needs a GPU render node"
    [ -f "${OBS_ENGINE_VERSION_FILE:-}" ] || obs_refuse "the control needs OBS_ENGINE_VERSION_FILE from the guest AppImage build"
    cp "$OBS_ENGINE_VERSION_FILE" "$output/engine-package.txt"
    if [ "$dry_run" = 1 ]; then
        dpkg-query -W libwebkit2gtk-4.1-0 > "$output/system-engine-package.txt" || obs_refuse "cannot identify the system WebKitGTK package"
    else
        pacman -Q webkit2gtk-4.1 > "$output/system-engine-package.txt" || obs_refuse "cannot identify the system WebKitGTK package"
    fi
    export WAYLAND_DISPLAY=wayland-chan-control
    weston --no-config --backend=headless --renderer=gl --shell=kiosk-shell.so \
        --socket="$WAYLAND_DISPLAY" --width=1600 --height=1000 > "$OBS_WORK/weston.log" 2>&1 &
    OBS_WESTON_PID=$!
    export OBS_WESTON_PID
    OBS_PIDS+=("$OBS_WESTON_PID")
    obs_wait 30 "the private Wayland compositor" test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
    printf '%s\n' "GDK_BACKEND=$GDK_BACKEND" "WAYLAND_DISPLAY=$WAYLAND_DISPLAY" > "$output/display-environment.txt"
else
    obs_need xvfb-run dpkg-query
    dpkg-query -W libwebkit2gtk-4.1-0 > "$output/engine-package.txt"
    if [ -e /dev/dri ]; then obs_refuse "/dev/dri exists in the GPU-less reading"; fi
    printf '%s\n' "LIBGL_ALWAYS_SOFTWARE=$LIBGL_ALWAYS_SOFTWARE" "WEBKIT_DISABLE_DMABUF_RENDERER=$WEBKIT_DISABLE_DMABUF_RENDERER" "GDK_BACKEND=$GDK_BACKEND" > "$output/software-environment.txt"
fi
cat /proc/self/timens_offsets > "$output/time-namespace-offsets.txt"
inspector_free() {
    python3 -c 'import socket, sys; sock = socket.socket(); sock.bind(("127.0.0.1", int(sys.argv[1]))); sock.close()' "$1" 2>/dev/null
}
if [ -n "${OBS_INSPECTOR_PORT:-}" ]; then
    [[ "$OBS_INSPECTOR_PORT" =~ ^[0-9]+$ ]] && [ "$OBS_INSPECTOR_PORT" -ge 1 ] && [ "$OBS_INSPECTOR_PORT" -le 65535 ] || obs_refuse "invalid OBS_INSPECTOR_PORT"
    inspector_port="$OBS_INSPECTOR_PORT"
    inspector_free "$inspector_port" || obs_refuse "TCP bind test found inspector port $inspector_port occupied"
else
    inspector_port=
    for _ in {1..20}; do
        candidate=$((20000 + RANDOM % 20000))
        if inspector_free "$candidate"; then inspector_port="$candidate"; break; fi
    done
    [ -n "$inspector_port" ] || obs_refuse "TCP bind test found no free inspector port in 20 picks"
fi
INSPECTOR="127.0.0.1:$inspector_port"
printf 'TCP bind test: %s free on 127.0.0.1 (released before WebKit bind)\n' "$inspector_port" | tee "$output/inspector-port.txt" >&2
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
if [ "$reading" = gpu-less ]; then
    openbox > "$OBS_WORK/openbox.log" 2>&1 &
    OBS_PIDS+=("$!")
    obs_wait 20 "the window manager" xprop -root _NET_SUPPORTING_WM_CHECK
fi
obs_start_desktop

WS="$OBS_WORK/ws"
mkdir -p "$WS"
printf 'Native welcome observation\n' > "$WS/a.md"
chan serve "$WS" > "$OBS_WORK/serve.out" 2>&1 || obs_inconclusive "chan serve was not handed off: $(obs_masked < "$OBS_WORK/serve.out")"
if [ "$reading" = gpu-less ]; then
    workspace_xid() { obs_x_window_titled "$WS"; }
    obs_wait 60 "the native workspace window" workspace_xid
    xid="$(workspace_xid)"
    xdotool windowactivate --sync "$xid"
fi
page_eval() { node "$HERE/inspect.mjs" "$INSPECTOR" eval "/workspace-" "$1"; }
# shellcheck disable=SC2329
page_answers() { page_eval "document.readyState" | grep -q complete; }
obs_wait 60 "the workspace page to answer the inspector" page_answers
CHAN_WINDOW_ID="$(page_eval "new URLSearchParams(location.search).get('w')" | tr -d '"')"
export CHAN_WINDOW_ID
[ -n "$CHAN_WINDOW_ID" ] || obs_inconclusive "the workspace page names no window id"
sockets="$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name 'chan-control-*.sock')"
for socket in $sockets; do
    CHAN_CONTROL_SOCKET="$socket"
    export CHAN_CONTROL_SOCKET
    if cs pane list --window "$CHAN_WINDOW_ID" --json > "$OBS_WORK/panes.out" 2>&1; then break; fi
    CHAN_CONTROL_SOCKET=""
done
[ -n "${CHAN_CONTROL_SOCKET:-}" ] || obs_inconclusive "no private control socket addresses the workspace window"
if [[ "${CHAN_CONTROL_SOCKET##*/}" =~ ^chan-control-([0-9]+)-.*\.sock$ ]]; then
    desktop_child_pid="${BASH_REMATCH[1]}"
    if [ "$desktop_child_pid" != "$OBS_DESKTOP_PID" ]; then OBS_PIDS+=("$desktop_child_pid"); fi
    OBS_DESKTOP_PID="$desktop_child_pid"
    export OBS_DESKTOP_PID
else
    obs_inconclusive "cannot identify the AppImage desktop process"
fi
if [ "$reading" = gpu-less ]; then
    xdotool getwindowgeometry --shell "$xid" > "$output/window-geometry.txt"
fi
"$CHAN_DESKTOP_BIN" --version > "$output/versions.txt"
"$CHAN_BIN" --version >> "$output/versions.txt"
if [ "$reading" = control ]; then weston --version >> "$output/versions.txt"; fi
git -C "$OBS_REPO" rev-parse HEAD > "$output/source-sha.txt"
sha256sum "$CHAN_DESKTOP_BIN" "$CHAN_BIN" > "$output/binaries-sha256.txt"
obs_log "native $reading reading, engine $(cat "$output/engine-package.txt")"
obs_verdict
drive_options=("${verbose[@]}")
if [ "$dry_run" = 1 ]; then drive_options+=(--dry-run); fi
OBS_DESKTOP_PID="$OBS_DESKTOP_PID" node "$HERE/welcome-gpu-guard.mjs" drive "$INSPECTOR" "$CHAN_WINDOW_ID" "$CHAN_CONTROL_SOCKET" "$WS" "$output" "$reading" "${drive_options[@]}"
verdict=$?
if [ "$verdict" -eq 2 ]; then obs_refuse "the native GPU reading's precondition failed"; fi
obs_judge "$verdict" "the native collection observed a guard failure"
