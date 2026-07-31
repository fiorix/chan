# Make the workspace binary-write limit configurable

Status: REGISTERED for v0.82.0; grounded 2026-07-31 after a real video upload exceeded the fixed limit.

## What

Binary workspace writes are capped at a hard-coded 50 MiB by `BYTES_WRITE_LIMIT` in `crates/chan-workspace/src/workspace.rs`. A 524,600,967-byte video upload was rejected with HTTP 413 and `write too large: 524600967 bytes exceeds 52428800 byte cap for bytes`.

The refusal is intentional safety policy, not the `cs tunnel` truncation bug. The missing product capability is a supported way to raise that policy for workspaces that legitimately carry large media.

## Configuration boundary

The limit belongs to `chan-workspace`, not to one HTTP route. `Workspace::write_bytes` and `Workspace::write_atomic_stream` enforce it for every caller, including server uploads and MCP writes, while standalone-terminal uploads consume the exported constant directly.

Recommended shape: add a positive machine-wide `bytes_write_limit_mb` field to the global `~/.chan/config.toml` registry, defaulting to 50. `Library` validates and snapshots the value, then passes the effective byte budget into every `Workspace` it opens. A server-only field in `~/.chan/server.toml` would let server uploads disagree with CLI and MCP writes, so it is the wrong source of truth.

The setting must retain a finite validated ceiling that includes at least 512 MiB. Zero must not silently mean unlimited. Invalid values and MiB-to-byte overflow fail config loading with a clear error.

## Contract

- The default remains 50 MiB, preserving the current safety posture for users who do not opt in.
- The effective binary budget is `max(existing_file_size, configured_limit)`, preserving the current rule that an existing oversized file may be replaced without growing further.
- Uploads remain progressive and atomic. Raising the cap must not buffer the whole file in memory, leave a partial target, or leave a temporary file after refusal or disconnect.
- The configured limit applies consistently to workspace file uploads, `/api/attachments`, standalone-terminal uploads, and other `Workspace` byte-write callers.
- `/api/files/upload` already disables axum's fixed default body limit; the workspace sink remains authoritative there.
- The fixed 50 MiB axum layer on `/api/attachments` and the two editor image pre-flight constants must consume the effective configured value or be replaced by a single server-reported limit. No public upload path may retain an independent stale 50 MiB ceiling.
- Text writes retain their separate 2 MiB policy. This item does not make `TEXT_WRITE_LIMIT` configurable.
- `docs/config-reference.md` documents the field, unit, default, supported range, restart behavior, and every consumer.

## Acceptance

- A missing field produces an effective 50 MiB budget.
- A configured value above 50 MiB permits a new binary file above the old limit through the normal streaming upload path and returns its exact size.
- One byte over the configured limit returns 413, preserves an existing target byte-for-byte, and leaves no temporary file.
- Replacement of an existing file larger than the configured limit succeeds only up to its existing size and refuses growth by one byte.
- Workspace, attachment, and standalone-terminal upload tests use small injected budgets to cover exact-limit, limit-plus-one, disconnect, and atomic cleanup without allocating hundreds of MiB in the test suite.
- The config parser rejects zero, unsupported values, and byte-conversion overflow with named errors.
- A repository sweep finds no independent production `50 * 1024 * 1024` upload gate outside the one default declaration.

## Rough size

Medium. The core policy change is small, but the value must be threaded through `Library` and `Workspace`, mirrored server gates must be removed, and the effective limit must reach browser pre-flight checks without creating a second source of truth.
