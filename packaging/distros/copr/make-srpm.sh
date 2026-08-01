#!/usr/bin/env bash
#
# Assemble the SRPM for one package (chan or chan-desktop) from the current
# repo: run mkdist to produce the vendored source tarball, sync the spec's
# %upstream_version to the tarball version, and rpmbuild -bs. Expects a
# Fedora-ish host with rpmbuild, cargo/rust, node/npm, git, tar, xz -- the
# COPR SRPM chroot after .copr/Makefile's dnf install, or the container
# copr/build-srpm.sh spins up locally.
#
# Usage: make-srpm.sh [--spec <path>] [--outdir <dir>] [--repo <path>]
#                     [--tarball <path>]
#
# --tarball skips mkdist and uses a prebuilt vendored tarball. The local
# container flow (build-srpm.sh) needs this: it runs mkdist on the host
# because a bind-mounted git *worktree* is unreadable in a container (its
# .git is a pointer file into the main repo), and it keeps the container
# down to rpm-build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SPEC=""
OUTDIR=""
TARBALL=""

while [ $# -gt 0 ]; do
    case "$1" in
        --spec) SPEC="$2"; shift 2 ;;
        --outdir) OUTDIR="$2"; shift 2 ;;
        --repo) REPO="$(cd "$2" && pwd)"; shift 2 ;;
        --tarball) TARBALL="$2"; shift 2 ;;
        *) echo "error: unknown argument: $1" >&2; exit 1 ;;
    esac
done

SPEC="${SPEC:-$REPO/packaging/distros/fedora/chan.spec}"
OUTDIR="${OUTDIR:-$REPO/target/distros/srpm}"
SOURCEDIR="$REPO/target/distros"

if [ -z "$TARBALL" ]; then
    # Same EPIPE hazard as build-srpm.sh: read all of mkdist's output,
    # then take its first line.
    TARBALL="$("$REPO/packaging/distros/mkdist" --repo "$REPO" \
        --outdir "$SOURCEDIR")"
    TARBALL="${TARBALL%%$'\n'*}"
elif [ ! -f "$TARBALL" ]; then
    echo "error: $TARBALL not found" >&2
    exit 1
fi
# chan-vendored-<version>.tar.xz -> <version>
VERSION="$(basename "$TARBALL" .tar.xz)"
VERSION="${VERSION#chan-vendored-}"

# The committed spec's %upstream_version is a fallback; the tarball just
# built is the truth. Rewrite a copy next to the sources.
SPEC_COPY="$SOURCEDIR/$(basename "$SPEC")"
sed "s/^%global upstream_version .*/%global upstream_version $VERSION/" \
    "$SPEC" > "$SPEC_COPY"

mkdir -p "$OUTDIR"
rpmbuild -bs "$SPEC_COPY" \
    --define "_sourcedir $SOURCEDIR" \
    --define "_srcrpmdir $OUTDIR"
