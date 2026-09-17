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
# than one (a second cargoHash attribute on the one line included), when a
# pin is not a quoted SRI "sha256-..." literal (lib.fakeHash, "" and the
# value lib.fakeHash spells out are placeholders a Nix build rejects), when a
# pin is the npmDeps.hash of the same file, or when the two pins differ. The
# verdict depends only on the files in the tree: no git history, no network,
# and nothing is written.
#
# `pin VALUE` writes a harvested value into both .nix files and rewrites the
# digest file from the live Cargo.lock, so the correct state after a harvest
# is one command. VALUE passes the same test a pin has to pass under `check`,
# and every refusal comes before the first write, so a refused run leaves
# every file as it was: a placeholder or malformed value, a .nix file without
# exactly one cargoHash line, a cargoHash value that is neither a quoted
# string nor a lib.* placeholder (a comment or an expression before the `;`
# would be replaced along with it), no Cargo.lock, the value an npmDeps.hash
# pin carries, and the value both files already pin offered for a Cargo.lock
# the digest file does not name, which is the `specified:` line a Nix build
# prints beside `got:`. A malformed digest file names no lock either, so it
# refuses that value too; only an absent digest file, the bootstrap case,
# accepts it, and the pin says so. Both files and the digest line are
# rendered to temporary files before any original is replaced, a failure
# before the first replacement removes them, and the digest is replaced last,
# so a run cut short leaves a tree the check fails rather than one that
# passes with stale pins. Only the value between `=` and the first `;` of the
# cargoHash line is replaced, so the rest of the line survives the pin.
#
# A pinned value is accepted as written: only a Nix build can prove it.
# Harvest it with `make nix-sdme-check NIX_PACKAGE=chan` on Linux, or
# `make nix-check` on a Linux host with Nix installed (both targets are
# Linux-only), with the Cargo.lock you will pin in the working tree; a macOS
# or Windows host harvests in a Linux VM or container that has Nix, over this
# working tree, or asks a maintainer to. The value is the `got:` line of the
# mismatch whose derivation name ends in `-vendor-staging`. A `-npm-deps`
# mismatch is npmDeps.hash, which a build with both lockfiles changed reports
# first; it is re-pinned by hand in both files before a build reaches the
# cargo one.
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
# A cargoHash value the pin can replace: a quoted string or a lib.*
# placeholder, and nothing else before the `;`.
PIN_TARGET='^("[^"]*"|lib\.[A-Za-z_][A-Za-z0-9_-]*)[[:space:]]*$'
# A second cargoHash attribute in what follows the value's `;` on its line.
# A trailing comment that spells `; cargoHash =` trips it too, which fails
# closed on a layout no file here uses.
SECOND_ATTR='(^|;)[[:space:]]*cargoHash[[:space:]]*='
# An npmDeps.hash line: `hash = "..."` as an attribute name of its own, not
# the tail of cargoHash.
NPM_HASH_LINE='(^|[^A-Za-z0-9_])hash[[:space:]]*=[[:space:]]*"([^"]*)"'
HARVEST="harvest the value with 'make nix-sdme-check NIX_PACKAGE=chan' on Linux, or 'make nix-check' on a Linux host with Nix installed, with the Cargo.lock you will pin in the working tree (a macOS or Windows host harvests in a Linux VM or container that has Nix, over this working tree, or asks a maintainer to); copy the got: line of the mismatch whose derivation name ends in -vendor-staging (a -npm-deps mismatch is npmDeps.hash, re-pinned by hand in both .nix files before a build reaches the cargo one), then pin it with 'make nix-hash-pin CARGO_HASH=sha256-...'"

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

# What follows the value's `;` on each cargoHash line.
cargo_hash_rests() {
    sed -n 's/^[[:space:]]*cargoHash[[:space:]]*=[[:space:]]*[^;]*;\(.*\)$/\1/p'
}

