#!/usr/bin/env bash
# Drive the reconnecting cover's Show in Computers on the native Linux
# desktop under Xvfb: a direct devserver's window, its flows closed through a
# relay with the devserver's feed left flowing, shows the cover with the
# action; a click through XTEST shows the Computers screen over the window on
# the devserver's card, and hiding it leaves the cover with the focus. A
# local window's cover offers no such action.
set -euo pipefail
umask 077
[ "$#" = 0 ] || { echo "usage: $0" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"
obs_setup cover-link
obs_need node
INSPECTOR="127.0.0.1:$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
obs_verdict
node "$HERE/cover-link-native.mjs" "$INSPECTOR" "$OBS_WORK" "$CHAN_BIN"
status=$?
obs_judge "$status" "cover link contract failed; see $OBS_WORK/results.json"
