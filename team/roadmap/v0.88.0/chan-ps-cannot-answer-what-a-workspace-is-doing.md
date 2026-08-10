# `chan ps` cannot answer what a workspace is doing

Status: REGISTERED 2026-08-09, from diagnosing the watcher-reconcile stall ([gitignore-write-strands-the-workspace-in-recovering](../done/gitignore-write-strands-the-workspace-in-recovering.md)) against a live devserver.

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
- The stall in [gitignore-write-strands-the-workspace-in-recovering](../done/gitignore-write-strands-the-workspace-in-recovering.md) is identifiable from `chan ps` output alone, demonstrated against a workspace held in that state.
- A workspace with no indexer renders its indexer columns as absent rather than as zero, following the `cs terminal list` queue-depth ruling from v0.85.0 where an unreported value renders `-` and not `0`.

## Rough size

Small. The data is already served and already authorized; this is a read, a table, and the column choices.

## Implemented 2026-08-10 (`6c57dc33`)

`chan ps` gains six columns, and `--json` gains an `activity` object per row.

```
STATE    BY           PID  READY       GEN    PASS      ACTION     INDEXER     QUEUE  WORKSPACE
served   devserver   8695  recovering  2/1    none->2   rebuild    rebuilding      0  /home/rig/ws/alpha
served   devserver   8695  ready       1      -         -          idle            0  /home/rig/ws/bravo
free     -              -  -           -      -         -          -               -  /home/rig/ws/d1
```

`PASS` is `pending->active`, and it is the column the item exists to put on screen. `14->none` is the stall — a pass is owed and nothing is running it. `none->2` is a pass with a claimant. They are different strings, which is the v0.87.0 distinction this must not collapse.

`GEN` is `generation/completed` while recovering and the bare generation when ready, so the lag that says a pass is owed is visible without arithmetic.

**Where the values come from.** `GET {prefix}/api/index/status` for readiness, `GET {prefix}/api/health` for indexer telemetry — the two surfaces the original diagnosis read by hand. Readiness is deserialized into the server's **own** `WorkspaceReadiness` rather than a client-side copy of its shape, so the contract's "cannot report a different truth" holds structurally: a variant or field the server changes stops this compiling rather than silently rendering a stale word. Only the flat indexer telemetry is mirrored client-side, because chan-server declares `mod indexer` privately and making it reachable would mean editing a file this lane does not own.

**Authority.** The bearer is the one already persisted at `~/.chan/devserver/config.json`, which this CLI reads today to *rotate* that same token — a mutating call. Two status reads with it grant nothing new. Per-workspace tokens come from `GET /api/devserver/workspaces`, the same path the original diagnosis used.

**Reach.** Only a devserver-served workspace can be enriched: a standalone or desktop serve persists no address/token pair `chan ps` may read, and `Identify` carries no address. Those rows render `-` rather than inventing a way in. An unreachable devserver costs the activity columns, not the command — the listing call is the single gate, so one timeout is spent rather than one per workspace.

### Acceptance

- **Per workspace, the readiness, generation, action, indexer and queue values. Met.** The table carries state, `generation`/`completed_generation`, `pending`/`active`, `required_action`, indexer status and queue depth. `last_event_at` and `last_settled_at` are carried in `--json` rather than the table: eight columns already reach the width of a terminal, and two absolute timestamps are a scripting value rather than a five-second-read value. Verified live in both forms.
- **A workspace with no indexer renders its columns absent rather than zero. Met**, by test rather than by live demonstration. `/api/health` reports `indexer: null` on a tenant with no indexer, and that payload renders `-` for both INDEXER and QUEUE. The test asserts the two renderings are *different strings*, because the failure worth preventing is a workspace with no indexer reading as the healthy one. No served workspace on the rig could be put into that state, so this is a shape test against the real payload, and is recorded as such rather than as a live result.
- **The stall is identifiable from `chan ps` output alone, demonstrated against a workspace held in that state. Partially met, and the gap is structural.** `53f8b5e6` closed the stall: every parked pass is announced to a `RecoveryDriver` and `Indexer::spawn` installs one before the server answers a poll, so on a served workspace at this commit the state is **unreachable** — see [one-stalled-workspace-may-block-the-others](one-stalled-workspace-may-block-the-others.md), where the same wall was hit and recorded. What was done instead, stated rather than blurred:
  - The **recorded live payload** from the owner's stalled devserver in [gitignore-write-strands-the-workspace-in-recovering](../done/gitignore-write-strands-the-workspace-in-recovering.md) — generation 14, completed 12, reconcile owed, active null, pending 14 — is parsed by test and renders `recovering  14/12  14->none  reconcile`. That is the incident's own evidence, read through the new columns.
  - A **live** recovering workspace was demonstrated end to end against a real devserver over 4000 files, rendering `recovering 2/1 none->2 rebuild rebuilding 0`, which proves the path works against a running server and that a claimed pass is not rendered as a stall.
  - What is **not** shown is a live workspace in the unowned-pass state, because no such state can be produced on a served workspace at this commit. Producing one would need a fix-reverted build.

### Tests

Six new, all against real captured payloads rather than hand-built values, so the wire shape is pinned and a server-side rename fails here instead of rendering `-` forever: the stall fingerprint from the incident's own evidence; a claimed pass rendering differently from a stalled one; a ready workspace; absent-vs-zero for the indexer columns; every column degrading to `-` when nothing answered; and readiness read out of the flattened `/api/index/status` payload.

**Mutation probes: 5 probes, 7 expect-red assertions, all 7 bit, control held in 5/5.** Reverting the pass column's pending/active distinction, the queue column's absent-is-not-zero rule, the recovering/ready distinction, the generation lag, and the readiness field name each turned the tests that claim them red, with an unrelated control staying green.

One instrument note, because it nearly produced a false result: the first run scored 6/7 with a control apparently moving, and both anomalies were the harness truncating `cargo test` output with `tail -40` so result lines fell outside the window. Re-run with full capture, every probe bit and every control held. The probes were not wrong; the thing measuring them was.

### Scoped gate

`cargo fmt -p chan --check`, `cargo clippy -p chan --all-targets -D warnings`, and `cargo test -p chan --lib` (199 passed, 0 failed), in an sdme container on the pinned 1.95.0 toolchain.
