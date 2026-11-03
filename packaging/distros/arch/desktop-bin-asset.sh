#!/usr/bin/env bash
# Name or build the release asset the chan-desktop-bin AUR package installs.
#
# Usage: desktop-bin-asset.sh name <version> <pkgrel>
#        desktop-bin-asset.sh pack <chan-desktop package> <version> <pkgrel> <outdir>
#
# `name` prints the asset's file name, the one spelling the renderer, the CI
# wrapper, and the workflow share. `pack` repacks the usr/ tree of a built
# chan-desktop .pkg.tar.zst, without pacman's metadata files, into
# <outdir>/<name> and prints that path. The asset name carries the pkgrel, so a
# repaired package is a new asset and a published one is never replaced.

set -euo pipefail

usage() {
    echo "usage: desktop-bin-asset.sh name <version> <pkgrel>" >&2
    echo "       desktop-bin-asset.sh pack <chan-desktop package> <version> <pkgrel> <outdir>" >&2
    exit 2
}

asset_name() {
    local version="$1" pkgrel="$2"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
        echo "error: chan-desktop-bin version must be a GA X.Y.Z version, got '$version'" >&2
        exit 1
    }
    [[ "$pkgrel" =~ ^[1-9][0-9]*$ ]] || {
        echo "error: pkgrel must be a positive integer, got '$pkgrel'" >&2
        exit 1
    }
    printf 'chan-desktop-bin-%s-%s-x86_64.tar.zst\n' "$version" "$pkgrel"
}

case "${1:-}" in
    name)
        [ "$#" -eq 3 ] || usage
        asset_name "$2" "$3"
        ;;
    pack)
        [ "$#" -eq 5 ] || usage
        pkg="$2"
        name="$(asset_name "$3" "$4")"
        outdir="$5"
        [ -f "$pkg" ] || { echo "error: no package at $pkg" >&2; exit 1; }
        case "$(basename "$pkg")" in
            "chan-desktop-$3-$4-x86_64.pkg.tar.zst") ;;
            *)
                echo "error: expected chan-desktop-$3-$4-x86_64.pkg.tar.zst, got $(basename "$pkg")" >&2
                exit 1
                ;;
        esac
        command -v bsdtar >/dev/null 2>&1 || {
            echo "error: bsdtar not found; run inside Arch" >&2
            exit 1
        }
        tree="$(mktemp -d)"
        trap 'rm -rf -- "$tree"' EXIT
        bsdtar -xf "$pkg" -C "$tree" usr
        [ -x "$tree/usr/bin/chan-desktop" ] || {
            echo "error: $pkg has no executable usr/bin/chan-desktop" >&2
            exit 1
        }
        mkdir -p "$outdir"
        # Root ownership matches what pacman installs; the builder's uid would
        # otherwise land in the archive.
        bsdtar --zstd --uid 0 --gid 0 --uname root --gname root \
            -cf "$outdir/$name" -C "$tree" usr
        printf '%s\n' "$outdir/$name"
        ;;
    *) usage ;;
esac
