#!/usr/bin/env bash
# Exercise a devserver's tmux card in the native Linux desktop under Xvfb.
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
        if [ "${TMUX_FEED_PRIVATE_KEYRING:-}" != 1 ]; then
            exec env TMUX_FEED_PRIVATE_KEYRING=1 keyctl session - bash "$0" "$@"
        fi
        ;;
    *) echo "usage: $0 [--gateway-fixture FILE]" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"
obs_setup tmux-feed
obs_need node tmux
if [ -n "$GATEWAY_FIXTURE" ]; then
    account="$(node -e 'process.stdout.write("keyring-rs:gateway:" + require(process.argv[1]).origin + "@chan-desktop")' "$GATEWAY_FIXTURE")"
    node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).pat))' "$GATEWAY_FIXTURE" |
        keyctl padd user "$account" @s >/dev/null
fi
INSPECTOR="127.0.0.1:$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
obs_verdict
node "$HERE/tmux-feed.mjs" "$INSPECTOR" "$OBS_WORK" "$CHAN_BIN" "$GATEWAY_FIXTURE"
status=$?
obs_judge "$status" "tmux feed contract failed; see $OBS_WORK/results.json"
