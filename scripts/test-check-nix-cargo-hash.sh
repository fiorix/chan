#!/usr/bin/env bash
# Contract test for check-nix-cargo-hash.sh against a throwaway tree.
#
# The fixture is a directory, not a repository: the checker reads files and
# nothing else, and this proves it under every rule it enforces, in `check`
# and in `pin`. Nothing here needs git, and the checker copies nothing into
# the real tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/check-nix-cargo-hash.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/chan-nix-hash-contract.XXXXXX")"
TREE="$TMP/tree"
BEFORE="$TMP/before"
OUT="$TMP/out"
LOCK="Cargo.lock"
DIGEST_FILE="packaging/nix/cargo-lock.sha256"
CHAN_NIX="packaging/nix/chan.nix"
DESKTOP_NIX="packaging/nix/chan-desktop.nix"
# Distinct from lib.fakeHash's value, which the checker refuses.
HASH_A='sha256-QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF='
HASH_B='sha256-QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ='
FAKE_HASH='sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
# The npmDeps.hash of the fixture: the shape of the real one, never a value
# a case pins as cargoHash unless the case is about that slip.
NPM_HASH='sha256-TlBNTlBNTlBNTlBNTlBNTlBNTlBNTlBNTlBNTlBNTlB='
STATUS=
failures=0

cleanup() {
    rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
    echo "not ok - $*" >&2
    failures=$((failures + 1))
}

assert_status() {
    local expected="$1" message="$2"
    [ "$STATUS" -eq "$expected" ] || fail "$message (expected $expected, got $STATUS): $(cat "$OUT")"
}

assert_out() {
    local pattern="$1" message="$2"
    grep -Eq -- "$pattern" "$OUT" || fail "$message: $(cat "$OUT")"
}

assert_not_out() {
    local pattern="$1" message="$2"
    if grep -Eq -- "$pattern" "$OUT"; then
        fail "$message: $(cat "$OUT")"
    fi
}

assert_fail_lines() {
    local expected="$1" message="$2" count
    count="$(grep -c '^nix cargo hash: FAIL: ' "$OUT" || true)"
    [ "$count" -eq "$expected" ] || fail "$message (expected $expected FAIL lines, got $count): $(cat "$OUT")"
}

# The tree is byte-for-byte what snapshot_tree recorded: nothing added,
# removed or rewritten.
assert_untouched() {
    local message="$1"
    diff -r "$BEFORE" "$TREE" >/dev/null 2>&1 || fail "$message: $(diff -r "$BEFORE" "$TREE" 2>&1 | head -5)"
}

# FILE in the tree is byte-for-byte what snapshot_tree recorded.
assert_file_untouched() {
    local file="$1" message="$2"
    cmp -s "$BEFORE/$file" "$TREE/$file" || fail "$message: $(diff "$BEFORE/$file" "$TREE/$file" 2>&1 | head -5)"
}

# FILE in the tree is the snapshot with its cargoHash line at HASH.
assert_pinned() {
    local file="$1" hash="$2" message="$3"
    sed "s|^  cargoHash = [^;]*;|  cargoHash = \"$hash\";|" "$BEFORE/$file" >"$TMP/expected"
    cmp -s "$TMP/expected" "$TREE/$file" || fail "$message: $(diff "$TMP/expected" "$TREE/$file" 2>&1 | head -5)"
}

# packaging/nix holds the three files and nothing else: no temporary left
# behind by a pin.
assert_no_temporaries() {
    local message="$1" listing
    listing="$(cd "$TREE/packaging/nix" && ls | sort | tr '\n' ' ')"
    [ "$listing" = "cargo-lock.sha256 chan-desktop.nix chan.nix " ] || fail "$message: packaging/nix holds $listing"
}

# FILE in the tree has exactly the octal mode MODE.
assert_mode() {
    local file="$1" mode="$2" message="$3"
    [ -n "$(find "$TREE/$file" -perm "$mode")" ] || fail "$message: $(ls -l "$TREE/$file")"
}

# The mode a file created under the current umask gets, as find -perm
# spells it.
created_mode() {
    printf '%04o' "$((0666 & ~$(umask)))"
}

snapshot_tree() {
    rm -rf "$BEFORE"
    cp -R "$TREE" "$BEFORE"
}

# The digest line sha256sum prints for the fixture's lock.
lock_digest() {
    local out
    if command -v sha256sum >/dev/null 2>&1; then
        out="$(cd "$TREE" && sha256sum "$LOCK")"
    else
        out="$(cd "$TREE" && shasum -a 256 "$LOCK")"
    fi
    printf '%s' "${out%% *}"
}

# The shape of the real derivations around the lines the checker reads: the
# cargoHash line, and the npmDeps.hash it must never be confused with.
write_nix() {
    local file="$1" hash="$2" npm_hash="${3:-$NPM_HASH}"
    cat >"$TREE/$file" <<NIX
{ lib, rustPlatform }:
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "${file##*/}";
  # cargoHash = lib.fakeHash;
  cargoHash = $hash;
  npmDeps = fetchNpmDeps {
    name = "\${finalAttrs.pname}-npm-deps";
    hash = "$npm_hash";
  };
})
NIX
}

write_lock() {
    local crate="$1"
    printf 'version = 4\n\n[[package]]\nname = "%s"\nversion = "1.0.0"\n' "$crate" >"$TREE/$LOCK"
}

