// Graph surface commands: available when a graph tab is the active
// surface. Net-new actions mutate the active GraphTab directly (its
// fields are $state, so the graph re-renders reactively, matching the
// pane's own menu). Reload, Select workspace and the depth are the
// exceptions: the fetch, the loaded nodes and the selection the depth
// belongs to live inside GraphPanel, so they arrive there as a
// chan:command. The graph menu lists its filter rows from
// GRAPH_FILTER_ROWS, the list the Filters command offers as options, so
// the menu and the launcher name and offer the same filters. See
// state/commands.ts for the Command shape and the onSurface helper.

import { openChoice, registerCommands, dispatchChanCommand, onSurface } from "../commands";
import { copyTextToClipboard } from "../store.svelte";
import {
  activeGraphTab,
  graphLinkFor,
  type GraphFilters,
  type GraphTab,
} from "../tabs.svelte";
import { notify } from "../notify.svelte";

/// Run an action against the active graph tab, a no-op when none is
/// active. onSurface hides these when no graph tab is focused; the guard
/// keeps a stale invocation safe.
function onGraph(fn: (tab: GraphTab) => void): () => void {
  return () => {
    const tab = activeGraphTab();
    if (tab) fn(tab);
  };
}

/// A filter a person can turn on and off. The tab's `link` slot is none:
/// a link shows whenever both its ends do.
export type GraphFilterKind = Exclude<keyof GraphFilters, "link">;

/// One filter a graph tab offers, with the word for it.
export type GraphFilterRow = { kind: GraphFilterKind; label: string };

/// The filters a graph tab offers and the word for each, in the order the
/// graph menu and the Filters command both list them. Every graph tab draws
/// the one graph of the workspace, so each offers them all.
export const GRAPH_FILTER_ROWS: readonly GraphFilterRow[] = [
  { kind: "tag", label: "tag" },
  { kind: "mention", label: "contact" },
  { kind: "language", label: "language" },
  { kind: "img", label: "media" },
  { kind: "folder", label: "folder" },
  { kind: "markdown", label: "markdown" },
  { kind: "source", label: "source" },
];

/// Turn one of a graph tab's filters on or off. A menu row and its option of
/// the Filters command both toggle through here.
export function toggleGraphFilter(tab: GraphTab, kind: GraphFilterKind): void {
  tab.filters[kind] = !tab.filters[kind];
}

/// The depth the active graph tab's panel shows, as a depth step's value.
/// The panel works it out for the selected node and records it on the tab.
function depthState(): string | null {
  const depth = activeGraphTab()?.shownDepth;
  return depth === undefined ? null : String(depth);
}

registerCommands([
  {
    id: "app.graph.scopeDetails",
    title: "Select workspace",
    category: "Graph",
    scope: "app",
    surface: "graph",
    order: 0,
    requirement: "workspace",
    keywords: ["root", "node"],
    available: (ctx) => onSurface(ctx, "graph"),
    // The selection lives in the panel, so the panel takes it: the
    // workspace's own node in place of whatever was selected, with its
    // details shown.
    run: () => dispatchChanCommand("app.graph.scopeDetails"),
  },
  {
    id: "app.graph.depth.increase",
    title: "Increase depth",
    category: "Graph",
    scope: "app",
    surface: "graph",
    order: 1,
    requirement: "workspace",
    keywords: ["Graph depth: increase", "depth", "expand", "more", "neighbors"],
    available: (ctx) => onSurface(ctx, "graph"),
    state: depthState,
    // The depth is the selected node's (levels below a directory, hops
    // from any other node), so the panel that knows the selection moves it.
    run: () => dispatchChanCommand("app.graph.depth.increase"),
  },
  {
    id: "app.graph.depth.decrease",
    title: "Decrease depth",
    category: "Graph",
    scope: "app",
    surface: "graph",
    order: 2,
    requirement: "workspace",
    keywords: ["Graph depth: decrease", "depth", "collapse", "less", "neighbors"],
    available: (ctx) => onSurface(ctx, "graph"),
    state: depthState,
    run: () => dispatchChanCommand("app.graph.depth.decrease"),
  },
  {
    // One option per filter the graph menu lists, with a check on each that
    // is on.
    id: "app.graph.filters",
    title: "Filters",
    category: "Graph",
    scope: "app",
    surface: "graph",
    order: 3,
    kind: "choice",
    requirement: "workspace",
    keywords: [
      "Graph filter: tags",
      "Graph filter: contacts",
      "Graph filter: languages",
      "Graph filter: media",
      "Graph filter: markdown",
      "Graph filter: source",
      "filter",
      "show",
      "hide",
    ],
    available: (ctx) => onSurface(ctx, "graph"),
    state: () => {
      const tab = activeGraphTab();
      if (!tab) return null;
      const on = GRAPH_FILTER_ROWS.filter(({ kind }) => tab.filters[kind]).length;
      return `${on} of ${GRAPH_FILTER_ROWS.length}`;
    },
    options: () => {
      const tab = activeGraphTab();
      if (!tab) return [];
      return GRAPH_FILTER_ROWS.map(({ kind, label }) => ({
        id: kind,
        label,
        checked: tab.filters[kind],
        run: () => toggleGraphFilter(tab, kind),
      }));
    },
    run: () => openChoice("app.graph.filters"),
  },
  {
    id: "app.graph.copyLink",
    title: "Copy graph link",
    category: "Graph",
    scope: "app",
    surface: "graph",
    requirement: "workspace",
    keywords: ["Copy link to graph", "link", "share", "url", "clipboard"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: onGraph((tab) => {
      void copyTextToClipboard(graphLinkFor(tab), {
        onSuccess: () => notify("Graph link copied"),
        onError: () => notify("Couldn't copy graph link"),
      });
    }),
  },
  {
    id: "app.graph.reload",
    title: "Reload graph",
    category: "Graph",
    scope: "app",
    surface: "graph",
    requirement: "workspace",
    keywords: ["reload", "refresh", "rebuild", "redraw"],
    available: (ctx) => onSurface(ctx, "graph"),
    // Scoped to this graph, unlike app.window.reload which reloads the SPA.
    run: () => dispatchChanCommand("app.graph.reload"),
  },
]);
