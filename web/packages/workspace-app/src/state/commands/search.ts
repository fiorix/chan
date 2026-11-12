// Search commands: rebuild the workspace index, and the search overlay's
// Details panel. Workspace-only. Semantic search and the embedding model are
// fields of the Settings overlay and reach the launcher through the settings
// index. Register with registerCommands. See state/commands.ts for the
// Command shape and helpers.

import { registerCommands, workspaceOnly } from "../commands";
import { searchPanel, setTransientStatus } from "../store.svelte";
import { api } from "../../api/client";

async function rebuildIndex(): Promise<void> {
  try {
    await api.indexRebuild();
    setTransientStatus("Rebuilding search index...");
  } catch {
    setTransientStatus("Index rebuild failed");
  }
}

/// Show or hide the search overlay's Details panel. The overlay's menu row
/// and the launcher's toggle both call this, and the choice holds while the
/// overlay is closed: the next search opens with it.
export function toggleSearchDetails(): void {
  searchPanel.inspectorOpen = !searchPanel.inspectorOpen;
}

registerCommands([
  {
    id: "app.index.rebuild",
    title: "Rebuild index",
    category: "Search",
    scope: "workspace",
    order: 1,
    requirement: "workspace",
    keywords: ["Rebuild search index", "reindex", "search", "index"],
    available: (ctx) => workspaceOnly(ctx),
    run: () => void rebuildIndex(),
  },
  {
    // Listed last in the Workspace section: it is a view choice of the
    // search overlay, where the rows above act on the workspace.
    id: "app.search.details",
    title: "Details (search)",
    category: "Search",
    scope: "workspace",
    order: 8,
    kind: "toggle",
    requirement: "workspace",
    keywords: ["Show Details", "Hide Details", "search", "inspector", "preview", "panel"],
    available: (ctx) => workspaceOnly(ctx),
    state: () => searchPanel.inspectorOpen,
    run: toggleSearchDetails,
  },
]);
