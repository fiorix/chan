#!/usr/bin/env bash
# Prove the Nix output shape, packaged-update posture, and embedded devserver.
set -euo pipefail

OUT="${1:?usage: smoke-nix-package.sh <nix-output-path> <chan|chan-desktop>}"
PACKAGE="${2:?usage: smoke-nix-package.sh <nix-output-path> <chan|chan-desktop>}"
BIN="$OUT/bin"

case "$PACKAGE" in
chan)
    [ -x "$BIN/chan" ] && [ ! -L "$BIN/chan" ] || {
        echo "error: chan is not a standalone executable in $OUT" >&2
        exit 1
    }
    [ -L "$BIN/cs" ] && [ "$(readlink "$BIN/cs")" = "chan" ] || {
        echo "error: $BIN/cs does not point to chan" >&2
        exit 1
    }
    for path in \
        "$BIN/chan-desktop" \
        "$OUT/share/applications/chan-desktop.desktop" \
        "$OUT/share/icons/hicolor"; do
        [ ! -e "$path" ] && [ ! -L "$path" ] || {
            echo "error: headless package contains desktop path: $path" >&2
            exit 1
        }
    done
    ;;
chan-desktop)
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
    ;;
*)
    echo "error: unknown Nix package: $PACKAGE" >&2
    exit 1
    ;;
esac

[ ! -e "$OUT/lib/systemd/user/chan-devserver.service" ] || {
    echo "error: Nix package must not ship the user devserver unit" >&2
    exit 1
}

VERSION_OUTPUT="$("$BIN/chan" --version)"
printf '%s\n' "$VERSION_OUTPUT"

# The Nix path is where a build id is most likely to be lost, and losing it is
# silent: `flake.nix` passes `src = self`, so the source in the store has no
# `.git` and the git fallback in crates/chan/build.rs stamps "unknown". The id
# reaches the compiler only because flake.nix hands it down through
# CHAN_BUILD_ID, and nothing else here would notice if that stopped happening.
if [ "$PACKAGE" = chan ]; then
    BUILD_ID="${VERSION_OUTPUT##*\(build }"
    BUILD_ID="${BUILD_ID%\)*}"
    [ "$VERSION_OUTPUT" != "$BUILD_ID" ] || {
        echo "error: chan --version names no build: $VERSION_OUTPUT" >&2
        exit 1
    }
    # Tagged and well-formed, not merely non-empty: `git-` is a commit an
    # operator can look up, `nar-` is the content-derived id a revisionless
    # flake degrades to, and "unknown" is the defect this check exists for.
    [[ "$BUILD_ID" =~ ^(git-[0-9a-f]{12}(-dirty)?|nar-[0-9a-f]{12})$ ]] || {
        echo "error: chan --version carries no usable build id: '$BUILD_ID'" >&2
        exit 1
    }
fi
# chan-desktop is deliberately unchecked: packaging/nix/chan-desktop.nix does
# not hand a build id down, so its `chan` (a symlink to the desktop binary)
# still reports "unknown". That gap is registered as its own roadmap item
# rather than widened into this one.

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
echo "Nix package smoke: PASS ($PACKAGE at $OUT)"
