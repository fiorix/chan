#!/usr/bin/env bash
# Drive the shared clean-container AUR build for one package on a CI runner.
# The caller names the Arch-family image; the package architecture comes from
# the runner the job landed on, never QEMU.
#
# Usage: build-in-ci.sh <image>
#
# Reads RELEASE_TAG (GA vX.Y.Z), AUR_PKGREL, PKGBASE, and optionally
# AUR_LOCAL_SOURCE from the environment. The latter must live under the repo
# so its read-only /src bind reaches the current commit instead of a published
# GitHub tag.

set -euo pipefail

image="${1:?usage: build-in-ci.sh <image>}"
release_tag="${RELEASE_TAG:?RELEASE_TAG must name the GA tag}"
pkgrel="${AUR_PKGREL:-1}"
pkgbase="${PKGBASE:?PKGBASE must be set}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
local_source="${AUR_LOCAL_SOURCE:-}"

case "$pkgbase" in
    chan|chan-desktop) ;;
    *) echo "::error::PKGBASE must be chan or chan-desktop, got $pkgbase"; exit 1 ;;
esac
if [[ ! "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "::error::the AUR jobs need a GA vX.Y.Z tag, got $release_tag"
    exit 1
fi
if [[ ! "$pkgrel" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::aur_pkgrel must be a positive integer, got $pkgrel"
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
# HOST_UID/HOST_GID hand the bind-mounted output back to the runner user, so
# the workspace stays cleanable after the container's builder writes into it.
docker run --rm \
    -e SRC=/src -e OUT=/out -e VERSION="${release_tag#v}" \
    -e PKGREL="$pkgrel" -e PKGBASE="$pkgbase" \
    -e AUR_LOCAL_SOURCE="$guest_source" \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -v "$repo:/src:ro" \
    -v "$out:/out" \
    "$image" bash /src/packaging/distros/arch/build-in-container.sh
