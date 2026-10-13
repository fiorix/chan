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
    probe "$key"
    expect_status 0 "$key unconfigured"
    if [[ $key == GATEWAY || $key == E2E_BINS ]]; then
        expect_count 'has no measured default' "$work/err" 5 "$key gap count"
        expect_line "limits: $key cpus=absent memory=absent disk=absent jobs=absent timeout=absent" "$work/err" "$key absent set"
    else
        expect_count 'has no measured default' "$work/err" 4 "$key gap count"
        expect_line "limits: $key cpus=absent memory=absent disk=44G jobs=absent timeout=absent" "$work/err" "$key fallback set"
    fi
    expect_line 'arg_count=0' "$work/out" "$key has no CPU or memory flag"

    probe "$key" SDME_BUILD_DISK=48G "SDME_BUILD_${key}_DISK="
    expect_status 0 "$key empty disk override"
    if [[ $key == GATEWAY || $key == E2E_BINS ]]; then
        expect_line "gap: SDME_BUILD_${key}_DISK has no measured default" "$work/err" "$key keeps no disk fallback"
    else
        expect_line 'disk=48G' "$work/out" "$key fallback is carried in its disk output"
        expect_line "limits: $key cpus=absent memory=absent disk=48G jobs=absent timeout=absent" "$work/err" "$key global fallback"
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
