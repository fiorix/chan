#!/usr/bin/env bash
# Keep the Nix cargoHash pins in step with the root Cargo.lock.
#
# packaging/nix/chan.nix and packaging/nix/chan-desktop.nix pin cargoHash, the
# fixed-output hash of the crates vendored from the root Cargo.lock. Both
# derivations build from the same flake source and vendor the same lock, so
# the two pins carry one value. Every change to the lock changes that value, a
# new edge to an already locked crate included, and no cargo step reads the
# .nix files, so a lock change on its own gates green and turns CI's Nix job
# red on main.
#
# packaging/nix/cargo-lock.sha256 records, in sha256sum format, the digest of
# the Cargo.lock the current pins were harvested for. `check` (the default)
# fails when the live Cargo.lock digests differently, when the digest file is
# absent or malformed, when either .nix file has no cargoHash line or more
# than one, when a pin is not a quoted SRI "sha256-..." literal (lib.fakeHash,
# "" and the value lib.fakeHash spells out are placeholders a Nix build
# rejects), or when the two pins differ. The verdict depends only on the files
# in the tree: no git history, no network, and nothing is written.
#
# `pin VALUE` writes a harvested value into both .nix files and rewrites the
# digest file from the live Cargo.lock, so the correct state after a harvest
# is one command. VALUE passes the same test a pin has to pass under `check`,
# and every refusal (a placeholder, a malformed value, a .nix file without
# exactly one cargoHash line, no Cargo.lock) comes before the first write, so
# a refused run leaves every file as it was.
#
# A pinned value is accepted as written: only a Nix build can prove it.
# Harvest it with `make nix-sdme-check NIX_PACKAGE=chan` on Linux from a
# clean worktree at the branch head, or `make nix-check` where Nix is
# installed; on any other host, take the got: value CI's Nix job reports on
# the pull request.
#
# Usage: scripts/check-nix-cargo-hash.sh [check]
#        scripts/check-nix-cargo-hash.sh pin sha256-<43 base64 characters>=
#
# Runs on bash 3.2 with sha256sum or shasum.
set -euo pipefail

LOCK="Cargo.lock"
DIGEST_FILE="packaging/nix/cargo-lock.sha256"
CHAN_NIX="packaging/nix/chan.nix"
DESKTOP_NIX="packaging/nix/chan-desktop.nix"
TAG="nix cargo hash"
NL=$'\n'
# A harvested value: the SRI form a Nix build reports as `got:`.
SRI='^sha256-[A-Za-z0-9+/]{43}=$'
# What lib.fakeHash evaluates to, so the placeholder is refused spelled out
# as well as by name.
FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
# One line of the digest file, as sha256sum prints it.
DIGEST_LINE='^[0-9a-f]{64}  Cargo\.lock$'
HARVEST="harvest the value with 'make nix-sdme-check NIX_PACKAGE=chan' on Linux from a clean worktree at the branch head, or 'make nix-check' where Nix is installed (on any other host take the got: value CI's Nix job reports), then pin it with 'make nix-hash-pin CARGO_HASH=sha256-...'"

problems=()
pin=""

usage() {
    echo "usage: $0 [check] | $0 pin sha256-<43 base64 characters>=" >&2
    exit 2
}

die() {
    echo "$TAG: FAIL: $*" >&2
    exit 1
}

problem() {
    problems+=("$*")
}

# The lowercase hex digest of FILE, from whichever tool the host has.
sha256_of() {
    local out
    if command -v sha256sum >/dev/null 2>&1; then
        out="$(sha256sum "$1")"
    elif command -v shasum >/dev/null 2>&1; then
        out="$(shasum -a 256 "$1")"
    else
        die "need sha256sum or shasum on PATH to digest $1"
    fi
    printf '%s' "${out%% *}"
}

# Whether VALUE, unquoted, is a harvested one: the `got:` form, and not what
# lib.fakeHash spells out.
harvestable() {
    [[ $1 =~ $SRI ]] && [ "$1" != "$FAKE_HASH" ]
}

# The cargoHash value as written, quotes included, so a `lib.fakeHash`
# placeholder is a value of its own rather than a missing line.
cargo_hash_lines() {
    sed -n 's/^[[:space:]]*cargoHash[[:space:]]*=[[:space:]]*\(.*\);[[:space:]]*$/\1/p'
}

