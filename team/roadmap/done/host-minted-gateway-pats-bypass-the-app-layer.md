# Host-minted gateway PATs bypass the app layer

> Status: SHIPPED in [v0.94.0](../../release/release-v0.94.0.md). Implemented and verified ahead of the round on `fix/gateway-admin-mint` and chan-prod-setup `main` (`90f09d0`, `6b216be`, `4512bd9`), landed by merging the branch; the round reran the postgres-backed suites against the merged tree (all four `admin_revoke_*` tests green by name) and gateway-zone's ctrlplane scenario. The deploy half stays the host's post-GA actions: `make admin-install` the wrapper on the prod host and rotate the two live devserver PATs onto expiring credentials.

Companion evidence: finding N3 of the 2026-08-18 security review (tracked in chan-prod-setup alongside the 2026-08-08 review).

## Observed behavior

`chan-gateway-admin mint` on the prod host wrote raw SQL into the gateway's Postgres as the `chan` DB role: an `api_tokens` row with `expires_at NULL` and argv's `$label` interpolated into the SQL string, plus a hand-rolled `devservers` row. `revoke` interpolated `$id` the same way. The wrapper's own comment justified the DB path with "there is NO admin API to create a PAT", which stopped being true at v0.68.0 (`01e984ad` shipped `POST /admin/v1/tokens`), and its README said "there is no admin mint" while documenting the `mint` subcommand.

The cost, in order of weight:

1. Every fleet credential was a permanent bearer; no TTL backstop.
2. The insert bypassed `ApiTokenService::create`'s policy gates: a mint could succeed for a blocked user, during a fleet admissions pause, or against a denying per-user devserver policy.
3. No `api_token_audit` row on mint, and none on the DB-path revoke.
4. Token internals (secret shape, hash, devserver id) were re-implemented in shell and had to stay byte-compatible with `identity/src/api_tokens.rs` by hand.
5. The `$label`/`$id` interpolation was SQL injection (root-gated, so low severity; gratuitous all the same).

Found on the way, and fixed in the same change:

- Profile has had an admin revoke-by-id (`POST /v1/admin/tokens/{id}/revoke`) since before the monorepo migration (`92d67fd9`, first tagged v0.19.0). Both the security review and this repo's own wrapper assumed no admin revoke existed; the review's proposed fix (psql `-v` binding) was also unrunnable, because psql does not interpolate variables into `-c` strings.
- The Rust CLI's `token revoke` expected 204 from a profile handler that answers (and whose own test asserts) 202, so every successful revoke was reported as an upstream error.
- Operator revokes were audited as `revoked`, indistinguishable from the owner's own action in the token's audit view.

## Contract

- Host tooling never writes gateway tables. `mint` calls identity's `POST /admin/v1/tokens` and sends `expires_days` by default (90, arg or `CHAN_MINT_EXPIRES_DAYS` override); the API treats absence as never-expires, and the wrapper omits it only when the caller spells the literal `never` in the days slot (chan-prod-setup `4512bd9`) -- permanence stays available, but never silent. `revoke` calls profile's `POST /v1/admin/tokens/{id}/revoke`.
- Operator revoke is audit-truthful: profile's admin surface writes `revoked_via_admin`, so an owner reading their token audit can tell an operator's revoke from their own.
- Operator revoke reaches parity with self-revoke: identity's new `POST /admin/v1/tokens/{token_id}/revoke` (operator_admin tree, `IDENTITY_ADMIN_TOKEN`) resolves the owner by token id, drives profile's durable boundary, then makes the same best-effort immediate owner-tunnel/session cut as `DELETE /api/tokens/{id}`, answering 202.
- The Rust CLI's `token revoke` succeeds on the 202 the server answers.

## Boundaries

- The SPA and desktop mint paths and the session-authed self-revoke are untouched.
- The admin mint API keeps absent-`expires_days` = never-expires (a deliberate operator-surface semantic); the default-expiry rule and the explicit `never` opt-out live in the wrapper.
- The wrapper's `revoke` targets profile's existing route, not identity's new one, so the deployed pre-v0.94.0 gateway serves it today. Pointing the wrapper at identity's route, to gain the immediate cut, is a post-release follow-up.
- Rotation of the two live (permanent) devserver PATs is an ops task at deploy time, not part of this change.

## Acceptance checks

1. Identity operator revoke: postgres-backed suite green -- `admin_revoke_hits_profile_and_is_retry_safe` (asserts the exact profile-boundary call and the idempotent retry), `admin_revoke_unknown_token_is_404` (owner lookup gates the forward), `admin_revoke_requires_the_exact_bearer`, `admin_revoke_disabled_surface_is_404` (`gateway/crates/identity/tests/admin_tokens.rs`), plus the operator route in the wrong-tier matrix (`tests/auth.rs`).
2. Audit truthfulness: `admin_token_revoke_and_audit` (`gateway/crates/profile/tests/api.rs`) asserts 202, action `revoked_via_admin`, no duplicate audit row on retry, 404 unknown id.
3. Route/doc parity: `identity/README.md` and `identity/design.md` carry the new route in the same commit; `profile/design.md`'s audit-action invariant lists `revoked_via_admin`.
4. Wrapper: `bin/chan-gateway-admin` (chan-prod-setup `90f09d0` mint, `6b216be` revoke, `4512bd9` never opt-out) contains no psql/DB path; shellcheck 0.11.0 clean at style severity; adversarial sweep rejected `0`, `-1`, `abc`, `1e3`, `Never`, `forever` in the days slot, accepted only the literal `never` for permanence, and JSON-encoded an injection-shaped label through jq.
5. Gateway gate on the final tree, in the per-worktree sdme container (Postgres 18 local service, `TEST_DATABASE_URL` set): SPA build + svelte-check 0 errors, `cargo fmt --check` clean, `cargo clippy --all-targets -- -D warnings` clean, `cargo test` -- see the verification section.

## Verification

Container `chan-gw` (rootfs `chan-ann-ubuntu`, btrfs, userns), worktree bound rw at its real path with the main checkout's `.git` bound read-only alongside, toolchain 1.95.0 per the repo pin, local Postgres 18 with `TEST_DATABASE_URL=postgres://chan:chan@127.0.0.1:5432/chan_gateway_test`. Against the final tree:

- `npm ci`, `npm run build -w @chan/profile`, `npm run check -w @chan/profile`: built; svelte-check 0 errors, 0 warnings.
- `cargo fmt --check`: clean.
- `RUSTFLAGS="-D warnings" cargo clippy --all-targets -- -D warnings`: clean.
- `RUSTFLAGS="-D warnings" cargo test`: 25 test binaries, every one `test result: ok` -- 488 passed, 0 failed. The four new `admin_revoke_*` tests and profile's updated `admin_token_revoke_and_audit` are present by name in the run log; the profile test asserts the new `revoked_via_admin` action, so it fails against the pre-change handler and the run demonstrably discriminates.
- `cargo build -p profile -p identity -p devserver-proxy -p devserver-control -p admin`: green.

The CLI `token revoke` status fix has no test harness in the admin crate; it is covered by compile plus profile's 202-asserting handler test, named here so the gap is explicit rather than implied.
