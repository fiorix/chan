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
export DATABASE_ROLE_POLICY_VERSION=1

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
"${identity_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO public.identity_session_index (user_id, store_id, authenticated_at) VALUES ('$test_user_id', 'role-test-session', now())" \
    -c "UPDATE public.identity_session_index SET authenticated_at = now() WHERE store_id = 'role-test-session'" \
    -c "DELETE FROM public.identity_session_index WHERE store_id = 'role-test-session'"

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

printf 'PASS: exact database-role prepare/reconcile contract\n'
