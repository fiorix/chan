# Gateway tests compile everywhere and execute only on `main`

Status: REGISTERED for v0.86.0, grounded 2026-08-06 during the v0.85.0 delivery round.

## What

Nothing local runs the gateway's tests. `make pre-push` reaches the nested `gateway/` workspace three times, and all three are static:

```
Makefile:330   gateway-fmt     cd gateway && cargo fmt --check
Makefile:344   gateway-lint    cd gateway && clippy --all-targets -- -D warnings
Makefile:336   gateway-build   cd gateway && cargo build <release crates>
```

`gateway-lint` passes `--all-targets`, so test files are compiled and type-checked. No target executes them, and `grep 'cd gateway' Makefile` returns those three plus `cargo clean`.

The gateway's tests run in exactly one place, `.github/workflows/gateway-ci.yml:111`. Its triggers are a push to `main` under `gateway/**` and a pull request under the same paths. A branch that changes gateway code and is delivered by a branch push, without a PR, therefore ships assertions that were compiled and never executed.

## Why it has not been noticed

The arrangement is deliberate and documented: the gateway is a separate nested workspace, Postgres-backed and server-side only, so the root `ci.yml` carries a mirror-image `paths-ignore` and never builds it. The split is correct. What is missing is the case where gateway code reaches the owner on a path that is neither `main` nor a PR.

The static checks also make the gap hard to see from the gate output. Formatting, lints, and compilation of the gateway all appear in a green `make pre-push`, so the gateway looks covered to the same standard as the root workspace. The difference is precisely the part that executes.

## Verified current state (2026-08-06)

The v0.85.0 delivery round changed real gateway code: `config.rs`, `proxy.rs`, and `tests/api.rs` in `devserver-proxy`, adding a distinct transfer class with its own caps. The round's authorized delivery is a push to a non-`main` branch with no PR, so neither trigger fires.

Those assertions were executed once, by hand, outside any gate:

```
cargo test -p devserver-proxy      69 passed (lib), 50 passed (tests/api.rs), 0 failed
```

Both transfer-class assertions are among them and both pass. The record is a one-off run by the round's lead, not a check any path repeats.

The whole-workspace `cargo test` that CI runs cannot be the local answer as it stands. `gateway/crates/identity/tests/admin_tokens.rs:50` requires `TEST_DATABASE_URL` and panics without it, so on a developer machine with no Postgres the command fails for reasons unrelated to the change under test. That is the constraint any fix has to handle, and it is the likely reason no such target was ever written.

## Contract

- Gateway code that reaches the owner has its tests executed on the path that delivers it, not only on the path that merges it.
- A local target that runs gateway tests either provides the database the identity tests need, or scopes to the crates that do not need one and says which it is doing.
- A database-backed test that does not run is reported as not run. It is never counted as a pass, and a green summary never covers a suite that was skipped.

## Acceptance

- A branch touching `gateway/` produces an executed test record for the gateway crates it changes, before the owner is asked to accept it.
- The chosen path is proven able to fail: break one gateway assertion on purpose, watch it go red, then restore it. A target that cannot go red is not coverage, which is the standard the rest of this round's checks were held to.
- On a machine with no Postgres the target either passes with the database-backed tests explicitly reported as not run, or fails with a message naming `TEST_DATABASE_URL`. It does not fail with a sqlx connection error that reads as a broken change.
- The gateway steps in `make pre-push` state which of them execute and which only compile, so a green gate does not imply more than it checked.

## Rough size

Small. The decision of where execution belongs, a local target against a throwaway Postgres or a widened workflow trigger, is most of the work; the mechanics of either are short.