# Sets `pin` to the one cargoHash value of FILE. A missing line and a
# duplicated one are both defects the check must not read past, so either
# records a problem and returns 1.
read_pin() {
    local file="$1"
    pin=""
    if [ ! -f "$file" ]; then
        problem "$file is absent"
        return 1
    fi
    pin="$(cargo_hash_lines <"$file")"
    case "$pin" in
        "")
            problem "no cargoHash line in $file"
            return 1
            ;;
        *"$NL"*)
            problem "more than one cargoHash line in $file"
            return 1
            ;;
    esac
}

# Records a problem and returns 1 unless VALUE, the pin as written in FILE,
# is a quoted harvested value.
valid_pin() {
    local file="$1" value="$2" bare
    bare="${value#\"}"
    bare="${bare%\"}"
    if [ "$value" != "\"$bare\"" ] || ! harvestable "$bare"; then
        problem "cargoHash in $file is $value, a placeholder or malformed value rather than a harvested one, and a Nix build rejects it; $HARVEST"
        return 1
    fi
}

check() {
    local live="" recorded chan_pin="" desktop_pin=""

    if [ ! -f "$LOCK" ]; then
        problem "$LOCK is absent"
    elif [ ! -f "$DIGEST_FILE" ]; then
        problem "$DIGEST_FILE is absent: it records the digest of the $LOCK the cargoHash pins were harvested for; $HARVEST"
    else
        recorded="$(cat "$DIGEST_FILE")"
        if [[ $recorded =~ $DIGEST_LINE ]]; then
            recorded="${recorded%%  *}"
            live="$(sha256_of "$LOCK")"
            if [ "$live" != "$recorded" ]; then
                problem "$LOCK changed since the cargoHash pins were harvested: its digest is $live and $DIGEST_FILE records $recorded; $HARVEST"
            fi
        else
            problem "$DIGEST_FILE is malformed: expected the one line '<64 hex>  $LOCK' that sha256sum prints and 'make nix-hash-pin' writes"
        fi
    fi

    # Only two harvested values are compared with each other: a placeholder
    # is reported as one, not also as a disagreement.
    if read_pin "$CHAN_NIX" && valid_pin "$CHAN_NIX" "$pin"; then
        chan_pin="$pin"
    fi
    if read_pin "$DESKTOP_NIX" && valid_pin "$DESKTOP_NIX" "$pin"; then
        desktop_pin="$pin"
    fi
    if [ -n "$chan_pin" ] && [ -n "$desktop_pin" ] && [ "$chan_pin" != "$desktop_pin" ]; then
        problem "cargoHash differs between $CHAN_NIX ($chan_pin) and $DESKTOP_NIX ($desktop_pin); both derivations vendor the same $LOCK, so both carry the one value the harvest reports"
    fi

    if [ "${#problems[@]}" -gt 0 ]; then
        local item
        for item in "${problems[@]}"; do
            echo "$TAG: FAIL: $item" >&2
        done
        exit 1
    fi
    echo "$TAG: PASS: $LOCK is the lock the cargoHash pins were harvested for (sha256 ${live:0:12}) and both pins carry $chan_pin"
}

pin_hash() {
    local value="$1" file tmp digest

    harvestable "$value" || die "'$value' is not a harvested cargoHash value: expected the bare SRI form a Nix build reports as got:, 'sha256-' followed by 43 base64 characters and '=', and not the lib.fakeHash placeholder; nothing was written"
    for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
        read_pin "$file" || die "${problems[0]}; nothing was written"
    done
    [ -f "$LOCK" ] || die "$LOCK is absent; nothing was written"
    digest="$(sha256_of "$LOCK")"

    for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
        tmp="$(mktemp "$file.XXXXXX")"
        sed "s|^\([[:space:]]*cargoHash[[:space:]]*=[[:space:]]*\).*;[[:space:]]*\$|\1\"$value\";|" "$file" >"$tmp"
        # Copied over rather than moved into place, so the file keeps its
        # inode and mode.
        cat "$tmp" >"$file"
        rm -f "$tmp"
    done
    printf '%s  %s\n' "$digest" "$LOCK" >"$DIGEST_FILE"
    echo "$TAG: pinned $value in $CHAN_NIX and $DESKTOP_NIX and recorded the $LOCK digest in $DIGEST_FILE"
    check
}

cd "$(dirname "${BASH_SOURCE[0]}")/.."

case "${1:-check}" in
    check)
        [ $# -le 1 ] || usage
        check
        ;;
    pin)
        [ $# -eq 2 ] || usage
        pin_hash "$2"
        ;;
    *)
        usage
        ;;
esac
