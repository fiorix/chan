# The devserver is the gateway sharing and gate unit

Status: accepted (grill-with-docs, 2026-06-21).

The gateway migrates from per-workspace (`workspace-proxy`) to a devserver-centric model (`devserver-proxy`). The **devserver** is the unit of tunnel registration (1 token : 1 devserver, `--tunnel-name` dropped, identity resolved from the token), of the access gate (`drv` = devserver, cookie `Path=/`, one `devserver_access(owner, devserver, caller)` check), and of sharing (a grant gives a collaborator the whole devserver). Per-workspace permissions are dropped; the path `{workspace}` segment is tenant routing only, never a gate key. Chosen for simplicity; pre-release with a fresh-state cutover (`rm -rf ~/.chan`, no migration) makes the profile grant reshape free.

## Considered options

- **Per-workspace gate (keep profile's `WorkspaceGrant`)** was the current implementation's shape and an earlier draft's recommendation. Rejected: whole-devserver sharing is the wanted unit, and per-workspace gating adds gate + grant + slug-reconciliation complexity for a granularity not wanted.
- **Hybrid (library admit + per-workspace narrow)** rejected: two-tier gate, and it risked dragging the owner-only management API into the share gate.
- **Per-devserver (chosen).** Its only real cost was a destructive profile migration; the fresh-state cutover removes that cost.

## Consequences

- profile reshapes: the per-workspace `WorkspaceGrant`/`WorkspaceAccess` become a per-devserver grant + access check. No migration (fresh state).
- The management API `/api/devserver/*` is local-only (loopback / `ssh -L`). The proxy 404s it on the public wildcard and carries tenant content only; grantees structurally cannot manage; no owner-vs-grantee role logic in the gate.
- Always authenticated: `--tunnel-public`, the proxy `entry.public` pass-through, the `public` field on the `Hello`/`HelloAck` wire + registry entry, the `TUNNEL_PUBLIC_SCOPE` check, and the `missing_public_scope` refusal are dropped.
- The `Path=/` whole-host cookie is safe because a grantee is granted the WHOLE devserver (no non-granted sub-tenant to isolate on the same host); user-to-user isolation stays on the `aud` claim.
- The devserver identity is resolved from the token (PAT hash); `Hello.workspace` is not the identity source.
