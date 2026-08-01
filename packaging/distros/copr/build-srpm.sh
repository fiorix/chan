#!/usr/bin/env bash
#
# Build the chan / chan-desktop SRPMs locally, mirroring what COPR's
# .copr/Makefile does in its SRPM chroot, and optionally submit them with
# copr-cli. The host only needs docker (rpmbuild and the Fedora toolchain
# run inside a fedora:latest container); artifacts land in
# target/distros/srpm/ on the host through the bind mount.
#
# Usage: build-srpm.sh [chan|chan-desktop ...] [--submit]
#
#   no package args   build both packages
#   --submit          after building, `copr-cli build <project> <srpm>`
#                     (needs ~/.config/copr; see packaging/distros/README.md).
#                     chan-desktop excludes the unsupported EL9 chroots.
#
# Env: COPR_PROJECT (default fiorix/chan), FEDORA_IMAGE, DOCKER
#      (default registry.fedoraproject.org/fedora:latest).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COPR_PROJECT="${COPR_PROJECT:-fiorix/chan}"
FEDORA_IMAGE="${FEDORA_IMAGE:-registry.fedoraproject.org/fedora:latest}"
DOCKER="${DOCKER:-docker}"

read -r -a DOCKER_CMD <<<"$DOCKER"
[ ${#DOCKER_CMD[@]} -gt 0 ] || {
    echo "error: DOCKER must name the container command" >&2
    exit 1
}

PKGS=()
SUBMIT=0
while [ $# -gt 0 ]; do
    case "$1" in
        --submit) SUBMIT=1; shift ;;
        chan|chan-desktop) PKGS+=("$1"); shift ;;
        *) echo "error: unknown argument: $1" >&2; exit 1 ;;
    esac
done
[ ${#PKGS[@]} -gt 0 ] || PKGS=(chan chan-desktop)

OUTDIR="$REPO/target/distros/srpm"
mkdir -p "$OUTDIR"

# mkdist runs on the host: a bind-mounted git worktree is unreadable in a
# container (its .git is a pointer into the main repo), and the container
# then needs nothing beyond rpm-build.
# Capture every line rather than piping into head: mkdist prints three
# paths under `set -o pipefail`, so a reader that closes the pipe after
# the first one kills it with EPIPE once the tarball write is slow
# enough for the reader to exit first.
TARBALL="$("$REPO/packaging/distros/mkdist" --repo "$REPO" \
    --outdir "$REPO/target/distros")"
TARBALL="${TARBALL%%$'\n'*}"

for pkg in "${PKGS[@]}"; do
    echo "==> building SRPM: $pkg"
    # The container runs as root; chown the outputs back to the invoking
    # user at the end.
    "${DOCKER_CMD[@]}" run --rm -v "$REPO:/src" "$FEDORA_IMAGE" bash -ec "
        dnf -y -q install rpm-build
        /src/packaging/distros/copr/make-srpm.sh --repo /src \
            --spec /src/packaging/distros/fedora/$pkg.spec \
            --outdir /src/target/distros/srpm \
            --tarball /src/target/distros/$(basename "$TARBALL")
        chown -R $(id -u):$(id -g) /src/target/distros
    "
done

ls -1 "$OUTDIR"/*.src.rpm

if [ "$SUBMIT" = 1 ]; then
    command -v copr-cli >/dev/null || {
        echo "error: copr-cli not installed (pip install copr-cli)" >&2
        exit 1
    }
    for pkg in "${PKGS[@]}"; do
        srpm="$(ls -t "$OUTDIR/$pkg"-[0-9]*.src.rpm 2>/dev/null | head -1)"
        [ -n "$srpm" ] || { echo "error: no SRPM for $pkg" >&2; exit 1; }
        echo "==> submitting $srpm to $COPR_PROJECT"
        # Spelled out per branch rather than through an array: bash before 4.4
        # treats an empty array expansion as unset under `set -u`.
        if [ "$pkg" = chan-desktop ]; then
            copr-cli build "$COPR_PROJECT" "$srpm" \
                --exclude-chroot centos-stream+epel-next-9-aarch64 \
                --exclude-chroot centos-stream+epel-next-9-x86_64
        else
            copr-cli build "$COPR_PROJECT" "$srpm"
        fi
    done
fi
