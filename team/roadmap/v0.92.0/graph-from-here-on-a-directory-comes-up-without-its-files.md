# "Graph from here" on a directory comes up without its files

Status: NOTE, 2026-08-16. Observed on the v0.91.0 candidate. Not investigated; the first task is to reproduce and find the cause.

## What was seen

Clicking "Graph from here" on a directory (file-browser inspector, or the tree's per-entry row) opens a graph tab that shows the directory but not the files inside it. The inspector beside it reports a non-zero file count for that same directory.

The files are in the index. In a graph tab that already has them, the same directories can be navigated into and the depth raised, and the files are there. It is only the tab that "Graph from here" opens that comes up without them.

## Why that matters

The two panels disagree about the same directory in the same window, and the one the user just asked for is the one that looks empty.

## First task

Reproduce, then establish where the difference is. The opening path is `openFsGraphForDirectory` in `web/packages/workspace-app/src/state/store.svelte.ts`, which opens a semantic graph tab scoped `dir:<path>` at depth 1 with the directory as the pending selection. Re-scoping inside an existing tab goes through `rescopeFromHere` in `GraphPanel.svelte`. Both claim depth 1, so the difference is somewhere else -- a fresh tab's filter or focus state, the pending selection, or what the `dir:` scope returns on first load versus after a re-scope.

Ruled out already: the tab's filters. `DEFAULT_GRAPH_FILTERS` is all-on, `openFsGraphForDirectory` passes no override, and node visibility is subtractive (a node renders unless a hidden set holds it), so no chip state can be withholding them.

## Acceptance

Opening "Graph from here" on a directory shows the same file nodes that navigating to that directory in an existing graph tab shows.
