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

# The Nix path is where a build id is most likely to be lost, and losing it is
# silent: `flake.nix` passes `src = self`, so the source in the store has no
# `.git` and the git fallback in each build script stamps "unknown". The id
# reaches the compilers only because flake.nix hands it down through the
# derivation environment, and nothing else here would notice if that stopped.
#
# Echo the line, then check it. `$1` names the invocation so a failure says
# which binary lied. The id is published in BUILD_ID rather than on stdout,
# which the echoed version line already owns.
BUILD_ID=
assert_build_id() {
    local what="$1" output="$2"
    printf '%s\n' "$output"
    BUILD_ID="${output##*\(build }"
    BUILD_ID="${BUILD_ID%\)*}"
    [ "$output" != "$BUILD_ID" ] || {
        echo "error: $what names no build: $output" >&2
        exit 1
    }
    # Tagged and well-formed, not merely non-empty: `git-` is a commit an
    # operator can look up, `nar-` is the content-derived id a revisionless
    # flake degrades to, and "unknown" is the defect this check exists for.
    [[ "$BUILD_ID" =~ ^(git-[0-9a-f]{12}(-dirty)?|nar-[0-9a-f]{12})$ ]] || {
        echo "error: $what carries no usable build id: '$BUILD_ID'" >&2
        exit 1
    }
}

assert_build_id "chan --version" "$("$BIN/chan" --version)"
CHAN_BUILD_ID="$BUILD_ID"

# chan-desktop ships TWO identities out of one derivation and needs both
# checked. `bin/chan` above is a symlink at the desktop binary, so it exercises
# the `chan` crate's CHAN_BUILD_ID; the app's own CHAN_DESKTOP_BUILD_ID comes
# from a different build script reading a different variable, and a recipe that
# set only one of them would pass the line above while still stamping "unknown"
# in the app users launch.
#
# Checking the app cannot be done by grepping the binary: both variables carry
# the same value, so a match cannot be attributed to either one and would go
# green on exactly that half-fix. `chan-desktop --version` is the headless
# reader that makes the app's own id observable.
if [ "$PACKAGE" = chan-desktop ]; then
    assert_build_id "chan-desktop --version" "$("$BIN/chan-desktop" --version)"
    # One derivation, one `buildId`, so a disagreement means the two variables
    # were fed from different places and one of them is stale.
    [ "$BUILD_ID" = "$CHAN_BUILD_ID" ] || {
        echo "error: package ships two build ids:" \
            "chan says '$CHAN_BUILD_ID', chan-desktop says '$BUILD_ID'" >&2
        exit 1
    }
fi

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
