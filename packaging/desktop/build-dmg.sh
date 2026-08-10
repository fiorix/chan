#!/usr/bin/env bash
#
# Finder-less Chan.app installer DMG builder.
#
# tauri-bundler's DMG step lays out the Finder window by mounting the volume
# and driving Finder over AppleScript (osascript). That needs a live GUI
# session, so a headless CI runner silently no-ops it and ships a flat,
# default-layout DMG, while a local build looks right. This script instead
# drives `dmgbuild`, which writes the .DS_Store layout PROGRAMMATICALLY (pure
# Python via the ds_store lib, then `hdiutil` to make the image) with no Finder
# at all, so local == CI byte-for-byte on layout.
#
# dmgbuild is a BUILD-time-only dependency (like the Node web build): installed
# into a throwaway venv, never shipped, so the single-binary runtime principle
# is untouched. The layout itself is pinned by packaging/desktop/dmg_settings.py, so any
# 1.x dmgbuild produces the same layout.
#
# Usage: build-dmg.sh <Chan.app> <out.dmg> [volume-name]
# Env:   DMGBUILD_SPEC (pip spec, default "dmgbuild>=1.6,<2")
#        DMG_VENV      (venv dir, default <repo>/.build-tools/dmg-venv)

set -euo pipefail

APP="${1:?usage: build-dmg.sh <Chan.app> <out.dmg> [volume-name]}"
OUT="${2:?usage: build-dmg.sh <Chan.app> <out.dmg> [volume-name]}"
VOLNAME="${3:-Chan}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
settings="$here/dmg_settings.py"
spec="${DMGBUILD_SPEC:-dmgbuild>=1.6,<2}"
# Default venv under the repo's .build-tools/ (gitignored, reused across runs).
# NOT under target/: CI caches target/, and see the provisioning note below.
venv="${DMG_VENV:-$(cd "$here/../.." && pwd)/.build-tools/dmg-venv}"

if [ ! -d "$APP" ]; then
    echo "error: app bundle not found: $APP" >&2
    exit 1
fi

# Hermetic, version-pinned dmgbuild in a venv: sidesteps PEP 668 on a
# system/Homebrew python3 and keeps the tool out of the global environment.
# Pure-Python wheels (dmgbuild + ds_store + mac_alias), no native compilation.
# The guard RUNS the venv rather than looking at it. A venv records the
# absolute path of the interpreter that created it, so when that interpreter
# moves -- a Homebrew python upgrade locally, a different runner image behind a
# restored cache -- bin/python dangles while bin/dmgbuild is still a present,
# still-executable script. Any file test passes there and the run dies at the
# exec with a bad interpreter. That is the same class of failure this path
# already shipped once, at a tag, after a dry run on the identical commit had
# passed; that one surfaced as a missing bin/pip and exit 127, this one as an
# unusable interpreter, and both come from reusing a venv nobody ran.
#
# Importing the module through the venv's own interpreter is the predicate the
# invocation below actually depends on, and it fails on a missing venv, a
# dangling interpreter, and a missing package alike. Rebuilding costs a few
# seconds on a cold venv.
if ! "$venv/bin/python" -c 'import dmgbuild' >/dev/null 2>&1; then
    rm -rf "$venv"
    python3 -m venv "$venv"
    # `python -m pip` rather than the bin/pip console script: the module is
    # what ensurepip installs, and it works even where the script is missing.
    if ! "$venv/bin/python" -m pip --version >/dev/null 2>&1; then
        echo "error: the venv at $venv has no pip; python3 -m venv produced one" >&2
        echo "hint: the interpreter lacks ensurepip (Debian/Ubuntu: install python3-venv)" >&2
        exit 1
    fi
    "$venv/bin/python" -m pip install --quiet --disable-pip-version-check "$spec"
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
"$venv/bin/dmgbuild" -s "$settings" -D app="$APP" "$VOLNAME" "$OUT"
echo "built DMG (Finder-less): $OUT"
