#!/usr/bin/env bash
# Check verify-copr-publication.sh's control flow against recorded COPR API
# fixtures, one per outcome, so every verdict branch is proven reachable
# without a live publication (which lands only at a GA tag push).
#
# The probe reaches the COPR API only through `curl`, so a stub curl on PATH
# stands in for the unauthenticated endpoints. It routes by URL: a
# `build/list` request returns a per-call fixture (so a build can be observed
# running and then succeeded across polls), and a `build-chroot/list` request
# returns the chroot fixture. The probe under test is the real file; only curl
# and the clock knobs (COPR_POLL_INTERVAL, COPR_POLL_BUDGET) are stubbed.
#
# The fixtures mirror the real API shape observed on 2026-07-21 from
# https://copr.fedorainfracloud.org/api_3 (build/list carries id, state,
# source_package.version, submitted_on, chroots; build-chroot/list carries
# per-chroot name and state).
#
# The workflow checks keep each package's trigger and verifier in separate
# jobs, pass the trigger time through a job output, and keep POST out of the
# independently re-runnable verifier.
#
# Run: packaging/distros/copr/test-verify-copr-publication.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="${COPR_PROBE_UNDER_TEST:-$SCRIPT_DIR/verify-copr-publication.sh}"
WORKFLOW="${COPR_WORKFLOW_UNDER_TEST:-$SCRIPT_DIR/../../../.github/workflows/publish-downstream.yml}"
WORK="$(mktemp -d)"
FAILURES=0

# shellcheck disable=SC2329  # runs from the EXIT trap
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/bin"

# Stub curl: emits the fixture the routed request maps to. The build/list call
# index advances a per-fixture counter so a scenario can hand back a build that
# is running on early polls and succeeded later.
cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
fix="${COPR_FIXTURE_DIR:?stub curl: COPR_FIXTURE_DIR unset}"
url=""
for a in "$@"; do
    case "$a" in http*) url="$a" ;; esac
done
[ -n "$url" ] || { echo "stub curl: no URL in args" >&2; exit 2; }
case " $* " in
    *" -X POST "*)
        echo "stub curl: the verifier must not POST" >&2
        exit 2
        ;;
esac
case "$url" in
    *build-chroot/list*)
        cat "$fix/build-chroot.json"
        ;;
    *build/list*)
        n=$(( $(cat "$fix/.calls" 2>/dev/null || echo 0) + 1 ))
        echo "$n" >"$fix/.calls"
        if [ -f "$fix/build-list.$n.json" ]; then
            cat "$fix/build-list.$n.json"
        else
            cat "$fix/build-list.json"
        fi
        ;;
    *)
        echo "stub curl: unrouted URL $url" >&2
        exit 2
        ;;
esac
STUB
chmod +x "$WORK/bin/curl"

ok() { echo "ok   $1"; }
bad() {
    echo "FAIL $1"
    FAILURES=$((FAILURES + 1))
}
assert_status() {
    if [ "$1" = "$2" ]; then
        ok "$3 (exit $2)"
    else
        bad "$3: expected exit $1, got $2"
    fi
}
assert_grep() {
    if grep -qF -- "$1" "$2"; then
        ok "$3"
    else
        bad "$3: '$1' missing from $2"
        sed 's/^/     | /' "$2"
    fi
}
assert_verify_only() {
    if grep -qF -- 'run: packaging/distros/copr/verify-copr-publication.sh' "$1" &&
        ! grep -qF -- 'curl -sf -X POST' "$1"; then
        ok "$2"
    else
        bad "$2: the verify job is missing the probe or contains a webhook POST"
        sed 's/^/     | /' "$1"
    fi
}
assert_same_guard() {
    local trigger_block="$1" verify_block="$2" label="$3"
    local trigger_guard="$WORK/$label-trigger.guard"
    local verify_guard="$WORK/$label-verify.guard"
    sed -n '/^    if: >-$/,/^    runs-on:/p' "$trigger_block" >"$trigger_guard"
    sed -n '/^    if: >-$/,/^    runs-on:/p' "$verify_block" >"$verify_guard"
    if [ -s "$trigger_guard" ] && cmp -s "$trigger_guard" "$verify_guard"; then
        ok "$label trigger and verify use the same release guard"
    else
        bad "$label trigger and verify release guards differ"
    fi
}

