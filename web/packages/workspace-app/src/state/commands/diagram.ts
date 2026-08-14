// New diagram command (Apps category): creates a seeded .excalidraw
// board through the server's diagram endpoint and opens it in the active
// pane, mirroring New draft (createDraftAndOpen). isExcalidraw(path)
// routes it to canvas mode. Availability follows the workspace gate. See
// state/commands.ts for the Command shape and the workspaceOnly helper.

import { registerCommands, workspaceOnly } from "../commands";
import { api } from "../../api/client";
import { noteDraftCreated, setTransientStatus } from "../store.svelte";
import { openInActivePane } from "../tabs.svelte";

/// Create a seeded Excalidraw board (a real, promotable draft) and open
/// it in the active pane. Mirrors createDraftAndOpen: surface it in the
/// tree and refresh graph/workspace before opening. Exported so
/// App.svelte's runCommand can route the `app.diagram.new` dispatch
/// (pane hamburger Apps rows, host bridge) through the same handler.
export async function createDiagramAndOpen(): Promise<void> {
  try {
    const { path } = await api.createDiagram();
    await noteDraftCreated(path);
    await openInActivePane(path);
  } catch (err) {
    console.warn("[chan] createDiagram failed", err);
    setTransientStatus(`New diagram failed: ${(err as Error).message}`);
  }
}

registerCommands([
  {
    id: "app.diagram.new",
    title: "New diagram",
    category: "Apps",
    requirement: "workspace",
    keywords: ["excalidraw", "draw", "whiteboard", "canvas", "board"],
    available: (ctx) => workspaceOnly(ctx),
    run: () => {
      void createDiagramAndOpen();
    },
  },
]);
