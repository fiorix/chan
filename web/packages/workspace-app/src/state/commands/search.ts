// Search commands: rebuild the index, enable semantic search, and pick
// the embedding model (one flat row per model). Workspace-only. Register
// with registerCommands. See state/commands.ts for the Command shape and
// helpers.

import { registerCommands, workspaceOnly, type Command } from "../commands";
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

/// Enable semantic search. The route rejects when the embedding model is
/// not present; the launcher does not orchestrate the download this
/// round, so it points at Search settings where the download lives.
async function enableSemantic(): Promise<void> {
  try {
    await api.semanticEnable();
    setTransientStatus("Semantic search enabled");
  } catch {
    setTransientStatus("Enable failed; download the embedding model in Search settings");
  }
}

async function setEmbeddingModel(model: string, label: string): Promise<void> {
  try {
    await api.semanticModelPatch(model);
    setTransientStatus(`Embedding model: ${label}`);
  } catch {
    setTransientStatus("Could not set embedding model");
  }
}

function embeddingModel(idKey: string, model: string, label: string): Command {
  return {
    id: `app.semantic.model.${idKey}`,
    title: `Embedding model: ${label}`,
    category: "Search",
    requirement: "workspace",
    keywords: ["embedding", "semantic", "model", "vector", "bge"],
    available: (ctx) => workspaceOnly(ctx),
    run: () => void setEmbeddingModel(model, label),
  };
}

registerCommands([
  {
    id: "app.index.rebuild",
    title: "Rebuild search index",
    category: "Search",
    requirement: "workspace",
    keywords: ["reindex", "search", "index"],
    available: (ctx) => workspaceOnly(ctx),
    run: () => void rebuildIndex(),
  },
  {
    id: "app.semantic.enable",
    title: "Enable semantic search",
    category: "Search",
    requirement: "workspace",
    keywords: ["semantic", "embedding", "vector", "ai"],
    available: (ctx) => workspaceOnly(ctx),
    run: () => void enableSemantic(),
  },
  embeddingModel("bgeSmall", "BAAI/bge-small-en-v1.5", "BGE Small EN v1.5"),
  embeddingModel("bgeBase", "BAAI/bge-base-en-v1.5", "BGE Base EN v1.5"),
  embeddingModel("bgeLarge", "BAAI/bge-large-en-v1.5", "BGE Large EN v1.5"),
  embeddingModel("bgeM3", "BAAI/bge-m3", "BGE M3"),
]);
