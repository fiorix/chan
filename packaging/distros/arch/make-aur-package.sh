#!/usr/bin/env bash
# Render one AUR package without publishing it.
#
# Usage: make-aur-package.sh <chan|chan-desktop|chan-desktop-bin> [version] [pkgrel] [outdir]
#
# AUR_LOCAL_SOURCE may name a local chan-<version>.tar.gz. This is the sdme
# pre-release path; production leaves it unset and resolves the tagged GitHub
# archive. makepkg is required because this script always emits .SRCINFO.
#
# chan-desktop-bin sources the release asset desktop-bin-asset.sh names.
# AUR_LOCAL_ASSET may name a local copy of it; the recipe still points at the
# release URL, and the copy is placed beside it, where makepkg uses it instead
# of downloading. Without it the published asset is hashed.

set -euo pipefail

pkgbase="${1:?usage: make-aur-package.sh <chan|chan-desktop|chan-desktop-bin> [version] [pkgrel] [outdir]}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
version="${2:-}"
pkgrel="${3:-1}"
outdir="${4:-$repo/target/aur-out}"

case "$pkgbase" in
    chan|chan-desktop|chan-desktop-bin) ;;
    *) echo "error: unknown pkgbase '$pkgbase' (expected chan, chan-desktop, or chan-desktop-bin)" >&2; exit 1 ;;
esac

if [ -z "$version" ]; then
    version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/Cargo.toml" | head -1)"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "error: AUR version must be a GA X.Y.Z version, got '$version'" >&2
    exit 1
}
[[ "$pkgrel" =~ ^[1-9][0-9]*$ ]] || {
    echo "error: pkgrel must be a positive integer, got '$pkgrel'" >&2
    exit 1
}
command -v makepkg >/dev/null 2>&1 || {
    echo "error: makepkg not found; run through make aur-check or inside Arch" >&2
    exit 1
}

tpl="$here/aur/$pkgbase/PKGBUILD.in"
dest="$outdir/$pkgbase"
[ -f "$tpl" ] || { echo "error: no template at $tpl" >&2; exit 1; }
rm -rf "$dest"
mkdir -p "$dest"

if [ "$pkgbase" = chan-desktop-bin ]; then
    asset="$("$here/desktop-bin-asset.sh" name "$version" "$pkgrel")"
    source_value="https://github.com/fiorix/chan/releases/download/v$version/$asset"
    if [ -n "${AUR_LOCAL_ASSET:-}" ]; then
        [ -f "$AUR_LOCAL_ASSET" ] || {
            echo "error: AUR_LOCAL_ASSET does not exist: $AUR_LOCAL_ASSET" >&2
            exit 1
        }
        cp "$AUR_LOCAL_ASSET" "$dest/$asset"
        source_sha="$(sha256sum "$dest/$asset" | awk '{print $1}')"
    else
        source_sha="$(curl -fsSL --retry 3 "$source_value" | sha256sum | awk '{print $1}')"
    fi
elif [ -n "${AUR_LOCAL_SOURCE:-}" ]; then
    [ -f "$AUR_LOCAL_SOURCE" ] || {
        echo "error: AUR_LOCAL_SOURCE does not exist: $AUR_LOCAL_SOURCE" >&2
        exit 1
    }
    source_name="chan-$version.tar.gz"
    cp "$AUR_LOCAL_SOURCE" "$dest/$source_name"
    source_value="$source_name"
    source_sha="$(sha256sum "$dest/$source_name" | awk '{print $1}')"
else
    source_value="chan-$version.tar.gz::https://github.com/fiorix/chan/archive/v$version.tar.gz"
    source_sha="$(curl -fsSL --retry 3 "https://github.com/fiorix/chan/archive/v$version.tar.gz" | sha256sum | awk '{print $1}')"
fi

sed -e "s|@PKGVER@|$version|g" \
    -e "s|@PKGREL@|$pkgrel|g" \
    -e "s|@SOURCE@|$source_value|g" \
    -e "s|@SHA256_SRC@|$source_sha|g" \
    "$tpl" > "$dest/PKGBUILD"

if grep -q '@[A-Z0-9_]\+@' "$dest/PKGBUILD"; then
    echo "error: unresolved placeholders in $dest/PKGBUILD" >&2
    grep -o '@[A-Z0-9_]\+@' "$dest/PKGBUILD" >&2
    exit 1
fi

(cd "$dest" && makepkg --printsrcinfo > .SRCINFO)

actual_base="$(awk '/^pkgbase = / { print $3; exit }' "$dest/.SRCINFO")"
actual_version="$(awk '/^[[:space:]]+pkgver = / { print $3; exit }' "$dest/.SRCINFO")"
actual_rel="$(awk '/^[[:space:]]+pkgrel = / { print $3; exit }' "$dest/.SRCINFO")"
[ "$actual_base" = "$pkgbase" ] || { echo "error: .SRCINFO pkgbase '$actual_base' != '$pkgbase'" >&2; exit 1; }
[ "$actual_version" = "$version" ] || { echo "error: .SRCINFO pkgver '$actual_version' != '$version'" >&2; exit 1; }
[ "$actual_rel" = "$pkgrel" ] || { echo "error: .SRCINFO pkgrel '$actual_rel' != '$pkgrel'" >&2; exit 1; }
if [ "$pkgbase" = chan-desktop-bin ]; then
    # The template spells the asset URL with makepkg variables; hold the
    # expansion to the name the CI wrapper packed and the workflow uploads.
    actual_source="$(awk '/^[[:space:]]+source = / { print $3; exit }' "$dest/.SRCINFO")"
    [ "$actual_source" = "$source_value" ] || {
        echo "error: .SRCINFO source '$actual_source' != '$source_value'" >&2
        exit 1
    }
fi

echo ">> rendered $pkgbase $version-$pkgrel in $dest" >&2
printf '%s\n' "$dest"