write_digest() {
    printf '%s  %s\n' "$(lock_digest)" "$LOCK" >"$TREE/$DIGEST_FILE"
}

# Run the checker from DIR (the tree by default) with the given arguments,
# under RUN_PATH when a case sets one (a hidden digest tool, a stub in front).
RUN_PATH=""
run_in() {
    local dir="$1"
    shift
    set +e
    (cd "$dir" && PATH="${RUN_PATH:-$PATH}" "$TREE/scripts/check-nix-cargo-hash.sh" "$@") >"$OUT" 2>&1
    STATUS=$?
    set -e
}

run_check() {
    run_in "$TREE" "$@"
}

# Back to the baseline: a lock, its digest, and both pins at HASH_A.
reset_fixture() {
    write_lock root-crate
    write_nix "$CHAN_NIX" "\"$HASH_A\""
    write_nix "$DESKTOP_NIX" "\"$HASH_A\""
    write_digest
}

mkdir -p "$TREE/packaging/nix" "$TREE/scripts"
ln -s "$CHECKER" "$TREE/scripts/check-nix-cargo-hash.sh"
reset_fixture

# A wrong-hash guard on the fixture itself: the values must be harvestable
# by the checker's own rule, or every placeholder case below proves nothing.
for value in "$HASH_A" "$HASH_B" "$NPM_HASH"; do
    [[ $value =~ ^sha256-[A-Za-z0-9+/]{43}=$ ]] || fail "fixture: $value is not SRI-shaped"
done

snapshot_tree
run_check
assert_status 0 "a matching digest and equal harvested pins pass"
assert_out "^nix cargo hash: PASS: $LOCK is the lock the cargoHash pins were harvested for \\(sha256 $(lock_digest | cut -c1-12)\\) and both pins carry \"$HASH_A\"\$" "the pass names the digest prefix and the pinned value"
assert_untouched "a passing check writes nothing"

run_check check
assert_status 0 "the explicit check mode passes"

run_in "$TREE/packaging" check
assert_status 0 "the check runs from a subdirectory"
assert_out "^nix cargo hash: PASS:" "the subdirectory run reports the same pass"

printf '\n' >>"$TREE/$LOCK"
snapshot_tree
run_check
assert_status 1 "a byte appended to the lock fails"
assert_fail_lines 1 "the appended byte is the only problem reported"
assert_out "^nix cargo hash: FAIL: $LOCK changed since the cargoHash pins were harvested: its digest is $(lock_digest) and $DIGEST_FILE records " "the failure names the live and recorded digests"
assert_out "make nix-sdme-check NIX_PACKAGE=chan" "the failure names the Linux harvest command"
assert_out "'make nix-check' on a Linux host with Nix installed" "the failure names the native harvest command and the host it needs"
assert_out "with the Cargo.lock you will pin in the working tree" "the failure says which tree to harvest from"
assert_out "a macOS or Windows host harvests in a Linux VM or container that has Nix, over this working tree, or asks a maintainer to" "the failure names the route for a host that runs neither harvest"
assert_out "copy the got: line of the mismatch whose derivation name ends in -vendor-staging" "the failure says which got: line is the cargo one"
assert_out "a -npm-deps mismatch is npmDeps.hash" "the failure says what the other mismatch is"
assert_out "make nix-hash-pin CARGO_HASH=sha256-" "the failure names the pin command"
assert_untouched "a failing check writes nothing"
reset_fixture

write_lock root-crate-bumped
run_check
assert_status 1 "a lock edited in place fails"
assert_out "^nix cargo hash: FAIL: $LOCK changed since the cargoHash pins were harvested" "the in-place edit is reported as a lock change"
reset_fixture

rm -f "$TREE/$LOCK"
run_check
assert_status 1 "an absent lock fails"
assert_out "^nix cargo hash: FAIL: $LOCK is absent\$" "the absent lock is named"
reset_fixture

rm -f "$TREE/$DIGEST_FILE"
run_check
assert_status 1 "an absent digest file fails"
assert_out "^nix cargo hash: FAIL: $DIGEST_FILE is absent: it records the digest of the $LOCK the cargoHash pins were harvested for" "the absent digest file is named with its purpose"
assert_out "restore it from the commit whose cargoHash pins you kept and run the check again, or harvest the value" "the absent digest file names the restore and the harvest"
assert_out "make nix-hash-pin CARGO_HASH=sha256-" "the absent digest file names the pin command"
reset_fixture

# A malformed digest file: the check cannot compare locks, so its message
# carries both repairs, the restore and the harvest.
CONFLICTED_DIGEST="$(printf '<<<<<<< HEAD\n%s  %s\n=======\n%s  %s\n>>>>>>> other\n' "$(lock_digest)" "$LOCK" "$(lock_digest | tr '0-9a-f' 'a-f0-9')" "$LOCK")"
for malformed in \
    "$(lock_digest)  gateway/$LOCK" \
    "$(lock_digest)  ./$LOCK" \
    "$(lock_digest) $LOCK" \
    "$(lock_digest | cut -c1-63)  $LOCK" \
    "$(lock_digest | tr 'a-f' 'A-F')  $LOCK" \
    "$(lock_digest)  Cargo_lock" \
    "$(lock_digest)" \
    "$CONFLICTED_DIGEST" \
    ""; do
    printf '%s\n' "$malformed" >"$TREE/$DIGEST_FILE"
    run_check
    assert_status 1 "a digest file reading '$malformed' fails"
    assert_out "^nix cargo hash: FAIL: $DIGEST_FILE is malformed: expected the one line '<64 hex>  $LOCK'" "the malformed digest file '$malformed' is named"
    assert_out "restore it from the commit whose cargoHash pins you kept and run the check again, or harvest the value" "the malformed digest file '$malformed' names the restore and the harvest"
    assert_out "make nix-hash-pin CARGO_HASH=sha256-" "the malformed digest file '$malformed' names the pin command"
