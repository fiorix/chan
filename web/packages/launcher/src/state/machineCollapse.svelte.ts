// Per-machine collapse state for the launcher's machine cards ("This machine"
// plus each devserver), persisted so a collapsed card stays collapsed across a
// reload AND a desktop restart. A collapsed card shows only its header row.
//
// localStorage is a first-paint cache; the authoritative copy is the desktop
// config, reached via `/api/library/collapsed-machines` (the launcher-theme
// side-channel pattern). The desktop launcher origin is a random loopback port
// per launch, so a config-backed store is the only thing that survives a
// restart. Surfaces with no store (a plain browser, a headless devserver)
// answer 404/401, which is swallowed; the in-memory toggle still works.
//
// Keys are the machine identity: "local" for the local card, the persisted
// Devserver.id per devserver (matching the machine tree's card key). Default
// expanded; only collapsed keys are stored. Stale ids are harmless and left
// unpruned.

import { authToken } from "./authToken";

const STORAGE_KEY = "chan-launcher-collapsed-machines";

function initialCollapsed(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed.filter((k): k is string => typeof k === "string");
  } catch {
    // Storage unavailable (private mode) or malformed JSON: start expanded.
  }
  return [];
}

export const collapsedState = $state<{ keys: string[] }>({ keys: initialCollapsed() });

export function isMachineCollapsed(key: string): boolean {
  return collapsedState.keys.includes(key);
}

function cacheCollapsed(keys: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Best-effort persistence; the in-memory toggle still works without it.
  }
}

/// Mirror the collapsed set to the desktop config (`PUT
/// /api/library/collapsed-machines`). Best-effort: a surface with no store (a
/// plain browser, a headless devserver) answers 404/401, which is swallowed, so
/// the toggle never breaks.
async function putCollapsed(keys: string[]): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    await fetch("/api/library/collapsed-machines", {
      method: "PUT",
      headers,
      body: JSON.stringify({ collapsed: keys }),
    });
  } catch {
    // Network or store-less surface: the in-memory + cached toggle still stands.
  }
}

export function toggleMachineCollapsed(key: string): void {
  collapsedState.keys = collapsedState.keys.includes(key)
    ? collapsedState.keys.filter((k) => k !== key)
    : [...collapsedState.keys, key];
  cacheCollapsed(collapsedState.keys);
  void putCollapsed(collapsedState.keys);
}

/// After first paint, reconcile the launcher's collapsed set with the
/// authoritative desktop-config value (`GET /api/library/collapsed-machines`).
/// localStorage is only a first-paint cache; a cleared WebView store or a
/// second writer would otherwise leave the launcher and the config out of sync.
/// When the config holds an array, adopt it (and refresh the cache); when it is
/// null (unset / no store / unreachable), keep the current set, which the next
/// toggle seeds into the config.
export async function reconcileCollapsedMachines(): Promise<void> {
  const headers: Record<string, string> = {};
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let collapsed: unknown = null;
  try {
    const res = await fetch("/api/library/collapsed-machines", { headers });
    if (!res.ok) return;
    const body = (await res.json()) as { collapsed?: string[] | null };
    collapsed = body?.collapsed ?? null;
  } catch {
    return;
  }
  if (Array.isArray(collapsed)) {
    const keys = collapsed.filter((k): k is string => typeof k === "string");
    collapsedState.keys = keys;
    cacheCollapsed(keys);
  }
}
