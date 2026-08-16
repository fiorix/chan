# One filesystem namespace, and a workspace window that can reach the disk

Status: ACCEPTED 2026-08-16 for v0.92.0. Raised against v0.91.0-rc1 while testing it, analysed during the rc2 cycle, and deliberately kept out of v0.91.0 so the candidate could ship. The investigation record is `projects/backlog/workspace-window-transfer-reach.md` in chan-dev.

## What

`cs download PATH` and `cs upload PATH` reach any path the shell's uid can reach when run from a standalone terminal window, and refuse anything outside the workspace root when run from a workspace window. The refusal is `abs_to_workspace_rel` in `crates/chan-server/src/control_socket.rs`, reported as `path escapes workspace root`.

This was never a regression. The workspace-less transfer lane was built for standalone terminals and mounted only on the slim tenant (`crates/chan-server/src/routes/transfer.rs`, mounted in `terminal_router`); workspace windows were simply never in its scope. The result is one product with two answers to the same command, decided by which window the user happened to type it in.

Two routes exist at the same URL shape with different meanings. On a workspace tenant `/api/files/{*path}` is workspace-relative; on the terminal tenant it is re-rooted at `/`. That collision is why this cannot be fixed by relaxing a check: `strip_leading_slash("/etc/hosts")` yields `etc/hosts`, which a workspace tenant resolves as `<workspace>/etc/hosts`, and a real file at that relpath is unusual but legal.

## Desired contract

- One filesystem namespace, `/api/fs`, whose paths are root-relative to whatever capability root the serving tenant has. A workspace tenant roots it at the workspace; a standalone tenant roots it at `/`. The URL means one thing, and the tenant decides the root.
- `/api/files/*` is retired. It is kept as an alias for one release rather than cut dead, because URLs escape: the extension lane, saved links, and external scripts hold them.
- `cs download` and `cs upload` behave identically in every window kind. A path the user's uid can read or write is transferable; nothing else is.
- Whether a workspace window served over a tunnel keeps that reach is a configuration decision, not a code path. See the open question below.

## Why this is smaller than it sounds

Every mechanism already exists and is reused as-is:

- `api_terminal_read_file` and `api_terminal_upload_file` take only `AppState`. They carry no terminal-tenant state, no session cwd, no terminal registry, and already implement the re-rooting, the read/write preflight and the transfer-ceiling enforcement.
- `WindowCommand::Download { path, is_dir }` is already the same shape for both lanes; there is no second message type to design.
- The SPA builds transfer URLs in exactly two places, `api.downloadUrl` and the upload POST (`api/client.ts`, plus the desktop path in `api/desktop.ts`). Everything downstream -- the transfer bubble, progress, retry, cancel -- is unaware of which root it is talking to.

## Implementation boundaries

- The namespace migration is `chan-server`: `routes/files.rs`, the two `routes/transfer.rs` mounts, and the router tables in `lib.rs`. The alias for `/api/files/*` lives here and is documented with the release it is removed in.
- The out-of-root routing is `control_socket.rs`: `download_path` and `upload_path` treat an escaping path as a route to the standalone lane rather than an error, and `WindowCommand::Download`/`Upload` carry which root the path is relative to.
- The SPA change is the two URL builders and the two frame handlers in `state/store.svelte.ts`.
- `scripts/e2e/browser-smoke` asserts these URLs today and moves with them.
- Not in scope: any change to what the preflight or the ceiling enforce. This moves a namespace and widens which windows can drive it; it does not loosen a guard.

## Acceptance

- `cs download` and `cs upload` on an absolute path outside the workspace succeed from a workspace window, and the transfer bubble reports them exactly as it does from a standalone terminal.
- The same commands still work from a standalone terminal window, unchanged.
- A path the uid cannot read fails at preflight with the same message in both window kinds, rather than starting a tarball it cannot finish.
- The transfer ceiling refuses an over-large directory plan in both window kinds.
- An `/api/files/*` request still resolves for one release, and its removal is documented with the version that removes it.
- The browser-smoke checks that assert transfer URLs pass against the new namespace.

## Open question, to settle before implementation

Does a workspace window served over a tunnel keep this reach?

The exposure is not new. A devserver mounts the shared standalone tenant unconditionally at startup (`mount_shared_terminal_tenant`), that tenant already carries the uid-scoped transfer routes, and the tunnel middleware stamps `TunnelOrigin` for the devserver as a whole rather than per tenant kind. Whole-filesystem reach behind the gateway edge therefore already ships and predates v0.91.0. What v0.91.0 added is a UI for it, not the capability.

So the decision is a product one rather than a security escalation: either the behaviour is unconditional and identical in every window, which is the simplest thing to document and to reason about, or it is gated by a server config key that can differ for a tunnel-served tenant. Decide before building; retrofitting a gate after the namespace moves means touching both again.

## Rough size

Small. Under a hundred lines of non-test change across roughly five files for the reach itself, plus the mechanical namespace rename and its alias. The migration is the larger half, and it is mostly find-and-replace with a public-URL compatibility window to honour.
