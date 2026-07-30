#!/usr/bin/env bash
# Render one Homebrew tap definition without publishing it.
#
# Usage: make-homebrew-package.sh <chan|chan-desktop> [version] [outdir]
#
# chan renders Formula/chan.rb from the released CLI tarball; chan-desktop
# renders Casks/chan-desktop.rb from the released DMG. Output paths mirror
# the fiorix/homebrew-chan tap layout so publication is a plain copy.
#
# HOMEBREW_LOCAL_ASSET may name a local copy of the release asset. This is
# the pre-release path; production leaves it unset and hashes the published
# GitHub Release asset. ruby is required because this script always
# syntax-checks what it renders. Asset names must match
# web/packages/marketing/scripts/release-assets.mjs.

set -euo pipefail

pkg="${1:?usage: make-homebrew-package.sh <chan|chan-desktop> [version] [outdir]}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
version="${2:-}"
outdir="${3:-$repo/target/homebrew-out}"

case "$pkg" in
    chan)
        tpl="$here/Formula/chan.rb.in"
        relpath="Formula/chan.rb"
        asset_pattern='chan-aarch64-apple-darwin.tar.gz'
        sha_placeholder='@SHA256_TARBALL@'
        ;;
    chan-desktop)
        tpl="$here/Casks/chan-desktop.rb.in"
        relpath="Casks/chan-desktop.rb"
        asset_pattern='Chan_@PKGVER@.dmg'
        sha_placeholder='@SHA256_DMG@'
        ;;
    *) echo "error: unknown package '$pkg' (expected chan or chan-desktop)" >&2; exit 1 ;;
esac

if [ -z "$version" ]; then
    version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/Cargo.toml" | head -1)"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "error: Homebrew version must be a GA X.Y.Z version, got '$version'" >&2
    exit 1
}
command -v ruby >/dev/null 2>&1 || {
    echo "error: ruby not found; it syntax-checks the rendered definition" >&2
    exit 1
}
[ -f "$tpl" ] || { echo "error: no template at $tpl" >&2; exit 1; }

asset="${asset_pattern//@PKGVER@/$version}"
url="https://github.com/fiorix/chan/releases/download/v$version/$asset"
if [ -n "${HOMEBREW_LOCAL_ASSET:-}" ]; then
    [ -f "$HOMEBREW_LOCAL_ASSET" ] || {
        echo "error: HOMEBREW_LOCAL_ASSET does not exist: $HOMEBREW_LOCAL_ASSET" >&2
        exit 1
    }
    sha="$(sha256sum "$HOMEBREW_LOCAL_ASSET" | awk '{print $1}')"
else
    sha="$(curl -fsSL --retry 3 "$url" | sha256sum | awk '{print $1}')"
fi

dest="$outdir/$relpath"
mkdir -p "$(dirname "$dest")"
sed -e "s|@PKGVER@|$version|g" \
    -e "s|$sha_placeholder|$sha|g" \
    "$tpl" > "$dest"

if grep -q '@[A-Z0-9_]\+@' "$dest"; then
    echo "error: unresolved placeholders in $dest" >&2
    grep -o '@[A-Z0-9_]\+@' "$dest" >&2
    exit 1
fi
ruby -c "$dest" >/dev/null
grep -q "version \"$version\"" "$dest" || {
    echo "error: rendered $dest does not pin version $version" >&2
    exit 1
}
grep -q "$sha" "$dest" || {
    echo "error: rendered $dest does not carry the asset sha256" >&2
    exit 1
}

echo ">> rendered $pkg $version in $dest" >&2
printf '%s\n' "$dest"
