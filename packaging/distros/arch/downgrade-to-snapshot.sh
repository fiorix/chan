#!/usr/bin/env bash
# Downgrade a throwaway Arch build container to the Arch Linux Archive snapshot
# of the given date, so a build links against the snapshot's libraries rather
# than the image's. The caller points pacman at that snapshot first.
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
# library pacman itself loads. Once the dependencies check out, what no
# snapshot package took over is deleted the way pacman -R deletes, and the
# result is checked: every installed package is the snapshot's, at the
# snapshot's version.

set -euo pipefail
export LC_ALL=C

snapshot="${1:?usage: downgrade-to-snapshot.sh <YYYY/MM/DD>}"

refuse() {
    echo "error: downgrade-to-snapshot.sh refuses to run: $*" >&2
    exit 1
}

# It uninstalls packages and deletes files, so it runs only in a container,
# and only where every repository pacman reads is the snapshot alone; anywhere
# else the packages it would drop are not the snapshot's to judge.
command -v systemd-detect-virt > /dev/null ||
    refuse "systemd-detect-virt is missing, so it cannot tell that it runs in a container"
systemd-detect-virt --container --quiet ||
    refuse "it runs outside a container, and it uninstalls packages and deletes their files"
arches="$(pacman-conf Architecture)" || refuse "pacman-conf cannot read pacman's architecture"
arch="${arches%%$'\n'*}"
repos="$(pacman-conf --repo-list)" || refuse "pacman-conf cannot list pacman's repositories"
[ -n "$repos" ] || refuse "pacman has no repositories"
while IFS= read -r repo; do
    expected="https://archive.archlinux.org/repos/$snapshot/$repo/os/$arch"
    servers="$(pacman-conf --repo="$repo" Server)" ||
        refuse "pacman-conf cannot read the servers of the repository $repo"
    [ "$servers" = "$expected" ] ||
        refuse "the repository $repo is served by '$(printf '%s' "$servers" | paste -sd' ')', not by the Arch Linux Archive snapshot $snapshot alone ($expected)"
done <<< "$repos"

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

if ! pacman -Suu --noconfirm ${overwrite[@]+"${overwrite[@]}"} 2>&1 | tee "$work/upgrade"; then
    echo "error: pacman -Suu could not downgrade the image to the Arch Linux Archive snapshot $snapshot" >&2
    if [ "${#absent[@]}" -gt 0 ]; then
        echo "error: the snapshot lacks these installed packages, already dropped from pacman's database: ${absent[*]}" >&2
    fi
    exit 1
fi

# pacman keeps a configuration file that differs from the snapshot package's
# and writes the snapshot's copy beside it. The build reads neither, so this
# is reported, not refused.
grep -E ' installed as .*\.pacnew$| saved as .*\.pacsave$' "$work/upgrade" > "$work/config" || [ $? -eq 1 ]
if [ -s "$work/config" ]; then
    echo ">> configuration the image keeps instead of the snapshot's: $(sed 's/^warning: //' "$work/config" | paste -sd';')" >&2
fi

# A package the snapshot lacks can provide what a package outside the
# transaction needs, and its files may still hold a library pacman loads: the
# dependencies are read while those files are still on disk.
if ! pacman -Dk > "$work/deps" 2>&1; then
    echo "error: after the downgrade to the Arch Linux Archive snapshot $snapshot, pacman -Dk: $(paste -sd';' "$work/deps")" >&2
    if [ "${#absent[@]}" -gt 0 ]; then
        echo "error: the snapshot lacks these installed packages, dropped from pacman's database with their files left on disk: ${absent[*]}" >&2
    fi
    exit 1
fi

if [ "${#absent[@]}" -gt 0 ]; then
    pacman -Qlq | sort -u > "$work/owned"
    comm -23 "$work/absent-files" "$work/owned" > "$work/leftover"
    # As pacman -R does: deepest first, files, then each directory once it is
    # empty. Whatever no package owns stays, with the directories above it,
    # and a directory entry that is a symlink on disk is left alone.
    removed=0
    kept=()
    while IFS= read -r entry; do
        path="${entry%/}"
        if [ -L "$path" ]; then
            [ "$entry" != "$path" ] || { rm -f -- "$path"; removed=$((removed + 1)); }
        elif [ -d "$path" ]; then
            rmdir --ignore-fail-on-non-empty -- "$path"
            if [ -d "$path" ]; then
                kept+=("$entry")
            else
                removed=$((removed + 1))
            fi
        elif [ -e "$path" ]; then
            rm -f -- "$path"
            removed=$((removed + 1))
        fi
    done < <(sort -r "$work/leftover")
    echo ">> deleted $removed path(s) of ${absent[*]} that no snapshot package took over" >&2
    if [ "${#kept[@]}" -gt 0 ]; then
        echo ">> kept ${#kept[@]} of their directories, which hold files no package owns: ${kept[*]}" >&2
    fi
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
if [ "${#problems[@]}" -gt 0 ]; then
    echo "error: after the downgrade the image does not match the Arch Linux Archive snapshot $snapshot:" >&2
    printf '  %s\n' "${problems[@]}" >&2
    exit 1
fi
echo ">> the image matches the snapshot $snapshot: $(grep -c ' \[installed\]$' "$work/sync") installed packages, each at the snapshot's version" >&2
