# A load that fails is retried forever

Status: accepted for v0.100.0 by the owner on 2026-09-20. Raised on the owner's instruction to fold the frontend review's most critical findings into this version. From the review (finding FB-01 high, WSC-02 and GPANEL-05 medium), re-verified against `main` at `d3de0180b` by reading. Three instances of one missing latch.

## What was seen

Each of these asks "is this loaded or loading" and never "did this fail", so a failure re-arms the request at once.

- `web/packages/workspace-app/src/components/PathPromptModal.svelte`: the effect that loads ancestor directories guards on `loadedDirs` and `loadingDirs` only. `loadTreeDir` in `state/store.svelte.ts` records the failure in `dirErrors`, rethrows and clears `loadingDirs` without ever setting `loadedDirs`, so the effect refires immediately. With New File or Save-as open over a path whose ancestor cannot be listed, the app issues an unbounded stream of `GET /api/fs` and starves the macrotask queue; the reviewer measured a hung tab.
- `components/SearchPanel.svelte`: a `language:` query walks directories in a loop bounded at 1000 with the same filter, so one unreadable directory costs 1000 sequential requests while the panel sits on "searching".
- `components/GraphPanel.svelte`: both depth-probe effects clear exactly the state their guards read when `/api/graph/fs` fails, so an open graph tab fires that request in a tight loop for as long as it is visible.

## Desired contract

A failed load is a state, not an absence of one. A load that failed is not retried until something changes that could make it succeed: the user retries, the directory changes on disk, the scope changes, or the panel reloads. The failure is visible where the content would have been.

## Boundaries

`web/packages/workspace-app/src/components/PathPromptModal.svelte`, `components/SearchPanel.svelte`, `components/GraphPanel.svelte` (the latch is cleared by `reloadGraph`, the hide-reset and the scope-change path), and `state/store.svelte.ts` only if `dirErrors` needs a reader helper. Tests: `components/searchReadiness.test.ts` and new mounted tests for the other two. `GraphPanel.svelte` is read as source text by 31 suites.

## Acceptance

1. With a directory that answers an error, opening the path prompt over it issues one request, shows the error, and a manual retry issues one more.
2. A `language:` query over a workspace with an unreadable directory issues one request for it.
3. A failing `/api/graph/fs` is requested once per reload or scope change, asserted on a counting stub.
