#!/usr/bin/env bash
# Create an immutable snapshot of the working-tree content of tracked files.

set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "usage: $0 REPOSITORY SNAPSHOT-PREFIX" >&2
    exit 2
fi

REPO_INPUT="$1"
SNAPSHOT_PREFIX="$2"
case "$SNAPSHOT_PREFIX" in
    chan-*-source) ;;
    *)
        echo "error: snapshot prefix must match chan-*-source (got '$SNAPSHOT_PREFIX')" >&2
        exit 2
        ;;
esac
if [ -n "${SNAPSHOT_PREFIX//[a-z0-9-]/}" ]; then
    echo "error: snapshot prefix contains unsupported characters (got '$SNAPSHOT_PREFIX')" >&2
    exit 2
fi

if ! REPO="$(cd "$REPO_INPUT" && pwd -P)"; then
    echo "error: could not resolve source repository '$REPO_INPUT'" >&2
    exit 1
fi
if ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "error: source snapshot requires a Git working tree ($REPO)" >&2
    exit 1
fi
if git -C "$REPO" ls-files --stage |
    awk '$1 == "160000" { found = 1 } END { exit !found }'; then
    echo "error: tracked source snapshots do not support submodules" >&2
    exit 1
fi

SNAPSHOT="$(mktemp -d "/var/tmp/${SNAPSHOT_PREFIX}.XXXXXX")"
cleanup() {
    rm -rf -- "$SNAPSHOT"
}
trap cleanup EXIT

(
    cd "$REPO"
    git ls-files -z --cached |
        while IFS= read -r -d '' path; do
            if [ -e "$path" ] || [ -L "$path" ]; then
                printf '%s\0' "$path"
            fi
        done |
        tar -c --null --verbatim-files-from --no-recursion -T - -f -
) | tar -x -C "$SNAPSHOT" -f -

SNAPSHOT="$(cd "$SNAPSHOT" && pwd -P)"
trap - EXIT
printf '%s\n' "$SNAPSHOT"
