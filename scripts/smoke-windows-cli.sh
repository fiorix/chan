#!/usr/bin/env bash
# Drive the two Windows-only syscall paths in the standalone chan.exe.
#
# The rest of the `chan` crate is platform-neutral logic already green on the
# Linux and macOS arms through its injectable pure cores (`release_target_for`,
# `parse_cli_with_arg0`, `control_socket_for_pid_in_dirs`). What runs on no arm
# is two thin syscall wrappers, and this smoke is scoped to exactly them:
#
#   1. the `DETACHED_PROCESS` daemon spawn (`devserver_daemon.rs`), and
#   2. the control-socket connect through the `\\.\pipe\` namespace.
#
# It is deliberately NOT a Windows port of the chan-crate test suite, which
# would mostly re-run logic already covered elsewhere; that port is a separate,
# still-deferred item.
set -euo pipefail

BIN="${1:?usage: smoke-windows-cli.sh <chan.exe>}"
[ -f "$BIN" ] || {
    echo "error: built binary not found: $BIN" >&2
    exit 1
}

choose_port() {
    local python
    if [ -n "${CHAN_SMOKE_PORT:-}" ]; then
        printf '%s\n' "$CHAN_SMOKE_PORT"
        return
    fi
    for python in python3 python; do
        if command -v "$python" >/dev/null 2>&1; then
            "$python" -c \
                'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
            return
        fi
    done
    echo "error: set CHAN_SMOKE_PORT or install Python to select a free port" >&2
    exit 1
}

# Control-socket pipes currently published, one name per line.
control_pipes() {
    powershell.exe -NoProfile -Command \
        "Get-ChildItem '\\\\.\\pipe\\' | Where-Object { \$_.Name -like 'chan-control-*' } | Select-Object -ExpandProperty Name" \
        2>/dev/null | tr -d '\r' | sort
}

PORT="$(choose_port)"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -gt 0 ] && [ "$PORT" -le 65535 ] || {
    echo "error: invalid smoke port: $PORT" >&2
    exit 1
}

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chan-windows-cli.XXXXXX")"

# Run hermetically. A chan terminal exports CHAN_CONTROL_SOCKET and friends
# into its children, and `chan open` follows that parentage: inherited, they
# aim this smoke at whatever devserver happens to be hosting the shell instead
# of the daemon it just started. Clear the whole namespace before setting the
# two vars the smoke owns.
while IFS='=' read -r name _; do
    case "$name" in
        CHAN | CHAN_*) unset "$name" ;;
    esac
done < <(env)

export CHAN_HOME="$TMP_ROOT/chan-home"
export CHAN_UPDATE_CHECK=0
mkdir -p "$CHAN_HOME"

# ShellCheck does not trace function calls through trap handlers.
# shellcheck disable=SC2329
cleanup() {
    local status=$?
    "$BIN" devserver --service=chan --stop >/dev/null 2>&1 || true
    # The daemon holds the workspace index and graph open; give its handles a
    # beat to close before removing the tree, and never fail the smoke on a
    # leftover temp file.
    sleep 2
    rm -rf -- "$TMP_ROOT" 2>/dev/null || true
    exit "$status"
}
trap cleanup EXIT INT TERM

# 1. The binary starts at all and its own version is readable. Cheap, but it is
#    the check that catches a chan.exe which cannot reach `main` on Windows --
#    a startup fault no other arm can see.
VERSION="$("$BIN" --version)"
[[ "$VERSION" == chan\ * ]] || {
    echo "error: unexpected --version output: $VERSION" >&2
    exit 1
}
echo "windows cli smoke: --version -> $VERSION"

PIPES_BEFORE="$(control_pipes)"

# 2. The DETACHED_PROCESS spawn. `--service=chan` is the self-managed
#    background backend, so the parent returns while the daemon keeps running
#    detached -- which is the syscall path under test. Redirect to a FILE, not
#    a pipe: the detached child inherits these handles, so a pipe would never
#    reach EOF and the smoke would hang here.
"$BIN" devserver --service=chan --start --bind 127.0.0.1 --port "$PORT" >"$TMP_ROOT/start.log" 2>&1 || {
    echo "error: detached devserver start failed" >&2
    cat "$TMP_ROOT/start.log" >&2
    exit 1
}

BODY=
for ((attempt = 0; attempt < 60; attempt++)); do
    BODY="$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    [[ "$BODY" == *'"status":"ok"'* ]] && break
    sleep 1
done
[[ "$BODY" == *'"status":"ok"'* ]] || {
    echo "error: detached devserver did not answer /api/health on $PORT" >&2
    cat "$TMP_ROOT/start.log" >&2
    exit 1
}
echo "windows cli smoke: DETACHED_PROCESS daemon serving on 127.0.0.1:$PORT"

# 3. The `\\.\pipe\` control-socket discovery and connect. A devserver
#    publishes one control socket per mounted tenant rather than one per
#    process, so a workspace has to be served before any pipe exists.
#
#    `chan ps` drives the whole path in one command: it reads the holder pid
#    from the workspace lock record, enumerates the pipe namespace for that
#    pid's socket, opens it, and completes an `Identify` round trip to fill the
#    BY column. A `devserver` answer means every one of those steps ran.
#    `devserver --status` would prove none of it -- it only reads a pidfile and
#    never opens a socket.
WS="$TMP_ROOT/workspace"
mkdir -p "$WS"
"$BIN" open --here --devserver="$PORT" --no-browser "$WS" >"$TMP_ROOT/open.log" 2>&1 || {
    echo "error: could not serve the smoke workspace on the detached daemon" >&2
    cat "$TMP_ROOT/open.log" >&2
    exit 1
}

# A new chan-control pipe in the namespace is the precondition; the diff around
# the spawn attributes it to OUR daemon and keeps the check off any other chan
# running on a developer's box.
[ -n "$(comm -13 <(printf '%s\n' "$PIPES_BEFORE") <(control_pipes))" ] || {
    echo "error: serving a workspace published no new chan-control pipe" >&2
    exit 1
}

PS_JSON=
for ((attempt = 0; attempt < 30; attempt++)); do
    # `|| true`: a failing ps is a retry, not the end of the script. Under
    # `set -e` a bare assignment carries the substitution's exit status, so
    # one transient non-zero while the daemon settles would kill the loop
    # and discard the stderr it just captured.
    PS_JSON="$("$BIN" ps --json 2>&1)" || true
    grep -q '"served_by": *"devserver"' <<<"$PS_JSON" && break
    sleep 1
done
grep -q '"served_by": *"devserver"' <<<"$PS_JSON" || {
    echo "error: ps did not identify the holder over the named-pipe control socket" >&2
    echo "$PS_JSON" >&2
    exit 1
}
echo "windows cli smoke: ps identified the devserver holder over its named pipe"

echo "windows cli smoke: PASS ($BIN)"
