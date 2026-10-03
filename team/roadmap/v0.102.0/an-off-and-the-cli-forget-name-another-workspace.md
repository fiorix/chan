# The launcher's off and `chan workspace forget` can still act on another workspace after the removal's repair

Status: raised for a decision on 2026-09-30 and held under v0.102.0, since the owner closed v0.101.0's intake on 2026-09-29; the owner has not ruled on this item. It holds what the repair of [a-removal-unregisters-by-the-name-it-is-given](../done/a-removal-unregisters-by-the-name-it-is-given.md) leaves, by its builder's report (`dev/v0101-team/reports/report-Runtime-39.md` in the development tree, "Callers at the tip and remaining naming costs" and the residuals of its last section), which the report calls a map derived from source. The lead told the owner of two of the cases on 2026-09-29 and said that both would be raised (`dev/v0101-team/for-host-2026-09-27.md`, the entry of 00:14Z), and a reading of the ledger that day found no item for them (`dev/v0101-team/machine-move/lead38-recon-1-prior-host-questions.md`, E5). The repair is ten commits, built and not landed, `2b5ebe6d1..1bd028bef`; the lines below are the report's, at that range's tip. Read, not run: the repair's fixtures exercise no CLI.

## What was seen

In the report's letters: a workspace R whose registered path S is a link, mounted from the folder C, and another registered workspace W2 whose registered path is O; then S is pointed at O.

- **`chan workspace forget` sends the path it was typed only after it has resolved it.** `unserve_running` canonicalizes the typed path and sends the canonical path to the desktop and to the control socket (`crates/chan/src/lib.rs:2491`, `:2507`, `:2536-2543`), so typing S once it resolves to O names W2. The control socket's removal keeps the host's rule for the name it is given and "cannot reconstruct a stored root discarded by the caller" (`crates/chan-server/src/control_socket.rs:1888`).
- **The CLI then unregisters in its own process by the typed path.** `cmd_close` calls `remove_from_registry` after any outcome that is not a refusal, a failed teardown among them (`lib.rs:2444`), and that function takes the workspace's paths and unregisters by the typed path (`:2394-2400`), which by the report "can wipe W2's metadata and row even if the earlier request is corrected". The report calls this the half with the higher impact, since a repair of the request alone does not prevent it.
- **The launcher's off still uses the close's old naming rule and can close and turn off W2** (the report's residuals, with no lines).

The report lists three more residuals that this item does not take: a removal by S of a workspace that is not mounted cannot purge a window kept only under an old canonical key that is no longer known; the lookup of a closing row can match a name that equals one row's cached path and resolves to another's key; and a registry written from outside can hold two rows that store one root, of which the repair's unregister removes only the one whose state it wiped. Whether the last is inside [two-registry-rows-can-name-one-directory](two-registry-rows-can-name-one-directory.md) was not checked.

[chan-workspace-forget-ignores-the-hosts-answer](chan-workspace-forget-ignores-the-hosts-answer.md) holds the CLI's local unregister after a host's answer that the removal must be retried. Whether its fix covers the unregister by the typed path is not established (`dev/v0101-team/machine-move/lead38-recon-6-runtime-hold.md`, "Unknown").

Not established: none of the three was reproduced; what the desktop's handoff needs beside the CLI's change, which the report names only as "equivalent desktop handling"; and anything on Windows.

## Desired contract

A forget or an off acts on the registry row that its user named, and never closes, turns off, unregisters or wipes another registered workspace because the named row's path resolves into that workspace's folder.

## What to do

Decide, and whether the three are one item, or parts of [chan-workspace-forget-ignores-the-hosts-answer](chan-workspace-forget-ignores-the-hosts-answer.md) and of the removal's item. The report names two "narrow followups" for the CLI: keep a lexically normalized, exact stored-root name on a remove, with equivalent handling in the desktop before it canonicalizes; and look the stored row up exactly and unregister that row in the local step. They are the builder's notes and not a plan, and the report names no shape for the launcher's off. Any build comes after the repair of [a-removal-unregisters-by-the-name-it-is-given](../done/a-removal-unregisters-by-the-name-it-is-given.md) has landed.

## Boundaries

By the report's citations: `crates/chan/src/lib.rs` (`unserve_running`, `cmd_close`, `remove_from_registry`), the control socket's removal in `crates/chan-server/src/control_socket.rs`, and the close's naming rule in the host, which the launcher's off uses. `crates/chan/src/lib.rs` is the file that [the-chan-cli-crate-is-one-13k-line-file](../done/the-chan-cli-crate-is-one-13k-line-file.md) splits, so its lines will have moved.

## Acceptance

1. The owner's decision is recorded, with which item holds each of the three.
2. If it is built: `chan workspace forget` of a registered path that resolves into another registered workspace's folder leaves that other workspace registered, with the state chan keeps for it; pinned red first.
3. If it is built: the launcher's off of such a row leaves the other workspace on; pinned red first.
