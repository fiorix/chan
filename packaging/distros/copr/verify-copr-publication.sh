#!/usr/bin/env bash
# Confirm a COPR webhook build actually published, at the released version.
#
# The COPR trigger jobs in publish-downstream.yml POST custom webhooks and
# record when each package was submitted. Their matching verify jobs run this
# probe to confirm that a build ran, every chroot succeeded, and the built
# version is the released tag. The SCM packages carry an empty committish and
# rebuild main's HEAD, so main stays frozen until both packages are confirmed.
#
# This probe reads the unauthenticated COPR API (no secret) for the build the
# webhook created and ends nonzero unless every chroot succeeded at the
# released version. Outcomes, following the PPA dry-run precedent:
#
#   - every chroot succeeded at the expected version           -> green
#   - a chroot failed or was cancelled                         -> red (named)
#   - the built version is not the released tag                -> red (freeze)
#   - the budget expired with the build unfinished/absent      -> red, worded
#     as publication UNCONFIRMED rather than failed
#   - COPR_WEBHOOK absent on the canonical repository          -> red
#     (a green no-op on forks)
#
# The 7200s budget is 1.57x the worst normal total measured across v0.89.0 to
# v0.99.0 (4577s for chan-desktop) and covers v0.82.0's 6058s slow build.
# Exceptional slow builds may outlast 7200s and expire as UNCONFIRMED; the
# package's separate verify job can be re-run after COPR finishes. The budget
# bounds this polling attempt only: main remains frozen until both packages are
# confirmed.
#
# It reports the chroot set it observed but does not assert it: the enabled
# chroots and the EL9 desktop denylist are console-only state, so the human
# check in the release skill stays.
#
# Env:
#   PACKAGE            required, chan|chan-desktop
#   RELEASE_TAG        required, e.g. v0.74.0 (the provenance target)
#   WEBHOOK_PRESENT    1 when the webhook was POSTed, 0/empty when absent
#   CANONICAL          "true" on fiorix/chan; controls the webhook-absent verdict
#   POSTED_AT          epoch seconds of the webhook POST; builds at/after it are
#                      candidates. Defaults to 0 (any build) when unset.
#   COPR_OWNER         default fiorix
#   COPR_PROJECT       default chan
#   COPR_API_BASE      default https://copr.fedorainfracloud.org/api_3
#   COPR_POLL_INTERVAL default 30 (seconds between polls)
#   COPR_POLL_BUDGET   default 7200 (seconds; see arithmetic above)
#
# Flags: -v/--verbose streams each poll's state to stderr.
#
# Run: packaging/distros/copr/verify-copr-publication.sh

set -euo pipefail

VERBOSE=0
for arg in "$@"; do
    case "$arg" in
        -v | --verbose) VERBOSE=1 ;;
        *)
            echo "verify-copr-publication.sh: unknown argument $arg" >&2
            exit 2
            ;;
    esac
done

PACKAGE="${PACKAGE:?PACKAGE is required}"
RELEASE_TAG="${RELEASE_TAG:?RELEASE_TAG is required}"
WEBHOOK_PRESENT="${WEBHOOK_PRESENT:-0}"
CANONICAL="${CANONICAL:-false}"
POSTED_AT="${POSTED_AT:-0}"
[ -n "$POSTED_AT" ] || POSTED_AT=0
COPR_OWNER="${COPR_OWNER:-fiorix}"
COPR_PROJECT="${COPR_PROJECT:-chan}"
COPR_API_BASE="${COPR_API_BASE:-https://copr.fedorainfracloud.org/api_3}"
COPR_POLL_INTERVAL="${COPR_POLL_INTERVAL:-30}"
COPR_POLL_BUDGET="${COPR_POLL_BUDGET:-7200}"

# The tag is the upstream version; COPR stamps source_package.version as
# <upstream>-<rpmrelease>, so provenance compares the upstream half only.
EXPECTED_VERSION="${RELEASE_TAG#v}"

log() { [ "$VERBOSE" = 1 ] && echo "verify-copr[$PACKAGE]: $*" >&2 || true; }

api() {
    # api <path-with-query>; JSON to stdout, empty on transport failure.
    curl -fsSL --retry 3 --max-time 60 "$COPR_API_BASE/$1" 2>/dev/null || true
}