# job_block <job id> <destination>; extract one top-level Actions job.
job_block() {
    awk -v heading="  $1:" '
        $0 == heading { found = 1 }
        found && $0 != heading && /^  [A-Za-z0-9][A-Za-z0-9_-]*:$/ { exit }
        found { print }
    ' "$WORKFLOW" >"$2"
}

# new_fixture <name> -> prints a fresh fixture dir path
new_fixture() {
    local d="$WORK/fix-$1"
    rm -rf "$d"
    mkdir -p "$d"
    printf '%s' "$d"
}

build_json() { # <id> <state> <version> <submitted>
    cat <<JSON
{"items":[
  {"id":$1,"state":"$2","source_package":{"version":"$3"},
   "submitted_on":$4,"started_on":$(($4 + 100)),"ended_on":$(($4 + 1000)),
   "chroots":["fedora-44-x86_64","centos-stream-10-x86_64","centos-stream-10-aarch64"]}
]}
JSON
}

chroots_all_ok() {
    cat <<'JSON'
{"items":[
  {"name":"fedora-44-x86_64","state":"succeeded"},
  {"name":"centos-stream-10-x86_64","state":"succeeded"},
  {"name":"centos-stream-10-aarch64","state":"succeeded"}
]}
JSON
}

chroots_one_failed() {
    cat <<'JSON'
{"items":[
  {"name":"fedora-44-x86_64","state":"succeeded"},
  {"name":"centos-stream-10-x86_64","state":"succeeded"},
  {"name":"centos-stream-10-aarch64","state":"failed"}
]}
JSON
}

# run_probe <fixture dir> <log> [ENV=VAL ...]
# Later ENV=VAL operands override the defaults (env applies them left to right),
# and env parses assignments from "$@" that the shell would treat as commands.
run_probe() {
    local fix="$1" log="$2"
    shift 2
    env PATH="$WORK/bin:$PATH" COPR_FIXTURE_DIR="$fix" \
        PACKAGE=chan RELEASE_TAG=v0.74.0 WEBHOOK_PRESENT=1 CANONICAL=true \
        POSTED_AT=1000 COPR_POLL_INTERVAL=1 COPR_POLL_BUDGET=30 \
        "$@" "$PROBE" >"$log" 2>&1
    return $?
}

# Run against the production default budget while seeding Bash's elapsed-time
# clock. This models a later observation without making the fixture wait hours.
run_probe_at() {
    local fix="$1" log="$2" elapsed="$3"
    env -u COPR_POLL_BUDGET PATH="$WORK/bin:$PATH" COPR_FIXTURE_DIR="$fix" \
        PACKAGE=chan RELEASE_TAG=v0.74.0 WEBHOOK_PRESENT=1 CANONICAL=true \
        POSTED_AT=1000 COPR_POLL_INTERVAL=0 SECONDS="$elapsed" \
        "$PROBE" >"$log" 2>&1
    return $?
}

echo "== every chroot succeeded at the expected version -> green"
fix="$(new_fixture green)"
build_json 10800001 succeeded 0.74.0-1 1000 >"$fix/build-list.json"
chroots_all_ok >"$fix/build-chroot.json"
run_probe "$fix" "$WORK/green.log"
assert_status 0 $? "a fully succeeded build at the tag is green"
assert_grep "succeeded at 0.74.0-1 on every chroot" "$WORK/green.log" "the green line names the version and chroot set"

echo "== a chroot failed -> red naming the chroot and build id"
fix="$(new_fixture chrootfail)"
build_json 10800002 failed 0.74.0-1 1000 >"$fix/build-list.json"
chroots_one_failed >"$fix/build-chroot.json"
run_probe "$fix" "$WORK/chrootfail.log"
assert_status 1 $? "a failed chroot fails the probe"
assert_grep "build 10800002 for chan ended 'failed'" "$WORK/chrootfail.log" "the red names the build id"
assert_grep "centos-stream-10-aarch64 failed" "$WORK/chrootfail.log" "the red names the failing chroot"