done
{ printf '%s  %s\n' "$(lock_digest)" "$LOCK"; printf '%s  %s\n' "$(lock_digest)" "$LOCK"; } >"$TREE/$DIGEST_FILE"
run_check
assert_status 1 "a digest file with two lines fails"
assert_out "^nix cargo hash: FAIL: $DIGEST_FILE is malformed" "the two-line digest file is malformed"
printf '%s  %s' "$(lock_digest)" "$LOCK" >"$TREE/$DIGEST_FILE"
run_check
assert_status 0 "a digest file without a trailing newline passes"
reset_fixture

write_nix "$DESKTOP_NIX" "\"$HASH_B\""
run_check
assert_status 1 "two harvested pins that differ fail"
assert_fail_lines 1 "the differing pins are the only problem reported"
assert_out "^nix cargo hash: FAIL: cargoHash differs between $CHAN_NIX \\(\"$HASH_A\"\\) and $DESKTOP_NIX \\(\"$HASH_B\"\\); both derivations vendor the same $LOCK" "the failure shows both values and the reason they must agree"
reset_fixture

for placeholder in \
    "lib.fakeHash" \
    "lib.fakeSha256" \
    '""' \
    "\"$FAKE_HASH\"" \
    '"sha256-abc="' \
    "$HASH_A" \
    "'$HASH_A'" \
    "\"${HASH_A}\" " \
    '"sha512-QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF="' \
    "\"${HASH_A%=}\"" \
    "\"${HASH_A}=\"" \
    "\"xsha256-${HASH_A#sha256-}\""; do
    write_nix "$CHAN_NIX" "$placeholder"
    run_check
    assert_status 1 "cargoHash = $placeholder; in chan.nix fails"
    assert_fail_lines 1 "the placeholder $placeholder is the only problem reported"
    assert_out "^nix cargo hash: FAIL: cargoHash in $CHAN_NIX is .*, a placeholder or malformed value rather than a harvested one, and a Nix build rejects it" "the placeholder $placeholder is named with its file"
    assert_out "make nix-hash-pin CARGO_HASH=sha256-" "the placeholder failure names the pin command"
    reset_fixture
done

write_nix "$CHAN_NIX" "lib.fakeHash"
write_nix "$DESKTOP_NIX" "lib.fakeHash"
run_check
assert_status 1 "the placeholder in both files fails"
assert_fail_lines 2 "each file's placeholder is reported"
assert_out "^nix cargo hash: FAIL: cargoHash in $CHAN_NIX is lib.fakeHash, a placeholder" "the chan.nix placeholder is named"
assert_out "^nix cargo hash: FAIL: cargoHash in $DESKTOP_NIX is lib.fakeHash, a placeholder" "the chan-desktop.nix placeholder is named"
assert_not_out "cargoHash differs between" "equal placeholders are not also reported as differing pins"
reset_fixture

write_nix "$DESKTOP_NIX" "\"$FAKE_HASH\""
run_check
assert_status 1 "the value lib.fakeHash spells out fails in chan-desktop.nix"
assert_out "^nix cargo hash: FAIL: cargoHash in $DESKTOP_NIX is \"$FAKE_HASH\", a placeholder" "the spelled-out placeholder is named with its file"
reset_fixture

# The npmDeps.hash as cargoHash: a well-formed value the check can still
# see is wrong, because the same file pins it as the npm hash.
for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
    write_nix "$file" "\"$HASH_A\"" "$HASH_A"
    run_check
    assert_status 1 "$file with cargoHash equal to its npmDeps.hash fails"
    assert_fail_lines 1 "the npm value in $file is the only problem reported"
    assert_out "^nix cargo hash: FAIL: cargoHash in $file is \"$HASH_A\", the value its npmDeps.hash pins: a Nix build reports the -npm-deps mismatch before the -vendor-staging one, and only the got: line of the latter is the cargo value" "the npm value in $file is named with the mismatch order"
    assert_not_out "cargoHash differs between" "the npm value in $file is not also reported as a differing pin"
    reset_fixture
done

for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
    sed "/^  cargoHash = /d" "$TREE/$file" >"$TMP/edited" && cat "$TMP/edited" >"$TREE/$file"
    run_check
    assert_status 1 "$file without a cargoHash line fails"
    assert_fail_lines 1 "the missing line in $file is the only problem reported"
    assert_out "^nix cargo hash: FAIL: no cargoHash line in $file\$" "the missing line in $file is named"
    reset_fixture

    printf '  cargoHash = "%s";\n' "$HASH_A" >>"$TREE/$file"
    run_check
    assert_status 1 "$file with two cargoHash lines fails"
    assert_fail_lines 1 "the duplicated line in $file is the only problem reported"
    assert_out "^nix cargo hash: FAIL: more than one cargoHash line in $file\$" "the duplicated line in $file is named"
    reset_fixture

    write_nix "$file" "\"$HASH_A\"; cargoHash = \"$HASH_B\""
    run_check
    assert_status 1 "$file with two cargoHash attributes on one line fails"
    assert_fail_lines 1 "the second attribute on the line in $file is the only problem reported"
    assert_out "^nix cargo hash: FAIL: more than one cargoHash attribute on the cargoHash line of $file\$" "the second attribute on the line in $file is named"
    reset_fixture

    rm -f "$TREE/$file"
    run_check
    assert_status 1 "an absent $file fails"
    assert_out "^nix cargo hash: FAIL: $file is absent\$" "the absent $file is named"
    reset_fixture
