#!/usr/bin/env bash
# Contract for the shared sdme build limits, without a container or package build.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy="$here/../sdme-build-policy.sh"
work="$(mktemp -d "${TMPDIR:-/var/tmp}/chan-sdme-policy.XXXXXX")"
trap 'rm -rf "$work"' EXIT
checks=0

probe() {
    local key="$1"
    shift
    status=0
    env -i PATH="$PATH" POLICY="$policy" KEY="$key" "$@" bash -c '
        set -euo pipefail
        . "$POLICY"
        sdme_build_limits "$KEY"
        sdme_build_log_limits "$KEY"
        printf "disk=%s\narg_count=%s\n" "$SDME_BUILD_LIMIT_DISK" "${#SDME_BUILD_LIMIT_ARGS[@]}"
        printf "arg=%s\n" ${SDME_BUILD_LIMIT_ARGS[@]+"${SDME_BUILD_LIMIT_ARGS[@]}"}
    ' >"$work/out" 2>"$work/err" || status=$?
}

expect_status() {
    [ "$status" -eq "$1" ] || { printf 'not ok - %s (expected %s, got %s)\n' "$2" "$1" "$status" >&2; exit 1; }
    checks=$((checks + 1))
}

expect_line() {
    grep -Fxq -- "$1" "$2" || { printf 'not ok - %s: missing %s\n' "$3" "$1" >&2; exit 1; }
    checks=$((checks + 1))
}

expect_count() {
    local actual
    actual="$(grep -Fc -- "$1" "$2" || true)"
    [ "$actual" -eq "$3" ] || { printf 'not ok - %s (expected %s, got %s)\n' "$4" "$3" "$actual" >&2; exit 1; }
    checks=$((checks + 1))
}

for key in AUR COPR NIX DESKTOP GATEWAY E2E_BINS; do
    case "$key" in
        AUR) default_memory=16G; default_timeout=9000 ;;
        COPR) default_memory=10G; default_timeout=5400 ;;
        NIX) default_memory=11G; default_timeout=3600 ;;
        DESKTOP) default_memory=7G; default_timeout=3600 ;;
        GATEWAY|E2E_BINS) default_memory=6G; default_timeout=1800 ;;
    esac
    probe "$key"
    expect_status 0 "$key defaults"
    if [[ $key == GATEWAY || $key == E2E_BINS ]]; then
        expected_gaps=1
        default_disk=absent
    else
        expected_gaps=0
        default_disk=44G
    fi
    expect_count 'has no measured default' "$work/err" "$expected_gaps" "$key gap count"
    expect_line "limits: $key cpus=2 memory=$default_memory disk=$default_disk jobs=2 timeout=$default_timeout" "$work/err" "$key default set"
    expect_line 'arg_count=4' "$work/out" "$key has CPU and memory flags"
    expect_line 'arg=--cpus' "$work/out" "$key CPU flag"
    expect_line 'arg=2' "$work/out" "$key CPU value"
    expect_line 'arg=--memory' "$work/out" "$key memory flag"
    expect_line "arg=$default_memory" "$work/out" "$key memory value"

    for kind in CPUS MEMORY JOBS TIMEOUT; do
        probe "$key" "SDME_BUILD_${key}_${kind}="
        expect_status 0 "$key cleared $kind"
        expect_line "gap: SDME_BUILD_${key}_${kind} has no measured default" "$work/err" "$key cleared $kind gap"
        expect_count 'has no measured default' "$work/err" "$((expected_gaps + 1))" "$key cleared $kind gap count"
    done

    probe "$key" SDME_BUILD_DISK=48G "SDME_BUILD_${key}_DISK="
    expect_status 0 "$key empty disk override"
    if [[ $key == GATEWAY || $key == E2E_BINS ]]; then
        expect_line "gap: SDME_BUILD_${key}_DISK has no measured default" "$work/err" "$key keeps no disk fallback"
    else
        expect_line 'disk=48G' "$work/out" "$key fallback is carried in its disk output"
        expect_line "limits: $key cpus=2 memory=$default_memory disk=48G jobs=2 timeout=$default_timeout" "$work/err" "$key global fallback"
    fi

    for spec in 'CPUS:0:2' 'CPUS:65:2' 'CPUS:1.:2' 'CPUS:.5:2' \
        'MEMORY:0G:2' 'MEMORY:1g:2' 'MEMORY:1T:2' \
        'DISK:0G:2' 'DISK:1g:2' 'DISK:1T:2' \
        'JOBS:0:2' 'JOBS:65:2' 'TIMEOUT:0:2' 'TIMEOUT:86401:2' \
        'CPUS:0.5:0' 'CPUS:64:0' 'MEMORY:1M:0' 'MEMORY:1G:0' \
        'DISK:1M:0' 'DISK:1G:0' 'JOBS:1:0' 'JOBS:64:0' \
        'TIMEOUT:1:0' 'TIMEOUT:86400:0'; do
        IFS=: read -r kind value expected <<<"$spec"
        probe "$key" "SDME_BUILD_${key}_${kind}=$value"
        expect_status "$expected" "$key $kind=$value"
        if [ "$expected" -eq 2 ]; then
            grep -Fq "SDME_BUILD_${key}_${kind}" "$work/err" || { printf 'not ok - %s %s refusal lost its source\n' "$key" "$kind" >&2; exit 1; }
        fi
    done
done

probe UNKNOWN
expect_status 2 'unknown driver'
expect_line "error: unknown sdme build driver 'UNKNOWN'" "$work/err" 'unknown driver diagnostic'

for key in AUR COPR NIX DESKTOP; do
    probe "$key" SDME_BUILD_DISK=1T
    expect_status 2 "$key rejects global disk"
    expect_line 'error: SDME_BUILD_DISK must be a positive M or G limit' "$work/err" "$key global disk source"
    probe "$key" SDME_BUILD_DISK=1T "SDME_BUILD_${key}_DISK="
    expect_status 2 "$key rejects empty disk override fallback"
    expect_line 'error: SDME_BUILD_DISK must be a positive M or G limit' "$work/err" "$key empty override source"
    probe "$key" SDME_BUILD_DISK=1T "SDME_BUILD_${key}_DISK=2G"
    expect_status 0 "$key valid override ignores malformed global disk"
done

printf 'ok - sdme build policy: %s assertions\n' "$checks"
