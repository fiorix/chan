#!/bin/sh
# chan CLI installer for macOS, Linux, and FreeBSD.
#
#   curl -fsSL https://chan.app/install.sh | sh
#
# Downloads complete-release CLI metadata, selects the matching standalone
# CLI tarball, verifies SHA256, and installs `chan` into PREFIX/bin.
# Defaults:
#
#   METADATA_URL=https://chan.app/dl/cli/latest.json
#   PREFIX=$HOME/.local

set -eu

DEFAULT_METADATA_BASE="https://chan.app/dl/cli"
PREFIX="${PREFIX:-$HOME/.local}"

err() { printf 'install: %s\n' "$1" >&2; exit 1; }

validate_version() {
    version=$1
    case "$version" in
        ""|v*|*[!0123456789.]*|*.*.*.*) err "VERSION must be a bare X.Y.Z version." ;;
    esac
    old_ifs=$IFS
    IFS=.
    # IFS is set to "." above precisely so the split happens here.
    # shellcheck disable=SC2086
    set -- $version
    IFS=$old_ifs
    [ "$#" -eq 3 ] || err "VERSION must be a bare X.Y.Z version."
    [ -n "$1" ] && [ -n "$2" ] && [ -n "$3" ] || err "VERSION must be a bare X.Y.Z version."
}

if [ "${VERSION:-}" ]; then
    validate_version "$VERSION"
fi

if [ "${METADATA_URL:-}" ]; then
    :
elif [ "${BASE:-}" ]; then
    BASE="${BASE%/}"
    if [ "${VERSION:-}" ]; then
        METADATA_URL="$BASE/v$VERSION.json"
    else
        METADATA_URL="$BASE/latest.json"
    fi
elif [ "${VERSION:-}" ]; then
    METADATA_URL="$DEFAULT_METADATA_BASE/v$VERSION.json"
else
    METADATA_URL="$DEFAULT_METADATA_BASE/latest.json"
fi

os=$(uname -s)
arch=$(uname -m)

case "$os" in
    Darwin)
        case "$arch" in
            arm64|aarch64) target="aarch64-apple-darwin" ;;
            *) err "macOS on $arch is not published. arm64 only for now." ;;
        esac
        ;;
    Linux)
        # The standalone Linux tarball is musl (fully static) so a too-new
        # build glibc does not gate older machines. The .deb/.rpm packages
        # (installed via the distro, not this script) stay gnu.
        case "$arch" in
            x86_64|amd64)  target="x86_64-unknown-linux-musl" ;;
            aarch64|arm64) target="aarch64-unknown-linux-musl" ;;
            *) err "Linux on $arch is not published." ;;
        esac
        ;;
    FreeBSD)
        case "$arch" in
            x86_64|amd64)  target="x86_64-unknown-freebsd" ;;
            aarch64|arm64) target="aarch64-unknown-freebsd" ;;
            *) err "FreeBSD on $arch is not published." ;;
        esac
        ;;
    *) err "Unsupported OS: $os." ;;
esac

