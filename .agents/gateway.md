# Gateway contributor guide

The gateway is the sixth layer of chan: a set of services you run on your own infrastructure, so that a `chan devserver` can dial out with a personal access token and be published behind sign-in, to its owner and to the accounts the owner shares it with, from any browser or desktop. The system design is [`gateway/design.md`](../gateway/design.md), and each crate's `README.md` and `design.md` hold its contracts and rationale. This guide is what a contributor does in the `gateway/` workspace: build and test it, keep its documents current, and follow the rules that cut across its crates.

## What the workspace is

`gateway/` is a nested Cargo workspace, separate from the root one, with eight crates under `gateway/crates/`: `identity` (the public origin `gw.{domain}`: OAuth sign-in, sessions, PATs, the desktop API, the entry-credential mint, and the only SPA), `profile` (internal; the only crate that touches the user, devserver and grant tables), `devserver-control` (the singleton, database-free control plane) with `devserver-control-proto` (its frame types), `devserver-proxy` (the data plane: tunnel termination and the gated tenant wildcard; no Postgres, no SPA), `admin` (the operator CLI), `wireguard-agent` (the proxy host's peer-sync agent: it keeps one kernel WireGuard interface's peers equal to the gateway's peer table through `wg`, touching only the peers it added), and `gateway-common` (the cross-service clients and the `devserver_gate` entry-credential envelope). The gateway consumes the core only through the tunnel crates (`crates/chan-tunnel-*`, path dependencies), which is why the single-binary chan build never links Postgres or OAuth. The topology, the flows and the isolation model are in the design document; this guide does not restate them.

## Build and test

The toolchain is the root `rust-toolchain.toml`; the gateway has none of its own. Every recipe runs `cargo` with `--locked`, because the release builds the gateway through these same recipes and an unlocked build would re-resolve a stale `gateway/Cargo.lock` silently.

```bash
make gateway-spa     # build identity's SPA, the rust-embed input, once per checkout
make gateway-fmt
make gateway-lint    # clippy, all targets, warnings denied; runs the static packaging checks first
make gateway-doc     # rustdoc with warnings denied
make gateway-test    # the database-free subset: library unit tests, devserver-proxy, binary unit tests
make gateway-build   # compile the release crates
```

`gateway/crates/identity/web/dist/` is created by the SPA build, and a fresh checkout does not compile the workspace until it exists; with an empty bundle, identity's SPA route answers a "frontend not built" banner that names the command. The SPA is `@chan/profile` in the `./web` npm workspace at the repo root, with the shared chrome in `@chan/web-shared`; `cd web && npm run dev -w @chan/profile` iterates on it without re-embedding.

These targets are Linux-only and part of the root `make pre-push` gate on Linux (`scripts/install-hooks` installs the hook). `.github/workflows/gateway-ci.yml` runs the same steps with a `postgres:16` service and runs the whole test suite, including the database-backed integration tests.

The integration tests of `profile` and `identity` need Postgres and read `TEST_DATABASE_URL`; the services themselves read `DATABASE_URL`. Each test creates a throwaway schema in the named database, so the database must already exist:

```bash
createdb --template=template0 --locale=C.UTF-8 chan_gateway        # a running dev stack
createdb --template=template0 --locale=C.UTF-8 chan_gateway_test   # the integration tests
export TEST_DATABASE_URL=postgres://localhost/chan_gateway_test
cd gateway && cargo test --locked
```

The database needs a UTF-8 locale: profile folds emails with PostgreSQL `lower()`, which folds only ASCII under a `C` or `POSIX` ctype. `profile` and `identity` each cap their pool at four connections, because Postgres non-superuser slots are shared with every other pool on a dev host; a `pool timed out` with working TCP means the slots ran out, and the reaper in `gateway/tests-shared/pg_reaper.rs` recovers the usual orphaned-pool case. Running the full stack locally, with its TLS edges and OAuth app, is [`gateway/README.md`](../gateway/README.md) and [`gateway/docs/dev-setup.md`](../gateway/docs/dev-setup.md), driven by the `packaging/gateway/scripts/dev/` runner.

### Packaging checks

`make gateway-version-pin-check` runs the static packaging contracts (the deb dependency pins and the packaging isolation rules) and is part of `gateway-lint`. `make gateway-packaging-isolation-test` is opt-in: it runs the real postinst scripts in every install order and the sdme provisioner's refusals, about half a minute, so run it when a change touches a package `postinst` or `packaging/*.env`, `configure.sh`, `check-database-ready.sh`, `generate-admission-keypair.py` or `packaging/sdme/chan-devserver-provision.sh`, and before a release that carries such a change. Building and installing the deb packages is in [`gateway/README.md`](../gateway/README.md).

## Documents

Each crate ships two documents: `README.md` is the consumer-facing entry (install, build, routes, env vars) and `design.md` holds the boundaries, invariants and rationale. Update `design.md` in the same commit as a change to HTTP routes, the wire shape of a public response, the session contract or the inter-service trust model. The whole-gateway lifecycles are in `gateway/design.md`, the vocabulary in `gateway/CONTEXT.md`, and the decisions in `gateway/docs/adr/`. The repository-wide [writing rules](writing-rules.md) apply.

## Rules across the crates

- **Compare secrets in constant time.** Every bearer, OAuth state value, signature and CSRF check goes through `subtle::ConstantTimeEq`; plain `==` on a secret is never acceptable, even behind an authenticated session.
- **One error enum per request-handling crate.** `profile`, `identity` and `devserver-proxy` each define a `thiserror` enum with an `IntoResponse` that maps every variant to a precise status, a short generic public message (`unauthorized`, `internal error`, `upstream unreachable`) and the detail in the `tracing` log. `anyhow` is for `main.rs` and startup paths. The cross-service client errors in `gateway-common` (`ProfileError`, `DevserverControlError`, `DevserverGateError`) are plain `thiserror` with no axum coupling; each consumer maps them with a `From` impl so handlers can `?` through.
- **Parameterized SQL only.** Column constants such as `USER_COLS` are formatted into queries; user input always goes through `.bind()` and `$N`.
- **The devserver is the sharing unit.** `devserver_access(owner, devserver, caller)` in profile is the one per-request access decision: access for the owner or a claimed grant, 404 otherwise, with the no-grant and unknown-devserver cases sharing one shape so the endpoint cannot enumerate shares. Access is binary, there are no roles, and a grant covers the whole devserver. The decision is [ADR 0001](../gateway/docs/adr/0001-devserver-is-the-sharing-unit.md).
- **The proxy is not the access authority.** The gate accepts a validly signed entry credential with the right `aud` and `drv`; it never compares the subject against the registry's cached owner, which would lock out every grantee. identity runs `devserver_access` before it mints.
- **Hop-by-hop stripping is complete.** `HOP_BY_HOP_NAMES` holds the static list and `connection_listed_headers` adds every name the inbound `Connection` value lists; both run on both legs, and the inbound `Host`, `Cookie`, `Authorization` and `X-Chan-CSRF` are dropped before forwarding. The proxy routes on the raw `Host` header, never the `Host` extractor, which would honour a spoofable `X-Forwarded-Host`.
- **Atomic upserts in profile.** The user, identity and email triangle resolves a concurrent first-login race in one transaction (`POST /v1/users/upsert-by-identity`), and identity calls only that endpoint. Code that reaches across users and identities uses the same shape rather than a multi-step dance.
- **Revocation fans out server-side.** A block reserves a durable revocation job in the same transaction that marks the user and revokes every PAT; a background worker drives devserver-control's `kill_owner_tunnels` and `revoke_subject_sessions` with retry to a deadline. Token revoke and account delete fire the same cuts best-effort after the database update.
- **Placeholder usernames are deterministic.** A new row seeds `'u' || substr(replace(uuid::text, '-', ''), 1, 12)`; identity renames on first sign-in, and `update_username` enforces `MAX_USERNAME_EDITS` lifetime renames with a compare-and-set update. Do not invent another seeding scheme.
- **PATs are stored as digests.** The shape is `chan_pat_<random bytes, base64url, no pad>`; the database holds only the SHA-256 digest and the plaintext is emitted once. The inventory of plaintext PAT paths is [Devserver publication](../gateway/design.md#devserver-publication); add a new path there, not here.
- **OAuth providers are pluggable.** Each is one file under `identity/src/providers/` behind the `Provider` trait plus wiring in `providers_from_vars` (`identity/src/config.rs`, called by `Config::from_env`). The callback compares the pending state in constant time before it checks the provider, and the session id cycles at the login privilege boundary.
- **`gateway-common` carries no transport coupling.** `User` is the superset of what profile returns and consumers ignore what they do not need; `devserver_gate` is the single source of the entry-credential shape, Ed25519 only, with `aud` canonicalised as a lowercase host with default ports stripped.
- **`admin` keeps its output contract.** The exit codes are part of it: 0 success, 1 upstream or network error, 2 user input error, 3 not found. A TTY gets a plain table and `--json` the same data as JSON; a subcommand without `--json` is a regression.

## Service-to-service bearers

Every bearer is `openssl rand -hex 32`, and each crate's `packaging/*.env` file is the authoritative roster of what that service reads. The cross-service ones:

- `PROFILE_AUTH_TOKEN`: identity to profile's service API. profile also accepts `PROFILE_ADMIN_TOKEN` there so a single-token deployment works, and runs both checks unconditionally so a wrong token never short-circuits on the first byte.
- `IDENTITY_INTERNAL_TOKEN`: devserver-proxy to identity's `/internal/v1/tokens/validate`. Required, with no fallback to `PROFILE_AUTH_TOKEN`; rotating one does not rotate the other.
- `WIREGUARD_AGENT_TOKEN`: wireguard-agent to identity's `/internal/v1/wireguard/peers`, the one route it reads. A value of its own, never another service's bearer, and the agent holds no other gateway credential.
- The devserver-control `/admin/v1/*` credentials are scoped per caller and rotation-capable (each accepts a list): `DEVSERVER_OPERATOR_ADMIN_TOKENS` for operator tooling, `DEVSERVER_IDENTITY_ADMIN_TOKENS` and `DEVSERVER_PROFILE_ADMIN_TOKENS` for the services, which present their own value through the singular `DEVSERVER_IDENTITY_ADMIN_TOKEN` and `DEVSERVER_PROFILE_ADMIN_TOKEN`. devserver-control rejects a credential reused across scopes, so a leaked service token never grants the operator tree.
- `DEVSERVER_PROXY_TOKEN`: devserver-proxy to devserver-control's control session. Distinct from the admin credentials on purpose: a proxy node holds no operator credential.

And the Ed25519 pairs, where only the minting service holds a signing key and the verifiers hold a one- or two-key ring for rotation:

- `DEVSERVER_ENTRY_SIGNING_KEY` (identity) and `DEVSERVER_ENTRY_VERIFYING_KEYS` (each proxy): the entry credential. A compromised proxy cannot mint entries.
- `DEVSERVER_ADMISSION_SIGNING_KEY` (identity) and `DEVSERVER_ADMISSION_VERIFYING_KEYS` (devserver-control and each proxy): the admission lease.

The admin CLI's own per-destination credentials are in [`gateway/README.md`](../gateway/README.md).

## Further reading

- [`gateway/README.md`](../gateway/README.md): overview, local run, releases, the admin CLI.
- [`gateway/design.md`](../gateway/design.md): deployment boundaries, publication, the desktop account lifecycle, entry, control and data planes, isolation.
- [`gateway/CONTEXT.md`](../gateway/CONTEXT.md) and [`gateway/docs/adr/`](../gateway/docs/adr/): vocabulary and decisions.
- [`gateway/docs/dev-setup.md`](../gateway/docs/dev-setup.md): the production-shaped local stack.
- The crate designs: [`profile`](../gateway/crates/profile/design.md), [`identity`](../gateway/crates/identity/design.md), [`devserver-proxy`](../gateway/crates/devserver-proxy/design.md), [`devserver-control`](../gateway/crates/devserver-control/design.md), [`admin`](../gateway/crates/admin/design.md), [`gateway-common`](../gateway/crates/gateway-common/design.md).
