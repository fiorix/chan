#!/usr/bin/env bash
# The AUR publication steps the publish-downstream workflow runs for each
# pkgbase, after its recipe was rendered and validated.
#
# Usage: publish-aur.sh report <generated dir>
#        publish-aur.sh push <generated dir>
#        publish-aur.sh verify
#
# Every mode reads PKGBASE, RELEASE_TAG, and AUR_PKGREL. `report` also reads
# PUBLISH, PUSHABLE, and CANONICAL; `push` reads AUR_SSH_KEY and writes
# pre-push-version to $GITHUB_OUTPUT; `verify` reads PRE_PUSH_VERSION and
# optionally AUR_VERIFY_BUDGET (seconds, default 600). <generated dir> holds
# the rendered PKGBUILD and .SRCINFO.

set -euo pipefail

mode="${1:?usage: publish-aur.sh report|push <generated dir> | verify}"
pkgbase="${PKGBASE:?PKGBASE must be set}"
release_tag="${RELEASE_TAG:?RELEASE_TAG must name the GA tag}"
pkgrel="${AUR_PKGREL:?AUR_PKGREL must be set}"
version="${release_tag#v}"

# aur-auth fails the whole AUR chain on a rejected key, so an unusable
# credential here means the secret is absent. That is the fork contract, but
# on the canonical repository a publish=false dispatch exists to prove the
# credential before the tag, and one that proves nothing must not end green.
# A publish=true run keeps the documented no-op: it is reporting an outcome,
# not standing in for the proof.
report() {
    local generated="$1"
    echo "Validated $pkgbase metadata for ${release_tag}-${pkgrel} and pushed nothing."
    echo "publish=${PUBLISH:-} credential-usable=${PUSHABLE:-}"
    cat "$generated/.SRCINFO"
    if [ "${PUBLISH:-}" != "true" ] && [ "${PUSHABLE:-}" != "true" ] && [ "${CANONICAL:-}" = "true" ]; then
        echo "::error::AUR_SSH_PRIVATE_KEY is absent on the canonical repository; the metadata validated but the AUR credential is unproven."
        exit 1
    fi
}

push() {
    local generated="$1" work clone pre_push pkgver pkgrel_seen epoch
    work="$(mktemp -d)"
    # The key file lives only as long as this push. The trap fires after this
    # function's locals are gone, so it carries the path itself.
    # shellcheck disable=SC2064 # expand $work now, not at exit
    trap "rm -rf -- '$work'" EXIT
    printf '%s\n' "${AUR_SSH_KEY:?AUR_SSH_KEY must be set}" > "$work/aur-key"
    chmod 600 "$work/aur-key"
    cat > "$work/aur-known-hosts" <<'EOF'
aur.archlinux.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEuBKrPzbawxA/k2g6NcyV5jmqwJ2s+zpgZGZ7tpLIcN
EOF
    export GIT_SSH_COMMAND="ssh -i $work/aur-key -o IdentitiesOnly=yes -o UserKnownHostsFile=$work/aur-known-hosts -o StrictHostKeyChecking=yes"
    clone="$work/aur"
    git clone "ssh://aur@aur.archlinux.org/$pkgbase.git" "$clone"
    git -C "$clone" config user.name "Alexandre Fiori"
    git -C "$clone" config user.email "fiorix@gmail.com"
    # The clone is the pre-push ground truth: the version the AUR had on
    # master before this run touched it, or nothing for a pkgbase that has
    # never been pushed. The verify step tolerates the RPC index reporting a
    # version at or below it (a not-yet-caught-up index) and reds on anything
    # else.
    pre_push=""
    if [ -f "$clone/.SRCINFO" ]; then
        pkgver="$(sed -n 's/^[[:space:]]*pkgver = //p' "$clone/.SRCINFO" | head -n1)"
        pkgrel_seen="$(sed -n 's/^[[:space:]]*pkgrel = //p' "$clone/.SRCINFO" | head -n1)"
        epoch="$(sed -n 's/^[[:space:]]*epoch = //p' "$clone/.SRCINFO" | head -n1)"
        if [ -n "$pkgver" ] && [ -n "$pkgrel_seen" ]; then
            pre_push="${epoch:+$epoch:}$pkgver-$pkgrel_seen"
        fi
    fi
    echo "pre-push-version=$pre_push" >> "${GITHUB_OUTPUT:-/dev/null}"
    cp "$generated/PKGBUILD" "$generated/.SRCINFO" "$clone/"
    git -C "$clone" add PKGBUILD .SRCINFO
    if git -C "$clone" diff --cached --quiet; then
        echo "$pkgbase is already at $version-$pkgrel; nothing to push."
        return 0
    fi
    git -C "$clone" commit -m "upgpkg: $pkgbase $version-$pkgrel"
    git -C "$clone" push origin HEAD:master
}

