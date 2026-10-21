# The status bar's broken-draft warning outlives the condition it reports

Status: carried into v0.109.0 at the v0.108.0 GA on 2026-10-21, still raised for a decision.

Record before the release: raised at the v0.107.0 cut on 2026-10-17 by the lead from a finding outside that version's items, recorded in the round's decisions as the ledger's entry; written down with the repair's shape; owner by lane at the next version's launch.

## What was seen

The status bar's workspace warnings come from the workspace payload; a `draft` frame runs the drafts refresh only. A window that discards a truly broken draft refreshes its own workspace; another window of the same workspace receives the discarded frame, updates its drafts group, and keeps the broken-draft warning in its status bar until its next workspace refresh (the review seat's read at source of the draft-creation item's acceptance 2, 2026-10-16; the frontend seat's reading at the base saw the warning outlive a completed creation the same way).

## Desired contract

The status bar's broken-draft warning leaves when the draft it names is discarded or made whole, in every window of the workspace, without waiting for an unrelated refresh.

## What to do

The draft frame refreshes the workspace payload as well, or the status bar's broken entries follow the drafts list.

## Acceptance

1. A pin on a second window, or a store test feeding the frame, red first at the base.
2. The design text of the status bar's warnings.
