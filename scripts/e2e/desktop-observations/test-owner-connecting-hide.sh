#!/usr/bin/env bash
# Path admission through the real driver and lib.sh with inert dependencies.
# The admitted call stops at CHAN_BIN --version: it proves entry into the
# reading's preparation, not a native reading. No desktop or display starts.
set -euo pipefail
umask 077

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
driver="$here/owner-connecting-hide.sh"
# A short, unique root keeps boundary cases independent of the caller's TMPDIR.
scratch=$(mktemp -d /tmp/hide-path.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
mkdir "$scratch/bin"
export HIDE_TEST_CALLS="$scratch/calls"
export HIDE_TEST_ADMITTED="$scratch/admitted"
cat > "$scratch/bin/stub" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${0##*/} == chan && $# == 1 && $1 == --version ]]; then
    printf '%s\n' "$XDG_RUNTIME_DIR" > "$HIDE_TEST_ADMITTED"
    printf 'fixture: reached version check before display\n' >&2
    exit 73
fi
printf '%s %s\n' "${0##*/}" "$*" >> "$HIDE_TEST_CALLS"
printf 'fixture: unexpected command %s\n' "${0##*/}" >&2
exit 99
STUB
chmod +x "$scratch/bin/stub"
for tool in Xvfb openbox xdotool xprop import python3 curl node setsid chan chan-desktop; do
    ln -s stub "$scratch/bin/$tool"
done
export CHAN_BIN="$scratch/bin/chan" CHAN_DESKTOP_BIN="$scratch/bin/chan-desktop"

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

run_driver() {
    local label=$1 output=$2
    status=0
    PATH="$scratch/bin:$PATH" timeout -k 2s 10s bash "$driver" "$output" > "$scratch/$label.log" 2> "$scratch/$label.stderr" || status=$?
    printf '%s: status=%s path=%s\n' "$label" "$status" "$output"
    cat "$scratch/$label.log" "$scratch/$label.stderr"
    [[ ! -e $HIDE_TEST_CALLS ]] || fail "unexpected dependency invocation: $(cat "$HIDE_TEST_CALLS")"
}

assert_limit() {
    local label=$1 length=$2
    grep -Fxq "owner-hide: cannot run: the output parent's path is too long for the control socket under it: at most 44 bytes, this one has $length" "$scratch/$label.stderr" || fail "$label did not name the limit and actual byte length on stderr"
}

# Run both calls before asserting: leftovers from the first call can change
# the second status. Record those leftovers separately.
long="$scratch/absent/an-output-parent-whose-path-is-far-too-long"
[[ ! -e $scratch/absent && ! -L $scratch/absent ]] || fail 'overlong parent is not fresh'
run_driver long-first "$long"
first_status=$status
first_leftover=0
[[ ! -e $scratch/absent && ! -L $scratch/absent ]] || first_leftover=1
run_driver long-second "$long"
second_status=$status
second_leftover=0
[[ ! -e $scratch/absent && ! -L $scratch/absent ]] || second_leftover=1
printf 'long leftovers: first=%s second=%s\n' "$first_leftover" "$second_leftover"
[[ $second_status == 2 ]] || fail "second overlong call expected status 2, got $second_status"
[[ $first_status == 2 ]] || fail "first overlong call expected status 2, got $first_status"
assert_limit long-first "${#long}"
assert_limit long-second "${#long}"
[[ $first_leftover == 0 && $second_leftover == 0 ]] || fail 'overlong refusal created output or an intermediate directory'

cd "$scratch"
run_driver relative relative-output
[[ $status == 3 && ! -e relative-output ]] || fail 'relative path was not refused without creation'
mkdir existing
printf 'keep\n' > existing/marker
run_driver existing "$scratch/existing"
[[ $status == 3 && $(cat existing/marker) == keep ]] || fail 'existing directory was not preserved with status 3'
[[ $(find existing -mindepth 1 -print) == existing/marker ]] || fail 'existing directory was changed'

padding=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
usable="$scratch/${padding:0:$((44 - ${#scratch} - 1))}"
over="${usable}x"
[[ ${#usable} == 44 && ${#over} == 45 ]] || fail 'incorrect boundary fixture lengths'
run_driver boundary-45 "$over"
[[ $status == 2 && ! -e $over && ! -L $over ]] || fail '45-byte path was not refused before creation'
assert_limit boundary-45 45
[[ ! -e $HIDE_TEST_ADMITTED ]] || fail 'a refused path reached preparation'

# One two-byte character makes this 44-character path exceed the byte budget.
multibyte="${usable%?}"$'\303\251'
[[ $(LC_ALL=C.UTF-8 locale charmap) == UTF-8 ]] || fail 'UTF-8 locale unavailable'
(LC_ALL=C.UTF-8; [[ ${#multibyte} == 44 ]]) || fail 'multibyte fixture is not 44 characters'
(LC_ALL=C; [[ ${#multibyte} == 45 ]]) || fail 'multibyte fixture is not 45 bytes'
for test_locale in C.UTF-8 C; do
    LC_ALL="$test_locale" run_driver "multibyte-$test_locale" "$multibyte"
    [[ $status == 2 && ! -e $multibyte && ! -L $multibyte ]] || fail "$test_locale 45-byte multibyte path was not refused before creation"
    assert_limit "multibyte-$test_locale" 45
    [[ ! -e $HIDE_TEST_ADMITTED ]] || fail 'a refused multibyte path reached preparation'
done

run_driver boundary-44 "$usable"
[[ $status == 3 && -f $HIDE_TEST_ADMITTED ]] || fail '44-byte path did not reach the version marker'
grep -Fxq 'fixture: reached version check before display' "$scratch/boundary-44.stderr" || fail 'missing preparation marker'
runtime=$(cat "$HIDE_TEST_ADMITTED")
[[ $runtime == "$usable"/chan-owner-hide.??????/run && -d $runtime ]] || fail 'runtime directory is not the shape the driver predicts'
((${#runtime} + 36 <= 107)) || fail 'admitted runtime directory exceeds the socket budget'
printf 'admitted runtime length=%s socket suffix=36 limit=107\n' "${#runtime}"
printf 'PASS: owner-connecting-hide path admission; no native reading\n'
