#!/usr/bin/env bash
#
# Run the gateway database roles suite (packaging/gateway/scripts/
# test-database-roles.sh) inside a disposable sdme PostgreSQL guest, then
# remove the guest. This is the suite's only local route: the suite rewrites
# the cluster-wide chan_gateway_identity and chan_gateway_profile roles (their
# passwords, memberships and attributes), so it never runs against a
# PostgreSQL that holds anything else, and the machine that runs it needs no
# PostgreSQL installed. CI runs the same suite against a postgres:16 service
# container (the packaging job in .github/workflows/gateway-ci.yml).
#
# Invoked through `make gateway-database-roles-test`. Standalone:
#
#   SDME='sudo sdme' packaging/gateway/scripts/dev/sdme/database-roles-test.sh
#
# The guest boots the chan-psql rootfs, built from chan-psql.sdme beside this
# file on first use. That rootfs listens on every address with a hardcoded
# password, so the guest gets a private network namespace with loopback alone
# and the suite runs inside it, where 127.0.0.1:5432 is the address its role
# connections expect. The working tree's packaging/gateway/scripts and
# gateway/migrations are bound read-only, so an uncommitted change is what
# gets tested.
#
#   SDME                     how sdme is reached (default: sudo sdme)
#   GATEWAY_ROLES_CONTAINER  guest name (default: chan-gateway-roles-test)
#   GATEWAY_ROLES_ROOTFS     rootfs name (default: chan-psql)

set -euo pipefail

SDME=${SDME:-sudo sdme}
CONTAINER=${GATEWAY_ROLES_CONTAINER:-chan-gateway-roles-test}
ROOTFS=${GATEWAY_ROLES_ROOTFS:-chan-psql}
HERE=$(cd "$(dirname "$0")" && pwd -P)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
GUEST=/opt/chan-gateway-roles-test
ADMIN_URL=postgres://chan:chan@127.0.0.1:5432
SUITE_PASS='PASS: exact database-role prepare/reconcile contract'

die() {
    printf 'database-roles-test: %s\n' "$*" >&2
    exit 1
}

read -r -a SDME_CMD <<<"$SDME"
[ ${#SDME_CMD[@]} -gt 0 ] || die "SDME must name the sdme command"

created=0
log=
# shellcheck disable=SC2329  # runs from the EXIT trap
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [ "$created" -eq 1 ] && ! "${SDME_CMD[@]}" rm -f "$CONTAINER" >/dev/null; then
        printf 'database-roles-test: could not remove sdme container %s\n' "$CONTAINER" >&2
        [ "$status" -ne 0 ] || status=1
    fi
    [ -z "$log" ] || rm -f -- "$log"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

listed() {
    awk -v name="$1" '$1 == name { found = 1 } END { exit !found }'
}

fs_list=$("${SDME_CMD[@]}" fs ls) || die "'${SDME_CMD[*]} fs ls' failed"
if ! listed "$ROOTFS" <<<"$fs_list"; then
    printf '==> building rootfs %s from %s/chan-psql.sdme\n' "$ROOTFS" "$HERE"
    ( cd "$HERE" && "${SDME_CMD[@]}" fs build "$ROOTFS" chan-psql.sdme ) \
        || die "rootfs build failed; chan-psql.sdme builds FROM the ubuntu rootfs: ${SDME_CMD[*]} fs import docker.io/ubuntu:26.04 --name ubuntu --install-packages=yes"
fi

# A guest of the same name may be someone else's: refuse rather than remove it.
container_list=$("${SDME_CMD[@]}" ps) || die "'${SDME_CMD[*]} ps' failed"
if listed "$CONTAINER" <<<"$container_list"; then
    die "an sdme container named $CONTAINER already exists; remove it (${SDME_CMD[*]} rm -f $CONTAINER) or set GATEWAY_ROLES_CONTAINER"
fi

# The cluster and the suite's database stay under a few tens of megabytes, so
# the memory cap leaves wide headroom while keeping a runaway guest off the
# host. No disk cap: the guest is removed after the run, and sdme refuses
# --disk on a host whose btrfs already has quotas enabled by something else.
printf '==> creating guest %s from rootfs %s\n' "$CONTAINER" "$ROOTFS"
"${SDME_CMD[@]}" create --name "$CONTAINER" -r "$ROOTFS" --storage btrfs \
    --memory 1G --private-network \
    -b "$REPO/packaging/gateway/scripts:$GUEST/scripts:ro" \
    -b "$REPO/gateway/migrations:$GUEST/migrations:ro"
# Marked as ours before the boot, so an interrupt during it still reaches the
# cleanup with the guest to remove.
created=1
"${SDME_CMD[@]}" start -t 120 "$CONTAINER"

# chan-pg-bootstrap.service runs after initdb and the server start, and creates
# the chan superuser the suite connects as.
state=
for _ in $(seq 1 90); do
    state=$("${SDME_CMD[@]}" exec "$CONTAINER" -- /usr/bin/systemctl is-active chan-pg-bootstrap.service 2>/dev/null) || true
    case $state in active | failed) break ;; esac
    sleep 1
done
if [ "$state" != active ]; then
    "${SDME_CMD[@]}" exec "$CONTAINER" -- /usr/bin/journalctl --no-pager -n 40 \
        -u chan-pg-init.service -u 'postgresql@*' -u chan-pg-bootstrap.service >&2 || true
    die "PostgreSQL in $CONTAINER did not become ready (chan-pg-bootstrap.service: ${state:-unknown})"
fi

# The suite runs as postgres, not root: CI's runner is unprivileged, and the
# distribution's psql wrapper must read the cluster configuration, which the
# postgres account can and nobody cannot.
guest_psql=("${SDME_CMD[@]}" exec --user postgres "$CONTAINER" -- /usr/bin/psql --no-password -X -v ON_ERROR_STOP=1)
server=$("${guest_psql[@]}" "$ADMIN_URL/postgres" -Atqc 'SELECT version()') \
    || die "cannot connect to PostgreSQL in $CONTAINER as chan"
printf '==> server: %s\n' "$server"
"${guest_psql[@]}" "$ADMIN_URL/postgres" -c 'CREATE DATABASE chan_gateway_role_test'

log=$(mktemp "${TMPDIR:-/tmp}/chan-gateway-roles.XXXXXX")
status=0
"${SDME_CMD[@]}" exec --user postgres "$CONTAINER" -- /usr/bin/env \
    DATABASE_URL="$ADMIN_URL/chan_gateway_role_test" \
    MIGRATIONS_DIR="$GUEST/migrations" \
    CHAN_GATEWAY_DATABASE_TEST_ALLOW_DESTRUCTIVE=yes \
    "$GUEST/scripts/test-database-roles.sh" 2>&1 | tee "$log" || status=$?

# The suite's own exit status is not the whole verdict: a FAIL line fails the
# run even when the suite exits 0, and so does a suite that stops before its
# final PASS line.
if grep -q '^FAIL' "$log"; then
    printf 'database-roles-test: the suite printed a FAIL line\n' >&2
    [ "$status" -ne 0 ] || status=1
fi
if ! grep -qxF "$SUITE_PASS" "$log"; then
    printf 'database-roles-test: the suite did not reach its final PASS line\n' >&2
    [ "$status" -ne 0 ] || status=1
fi
if [ "$status" -eq 0 ]; then
    printf 'database-roles-test: PASS in %s\n' "$CONTAINER"
else
    printf 'database-roles-test: FAIL (status %s) in %s\n' "$status" "$CONTAINER" >&2
fi
exit "$status"