done

printf '\n' >>"$TREE/$LOCK"
write_nix "$DESKTOP_NIX" "lib.fakeHash"
run_check
assert_status 1 "a changed lock over a placeholder fails"
assert_fail_lines 2 "the lock change and the placeholder are both reported"
assert_out "^nix cargo hash: FAIL: $LOCK changed since the cargoHash pins were harvested" "the lock change is reported beside the placeholder"
assert_out "^nix cargo hash: FAIL: cargoHash in $DESKTOP_NIX is lib.fakeHash" "the placeholder is reported beside the lock change"
reset_fixture

# The pin helper: a harvest's end state in one command.
write_lock root-crate-bumped
write_nix "$CHAN_NIX" "lib.fakeHash"
write_nix "$DESKTOP_NIX" "lib.fakeHash"
run_check
assert_status 1 "fixture: the mid-harvest tree fails before the pin"
snapshot_tree
run_check pin "$HASH_B"
assert_status 0 "pinning a harvested value over a mid-harvest tree succeeds"
assert_out "^nix cargo hash: pinned $HASH_B in $CHAN_NIX and $DESKTOP_NIX and recorded the $LOCK digest in $DIGEST_FILE\$" "the pin reports what it wrote"
assert_out "^nix cargo hash: PASS: $LOCK is the lock the cargoHash pins were harvested for .* and both pins carry \"$HASH_B\"\$" "the pin ends with the check's pass"
assert_not_out "^nix cargo hash: note:" "a pin over a recorded digest prints no bootstrap note"
for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
    sed "s|^  cargoHash = lib.fakeHash;\$|  cargoHash = \"$HASH_B\";|" "$BEFORE/$file" >"$TMP/expected"
    cmp -s "$TMP/expected" "$TREE/$file" || fail "the pin rewrote only the cargoHash line of $file: $(diff "$TMP/expected" "$TREE/$file")"
done
cmp -s "$BEFORE/$LOCK" "$TREE/$LOCK" || fail "the pin left the lock alone"
[ "$(cat "$TREE/$DIGEST_FILE")" = "$(lock_digest)  $LOCK" ] || fail "the pin recorded the live lock digest in sha256sum format: $(cat "$TREE/$DIGEST_FILE")"
assert_no_temporaries "the pin left no temporary file"
run_check
assert_status 0 "the pinned tree passes the check"
run_check pin "$HASH_B"
assert_status 0 "pinning the pinned value again succeeds"
run_check
assert_status 0 "the tree passes after the repeated pin"
reset_fixture

# The pin keeps each file's mode: the temporaries are copies of the
# originals, not fresh private files.
write_lock root-crate-bumped
chmod 640 "$TREE/$CHAN_NIX" "$TREE/$DIGEST_FILE"
run_check pin "$HASH_B"
assert_status 0 "the pin over files at mode 640 succeeds"
assert_mode "$CHAN_NIX" 0640 "the pin kept the mode of $CHAN_NIX"
assert_mode "$DIGEST_FILE" 0640 "the pin kept the mode of $DIGEST_FILE"
chmod "=rw" "$TREE/$CHAN_NIX" "$TREE/$DIGEST_FILE"
reset_fixture

# The stale pin. A Nix build prints the value both files carry as
# `specified:` beside the harvested `got:`, and copying the wrong line pins
# a value harvested for another lock: refused, with nothing written. The
# refusal needs both files at the value and a digest file that names another
# lock, or one that names no lock at all because it is malformed; a value
# one file carries is not that slip, and an absent digest file is the
# bootstrap case.
write_lock root-crate-bumped
snapshot_tree
run_check pin "$HASH_A"
assert_status 1 "re-pinning the value both files carry over a changed lock is refused"
assert_out "^nix cargo hash: FAIL: '$HASH_A' is the value both $CHAN_NIX and $DESKTOP_NIX pin, harvested for a $LOCK that is not the live one \\(live digest $(lock_digest), $DIGEST_FILE records [0-9a-f]{64}\\): a Nix build prints that stale pin as 'specified:' beside the harvested value as 'got:', so copy the got: line of the -vendor-staging mismatch; if both files were edited by hand to the harvested value, or an earlier pin stopped before it recorded the digest, set both to lib.fakeHash and pin again; nothing was written\$" "the refusal names the specified: slip, the got: line to copy, and both ways out"
assert_untouched "the refused stale re-pin left every file as it was"
run_check pin "$HASH_B"
assert_status 0 "a value that differs from the stale pin is accepted over the changed lock"
reset_fixture

for stale_in in "$CHAN_NIX" "$DESKTOP_NIX"; do
    write_lock root-crate-bumped
    write_nix "$stale_in" "lib.fakeHash"
    run_check pin "$HASH_A"
    assert_status 0 "the value one file carries beside a placeholder in $stale_in is not the stale pin"
    reset_fixture
