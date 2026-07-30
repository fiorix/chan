#!/usr/bin/env bash
# Prove the Nix output shape, packaged-update posture, and embedded devserver.
set -euo pipefail

OUT="${1:?usage: smoke-nix-package.sh <nix-output-path>}"
BIN="$OUT/bin"

[ -x "$BIN/chan-desktop" ] || {
    echo "error: chan-desktop is not executable in $OUT" >&2
    exit 1
}
for name in chan cs; do
    [ -L "$BIN/$name" ] || {
        echo "error: $BIN/$name is not a symlink" >&2
        exit 1
    }
    [ "$(readlink "$BIN/$name")" = "chan-desktop" ] || {
        echo "error: $BIN/$name does not point to chan-desktop" >&2
        exit 1
    }
done

[ -f "$OUT/share/applications/chan-desktop.desktop" ] || {
    echo "error: desktop entry missing from $OUT" >&2
    exit 1
}
for size in 32x32 64x64 128x128 256x256 512x512; do
    [ -f "$OUT/share/icons/hicolor/$size/apps/chan-desktop.png" ] || {
        echo "error: $size desktop icon missing from $OUT" >&2
        exit 1
    }
done
[ ! -e "$OUT/lib/systemd/user/chan-devserver.service" ] || {
    echo "error: Nix package must not ship the user devserver unit" >&2
    exit 1
}

"$BIN/chan" --version

set +e
UPGRADE_OUTPUT="$("$BIN/chan" upgrade --check 2>&1)"
UPGRADE_STATUS=$?
set -e
[ "$UPGRADE_STATUS" -ne 0 ] || {
    echo "error: Nix-managed chan unexpectedly allowed self-upgrade" >&2
    exit 1
}
[[ "$UPGRADE_OUTPUT" == *"system package manager (nix)"* ]] || {
    echo "error: Nix upgrade refusal did not name the package manager" >&2
    printf '%s\n' "$UPGRADE_OUTPUT" >&2
    exit 1
}
[[ "$UPGRADE_OUTPUT" == *"self-upgrade is disabled"* ]] || {
    echo "error: Nix upgrade refusal did not disable self-upgrade" >&2
    printf '%s\n' "$UPGRADE_OUTPUT" >&2
    exit 1
}

scripts/smoke-built-devserver.sh "$BIN/chan"
echo "Nix package smoke: PASS ($OUT)"
