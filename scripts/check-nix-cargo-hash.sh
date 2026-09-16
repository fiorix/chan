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
# exactly one cargoHash line, no Cargo.lock, or the value both files already
# pin offered for a Cargo.lock that is not the one it was harvested for,
# which is the `specified:` line a Nix build prints beside `got:`) comes
# before the first write, so a refused run leaves every file as it was. Both
# files are rendered to temporary files before either is replaced, a failure
# before the replacement removes them, and only the value between `=` and
# the first `;` of the cargoHash line is replaced, so the rest of the line
# survives the pin.
#
# A pinned value is accepted as written: only a Nix build can prove it.
# Harvest it with `make nix-sdme-check NIX_PACKAGE=chan` on Linux, or
# `make nix-check` where Nix is installed, with the Cargo.lock you will pin
# in the working tree; a host without Linux or Nix harvests in a Linux
# container, or asks a maintainer to.
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
HARVEST="harvest the value with 'make nix-sdme-check NIX_PACKAGE=chan' on Linux, or 'make nix-check' where Nix is installed, with the Cargo.lock you will pin in the working tree (a host without Linux or Nix harvests in a Linux container, or asks a maintainer to), then pin it with 'make nix-hash-pin CARGO_HASH=sha256-...'"

problems=()
pin=""
# The files `pin` renders beside the originals, removed on every exit so a
# failed run leaves nothing behind.
temps=()

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

remove_temps() {
    if [ "${#temps[@]}" -gt 0 ]; then
        rm -f "${temps[@]}"
    fi
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
# placeholder is a value of its own rather than a missing line. The value
# ends at the first `;`; whatever follows on the line is not the pin's.
cargo_hash_lines() {
    sed -n 's/^[[:space:]]*cargoHash[[:space:]]*=[[:space:]]*\([^;]*\);.*$/\1/p'
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
    local value="$1" file tmp digest recorded="" chan_pin desktop_pin

    harvestable "$value" || die "'$value' is not a harvested cargoHash value: expected the bare SRI form a Nix build reports as got:, 'sha256-' followed by 43 base64 characters and '=', and not the lib.fakeHash placeholder; nothing was written"
    read_pin "$CHAN_NIX" || die "${problems[0]}; nothing was written"
    chan_pin="$pin"
    read_pin "$DESKTOP_NIX" || die "${problems[0]}; nothing was written"
    desktop_pin="$pin"
    [ -f "$LOCK" ] || die "$LOCK is absent; nothing was written"
    digest="$(sha256_of "$LOCK")"

    # The value both files already pin, offered for a lock that is not the
    # one it was harvested for, is the stale pin: a Nix build prints it as
    # `specified:` right beside the harvested `got:` value, and the easy slip
    # is to copy that line. A digest file that is absent or malformed cannot
    # tell the two locks apart, so it does not refuse.
    if [ -f "$DIGEST_FILE" ]; then
        recorded="$(cat "$DIGEST_FILE")"
        if [[ $recorded =~ $DIGEST_LINE ]]; then
            recorded="${recorded%%  *}"
        else
            recorded=""
        fi
    fi
    if [ -n "$recorded" ] && [ "$recorded" != "$digest" ] && [ "$chan_pin" = "\"$value\"" ] && [ "$desktop_pin" = "\"$value\"" ]; then
        die "'$value' is the value both $CHAN_NIX and $DESKTOP_NIX pin, harvested for a $LOCK that is not the live one (live digest $digest, $DIGEST_FILE records $recorded): a Nix build prints that stale pin as 'specified:' beside the harvested value as 'got:', so copy the got: line; if both files were edited by hand to the harvested value, set them to lib.fakeHash and pin again; nothing was written"
    fi

    # Both files are rendered before either original is replaced, so a
    # failure up to the first rename leaves the tree as it was, and the trap
    # removes whatever was rendered. The copy keeps the original's mode and
    # owner, and only the value between `=` and the first `;` is replaced,
    # so anything else on the line survives the pin.
    trap remove_temps EXIT
    for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
        tmp="$(mktemp "$file.XXXXXX")" || die "cannot create a temporary file beside $file; nothing was written"
        temps+=("$tmp")
        cp -p "$file" "$tmp" || die "cannot copy $file to $tmp; nothing was written"
        sed "s|^\([[:space:]]*cargoHash[[:space:]]*=[[:space:]]*\)[^;]*;|\1\"$value\";|" "$file" >"$tmp" || die "cannot render $tmp; nothing was written"
    done
    mv -f "${temps[0]}" "$CHAN_NIX" || die "cannot replace $CHAN_NIX; nothing was written"
    mv -f "${temps[1]}" "$DESKTOP_NIX" || die "cannot replace $DESKTOP_NIX: $CHAN_NIX is pinned and $DESKTOP_NIX is not, so pin again"
    temps=()
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
