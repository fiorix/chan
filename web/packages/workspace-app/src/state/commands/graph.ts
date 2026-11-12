// Graph surface commands: available when a graph tab is the active
// surface. Net-new actions mutate the active GraphTab directly (its
// fields are $state, so the graph re-renders reactively, matching the
// pane's own menu). Reload is the exception: the fetch lives inside
// GraphPanel, so it arrives there as a chan:command. See
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

type FilterKind = Exclude<keyof GraphFilters, "link">;

const FILTER_KINDS: readonly FilterKind[] = [
  "tag",
  "mention",
  "language",
  "img",
  "folder",
  "markdown",
  "source",
];

/// What a graph tab's scope id names, read from its spelling as the panel
/// reads it: the workspace, a file, a directory, or a node of another kind.
function scopeKind(tab: GraphTab): "workspace" | "file" | "dir" | "other" {
  if (tab.scopeId === "workspace") return "workspace";
  if (tab.scopeId.startsWith("file:") && tab.scopeId.length > "file:".length) return "file";
  if (tab.scopeId.startsWith("dir:") && tab.scopeId.length > "dir:".length) return "dir";
  return "other";
}

/// The filters a graph tab offers and the word for each, as the graph menu
/// lists them. A language graph filters languages alone. A filesystem graph
/// over the workspace, a file or a directory names three of the kinds after
/// what they hide there and has no media or language filter. Every other
/// graph offers them all, the folder filter only over the whole workspace.
function graphFilters(tab: GraphTab): { kind: FilterKind; label: string }[] {
  if (tab.mode === "language") return [{ kind: "language", label: "language" }];
  const scope = scopeKind(tab);
  if (tab.mode === "filesystem" && scope !== "other") {
    const words: Partial<Record<FilterKind, string>> = {
      tag: "symlink",
      mention: "hardlink",
      folder: "directory",
      markdown: "markdown",
      source: "source",
    };
    return FILTER_KINDS.flatMap((kind) => {
      const label = words[kind];
      return label ? [{ kind, label }] : [];
    });
  }
  const words: Partial<Record<FilterKind, string>> = { mention: "contact", img: "media" };
  return FILTER_KINDS.filter((kind) => kind !== "folder" || scope === "workspace").map(
    (kind) => ({ kind, label: words[kind] ?? kind }),
  );
}

/// The active graph tab's depth as a row's value.
function depthState(): string | null {
  const tab = activeGraphTab();
  return tab ? String(tab.depth) : null;
}

registerCommands([
  {
    id: "app.graph.depth.increase",
    title: "Increase depth",
    category: "Graph",
    scope: "app",
    surface: "graph",
    order: 0,
    requirement: "workspace",
    keywords: ["Graph depth: increase", "depth", "expand", "more", "neighbors"],
    available: (ctx) => onSurface(ctx, "graph"),
    state: depthState,
    // The panel's own clamp effect caps depth to the scope's ceiling.
    run: onGraph((tab) => {
      tab.depth = tab.depth + 1;
    }),
  },
  {
    id: "app.graph.depth.decrease",
    title: "Decrease depth",
    category: "Graph",
    scope: "app",
    surface: "graph",
    order: 1,
    requirement: "workspace",
    keywords: ["Graph depth: decrease", "depth", "collapse", "less", "neighbors"],
    available: (ctx) => onSurface(ctx, "graph"),
    state: depthState,
    run: onGraph((tab) => {
      tab.depth = Math.max(0, tab.depth - 1);
    }),
  },
  {
    // One row per filter with a check on each that is on, as the graph
    // menu lists them.
    id: "app.graph.filters",
    title: "Filters",
    category: "Graph",
    scope: "app",
    surface: "graph",
    order: 2,
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
      const filters = graphFilters(tab);
      return `${filters.filter(({ kind }) => tab.filters[kind]).length} of ${filters.length}`;
    },
    options: () => {
      const tab = activeGraphTab();
      if (!tab) return [];
      return graphFilters(tab).map(({ kind, label }) => ({
        id: kind,
        label,
        checked: tab.filters[kind],
        run: () => {
          tab.filters[kind] = !tab.filters[kind];
        },
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
