#!/usr/bin/env bash
# check-package-version-pins.sh -- assert the gateway deb dependency pins name
# the gateway workspace's own version.
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

gateway_version=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' \
    "$REPO/gateway/Cargo.toml" | head -n 1)
[ -n "$gateway_version" ] \
    || die "could not read the version from gateway/Cargo.toml"

# profile's systemd unit Requires the migration unit and binary that the
# identity package ships, so the two debs must come from the same release.
grep -Fq "chan-gateway-identity (= ${gateway_version}-1)" \
    "$REPO/gateway/crates/profile/Cargo.toml" \
    || die "profile package does not require chan-gateway-identity (= ${gateway_version}-1)"
