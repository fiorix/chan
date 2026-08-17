# "Graph from here" on a directory comes up without its files

Status: REPRODUCED AND FIXED 2026-08-17, not yet gated or merged. Raised as a NOTE on 2026-08-16 against the v0.91.0 candidate. The reproduction is below, under the note's own text; it corrects the note's guess about where the difference is.

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

> Amended 2026-08-17. That line was already true of the shipped code, so it cannot decide this item; the reproduction below establishes what can. The operative acceptance is that a from-here directory graph shows the directory's files whenever its subtree holds any, and it is measured in `112-graph-from-here-dir`.

## What reproduction found, 2026-08-17

The opening path is not where the difference is. Measured in a real browser against a seeded workspace, a `dir:` scope opened cold by "Graph from here" and the same scope reached by clicking the parent crumb in an existing tab render the SAME set, 6 visible nodes and 6 visible edges each, on a directory holding two files and a subdirectory. `openFsGraphForDirectory` versus `rescopeFromHere` is not the cause, and the note's own ruling-out of the filters holds. The acceptance line above was already met by the shipped code, which is why it could not have found this.

What does reproduce is narrower and was never about the opening path: a directory whose immediate children are ALL directories comes up with no file on screen at all.

| the tab                                          | visible nodes | visible edges |
| ---                                              | ---           | ---           |
| `dir:` scope, files among the immediate children | 6             | 6             |
| `dir:` scope, files one level below, as opened   | 4             | 3             |
| that same tab after the depth slider moves to 2  | 7             | 7             |

The four are the workspace-root anchor, the scope directory, and its two subdirectories. The files are not missing from what the tab fetched: the semantic layer is prefix-scoped and complete, and that tab's own `/api/graph?scope=directory&depth=1` response carried both of them. The render gate withheld them.

This is what the note saw. The inspector's file count for a directory is its whole subtree (`dirStats` in `FileInfoBody`, and the `subtree` roll-up it prefers), so a directory of directories reads as "N files" beside a graph with none, and raising the depth is exactly what reaches them.

## Cause

A directory-scoped graph renders one level at a time. `scopedNodeIds` shows a file only when every directory between it and the scope root is in `graphState.expanded`, and a tab is born with `expanded: { "": true }` (`openGraphInPane`), which expands the workspace root and nothing else. "Graph from here" opens at `depth: 1`, and the panel's first load deliberately does not seed the expanded set, because a restored tab's serialized expansion is the user's. So only the scope root's immediate children ever render.

For a directory with files among those children that is the right tight view, and it is what depth 1 should mean. For a directory of directories it is a graph of folder bubbles.

## The fix

`shallowestFileDepth` (`web/packages/workspace-app/src/graph/depth.ts`) reports the shallowest level below a root that holds a file. On arrival at a `dir:` scope, `revealDirScopeFiles` in `GraphPanel.svelte` raises the tab's depth to that level when the current depth holds no file at all. The existing depth-change reseed then expands the levels in between, so the slider reads the depth actually on screen and no new expansion path is introduced.

Three guards keep it to the case it is for: `dir:` scopes only, so the workspace graph's root-level overview is untouched; only while nothing below the scope root is expanded, so a restored tab keeps the user's own expand/collapse state; and only on arrival at a scope, never on a depth change, so dragging the slider down to a level with no files is honoured rather than corrected.

Deliberately out of scope: the workspace-scoped graph, which has the same shape of default and is a much wider surface to change. A workspace whose root holds only directories would open the same way.

## Validation

- `scripts/e2e/browser-smoke/checks/112-graph-from-here-dir.mjs` drives the tree row's own "New Graph" entry in a real browser over three legs: a directory with files among its children, the same scope reached by a breadcrumb re-scope (they must render one set), and a directory whose files are one level below. Floors are computed from the payload rather than from fixture constants, and each leg asserts the scope of the panel it read, because hidden graph tabs stay mounted and a leg reading an earlier leg's panel agrees with itself perfectly.
- The check was measured RED on the unmodified tree, failing the third leg at 4 nodes / 3 edges against a floor of 6 while the other two legs stayed green, and GREEN with the fix at 7 nodes / 7 edges.
- `shallowestFileDepth` is unit-tested in `graph/depth.test.ts`; the panel wiring is pinned in `components/graphDirScopeReveal.test.ts` (the `?raw` convention this repo uses for logic inside a Svelte component). `svelte-check` is clean.
