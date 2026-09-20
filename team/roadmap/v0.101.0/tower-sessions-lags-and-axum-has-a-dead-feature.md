# tower-sessions is held a release behind, and axum carries a feature nothing uses

Status: raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog. The code claims are a source reading against `main` at `fa0df75ad`. No registry was reachable from the reading host, so which releases exist today is unmeasured.

## What was seen

`gateway/Cargo.toml` holds `tower-sessions = "0.14"` beside `tower-sessions-sqlx-store = "0.15"`, with a comment giving the reason: the newest store release requires `tower-sessions-core ^0.14`, and both must resolve to one core or `PostgresStore` stops satisfying `SessionStore`. `gateway/Cargo.lock` has `tower-sessions` and `tower-sessions-core` at 0.14.0 and the store at 0.15.0. The pairing was the blocker when the gateway first wanted 0.15, and the comment carries no date or store version to say when it was last checked.

The `macros` feature of axum is enabled in both workspaces (`Cargo.toml`: `["ws", "macros", "multipart"]`; `gateway/Cargo.toml`: `["macros", "ws"]`) and used in neither: no `debug_handler`, no `FromRef` or `FromRequest` derive, no `#[axum::...]` attribute anywhere under `crates/`, `desktop/src-tauri/src/` or `gateway/crates/`. It keeps `axum-macros` in both lockfiles.

The root spec also leaks. `chan-tunnel-client` inherits axum with `workspace = true`, and the gateway consumes that crate by path, so the root's feature set, `multipart` included, is unified into gateway binaries that never parse a multipart body; its users are all under `crates/chan-server/`.

## Desired contract

Owner ruling, 2026-09-20: use the latest if possible, and clean up the debt too.

The gateway runs the newest tower-sessions a compatible Postgres store allows, and if that is still 0.14 the comment says which store release was checked and when. axum enables only the features something uses, and a crate the gateway consumes names its own axum features instead of inheriting the root's.

## Boundaries

`Cargo.toml`, `gateway/Cargo.toml`, `crates/chan-tunnel-client/Cargo.toml`, both lockfiles. A root `Cargo.lock` change moves the Nix cargo hash, which has to be harvested before landing. A tower-sessions major-minor bump can change cookie or record encoding, so signed-in sessions across the upgrade are part of the check, not an afterthought.

## Acceptance

1. The newest `tower-sessions` and `tower-sessions-sqlx-store` releases are recorded with the core each requires; the gateway moves to the newest compatible pair, or the comment is refreshed with the date and the versions checked.
2. If the pair moves: the identity Postgres tests pass, and a session created before the upgrade is either still valid after it or the release note says users sign in again.
3. `macros` is gone from both axum specs, `axum-macros` is gone from both lockfiles, and both workspaces build and pass clippy.
4. `cargo tree -e features` for a gateway binary no longer shows axum's `multipart`.
5. `make nix-hash-check` is green on the landed commit.