done

for malformed in "not a digest line" "$CONFLICTED_DIGEST"; do
    write_lock root-crate-bumped
    printf '%s\n' "$malformed" >"$TREE/$DIGEST_FILE"
    snapshot_tree
    run_check pin "$HASH_A"
    assert_status 1 "re-pinning the value both files carry over a digest file reading '$malformed' is refused"
    assert_out "^nix cargo hash: FAIL: '$HASH_A' is the value both $CHAN_NIX and $DESKTOP_NIX pin, and $DIGEST_FILE is malformed \\(expected the one line '<64 hex>  $LOCK'\\), so the pins cannot be matched to the live $LOCK: restore the digest file from the commit whose pins you kept \\(for example 'git checkout <rev> -- $DIGEST_FILE'\\) and run the check, or harvest the value with " "the refusal over '$malformed' names the restore and the harvest"
    assert_out "copy the got: line of the mismatch whose derivation name ends in -vendor-staging.*; nothing was written\$" "the refusal over '$malformed' says which got: line to copy and that nothing was written"
    assert_untouched "the refused re-pin over '$malformed' left every file as it was"
    run_check pin "$HASH_B"
    assert_status 0 "a fresh value pins over a digest file reading '$malformed'"
    [ "$(cat "$TREE/$DIGEST_FILE")" = "$(lock_digest)  $LOCK" ] || fail "the pin over '$malformed' recorded the live digest: $(cat "$TREE/$DIGEST_FILE")"
    run_check
    assert_status 0 "the tree passes after the pin over '$malformed'"
    reset_fixture
done

write_lock root-crate-bumped
rm -f "$TREE/$DIGEST_FILE"
run_check pin "$HASH_A"
assert_status 0 "an absent digest file is the bootstrap case: the value both files carry pins"
assert_out "^nix cargo hash: note: $DIGEST_FILE is absent, so '$HASH_A', which both files already pin, is recorded as harvested for the live $LOCK without a stale-pin check\. If $LOCK changed since those pins were harvested, the value is stale: restore the digest file with 'git checkout <rev> -- $DIGEST_FILE' instead\$" "the bootstrap pin says the stale-pin check did not run and how to restore its evidence"
[ "$(cat "$TREE/$DIGEST_FILE")" = "$(lock_digest)  $LOCK" ] || fail "the bootstrap pin recorded the live digest: $(cat "$TREE/$DIGEST_FILE")"
assert_mode "$DIGEST_FILE" "$(created_mode)" "the created digest file has the mode a fresh file gets under this umask, not mktemp's private one"
run_check
assert_status 0 "the tree passes after the bootstrap pin"
reset_fixture

write_lock root-crate-bumped
run_in "$TREE/packaging" pin "$HASH_B"
assert_status 0 "the pin runs from a subdirectory"
run_check
assert_status 0 "the subdirectory pin leaves a passing tree"
reset_fixture

rm -f "$TREE/$DIGEST_FILE"
run_check pin "$HASH_B"
assert_status 0 "the pin creates an absent digest file"
assert_not_out "^nix cargo hash: note:" "a fresh value over an absent digest file is not the bootstrap slip"
[ "$(cat "$TREE/$DIGEST_FILE")" = "$(lock_digest)  $LOCK" ] || fail "the created digest file carries the live digest: $(cat "$TREE/$DIGEST_FILE")"
reset_fixture

# The npmDeps.hash offered as the cargo value: refused, whichever file pins
# it, with nothing written.
for npm_in in "$CHAN_NIX" "$DESKTOP_NIX"; do
    write_lock root-crate-bumped
    write_nix "$npm_in" "\"$HASH_A\"" "$HASH_B"
    snapshot_tree
    run_check pin "$HASH_B"
    assert_status 1 "the npmDeps.hash of $npm_in is refused as the cargo value"
    assert_out "^nix cargo hash: FAIL: '$HASH_B' is the npmDeps.hash pinned in $npm_in: a Nix build reports the -npm-deps mismatch before the -vendor-staging one, and only the got: line of the latter is the cargo value, so build again with npmDeps.hash re-pinned and copy that line; nothing was written\$" "the refusal of the npm value in $npm_in names the mismatch order"
    assert_untouched "the refused npm value over $npm_in left every file as it was"
    reset_fixture
done

# A second attribute on the cargoHash line: the value ends at the first `;`,
# and the pin replaces that value alone.
write_nix "$CHAN_NIX" "\"$HASH_A\"; # cargoHash = lib.fakeHash; to re-harvest"
run_check
assert_status 0 "a trailing comment that mentions cargoHash is not a second attribute"
write_lock root-crate-bumped
snapshot_tree
run_check pin "$HASH_B"
assert_status 0 "the pin accepts a trailing comment that mentions cargoHash"
assert_pinned "$CHAN_NIX" "$HASH_B" "the pin kept the trailing cargoHash comment in $CHAN_NIX"
run_check
assert_status 0 "the tree with the trailing cargoHash comment passes after the pin"
reset_fixture

