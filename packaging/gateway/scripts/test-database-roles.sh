#!/usr/bin/env bash
# Destructive integration test for prepare/reconcile against an isolated DB.
#
# Two routes run it, on two PostgreSQL majors. Gateway CI runs it against a
# postgres:16 service container, the major the Kubernetes manifests deploy.
# `make gateway-database-roles-test` runs it in the chan-psql sdme guest, which
# installs PostgreSQL 18, so a local green certifies 18 alone. The privilege
# reads stay on what both majors share: the ACL columns of pg_namespace,
# pg_class and pg_attribute through aclexplode. From 17 on a table also has
# MAINTAIN; the matrix never names it, so it can only be reported as extra.

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

# Every privilege reconcile-database-roles.sh grants, and the rollout marker's
# SELECT that prepare-database-roles.sh grants first, one line per grantee and
# object. The list is exact in both directions: each privilege named here must
# be granted, and the two application roles and PUBLIC must hold nothing else
# on any schema, table, column or sequence of the two schemas. A grant the
# gateway gains or loses changes here and in the reconcile script together.
role_matrix() {
    cat <<'MATRIX'
chan_gateway_identity schema public USAGE
chan_gateway_identity schema tower_sessions USAGE
chan_gateway_identity table public.api_token_audit SELECT,INSERT
chan_gateway_identity table public.api_tokens SELECT,INSERT,UPDATE
chan_gateway_identity table public.chan_gateway_deployment_state SELECT
chan_gateway_identity table public.devserver_fleet_policy SELECT
chan_gateway_identity table public.devserver_user_policies SELECT
chan_gateway_identity table public.identity_session_index SELECT,INSERT,UPDATE,DELETE
chan_gateway_identity table public.users SELECT
chan_gateway_identity table tower_sessions.session SELECT,INSERT,UPDATE,DELETE
chan_gateway_identity column public.devserver_fleet_policy.updated_at UPDATE
chan_gateway_identity column public.users.updated_at UPDATE
chan_gateway_identity sequence public.api_token_audit_id_seq USAGE
chan_gateway_profile schema public USAGE
chan_gateway_profile table public.api_token_audit SELECT,INSERT
chan_gateway_profile table public.api_tokens SELECT,UPDATE
chan_gateway_profile table public.auth_audit SELECT,INSERT
chan_gateway_profile table public.chan_gateway_deployment_state SELECT
chan_gateway_profile table public.control_revocation_jobs SELECT,INSERT,UPDATE,DELETE
chan_gateway_profile table public.devserver_fleet_policy SELECT,INSERT,UPDATE
chan_gateway_profile table public.devserver_grants SELECT,INSERT,UPDATE,DELETE
chan_gateway_profile table public.devserver_user_policies SELECT,INSERT,UPDATE
chan_gateway_profile table public.devservers SELECT,INSERT,UPDATE,DELETE
chan_gateway_profile table public.feature_flag_overrides SELECT,INSERT,UPDATE,DELETE
chan_gateway_profile table public.feature_flags SELECT,INSERT,UPDATE,DELETE
chan_gateway_profile table public.identities SELECT,INSERT
chan_gateway_profile table public.users SELECT,INSERT,UPDATE,DELETE
chan_gateway_profile table public.wireguard_peers SELECT,INSERT,UPDATE,DELETE
chan_gateway_profile sequence public.api_token_audit_id_seq USAGE
chan_gateway_profile sequence public.auth_audit_id_seq USAGE
MATRIX
}

# What the two application roles and PUBLIC are granted in the two schemas, as
# "grantee kind object privilege" lines read from the catalog's ACLs. One
# privilege per line: has_table_privilege with a comma list answers true when
# any one of the listed privileges is held, so it cannot show that all are.
# The application roles own nothing and belong to no role (reconcile refuses
# both), so their ACL entries and PUBLIC's are everything they can use.
granted_privileges() {
    psql "$DATABASE_URL" --no-password -X -v ON_ERROR_STOP=1 -Atq <<'SQL'
SELECT granted.grantee || ' ' || granted.kind || ' ' || granted.object
    || ' ' || granted.privilege
FROM (
    SELECT CASE WHEN entry.grantee = 0 THEN 'PUBLIC'
                ELSE pg_get_userbyid(entry.grantee)::text END AS grantee,
           acl.kind,
           acl.object,
           entry.privilege_type
               || CASE WHEN entry.is_grantable THEN ' WITH GRANT OPTION'
                       ELSE '' END AS privilege
    FROM (
        SELECT 'schema' AS kind, nspname::text AS object, nspacl AS acl
        FROM pg_namespace
        WHERE nspname IN ('public', 'tower_sessions')
        UNION ALL
        SELECT CASE relkind WHEN 'S' THEN 'sequence' ELSE 'table' END,
               nspname || '.' || relname, relacl
        FROM pg_class
        JOIN pg_namespace ON pg_namespace.oid = relnamespace
        WHERE nspname IN ('public', 'tower_sessions')
        UNION ALL
        SELECT 'column', nspname || '.' || relname || '.' || attname, attacl
        FROM pg_attribute
        JOIN pg_class ON pg_class.oid = attrelid
        JOIN pg_namespace ON pg_namespace.oid = relnamespace
        WHERE nspname IN ('public', 'tower_sessions')
    ) AS acl
    CROSS JOIN LATERAL aclexplode(acl.acl) AS entry
) AS granted
WHERE granted.grantee IN ('PUBLIC', 'chan_gateway_identity', 'chan_gateway_profile');
SQL
}

