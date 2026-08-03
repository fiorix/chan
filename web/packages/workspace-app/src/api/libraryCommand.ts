// Browser command-launcher access to the ONE chan-library that serves this
// window. The tenant bearer may mint only a short-lived capability bound to the
// invoking window's live /ws presence. The capability and its snapshots stay in
// module memory: launcher drafts persist across reload, authority does not.

import { sessionWindowId } from "./client";
import { ApiError } from "./errors";
import { requestRoot } from "./transport";

export type LibraryCommandRole = "owner" | "readonly";
export type ScopedWindowKind = "terminal" | "workspace";
export type ScopedWorkspaceStatus =
  | "stopped"
  | "starting"
  | "running"
  | "locked"
  | "closing"
  | "removing"
  | "error";

export interface ScopedLibraryWindow {
  window_id: string;
  kind: ScopedWindowKind;
  title: string;
  ordinal: number;
  workspace_path: string | null;
  connected: boolean;
  hidden: boolean;
  control: boolean;
  can_act: boolean;
  /** Same-origin redirect that revalidates the capability before attaching. */
  launch_path: string;
}

export interface ScopedLibraryWorkspace {
  workspace_id: string;
  path: string;
  label: string;
  on: boolean;
  status: ScopedWorkspaceStatus;
  error?: string;
  library_id: string | null;
  devserver_id: string | null;
  prefix: string;
  can_act: boolean;
}

export type ScopedLibraryWindowMode = "browser" | "desktop" | "native_watcher";

export interface ScopedLibrarySnapshot {
  library_id: string;
  role: LibraryCommandRole;
  window_mode: ScopedLibraryWindowMode;
  windows: ScopedLibraryWindow[];
  workspaces: ScopedLibraryWorkspace[];
}

export type ScopedLibraryAction =
  | { action: "new_terminal" }
  | { action: "new_workspace_window"; workspace_id: string }
  | { action: "focus_window"; window_id: string }
  | { action: "set_window_visibility"; window_id: string; hidden: boolean };
interface MintedLibraryCommandCapability {
  token: string;
  role: LibraryCommandRole;
  expires_in_seconds: number;
}

export interface ScopedLibraryActionResult {
  window?: ScopedLibraryWindow;
}

let capability: MintedLibraryCommandCapability | null = null;
let mintInFlight: Promise<MintedLibraryCommandCapability> | null = null;

function tenantPrefix(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector('meta[name="chan-prefix"]')?.getAttribute("content")?.trim() ?? "";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mintCapability(): Promise<MintedLibraryCommandCapability> {
  // The app's main /ws may still be opening when the user invokes the launcher
  // immediately after load. Retry only that expected liveness race.
  const delays = [0, 100, 300, 800];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await pause(delay);
    try {
      return await requestRoot<MintedLibraryCommandCapability>(
        "POST",
        "/api/library/command-capabilities",
        { window_id: sessionWindowId(), tenant_prefix: tenantPrefix() },
      );
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiError) || error.status !== 403) throw error;
    }
  }
  throw lastError;
}

async function ensureCapability(): Promise<MintedLibraryCommandCapability> {
  if (capability) return capability;
  if (!mintInFlight) {
    mintInFlight = mintCapability()
      .then((minted) => {
        capability = minted;
        return minted;
      })
      .finally(() => {
        mintInFlight = null;
      });
  }
  return mintInFlight;
}

function capabilityPath(token: string, suffix = ""): string {
  return `/api/library/command-capabilities/${encodeURIComponent(token)}${suffix}`;
}

function capabilityRejected(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 410);
}

async function withCapability<T>(
  use: (minted: MintedLibraryCommandCapability) => Promise<T>,
): Promise<T> {
  let minted = await ensureCapability();
  try {
    return await use(minted);
  } catch (error) {
    if (!capabilityRejected(error)) throw error;
    capability = null;
    minted = await ensureCapability();
    return use(minted);
  }
}

export function loadScopedLibrarySnapshot(): Promise<ScopedLibrarySnapshot> {
  return withCapability((minted) =>
    requestRoot<ScopedLibrarySnapshot>("GET", capabilityPath(minted.token)),
  );
}

export function runScopedLibraryAction(
  action: ScopedLibraryAction,
): Promise<ScopedLibraryActionResult | undefined> {
  return withCapability((minted) =>
    requestRoot<ScopedLibraryActionResult | undefined>(
      "POST",
      capabilityPath(minted.token, "/actions"),
      action,
    ),
  );
}

/** Drop authority after a definitive liveness/auth failure or in tests. */
export function resetScopedLibraryCapability(): void {
  capability = null;
  mintInFlight = null;
}
