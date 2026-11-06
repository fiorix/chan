#!/usr/bin/env bash
# Destructive integration test for prepare/reconcile against an isolated DB.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${MIGRATIONS_DIR:?MIGRATIONS_DIR is required}"
: "${IDENTITY_DATABASE_PASSWORD:=identity-test-password}"
: "${PROFILE_DATABASE_PASSWORD:=profile-test-password}"
: "${EXPECTED_TEST_DATABASE:=chan_gateway_role_test}"
: "${CHAN_GATEWAY_DATABASE_TEST_ALLOW_DESTRUCTIVE:=}"

[[ $CHAN_GATEWAY_DATABASE_TEST_ALLOW_DESTRUCTIVE == yes ]] \
    || { echo "refusing destructive DB test without CHAN_GATEWAY_DATABASE_TEST_ALLOW_DESTRUCTIVE=yes" >&2; exit 1; }
actual_database=$(psql "$DATABASE_URL" --no-password -Atqc 'SELECT current_database()')
[[ $actual_database == "$EXPECTED_TEST_DATABASE" ]] \
    || { echo "refusing DB test against unexpected database: $actual_database" >&2; exit 1; }

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
export DATABASE_URL IDENTITY_DATABASE_PASSWORD PROFILE_DATABASE_PASSWORD
"$SCRIPT_DIR/prepare-database-roles.sh"

psql "$DATABASE_URL" --no-password --set=ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public._sqlx_migrations (
    version bigint PRIMARY KEY,
    description text NOT NULL,
    installed_on timestamptz NOT NULL DEFAULT now(),
    success boolean NOT NULL,
    checksum bytea NOT NULL,
    execution_time bigint NOT NULL
);
SQL

