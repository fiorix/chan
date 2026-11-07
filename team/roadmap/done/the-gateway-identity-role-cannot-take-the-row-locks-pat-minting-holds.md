# The gateway identity role cannot take the row locks PAT minting holds

Status: shipped in [v0.125.0](../../release/release-v0.125.0.md).

Record before the release: raised on 2026-11-06 by the release's live enrollment proof, the first run of the packaged database role policy against the real token mint; accepted for v0.125.0 by the owner the same day; built, and carried in the first release candidate `0.125.0-rc0` (`67fd26b38`).

## What is there now

A desktop sign-in ends at the consent confirmation with a 500. identity's log reads `desktop authorize mint failed ... permission denied for table users` (SQLSTATE 42501). The PAT mint (`gateway/crates/identity/src/api_tokens.rs`) locks the user's row with `SELECT ... FROM users WHERE id = $1 FOR UPDATE` and the fleet policy row with `FOR SHARE` before it writes the token. The packaged role policy (`packaging/gateway/scripts/reconcile-database-roles.sh`) grants `chan_gateway_identity` SELECT alone on `users` and `devserver_fleet_policy`, and PostgreSQL denies every row-lock clause (`FOR UPDATE`, `NO KEY UPDATE`, `SHARE`, `KEY SHARE`) to a role with no UPDATE privilege on at least one column of the table. A gateway deployed with the packaged policy has therefore answered 500 to every desktop authorize since the locks and the policy were written in July; the gateway's Postgres-backed tests run as the database owner and cannot see it, and the first run of the packaged policy against the real mint was the release's enrollment proof against a kernel WireGuard peer.

## Desired contract

1. identity can take both row locks the mint holds and can write only the two tables' `updated_at` columns; it cannot change account state (`users.blocked_at`) or admission policy (`devserver_fleet_policy.admissions_enabled`).
2. The packaged role policy carries that grant as version 2 at schema migration 17: the reconcile script, the env templates, the postinst checks, `configure.sh` and the Kubernetes reconciliation ConfigMap all agree, and the ConfigMap's embedded copy of the reconcile script equals the packaged one.
3. An existing deployment sets `DATABASE_ROLE_POLICY_VERSION=2` and `EXPECTED_SQLX_MIGRATION=17` in `migrate.env`, `identity.env` and `profile.env` before the new packages install, because the postinst scripts reject policy version 1; after the install it restarts the migration unit, then identity and profile. The gateway README says so.

## Boundaries

- The mint's SQL does not change; the grant is the narrowest that lets its locks through, column-level UPDATE on `updated_at` alone.
- The policy version moves once, to 2; no other grant changes; no new dependency.

## Acceptance

1. The roles suite, run as the reconciled identity role against a database: both locks denied with 42501 under policy 1 and taken under policy 2; the exact column grants; `UPDATE` of `blocked_at` and `admissions_enabled` denied; a timestamp update rolled back; the grants reapplied after a drift (the timestamp grants removed and the two forbidden column grants added by hand, then the real reconcile).
2. `make gateway-packaging-isolation-test` (the package orders, the static contract, the real postinsts against the packaged env files) and `packaging/kube/test-manifests.py` green at the tip.
3. The live proof database moved from its interim hand grants to policy 2 by the packaged reconcile, read back by column ACLs, and the enrollment walk green against it.

## Built

- `4f56baa90` on `fix/gateway-identity-role-locks` (fourteen files, no Rust change), merged `--no-ff` into the integration branch as `56d69dcda`: `GRANT UPDATE (updated_at) ON public.users, public.devserver_fleet_policy TO chan_gateway_identity` after the table-level revoke in the reconcile script; every policy-version pin from 1 to 2 (the env files, both postinsts, `configure.sh`, the static packaging contract, the roles suite, the kube ConfigMap and its test), the ConfigMap's embedded reconcile copy synchronized with the packaged script; the README's upgrade sentence.
- The roles suite in an isolated PostgreSQL guest with its own throwaway cluster: red at a test-only snapshot of the new tests on policy 1 (`FAIL: identity user FOR UPDATE` and `FAIL: identity fleet FOR SHARE`, both `permission denied`, SQLSTATE 42501), green at `4f56baa90` with both lock PASS lines, both column-denial PASS lines, the timestamp-only update and rollback, all five again after the drift repair, then the exact prepare and reconcile contract. `git diff --check`, `make shell-check workflow-check`, `make gateway-packaging-isolation-test` and `python3 -I packaging/kube/test-manifests.py` rc=0 at the tip.
- The proof database: the two interim column grants (`users.blocked_at`, `devserver_fleet_policy.admissions_enabled`) revoked and the packaged reconcile run with migration 17 and policy 2; afterwards the identity role could write only the two `updated_at` columns, and the deployment state read migration 17, policy 2, reconciled.
