#!/usr/bin/env bash
# The Homebrew publication step the publish-downstream workflow runs after
# homebrew-validate rendered, audited and installed both definitions.
#
# Usage: publish-homebrew.sh push <generated dir>
#
# Reads RELEASE_TAG and TAP_SSH_KEY_B64 (base64, one line, of the private
# half of the write deploy key on fiorix/homebrew-tap). <generated dir> holds
# Casks/chan-desktop.rb and Formula/chan.rb. HOMEBREW_TAP_REMOTE names a
# remote other than the tap and HOMEBREW_TAP_CLONE an existing clone to reuse
# instead of cloning; both exist for test-publish-homebrew.sh, and the
# workflow sets neither.
#
# The tap's own update workflow commits to the same branch (Casks/minitile.rb
# only), so a push can meet a commit that landed after the clone. A rejected
# push is fetched and rebased onto the tap's main and tried again, up to five
# attempts. This step writes only the two chan files, so a rebase that stops
# means someone edited them in the tap by hand; it is aborted and the step
# fails naming the path, since resolving it here would overwrite that edit.
# Nothing here forces a push or resets to the remote.

set -euo pipefail

mode="${1:?usage: publish-homebrew.sh push <generated dir>}"
release_tag="${RELEASE_TAG:?RELEASE_TAG must name the GA tag}"
version="${release_tag#v}"
remote="${HOMEBREW_TAP_REMOTE:-git@github.com:fiorix/homebrew-tap.git}"
attempts=5

push() {
    local generated="$1" work clone attempt conflict
    work="$(mktemp -d)"
    # The key file lives only as long as this push. The trap fires after this
    # function's locals are gone, so it carries the path itself.
    # shellcheck disable=SC2064 # expand $work now, not at exit
    trap "rm -rf -- '$work'" EXIT
    printf '%s' "${TAP_SSH_KEY_B64:?TAP_SSH_KEY_B64 must be set}" | base64 -d > "$work/tap-key"
    chmod 600 "$work/tap-key"
    cat > "$work/tap-known-hosts" <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
EOF
    export GIT_SSH_COMMAND="ssh -i $work/tap-key -o IdentitiesOnly=yes -o UserKnownHostsFile=$work/tap-known-hosts -o StrictHostKeyChecking=yes"
    if [ -n "${HOMEBREW_TAP_CLONE:-}" ]; then
        clone="$HOMEBREW_TAP_CLONE"
    else
        clone="$work/tap"
        git clone "$remote" "$clone"
    fi
    git -C "$clone" config user.name "Alexandre Fiori"
    git -C "$clone" config user.email "fiorix@gmail.com"
    install -D "$generated/Casks/chan-desktop.rb" "$clone/Casks/chan-desktop.rb"
    install -D "$generated/Formula/chan.rb" "$clone/Formula/chan.rb"
    git -C "$clone" add -- Casks/chan-desktop.rb Formula/chan.rb
    if git -C "$clone" diff --cached --quiet; then
        echo "the tap is already at $version; nothing to push."
        return 0
    fi
    git -C "$clone" commit -m "chan-desktop $version, chan $version"
    for attempt in $(seq 1 "$attempts"); do
        if git -C "$clone" push origin HEAD:main; then
            echo "pushed chan-desktop $version, chan $version to the tap on attempt $attempt."
            return 0
        fi
        if [ "$attempt" -eq "$attempts" ]; then
            break
        fi
        echo "the tap rejected push attempt $attempt; rebasing onto its main and trying again."
        git -C "$clone" fetch origin main
        if ! git -C "$clone" rebase origin/main; then
            conflict="$(git -C "$clone" diff --name-only --diff-filter=U | paste -sd ' ' -)"
            git -C "$clone" rebase --abort || true
            echo "::error::rebasing the chan commit onto the tap's main stopped on ${conflict:-an unmerged path}; a chan file was edited in the tap by hand, which this step does not overwrite"
            exit 1
        fi
    done
    echo "::error::the tap rejected the push $attempts times; nothing was published"
    exit 1
}

case "$mode" in
    push) push "${2:?usage: publish-homebrew.sh push <generated dir>}" ;;
    *) echo "error: unknown mode '$mode' (expected push)" >&2; exit 2 ;;
esac
