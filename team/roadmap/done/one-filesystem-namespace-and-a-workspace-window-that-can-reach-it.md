# One filesystem namespace, and a workspace window that can reach the disk

Status: SHIPPED in [v0.93.0](../../release/release-v0.93.0.md). File content and transfers serve from one `/api/fs` namespace rooted at the serving tenant's capability root, and `cs download` / `cs upload` behave identically in every window kind; `/api/files` is kept as a compatibility alias documented for removal in v0.94.0. Five of the six acceptance lines are met by named tests, three of them parity or refusal tests, and the sixth is partly measurable because four of the eleven browser-smoke checks it names are red on unmodified code for reasons this change did not cause.

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

## Round evidence, v0.93.0

The open question is answered: reach is unconditional, with no configuration key, on the host's ruling that the shared standalone tenant is already mounted unconditionally at devserver startup and already carries the uid-scoped transfer routes, so this documents an existing reach rather than widening one.

Implemented across two commits: the contract, which serves `/api/fs` rooted at the serving tenant's capability root and keeps `/api/files` as an alias, and the caller migration, which moves 66 files onto the primary namespace. The surface was larger than this item's five-file sketch: 243 live references across 73 files, established by `git grep -n -I -E '(/api/files|api/files)'` at `1d2762e6`. That count was still incomplete, because a consumer that escapes the namespace for a regex is invisible to a search for the namespace; `git grep -nF 'api\/files'` found the one remaining site, a raw-source pin in `components/fileTreeDragOut.test.ts`.

Acceptance:

1. Met. `the_same_out_of_root_download_succeeds_from_workspace_and_terminal_windows` drives the same absolute out-of-root download through both tenant kinds and asserts the `filesystem` root frame.
2. Met. `upload_download_on_a_terminal_tenant_signal_the_window_cwd_scoped` and `terminal_router_serves_absolute_paths_via_wildcard_capture`.
3. Met. `workspace_and_terminal_routes_report_the_same_unreadable_path` sends an unreadable socket entry through both full routers and asserts identical status and body, refusing with `400` and `cannot read`.
4. Met. `workspace_and_terminal_routes_apply_the_same_directory_ceiling` configures a 4096-byte ceiling, builds a 4097-byte plan through both routers, and asserts identical `413` responses naming the exceeded count.
5. Met. `workspace_router_serves_the_fs_namespace_and_files_alias` and `terminal_router_serves_absolute_paths_via_wildcard_capture`. The removal version is documented as v0.94.0 in `design.md`, `.agents/gateway.md`, and both mount comments.
6. Partly measurable. The eleven browser-smoke URL assertions are migrated. Seven checks were green in the round's baseline and provide usable harnesses. `video-inspector` and `excalidraw-collab` are environment gaps that reproduce on a fresh baseline server and browser in this container. `large-file-streaming` and `binary-transfer-streaming-queue` cannot certify the namespace here because unmodified `1d2762e6` already disagrees with their transfer-ceiling expectations, in opposite directions: one receives a limit where it expects content, the other content where it expects a limit. That disagreement is pre-existing, is not caused by this change, and is recorded as a candidate for a later version.

No preflight, atomic-write, admission or ceiling policy changed. `routes/transfer.rs` relocates `transfer_max_bytes` without altering it.
