#!/usr/bin/env bash
# check-packaging-isolation.sh -- static regression checks for gateway package
# identity, env-file ownership, and the credential and transport contracts the
# packaging and the developer E2E fixtures must keep.
#
# Every check here only reads tracked files, so it runs in well under a second
# and belongs to the gate: `make gateway-version-pin-check` runs it beside
# check-package-version-pins.sh, and `make gateway-lint` (so `make pre-push`)
# depends on that target. The behavioural half, which executes the postinst
# scripts and the sdme provisioner, is test-packaging-isolation.sh behind the
# opt-in `make gateway-packaging-isolation-test`.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

die() {
    printf 'check-packaging-isolation: %s\n' "$*" >&2
    exit 1
}

assert_contains() {
    local file=$1 text=$2
    grep -Fqx "$text" "$file" \
        || die "$file does not contain: $text"
}

# grep exits 0 for a match, 1 for no match, and 2 for an error such as an
# unreadable file or a bad pattern. Both helpers below treat anything other
# than 0 or 1 as a failure of the check itself: reading an error as "pattern
# absent" is exactly what made the retired ripgrep calls here pass vacuously.
#
# refute_pattern fails when the extended regular expression IS found.
refute_pattern() {
    local message=$1 pattern=$2
    shift 2
    local status=0
    grep -rEn -e "$pattern" "$@" || status=$?
    case "$status" in
        0) die "$message" ;;
        1) ;;
        *) die "grep failed (status $status) while checking: $message" ;;
    esac
}

# require_fixed fails when the literal string is NOT found.
require_fixed() {
    local message=$1 text=$2
    shift 2
    local status=0
    grep -rFq -e "$text" "$@" || status=$?
    case "$status" in
        0) ;;
        1) die "$message" ;;
        *) die "grep failed (status $status) while checking: $message" ;;
    esac
}

services=(profile identity devserver-control devserver-proxy)
for service in "${services[@]}"; do
    user="chan-gateway-$service"
    packaging="$REPO/gateway/crates/$service/packaging"
    unit="$packaging/chan-gateway-$service.service"
    postinst="$packaging/postinst"
    env_file="$packaging/$service.env"

    assert_contains "$unit" "User=$user"
    assert_contains "$unit" "Group=$user"
    assert_contains "$postinst" "    install -d -m 0751 -o root -g root /etc/chan-gateway"
    assert_contains "$postinst" "      chown root:root /etc/chan-gateway/domain.env"
    assert_contains "$postinst" "      chmod 0644 /etc/chan-gateway/domain.env"
    assert_contains "$postinst" "      chown root:$user /etc/chan-gateway/$service.env"
    assert_contains "$postinst" "      chmod 0640 /etc/chan-gateway/$service.env"
    grep -Fq "Permissions are 0640 root:$user" "$env_file" \
        || die "$env_file does not document its service-only group"
done

migrate_packaging="$REPO/gateway/crates/identity/packaging"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "User=chan-gateway-migrate"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "Group=chan-gateway-migrate"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "EnvironmentFile=/etc/chan-gateway/migrate.env"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "ExecStartPre=/usr/lib/chan-gateway/prepare-database-roles"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "ExecStart=/usr/bin/chan-gateway-identity"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "ExecStartPost=/usr/lib/chan-gateway/reconcile-database-roles"
assert_contains "$migrate_packaging/chan-gateway-migrate.service" \
    "RemainAfterExit=yes"
if grep -Fq '[Install]' "$migrate_packaging/chan-gateway-migrate.service"; then
    die "database migration unit must run only as an app-service dependency"
fi
for service in profile identity; do
    assert_contains "$REPO/gateway/crates/$service/packaging/chan-gateway-$service.service" \
        "Requires=chan-gateway-migrate.service"
    assert_contains "$REPO/gateway/crates/$service/packaging/$service.env" \
        "CHAN_GATEWAY_MIGRATIONS=external"
    assert_contains "$REPO/gateway/crates/$service/packaging/chan-gateway-$service.service" \
        "ExecStartPre=/usr/lib/chan-gateway/check-database-ready"
    assert_contains "$REPO/gateway/crates/$service/packaging/$service.env" \
        "EXPECTED_SQLX_MIGRATION=16"
    assert_contains "$REPO/gateway/crates/$service/packaging/$service.env" \
        "DATABASE_ROLE_POLICY_VERSION=1"
    if grep -Fq 'postgres://chan:chan@' \
        "$REPO/gateway/crates/$service/packaging/$service.env"; then
        die "$service env still carries the database-owner URL"
    fi
done
assert_contains "$migrate_packaging/migrate.env" "CHAN_GATEWAY_MIGRATIONS=only"
assert_contains "$migrate_packaging/migrate.env" "EXPECTED_SQLX_MIGRATION=16"
assert_contains "$migrate_packaging/migrate.env" "DATABASE_ROLE_POLICY_VERSION=1"
assert_contains "$migrate_packaging/postinst" \
    "      chown root:chan-gateway-migrate /etc/chan-gateway/migrate.env"
