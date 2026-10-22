# Three graph readers show a failed first load's partial view as the whole graph

Status: built on 2026-10-22 on the seat's branch; the section Built 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the release: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

A first load of the shared graph that fails keeps what it streamed, marked partial, and a retry streams afresh. The state module and the inspectors' references branch on the error state first; three readers do not: the search panel's tag and mention rows and the workspace body's contacts read the partial view as the whole graph until a retry completes (the review seat's note at the graph refetch item's amend, 2026-10-16; the same at that item's parent).

## Desired contract

A reader of the shared graph shows a failed first load as a failure or as loading, never a partial graph as the whole.

## What to do

The three readers branch on the error state or the partial mark as the inspectors do, showing the error or the loading state instead of a partial graph.

## Acceptance

1. A pin per reader with a failed first load, red first.
2. The design text.

## Lead's rulings 2026-10-22

On the frontend seat's design, 00:38Z: "grfldg takes (a) (what a person sees today is false, so the loading line is correctness and is not put to Alex); grfprt as recommended (the search panel quiet, the contacts with the loading and error lines); two commits, grfldg first, both after grfapl's page half through `graphData.svelte.ts`."

On the review seat's read of the design, 00:45Z:

- G2. "The `contactPills` guard returning `[]` while partial is dropped: the new branches are the guard."
- G3. "The contacts take the file inspector's third branch too: "rebuilding contacts..." on `graphData.gated`, after the error branch, in the inspector's order, with a pin."
- G4. "The search panel's two pins go in a file of their own beside `SearchPanel.names.test.ts` (name it in the hand-back)."
- Counts: "grfprt: five pins, four mutants".

## Built 2026-10-22

Each of the three readers branches on the shared graph's state, on the mark the inspectors' item publishes, `graphData.partial` (true over a first load's partial view, while it streams and after it fails). The search panel's tag and mention rows (`tagRows` and `mentionRows` in `web/packages/workspace-app/src/components/SearchPanel.svelte`) offer nothing over a partial view, as before any view exists, while the panel's file and content results answer the query; a complete answer brings them. The workspace inspector's contacts (`components/WorkspaceInfoBody.svelte`) take the file inspector's lines in its order before the pills: "loading contacts..." while a load is out over a partial view, "contacts unavailable: <error>" on the shared graph's error, which covers a failed refresh as the file inspector's line does, and "rebuilding contacts..." over a gated answer (G3); `contactPills` itself keeps no guard (G2), and a refresh in flight over a complete view keeps the pills. The workspace app's design text (`src/design.md`, the shared graph through a burst of filesystem events) says so.

Acceptance 1, a pin per reader with a failed first load, in the frontend seat's guest (logs under `dev/v0109-team/evidence/Frontend109/grfprt/build/`). `components/SearchPanel.graphRows.test.ts` (new, beside `SearchPanel.names.test.ts`, G4): after a first load that streams its one batch and fails, a query matching the batch's tag shows no tag row, and one matching its mention no mention row; each row comes once a complete answer lands. `components/WorkspaceInfoBody.test.ts`: a failed first load shows "contacts unavailable: stream down" and no pill; a first load held after its batch shows "loading contacts..." and no pill, then the pills; a gated answer shows "rebuilding contacts..."; a refresh in flight shows the pills and no loading line. With the two product modules as they are at the parent `52a092190` (`redgreen-1`), the first five fail on their own assertions (the rows and the pills read from the partial view, no line), and the refresh pin passes there. Six mutants, one per guard, each fail a pin: the partial test dropped from the tag rows and from the mention rows, the loading line's `partial` dropped (red on the refresh pin alone), the loading line, the error line and the rebuilding line each removed. The two touched files pass once in a shuffled order (`shuffle-1`, seed 1792677056024, 24 tests).

Acceptance 2, the design text above. `make web-check` at `eda4a58af`, this commit without this section (`gate-1.log`, rc 0, 15 minutes): svelte-check clean in every package, web-shared's 218 tests, the launcher's 624, the workspace app's 7563 in 593 files and the profile's 20, both production builds, the web lock unchanged and the checkout clean after. Browser checks 123 and 174, which open the search panel and pick its file results, pass at the commit and at the parent (`search-tip-1`, `search-parent-1`); no check reads the graph rows or the workspace contacts.

A workspace with no contacts shows the Contacts header with its line while a first load streams, fails or is gated, as the file inspector shows its references line for a file with none; the section leaves once a complete answer holds no contact.
