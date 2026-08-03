// Process-ready local extensions and their dynamic launcher commands. The
// capability-scoped entry path lives only in this in-memory catalog: tabs persist the
// stable extension id + display name, never credentials.

import { api } from "../api/client";
import type { ExtensionCommandInfo, ExtensionInfo } from "../api/types";
import { registerCommands, workspaceOnly } from "./commands";
import { notify } from "./notify.svelte";
import { openOrFocusExtension } from "./tabs.svelte";

const EXTENSION_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const EXTENSION_COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_QUEUED_COMMANDS = 16;

export const EXTENSION_READY_MESSAGE = "chan:extension-ready:v1";
export const EXTENSION_COMMAND_MESSAGE = "chan:extension-command:v1";
export const EXTENSION_COMMAND_RESULT_MESSAGE = "chan:extension-command-result:v1";

export type PendingExtensionCommand = {
  id: string;
  requestId: string;
};

type ExtensionFrameTarget = {
  ready: boolean;
  post: (command: PendingExtensionCommand) => void;
};

let catalog = $state<ExtensionInfo[]>([]);
let ready = $state(false);
let loadPromise: Promise<void> | null = null;
const frameTargets = new Map<string, ExtensionFrameTarget>();
const commandQueues = new Map<string, PendingExtensionCommand[]>();

/// Load once during workspace bootstrap. A missing/older endpoint is a
/// non-fatal empty catalog; a server restart reloads the whole SPA and retries.
export function loadExtensions(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const entries = (await api.extensions()).filter(isValidExtensionInfo);
      catalog = entries;
      registerCommands(
        entries.flatMap((extension) => [
          {
            id: `extension.${extension.id}`,
            title: extension.name,
            category: "Apps" as const,
            keywords: ["extension", extension.id],
            available: workspaceOnly,
            run: () => invokeExtension(extension),
          },
          ...(extension.commands ?? []).map((command) => ({
            id: `extension.${extension.id}.${command.id}`,
            title: command.title,
            category: "Apps" as const,
            keywords: [
              "extension",
              extension.id,
              extension.name,
              ...(command.keywords ?? []),
            ],
            available: workspaceOnly,
            run: () => invokeExtension(extension, command.id),
          })),
        ]),
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

export function extensionHasCapability(
  extension: ExtensionInfo | undefined,
  capability: "session-context" | "presentation",
): boolean {
  return extension?.capabilities?.includes(capability) ?? false;
}

export function registerExtensionFrame(
  tabId: string,
  post: (command: PendingExtensionCommand) => void,
): () => void {
  frameTargets.set(tabId, { ready: false, post });
  return () => {
    frameTargets.delete(tabId);
    commandQueues.delete(tabId);
  };
}

export function resetExtensionFrame(tabId: string): void {
  const target = frameTargets.get(tabId);
  if (target) target.ready = false;
}

export function markExtensionFrameReady(tabId: string): void {
  const target = frameTargets.get(tabId);
  if (!target) return;
  target.ready = true;
  const queued = commandQueues.get(tabId) ?? [];
  commandQueues.delete(tabId);
  for (const command of queued) target.post(command);
}

export function isExtensionCommandResult(value: unknown): value is {
  type: typeof EXTENSION_COMMAND_RESULT_MESSAGE;
  request_id: string;
  ok: boolean;
  message?: string;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === EXTENSION_COMMAND_RESULT_MESSAGE &&
    typeof candidate.request_id === "string" &&
    candidate.request_id.length <= 128 &&
    typeof candidate.ok === "boolean" &&
    (candidate.message === undefined ||
      (typeof candidate.message === "string" && candidate.message.length <= 512))
  );
}

function invokeExtension(extension: ExtensionInfo, commandId?: string): void {
  const tab = openOrFocusExtension(
    extension.id,
    extension.name,
    extension.singleton ?? false,
  );
  if (!tab || !commandId) return;
  const command: PendingExtensionCommand = {
    id: commandId,
    requestId:
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
  const target = frameTargets.get(tab.id);
  if (target?.ready) {
    target.post(command);
    return;
  }
  const queue = commandQueues.get(tab.id) ?? [];
  if (queue.length >= MAX_QUEUED_COMMANDS) {
    notify(`${extension.name} is still loading; command queue is full`);
    return;
  }
  queue.push(command);
  commandQueues.set(tab.id, queue);
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
  if (
    candidate.singleton !== undefined &&
    typeof candidate.singleton !== "boolean"
  ) {
    return false;
  }
  if (
    candidate.capabilities !== undefined &&
    (!Array.isArray(candidate.capabilities) ||
      candidate.capabilities.some(
        (capability) =>
          capability !== "session-context" && capability !== "presentation",
      ))
  ) {
    return false;
  }
  if (
    candidate.commands !== undefined &&
    (!Array.isArray(candidate.commands) ||
      candidate.commands.length > 32 ||
      !validExtensionCommands(candidate.commands))
  ) {
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

function validExtensionCommands(commands: ExtensionCommandInfo[]): boolean {
  const ids = new Set<string>();
  for (const command of commands) {
    if (
      !command ||
      typeof command !== "object" ||
      typeof command.id !== "string" ||
      !EXTENSION_COMMAND_ID.test(command.id) ||
      ids.has(command.id) ||
      typeof command.title !== "string" ||
      !command.title.trim() ||
      command.title.length > 128 ||
      (command.keywords !== undefined &&
        (!Array.isArray(command.keywords) ||
          command.keywords.length > 8 ||
          command.keywords.some(
            (keyword) =>
              typeof keyword !== "string" ||
              !keyword.trim() ||
              keyword.length > 64,
          )))
    ) {
      return false;
    }
    ids.add(command.id);
  }
  return true;
}
