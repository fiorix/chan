#!/usr/bin/env bash
# Install what browser-smoke needs to run: the shared libraries headless
# Chrome links against, and Chrome itself in the cache location the harness
# looks in.
#
# The project's build containers carry the Rust and Node toolchains and no
# browser at all, so without this the suite is unrunnable anywhere in the
# normal workflow: the host keeps no toolchain by policy, and a downloaded
# Chrome in a stock container dies on libnss3 before it opens a page.
#
# Run it inside the container, as root:
#     scripts/e2e/browser-smoke/provision.sh
#     make browser-smoke-deps          # same thing from the repo root
#
# This is the single list of those dependencies. An sdme rootfs that wants
# them baked in COPYs this file and RUNs it, rather than restating the set.
#
# Exit status: 0 provisioned, 1 provisioning failed, 2 this environment
# cannot be provisioned at all (no apt-get, not root, no npm). A skip is not
# a pass; 2 says the caller must fix the environment rather than read the
# absence of a run as a green.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# How many of Chrome's shared libraries are missing is a property of the BASE
# IMAGE, not of Chrome, so this list is only ever correct for bases someone has
# measured. Two are measured, both Ubuntu 26.04: the project's build rootfs
# needs the NSS and ALSA families (5 sonames), and a stock `ubuntu` needs those
# plus the X, GTK, cairo, pango, glib, cups and gbm families (23). The union is
# listed here, so the extra names are a no-op on a base that already carries
# them. On any third base the `ldd` verification at the end is what holds: it
# fails loudly with the exact missing sonames rather than leaving a Chrome that
# cannot start. Treat the list as the fast path and that check as the contract.
#
# unzip is not Chrome's dependency but the downloader's: @puppeteer/browsers
# extracts with it and fails the install without it, leaving a browser
# directory holding no executable.
APT_PACKAGES=(
    unzip
    libnss3
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2
    libxkbcommon0
    libcairo2 libpango-1.0-0 libgbm1
)
# The 64-bit time_t transition renamed these: 24.04 and newer carry the t64
# name, older releases the bare one. Probe for each rather than assuming a
# release, so one script spans both sides of that split. First name that the
# package index knows wins.
APT_RENAMED_CANDIDATES=(
    "libasound2t64 libasound2"
    "libatk1.0-0t64 libatk1.0-0"
    "libatk-bridge2.0-0t64 libatk-bridge2.0-0"
    "libatspi2.0-0t64 libatspi2.0-0"
    "libcups2t64 libcups2"
    "libglib2.0-0t64 libglib2.0-0"
)

# `stable` tracks whatever Chrome is current, which is what puppeteer-core's
# floating major expects. Pin CHROME_VERSION to a buildId to freeze a run.
CHROME_VERSION="${CHROME_VERSION:-stable}"
PUPPETEER_CACHE="${PUPPETEER_CACHE_DIR:-${HOME:-/root}/.cache/puppeteer}"

need() {
    command -v "$1" >/dev/null 2>&1
}

skip() {
    echo "SKIP: $1" >&2
    echo "SKIP: a skipped check is not a pass" >&2
    exit 2
}

if [ "$(id -u)" -ne 0 ]; then
    skip "provisioning needs root (run it inside the container)"
fi
if ! need apt-get; then
    skip "no apt-get; this provisioner targets the project's Debian/Ubuntu containers"
fi
if ! need npm; then
    skip "no npm; the Chrome download needs the container's Node toolchain"
fi

export DEBIAN_FRONTEND=noninteractive
# Before the probe below, not after: a container built from the stock rootfs
# carries no package lists at all, and apt-cache answers "no such package" for
# every candidate rather than admitting it has nothing to search.
apt-get update -qq

resolved=("${APT_PACKAGES[@]}")
for candidates in "${APT_RENAMED_CANDIDATES[@]}"; do
    picked=""
    for candidate in $candidates; do
        if apt-cache show "$candidate" >/dev/null 2>&1; then
            picked="$candidate"
            break
        fi
    done
    if [ -z "$picked" ]; then
        echo "error: none of these packages exist here: $candidates" >&2
        exit 1
    fi
    resolved+=("$picked")
done

echo ">> browser-smoke deps: ${resolved[*]}" >&2
apt-get install -y --no-install-recommends "${resolved[@]}"
# The package lists are deliberately NOT deleted afterwards. Dropping them is a
# container-image idiom, and this runs against a live container that other work
# continues in: clearing them leaves the next `apt-get install` in this
# container failing to find packages that plainly exist.

# The harness reads the newest linux-* build out of the puppeteer cache, so
# install into that layout rather than somewhere CHROME_BIN would have to
# point at. A half-extracted directory from an interrupted or unzip-less
# earlier attempt makes the installer fail on the missing executable instead
# of replacing it, so clear a broken one first.
mkdir -p "$PUPPETEER_CACHE"
for dir in "$PUPPETEER_CACHE"/chrome/linux-*; do
    [ -d "$dir" ] || continue
    [ -x "$dir/chrome-linux64/chrome" ] && continue
    echo ">> discarding incomplete Chrome download: $dir" >&2
    rm -rf "$dir"
done

echo ">> installing Chrome ($CHROME_VERSION) into $PUPPETEER_CACHE" >&2
installed="$(cd "$SCRIPT_DIR" && npx --yes @puppeteer/browsers install \
    "chrome@$CHROME_VERSION" --path "$PUPPETEER_CACHE" | tail -1)"
chrome_bin="${installed##* }"
if [ ! -x "$chrome_bin" ]; then
    echo "error: installer reported '$installed' but left no executable" >&2
    exit 1
fi

# Prove the binary actually starts here rather than only that its files
# landed: a missing library is exactly the failure this script exists to
# remove, and it does not show up until Chrome runs.
missing="$(ldd "$chrome_bin" | awk '/not found/ { print $1 }' | sort -u)"
if [ -n "$missing" ]; then
    echo "error: Chrome still has unresolved libraries:" >&2
    echo "$missing" >&2
    exit 1
fi
if ! "$chrome_bin" --headless --no-sandbox --disable-gpu \
    --dump-dom about:blank >/dev/null 2>&1; then
    echo "error: Chrome is installed but will not render a page" >&2
    exit 1
fi

echo ">> browser-smoke ready: $chrome_bin" >&2
