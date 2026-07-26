#!/bin/sh
# Verify the migrated schema and apply the exact runtime privilege matrix.

set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${EXPECTED_SQLX_MIGRATION:?EXPECTED_SQLX_MIGRATION is required}"
: "${DATABASE_ROLE_POLICY_VERSION:?DATABASE_ROLE_POLICY_VERSION is required}"

case "$EXPECTED_SQLX_MIGRATION" in
    ''|*[!0-9]*) echo "EXPECTED_SQLX_MIGRATION must be a positive integer" >&2; exit 1 ;;
esac
case "$DATABASE_ROLE_POLICY_VERSION" in
    ''|*[!0-9]*) echo "DATABASE_ROLE_POLICY_VERSION must be a positive integer" >&2; exit 1 ;;
esac
[ "$EXPECTED_SQLX_MIGRATION" -gt 0 ] \
    || { echo "EXPECTED_SQLX_MIGRATION must be positive" >&2; exit 1; }
[ "$DATABASE_ROLE_POLICY_VERSION" -gt 0 ] \
    || { echo "DATABASE_ROLE_POLICY_VERSION must be positive" >&2; exit 1; }

# Invalidate outside the reconciliation transaction. A failed assertion must
# leave a durable not-ready marker rather than rolling an old ready row back in.
psql "$DATABASE_URL" --no-password --set=ON_ERROR_STOP=1 <<'SQL'
UPDATE public.chan_gateway_deployment_state SET
    migration_version = -1,
    role_policy_version = -1,
    reconciled_at = NULL
WHERE singleton;
SQL

psql "$DATABASE_URL" --no-password --set=ON_ERROR_STOP=1 \
    --set=expected_migration="$EXPECTED_SQLX_MIGRATION" \
    --set=role_policy_version="$DATABASE_ROLE_POLICY_VERSION" <<'SQL'
BEGIN;

SELECT set_config('chan.expected_migration', :'expected_migration', true);

DO $verify$
DECLARE
    actual_public_tables text[];
    actual_public_sequences text[];
    actual_session_tables text[];
    actual_session_sequences text[];
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public._sqlx_migrations
        WHERE version = current_setting('chan.expected_migration')::bigint AND success
    ) OR EXISTS (
        SELECT 1 FROM public._sqlx_migrations
        WHERE version > current_setting('chan.expected_migration')::bigint OR NOT success
    ) THEN
        RAISE EXCEPTION 'database is not exactly at successful sqlx migration %',
            current_setting('chan.expected_migration');
    END IF;

    SELECT array_agg(tablename ORDER BY tablename)
    INTO actual_public_tables
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_sqlx_migrations', 'chan_gateway_deployment_state');
    IF actual_public_tables IS DISTINCT FROM ARRAY[
        'api_token_audit', 'api_tokens', 'auth_audit',
        'control_revocation_jobs', 'devserver_fleet_policy', 'devserver_grants',
        'devserver_user_policies', 'devservers', 'feature_flag_overrides',
        'feature_flags', 'identities', 'identity_session_index', 'users'
    ]::text[] THEN
        RAISE EXCEPTION 'unexpected public table inventory: %', actual_public_tables;
    END IF;

    SELECT array_agg(sequencename ORDER BY sequencename)
    INTO actual_public_sequences
    FROM pg_sequences
    WHERE schemaname = 'public';
    IF actual_public_sequences IS DISTINCT FROM ARRAY[
        'api_token_audit_id_seq', 'auth_audit_id_seq'
    ]::text[] THEN
        RAISE EXCEPTION 'unexpected public sequence inventory: %', actual_public_sequences;
    END IF;

    SELECT array_agg(tablename ORDER BY tablename)
    INTO actual_session_tables
    FROM pg_tables
    WHERE schemaname = 'tower_sessions';
    IF actual_session_tables IS DISTINCT FROM ARRAY['session']::text[] THEN
        RAISE EXCEPTION 'unexpected tower_sessions table inventory: %', actual_session_tables;
    END IF;

    SELECT array_agg(sequencename ORDER BY sequencename)
    INTO actual_session_sequences
    FROM pg_sequences
    WHERE schemaname = 'tower_sessions';
    IF actual_session_sequences IS NOT NULL THEN
        RAISE EXCEPTION 'unexpected tower_sessions sequence inventory: %', actual_session_sequences;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        WHERE member.rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
    ) OR EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
          AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit
               OR rolreplication OR rolbypassrls)
    ) THEN
        RAISE EXCEPTION 'application database role has unsafe attributes or membership';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_default_acl defaults
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) exploded
        JOIN pg_roles grantee ON grantee.oid = exploded.grantee
        WHERE grantee.rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
    ) THEN
        RAISE EXCEPTION 'application role appears in default privileges';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_database database
        JOIN pg_roles owner ON owner.oid = database.datdba
        WHERE database.datname = current_database()
          AND owner.rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
    ) OR EXISTS (
        SELECT 1 FROM pg_namespace namespace
        JOIN pg_roles owner ON owner.oid = namespace.nspowner
        WHERE owner.rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
    ) OR EXISTS (
        SELECT 1 FROM pg_class relation
        JOIN pg_roles owner ON owner.oid = relation.relowner
        WHERE owner.rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
    ) OR EXISTS (
        SELECT 1 FROM pg_proc function
        JOIN pg_roles owner ON owner.oid = function.proowner
        WHERE owner.rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
    ) OR EXISTS (
        SELECT 1 FROM pg_type type
        JOIN pg_roles owner ON owner.oid = type.typowner
        WHERE owner.rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
    ) OR EXISTS (
        SELECT 1 FROM pg_extension extension
        JOIN pg_roles owner ON owner.oid = extension.extowner
        WHERE owner.rolname IN ('chan_gateway_identity', 'chan_gateway_profile')
    ) THEN
        RAISE EXCEPTION 'application database role owns an object';
    END IF;
