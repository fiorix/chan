#!/usr/bin/env bash
# Read a devserver's connection face on the native Linux desktop's Computers
# screen under Xvfb, through a relay that delays, silences and drops the
# devserver's flows: a direct devserver by default, or with
# `--gateway-fixture FILE` (from `../gateway-zone.sh connface`) one reached
# through a real gateway, the relay on its tunnel leg alone.
set -euo pipefail
umask 077
GATEWAY_FIXTURE=""
case "${1:-}" in
    "") ;;
    --gateway-fixture)
        [ "$#" = 2 ] && [ -r "$2" ] || exit 2
        GATEWAY_FIXTURE="$2"
        # The disposable account PAT lives only in this process family's
        # kernel keyring, the same backend the Linux desktop uses.
        if [ "${CONNECTION_FACE_PRIVATE_KEYRING:-}" != 1 ]; then
            exec env CONNECTION_FACE_PRIVATE_KEYRING=1 keyctl session - bash "$0" "$@"
        fi
        ;;
    *) echo "usage: $0 [--gateway-fixture FILE]" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"
obs_setup connection-face
obs_need node
if [ -n "$GATEWAY_FIXTURE" ]; then
    obs_need keyctl
    account="$(node -e 'process.stdout.write("keyring-rs:gateway:" + require(process.argv[1]).origin + "@chan-desktop")' "$GATEWAY_FIXTURE")"
    node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).pat))' "$GATEWAY_FIXTURE" |
        keyctl padd user "$account" @s >/dev/null
fi
INSPECTOR="127.0.0.1:$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
obs_verdict
node "$HERE/connection-face-native.mjs" "$INSPECTOR" "$OBS_WORK" "$CHAN_BIN" ${GATEWAY_FIXTURE:+"$GATEWAY_FIXTURE"}
status=$?
obs_judge "$status" "connection face contract failed; see $OBS_WORK/results.json"
