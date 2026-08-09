# `chan ps` cannot answer what a workspace is doing

Status: REGISTERED 2026-08-09, from diagnosing the watcher-reconcile stall ([gitignore-write-strands-the-workspace-in-recovering](gitignore-write-strands-the-workspace-in-recovering.md)) against a live devserver.

## What

Diagnosing a stalled workspace took a shell on the host, the management token from `~/.chan/devserver/config.json`, a workspace token fetched from `GET /api/devserver/workspaces`, and hand-read JSON from `/api/health` and `/api/index/status`. Every value that identified the fault was already computed and already served. `chan ps` simply does not surface any of it.

The values that mattered were readiness state, `generation`, `completed_generation`, `pending_generation`, `required_action`, indexer status, and queue depth. With those on screen the diagnosis is a five-second read: pending 14, active none, queue 0, and the conclusion that a pass exists with no worker follows immediately. Without them, the same conclusion took a live investigation.

This is an observability gap, not a defect: nothing is wrong with what the server computes, only with what the operator can see.

## Contract

- `chan ps` answers what each served workspace is doing, sufficient to distinguish a workspace making progress from one parked.
- The columns come from the surfaces that already carry them, so `chan ps` cannot report a different truth than `/api/health` and `/api/index/status`.
- No new authority: `chan ps` shows what its existing credential already permits.

## Acceptance

- Per workspace, `chan ps` carries readiness state, `generation` / `completed_generation` / `pending_generation`, `required_action`, indexer status, queue depth, and `last_event_at` / `last_settled_at`.
- The stall in [gitignore-write-strands-the-workspace-in-recovering](gitignore-write-strands-the-workspace-in-recovering.md) is identifiable from `chan ps` output alone, demonstrated against a workspace held in that state.
- A workspace with no indexer renders its indexer columns as absent rather than as zero, following the `cs terminal list` queue-depth ruling from v0.85.0 where an unreported value renders `-` and not `0`.

## Rough size

Small. The data is already served and already authorized; this is a read, a table, and the column choices.