assert_contains "$migrate_packaging/postinst" \
    "      chmod 0640 /etc/chan-gateway/migrate.env"

# Every package reapplies the same directory state, so installing admin first,
# last, or between service packages cannot remove traversal from service users.
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "    install -d -m 0751 -o root -g root /etc/chan-gateway"
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "      chown root:root /etc/chan-gateway/domain.env"
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "      chmod 0644 /etc/chan-gateway/domain.env"
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "      chown root:root /etc/chan-gateway/admin.env"
assert_contains "$REPO/gateway/crates/admin/packaging/postinst" \
    "      chmod 0600 /etc/chan-gateway/admin.env"

refute_pattern "a gateway daemon still uses the shared chan-gateway identity" \
    '^(User|Group)=chan-gateway$' \
    "$REPO"/gateway/crates/*/packaging/*.service

assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    "install -d -m 0751 -o root -g root /etc/chan-gateway"
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    "MAX_DEVSERVERS_PER_USER=100"
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    '        chown root:root "$backup"'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    '        chmod 0600 "$backup"'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'write_env /etc/chan-gateway/migrate.env chan-gateway-migrate 0640 "$(cat <<EOF'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DATABASE_URL=${MIGRATION_DATABASE_URL}'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DATABASE_URL=${IDENTITY_DATABASE_URL}'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DATABASE_URL=${PROFILE_DATABASE_URL}'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'CHAN_GATEWAY_MIGRATIONS=external'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DEVSERVER_ENTRY_SIGNING_KEY=${DEVSERVER_ENTRY_SIGNING_KEY}'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'DEVSERVER_ENTRY_VERIFYING_KEYS=${DEVSERVER_ENTRY_VERIFYING_KEYS}'
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "INTERNAL_BIND_ADDR=127.0.0.1:7004"
assert_contains "$REPO/gateway/crates/devserver-proxy/packaging/devserver-proxy.env" \
    "IDENTITY_URL=http://127.0.0.1:7004"
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'INTERNAL_BIND_ADDR=127.0.0.1:7004'
assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
    'IDENTITY_URL=http://127.0.0.1:7004'
refute_pattern "an internal identity client still targets the public listener" \
    '^IDENTITY_URL=.*:7000/?$' \
    "$REPO"/gateway/crates/*/packaging/*.env \
    "$REPO/packaging/gateway/scripts/configure.sh" \
    "$REPO/packaging/gateway/scripts/dev/setup.sh"

for scoped_env in \
    DEVSERVER_OPERATOR_ADMIN_TOKENS \
    DEVSERVER_IDENTITY_ADMIN_TOKENS \
    DEVSERVER_PROFILE_ADMIN_TOKENS; do
    assert_contains "$REPO/gateway/crates/devserver-control/packaging/devserver-control.env" \
        "$scoped_env="
done
assert_contains "$REPO/gateway/crates/devserver-control/packaging/devserver-control.env" \
    "DEVSERVER_ADMISSION_VERIFYING_KEYS="
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "DEVSERVER_ADMISSION_VERIFYING_KEYS="
if grep -Fq 'DEVSERVER_ADMISSION_VERIFYING_KEY=' \
    "$REPO/gateway/crates/devserver-control/packaging/devserver-control.env"; then
    die "controller package retains the non-rotatable admission verifier variable"
fi
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "DEVSERVER_IDENTITY_ADMIN_TOKEN="
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "IDENTITY_SESSION_INTERNAL_TOKEN="
assert_contains "$REPO/gateway/crates/identity/packaging/identity.env" \
    "IDENTITY_ACCOUNT_ADMIN_TOKEN="
for scoped_env in IDENTITY_SESSION_INTERNAL_TOKEN IDENTITY_ACCOUNT_ADMIN_TOKEN; do
    assert_contains "$REPO/packaging/gateway/scripts/configure.sh" \
        "$scoped_env=\${$scoped_env}"
    assert_contains "$REPO/packaging/gateway/scripts/dev/setup.sh" \
        "$scoped_env=\$$scoped_env"
done
assert_contains "$REPO/gateway/crates/profile/packaging/profile.env" \
    "DEVSERVER_PROFILE_ADMIN_TOKEN="
for scoped_env in \
    CHAN_ADMIN_PROFILE_TOKEN CHAN_ADMIN_IDENTITY_TOKEN CHAN_ADMIN_OPERATOR_TOKEN; do
    assert_contains "$REPO/gateway/crates/admin/packaging/admin.env" "$scoped_env="
done
refute_pattern "packaging retains a shared admin bearer" \
    '^DEVSERVER_ADMIN_TOKEN=|^CHAN_ADMIN_TOKEN=' \
    "$REPO"/gateway/crates/*/packaging/*.env \
    "$REPO/packaging/gateway/scripts/configure.sh"
refute_pattern "runtime packaging retains the retired cross-service session secret" \
    '^DEVSERVER_GATE_SECRET=' \
    "$REPO"/gateway/crates/*/packaging/*.env \
    "$REPO/packaging/gateway/scripts/configure.sh" \
    "$REPO/packaging/gateway/scripts/dev/setup.sh"
refute_pattern "a narrow account bearer escaped identity packaging" \
    '^IDENTITY_(SESSION_INTERNAL|ACCOUNT_ADMIN)_TOKEN=' \
    "$REPO/gateway/crates/devserver-proxy/packaging/devserver-proxy.env" \
    "$REPO/gateway/crates/admin/packaging/admin.env"

# Keep both developer E2E paths on the production credential and transport
# contracts. These fixtures are executable documentation and must not quietly
# regress to the retired shared-secret/query-bearer flow or cleartext public
# DNS origins.
sdme_e2e="$REPO/packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e"
refute_pattern "sdme devserver E2E retains a retired credential contract" \
    'DEVSERVER_GATE_SECRET|HS256|mint-gate-token|entry_url[^[:space:]]*[?]t=' \
    "$sdme_e2e"
for expected in \
    DEVSERVER_ENTRY_VERIFYING_KEYS \
    IDENTITY_PUBLIC_ORIGIN \
    DEVSERVER_PROXY_CREDENTIALS \
    devserver-control-service \
    mint-signed-credential.py; do
    require_fixed "sdme devserver E2E does not exercise $expected" \
        "$expected" "$sdme_e2e"
done

dev_setup="$REPO/packaging/gateway/scripts/dev/setup.sh"
dev_run="$REPO/packaging/gateway/scripts/dev/run.sh"
refute_pattern "local gateway runner publishes a cleartext DNS origin" \
    '^(BASE_URL|DEVSERVER_PROXY_ORIGIN|DEVSERVER_TUNNEL_ORIGIN|DEVSERVER_PROXY_BASE_URL|IDENTITY_PUBLIC_ORIGIN|DASHBOARD_URL)=http://.*localtest\.me' \
    "$dev_setup"
for expected in \
    'BASE_URL=https://gw.localtest.me:17000' \
    'DEVSERVER_PROXY_ORIGIN=https://proxy.localtest.me:17002' \
    'DEVSERVER_TUNNEL_ORIGIN=https://proxy.localtest.me:17100' \
    'IDENTITY_PUBLIC_ORIGIN=https://gw.localtest.me:17000'; do
    require_fixed "local gateway setup does not contain: $expected" \
        "$expected" "$dev_setup"
done
grep -Fq 'TLS_SHIM="$SCRIPT_DIR/tls-shim.mjs"' "$dev_run" \
    || die "local gateway runner does not publish TLS edges"

prepare="$REPO/packaging/gateway/scripts/prepare-database-roles.sh"
reconcile="$REPO/packaging/gateway/scripts/reconcile-database-roles.sh"
for role in chan_gateway_identity chan_gateway_profile; do
    grep -Fq "ALTER ROLE $role NOSUPERUSER NOCREATEDB NOCREATEROLE" "$prepare" \
        || die "$prepare does not constrain $role"
done
grep -Fq "Remove every role" "$prepare" \
    || die "$prepare does not remove application role memberships"
grep -Fq "public._sqlx_migrations" "$reconcile" \
    || die "$reconcile does not explicitly isolate sqlx history"
grep -Fq "chan_gateway_deployment_state" "$reconcile" \
    || die "$reconcile does not publish an exact readiness marker"
for table in devserver_user_policies devserver_fleet_policy identity_session_index; do
    grep -Fq "public.$table" "$reconcile" \
        || die "$reconcile does not inventory and grant $table"
    grep -Fq "public.$table" "$REPO/packaging/gateway/scripts/test-database-roles.sh" \
        || die "database role test does not exercise $table"
done
grep -Fq "application database role owns an object" "$prepare" \
    || die "$prepare does not reject app-owned database objects"
grep -Fq "application database role owns an object" "$reconcile" \
    || die "$reconcile does not reject app-owned database objects"
if grep -Eq 'GRANT .*ALL (TABLES|SEQUENCES)|ALTER DEFAULT PRIVILEGES.*GRANT' \
    "$prepare" "$reconcile"; then
    die "database role scripts contain a blanket or default grant"
fi

latest_migration=$(find "$REPO/gateway/migrations" -maxdepth 1 -name '*.sql' \
    | sed 's|.*/||' | LC_ALL=C sort | tail -n 1)
[[ -n "$latest_migration" ]] || die "no SQL migrations found in $REPO/gateway/migrations"
latest_migration=${latest_migration%%_*}
latest_migration=$((10#$latest_migration))
grep -Fqx "EXPECTED_SQLX_MIGRATION=$latest_migration" \
    "$migrate_packaging/migrate.env" \
    || die "migrate.env does not pin the latest sqlx migration"

provision="$REPO/packaging/sdme/chan-devserver-provision.sh"
grep -Fq 'container already belongs to trust-domain user' "$provision" \
    || die "sdme provisioner does not refuse a second trust-domain user"
if grep -Eq 'NOPASSWD|adduser .* sudo|apt-get .* sudo' "$provision"; then
    die "sdme provisioner still grants or installs sudo"
fi

printf 'PASS: gateway packaging isolation contracts (static)\n'