# Compare the granted privileges with the matrix and name every difference.
# It returns instead of relying on errexit, which is off when the caller tests
# its status.
check_role_matrix() {
    local expected granted grantee kind object privilege failed=0
    expected=$(role_matrix \
        | awk '{ count = split($4, names, ","); for (i = 1; i <= count; i++) print $1, $2, $3, names[i] }' \
        | LC_ALL=C sort) || return 1
    if ! granted=$(granted_privileges 2>&1); then
        printf 'FAIL: the granted privileges could not be read\n%s\n' "$granted" >&2
        return 1
    fi
    granted=$(LC_ALL=C sort -u <<< "$granted") || return 1
    while read -r grantee kind object privilege; do
        [[ -n $grantee ]] || continue
        printf 'FAIL: %s lacks %s on %s %s\n' \
            "$grantee" "$privilege" "$kind" "$object" >&2
        failed=1
    done < <(LC_ALL=C comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$granted"))
    while read -r grantee kind object privilege; do
        [[ -n $grantee ]] || continue
        printf 'FAIL: %s holds %s on %s %s, which the role matrix does not grant\n' \
            "$grantee" "$privilege" "$kind" "$object" >&2
        failed=1
    done < <(LC_ALL=C comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$granted"))
    [[ $failed == 0 ]] || return 1
    printf 'PASS: role privilege matrix is exact: %s privileges on %s objects\n' \
        "$(wc -l <<< "$expected")" "$(role_matrix | wc -l)"
}

# An impossible target must fail and leave the durable marker invalid.
if EXPECTED_SQLX_MIGRATION=$((latest_migration + 1)) \
    "$SCRIPT_DIR/reconcile-database-roles.sh" >/dev/null 2>&1; then
    echo "reconcile accepted a missing latest migration" >&2
    exit 1
fi
[[ $(psql "$DATABASE_URL" --no-password -Atqc \
    'SELECT migration_version FROM public.chan_gateway_deployment_state WHERE singleton') == -1 ]]

"$SCRIPT_DIR/reconcile-database-roles.sh"

check_role_matrix

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

# A refusal counts only as SQLSTATE 42501, insufficient privilege. Any other
# error (a constraint, a missing object, a lost connection) says nothing about
# the grant. The statement runs in a transaction that is rolled back, so one
# that is wrongly permitted leaves nothing behind.
assert_denied() {
    local role=$1 name=$2 sql=$3 result status
    local -a role_psql
    case $role in
        identity) role_psql=("${identity_psql[@]}") ;;
        profile) role_psql=("${profile_psql[@]}") ;;
        *) printf 'FAIL: no psql connection for role %s\n' "$role" >&2; return 1 ;;
    esac
    if result=$("${role_psql[@]}" -X -v ON_ERROR_STOP=1 \
        -v VERBOSITY=verbose -Atqc "BEGIN; $sql; ROLLBACK" 2>&1); then
        printf 'FAIL: %s was permitted: %s\n' "$role" "$name" >&2
        return 1
    else
        status=$?
    fi
    if ! grep -Eq '^ERROR:[[:space:]]+42501:' <<< "$result"; then
        printf 'FAIL: %s %s denial was not SQLSTATE 42501 (rc=%s)\n%s\n' \
            "$role" "$name" "$status" "$result" >&2
        return 1
    fi
    printf 'PASS: %s %s denied with SQLSTATE 42501\n' "$role" "$name"
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

    assert_denied identity 'users.blocked_at update' \
        "UPDATE public.users SET blocked_at = now() WHERE id = '$test_user_id'"
    assert_denied identity 'devserver_fleet_policy.admissions_enabled update' \
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
# A second user that never gets a policy row, for the policy insert identity
# must be refused: against the first user that insert would hit the primary key
# whatever identity is granted.
unprovisioned_user_id=00000000-0000-0000-0000-000000000003
"${profile_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO public.users (id, email, username) VALUES ('$test_user_id', 'role-test@example.com', 'role-test'), ('$unprovisioned_user_id', 'role-test-unprovisioned@example.com', 'role-test-unprovisioned')" \
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

# Identity mints, uses and revokes a token and writes its audit rows, whose
# ids come from the sequence.
test_token_id=00000000-0000-0000-0000-000000000002
"${identity_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO public.api_tokens (id, user_id, label, token_hash) VALUES ('$test_token_id', '$test_user_id', 'wireguard', 'role-test-token-digest')" \
    -c "INSERT INTO public.api_token_audit (token_id, action) VALUES ('$test_token_id', 'created')" \
    -c "UPDATE public.api_tokens SET last_used_at = now() WHERE id = '$test_token_id'" \
    -c "UPDATE public.api_tokens SET revoked_at = now() WHERE id = '$test_token_id'" \
    -c "INSERT INTO public.api_token_audit (token_id, action) VALUES ('$test_token_id', 'revoked')"
