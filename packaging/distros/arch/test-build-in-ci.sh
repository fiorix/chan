#!/usr/bin/env bash
# Exercise the CI wrapper and the container builder's environment handoff with
# local stubs. No container, package manager, or Cargo build runs here.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
repo="$work/repo"
arch="$repo/packaging/distros/arch"
mkdir -p "$arch" "$work/docker-bin" "$work/builder-bin" "$work/state"
ln -s "$script_dir/build-in-ci.sh" "$arch/build-in-ci.sh"

fail() {
    echo "FAIL $*" >&2
    exit 1
}

assert_contains() {
    grep -Fq -- "$1" "$2" || fail "$3: missing $1"
}

cat > "$work/docker-bin/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${STUB_STATE:?}/docker.args"
STUB
chmod +x "$work/docker-bin/docker"

run_wrapper() {
    local name="$1"
    shift
    rm -f "$work/state/docker.args"
    env -u CARGO_BUILD_JOBS -u AUR_CARGO_JOBS \
        RELEASE_TAG=v1.2.3 AUR_PKGREL=4 PKGBASE=chan \
        STUB_STATE="$work/state" PATH="$work/docker-bin:$PATH" \
        "$@" "$arch/build-in-ci.sh" arch:test \
        > "$work/$name.log" 2>&1
}

assert_docker_args() {
    local name="$1" jobs="$2" i
    local -a args expected
    mapfile -t args < "$work/state/docker.args"
    printf '%s\n' "${args[@]}" | grep -Fxq -- "CARGO_BUILD_JOBS=$jobs" || \
        fail "$name: docker did not receive -e CARGO_BUILD_JOBS=$jobs"
    expected=(run --rm
        -e SRC=/src -e OUT=/out -e VERSION=1.2.3
        -e PKGREL=4 -e PKGBASE=chan
        -e AUR_LOCAL_SOURCE=
        -e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)"
        -e "CARGO_BUILD_JOBS=$jobs"
        -v "$repo:/src:ro"
        -v "$repo/target/aur-ci-out:/out"
        arch:test bash /src/packaging/distros/arch/build-in-container.sh)
    [ "${#args[@]}" -eq "${#expected[@]}" ] || fail "$name: docker argument count changed"
    for i in "${!expected[@]}"; do
        [ "${args[$i]}" = "${expected[$i]}" ] || \
            fail "$name: docker argument $i changed: ${args[$i]}"
    done
}

run_wrapper default || fail 'default wrapper invocation failed'
assert_docker_args default 2
run_wrapper override AUR_CARGO_JOBS=3 || fail 'override wrapper invocation failed'
assert_docker_args override 3

for invalid in 0 -2 word ''; do
    if run_wrapper invalid "AUR_CARGO_JOBS=$invalid"; then
        fail "AUR_CARGO_JOBS=$invalid was accepted"
    fi
    [ ! -e "$work/state/docker.args" ] || \
        fail "AUR_CARGO_JOBS=$invalid reached docker"
    assert_contains 'AUR_CARGO_JOBS must be a positive integer' \
        "$work/invalid.log" "AUR_CARGO_JOBS=$invalid refusal"
done
echo 'ok wrapper default, override, preserved args, and invalid values'

# The root arm needs pacman and writes system configuration. Pin its explicit
# environment handoff as source text; this does not execute that arm.
assert_contains 'AUR_LOCAL_SOURCE="${AUR_LOCAL_SOURCE:-}" "${cargo_jobs_env[@]}" bash "$0"' \
    "$script_dir/build-in-container.sh" 'root arm CARGO_BUILD_JOBS carry'
echo 'ok root arm source carries the cargo job count'

cat > "$arch/make-aur-package.sh" <<'STUB'
#!/usr/bin/env bash
mkdir -p "$4/$1"
STUB
cat > "$work/builder-bin/id" <<'STUB'
#!/usr/bin/env bash
[ "$*" = -u ] || exit 64
printf '1000\n'
STUB
cat > "$work/builder-bin/makepkg" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${CARGO_BUILD_JOBS-<unset>}" > "${STUB_STATE:?}/builder.jobs"
echo 'marker: makepkg ran' >&2
exit 47
STUB
chmod +x "$arch/make-aur-package.sh" "$work/builder-bin/id" "$work/builder-bin/makepkg"

run_builder() {
    local name="$1"
    shift
    rm -f "$work/state/builder.jobs"
    env -u CARGO_BUILD_JOBS SRC="$repo" OUT="$work/out" \
        VERSION=1.2.3 PKGREL=4 PKGBASE=chan STUB_STATE="$work/state" \
        PATH="$work/builder-bin:$PATH" "$@" \
        "$script_dir/build-in-container.sh" > "$work/$name.log" 2>&1
}

assert_builder_log() {
    local name="$1" jobs="$2" log="$work/$1.log" resource_line marker_line
    assert_contains 'CPUs=' "$log" "$name resource line"
    assert_contains 'cpu.max=' "$log" "$name resource line"
    assert_contains 'MemTotal=' "$log" "$name resource line"
    assert_contains 'MemAvailable=' "$log" "$name resource line"
    assert_contains 'memory.max=' "$log" "$name resource line"
    assert_contains "CARGO_BUILD_JOBS=$jobs" "$log" "$name resource line"
    resource_line="$(grep -n '^>> cargo resources:' "$log" | head -1)"
    resource_line="${resource_line%%:*}"
    marker_line="$(grep -n '^marker: makepkg ran$' "$log" | head -1)"
    marker_line="${marker_line%%:*}"
    [ -n "$resource_line" ] && [ -n "$marker_line" ] && \
        [ "$resource_line" -lt "$marker_line" ] || \
        fail "$name: the resource line did not precede makepkg"
}

if run_builder set CARGO_BUILD_JOBS=2; then
    fail 'builder stub marker exit was lost with CARGO_BUILD_JOBS set'
else
    status=$?
    [ "$status" -eq 47 ] || fail "builder returned $status instead of marker 47"
fi
assert_builder_log set 2
[ "$(cat "$work/state/builder.jobs")" = 2 ] || \
    fail 'builder did not carry CARGO_BUILD_JOBS=2 into makepkg'

if run_builder unset; then
    fail 'builder stub marker exit was lost with CARGO_BUILD_JOBS unset'
else
    status=$?
    [ "$status" -eq 47 ] || fail "builder returned $status instead of marker 47"
fi
assert_builder_log unset 'unset (cargo default)'
[ "$(cat "$work/state/builder.jobs")" = '<unset>' ] || \
    fail 'builder supplied CARGO_BUILD_JOBS when the caller left it unset'
echo 'ok builder resource line, environment carry, and unset default'
