# Agents

The canonical home for agent and contributor standards in this repo. Read this file first, then follow the read order below.

## What This Project Is

`chan` is a supercharged terminal emulator. The product framing and its layers are stated once, in [`../design.md`](../design.md); every other description of chan in this repository follows it. The root [`README.md`](../README.md) is the short form: each layer in a line or two, how chan is made, and how the repository is laid out.

The invariants behind that design (the workspace boundary, the single binary with no runtime dependencies, local-first serving with an opt-in tunnel, the core, host and serving layers, MCP-only agents) are in [principles.md](principles.md), the first file in the read order below.

## Read Order

1. [principles.md](principles.md) - the load-bearing project invariants.
2. [writing-rules.md](writing-rules.md) - documentation and comment style.
3. [patterns.md](patterns.md) - contributor patterns for code changes.
4. [playbook.md](playbook.md) - the operational rules for working alongside other agents, with their reasons.
5. [skills/](skills/) - executable workflows (test server, release, gate, archive-round) plus vendored general skill profiles.

Subsystem guides: [desktop.md](desktop.md) (chan-desktop), [gateway.md](gateway.md) (the self-hosted gateway workspace), [orchestration/](orchestration/README.md) (the cs control surface and Team Work). The development process itself (rounds, roles, the roadmap and release trees) is [`../team/README.md`](../team/README.md).

## Layout

The repository layout, a line per top-level directory, is in the root [`README.md`](../README.md#repository-layout). One directory is missing from it because git never sees it: `web-launcher/` is the gitignored build output of `web/packages/launcher` (the launcher SPA's rust-embed input, not a source tree). The whole-system architecture (crate boundaries, runtime topology, bind vs tunnel, the devserver) lives in [`../design.md`](../design.md), and the per-crate design-doc index, by category, is in the root [`README.md`](../README.md#design-documents); do not duplicate any of the three here.

## Build & Test

The commands are in [`../CONTRIBUTING.md`](../CONTRIBUTING.md): setup, the cargo and web checks, the pre-push hook that runs `make pre-push`, and the gateway's Postgres-backed tests. The gate's step list, what CI adds on Linux, what macOS and Windows hosts skip, and the isolated own-gate model for multi-agent rounds are in [skills/gate/SKILL.md](skills/gate/SKILL.md).

## Documentation

- **Design and architecture**: [`design.md`](../design.md), the whole-system reference. Update it in the same commit as any change that affects crate boundaries, server contracts, state ownership, window capabilities, or the frontend embed / serve story. That rule lives here rather than in the document itself: `design.md` is the first file most readers open, and it opens as a description of the system, not as instructions to the people editing it. The full per-crate design-doc index, by category, is in the root [`README.md`](../README.md).
- **chan-workspace design**: [`crates/chan-workspace/design.md`](../crates/chan-workspace/design.md). Read before proposing chan-workspace changes.
- **Issue tracker**: GitHub repo `fiorix/chan`.