write_nix "$CHAN_NIX" "\"$HASH_A\"; doCheck = false"
run_check
assert_status 0 "a second attribute after the cargoHash value is not a malformed pin"
assert_out "both pins carry \"$HASH_A\"\$" "the value before the first ; is the pin"
write_lock root-crate-bumped
write_nix "$DESKTOP_NIX" "lib.fakeHash; doCheck = false"
snapshot_tree
run_check pin "$HASH_B"
assert_status 0 "the pin over lines with a second attribute succeeds"
for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
    sed "s|^  cargoHash = .*; doCheck = false;\$|  cargoHash = \"$HASH_B\"; doCheck = false;|" "$BEFORE/$file" >"$TMP/expected"
    cmp -s "$TMP/expected" "$TREE/$file" || fail "the pin kept the second attribute on the cargoHash line of $file: $(diff "$TMP/expected" "$TREE/$file")"
done
run_check
assert_status 0 "the tree with second attributes passes after the pin"
reset_fixture

# A third-position cargoHash attribute is a duplicate even when another
# attribute follows the value first.
for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
    write_nix "$file" "\"$HASH_A\"; doCheck = false; cargoHash = \"$HASH_B\""
    run_check
    assert_status 1 "$file with a third-position cargoHash attribute fails"
    assert_fail_lines 1 "the third-position cargoHash attribute in $file is the only problem reported"
    assert_out "^nix cargo hash: FAIL: more than one cargoHash attribute on the cargoHash line of $file\$" "the third-position cargoHash attribute in $file is named"
    snapshot_tree
    run_check pin "$HASH_B"
    assert_status 1 "the pin refuses a third-position cargoHash attribute in $file"
    assert_out "^nix cargo hash: FAIL: more than one cargoHash attribute on the cargoHash line of $file; nothing was written\$" "the pin refusal names the third-position cargoHash attribute in $file"
    assert_untouched "the refused pin over a third-position cargoHash attribute in $file left every file as it was"
    reset_fixture
done

# A cargoHash value that is neither a quoted string nor a lib.* placeholder:
# the check reports it as malformed, and the pin refuses to replace it,
# because replacing everything before the `;` would leave Nix that does not
# parse. Two attributes on the one line are refused as a duplicate.
for file in "$CHAN_NIX" "$DESKTOP_NIX"; do
    for layout in \
        "/* harvested; see README */ \"$HASH_A\"" \
        "if true then \"$HASH_A\" else \"a;b\"" \
        "\"$HASH_A\" /* got: */" \
        "/* \"x\" ; */ \"$HASH_A\""; do
        write_lock root-crate-bumped
        write_nix "$file" "$layout"
        run_check
        assert_status 1 "fixture: cargoHash = $layout; in $file fails the check"
        assert_out "^nix cargo hash: FAIL: cargoHash in $file is .*, a placeholder or malformed value" "cargoHash = $layout; in $file is reported as malformed"
        snapshot_tree
        run_check pin "$HASH_B"
        assert_status 1 "the pin refuses to replace cargoHash = $layout; in $file"
        assert_out "^nix cargo hash: FAIL: cargoHash in $file is .*, neither a quoted value nor a lib\\.\\* placeholder, so the pin cannot replace it: set the line to 'cargoHash = lib\\.fakeHash;' and pin again; nothing was written\$" "the refusal of cargoHash = $layout; in $file names the repair"
        assert_untouched "the refused pin over cargoHash = $layout; in $file left every file as it was"
        reset_fixture
    done
done
write_lock root-crate-bumped
write_nix "$CHAN_NIX" "\"$HASH_A\"; cargoHash = \"$HASH_A\""
snapshot_tree
run_check pin "$HASH_B"
assert_status 1 "the pin refuses a line with two cargoHash attributes"
assert_out "^nix cargo hash: FAIL: more than one cargoHash attribute on the cargoHash line of $CHAN_NIX; nothing was written\$" "the refusal names the second attribute on the line"
assert_untouched "the refused pin over two attributes on one line left every file as it was"
reset_fixture

