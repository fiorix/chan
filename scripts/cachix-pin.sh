#!/usr/bin/env bash
# Pin a release's Nix closures in a Cachix cache under stable names.
#
# A pin keeps its closure out of Cachix's garbage collection, so a pin per
# release would hold every release's closures and fill the cache. Each
# package and system has one pin name instead (`chan-x86_64-linux`,
# `chan-desktop-aarch64-linux`), every release adds a revision to it, and
# `--keep-revisions KEEP` has Cachix drop the revisions older than the newest
# KEEP, whose closures then fall to its garbage collection.
#
# Usage: cachix-pin.sh plan|pin CACHE KEEP SYSTEM PACKAGE=STORE_PATH...
#
# `plan` prints, one a line, the `cachix pin` commands `pin` runs, and runs
# nothing; a dry run lists them that way. `pin` prints each command to stderr
# and runs it, stopping at the first failure. Both refuse a KEEP that is not
# a positive integer, and malformed names or store paths, before any command.

set -euo pipefail

usage() {
    echo "usage: $(basename "$0") plan|pin CACHE KEEP SYSTEM PACKAGE=STORE_PATH..." >&2
    exit 2
}

refuse() {
    echo "cachix pin: $*" >&2
    exit 1
}

[ "$#" -ge 5 ] || usage
mode="$1" cache="$2" keep="$3" system="$4"
shift 4
case "$mode" in
    plan | pin) ;;
    *) usage ;;
esac

[[ "$cache" =~ ^[a-z0-9][a-z0-9-]*$ ]] || refuse "cache name must be lowercase letters, digits and dashes, got '$cache'"
[[ "$keep" =~ ^[1-9][0-9]{0,3}$ ]] || refuse "revisions to keep must be a whole number from 1 to 9999, got '$keep'"
[[ "$system" =~ ^[a-z0-9_]+-[a-z]+$ ]] || refuse "system must look like x86_64-linux, got '$system'"

commands=()
for pair in "$@"; do
    package="${pair%%=*}"
    path="${pair#*=}"
    [ "$package" != "$pair" ] || refuse "expected PACKAGE=STORE_PATH, got '$pair'"
    [[ "$package" =~ ^[a-z][a-z0-9-]*$ ]] || refuse "package name must be lowercase letters, digits and dashes, got '$package'"
    [[ "$path" =~ ^/nix/store/[0-9a-z]{32}-[^/[:space:]]+$ ]] || refuse "store path of $package is not a /nix/store path, got '$path'"
    commands+=("pin $cache $package-$system $path --keep-revisions $keep")
done

for command in "${commands[@]}"; do
    if [ "$mode" = plan ]; then
        echo "cachix $command"
        continue
    fi
    echo "cachix $command" >&2
    # Every word was validated above: no spaces, globs or quotes to split on.
    # shellcheck disable=SC2086
    cachix $command || refuse "pinning failed: cachix $command"
done
