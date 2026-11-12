// Search commands: rebuild the workspace index. Workspace-only. Semantic
// search and the embedding model are fields of the Settings overlay and
// reach the launcher through the settings index. Register with
// registerCommands. See state/commands.ts for the Command shape and helpers.

import { registerCommands, workspaceOnly } from "../commands";
import { setTransientStatus } from "../store.svelte";
import { api } from "../../api/client";

async function rebuildIndex(): Promise<void> {
  try {
    await api.indexRebuild();
    setTransientStatus("Rebuilding search index...");
  } catch {
    setTransientStatus("Index rebuild failed");
  }
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
]);