# A write failure leaves both originals, the digest file, and no temporary
# file behind. The helper renders both files and the digest line to
# temporaries beside the originals and only then renames them into place,
# so the failure is injected through the tools it calls, which works as
# root (a permission would not) and on every host: a cp that refuses the
# second file, with one temporary rendered; a cp and a mktemp that refuse
# the digest, with both .nix temporaries rendered; and an mv that refuses
# the first rename, with all three.
STUB_CP="$TMP/stub-cp"
STUB_CP_DIGEST="$TMP/stub-cp-digest"
STUB_MKTEMP_DIGEST="$TMP/stub-mktemp-digest"
STUB_MV="$TMP/stub-mv"
STUB_MV_DESKTOP="$TMP/stub-mv-desktop"
STUB_MV_DIGEST="$TMP/stub-mv-digest"
mkdir -p "$STUB_CP" "$STUB_CP_DIGEST" "$STUB_MKTEMP_DIGEST" "$STUB_MV" "$STUB_MV_DESKTOP" "$STUB_MV_DIGEST"
REAL_CP="$(command -v cp)"
REAL_MKTEMP="$(command -v mktemp)"
REAL_MV="$(command -v mv)"
# A stub of TOOL at DIR that refuses when its arguments mention NAME and
# otherwise runs the real REAL.
write_stub() {
    local dir="$1" tool="$2" name="$3" real="$4"
    cat >"$dir/$tool" <<STUB
#!/usr/bin/env bash
case "\$*" in *$name*) echo "$tool: stub refusal: \$*" >&2; exit 1 ;; esac
exec "$real" "\$@"
STUB
    chmod +x "$dir/$tool"
}
write_stub "$STUB_CP" cp chan-desktop.nix "$REAL_CP"
write_stub "$STUB_CP_DIGEST" cp cargo-lock.sha256 "$REAL_CP"
write_stub "$STUB_MKTEMP_DIGEST" mktemp cargo-lock.sha256 "$REAL_MKTEMP"
write_stub "$STUB_MV_DESKTOP" mv chan-desktop.nix "$REAL_MV"
write_stub "$STUB_MV_DIGEST" mv cargo-lock.sha256 "$REAL_MV"
printf '#!/usr/bin/env bash\necho "mv: stub refusal: $*" >&2\nexit 1\n' >"$STUB_MV/mv"
chmod +x "$STUB_MV/mv"
write_lock root-crate-bumped
snapshot_tree
RUN_PATH="$STUB_CP:$PATH"
run_check pin "$HASH_B"
RUN_PATH=""
assert_status 1 "a failure rendering the second file fails the pin"
assert_out "^nix cargo hash: FAIL: cannot copy $DESKTOP_NIX to $DESKTOP_NIX\\.[A-Za-z0-9]+; nothing was written\$" "the failed render says nothing was written"
assert_untouched "the failed render left both originals and no temporary file"
RUN_PATH="$STUB_CP_DIGEST:$PATH"
run_check pin "$HASH_B"
RUN_PATH=""
assert_status 1 "a failure copying the digest file fails the pin"
assert_out "^nix cargo hash: FAIL: cannot copy $DIGEST_FILE to $DIGEST_FILE\\.[A-Za-z0-9]+; nothing was written\$" "the failed digest copy says nothing was written"
assert_untouched "the failed digest copy left every original and no temporary file"
RUN_PATH="$STUB_MKTEMP_DIGEST:$PATH"
run_check pin "$HASH_B"
RUN_PATH=""
assert_status 1 "a failure creating the digest temporary fails the pin before any rename"
assert_out "^nix cargo hash: FAIL: cannot create a temporary file beside $DIGEST_FILE; nothing was written\$" "the failed digest temporary says nothing was written"
assert_untouched "the failed digest temporary left every original and no temporary file"
RUN_PATH="$STUB_MV:$PATH"
run_check pin "$HASH_B"
RUN_PATH=""
assert_status 1 "a failure renaming the first file fails the pin"
assert_out "^nix cargo hash: FAIL: cannot replace $CHAN_NIX; nothing was written\$" "the failed rename says nothing was written"
assert_untouched "the failed rename left both originals and no temporary file"
reset_fixture

# A failed second rename is the one partial state: chan.nix pinned, the
# other two files as they were, no temporary, and the message says to pin
# again, which then succeeds because the two pins differ.
write_lock root-crate-bumped
snapshot_tree
RUN_PATH="$STUB_MV_DESKTOP:$PATH"
run_check pin "$HASH_B"
RUN_PATH=""
assert_status 1 "a failure renaming the second file fails the pin"
assert_out "^nix cargo hash: FAIL: cannot replace $DESKTOP_NIX: $CHAN_NIX is pinned and $DESKTOP_NIX is not, so pin again\$" "the failed second rename names the partial state and the repair"
assert_pinned "$CHAN_NIX" "$HASH_B" "the failed second rename left $CHAN_NIX pinned"
assert_file_untouched "$DESKTOP_NIX" "the failed second rename left $DESKTOP_NIX as it was"
assert_file_untouched "$DIGEST_FILE" "the failed second rename left $DIGEST_FILE as it was"
assert_no_temporaries "the failed second rename left no temporary file"
run_check
assert_status 1 "the tree fails after the failed second rename"
assert_out "^nix cargo hash: FAIL: $LOCK changed since the cargoHash pins were harvested" "the partial state fails on the lock"
assert_out "^nix cargo hash: FAIL: cargoHash differs between" "the partial state fails on the differing pins"
run_check pin "$HASH_B"
assert_status 0 "pinning again after the failed second rename succeeds"
run_check
assert_status 0 "the tree passes after the repeated pin"
reset_fixture

# A failed digest rename: both files pinned, the digest as it was, no
# temporary, and the message names the line to write by hand, after which
# the tree passes.
write_lock root-crate-bumped
snapshot_tree
RUN_PATH="$STUB_MV_DIGEST:$PATH"
run_check pin "$HASH_B"
RUN_PATH=""
assert_status 1 "a failure renaming the digest file fails the pin"
assert_out "^nix cargo hash: FAIL: cannot replace $DIGEST_FILE: both files are pinned and the $LOCK digest is not recorded, so write the line '$(lock_digest)  $LOCK' to $DIGEST_FILE by hand and run the check\$" "the failed digest rename names the partial state and the line to write"
assert_pinned "$CHAN_NIX" "$HASH_B" "the failed digest rename left $CHAN_NIX pinned"
assert_pinned "$DESKTOP_NIX" "$HASH_B" "the failed digest rename left $DESKTOP_NIX pinned"
assert_file_untouched "$DIGEST_FILE" "the failed digest rename left $DIGEST_FILE as it was"
assert_no_temporaries "the failed digest rename left no temporary file"
run_check
assert_status 1 "the tree fails after the failed digest rename"
assert_out "^nix cargo hash: FAIL: $LOCK changed since the cargoHash pins were harvested" "the partial state fails on the lock"
write_digest
run_check
assert_status 0 "the tree passes once the digest line is written by hand"
reset_fixture