# Sets `pin` to the one cargoHash value of FILE. A missing line and a
# duplicated one are both defects the check must not read past, so either
# records a problem and returns 1. Two attributes on the one line are a
# duplicate too: Nix rejects the line, and the value read would be only the
# first.
read_pin() {
    local file="$1" rest
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
    rest="$(cargo_hash_rests <"$file")"
    if [[ $rest =~ $SECOND_ATTR ]]; then
        problem "more than one cargoHash attribute on the cargoHash line of $file"
        return 1
    fi
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

# Whether VALUE, unquoted, is pinned as a `hash = "..."` attribute of FILE:
# the npmDeps.hash, which a build with both lockfiles changed reports first,
# and whose got: line is not the cargo value.
npm_hash_pinned() {
    local file="$1" value="$2" line
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ $line =~ $NPM_HASH_LINE ]] && [ "${BASH_REMATCH[2]}" = "$value" ]; then
            return 0
        fi
    done <"$file"
    return 1
}

# Records a problem and returns 1 when VALUE, the quoted pin of FILE, is the
# npmDeps.hash pinned in the same file.
not_npm_hash() {
    local file="$1" value="$2" bare
    bare="${value#\"}"
    bare="${bare%\"}"
    if npm_hash_pinned "$file" "$bare"; then
        problem "cargoHash in $file is $value, the value its npmDeps.hash pins: a Nix build reports the -npm-deps mismatch before the -vendor-staging one, and only the got: line of the latter is the cargo value; $HARVEST"
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
            problem "$DIGEST_FILE is malformed: expected the one line '<64 hex>  $LOCK' that sha256sum prints and 'make nix-hash-pin' writes; restore it from the commit whose cargoHash pins you kept and run the check again, or $HARVEST"
        fi
    fi

    # Only two harvested values are compared with each other: a placeholder
    # or an npm value is reported as one, not also as a disagreement.
    if read_pin "$CHAN_NIX" && valid_pin "$CHAN_NIX" "$pin" && not_npm_hash "$CHAN_NIX" "$pin"; then
        chan_pin="$pin"
    fi
    if read_pin "$DESKTOP_NIX" && valid_pin "$DESKTOP_NIX" "$pin" && not_npm_hash "$DESKTOP_NIX" "$pin"; then
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

# Dies unless VALUE, the cargoHash value as written in FILE, is one the pin
# can replace without rewriting the rest of the line into Nix that does not
# parse.
replaceable() {
    [[ $2 =~ $PIN_TARGET ]] || die "cargoHash in $1 is $2, neither a quoted value nor a lib.* placeholder, so the pin cannot replace it: set the line to 'cargoHash = lib.fakeHash;' and pin again; nothing was written"
}

pin_hash() {
    local value="$1" file tmp digest recorded="" digest_state="" chan_pin desktop_pin

    harvestable "$value" || die "'$value' is not a harvested cargoHash value: expected the bare SRI form a Nix build reports as got:, 'sha256-' followed by 43 base64 characters and '=', and not the lib.fakeHash placeholder; nothing was written"
    read_pin "$CHAN_NIX" || die "${problems[0]}; nothing was written"
    chan_pin="$pin"
    replaceable "$CHAN_NIX" "$chan_pin"
    read_pin "$DESKTOP_NIX" || die "${problems[0]}; nothing was written"
    desktop_pin="$pin"
    replaceable "$DESKTOP_NIX" "$desktop_pin"
    for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
        if npm_hash_pinned "$file" "$value"; then
            die "'$value' is the npmDeps.hash pinned in $file: a Nix build reports the -npm-deps mismatch before the -vendor-staging one, and only the got: line of the latter is the cargo value, so build again with npmDeps.hash re-pinned and copy that line; nothing was written"
        fi
    done
    [ -f "$LOCK" ] || die "$LOCK is absent; nothing was written"
    digest="$(sha256_of "$LOCK")"

    # The value both files already pin, offered for a lock that is not the
    # one it was harvested for, is the stale pin: a Nix build prints it as
    # `specified:` right beside the harvested `got:` value, and the easy slip
    # is to copy that line. A malformed digest file (a merge or rebase
    # conflict left in it, say) cannot tell the two locks apart, so it
    # refuses the value too, with the repair named. An absent digest file is
    # the bootstrap case: the value pins, and the pin says so.
    if [ -f "$DIGEST_FILE" ]; then
        recorded="$(cat "$DIGEST_FILE")"
        if [[ $recorded =~ $DIGEST_LINE ]]; then
            recorded="${recorded%%  *}"
            digest_state="recorded"
        else
            recorded=""
            digest_state="malformed"
        fi
    else
        digest_state="absent"
    fi
    if [ "$chan_pin" = "\"$value\"" ] && [ "$desktop_pin" = "\"$value\"" ]; then
        case "$digest_state" in
            recorded)
                if [ "$recorded" != "$digest" ]; then
                    die "'$value' is the value both $CHAN_NIX and $DESKTOP_NIX pin, harvested for a $LOCK that is not the live one (live digest $digest, $DIGEST_FILE records $recorded): a Nix build prints that stale pin as 'specified:' beside the harvested value as 'got:', so copy the got: line of the -vendor-staging mismatch; if both files were edited by hand to the harvested value, or an earlier pin stopped before it recorded the digest, set both to lib.fakeHash and pin again; nothing was written"
                fi
                ;;
            malformed)
                die "'$value' is the value both $CHAN_NIX and $DESKTOP_NIX pin, and $DIGEST_FILE is malformed (expected the one line '<64 hex>  $LOCK'), so the pins cannot be matched to the live $LOCK: restore the digest file from the commit whose pins you kept (for example 'git checkout <rev> -- $DIGEST_FILE') and run the check, or $HARVEST; nothing was written"
                ;;
            absent)
                echo "$TAG: note: $DIGEST_FILE is absent, so '$value', which both files already pin, is recorded as harvested for the live $LOCK without a stale-pin check" >&2
                ;;
        esac
    fi

    # Both files and the digest line are rendered before any original is
    # replaced, so a failure up to the first rename leaves the tree as it
    # was, and the trap removes whatever was rendered. The copy keeps the
    # original's mode and owner, and only the value between `=` and the
    # first `;` is replaced, so anything else on the line survives the pin.
    # The digest is replaced last: a run cut short then leaves a tree the
    # check fails, never one that passes with stale pins.
    trap remove_temps EXIT
    for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
        tmp="$(mktemp "$file.XXXXXX")" || die "cannot create a temporary file beside $file; nothing was written"
        temps+=("$tmp")
        cp -p "$file" "$tmp" || die "cannot copy $file to $tmp; nothing was written"
        sed "s|^\([[:space:]]*cargoHash[[:space:]]*=[[:space:]]*\)[^;]*;|\1\"$value\";|" "$file" >"$tmp" || die "cannot render $tmp; nothing was written"
    done
    tmp="$(mktemp "$DIGEST_FILE.XXXXXX")" || die "cannot create a temporary file beside $DIGEST_FILE; nothing was written"
    temps+=("$tmp")
    if [ -f "$DIGEST_FILE" ]; then
        cp -p "$DIGEST_FILE" "$tmp" || die "cannot copy $DIGEST_FILE to $tmp; nothing was written"
    else
        # A new file gets the mode a fresh checkout would give it, not
        # mktemp's private one.
        chmod "=rw" "$tmp" || die "cannot set the mode of $tmp; nothing was written"
    fi
    printf '%s  %s\n' "$digest" "$LOCK" >"$tmp" || die "cannot render $tmp; nothing was written"
    mv -f "${temps[0]}" "$CHAN_NIX" || die "cannot replace $CHAN_NIX; nothing was written"
    mv -f "${temps[1]}" "$DESKTOP_NIX" || die "cannot replace $DESKTOP_NIX: $CHAN_NIX is pinned and $DESKTOP_NIX is not, so pin again"
    mv -f "${temps[2]}" "$DIGEST_FILE" || die "cannot replace $DIGEST_FILE: both files are pinned and the $LOCK digest is not recorded, so write the line '$digest  $LOCK' to $DIGEST_FILE by hand and run the check"
    temps=()
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