echo "== built version is not the released tag -> red (freeze broken)"
fix="$(new_fixture mismatch)"
build_json 10800003 succeeded 0.73.0-1 1000 >"$fix/build-list.json"
chroots_all_ok >"$fix/build-chroot.json"
run_probe "$fix" "$WORK/mismatch.log"
assert_status 1 $? "a version mismatch fails the probe"
assert_grep "COPR built chan 0.73.0-1 (build 10800003), not the released 0.74.0" "$WORK/mismatch.log" "the red states the provenance mismatch"
assert_grep "main was not frozen" "$WORK/mismatch.log" "the red names the frozen-main cause"

echo "== build still running past the budget -> red, unconfirmed not failed"
fix="$(new_fixture running)"
build_json 10800004 running 0.74.0-1 1000 >"$fix/build-list.json"
chroots_all_ok >"$fix/build-chroot.json"
run_probe "$fix" "$WORK/running.log" COPR_POLL_BUDGET=1
assert_status 1 $? "an unfinished build past budget fails the probe"
assert_grep "still 'running' after" "$WORK/running.log" "the red names the non-terminal state"
assert_grep "UNCONFIRMED (not failed)" "$WORK/running.log" "the budget red says unconfirmed, not failed"

echo "== no build for the package appeared -> red, unconfirmed not failed"
fix="$(new_fixture nobuild)"
# The only build predates the POST, so POSTED_AT excludes it: no build is ours.
build_json 10799000 succeeded 0.74.0-1 500 >"$fix/build-list.json"
chroots_all_ok >"$fix/build-chroot.json"
run_probe "$fix" "$WORK/nobuild.log" COPR_POLL_BUDGET=1
assert_status 1 $? "no matching build past budget fails the probe"
assert_grep "no COPR build for chan appeared" "$WORK/nobuild.log" "the red says no build appeared"
assert_grep "UNCONFIRMED (not failed)" "$WORK/nobuild.log" "the absent-build red says unconfirmed, not failed"

echo "== a build observed running then succeeding -> green (the poll actually waits)"
fix="$(new_fixture wait)"
build_json 10800005 running 0.74.0-1 1000 >"$fix/build-list.1.json"
build_json 10800005 running 0.74.0-1 1000 >"$fix/build-list.2.json"
build_json 10800005 succeeded 0.74.0-1 1000 >"$fix/build-list.json"
chroots_all_ok >"$fix/build-chroot.json"
run_probe "$fix" "$WORK/wait.log"
assert_status 0 $? "a build that finishes within budget greens after polling"
assert_grep "build 10800005 succeeded at 0.74.0-1" "$WORK/wait.log" "the green arrives after the running polls"

echo "== a v0.82.0-length build finishes inside the default window"
fix="$(new_fixture slow-within-window)"
build_json 10800006 running 0.74.0-1 1000 >"$fix/build-list.1.json"
build_json 10800006 succeeded 0.74.0-1 1000 >"$fix/build-list.json"
chroots_all_ok >"$fix/build-chroot.json"
run_probe_at "$fix" "$WORK/slow-within-window.log" 6058
assert_status 0 $? "a build still running at 6058s can finish inside the default budget"
assert_grep "build 10800006 succeeded at 0.74.0-1" "$WORK/slow-within-window.log" "the 6058s case reaches the later success"

echo "== a v0.98.0-length build expires unconfirmed, then verify alone succeeds"
fix="$(new_fixture slow-past-window)"
build_json 10800007 running 0.74.0-1 1000 >"$fix/build-list.json"
chroots_all_ok >"$fix/build-chroot.json"
run_probe_at "$fix" "$WORK/slow-past-window.log" 13986
assert_status 1 $? "a build still running at 13986s exceeds the default budget"
assert_grep "still 'running' after 7200s" "$WORK/slow-past-window.log" "the timeout names the 7200s window"
assert_grep "UNCONFIRMED (not failed)" "$WORK/slow-past-window.log" "the exceptional slow build is unconfirmed rather than failed"