# Every refusal leaves the tree as it was, digest file included.
write_lock root-crate-bumped
snapshot_tree
for refused in \
    "lib.fakeHash" \
    "" \
    "$FAKE_HASH" \
    "\"$HASH_B\"" \
    "sha256-abc=" \
    "${HASH_B%=}" \
    "$HASH_B=" \
    "x$HASH_B" \
    "sha512-QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUF="; do
    run_check pin "$refused"
    assert_status 1 "the pin refuses '$refused'"
    assert_out "^nix cargo hash: FAIL: '.*' is not a harvested cargoHash value: expected the bare SRI form a Nix build reports as got:.*; nothing was written\$" "the refusal of '$refused' says what a value looks like and that nothing was written"
    assert_untouched "the refused pin of '$refused' left every file as it was"
done
run_check pin
assert_status 2 "the pin without a value is a usage error"
assert_untouched "the pin without a value wrote nothing"
run_check pin "$HASH_B" "$HASH_B"
assert_status 2 "the pin with two values is a usage error"
assert_untouched "the pin with two values wrote nothing"
reset_fixture

write_lock root-crate-bumped
printf '  cargoHash = "%s";\n' "$HASH_A" >>"$TREE/$CHAN_NIX"
snapshot_tree
run_check pin "$HASH_B"
assert_status 1 "the pin refuses a file with two cargoHash lines"
assert_out "^nix cargo hash: FAIL: more than one cargoHash line in $CHAN_NIX; nothing was written\$" "the refusal names the duplicated line"
assert_untouched "the refused pin over a duplicated line left every file as it was"
reset_fixture

write_lock root-crate-bumped
sed "/^  cargoHash = /d" "$TREE/$DESKTOP_NIX" >"$TMP/edited" && cat "$TMP/edited" >"$TREE/$DESKTOP_NIX"
snapshot_tree
run_check pin "$HASH_B"
assert_status 1 "the pin refuses a file without a cargoHash line"
assert_out "^nix cargo hash: FAIL: no cargoHash line in $DESKTOP_NIX; nothing was written\$" "the refusal names the missing line"
assert_untouched "the refused pin over a missing line left every file as it was, chan.nix included"
reset_fixture

rm -f "$TREE/$LOCK"
snapshot_tree
run_check pin "$HASH_B"
assert_status 1 "the pin refuses when the lock is absent"
assert_out "^nix cargo hash: FAIL: $LOCK is absent; nothing was written\$" "the refusal names the absent lock"
assert_untouched "the refused pin without a lock left every file as it was"
reset_fixture

# The digest tools. A PATH holding only the commands the checker runs, minus
# sha256sum, exercises the shasum fallback on a host that has both; minus
# shasum as well, the checker refuses before it writes.
NOSUM="$TMP/nosum"
NOTOOL="$TMP/notool"
mkdir -p "$NOSUM" "$NOTOOL"
for tool in bash dirname cat sed mktemp cp mv rm chmod; do
    ln -s "$(command -v "$tool")" "$NOSUM/$tool"
    ln -s "$(command -v "$tool")" "$NOTOOL/$tool"
done
if command -v shasum >/dev/null 2>&1; then
    ln -s "$(command -v shasum)" "$NOSUM/shasum"
    RUN_PATH="$NOSUM"
    run_check
    assert_status 0 "the check digests through shasum when sha256sum is not on PATH"
    assert_out "^nix cargo hash: PASS: $LOCK is the lock the cargoHash pins were harvested for \\(sha256 $(lock_digest | cut -c1-12)\\)" "shasum gives the digest sha256sum recorded"
    write_lock root-crate-bumped
    run_check pin "$HASH_B"
    assert_status 0 "the pin digests through shasum when sha256sum is not on PATH"
    [ "$(cat "$TREE/$DIGEST_FILE")" = "$(lock_digest)  $LOCK" ] || fail "the shasum pin recorded the digest sha256sum computes: $(cat "$TREE/$DIGEST_FILE")"
    RUN_PATH=""
    reset_fixture
else
    echo "skip - shasum is not on PATH, so the shasum fallback is not exercised" >&2
fi
snapshot_tree
RUN_PATH="$NOTOOL"
run_check
assert_status 1 "the check fails without sha256sum or shasum"
assert_out "^nix cargo hash: FAIL: need sha256sum or shasum on PATH to digest $LOCK\$" "the missing digest tool is named"
run_check pin "$HASH_B"
assert_status 1 "the pin fails without sha256sum or shasum"
assert_out "^nix cargo hash: FAIL: need sha256sum or shasum on PATH to digest $LOCK\$" "the pin names the missing digest tool"
assert_untouched "the pin without a digest tool wrote nothing"
RUN_PATH=""

snapshot_tree
run_check bogus
assert_status 2 "an unknown mode is a usage error"
assert_out "^usage: " "the unknown mode prints the usage"
assert_untouched "the usage error wrote nothing"
run_check check extra
assert_status 2 "check with an argument is a usage error"
assert_untouched "the check usage error wrote nothing"

if [ "$failures" -ne 0 ]; then
    echo "FAIL: $failures contract assertion(s) failed" >&2
    exit 1
fi
echo "ok - scripts/check-nix-cargo-hash.sh contract"
