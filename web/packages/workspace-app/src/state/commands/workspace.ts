// Workspace-settings commands: chan-reports indexing toggle and metadata
// archive import / export. Workspace-only (a standalone terminal window
// has no workspace surface). Register with registerCommands. See
// state/commands.ts for the Command shape and helpers.

import { registerCommands, workspaceOnly } from "../commands";
import { setTransientStatus } from "../store.svelte";
import { uiConfirm } from "../confirm.svelte";
import { api } from "../../api/client";

async function withStatus(
  fn: () => Promise<unknown>,
  ok: string,
  fail: string,
): Promise<void> {
  try {
    await fn();
    setTransientStatus(ok);
  } catch {
    setTransientStatus(fail);
  }
}

async function exportMetadataArchive(): Promise<void> {
  try {
    const dl = await api.metadataExport();
    const url = URL.createObjectURL(dl.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = dl.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setTransientStatus(`Exported ${dl.files} ${dl.files === 1 ? "file" : "files"}`);
  } catch {
    setTransientStatus("Metadata export failed");
  }
}

/// Pick a .tar.zst archive with a transient file input, confirm the
/// destructive replace, then import and reload so the refreshed index,
/// graph, report, and session metadata take effect. The launcher path
/// keeps rescan on and omits the force-scm option (the settings panel
/// still owns the full flow).
async function importMetadataArchive(): Promise<void> {
  const file = await pickFile(".tar.zst,application/zstd");
  if (!file) return;
  const ok = await uiConfirm({
    title: "Import metadata archive?",
    message: "Replaces index, graph, report, and session metadata.",
    confirmLabel: "Import",
    destructive: true,
  });
  if (!ok) return;
  try {
    await api.metadataImport(file, { rescan: true });
    setTransientStatus("Imported; reloading...");
    window.setTimeout(() => window.location.reload(), 700);
  } catch {
    setTransientStatus("Metadata import failed");
  }
}

/// Open the browser file picker without a persistent DOM input. Resolves
/// null when the user cancels; a cancelled picker that fires no event
/// simply leaves the promise pending, which is fine for a one-shot
/// command whose launcher has already closed.
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

registerCommands([
  {
    id: "app.reports.enable",
    title: "Enable chan-reports indexing",
    category: "Workspace",
    requirement: "workspace",
    keywords: ["reports", "index", "chan-reports"],
    available: (ctx) => workspaceOnly(ctx),
    run: () =>
      void withStatus(
        () => api.reportsEnable(),
        "chan-reports indexing enabled",
        "chan-reports update failed",
      ),
  },
  {
    id: "app.reports.disable",
    title: "Disable chan-reports indexing",
    category: "Workspace",
    requirement: "workspace",
    keywords: ["reports", "index", "chan-reports"],
    available: (ctx) => workspaceOnly(ctx),
    run: () =>
      void withStatus(
        () => api.reportsDisable(),
        "chan-reports indexing disabled",
        "chan-reports update failed",
      ),
  },
  {
    id: "app.metadata.export",
    title: "Metadata archive: export",
    category: "Workspace",
    requirement: "workspace",
    keywords: ["metadata", "archive", "backup", "download"],
    available: (ctx) => workspaceOnly(ctx),
    run: () => void exportMetadataArchive(),
  },
  {
    id: "app.metadata.import",
    title: "Metadata archive: import",
    category: "Workspace",
    requirement: "workspace",
    keywords: ["metadata", "archive", "restore", "upload"],
    available: (ctx) => workspaceOnly(ctx),
    run: () => void importMetadataArchive(),
  },
]);
