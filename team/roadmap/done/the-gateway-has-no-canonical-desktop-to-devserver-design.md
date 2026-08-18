# The gateway has no canonical desktop-to-devserver design

Status: SHIPPED in [v0.92.0](../../release/release-v0.92.0.md). The documentation review was grounded against the live implementation from `43726ab7`.

## What is missing

The gateway is the infrastructure that connects `chan-desktop` to devservers running on other machines, but its documentation does not describe that system in one place. `gateway/design.md` is missing. The gateway README, context file, crate documentation, ADRs, root design, desktop design, and deployment guides each carry part of the story, sometimes at different levels of detail and sometimes with conflicting facts.

That drift now reaches observable behavior. Current documentation still contains claims or examples based on automatic database migrations, old ports and local origins, one devserver per user, workspace-era names and flags, an admin service rather than the admin CLI, and revocation and systemd behavior that no longer matches the implementation. The account sign-in, roster, selected-devserver entry exchange, and exact proxy-origin data path are not presented as one lifecycle.

## Desired contract

`gateway/design.md` becomes the canonical system-level design for the gateway. It explains how one `chan-desktop` account discovers a gateway, signs in, receives a roster containing multiple owned or shared devservers, and enters a selected devserver through its exact proxy origin. It also explains how each devserver publishes itself through an outbound tunnel and how the gateway control and data planes participate without duplicating component-level API catalogs.

The design carries four Mermaid diagrams:

- One block diagram places `chan-desktop`, identity, profile, Postgres, devserver-control, the proxy fleet, and multiple tunneled devservers at their high-level deployment boundaries.
- A publication sequence follows a devserver from tunnel dial through PAT validation, admission, registration, and readiness.
- An account sequence follows gateway discovery, browser authorization with PKCE, redemption, credential storage, and ETag roster polling.
- An entry sequence follows selection and shared-devserver trust, the explicit immutable roster identity, entry authorization, exact-origin validation, cookie exchange, Tauri capability minting, and proxied HTTP and WebSocket traffic to the chosen devserver.

## Document ownership

- `gateway/README.md` is the gateway front door: a concise overview, component index, and links to setup, operation, and design.
- `gateway/CONTEXT.md` is a glossary of current terms. It does not duplicate topology or preserve rename history as present-tense architecture.
- Crate READMEs own executable and consumer contracts: how to run a component, its configuration, routes, and CLI surface.
- Crate design documents own component boundaries, invariants, rationale, and failure behavior. Exact route and environment catalogs are not repeated there.
- ADRs preserve durable decisions and rejected alternatives without stale assertions about the current product model.
- Packaging documentation remains canonical for local-stack and production deployment mechanics.

## Implementation boundaries

Review every Markdown file under `gateway/`. Correct stale claims against current routes, configuration, CLI flags, deployment manifests, and desktop integration code. Consolidate repeated catalogs rather than updating parallel copies, and remove the redundant Linux/macOS testing pointer after retargeting its inbound links. Keep the gateway development guide focused on gateway-specific contributor setup and link to the canonical runner and Kubernetes guides for operational detail.

Outside `gateway/`, change only references and gateway claims required for consistency. The root and desktop designs link to the new gateway design and keep their own product-level view. The contributor index, agent gateway guide, and local runner documentation lose references to deleted pages, retired tunnel flags, and stale topology where those references are directly affected.

This is documentation work. It does not change runtime APIs, schemas, configuration, or behavior. The factual product description established by `43726ab7` remains intact, and unrelated worktree changes are not part of the item.

## Acceptance

- Every Markdown document under `gateway/` has been read against the live implementation and has a single, stated role in the documentation set.
- `gateway/design.md` explains the cross-component architecture and the full devserver publication, desktop account, roster, entry, and data-path lifecycles without requiring a reader to reconstruct them from crate docs.
- Its block diagram shows multiple devservers behind the gateway, and all four Mermaid diagrams parse with the repository's available Mermaid tooling.
- Migration mode, service ports and origins, desktop account and roster routes, multiple-devserver semantics, devserver terminology, admin CLI behavior, tunnel flags, revocation behavior, and systemd support match the current code and deployment configuration.
- Redundant material is removed or replaced by a link to its canonical owner, and no repository link points at a removed document.
- A repository-wide stale-term search, relative Markdown link check, and `git diff --check` pass.

## Resolution

`gateway/design.md` now owns the cross-component design and its four Mermaid diagrams. The v0.92.0 close read 24 gateway documents against the implementation, removed the stale topology and operational claims named above, retargeted links away from the redundant testing stub, parsed all four diagrams with repository tooling, and passed the release gate.
