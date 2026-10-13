#!/usr/bin/env bash
# Read the browser sign-in wait in the stock Linux WebKitGTK desktop.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/e2e/desktop-observations/lib.sh
. "$HERE/lib.sh"

obs_need python3
for argument in "$@"; do
    case "$argument" in
        -h|--help) exec python3 "$HERE/gateway-signin.py" validate "$@" ;;
    esac
done
if python3 "$HERE/gateway-signin.py" validate "$@"; then
    :
else
    status=$?
    obs_inconclusive "invalid gateway sign-in arguments (status $status); no observation started"
fi
obs_setup gateway-signin
obs_need node pkg-config
for argument in "$@"; do
    if [ "$argument" = held-enter ]; then obs_need xset; fi
done
export GWCANC_WORK="$OBS_WORK"
export GWCANC_HELPER="$HERE/gateway-signin.py"
mkdir "$OBS_WORK/bin"
cat > "$OBS_WORK/bin/xdg-open" <<'SHIM'
#!/usr/bin/env bash
exec python3 "$GWCANC_HELPER" capture "$@"
SHIM
chmod 700 "$OBS_WORK/bin/xdg-open"
export PATH="$OBS_WORK/bin:$PATH"
INSPECTOR="127.0.0.1:${OBS_INSPECTOR_PORT:-$((20000 + RANDOM % 20000))}"
export WEBKIT_INSPECTOR_HTTP_SERVER="$INSPECTOR"
python3 "$HERE/gateway-signin-reader.py" --preflight "$OBS_WORK/reader-preflight.json"
{
    printf 'fixture_source=%s\nproduct_source=%s\nengine=Linux WebKitGTK\n' "$OBS_SHA" "${GWCANC_PRODUCT_SHA:-not-recorded}"
    pkg-config --modversion webkit2gtk-4.1
    sha256sum "$CHAN_BIN" "$CHAN_DESKTOP_BIN" "$HERE/gateway-signin.py" "$HERE/gateway-signin-reader.py" "$HERE/gateway-signin.sh"
    printf 'WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=%s\nWEBKIT_DISABLE_DMABUF_RENDERER=%s\nLIBGL_ALWAYS_SOFTWARE=%s\nGDK_BACKEND=%s\n' \
        "$WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS" "$WEBKIT_DISABLE_DMABUF_RENDERER" "$LIBGL_ALWAYS_SOFTWARE" "$GDK_BACKEND"
} > "$OBS_WORK/provenance.txt"
obs_start_display
obs_start_desktop
obs_verdict
python3 "$HERE/gateway-signin.py" run "$INSPECTOR" "$OBS_WORK" "$@"
status=$?
case "$status" in
    2) obs_refuse "gateway sign-in preflight failed; see $OBS_WORK/summary.json" ;;
    *) obs_judge "$status" "gateway sign-in fault observed; see $OBS_WORK/summary.json" ;;
esac