# The push step is the publication: a zero exit from `git push` means the AUR
# accepted the ref, and the AUR's own hooks reject a malformed .SRCINFO at
# push time. The RPC index is a separate, asynchronously populated projection
# with no freshness guarantee, so this poll is advisory: an index that never
# catches up inside the budget ends in a warning, not a red. The one red left
# is the index affirmatively reporting a version that is neither the pushed
# one nor at or below the pre-push master state, which means the recipe the
# AUR serves does not correspond to this release.
verify() {
    local expected rpc_url budget delay reported payload count stale newest
    expected="$version-$pkgrel"
    rpc_url="https://aur.archlinux.org/rpc/v5/info/$pkgbase"
    budget="${AUR_VERIFY_BUDGET:-600}"
    delay=10
    reported=""
    while :; do
        payload="$(curl -fsSL --retry 3 "$rpc_url" || true)"
        count="$(jq -r '.resultcount // empty' <<<"$payload" 2>/dev/null || true)"
        if [ "$count" = "1" ]; then
            reported="$(jq -r '.results[0].Version // empty' <<<"$payload")"
            if [ "$reported" = "$expected" ]; then
                echo "$pkgbase $expected is visible in the AUR after ${SECONDS}s."
                return 0
            fi
            if [ -n "$reported" ]; then
                stale=false
                if [ -n "${PRE_PUSH_VERSION:-}" ]; then
                    newest="$(printf '%s\n%s\n' "$reported" "$PRE_PUSH_VERSION" | sort -V | tail -n1)"
                    if [ "$newest" = "$PRE_PUSH_VERSION" ]; then
                        stale=true
                    fi
                fi
                if [ "$stale" != "true" ]; then
                    echo "::error::the AUR reports $pkgbase $reported, which is neither the pushed $expected nor at or below the pre-push ${PRE_PUSH_VERSION:-state of a new pkgbase}; the recipe the AUR serves does not match this release"
                    exit 1
                fi
                echo "the AUR still reports $pkgbase $reported (pre-push state); waiting for $expected"
            fi
        fi
        if [ "$SECONDS" -ge "$budget" ]; then
            break
        fi
        sleep "$delay"
        delay=$((delay * 2))
        if [ "$delay" -gt 60 ]; then
            delay=60
        fi
    done
    echo "::warning::$pkgbase $expected was pushed but the AUR RPC index reports ${reported:-no result} after ${SECONDS}s; the push is authoritative and the index advisory, check $rpc_url by hand"
    {
        echo "### AUR $pkgbase: pushed, index confirmation timed out"
        echo
        echo "The recipe was pushed. The RPC index did not report $expected within ${SECONDS}s (last seen: ${reported:-no result}). Manual check: $rpc_url"
    } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

case "$mode" in
    report) report "${2:?usage: publish-aur.sh report <generated dir>}" ;;
    push) push "${2:?usage: publish-aur.sh push <generated dir>}" ;;
    verify) verify ;;
    *) echo "error: unknown mode '$mode' (expected report, push, or verify)" >&2; exit 2 ;;
esac
