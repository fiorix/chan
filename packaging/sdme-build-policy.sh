#!/usr/bin/env bash
# Shared resource policy for sdme containers that build chan.

# Provisional: 44G is the smallest cap demonstrated to finish the larger gate
# workload. It is not an LTO-inclusive peak for the Nix desktop build; replace
# this one value after that host measurement completes.
SDME_BUILD_DISK="${SDME_BUILD_DISK:-44G}"
readonly SDME_BUILD_DISK

# A value exported by the caller wins over a measured default. Empty fields
# have no measured default yet, so the driver names the gap and passes no limit.
# The four existing --disk drivers use their own value, else SDME_BUILD_DISK;
# an exported empty per-driver disk value still takes that fallback. Gateway
# disk limits remain absent until each builder has a successful measurement.
# Decimal CPU values such as 0.5 follow sdme's --cpus grammar.
# shellcheck disable=SC2034  # selected by name in sdme_build_limits
SDME_BUILD_AUR_CPUS="${SDME_BUILD_AUR_CPUS:-}"
SDME_BUILD_AUR_MEMORY="${SDME_BUILD_AUR_MEMORY:-}"
SDME_BUILD_AUR_DISK="${SDME_BUILD_AUR_DISK:-$SDME_BUILD_DISK}"
SDME_BUILD_AUR_JOBS="${SDME_BUILD_AUR_JOBS:-}"
SDME_BUILD_AUR_TIMEOUT="${SDME_BUILD_AUR_TIMEOUT:-}"
SDME_BUILD_COPR_CPUS="${SDME_BUILD_COPR_CPUS:-}"
SDME_BUILD_COPR_MEMORY="${SDME_BUILD_COPR_MEMORY:-}"
SDME_BUILD_COPR_DISK="${SDME_BUILD_COPR_DISK:-$SDME_BUILD_DISK}"
SDME_BUILD_COPR_JOBS="${SDME_BUILD_COPR_JOBS:-}"
SDME_BUILD_COPR_TIMEOUT="${SDME_BUILD_COPR_TIMEOUT:-}"
SDME_BUILD_NIX_CPUS="${SDME_BUILD_NIX_CPUS:-}"
SDME_BUILD_NIX_MEMORY="${SDME_BUILD_NIX_MEMORY:-}"
SDME_BUILD_NIX_DISK="${SDME_BUILD_NIX_DISK:-$SDME_BUILD_DISK}"
SDME_BUILD_NIX_JOBS="${SDME_BUILD_NIX_JOBS:-}"
SDME_BUILD_NIX_TIMEOUT="${SDME_BUILD_NIX_TIMEOUT:-}"
SDME_BUILD_DESKTOP_CPUS="${SDME_BUILD_DESKTOP_CPUS:-}"
SDME_BUILD_DESKTOP_MEMORY="${SDME_BUILD_DESKTOP_MEMORY:-}"
SDME_BUILD_DESKTOP_DISK="${SDME_BUILD_DESKTOP_DISK:-$SDME_BUILD_DISK}"
SDME_BUILD_DESKTOP_JOBS="${SDME_BUILD_DESKTOP_JOBS:-}"
SDME_BUILD_DESKTOP_TIMEOUT="${SDME_BUILD_DESKTOP_TIMEOUT:-}"
SDME_BUILD_GATEWAY_CPUS="${SDME_BUILD_GATEWAY_CPUS:-}"
SDME_BUILD_GATEWAY_MEMORY="${SDME_BUILD_GATEWAY_MEMORY:-}"
SDME_BUILD_GATEWAY_DISK="${SDME_BUILD_GATEWAY_DISK:-}"
SDME_BUILD_GATEWAY_JOBS="${SDME_BUILD_GATEWAY_JOBS:-}"
SDME_BUILD_GATEWAY_TIMEOUT="${SDME_BUILD_GATEWAY_TIMEOUT:-}"
SDME_BUILD_E2E_BINS_CPUS="${SDME_BUILD_E2E_BINS_CPUS:-}"
SDME_BUILD_E2E_BINS_MEMORY="${SDME_BUILD_E2E_BINS_MEMORY:-}"
SDME_BUILD_E2E_BINS_DISK="${SDME_BUILD_E2E_BINS_DISK:-}"
SDME_BUILD_E2E_BINS_JOBS="${SDME_BUILD_E2E_BINS_JOBS:-}"
SDME_BUILD_E2E_BINS_TIMEOUT="${SDME_BUILD_E2E_BINS_TIMEOUT:-}"

sdme_build_limits() {
    local key="$1" kind name value
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
                    echo "error: $name must be a positive M or G limit" >&2
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
