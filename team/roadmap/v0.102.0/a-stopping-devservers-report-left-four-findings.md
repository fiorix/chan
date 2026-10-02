# The report of the stopping devserver's order left four findings outside its items

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner has not ruled on this item. The builder of [a-stopping-devserver-says-it-is-restoring](../done/a-stopping-devserver-says-it-is-restoring.md) and [the-launchers-add-and-on-skip-the-stop-check](../done/the-launchers-add-and-on-skip-the-stop-check.md) listed them for the lead to raise (`dev/v0101-team/reports/report-Services-40.md` in the development tree, "Found outside the items, for the lead to raise"), and a reading of the ledger on 2026-09-29 could not establish that any was raised (`dev/v0101-team/machine-move/lead38-recon-5-runtime-launcher-drawing.md`, T5, part d, and "Unknown"). Each was read, three of them by an agent of the builder's seat, and none was run. The lines are the report's, at its lane's tip or, where marked, at its base `61895c96d`.

## What was seen

- **The upload turns every 503 into `server busy` and drops the sentence.** The workspace app's XHR upload does so for any 503 (`web/packages/workspace-app/src/api/client.ts:433-436`, `:463-468`; read by an agent and, by the report, not spot-checked), and `isTransferBusyError` and `transferRetryAfterSeconds` have no production caller (`:376`, `:386`). So by that reading an upload that a stopping devserver refuses with 503 reads as `server busy`.
- **The document and scene sync sockets stay off for the page's life when their first dial closes before a frame.** This one has an item of its own, [a-sync-socket-closed-before-a-frame-stays-off](a-sync-socket-closed-before-a-frame-stays-off.md).
- **The gateway proxy's own plain-text 503s look the same as the devserver's** to a reader that sees only the status: "entry capacity reached" (`gateway/crates/devserver-proxy/src/proxy.rs:579`, `:654`; read by an agent).
- **The devserver's save during a stop.** The save keeps a mounted record's desired state once the devserver is shutting down (`crates/chan-server/src/devserver.rs:1670-1677`, `:1720-1728` at `61895c96d`; read by the builder). Whether it can write a launcher's off back on during the stop was not traced; the report gives it as a question only, for the Runtime lane.

The report names one more difference and raises nothing on it: at a stop, the devserver's own open and on resolve the root's key, a filesystem ask of up to sixty seconds, before their stop check (`devserver.rs:1025-1027`, `:1042-1044` against `:1065` at `61895c96d`), while the launcher's check asks no filesystem; so a root that hangs at the stop is refused by the launcher at once and by the devserver's own routes only after up to sixty seconds.

Not established: each of them in a run; whether the save can turn a workspace back on during a stop; and whether any of them was raised under another name, which the reading of 2026-09-29 could not tell.

## Desired contract

Not written yet: the four are a builder's side findings, and the records say of none what should hold.

## What to do

Decide each: an item of its own, a line of an item that exists, or nothing. The save during a stop needs a trace first, since the report leaves it as a question.

## Boundaries

By the report's citations: `web/packages/workspace-app/src/api/client.ts`, `gateway/crates/devserver-proxy/src/proxy.rs` and `crates/chan-server/src/devserver.rs`. A client that does not read the stop's code is [no-client-reads-the-devserver-stopping-code](no-client-reads-the-devserver-stopping-code.md), and a refusal's shape is [refusals-answer-in-four-shapes](../done/refusals-answer-in-four-shapes.md)'s.

## Acceptance

1. Each of the four, and the difference the report only names, has a recorded disposition.
2. The save during a stop is traced, and the trace says whether a launcher's off can be written back on.
