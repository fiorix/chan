#!/usr/bin/env bash
# Proves publish-homebrew.sh's push against a local bare repository standing
# in for fiorix/homebrew-tap, with a second clone standing in for the tap's
# own update workflow:
#
#   1. a commit to Casks/minitile.rb lands after the publisher's clone: the
#      push rebases over it and lands on top, minitile untouched;
#   2. the same definitions again: nothing to push, no new commit;
#   3. a hand edit to Formula/chan.rb lands after the clone: the rebase stops,
#      the step fails naming the file, and the tap's main does not move.
#
# The bare repository refuses non-fast-forward pushes, so a forced push fails
# the test instead of passing it. Needs git, ssh-keygen and base64; the key
# is a throwaway made here. Exits 1 on the first failed assertion.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
publish="$here/publish-homebrew.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

# The caller's git configuration (signing, hooks, a default branch) stays out.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$work/gitconfig"
: > "$GIT_CONFIG_GLOBAL"
bot=(-c user.name=github-actions -c user.email=bot@example.invalid)

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

ssh-keygen -q -t ed25519 -N '' -C throwaway -f "$work/key"
TAP_SSH_KEY_B64="$(base64 < "$work/key" | tr -d '\n')"
export TAP_SSH_KEY_B64

bare="$work/tap.git"
git init -q --bare -b main "$bare"
git -C "$bare" config receive.denyNonFastForwards true
git init -q -b main "$work/seed"
mkdir -p "$work/seed/Casks"
printf 'cask "minitile" do\n  version "0.1.0"\nend\n' > "$work/seed/Casks/minitile.rb"
printf '# fiorix/homebrew-tap\n' > "$work/seed/README.md"
git -C "$work/seed" add -A
git -C "$work/seed" "${bot[@]}" commit -q -m "Add minitile"
git -C "$work/seed" push -q "$bare" main

render() {
    local dir="$1" version="$2"
    mkdir -p "$dir/Casks" "$dir/Formula"
    printf 'cask "chan-desktop" do\n  version "%s"\nend\n' "$version" > "$dir/Casks/chan-desktop.rb"
    printf 'class Chan < Formula\n  url "https://example.invalid/download/v%s/chan.tar.gz"\nend\n' "$version" > "$dir/Formula/chan.rb"
}

run_publish() {
    local clone="$1" generated="$2" version="$3"
    set +e
    HOMEBREW_TAP_REMOTE="$bare" HOMEBREW_TAP_CLONE="$clone" RELEASE_TAG="v$version" \
        "$publish" push "$generated" > "$work/out" 2>&1
    status=$?
    set -e
}

# 1. The tap's own workflow commits after the publisher cloned.
git clone -q "$bare" "$work/a"
git clone -q "$bare" "$work/b"
printf 'cask "minitile" do\n  version "0.2.0"\nend\n' > "$work/b/Casks/minitile.rb"
git -C "$work/b" "${bot[@]}" commit -q -am "Update minitile to 0.2.0"
git -C "$work/b" push -q origin main
bot_commit="$(git -C "$work/b" rev-parse HEAD)"
render "$work/gen1" 1.2.3
run_publish "$work/a" "$work/gen1" 1.2.3
[ "$status" -eq 0 ] || fail "case 1: exit $status, want 0: $(cat "$work/out")"
grep -q 'rebasing onto its main' "$work/out" || fail "case 1: the first push was not rejected, so nothing was raced: $(cat "$work/out")"
tip="$(git -C "$bare" rev-parse main)"
[ "$(git -C "$bare" log -1 --format=%s "$tip")" = "chan-desktop 1.2.3, chan 1.2.3" ] \
    || fail "case 1: the tap's main is not the chan commit"
[ "$(git -C "$bare" rev-parse "$tip^")" = "$bot_commit" ] \
    || fail "case 1: the chan commit does not sit on the bot's commit"
[ "$(git -C "$bare" diff-tree --no-commit-id --name-only -r "$tip" | paste -sd ' ' -)" = "Casks/chan-desktop.rb Formula/chan.rb" ] \
    || fail "case 1: the chan commit touches more than the two chan files"
git -C "$bare" show "main:Casks/minitile.rb" | cmp -s - "$work/b/Casks/minitile.rb" \
    || fail "case 1: Casks/minitile.rb differs from the bot's"
git -C "$bare" show "main:Casks/chan-desktop.rb" | cmp -s - "$work/gen1/Casks/chan-desktop.rb" \
    || fail "case 1: Casks/chan-desktop.rb is not the rendered one"
git -C "$bare" show "main:Formula/chan.rb" | cmp -s - "$work/gen1/Formula/chan.rb" \
    || fail "case 1: Formula/chan.rb is not the rendered one"
echo "PASS case 1: the push rebased over the tap's own commit"

# 2. The same definitions again.
run_publish "$work/a" "$work/gen1" 1.2.3
[ "$status" -eq 0 ] || fail "case 2: exit $status, want 0: $(cat "$work/out")"
grep -q 'nothing to push' "$work/out" || fail "case 2: no 'nothing to push': $(cat "$work/out")"
[ "$(git -C "$bare" rev-parse main)" = "$tip" ] || fail "case 2: the tap's main moved"
echo "PASS case 2: an unchanged tap gets no commit"

# 3. A hand edit to a chan file lands after the publisher cloned.
git clone -q "$bare" "$work/c"
git -C "$work/b" pull -q --rebase origin main
printf 'class Chan < Formula\n  url "https://example.invalid/edited-by-hand/chan.tar.gz"\nend\n' > "$work/b/Formula/chan.rb"
git -C "$work/b" "${bot[@]}" commit -q -am "Edit chan by hand"
git -C "$work/b" push -q origin main
edited="$(git -C "$bare" rev-parse main)"
render "$work/gen2" 1.2.4
run_publish "$work/c" "$work/gen2" 1.2.4
[ "$status" -eq 1 ] || fail "case 3: exit $status, want 1: $(cat "$work/out")"
grep -q 'stopped on Formula/chan.rb' "$work/out" || fail "case 3: the failure does not name Formula/chan.rb: $(cat "$work/out")"
[ "$(git -C "$bare" rev-parse main)" = "$edited" ] || fail "case 3: the tap's main moved"
echo "PASS case 3: a hand-edited chan file stops the push and names the file"
