# tower-sessions is held a release behind, and axum carries a feature nothing uses

Status: shipped in [v0.101.0](../../release/release-v0.101.0.md).

Record before the release: accepted for v0.101.0 by the owner on 2026-09-25; raised for v0.101.0 on the owner's instruction, 2026-09-20, from the development archive's pre-v0.68 backlog. The code claims are a source reading against `main` at `fa0df75ad`. No registry was reachable from the reading host, so which releases exist today is unmeasured.

## Owner ruling

Accepted on 2026-09-25 as the lead recommended, in one dependency lane with [two-exact-pins-hold-back-web-upgrades](two-exact-pins-hold-back-web-upgrades.md), which lands with its Nix hashes re-harvested.

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

## What shipped

Built and accepted on 2026-10-01, on a branch of its own and, until 2026-10-02, on no integration branch: three commits in `Cargo.toml`, `crates/chan-tunnel-client/Cargo.toml`, `gateway/Cargo.toml` and both lock files, nothing else. The root `Cargo.lock` moves, so the Nix `cargoHash` must be harvested and pinned before the range lands, by the owner, for the reason the two exact pins' item gives ([two-exact-pins-hold-back-web-upgrades](two-exact-pins-hold-back-web-upgrades.md)); until then the range stays out of every integration, and its own gate was green but for the Nix hash check, red as ordered.

- **axum's `macros` feature is gone from both specs** and `axum-macros` from both locks; a search for `debug_handler` and the `FromRef`, `FromRequest` and `FromRequestParts` derives under the crates, the gateway and the desktop finds nothing, read by the lead.
- **`chan-tunnel-client` names its own axum,** `0.8` with default features off and a comment that says why, so the gateway's binaries no longer inherit the root's `multipart`: `multer` leaves the gateway's lock, and the gateway binary's feature tree carries no `multipart`.
- **The tower-sessions pair stays at 0.14 with the store at 0.15,** and the comment is dated 2026-10-01 with both newest releases' core requirements: tower-sessions 0.15.0 needs the core at exactly 0.15.0 while the SQLx store 0.15.0 needs it at 0.14, so no newer compatible pair exists.

The identity's Postgres tests and the gateway's unit tests passed in a PostgreSQL the lane installed in the guest; no session dependency moved, so no changelog entry is owed and the acceptance's second point does not apply. The first, third and fourth points are met; the fifth waited on the hash and is met at the integration's tip (below). Residual: the tunnel client's `default-features = false` is proved by the gateway workspace's build and lint, which build the crate without chan-server, where the root workspace's feature unification could hide a missing default.

**On the integration branch since 2026-10-02,** and not on `main`: the three commits were picked as they were, the gateway's manifest and lock byte-equal to their branch's, and `cargo metadata --locked` passes for both workspaces. The root `Cargo.lock` at that tip also carries the one edge the control socket's owner rule adds, from chan-shell to the locked `rustix`, so the `cargoHash` was harvested for that lock, as the two exact pins' item describes, and pinned in both Nix packages and in `packaging/nix/cargo-lock.sha256`. The combined gate was green on Linux with the Nix hash check passing inside it, which meets the fifth acceptance point at the integration's tip. Any later change of `Cargo.lock`, the version bump at the release candidate included, needs a new harvest. That either Nix package builds is not established.
