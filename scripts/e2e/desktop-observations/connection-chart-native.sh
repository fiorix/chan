#!/usr/bin/env bash
# Read the connection chart on a direct devserver's card in front of the
# native Linux desktop's Computers screen under Xvfb: where the chart sits
# inside the card (`inset`), what its fourth figure reads (`figures`), and
# how its line moves between and across the samples the desktop's pings add
# (`motion`), or with prefers-reduced-motion set in the desktop's GTK
# settings (`reduced`), or with privacy mode on (`privacy`); each of those
# two runs alone, since the desktop reads its setting at its start. With no
# leg named: `inset figures motion`.
# connection-chart-native.mjs owns the devserver, the relay and the verdicts.
#
# Exit 0 when every leg named held, 1 when one did not, 2 when a step the
# legs rest on did not happen (the setup did not run), 3 otherwise.
set -euo pipefail
umask 077
LEGS=("$@")
[ "${#LEGS[@]}" -gt 0 ] || LEGS=(inset figures motion)
ALONE=""
for leg in "${LEGS[@]}"; do
    case "$leg" in
    inset | figures | motion) ;;
    reduced | privacy) ALONE="$leg" ;;
    *) echo "usage: $0 [inset] [figures] [motion] | reduced | privacy" >&2; exit 2 ;;
    esac
done
if [ -n "$ALONE" ] && [ "${#LEGS[@]}" != 1 ]; then
    echo "usage: $0 [inset] [figures] [motion] | reduced | privacy" >&2
    exit 2
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"
obs_setup connection-chart
obs_need node
if [ "$ALONE" = reduced ]; then
    # WebKitGTK answers prefers-reduced-motion from GTK's
    # gtk-enable-animations, which GTK 3 reads from this file with no
    # settings daemon; the page's own reading of the query is the check.
    mkdir -p "$HOME/.config/gtk-3.0"
    printf '[Settings]\ngtk-enable-animations=0\n' > "$HOME/.config/gtk-3.0/settings.ini"
fi
if [ "$ALONE" = privacy ]; then
    # The desktop's own config, read at its start; the page's hidden
    # computer name is the check.
    mkdir -p "$CHAN_HOME/desktop"
    printf '{"privacy":{"enabled":true,"mask_terminal_secrets":false,"revision":1}}\n' > "$CHAN_HOME/desktop/config.json"
fi
INSPECTOR="127.0.0.1:$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
obs_start_display
obs_start_desktop
obs_verdict
node "$HERE/connection-chart-native.mjs" "$INSPECTOR" "$OBS_WORK" "$CHAN_BIN" "${LEGS[@]}"
status=$?
[ "$status" != 2 ] || obs_refuse "the setup did not run; see the SETUP NOT RUN line above and $OBS_WORK/results.json"
obs_judge "$status" "connection chart contract failed; see $OBS_WORK/results.json"
