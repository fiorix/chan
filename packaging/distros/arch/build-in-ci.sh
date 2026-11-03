#!/usr/bin/env bash
# Drive the shared clean-container AUR build for one package on a CI runner.
# The caller names the Arch-family image; the package architecture comes from
# the runner the job landed on, never QEMU.
#
# Usage: build-in-ci.sh <image>
#
# Reads RELEASE_TAG (GA vX.Y.Z), AUR_PKGREL, PKGBASE, and optionally
# AUR_LOCAL_SOURCE and AUR_CARGO_JOBS from the environment. The source must
# live under the repo so its read-only /src bind reaches the current commit.
#
# PKGBASE=chan-desktop-bin runs two containers. The first builds chan-desktop
# on the Arch Linux Archive snapshot ARCH_SNAPSHOT names (YYYY/MM/DD, by
# default six weeks before the checked-out commit) and packs the release asset
# into target/aur-ci-out/assets/. AUR_BIN_ASSET may name an asset already
# published for this version and pkgrel instead, which skips that build. The
# second builds and smokes chan-desktop-bin from the asset on the current
# image, so the binary is proven on both the oldest and the newest system it
# targets.
# AUR_CARGO_JOBS defaults to 2 for every cargo call of the CI recipe, including
# build() and check(). Their commands and tests are unchanged; fewer jobs can
# lengthen the hosted run, by an amount not yet measured. A user's own makepkg
# uses cargo's default because the published recipe does not set the variable.

set -euo pipefail

image="${1:?usage: build-in-ci.sh <image>}"
release_tag="${RELEASE_TAG:?RELEASE_TAG must name the GA tag}"
pkgrel="${AUR_PKGREL:-1}"
pkgbase="${PKGBASE:?PKGBASE must be set}"
cargo_jobs="${AUR_CARGO_JOBS-2}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
local_source="${AUR_LOCAL_SOURCE:-}"

case "$pkgbase" in
    chan|chan-desktop|chan-desktop-bin) ;;
    *) echo "::error::PKGBASE must be chan, chan-desktop, or chan-desktop-bin, got $pkgbase"; exit 1 ;;
esac
if [[ ! "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "::error::the AUR jobs need a GA vX.Y.Z tag, got $release_tag"
    exit 1
fi
if [[ ! "$pkgrel" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::aur_pkgrel must be a positive integer, got $pkgrel"
    exit 1
fi
if [[ ! "$cargo_jobs" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::AUR_CARGO_JOBS must be a positive integer, got $cargo_jobs" >&2
    exit 1
fi

guest_source=
if [ -n "$local_source" ]; then
    [ -f "$local_source" ] || {
        echo "::error::AUR_LOCAL_SOURCE does not exist: $local_source" >&2
        exit 1
    }
    local_source="$(realpath "$local_source")"
    case "$local_source" in
        "$repo"/*) guest_source="/src/${local_source#"$repo"/}" ;;
        *)
            echo "::error::AUR_LOCAL_SOURCE must live under $repo" >&2
            exit 1
            ;;
    esac
fi

out="$repo/target/aur-ci-out"
mkdir -p "$out"

# run_container <pkgbase> [-e NAME=value]...
# HOST_UID/HOST_GID hand the bind-mounted output back to the runner user, so
# the workspace stays cleanable after the container's builder writes into it.
run_container() {
    local container_pkgbase="$1"
    shift
    docker run --rm \
        -e SRC=/src -e OUT=/out -e VERSION="${release_tag#v}" \
        -e PKGREL="$pkgrel" -e PKGBASE="$container_pkgbase" \
        -e AUR_LOCAL_SOURCE="$guest_source" \
        -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
        -e CARGO_BUILD_JOBS="$cargo_jobs" \
        "$@" \
        -v "$repo:/src:ro" \
        -v "$out:/out" \
        "$image" bash /src/packaging/distros/arch/build-in-container.sh
}

if [ "$pkgbase" != chan-desktop-bin ]; then
    run_container "$pkgbase"
    exit 0
fi

asset="$("$repo/packaging/distros/arch/desktop-bin-asset.sh" name "${release_tag#v}" "$pkgrel")"
mkdir -p "$out/assets"
if [ -n "${AUR_BIN_ASSET:-}" ]; then
    [ -f "$AUR_BIN_ASSET" ] || {
        echo "::error::AUR_BIN_ASSET does not exist: $AUR_BIN_ASSET" >&2
        exit 1
    }
    [ "$(basename "$AUR_BIN_ASSET")" = "$asset" ] || {
        echo "::error::AUR_BIN_ASSET must be $asset, got $(basename "$AUR_BIN_ASSET")" >&2
        exit 1
    }
    if [ "$(realpath "$AUR_BIN_ASSET")" != "$(realpath -m "$out/assets/$asset")" ]; then
        cp "$AUR_BIN_ASSET" "$out/assets/$asset"
    fi
    echo ">> reusing the published $asset" >&2
else
    snapshot="${ARCH_SNAPSHOT:-}"
    if [ -z "$snapshot" ]; then
        # Six weeks keeps the build at or behind derivatives that hold their
        # mirror about a month behind Arch. The commit date, not the clock,
        # picks the day, so a rebuild of one tag links against the same
        # snapshot.
        committed="$(git -C "$repo" log -1 --format=%ct HEAD)"
        snapshot="$(date -u -d "@$((committed - 42 * 86400))" +%Y/%m/%d)"
    fi
    rm -f "$out/assets/$asset"
    run_container chan-desktop \
        -e ARCH_SNAPSHOT="$snapshot" -e DESKTOP_BIN_ASSET_DIR=/out/assets
    [ -f "$out/assets/$asset" ] || {
        echo "::error::the snapshot build did not pack $asset" >&2
        exit 1
    }
fi
run_container chan-desktop-bin -e AUR_LOCAL_ASSET="/src/target/aur-ci-out/assets/$asset"