# A verify-only rerun sees the same webhook build after it becomes terminal.
# The curl stub rejects POST, so this green cannot conceal a second trigger.
build_json 10800007 succeeded 0.74.0-1 1000 >"$fix/build-list.json"
rm -f "$fix/.calls"
run_probe_at "$fix" "$WORK/verify-rerun.log" 0
assert_status 0 $? "a later verify-only run succeeds against the original build"
assert_grep "build 10800007 succeeded at 0.74.0-1" "$WORK/verify-rerun.log" "the verify-only rerun confirms publication"

echo "== trigger and verify are separate re-runnable workflow jobs"
for row in \
    "chan|copr-chan-trigger|copr-chan-verify" \
    "chan-desktop|copr-desktop-trigger|copr-desktop-verify"; do
    IFS='|' read -r package trigger_job verify_job <<<"$row"
    trigger_block="$WORK/$trigger_job.yml"
    verify_block="$WORK/$verify_job.yml"
    job_block "$trigger_job" "$trigger_block"
    job_block "$verify_job" "$verify_block"

    assert_grep "name: COPR $package trigger" "$trigger_block" "$package has a trigger job"
    assert_grep 'if: >-' "$trigger_block" "$package trigger keeps the release guard"
    assert_grep 'PUBLISH: ${{ github.event_name' "$trigger_block" "$package trigger keeps the publish guard"
    assert_grep 'posted_at: ${{ steps.trigger.outputs.posted_at }}' "$trigger_block" "$package promotes the POST time to a job output"
    assert_grep 'webhook_present: ${{ steps.trigger.outputs.webhook_present }}' "$trigger_block" "$package promotes webhook presence to a job output"
    assert_grep 'curl -sf -X POST' "$trigger_block" "$package trigger owns the webhook POST"

    assert_grep "name: COPR $package verify" "$verify_block" "$package has a separate verify job"
    assert_grep "needs: $trigger_job" "$verify_block" "$package verify depends on its trigger"
    assert_grep 'if: >-' "$verify_block" "$package verify duplicates the release guard"
    assert_grep 'PUBLISH: ${{ github.event_name' "$verify_block" "$package verify duplicates the publish guard"
    assert_grep "POSTED_AT: \${{ needs.$trigger_job.outputs.posted_at }}" "$verify_block" "$package verify consumes the original POST time"
    assert_grep "WEBHOOK_PRESENT: \${{ needs.$trigger_job.outputs.webhook_present }}" "$verify_block" "$package verify consumes the original webhook verdict"
    assert_grep 'run: packaging/distros/copr/verify-copr-publication.sh' "$verify_block" "$package verify runs the probe"
    assert_verify_only "$verify_block" "$package verify runs only the probe and cannot POST"
    assert_same_guard "$trigger_block" "$verify_block" "$package"
done

echo "== COPR_WEBHOOK absent on the canonical repository -> red"
fix="$(new_fixture canonabsent)"
PATH="$WORK/bin:$PATH" COPR_FIXTURE_DIR="$fix" \
    PACKAGE=chan RELEASE_TAG=v0.74.0 WEBHOOK_PRESENT=0 CANONICAL=true \
    "$PROBE" >"$WORK/canonabsent.log" 2>&1
assert_status 1 $? "an absent webhook on the canonical repo is red"
assert_grep "COPR_WEBHOOK is absent on the canonical repository" "$WORK/canonabsent.log" "the canonical red names the absent secret"

echo "== COPR_WEBHOOK absent on a fork -> green no-op"
fix="$(new_fixture forkabsent)"
PATH="$WORK/bin:$PATH" COPR_FIXTURE_DIR="$fix" \
    PACKAGE=chan RELEASE_TAG=v0.74.0 WEBHOOK_PRESENT=0 CANONICAL=false \
    "$PROBE" >"$WORK/forkabsent.log" 2>&1
assert_status 0 $? "an absent webhook on a fork is a green no-op"
assert_grep "absent on a fork" "$WORK/forkabsent.log" "the fork no-op says so"

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "all checks passed"
    exit 0
fi
echo "$FAILURES check(s) failed"
exit 1
