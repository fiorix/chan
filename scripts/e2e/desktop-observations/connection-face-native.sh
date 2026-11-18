#!/usr/bin/env bash
# Read a direct devserver's connection face on the native Linux desktop's
# Computers screen under Xvfb, through a relay that delays, silences and
# drops the devserver's flows.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"
obs_setup connection-face
obs_need node
INSPECTOR="127.0.0.1:$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
obs_verdict
node "$HERE/connection-face-native.mjs" "$INSPECTOR" "$OBS_WORK" "$CHAN_BIN"
status=$?
obs_judge "$status" "connection face contract failed; see $OBS_WORK/results.json"
