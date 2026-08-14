/// Selectable shells for the terminal profile picker.
///
/// Sourced from `GET /api/terminal/shells`, which returns discovery layered
/// with the user's declared profiles -- the same merge the server runs at
/// spawn, so what the picker lists cannot drift from what clicking it does.
///
/// Loaded once, lazily, on first use. The list changes only when the machine's
/// installed shells or the user's config change, neither of which happens
/// mid-session often enough to justify polling; `reloadShellProfiles()` exists
/// for the settings pane to call after a config write.
///
/// Failure is silent and non-fatal: a server that predates the endpoint 404s,
/// which leaves the list empty and collapses the picker back to a plain "new
/// terminal" button. Callers must treat an empty list as "no picker", never as
/// "no shells".
import { api } from "../api/client";
import type { ShellProfileView } from "../api/types";

let profiles = $state<ShellProfileView[]>([]);
let defaultProfileId = $state<string | null>(null);
let loaded = $state(false);
let inflight: Promise<void> | null = null;

export function shellProfiles(): ShellProfileView[] {
  return profiles;
}

/// Id of the profile new terminals spawn with when none is named. Echoed by
/// the server only when it resolves to a listed profile, so a stale
/// `default_profile` in the config reads as "no default" here rather than
/// highlighting an entry that does not exist.
export function defaultShellProfileId(): string | null {
  return defaultProfileId;
}

export function shellProfilesLoaded(): boolean {
  return loaded;
}

/// Fetch once. Concurrent callers share the in-flight promise rather than
/// racing duplicate requests -- several panes can mount their picker at the
/// same time.
export function ensureShellProfiles(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = api
    .terminalShells()
    .then((res) => {
      profiles = res.profiles ?? [];
      defaultProfileId = res.default_profile ?? null;
    })
    .catch(() => {
      // Older server, or the endpoint is unreachable. Empty list = no picker.
      profiles = [];
      defaultProfileId = null;
    })
    .finally(() => {
      loaded = true;
      inflight = null;
    });
  return inflight;
}

/// Drop the cache so the next `ensureShellProfiles()` refetches. For the
/// settings pane after a `terminal.profiles` write.
export function reloadShellProfiles(): Promise<void> {
  loaded = false;
  inflight = null;
  return ensureShellProfiles();
}

/// Display name for a profile id, for a tab tooltip or indicator. Falls back to
/// the raw id when the profile is unknown -- a tab restored from a hash can
/// name a profile this machine no longer has, and showing the id beats showing
/// nothing.
export function shellProfileLabel(id: string | undefined): string | null {
  if (!id) return null;
  return profiles.find((p) => p.id === id)?.name ?? id;
}
