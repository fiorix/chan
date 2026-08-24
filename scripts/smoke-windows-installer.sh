#!/usr/bin/env bash
# Build the standalone CLI with the compile-time loopback metadata seam, then
# drive install.ps1 and chan upgrade on a native Windows runner.
set -euo pipefail

UPGRADE_BIN="${1:?usage: smoke-windows-installer.sh <release-chan.exe>}"
CARGO_CMD="${CARGO:-cargo}"

[ -f "$UPGRADE_BIN" ] || {
    echo "error: release CLI not found: $UPGRADE_BIN" >&2
    exit 1
}

choose_port() {
    local python
    if [ -n "${CHAN_WINDOWS_INSTALLER_PORT:-}" ]; then
        printf '%s\n' "$CHAN_WINDOWS_INSTALLER_PORT"
        return
    fi
    for python in "${PYTHON:-python}" python3 python; do
        if command -v "$python" >/dev/null 2>&1; then
            "$python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
            return
        fi
    done
    echo "error: Python is required to select a free loopback port" >&2
    exit 1
}

PORT="$(choose_port)"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -gt 0 ] && [ "$PORT" -le 65535 ] || {
    echo "error: invalid Windows installer smoke port: $PORT" >&2
    exit 1
}

# This debug binary is deliberately test-only. The official release binary was
# built first without the seam and remains untouched at target/release/chan.exe.
CHAN_TEST_CLI_METADATA_BASE="http://127.0.0.1:$PORT/dl/cli" "$CARGO_CMD" build -p chan

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/smoke-windows-installer.ps1 -Installer web/packages/marketing/src/install.ps1 -TestBinary target/debug/chan.exe -UpgradeBinary "$UPGRADE_BIN" -Port "$PORT"
