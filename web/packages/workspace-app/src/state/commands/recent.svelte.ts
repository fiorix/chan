// The commands last run from the launcher in this window, most recent
// first. Kept in session storage beside the launcher's draft, so the list
// follows the window across a reload and ends with the browser tab.

const RECENT_COMMANDS_KEY = "chan.command-launcher.recent.v1";

/// More ids are remembered than the launcher lists, since it shows only the
/// ones that can run where it opens.
const RECENT_COMMANDS_KEPT = 16;

function load(): string[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)
      .slice(0, RECENT_COMMANDS_KEPT);
  } catch {
    return [];
  }
}

const recent = $state<{ ids: string[] }>({ ids: load() });

/// The remembered command ids, most recent first.
export function recentCommandIds(): readonly string[] {
  return recent.ids;
}

/// Record that the launcher ran `id`, moving it to the front.
export function noteCommandRun(id: string): void {
  recent.ids = [id, ...recent.ids.filter((other) => other !== id)].slice(0, RECENT_COMMANDS_KEPT);
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(recent.ids));
  } catch {
    // Storage denial leaves the list in memory for this page's lifetime.
  }
}

/// Forget every remembered command.
export function clearRecentCommands(): void {
  recent.ids = [];
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(RECENT_COMMANDS_KEY);
  } catch {
    // Nothing was stored where storage is denied.
  }
}
