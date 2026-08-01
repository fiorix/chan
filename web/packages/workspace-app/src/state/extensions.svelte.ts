// Process-ready local extensions and their dynamic launcher commands. The
// capability-scoped entry path lives only in this in-memory catalog: tabs persist the
// stable extension id + display name, never credentials.

import { api } from "../api/client";
import type { ExtensionInfo } from "../api/types";
import { registerCommands, workspaceOnly } from "./commands";
import { openExtensionInActivePane } from "./tabs.svelte";

const EXTENSION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

let catalog = $state<ExtensionInfo[]>([]);
let ready = $state(false);
let loadPromise: Promise<void> | null = null;

/// Load once during workspace bootstrap. A missing/older endpoint is a
/// non-fatal empty catalog; a server restart reloads the whole SPA and retries.
export function loadExtensions(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const entries = (await api.extensions()).filter(isValidExtensionInfo);
      catalog = entries;
      registerCommands(
        entries.map((extension) => ({
          id: `extension.${extension.id}`,
          title: extension.name,
          category: "Apps" as const,
          keywords: ["extension", extension.id],
          available: workspaceOnly,
          run: () => {
            openExtensionInActivePane(extension.id, extension.name);
          },
        })),
      );
    } catch {
      catalog = [];
    } finally {
      ready = true;
    }
  })();
  return loadPromise;
}

export function extensionFor(id: string): ExtensionInfo | undefined {
  return catalog.find((extension) => extension.id === id);
}

export function extensionsReady(): boolean {
  return ready;
}

/// Defense in depth over the authenticated server response. This mirrors the
/// backend's exact v1 frame sources so a malformed response never widens the
/// iframe surface beyond the desktop CSP.
export function isValidExtensionInfo(value: unknown): value is ExtensionInfo {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExtensionInfo>;
  if (
    typeof candidate.id !== "string" ||
    !EXTENSION_ID.test(candidate.id) ||
    typeof candidate.name !== "string" ||
    !candidate.name.trim() ||
    typeof candidate.entry_path !== "string"
  ) {
    return false;
  }
  if (!candidate.entry_path.startsWith("/") || candidate.entry_path.startsWith("//")) {
    return false;
  }
  let entry: URL;
  try {
    entry = new URL(candidate.entry_path, "http://chan.invalid");
  } catch {
    return false;
  }
  const prefix = `/_chan/extensions/${candidate.id}/`;
  const capability = entry.pathname.slice(prefix.length).split("/", 1)[0] ?? "";
  return (
    entry.origin === "http://chan.invalid" &&
    entry.pathname.startsWith(prefix) &&
    /^[a-f0-9]{64}$/.test(capability) &&
    entry.searchParams.getAll("t").length === 0
  );
}
