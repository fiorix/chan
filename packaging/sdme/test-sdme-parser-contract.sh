#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=packaging/sdme/test-sdme-parser.sh
. "$HERE/test-sdme-parser.sh"
checks=0

accept() {
    sdme_stub_parse "$@"
    checks=$((checks + 1))
}

refuse() {
    local status=0
    sdme_stub_parse "$@" >/dev/null 2>&1 || status=$?
    [ "$status" -eq 2 ] || { printf 'expected parser refusal 2, got %s: %s\n' "$status" "$*" >&2; exit 1; }
    checks=$((checks + 1))
}

refuse new --name probe -r ubuntu --storage btrfs --disk 44G timeout 1s true
refuse new --name probe -r ubuntu --storage btrfs --disk 44G --started -- true
refuse create --name probe -r ubuntu --bogus
refuse create --name probe -r ubuntu --cpus
refuse create --name probe -r ubuntu --disk 44G
accept --config /tmp/test-sdme.conf new --name probe -r ubuntu --storage btrfs --disk 44G -- true
accept new --config /tmp/test-sdme.conf --name probe -r ubuntu --storage btrfs --disk 44G -- true
accept --config /tmp/test-sdme.conf create --name probe -r ubuntu --storage btrfs --disk 44G --started
accept create --config /tmp/test-sdme.conf --name probe -r ubuntu --storage btrfs --disk 44G --started
accept exec probe timeout -s TERM -k 30s 1s true
accept exec probe -- timeout -s TERM -k 30s 1s true
accept new --name probe -r ubuntu --storage btrfs --disk 44G --cpus abc --memory 2X -- true
accept create --name probe -r ubuntu --storage btrfs --disk 44G --cpus abc --memory 2X --started
printf 'ok - sdme stand-in parser: %s probes\n' "$checks"
