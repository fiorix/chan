import {
  createDeckDraft,
  loadSessionDeckDraft,
  saveSessionDeckDraft,
  SESSION_DECK_DRAFT_KEY,
  type DeckDraft,
} from "@chan/web-shared/command-deck";

// A browser/webview reload recreates the component. The agreed draft includes
// visibility, so an open inline launcher comes back open after reload.
export const commandLauncher = $state<{ draft: DeckDraft }>({
  draft: loadSessionDeckDraft(SESSION_DECK_DRAFT_KEY),
});

export function activeCommandLauncherDraft(): DeckDraft {
  return commandLauncher.draft;
}

export function persistCommandLauncherDraft(): void {
  saveSessionDeckDraft(SESSION_DECK_DRAFT_KEY, commandLauncher.draft);
}

/** Show the deck at its root: no page, no filter and no card, with the last
 * query kept for the deck to select, so Enter repeats it and typing replaces
 * it. A reload restores an open deck where it stood, since it does not come
 * through here. */
export function openCommandLauncher(): void {
  const draft = commandLauncher.draft;
  if (!draft.visible) {
    draft.path = [];
    draft.scope = null;
    draft.selectedId = null;
    draft.operation = null;
  }
  draft.visible = true;
  persistCommandLauncherDraft();
}

export function closeCommandLauncher(): void {
  commandLauncher.draft.visible = false;
  persistCommandLauncherDraft();
}

export function clearCommandLauncherDraft(): void {
  const visible = commandLauncher.draft.visible;
  commandLauncher.draft = createDeckDraft();
  commandLauncher.draft.visible = visible;
  persistCommandLauncherDraft();
}

export function toggleCommandLauncher(): void {
  if (commandLauncher.draft.visible) closeCommandLauncher();
  else openCommandLauncher();
}

// The windows the deck last acted on, most recent first, for its Recent
// windows section. The feed carries no focus time, so the deck's own use is
// the record: a window it focused, showed or opened, and one that arrived
// after it asked for it. Kept for this tab like the draft, under the draft's
// key prefix, so a window opened from here does not inherit the list.
const RECENT_WINDOWS_KEY = "chan.command-launcher.v1:recent-windows";
// More than the section shows, so it stays full as windows close.
const RECENT_WINDOWS_KEPT = 12;

function loadRecentWindows(): string[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(RECENT_WINDOWS_KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((key): key is string => typeof key === "string" && key.length <= 256)
      .slice(0, RECENT_WINDOWS_KEPT);
  } catch {
    return [];
  }
}

export const recentWindows = $state<{ keys: string[] }>({ keys: loadRecentWindows() });

export function noteRecentWindow(key: string): void {
  recentWindows.keys = [key, ...recentWindows.keys.filter((kept) => kept !== key)].slice(
    0,
    RECENT_WINDOWS_KEPT,
  );
  try {
    sessionStorage.setItem(RECENT_WINDOWS_KEY, JSON.stringify(recentWindows.keys));
  } catch {
    // The list still orders this page's section when storage is denied.
  }
}

export function clearRecentWindows(): void {
  recentWindows.keys = [];
  try {
    sessionStorage.removeItem(RECENT_WINDOWS_KEY);
  } catch {
    // Nothing was saved where storage is denied.
  }
}