latest_migration=0
for migration in "$MIGRATIONS_DIR"/*.sql; do
    filename=${migration##*/}
    padded_version=${filename%%_*}
    version=$((10#$padded_version))
    psql "$DATABASE_URL" --no-password --set=ON_ERROR_STOP=1 --file="$migration"
    psql "$DATABASE_URL" --no-password --set=ON_ERROR_STOP=1 \
        --set=version="$version" --set=description="$filename" <<'SQL'
INSERT INTO public._sqlx_migrations (
    version, description, success, checksum, execution_time
) VALUES (:'version', :'description', true, ''::bytea, 0);
SQL
    latest_migration=$version
done

psql "$DATABASE_URL" --no-password --set=ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE tower_sessions.session (
    id text PRIMARY KEY NOT NULL,
    data bytea NOT NULL,
    expiry_date timestamptz NOT NULL
);
SQL

export EXPECTED_SQLX_MIGRATION=$latest_migration
export DATABASE_ROLE_POLICY_VERSION=2

# An impossible target must fail and leave the durable marker invalid.
if EXPECTED_SQLX_MIGRATION=$((latest_migration + 1)) \
    "$SCRIPT_DIR/reconcile-database-roles.sh" >/dev/null 2>&1; then
    echo "reconcile accepted a missing latest migration" >&2
    exit 1
fi
[[ $(psql "$DATABASE_URL" --no-password -Atqc \
    'SELECT migration_version FROM public.chan_gateway_deployment_state WHERE singleton') == -1 ]]

"$SCRIPT_DIR/reconcile-database-roles.sh"

psql "$DATABASE_URL" --no-password --set=ON_ERROR_STOP=1 <<'SQL'
DO $check$
BEGIN
    IF NOT has_table_privilege(
        'chan_gateway_identity', 'public.api_tokens', 'SELECT,INSERT,UPDATE'
    ) OR has_table_privilege(
        'chan_gateway_identity', 'public.api_tokens', 'DELETE'
    ) OR has_table_privilege(
        'chan_gateway_identity', 'public.users', 'INSERT,UPDATE,DELETE'
    ) OR NOT has_table_privilege(
        'chan_gateway_profile', 'public.users', 'SELECT,INSERT,UPDATE,DELETE'
    ) OR has_table_privilege(
        'chan_gateway_profile', 'public.identities', 'UPDATE,DELETE'
    ) OR has_table_privilege(
        'chan_gateway_profile', 'tower_sessions.session', 'SELECT'
    ) OR NOT has_table_privilege(
        'chan_gateway_profile', 'public.control_revocation_jobs',
        'SELECT,INSERT,UPDATE,DELETE'
    ) OR has_table_privilege(
        'chan_gateway_identity', 'public.control_revocation_jobs',
        'SELECT,INSERT,UPDATE,DELETE'
    ) OR NOT has_table_privilege(
        'chan_gateway_identity', 'public.devserver_fleet_policy', 'SELECT'
    ) OR has_table_privilege(
        'chan_gateway_identity', 'public.devserver_fleet_policy',
        'INSERT,UPDATE,DELETE'
    ) OR NOT has_table_privilege(
        'chan_gateway_identity', 'public.devserver_user_policies', 'SELECT'
    ) OR has_table_privilege(
        'chan_gateway_identity', 'public.devserver_user_policies',
        'INSERT,UPDATE,DELETE'
    ) OR NOT has_table_privilege(
        'chan_gateway_identity', 'public.identity_session_index',
        'SELECT,INSERT,UPDATE,DELETE'
    ) OR NOT has_table_privilege(
        'chan_gateway_profile', 'public.devserver_fleet_policy',
        'SELECT,INSERT,UPDATE'
    ) OR has_table_privilege(
        'chan_gateway_profile', 'public.devserver_fleet_policy', 'DELETE'
    ) OR NOT has_table_privilege(
        'chan_gateway_profile', 'public.devserver_user_policies',
        'SELECT,INSERT,UPDATE'
    ) OR has_table_privilege(
        'chan_gateway_profile', 'public.devserver_user_policies', 'DELETE'
    ) OR NOT has_table_privilege(
        'chan_gateway_profile', 'public.wireguard_peers', 'SELECT'
    ) OR NOT has_table_privilege(
        'chan_gateway_profile', 'public.wireguard_peers', 'INSERT'
    ) OR NOT has_table_privilege(
        'chan_gateway_profile', 'public.wireguard_peers', 'UPDATE'
    ) OR NOT has_table_privilege(
        'chan_gateway_profile', 'public.wireguard_peers', 'DELETE'
    ) OR has_table_privilege(
        'chan_gateway_identity', 'public.wireguard_peers',
        'SELECT,INSERT,UPDATE,DELETE'
    ) OR has_table_privilege(
        'chan_gateway_profile', 'public.identity_session_index',
        'SELECT,INSERT,UPDATE,DELETE'
    ) THEN
        RAISE EXCEPTION 'application role matrix is not exact';
    END IF;
END
$check$;
SQL

identity_psql=(psql "postgres://chan_gateway_identity:${IDENTITY_DATABASE_PASSWORD}@127.0.0.1:5432/$EXPECTED_TEST_DATABASE" --no-password)
profile_psql=(psql "postgres://chan_gateway_profile:${PROFILE_DATABASE_PASSWORD}@127.0.0.1:5432/$EXPECTED_TEST_DATABASE" --no-password)

DATABASE_URL="postgres://chan_gateway_identity:${IDENTITY_DATABASE_PASSWORD}@127.0.0.1:5432/$EXPECTED_TEST_DATABASE" \
    "$SCRIPT_DIR/check-database-ready.sh"
DATABASE_URL="postgres://chan_gateway_profile:${PROFILE_DATABASE_PASSWORD}@127.0.0.1:5432/$EXPECTED_TEST_DATABASE" \
    "$SCRIPT_DIR/check-database-ready.sh"

"${identity_psql[@]}" -Atqc \
    'SELECT migration_version FROM public.chan_gateway_deployment_state WHERE singleton' \
    | grep -qx "$latest_migration"
"${profile_psql[@]}" -Atqc 'SELECT count(*) FROM public.users' | grep -qx 0

assert_identity_lock() {
    local name=$1 sql=$2 expected=$3 result
    if ! result=$("${identity_psql[@]}" -X -v ON_ERROR_STOP=1 \
        -v VERBOSITY=verbose -Atqc "$sql" 2>&1); then
        printf 'FAIL: identity %s\n%s\n' "$name" "$result" >&2
        return 1
    fi
    if [[ $result != "$expected" ]]; then
        printf 'FAIL: identity %s did not return the seeded row\n' "$name" >&2
        return 1
    fi
    printf 'PASS: identity %s\n' "$name"
}

assert_identity_update_denied() {
    local name=$1 sql=$2 result status
    if result=$("${identity_psql[@]}" -X -v ON_ERROR_STOP=1 \
        -v VERBOSITY=verbose -Atqc "BEGIN; $sql; ROLLBACK" 2>&1); then
        printf 'FAIL: identity unexpectedly updated %s\n' "$name" >&2
        return 1
    else
        status=$?
    fi
    if ! grep -Eq '^ERROR:[[:space:]]+42501:' <<< "$result"; then
        printf 'FAIL: identity %s denial was not SQLSTATE 42501 (rc=%s)\n%s\n' \
            "$name" "$status" "$result" >&2
        return 1
    fi
    printf 'PASS: identity %s update denied with SQLSTATE 42501\n' "$name"
}

check_identity_mint_permissions() {
    local failed=0 timestamps before after snapshot_sql
    # Run both locks even on failure so a missing grant cannot hide its peer.
    assert_identity_lock 'user FOR UPDATE' \
        "SELECT id, blocked_at FROM public.users WHERE id = '$test_user_id' FOR UPDATE" \
        "$test_user_id|" || failed=1
    assert_identity_lock 'fleet FOR SHARE' \
        'SELECT admissions_enabled FROM public.devserver_fleet_policy WHERE singleton = true FOR SHARE' \
        f || failed=1
    [[ $failed == 0 ]] || return 1

    psql "$DATABASE_URL" --no-password -X -v ON_ERROR_STOP=1 <<'SQL'
DO $check$
DECLARE
    target regclass;
    column_row record;
BEGIN
    FOREACH target IN ARRAY ARRAY['public.users'::regclass, 'public.devserver_fleet_policy'::regclass]
    LOOP
        IF has_table_privilege('chan_gateway_identity', target, 'INSERT,UPDATE,DELETE') THEN
            RAISE EXCEPTION 'identity has table write privileges on %', target;
        END IF;
        FOR column_row IN
            SELECT attname, attnum FROM pg_attribute
            WHERE attrelid = target AND attnum > 0 AND NOT attisdropped
        LOOP
            IF has_column_privilege('chan_gateway_identity', target, column_row.attnum, 'UPDATE')
                   IS DISTINCT FROM (column_row.attname = 'updated_at')
               OR has_column_privilege('chan_gateway_identity', target, column_row.attnum, 'INSERT') THEN
                RAISE EXCEPTION 'identity column write privileges differ on %.%', target, column_row.attname;
            END IF;
        END LOOP;
    END LOOP;
END
$check$;
SQL

    assert_identity_update_denied users.blocked_at \
        "UPDATE public.users SET blocked_at = now() WHERE id = '$test_user_id'"
    assert_identity_update_denied devserver_fleet_policy.admissions_enabled \
        'UPDATE public.devserver_fleet_policy SET admissions_enabled = true WHERE singleton'

    snapshot_sql="SELECT updated_at FROM public.users WHERE id = '$test_user_id';
        SELECT updated_at FROM public.devserver_fleet_policy WHERE singleton"
    before=$("${identity_psql[@]}" -X -v ON_ERROR_STOP=1 -Atqc "$snapshot_sql")
    timestamps=$("${identity_psql[@]}" -X -v ON_ERROR_STOP=1 -Atq \
        -c 'BEGIN' \
        -c "UPDATE public.users SET updated_at = '2000-01-01 00:00:00+00'
            WHERE id = '$test_user_id'
            RETURNING updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00'" \
        -c "UPDATE public.devserver_fleet_policy SET updated_at = '2000-01-01 00:00:00+00'
            WHERE singleton
            RETURNING updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00'" \
        -c 'ROLLBACK')
    [[ $timestamps == $'t\nt' ]] \
        || { echo 'identity did not update both seeded timestamps' >&2; return 1; }
    after=$("${identity_psql[@]}" -X -v ON_ERROR_STOP=1 -Atqc "$snapshot_sql")
    [[ $before == "$after" ]] \
        || { echo 'identity timestamp updates did not roll back' >&2; return 1; }
    printf 'PASS: identity timestamp-only UPDATE capability and rollback\n'
}

test_user_id=00000000-0000-0000-0000-000000000001
"${profile_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO public.users (id, email, username) VALUES ('$test_user_id', 'role-test@example.com', 'role-test')" \
    -c "INSERT INTO public.devserver_user_policies (user_id, enabled, max_connected_devservers) VALUES ('$test_user_id', true, 3)" \
    -c "INSERT INTO public.devserver_fleet_policy (singleton, admissions_enabled) VALUES (true, false) ON CONFLICT (singleton) DO UPDATE SET admissions_enabled = EXCLUDED.admissions_enabled"
"${identity_psql[@]}" -Atqc \
    "SELECT max_connected_devservers FROM public.devserver_user_policies WHERE user_id = '$test_user_id'" \
    | grep -qx 3
"${identity_psql[@]}" -Atqc \
    'SELECT admissions_enabled FROM public.devserver_fleet_policy WHERE singleton' \
    | grep -qx f
check_identity_mint_permissions
"${identity_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO public.identity_session_index (user_id, store_id, authenticated_at) VALUES ('$test_user_id', 'role-test-session', now())" \
    -c "UPDATE public.identity_session_index SET authenticated_at = now() WHERE store_id = 'role-test-session'" \
    -c "DELETE FROM public.identity_session_index WHERE store_id = 'role-test-session'"

test_token_id=00000000-0000-0000-0000-000000000002
"${identity_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO public.api_tokens (id, user_id, label, token_hash) VALUES ('$test_token_id', '$test_user_id', 'wireguard', 'role-test-token-digest')"
"${profile_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO public.wireguard_peers (user_id, token_id, host, public_key, address_v4) VALUES ('$test_user_id', '$test_token_id', 'p1', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '10.7.0.2')" \
    -c "UPDATE public.wireguard_peers SET address_v4 = '10.7.0.3' WHERE token_id = '$test_token_id'"
"${profile_psql[@]}" -Atqc \
    "SELECT address_v4 FROM public.wireguard_peers WHERE token_id = '$test_token_id'" \
    | grep -qx '10.7.0.3'
"${profile_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "DELETE FROM public.wireguard_peers WHERE token_id = '$test_token_id'"
if "${identity_psql[@]}" -c 'SELECT * FROM public.wireguard_peers' >/dev/null 2>&1; then
    echo 'identity role unexpectedly read profile-only WireGuard peers' >&2
    exit 1
fi

if "${identity_psql[@]}" -c 'CREATE TABLE public.forbidden (id int)' >/dev/null 2>&1; then
    echo "identity role unexpectedly created a table" >&2
    exit 1
fi
if "${identity_psql[@]}" -c 'SELECT * FROM public._sqlx_migrations' >/dev/null 2>&1; then
    echo "identity role unexpectedly read sqlx migration history" >&2
    exit 1
fi
if "${identity_psql[@]}" -c 'SELECT * FROM public.identities' >/dev/null 2>&1; then
    echo "identity role unexpectedly read profile-only identities" >&2
    exit 1
fi
if "${profile_psql[@]}" -c 'SELECT * FROM tower_sessions.session' >/dev/null 2>&1; then
    echo "profile role unexpectedly read identity sessions" >&2
    exit 1
fi
if "${profile_psql[@]}" -c 'SELECT * FROM public.identity_session_index' >/dev/null 2>&1; then
    echo "profile role unexpectedly read the identity session index" >&2
    exit 1
fi
if "${identity_psql[@]}" -c \
    "INSERT INTO public.devserver_user_policies (user_id, enabled, max_connected_devservers) VALUES ('$test_user_id', true, 4)" \
    >/dev/null 2>&1; then
    echo "identity role unexpectedly wrote user policy" >&2
    exit 1
fi
if "${profile_psql[@]}" -c \
    'DELETE FROM public.devserver_fleet_policy WHERE singleton' >/dev/null 2>&1; then
    echo "profile role unexpectedly deleted fleet policy" >&2
    exit 1
fi

# An owner bypasses every ACL. Poison an expected table, prove reconciliation
# fails closed, then repair ownership as the migration owner.
psql "$DATABASE_URL" --no-password \
    -c 'ALTER TABLE public.api_tokens OWNER TO chan_gateway_identity' >/dev/null
if "$SCRIPT_DIR/reconcile-database-roles.sh" >/dev/null 2>&1; then
    echo "reconcile accepted an app-owned database object" >&2
    exit 1
fi
[[ $(psql "$DATABASE_URL" --no-password -Atqc \
    'SELECT migration_version FROM public.chan_gateway_deployment_state WHERE singleton') == -1 ]]
if DATABASE_URL="postgres://chan_gateway_profile:${PROFILE_DATABASE_PASSWORD}@127.0.0.1:5432/$EXPECTED_TEST_DATABASE" \
    "$SCRIPT_DIR/check-database-ready.sh" >/dev/null 2>&1; then
    echo "app readiness accepted a failed ownership reconcile" >&2
    exit 1
fi
psql "$DATABASE_URL" --no-password \
    -c 'ALTER TABLE public.api_tokens OWNER TO CURRENT_USER' >/dev/null
"$SCRIPT_DIR/reconcile-database-roles.sh" >/dev/null

# Schema drift invalidates readiness until the unexpected object is removed and
# the exact privilege reconcile succeeds again.
psql "$DATABASE_URL" --no-password -c 'CREATE TABLE public.rogue_table (id int)' >/dev/null
if "$SCRIPT_DIR/reconcile-database-roles.sh" >/dev/null 2>&1; then
    echo "reconcile accepted an unknown public table" >&2
    exit 1
fi
[[ $(psql "$DATABASE_URL" --no-password -Atqc \
    'SELECT migration_version FROM public.chan_gateway_deployment_state WHERE singleton') == -1 ]]
psql "$DATABASE_URL" --no-password -c 'DROP TABLE public.rogue_table' >/dev/null
"$SCRIPT_DIR/reconcile-database-roles.sh" >/dev/null

# Reconciliation replaces both missing and over-broad column grants.
psql "$DATABASE_URL" --no-password -X -v ON_ERROR_STOP=1 <<'SQL'
REVOKE UPDATE (updated_at) ON public.users, public.devserver_fleet_policy
    FROM chan_gateway_identity;
GRANT UPDATE (blocked_at) ON public.users TO chan_gateway_identity;
GRANT UPDATE (admissions_enabled) ON public.devserver_fleet_policy TO chan_gateway_identity;
SQL
"$SCRIPT_DIR/reconcile-database-roles.sh"
check_identity_mint_permissions

printf 'PASS: exact database-role prepare/reconcile contract\n'