"${identity_psql[@]}" -Atqc \
    "SELECT count(*) FROM public.api_token_audit WHERE token_id = '$test_token_id'" \
    | grep -qx 2
"${profile_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO public.wireguard_peers (user_id, token_id, host, public_key, address_v4) VALUES ('$test_user_id', '$test_token_id', 'p1', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', '10.7.0.2')" \
    -c "UPDATE public.wireguard_peers SET address_v4 = '10.7.0.3' WHERE token_id = '$test_token_id'"
"${profile_psql[@]}" -Atqc \
    "SELECT address_v4 FROM public.wireguard_peers WHERE token_id = '$test_token_id'" \
    | grep -qx '10.7.0.3'
"${profile_psql[@]}" -v ON_ERROR_STOP=1 \
    -c "DELETE FROM public.wireguard_peers WHERE token_id = '$test_token_id'"

assert_denied identity 'read of profile-only WireGuard peers' \
    'SELECT * FROM public.wireguard_peers'
assert_denied identity 'table creation' 'CREATE TABLE public.forbidden (id int)'
assert_denied identity 'read of the sqlx migration history' \
    'SELECT * FROM public._sqlx_migrations'
assert_denied identity 'read of profile-only identities' \
    'SELECT * FROM public.identities'
assert_denied profile 'read of identity sessions' \
    'SELECT * FROM tower_sessions.session'
assert_denied profile 'read of the identity session index' \
    'SELECT * FROM public.identity_session_index'
assert_denied profile 'fleet policy delete' \
    'DELETE FROM public.devserver_fleet_policy WHERE singleton'
# Profile holds the grant and its insert goes through, so identity's refusal of
# the same statement is the missing grant and not a constraint.
policy_insert="INSERT INTO public.devserver_user_policies (user_id, enabled, max_connected_devservers) VALUES ('$unprovisioned_user_id', true, 4)"
"${profile_psql[@]}" -X -v ON_ERROR_STOP=1 -q -c "BEGIN; $policy_insert; ROLLBACK"
assert_denied identity 'user policy insert' "$policy_insert"

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

# Reconciliation replaces missing and over-broad grants of every kind. Drift
# one of each first and require the matrix check to name exactly those, which
# proves on every run, on either major, that the check can fail.
psql "$DATABASE_URL" --no-password -X -q -v ON_ERROR_STOP=1 <<'SQL'
REVOKE UPDATE ON public.api_tokens FROM chan_gateway_identity;
GRANT DELETE ON public.api_tokens TO chan_gateway_identity;
GRANT SELECT ON public._sqlx_migrations TO PUBLIC;
GRANT CREATE ON SCHEMA public TO chan_gateway_profile;
REVOKE USAGE ON SEQUENCE public.auth_audit_id_seq FROM chan_gateway_profile;
REVOKE UPDATE (updated_at) ON public.users, public.devserver_fleet_policy
    FROM chan_gateway_identity;
GRANT UPDATE (blocked_at) ON public.users TO chan_gateway_identity;
GRANT UPDATE (admissions_enabled) ON public.devserver_fleet_policy TO chan_gateway_identity;
SQL
expected_drift='FAIL: chan_gateway_identity lacks UPDATE on column public.devserver_fleet_policy.updated_at
FAIL: chan_gateway_identity lacks UPDATE on column public.users.updated_at
FAIL: chan_gateway_identity lacks UPDATE on table public.api_tokens
FAIL: chan_gateway_profile lacks USAGE on sequence public.auth_audit_id_seq
FAIL: PUBLIC holds SELECT on table public._sqlx_migrations, which the role matrix does not grant
FAIL: chan_gateway_identity holds UPDATE on column public.devserver_fleet_policy.admissions_enabled, which the role matrix does not grant
FAIL: chan_gateway_identity holds UPDATE on column public.users.blocked_at, which the role matrix does not grant
FAIL: chan_gateway_identity holds DELETE on table public.api_tokens, which the role matrix does not grant
FAIL: chan_gateway_profile holds CREATE on schema public, which the role matrix does not grant'
if drift=$(check_role_matrix 2>&1); then
    printf 'FAIL: the role matrix check passed over drifted grants\n%s\n' "$drift" >&2
    exit 1
fi
if [[ $drift != "$expected_drift" ]]; then
    printf 'FAIL: the role matrix check did not name exactly the drifted grants\n%s\n' "$drift" >&2
    exit 1
fi
printf 'PASS: the role matrix check names every drifted grant\n'
"$SCRIPT_DIR/reconcile-database-roles.sh"
check_role_matrix
check_identity_mint_permissions

printf 'PASS: exact database-role prepare/reconcile contract\n'
