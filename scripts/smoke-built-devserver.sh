#!/usr/bin/env bash
# Boot the release binary's foreground devserver and prove its health route.
set -euo pipefail

BIN="${1:?usage: smoke-built-devserver.sh <chan-or-chan-desktop-binary>}"
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

PORT="$(choose_port)"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -gt 0 ] && [ "$PORT" -le 65535 ] || {
    echo "error: invalid smoke port: $PORT" >&2
    exit 1
}

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/chan-built-devserver.XXXXXX")"
LOG="$TMP_ROOT/devserver.log"
PID=

cleanup() {
    local status=$?
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        wait "$PID" 2>/dev/null || true
    fi
    rm -rf -- "$TMP_ROOT"
    exit "$status"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP_ROOT/chan-home" "$TMP_ROOT/runtime"
case "$BIN" in
    *.AppImage)
        # AppRun rewrites argv[0], but the type-2 runtime preserves an
        # `exec -a` name through ARGV0. Match the installed AppImage shim.
        ARGV0=chan \
        APPIMAGE_EXTRACT_AND_RUN=1 \
        CHAN_HOME="$TMP_ROOT/chan-home" \
        CHAN_UPDATE_CHECK=0 \
        XDG_RUNTIME_DIR="$TMP_ROOT/runtime" \
        bash -c 'exec -a chan "$@"' _ "$BIN" \
            devserver --service=none --bind=127.0.0.1 --port="$PORT" \
            >"$LOG" 2>&1 &
        ;;
    *)
        ARGV0=chan \
        CHAN_HOME="$TMP_ROOT/chan-home" \
        CHAN_UPDATE_CHECK=0 \
        XDG_RUNTIME_DIR="$TMP_ROOT/runtime" \
        "$BIN" devserver --service=none --bind=127.0.0.1 --port="$PORT" \
            >"$LOG" 2>&1 &
        ;;
esac
PID=$!

BODY=
for ((attempt = 0; attempt < 90; attempt++)); do
    if ! kill -0 "$PID" 2>/dev/null; then
        break
    fi
    BODY="$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    if [[ "$BODY" == *'"status":"ok"'* ]]; then
        echo "built devserver smoke: PASS ($BIN on 127.0.0.1:$PORT)"
        exit 0
    fi
    sleep 1
done

echo "error: built devserver did not answer /api/health" >&2
cat "$LOG" >&2
exit 1
