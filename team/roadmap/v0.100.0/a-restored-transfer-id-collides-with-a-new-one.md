# A restored transfer's id collides with the next new transfer

Status: raised for v0.100.0 on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding SYNC-02, high, trivial), re-verified against `main` at `d3de0180b` by reading.

## What was seen

`web/packages/workspace-app/src/state/transfers.svelte.ts` mints transfer ids from a module counter that starts at 1 on every load (`xfer-<window>-<n>`), and `restoreTransfers` replays persisted records with their old ids without seeding the counter past them. After a reload that had any persisted transfer, the first new transfer takes an id a restored dead row already holds. The live transfer then never settles, the `beforeunload` close guard prompts on every attempt to leave, and `TransferBubble`'s keyed `{#each}` throws `each_key_duplicate`.

## Desired contract

A transfer id is unique among every record the window holds, restored or new.

## Boundaries

`web/packages/workspace-app/src/state/transfers.svelte.ts`, `state/transfers.test.ts`, and `state/transferQueueReporting.test.ts`, which pins the literal id template in source text and has to change with it. Either seed the counter from the restored records or mint ids that cannot collide; if `crypto.randomUUID` is used it goes through the guarded helper from [rich-prompt-submit-throws-on-plain-http](rich-prompt-submit-throws-on-plain-http.md), because a devserver reached over plain http has no `randomUUID`.

## Acceptance

1. A test restores two persisted transfers, starts a new one, and asserts three distinct ids and that the new transfer settles.
2. The transfer bubble renders the restored and the new rows without throwing.
3. The close guard stops prompting once the live transfer completes.