END
$verify$;

REVOKE ALL ON SCHEMA public, tower_sessions
    FROM PUBLIC, chan_gateway_identity, chan_gateway_profile;
REVOKE ALL ON ALL TABLES IN SCHEMA public, tower_sessions
    FROM PUBLIC, chan_gateway_identity, chan_gateway_profile;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, tower_sessions
    FROM PUBLIC, chan_gateway_identity, chan_gateway_profile;

GRANT USAGE ON SCHEMA public TO chan_gateway_identity, chan_gateway_profile;
GRANT USAGE ON SCHEMA tower_sessions TO chan_gateway_identity;

-- identity-service: PAT lifecycle, admission policy reads, and its private
-- OAuth-session index/store.
GRANT SELECT ON
    public.users, public.api_tokens, public.api_token_audit,
    public.devserver_fleet_policy, public.devserver_user_policies
    TO chan_gateway_identity;
GRANT INSERT, UPDATE ON public.api_tokens TO chan_gateway_identity;
GRANT INSERT ON public.api_token_audit TO chan_gateway_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.identity_session_index
    TO chan_gateway_identity;
GRANT USAGE ON SEQUENCE public.api_token_audit_id_seq TO chan_gateway_identity;
GRANT SELECT, INSERT, UPDATE, DELETE ON tower_sessions.session
    TO chan_gateway_identity;

-- profile-service: domain data and operator audit, but never sessions.
GRANT SELECT ON
    public.users, public.identities, public.api_tokens, public.api_token_audit,
    public.auth_audit, public.control_revocation_jobs, public.devservers,
    public.devserver_fleet_policy, public.devserver_grants,
    public.devserver_user_policies, public.feature_flags,
    public.feature_flag_overrides
    TO chan_gateway_profile;
GRANT INSERT, UPDATE, DELETE ON public.users TO chan_gateway_profile;
GRANT INSERT ON public.identities TO chan_gateway_profile;
GRANT UPDATE ON public.api_tokens TO chan_gateway_profile;
GRANT INSERT ON public.api_token_audit, public.auth_audit TO chan_gateway_profile;
GRANT INSERT, UPDATE, DELETE ON
    public.control_revocation_jobs, public.devservers, public.devserver_grants,
    public.feature_flags, public.feature_flag_overrides
    TO chan_gateway_profile;
GRANT INSERT, UPDATE ON
    public.devserver_fleet_policy, public.devserver_user_policies
    TO chan_gateway_profile;
GRANT USAGE ON SEQUENCE
    public.api_token_audit_id_seq, public.auth_audit_id_seq
    TO chan_gateway_profile;

-- Both app roles can read only the dedicated rollout marker. The sqlx history
-- table remains owner-only.
GRANT SELECT ON public.chan_gateway_deployment_state
    TO chan_gateway_identity, chan_gateway_profile;
REVOKE ALL ON public._sqlx_migrations
    FROM PUBLIC, chan_gateway_identity, chan_gateway_profile;

UPDATE public.chan_gateway_deployment_state SET
    migration_version = :'expected_migration'::bigint,
    role_policy_version = :'role_policy_version'::bigint,
    reconciled_at = now()
WHERE singleton;

COMMIT;
SQL
