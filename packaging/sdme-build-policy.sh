#!/usr/bin/env bash
# Shared resource policy for sdme containers that build chan.

# The four drivers with a disk fallback keep 44G. Their measured referenced
# peaks are below 6G, so this cap leaves space beyond those builds.
SDME_BUILD_DISK="${SDME_BUILD_DISK:-44G}"
readonly SDME_BUILD_DISK

# An exported value wins over a measured default. An exported empty CPU,
# memory, jobs or timeout value clears that default and names the gap.
# The four existing --disk drivers use their own value, else SDME_BUILD_DISK;
# an exported empty per-driver disk value still takes that fallback. Gateway
# disk limits remain absent because no disk default was ruled for them.
# Decimal CPU values such as 0.5 follow sdme's --cpus grammar.
# AUR: at 2 CPUs, 6842 CPU seconds in 4103 wall seconds sets 2 CPUs/jobs.
# The 8G cap was met with 6.13 GiB swap; ceil(8+6.13)+1G is 16G.
# Twice the measured wall, rounded up to 1800 seconds, is 9000 seconds.
# shellcheck disable=SC2034  # selected by name in sdme_build_limits
SDME_BUILD_AUR_CPUS="${SDME_BUILD_AUR_CPUS-2}"
SDME_BUILD_AUR_MEMORY="${SDME_BUILD_AUR_MEMORY-16G}"
SDME_BUILD_AUR_DISK_SOURCE=SDME_BUILD_AUR_DISK
# shellcheck disable=SC2034  # selected by name when validating the fallback
[ -n "${SDME_BUILD_AUR_DISK:-}" ] || SDME_BUILD_AUR_DISK_SOURCE=SDME_BUILD_DISK
SDME_BUILD_AUR_DISK="${SDME_BUILD_AUR_DISK:-$SDME_BUILD_DISK}"
SDME_BUILD_AUR_JOBS="${SDME_BUILD_AUR_JOBS-2}"
SDME_BUILD_AUR_TIMEOUT="${SDME_BUILD_AUR_TIMEOUT-9000}"
# COPR: three targets at 2 CPUs used 3840 CPU seconds in 2543 wall seconds.
# The el10 desktop target met 8G with 0.62 GiB swap; ceil(8+0.62)+1G is 10G.
# Twice the targets' summed wall, rounded up to 1800 seconds, is 5400 seconds.
SDME_BUILD_COPR_CPUS="${SDME_BUILD_COPR_CPUS-2}"
SDME_BUILD_COPR_MEMORY="${SDME_BUILD_COPR_MEMORY-10G}"
SDME_BUILD_COPR_DISK_SOURCE=SDME_BUILD_COPR_DISK
# shellcheck disable=SC2034  # selected by name when validating the fallback
[ -n "${SDME_BUILD_COPR_DISK:-}" ] || SDME_BUILD_COPR_DISK_SOURCE=SDME_BUILD_DISK
SDME_BUILD_COPR_DISK="${SDME_BUILD_COPR_DISK:-$SDME_BUILD_DISK}"
SDME_BUILD_COPR_JOBS="${SDME_BUILD_COPR_JOBS-2}"
SDME_BUILD_COPR_TIMEOUT="${SDME_BUILD_COPR_TIMEOUT-5400}"
# NIX: at 2 CPUs, 2173 CPU seconds in 1367 wall seconds sets 2 CPUs/jobs.
# The 8G cap was met with 1.17 GiB swap; ceil(8+1.17)+1G is 11G.
# Twice the measured wall, rounded up to 1800 seconds, is 3600 seconds.
SDME_BUILD_NIX_CPUS="${SDME_BUILD_NIX_CPUS-2}"
SDME_BUILD_NIX_MEMORY="${SDME_BUILD_NIX_MEMORY-11G}"
SDME_BUILD_NIX_DISK_SOURCE=SDME_BUILD_NIX_DISK
# shellcheck disable=SC2034  # selected by name when validating the fallback
[ -n "${SDME_BUILD_NIX_DISK:-}" ] || SDME_BUILD_NIX_DISK_SOURCE=SDME_BUILD_DISK
SDME_BUILD_NIX_DISK="${SDME_BUILD_NIX_DISK:-$SDME_BUILD_DISK}"
SDME_BUILD_NIX_JOBS="${SDME_BUILD_NIX_JOBS-2}"
SDME_BUILD_NIX_TIMEOUT="${SDME_BUILD_NIX_TIMEOUT-3600}"
# DESKTOP: at 2 CPUs, 1941 CPU seconds in 1200 wall seconds sets 2 CPUs/jobs.
# Peak 4.07 GiB plus 1.26 GiB swap, rounded up with 1G margin, gives 7G.
# Twice the measured wall, rounded up to 1800 seconds, is 3600 seconds.
SDME_BUILD_DESKTOP_CPUS="${SDME_BUILD_DESKTOP_CPUS-2}"
SDME_BUILD_DESKTOP_MEMORY="${SDME_BUILD_DESKTOP_MEMORY-7G}"
SDME_BUILD_DESKTOP_DISK_SOURCE=SDME_BUILD_DESKTOP_DISK
# shellcheck disable=SC2034  # selected by name when validating the fallback
[ -n "${SDME_BUILD_DESKTOP_DISK:-}" ] || SDME_BUILD_DESKTOP_DISK_SOURCE=SDME_BUILD_DISK
SDME_BUILD_DESKTOP_DISK="${SDME_BUILD_DESKTOP_DISK:-$SDME_BUILD_DISK}"
SDME_BUILD_DESKTOP_JOBS="${SDME_BUILD_DESKTOP_JOBS-2}"
SDME_BUILD_DESKTOP_TIMEOUT="${SDME_BUILD_DESKTOP_TIMEOUT-3600}"
# GATEWAY: at 2 CPUs, 431 CPU seconds in 274 wall seconds sets 2 CPUs/jobs.
# Peak 4.51 GiB plus 0.15 GiB swap, rounded up with 1G margin, gives 6G.
# Twice the measured wall, rounded up to 1800 seconds, is 1800 seconds.
SDME_BUILD_GATEWAY_CPUS="${SDME_BUILD_GATEWAY_CPUS-2}"
SDME_BUILD_GATEWAY_MEMORY="${SDME_BUILD_GATEWAY_MEMORY-6G}"
SDME_BUILD_GATEWAY_DISK="${SDME_BUILD_GATEWAY_DISK:-}"
SDME_BUILD_GATEWAY_JOBS="${SDME_BUILD_GATEWAY_JOBS-2}"
SDME_BUILD_GATEWAY_TIMEOUT="${SDME_BUILD_GATEWAY_TIMEOUT-1800}"
# E2E_BINS: at 2 CPUs, 888 CPU seconds in 558 wall seconds sets 2 CPUs/jobs.
# Peak 3.80 GiB plus 0.50 GiB swap, rounded up with 1G margin, gives 6G.
# Twice the measured wall, rounded up to 1800 seconds, is 1800 seconds.
SDME_BUILD_E2E_BINS_CPUS="${SDME_BUILD_E2E_BINS_CPUS-2}"
SDME_BUILD_E2E_BINS_MEMORY="${SDME_BUILD_E2E_BINS_MEMORY-6G}"
SDME_BUILD_E2E_BINS_DISK="${SDME_BUILD_E2E_BINS_DISK:-}"
SDME_BUILD_E2E_BINS_JOBS="${SDME_BUILD_E2E_BINS_JOBS-2}"
SDME_BUILD_E2E_BINS_TIMEOUT="${SDME_BUILD_E2E_BINS_TIMEOUT-1800}"

