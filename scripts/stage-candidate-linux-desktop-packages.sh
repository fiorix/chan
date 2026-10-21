#!/usr/bin/env bash
# Stage the diagnostic Linux packages from one Tauri bundle directory.
set -euo pipefail

if [ "$#" -ne 2 ]; then
    printf 'usage: %s BUNDLE_DIR STAGE_DIR\n' "$0" >&2
    exit 2
fi

bundle_dir=$1
stage_dir=$2
shopt -s nullglob

for format in rpm deb; do
    files=("$bundle_dir/$format/"*."$format")
    if [ "${#files[@]}" -ne 1 ] || [ ! -f "${files[0]:-}" ]; then
        printf 'candidate desktop packages: expected exactly one %s in %s (found %s)\n' \
            "$format" "$bundle_dir/$format" "${#files[@]}" >&2
        exit 1
    fi
done

if [ -e "$stage_dir" ] && [ -n "$(find "$stage_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    printf 'candidate desktop packages: stage directory is not empty: %s\n' "$stage_dir" >&2
    exit 1
fi

mkdir -p "$stage_dir"
cp -- "$bundle_dir/rpm/"*.rpm "$bundle_dir/deb/"*.deb "$stage_dir/"
