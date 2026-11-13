# A graph tab keeps a directory's old files after another directory takes its name

Status: accepted for v0.131.0 by the owner on 2026-11-13; not started.

Record: found on 2026-11-13 by the confirm read of the second independent review of v0.129.0's graph fixes, in a vitest probe drawing from the spine alone, and older than that work (`dev/v0129/reviews/review-graphfix-2.md`, "Confirm read of round 4", follow-up 1; probe D in `dev/v0129/evidence/graphfix/review-2/probe-vitest-4/run.log`). Left open in the shipped [graph row](../done/the-graph-tab-draws-a-different-graph-for-each-way-it-is-opened.md) ("Open") and in `dev/v0129/row-notes.md`, "Graph work: follow-ups from the second review". At v0.130.0's planning the owner placed the later group of rows, this one among them, in v0.131.0: "yes v0.131" (`dev/v0130/status.md`).

## What is there now

Read at `342dbe791`, in `web/packages/workspace-app/src/components/GraphPanel.svelte` unless named:

- A change in the workspace patches the tab's spine. `spineDirsTouched` (1439-1453) takes the parent directory of each path the change names, when the spine holds that parent's children or the tree draws them; `patchSpine` (1537-1580) reads each such level again, and `applySpineLevel` (1600-1646) lays it over what the spine held.
- A named path that is itself a directory the spine holds is not read. After `mv releases/v2 releases/v3 && mv releases/v1 releases/v2`, with `releases` and `releases/v2` opened, only `releases` is read; `releases/v2` is a directory before and after, so `applySpineLevel` keeps what the spine held below it. The tab draws `releases/v2/old.md`, which is now `releases/v3/old.md`, and not `releases/v2/new.md`, which came from `v1`, until `Reload graph` or a whole fetch. Shown by the probe while the tab draws from its spine alone. By reading, the shared graph laid over it does not remove the stale file: `withSpine` (`web/packages/workspace-app/src/graph/sharedGraph.ts:86-99`) adds every spine node the shared graph does not hold; not run.

## Desired contract

1. A change that names a directory the spine holds reads that directory's level again too, so its children are what is on disk after the change: in the sequence above `releases/v2` shows `new.md` and not `old.md`, with or without the shared graph laid over.
2. A patch stays bounded as now: one that would read as many directories as a whole fetch is a whole fetch.

## Boundaries

- `spineDirsTouched` and the patch path in `GraphPanel.svelte`.
- Not here, two lower items from the same read: a symlink swapped between the route's scope check and its walk would be listed (the escape guard has the same window); the symlink check matches a link by its target's directory, so a change there reads again every held directory with a link into it (performance only).

## Acceptance

1. Workspace app tests over the graph panel with the fs-graph stub (`web/packages/workspace-app/src/__tests__/graphPanel.ts`), the sequence above: drawing from the spine alone, and with a shared graph laid over that holds `releases/v2/new.md` and `releases/v3/old.md`; in both `releases/v2/new.md` is drawn and `releases/v2/old.md` is not. Red on the code without the change.
2. A browser check in a guest that runs the sequence in a real workspace with the tab's directories opened and reads the drawn nodes after the change, before any reload.