fetch_url() {
    url=$1
    out=$2
    case "$url" in
        file://*) cp "${url#file://}" "$out" ;;
        /*|./*|../*) cp "$url" "$out" ;;
        *)
            if command -v curl >/dev/null 2>&1; then
                curl -fsSL "$url" -o "$out"
            elif command -v wget >/dev/null 2>&1; then
                wget -qO "$out" "$url"
            elif command -v fetch >/dev/null 2>&1; then
                fetch -qo "$out" "$url"
            else
                printf 'install: need curl, wget, or fetch on PATH.\n' >&2
                return 1
            fi
            ;;
    esac
}

json_field() {
    file=$1
    key=$2
    # Each JSON punctuation character maps to its own newline; the repeated
    # replacement is what makes set2 the same length as set1.
    # shellcheck disable=SC2020
    tr '{}[],' '\n\n\n\n\n' < "$file" | awk -v key="$key" '
        function trim(s) {
            sub(/^[[:space:]]+/, "", s)
            sub(/[[:space:]]+$/, "", s)
            return s
        }
        function value(s) {
            sub(/^[^:]*:[[:space:]]*"/, "", s)
            sub(/"[[:space:]]*$/, "", s)
            return s
        }
        {
            line = trim($0)
            if (index(line, "\"" key "\"") == 1) {
                print value(line)
                exit
            }
        }
    '
}

target_metadata() {
    file=$1
    wanted=$2
    # Each JSON punctuation character maps to its own newline; the repeated
    # replacement is what makes set2 the same length as set1.
    # shellcheck disable=SC2020
    tr '{}[],' '\n\n\n\n\n' < "$file" | awk -v wanted="$wanted" '
        function trim(s) {
            sub(/^[[:space:]]+/, "", s)
            sub(/[[:space:]]+$/, "", s)
            return s
        }
        function value(s) {
            sub(/^[^:]*:[[:space:]]*"/, "", s)
            sub(/"[[:space:]]*$/, "", s)
            return s
        }
        BEGIN { in_target = 0; asset = ""; url = ""; sha = "" }
        {
            line = trim($0)
            if (index(line, "\"target\"") == 1) {
                in_target = (value(line) == wanted)
                asset = ""; url = ""; sha = ""
                next
            }
            if (!in_target) {
                next
            }
            if (index(line, "\"asset\"") == 1) {
                asset = value(line)
            } else if (index(line, "\"url\"") == 1) {
                url = value(line)
            } else if (index(line, "\"sha256\"") == 1) {
                sha = value(line)
            }
            if (asset != "" && url != "" && sha != "") {
                print asset
                print url
                print sha
                exit
            }
        }
    '
}

sha256_file() {
    file=$1
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print tolower($1)}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print tolower($1)}'
    else
        err "need sha256sum or shasum on PATH."
    fi
}

bindir="$PREFIX/bin"
mkdir -p "$bindir"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

printf 'install: reading %s\n' "$METADATA_URL"
if ! fetch_url "$METADATA_URL" "$tmp/cli-release.json"; then
    printf 'install: release metadata unavailable: %s\n' "$METADATA_URL" >&2
    printf 'install: manual downloads: https://github.com/fiorix/chan/releases\n' >&2
    exit 1
fi

version=$(json_field "$tmp/cli-release.json" version)
[ -n "$version" ] || err "metadata is missing version."

info=$(target_metadata "$tmp/cli-release.json" "$target")
[ -n "$info" ] || err "metadata has no asset for $target."

asset=$(printf '%s\n' "$info" | sed -n '1p')
url=$(printf '%s\n' "$info" | sed -n '2p')
expected_sha=$(printf '%s\n' "$info" | sed -n '3p' | tr 'A-F' 'a-f')

expected_asset="chan-$target.tar.gz"
[ "$asset" = "$expected_asset" ] || err "metadata asset mismatch for $target: $asset"

case "$expected_sha" in
    ""|*[!0123456789abcdef]*) err "metadata has invalid SHA256 for $asset." ;;
esac
[ "${#expected_sha}" -eq 64 ] || err "metadata has invalid SHA256 for $asset."

printf 'install: downloading %s\n' "$url"
fetch_url "$url" "$tmp/chan.tar.gz" || err "download failed: $url"

actual_sha=$(sha256_file "$tmp/chan.tar.gz")
[ "$actual_sha" = "$expected_sha" ] || err "SHA256 mismatch for $asset."

tar -xzf "$tmp/chan.tar.gz" -C "$tmp"

bin=$(find "$tmp" -type f -name chan -perm -u+x | head -n1 || true)
[ -n "$bin" ] || err "binary 'chan' not found inside $asset"

install -m 0755 "$bin" "$bindir/chan"
printf 'install: installed chan %s to %s\n' "$version" "$bindir/chan"

# `cs` is the same multi-call binary under a different argv[0] (the
# control-socket CLI: `cs terminal`, `cs poke`, ...). Relative target so
# the link stays valid regardless of where PREFIX lives.
ln -sf chan "$bindir/cs"
printf 'install: linked cs -> chan in %s\n' "$bindir"

case ":$PATH:" in
    *":$bindir:"*) ;;
    *)
        printf 'install: note: %s is not on your PATH.\n' "$bindir" >&2
        printf '  add this to your shell rc:  export PATH="%s:$PATH"\n' "$bindir" >&2
        ;;
esac
