# A shared devserver's root link refuses the people it is shared with

Status: raised on 2026-11-08 from the reading behind the manual and design drift item, which found the account page's Copy link comment claiming a safety the root does not have; accepted by the owner for v0.127.0 on 2026-11-08; built on `fix/shared-devserver-root-admits-grantees` (`1f8340737`, five commits) and merged into the integration branch as `13f6e6e2e` on 2026-11-09. A read-only review at the merge found no admission defect: the root now runs the per-workspace landing's check, decided by profile on every request (the owner, or an accepted grantee of that exact devserver), and a refusal is byte-identical to an unknown handle's; it noted that Open on a shared devserver shows while the devserver is offline and leads to identity's bare not-found. At `13f6e6e2e` the gateway block and `make web-check` are green, so acceptance 2 holds; acceptance 1 is met by Gateway CI run 42708859158 at `7b030d71f` (2026-11-09), whose PostgreSQL-backed suites ran the grantee-admitted landing, the no-grant refusal and profile's claim-and-revoke access tests green; acceptance 3's `sharedroot` scenario runs real devservers and PostgreSQL, so it waits on an isolated guest.

## What is there now

The account page's Devservers view builds two links for a devserver its user owns: Open, and Copy link, which copies `/s/{owner}?d=<disc>`, the whole-devserver root on the identity origin (`web/packages/profile/src/views/Devservers.svelte:151-184`, the label at `:307`). identity serves that root to the owner alone: `landing` answers any other caller, an accepted grantee included, with the same not-found as an unknown handle (`gateway/crates/identity/src/http.rs:1646-1650`, documented at `:1592`, pinned by `share_landing_root_grantee_denied` in `gateway/crates/identity/tests/auth.rs:2681`); the design documents say owner-only too (`gateway/crates/identity/design.md:136`, `gateway/crates/identity/README.md:170`, `gateway/design.md:170`). The per-workspace landing `/s/{owner}/{workspace}` admits grantees (`http.rs:1527-1568`). The owner-only root restricts only where a browser lands first: an accepted grantee who enters through a per-workspace landing gets an opaque session for the whole tenant host (the session record carries no path, `gateway/crates/devserver-proxy/src/session_store.rs:81-93`; the gate cookie is `Path=/`, `gateway/design.md:188`), and can then load `/`, the launcher; the devserver gives a grantee what it gives the owner on every route except the reverse-tunnel legs (`crates/chan-server/src/route_authority.rs:41-56`); Chan Desktop already opens a shared devserver for a grantee at `/` (`http.rs:1879-1960`, the default path at `:2143-2148`). The owner-only root dates from the viewer and editor roles that migration 0014 removed because the terminal data plane cannot enforce a containment boundary; the test's comment still states one. The account page offers a grantee no browser entry: the Shared with me rows have no Open and no Copy link (`Devservers.svelte:400-425`). Lines cited at `fa08475b3`.

## Desired contract

1. identity's whole-devserver root admits an accepted grantee as the per-workspace landing does: the owner-only branch goes, `resolve_entry_target`'s `devserver_access` check stays the one gate, and a caller with no access keeps the uniform not-found.
2. `share_landing_root_grantee_denied` becomes a grantee-admitted test beside a no-grant refusal; the landing's doc comment and the three design statements say who the root admits.
3. The account page's Shared with me rows gain Open and Copy link, built from `owner_username` and the disc as the owner's rows are; the Copy link comment and label describe a link a grantee can use.

## Boundaries

- No authority widens: the proxy session, the desktop and the devserver already treat an accepted grantee as holding the whole devserver (ADR 0001); only where a browser may land first changes.
- No change to the per-workspace landing, to grants, to the proxy or to the devserver.

## Acceptance

1. `cd gateway && cargo test --locked -p chan-gateway-identity` with `TEST_DATABASE_URL`: the grantee-admitted landing test and the no-grant refusal green, the old denial test gone.
2. `make web-check`: a mounted test of the Shared with me rows showing Open and Copy link for a shared devserver.
3. In the gateway zone harness, a grantee signed in through the stub lands on the whole-devserver root from the copied link.
