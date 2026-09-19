#!/usr/bin/env bash
# check-package-version-pins.sh -- assert the gateway deb dependency pins name
# the Debian version cargo-deb gives the packages of this workspace.
#
# cargo-deb copies `[package.metadata.deb] depends` verbatim into the control
# file, so nothing in the build derives these strings and nothing else notices
# when one goes stale. A pin left at an older release ships a package that apt
# and dpkg refuse to install beside its siblings from the same release, which
# is exactly what the install instructions tell a user to do. The gate asserts
# them instead.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

die() {
    echo "check-package-version-pins: $*" >&2
    exit 1
}

# The Debian version cargo-deb builds a crate of this version under, mirroring
# its manifest_version_string: a semver prerelease identifier holding both a
# digit and a non-digit moves to Debian's `~` form, which sorts before the
# final release, and the package revision follows. A release version has no
# prerelease and only gains the revision.
debian_version() {
    local version=$1 pre=${1#*-}
    if [[ $pre != "$version" && $pre == *[0-9]* && $pre == *[!0-9]* ]]; then
        version="${version%%-*}~$pre"
    fi
    printf '%s-1\n' "$version"
}

gateway_version=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' \
    "$REPO/gateway/Cargo.toml" | head -n 1)
[ -n "$gateway_version" ] \
    || die "could not read the version from gateway/Cargo.toml"
identity_version=$(debian_version "$gateway_version")

# profile's systemd unit Requires the migration unit and binary that the
# identity package ships, so the two debs must come from the same release.
grep -Fq "chan-gateway-identity (= ${identity_version})" \
    "$REPO/gateway/crates/profile/Cargo.toml" \
    || die "profile package does not require chan-gateway-identity (= ${identity_version})"
