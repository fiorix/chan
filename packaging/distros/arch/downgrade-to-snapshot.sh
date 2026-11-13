#!/usr/bin/env bash
# Downgrade an Arch system to the Arch Linux Archive snapshot its pacman
# mirrorlist already names, so a build links against the snapshot's libraries
# rather than the image's. The date only names the snapshot in messages.
#
# Usage: downgrade-to-snapshot.sh <YYYY/MM/DD>
#
# `pacman -Suu` takes every installed package the snapshot carries to the
# snapshot's version and leaves the ones it lacks installed. One of those that
# shares a file with a snapshot package fails the whole transaction on a file
# conflict: an image with openssl 4 carries the openssl-3 compat package, whose
# libssl.so.3 the snapshot's openssl 3 owns. So the packages the snapshot lacks
# leave pacman's database first, while their files stay on disk until the
# snapshot's packages have replaced them, because any of them can hold a
# library pacman itself loads. What no snapshot package took over is deleted
# afterwards, and the result is checked: every installed package is the
# snapshot's, at the snapshot's version, with its dependencies met.

set -euo pipefail
export LC_ALL=C

snapshot="${1:?usage: downgrade-to-snapshot.sh <YYYY/MM/DD>}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

# Write the installed packages no sync database carries to $1, one per line.
# pacman -Qm exits 1 both when there are none and when it fails; only the
# failure prints anything.
absent_packages() {
    local status=0
    pacman -Qmq > "$1" 2> "$work/qm.err" || status=$?
    if [ "$status" -eq 0 ] ||
        { [ "$status" -eq 1 ] && [ ! -s "$1" ] && [ ! -s "$work/qm.err" ]; }; then
        return 0
    fi
    cat "$work/qm.err" >&2
    echo "error: pacman -Qm failed (exit $status) listing the installed packages the snapshot $snapshot lacks" >&2
    exit 1
}

pacman -Syy --noconfirm
absent_packages "$work/absent"
mapfile -t absent < "$work/absent"

overwrite=()
if [ "${#absent[@]}" -gt 0 ]; then
    echo ">> the snapshot $snapshot lacks ${#absent[@]} installed package(s), dropped from pacman's database before the downgrade: ${absent[*]}" >&2
    pacman -Qlq "${absent[@]}" | sort -u > "$work/absent-files"
    pacman -Rdd --dbonly --noconfirm "${absent[@]}"
    # Their files are unowned now, and pacman refuses to overwrite an unowned
    # file without --overwrite. Each value is a list of globs split at commas,
    # so the glob characters are escaped and ? stands for a comma.
    while IFS= read -r path; do
        overwrite+=(--overwrite "$path")
    done < <(grep -v '/$' "$work/absent-files" | sed 's/[][*?\\]/\\&/g; s/,/?/g')
fi

if ! pacman -Suu --noconfirm ${overwrite[@]+"${overwrite[@]}"}; then
    echo "error: pacman -Suu could not downgrade the image to the Arch Linux Archive snapshot $snapshot" >&2
    if [ "${#absent[@]}" -gt 0 ]; then
        echo "error: the snapshot lacks these installed packages, already dropped from pacman's database: ${absent[*]}" >&2
    fi
    exit 1
fi

if [ "${#absent[@]}" -gt 0 ]; then
    pacman -Qlq | sort -u > "$work/owned"
    comm -23 "$work/absent-files" "$work/owned" > "$work/leftover"
    # A package lists every directory above its files, so nothing installed
    # lives under a directory that no installed package owns.
    xargs -r -d '\n' rm -rf -- < "$work/leftover"
    echo ">> deleted $(wc -l < "$work/leftover") path(s) of ${absent[*]} that no snapshot package took over" >&2
fi

problems=()
absent_packages "$work/absent-after"
if [ -s "$work/absent-after" ]; then
    problems+=("installed, absent from the snapshot: $(paste -sd' ' "$work/absent-after")")
fi
pacman -Sl > "$work/sync"
grep -F ' [installed: ' "$work/sync" > "$work/drift" || [ $? -eq 1 ]
if [ -s "$work/drift" ]; then
    problems+=("installed at another version than the snapshot's: $(paste -sd';' "$work/drift")")
fi
if ! pacman -Dk > "$work/deps" 2>&1; then
    problems+=("pacman -Dk: $(paste -sd';' "$work/deps")")
fi
if [ "${#problems[@]}" -gt 0 ]; then
    echo "error: after the downgrade the image does not match the Arch Linux Archive snapshot $snapshot:" >&2
    printf '  %s\n' "${problems[@]}" >&2
    exit 1
fi
echo ">> the image matches the snapshot $snapshot: $(grep -c ' \[installed\]$' "$work/sync") installed packages, each at the snapshot's version" >&2
