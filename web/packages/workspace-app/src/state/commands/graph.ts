// Graph surface commands: available when a graph tab is the active
// surface. Net-new actions mutate the active GraphTab directly (its
// fields are $state, so the graph re-renders reactively, matching the
// pane's own menu). Reload is the exception: the fetch lives inside
// GraphPanel, so it arrives there as a chan:command. See
// state/commands.ts for the Command shape and the onSurface helper.

import { registerCommands, dispatchChanCommand, onSurface } from "../commands";
import { copyTextToClipboard, setHybridSurfaceTheme } from "../store.svelte";
import { activeGraphTab, graphLinkFor, type GraphTab } from "../tabs.svelte";
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

registerCommands([
  {
    id: "app.graph.surfaceTheme.light",
    title: "Graph theme: light",
    category: "Graph",
    keywords: ["theme", "light", "appearance"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: () => setHybridSurfaceTheme("graph", "light"),
  },
  {
    id: "app.graph.surfaceTheme.dark",
    title: "Graph theme: dark",
    category: "Graph",
    keywords: ["theme", "dark", "appearance"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: () => setHybridSurfaceTheme("graph", "dark"),
  },
  {
    id: "app.graph.copyLink",
    title: "Copy link to graph",
    category: "Graph",
    keywords: ["link", "share", "url", "clipboard"],
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
    keywords: ["reload", "refresh", "rebuild", "redraw"],
    available: (ctx) => onSurface(ctx, "graph"),
    // Scoped to this graph, unlike app.window.reload which reloads the SPA.
    run: () => dispatchChanCommand("app.graph.reload"),
  },
  {
    id: "app.graph.depth.increase",
    title: "Graph depth: increase",
    category: "Graph",
    keywords: ["depth", "expand", "more", "neighbors"],
    available: (ctx) => onSurface(ctx, "graph"),
    // The panel's own clamp effect caps depth to the scope's ceiling.
    run: onGraph((tab) => {
      tab.depth = tab.depth + 1;
    }),
  },
  {
    id: "app.graph.depth.decrease",
    title: "Graph depth: decrease",
    category: "Graph",
    keywords: ["depth", "collapse", "less", "neighbors"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: onGraph((tab) => {
      tab.depth = Math.max(0, tab.depth - 1);
    }),
  },
  {
    id: "app.graph.filter.tag",
    title: "Graph filter: tags",
    category: "Graph",
    keywords: ["filter", "tag", "toggle"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: onGraph((tab) => {
      tab.filters.tag = !tab.filters.tag;
    }),
  },
  {
    id: "app.graph.filter.contact",
    title: "Graph filter: contacts",
    category: "Graph",
    keywords: ["filter", "contact", "mention", "toggle"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: onGraph((tab) => {
      tab.filters.mention = !tab.filters.mention;
    }),
  },
  {
    id: "app.graph.filter.language",
    title: "Graph filter: languages",
    category: "Graph",
    keywords: ["filter", "language", "toggle"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: onGraph((tab) => {
      tab.filters.language = !tab.filters.language;
    }),
  },
  {
    id: "app.graph.filter.media",
    title: "Graph filter: media",
    category: "Graph",
    keywords: ["filter", "media", "image", "toggle"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: onGraph((tab) => {
      tab.filters.img = !tab.filters.img;
    }),
  },
  {
    id: "app.graph.filter.markdown",
    title: "Graph filter: markdown",
    category: "Graph",
    keywords: ["filter", "markdown", "document", "toggle"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: onGraph((tab) => {
      tab.filters.markdown = !tab.filters.markdown;
    }),
  },
  {
    id: "app.graph.filter.source",
    title: "Graph filter: source",
    category: "Graph",
    keywords: ["filter", "source", "code", "toggle"],
    available: (ctx) => onSurface(ctx, "graph"),
    run: onGraph((tab) => {
      tab.filters.source = !tab.filters.source;
    }),
  },
]);
