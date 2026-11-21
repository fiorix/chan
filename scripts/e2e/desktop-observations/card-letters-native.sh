#!/usr/bin/env bash
# Press the row letters on a Computers card of the native Linux desktop under
# Xvfb, on a real connected devserver's card, with real input through XTEST:
# a click on the card's empty body selects it and paints its ring, o
# disconnects and connects the devserver, with nothing selected o does
# nothing, a click on a workspace row selects it with its ring and t acts on
# that row, and t on the clicked card opens a terminal on the devserver.
# card-letters-native.mjs owns the devserver and the verdicts.
#
# Prints PASS or FAIL per leg. Exit 0 when every leg held, 1 when one did not,
# 2 when a step the legs rest on did not happen (the setup did not run), 3
# otherwise.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"
obs_setup card-letters
obs_need node
INSPECTOR="127.0.0.1:$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
obs_verdict
node "$HERE/card-letters-native.mjs" "$INSPECTOR" "$OBS_WORK" "$CHAN_BIN"
status=$?
[ "$status" != 2 ] || obs_refuse "the setup did not run; see the SETUP NOT RUN line above and $OBS_WORK/results.json"
obs_judge "$status" "card letter contract failed; see $OBS_WORK/results.json"
