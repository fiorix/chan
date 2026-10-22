# The index-status poller reloads the shared graph after every observed apply

Status: raised for v0.109.0 on 2026-10-22 by the lead, from the review seat's placement of browser check 163's red at the integrated tip; closes in the round.

## What was seen

The index-status poller in `web/packages/workspace-app/src/state/store.svelte.ts` polls every 250 ms while the indexer reports a per-file reindex, and `graphReloadWhenReady` is set because `graphIndexUnavailable` counts that state as the graph being unavailable; when the indexer returns to idle the poller calls `reloadGraph()`, whose `invalidateGraph` (`state/graphData.svelte.ts`) cancels a pending quiet window and fetches the whole graph at once. The graph route answers gated only during a full rebuild, so since `60e73ad0c` every return to idle after a poll that observed a per-file reindex ends in a redundant whole-graph fetch, and with the apply frames the graph-refresh item added it lands beside the two fetches that item's design costs and cancels a pending burst window. Browser check 163 (`scripts/e2e/browser-smoke/checks/163-file-browser-watch-refresh.mjs`) alone in the idle integration guest was red 11 of 15 at the integrated tip, 4 of 10 at the graph-refresh item's tip (and 1 of 3 under load), and 1 of 5 before its page half. The reds at the graph-refresh tip are a single fetch 103 to 162 ms after a step's frames, the poller's reload cancelling the step's window, and the others are steps with three or four fetches. One red at the graph-refresh tip is on another assertion (the unopened directory caused a root listing) and is placed apart. The check models neither the apply frames nor the reload.

## Desired contract

The poller reloads the shared graph only when the graph route was gated (a full build, a recovery or the gated mark); an observed per-file apply changes nothing in a page that holds an ungated view; check 163 takes the apply frames as part of a step.

## What to do

`graphReloadWhenReady` takes `building`, `recovering` and the gated mark, not `reindexing`, with three pins: a reindex that returns to idle with an ungated cached view fetches nothing; a build that returns to idle reloads; a gated view reloads at idle. In the same commit check 163 takes the apply frames into its steps, each step's boundary after the frames and the fetch they cue: the graph-refresh item's page half costs a step that stays open past its apply two fetches by design, so the step model is wrong without this adjustment whatever the poller's repair does to the counts. The commit is proved by check 163 alone ten times in the seat's guest and three times beside a compile load there, and at the landing in the integration guest, beside the base's count.

## Boundaries

`state/store.svelte.ts` at the poller, `state/graphData.svelte.ts` only if the pins need a seam, their tests, and check 163. Not changed: the graph routes, the indexer, the quiet window.

## Acceptance

1. The three pins red first; `make web-check` green at the commit.
2. Check 163 alone ten times green in the seat's guest at the commit and three times beside a compile load, and at the landing in the integration guest beside the base's count, the counts recorded here.