# The webhook-absent branch never polls: there is no build to confirm.
if [ "$WEBHOOK_PRESENT" != 1 ]; then
    if [ "$CANONICAL" = true ]; then
        echo "::error::COPR_WEBHOOK is absent on the canonical repository; the $PACKAGE build was never triggered and its publication is unproven."
        exit 1
    fi
    echo "COPR_WEBHOOK is absent on a fork; there is nothing to verify."
    exit 0
fi

upstream_of() {
    # Strip the trailing -<rpmrelease> from a COPR source_package.version.
    printf '%s' "${1%-*}"
}

build_list() {
    api "build/list?ownername=$COPR_OWNER&projectname=$COPR_PROJECT&packagename=$PACKAGE&limit=50"
}

# The webhook build is the newest one submitted at or after the POST. Older
# builds (a previous release, a retry) are excluded by POSTED_AT, so a stale
# same-version build cannot be mistaken for this one.
select_build() {
    jq -c --argjson since "$POSTED_AT" \
        '[.items[]? | select((.submitted_on // 0) >= $since)]
         | sort_by(.submitted_on) | last // empty' 2>/dev/null
}

chroot_states() {
    # chroot_states <build_id>; "<name> <state>" lines.
    api "build-chroot/list?build_id=$1" |
        jq -r '.items[]? | "\(.name) \(.state)"' 2>/dev/null
}

report_green() {
    local id="$1" version="$2"
    local set
    set="$(chroot_states "$id" | awk '{print $1}' | sort | paste -sd, -)"
    echo "COPR $PACKAGE build $id succeeded at $version on every chroot: ${set:-none reported}."
}

deadline_msg() {
    local id="$1" state="$2"
    if [ -z "$id" ]; then
        echo "::error::no COPR build for $PACKAGE appeared within ${COPR_POLL_BUDGET}s of the webhook POST; its publication is UNCONFIRMED (not failed). Check https://copr.fedorainfracloud.org/coprs/$COPR_OWNER/$COPR_PROJECT/ by hand."
    else
        echo "::error::COPR build $id for $PACKAGE was still '$state' after ${COPR_POLL_BUDGET}s; its publication is UNCONFIRMED (not failed). Check https://copr.fedorainfracloud.org/coprs/$COPR_OWNER/$COPR_PROJECT/build/$id/ by hand."
    fi
}

last_id=""
last_state=""
while :; do
    build="$(build_list | select_build)"
    if [ -n "$build" ] && [ "$build" != null ]; then
        last_id="$(jq -r '.id' <<<"$build")"
        last_state="$(jq -r '.state' <<<"$build")"
        reported="$(jq -r '.source_package.version // ""' <<<"$build")"
        log "build $last_id state=$last_state version=${reported:-<none>}"

        # Provenance is a hard red the moment a version is known, whatever the
        # build state: COPR built something other than the released tag.
        if [ -n "$reported" ]; then
            reported_upstream="$(upstream_of "$reported")"
            if [ "$reported_upstream" != "$EXPECTED_VERSION" ]; then
                echo "::error::COPR built $PACKAGE $reported (build $last_id), not the released $EXPECTED_VERSION; main was not frozen between the tag push and the COPR build."
                exit 1
            fi
        fi

        case "$last_state" in
            succeeded)
                # Assert per-chroot, not just the aggregate: a green build with
                # a non-succeeded chroot would still be a defect to surface.
                failed="$(chroot_states "$last_id" | awk '$2 != "succeeded" { print }')"
                if [ -n "$failed" ]; then
                    echo "::error::COPR build $last_id for $PACKAGE reports succeeded but a chroot did not: $(echo "$failed" | paste -sd'; ' -)."
                    exit 1
                fi
                report_green "$last_id" "$reported"
                exit 0
                ;;
            failed | cancelled | canceled | skipped)
                bad="$(chroot_states "$last_id" | awk '$2 != "succeeded" { print }' | paste -sd'; ' -)"
                echo "::error::COPR build $last_id for $PACKAGE ended '$last_state'; failing chroots: ${bad:-unknown}."
                exit 1
                ;;
            *)
                log "build $last_id not terminal ($last_state); waiting"
                ;;
        esac
    else
        log "no build submitted at/after $POSTED_AT yet; waiting"
    fi

    if [ "$SECONDS" -ge "$COPR_POLL_BUDGET" ]; then
        deadline_msg "$last_id" "$last_state"
        exit 1
    fi
    sleep "$COPR_POLL_INTERVAL"
done
