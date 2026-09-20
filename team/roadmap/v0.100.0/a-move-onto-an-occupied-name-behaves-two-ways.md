# A move onto an occupied name behaves two ways, and neither is honest

Status: accepted for v0.100.0 by the owner on 2026-09-20. Two sources describe the two halves: a follow-up the v0.99.0 fix loop parked (the single move), and the frontend review's finding FB-05 (the multi-row move). Both were re-read against `main` at `d3de0180b`, and the review's stated consequence for FB-05 did not survive the reading; what follows is what the code does.

## What was seen

**One row: a confirm the server will refuse.** `performMove` in `web/packages/workspace-app/src/state/store.svelte.ts` looks the target up in the tree and, when it is an existing file, asks "Overwrite existing file?" with a destructive Overwrite button, then sends the same `api.move` it would have sent anyway. Since v0.99.0 the server refuses an occupied rename destination before doing anything: `preflight_rename` in `crates/chan-workspace/src/rooted_fs.rs` returns `PathAlreadyExists` for any existing non-identical destination, and the route answers 409. The user is asked to confirm a replacement the product will not perform, and confirming produces the refusal. The rename prompt and a single-row drag share `performMove`, so both behave this way.

**Many rows: a silent rename.** A drop of two or more rows in `components/FileTree.svelte` bypasses `fileOps.moveTo` and calls `api.fsTransfer("move", candidates, destDir)` directly. That route never overwrites either: `fs_transfer_batch_sync` in `crates/chan-server/src/routes/files.rs` resolves a free name, so a file dropped onto an occupied name lands beside it under a " copy" suffix, and nobody is told. The route rewrites links itself and returns the rewrite conflicts in its response; the drop handler reads only `resp.moved` and drops them, where a single move notifies. The client-side steps a single move runs, the drafts-path refusal and the open-tab re-key among them, are skipped; what that costs the user was not reproduced and is this item's first task. `fbClipboardPaste` takes the same route and has the same shape.

The frontend review filed the multi-row case as overwriting the destination with no prompt. It does not, and did not at the commit the review read.

## Desired contract

A move onto an occupied name has one behaviour, whatever the gesture: rename prompt, single drag, multi-row drag or cut and paste. The app never offers an action the server will refuse, and never lets the server resolve a collision without saying so. Every moved file gets what a single move gets: the drafts refusal, the conflict report, and open tabs that follow the file.

Which behaviour is the one (refuse and name the occupied path, or keep both under a suffix and say so) was a small product decision to settle first. Owner ruling, 2026-09-20: refuse, and name the occupied path. It is what the server already does, it needs no naming rule, and nothing is written that the user did not ask for. The "Overwrite existing file?" confirm goes, because it offers an action the server refuses.

## Boundaries

`web/packages/workspace-app/src/state/store.svelte.ts` (`performMove`, `fbClipboardPaste`, and a shared many-path helper beside them), `components/FileTree.svelte` (the drop handler, which stops importing `api` for this one call), `state/fileOps`, and their tests; `state/fileOpsNoClobber.test.ts` pins the confirm's title as source text and changes with it. `crates/chan-workspace/src/rooted_fs.rs` and `crates/chan-server/src/routes/files.rs` are read-only for this item. `store.svelte.ts` is shared with other items of this version; sequence through the lead.

## Acceptance

1. A reproduction first, as mounted tests: what a multi-row move does today to an open tab on a moved file, to a drafts-path destination, and to a rewrite conflict.
2. A single move onto an existing file opens no overwrite confirm; the user sees one message naming the occupied path, or the ruled alternative. The existing-directory branch keeps today's message, pinned.
3. A multi-row move and a cut-and-paste onto an occupied name behave the same as the single move.
4. After a multi-row move, open tabs on the moved files point at the new paths, and rewrite conflicts are reported.
5. No server route changes.

## Which side of the wire the guarantee lives on

The refusal is client side, because acceptance 5 forbids a route change and the transfer route never refuses: it resolves a collision to a " copy" suffix and reports only the link rewrites it could not apply. A check against the client's cached listing cannot be the guarantee, and reading it as one is what made the first attempt at this item wrong. `loadTreeDir` returns at once when a directory is already loaded or already in flight, so awaiting it does not mean having a listing that speaks for the moment of the transfer; a case-insensitive filesystem defeats a string compare; and an entry can arrive between the listing and the request.

So the response is the authority. `TransferResponse.moved` carries each source's final destination after collision suffixing, and a `to` that differs from the landing path the caller asked for is a name that was taken and resolved, which the user is told by name. The pre-check keeps its place as what it can honestly be: a round trip saved when the collision is already visible. `skipped` is named to the user as well, without interpretation, because the wire carries the no-op move and the escaped path in one field.

A copy is deliberately outside this: landing beside the original under a suffix is what a copy is for.