sdme_build_limits() {
    local key="$1" kind name value source
    case "$key" in
        AUR|COPR|NIX|DESKTOP|GATEWAY|E2E_BINS) ;;
        *) echo "error: unknown sdme build driver '$key'" >&2; return 2 ;;
    esac

    for kind in CPUS MEMORY DISK JOBS TIMEOUT; do
        name="SDME_BUILD_${key}_${kind}"
        value="${!name-}"
        if [ -z "$value" ]; then
            echo "gap: $name has no measured default" >&2
            continue
        fi
        case "$kind" in
            CPUS)
                if [[ ! $value =~ ^[0-9]+([.][0-9]+)?$ ]] ||
                    ! awk -v v="$value" 'BEGIN { exit !(v + 0 > 0 && v + 0 <= 64) }'; then
                    echo "error: $name must be a positive decimal CPU limit at most 64" >&2
                    return 2
                fi
                ;;
            MEMORY|DISK)
                if [[ ! $value =~ ^[1-9][0-9]*[MG]$ ]]; then
                    source="$name"
                    if [ "$kind" = DISK ]; then
                        local disk_source="${name}_SOURCE"
                        source="${!disk_source:-$name}"
                    fi
                    echo "error: $source must be a positive M or G limit" >&2
                    return 2
                fi
                ;;
            JOBS)
                if [[ ! $value =~ ^[1-9][0-9]{0,5}$ ]] || (( 10#$value > 64 )); then
                    echo "error: $name must be an integer from 1 to 64" >&2
                    return 2
                fi
                ;;
            TIMEOUT)
                if [[ ! $value =~ ^[1-9][0-9]{0,5}$ ]] || (( 10#$value > 86400 )); then
                    echo "error: $name must be an integer from 1 to 86400 seconds" >&2
                    return 2
                fi
                ;;
        esac
    done

    SDME_BUILD_LIMIT_ARGS=()
    local key_cpus="SDME_BUILD_${key}_CPUS"
    local key_memory="SDME_BUILD_${key}_MEMORY"
    local key_disk="SDME_BUILD_${key}_DISK"
    local key_jobs="SDME_BUILD_${key}_JOBS"
    local key_timeout="SDME_BUILD_${key}_TIMEOUT"
    SDME_BUILD_LIMIT_DISK="${!key_disk}"
    # shellcheck disable=SC2034  # output consumed by sourcing drivers
    SDME_BUILD_LIMIT_JOBS="${!key_jobs}"
    # shellcheck disable=SC2034  # output consumed by sourcing drivers
    SDME_BUILD_LIMIT_TIMEOUT="${!key_timeout}"
    [ -z "${!key_cpus}" ] || SDME_BUILD_LIMIT_ARGS+=(--cpus "${!key_cpus}")
    [ -z "${!key_memory}" ] || SDME_BUILD_LIMIT_ARGS+=(--memory "${!key_memory}")
    if [[ $key == GATEWAY || $key == E2E_BINS ]] && [ -n "$SDME_BUILD_LIMIT_DISK" ]; then
        SDME_BUILD_LIMIT_ARGS+=(--disk "$SDME_BUILD_LIMIT_DISK")
    fi
}

sdme_build_log_limits() {
    local key="$1" kind name value label line
    line="limits: $key"
    for kind in CPUS MEMORY DISK JOBS TIMEOUT; do
        name="SDME_BUILD_${key}_${kind}"
        value="${!name:-absent}"
        case "$kind" in
            CPUS) label='cpus' ;;
            MEMORY) label='memory' ;;
            DISK) label='disk' ;;
            JOBS) label='jobs' ;;
            TIMEOUT) label='timeout' ;;
        esac
        line="${line} ${label}=$value"
    done
    printf '%s\n' "$line" >&2
}
