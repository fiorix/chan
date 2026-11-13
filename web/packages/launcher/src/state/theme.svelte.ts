// The launcher's theme: the system's preference, or dark or light whatever
// the system prefers. The theme showing is applied as `data-theme` on the
// document element (the CSS tokens key off it), and a pinned choice is stored
// so a reload keeps it. Nothing stored means the system's preference.
//
// On chan-desktop the desktop's local-theme store holds the choice and the
// page's storage only paints it first; elsewhere the page's storage is the
// only store.

import { authToken } from "./authToken";
import { hasDesktopBridge } from "./capabilities";

export type Theme = "dark" | "light";
/// What the user chose: one theme, or to follow the system's preference.
export type ThemeChoice = "system" | Theme;

const STORAGE_KEY = "chan-launcher-theme-choice";
/// Where a launcher whose choice had no System (v0.128.0 and earlier) stored
/// its pin. On chan-desktop that pin can be missing from the desktop's store,
/// whose empty value means System, so it is read until it has been carried
/// to the store that holds the choice on this surface (`reconcileLocalTheme`).
/// This launcher never writes it, and removes it whenever it stores a choice.
const PRIOR_KEY = "chan-launcher-theme";
const LIGHT_SCHEME = "(prefers-color-scheme: light)";

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

function storedTheme(key: string): Theme | null {
  try {
    const stored = localStorage.getItem(key);
    return isTheme(stored) ? stored : null;
  } catch {
    // Storage unavailable (private mode): nothing is stored.
    return null;
  }
}

/// A pin from before System was offered, not yet carried over.
function priorPin(): Theme | null {
  return storedTheme(PRIOR_KEY);
}

/// The theme the system prefers: dark unless it says light, so a system that
/// states no preference reads dark.
function systemTheme(): Theme {
  try {
    return typeof matchMedia === "function" && matchMedia(LIGHT_SCHEME).matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/// The prior pin first: this launcher removes it whenever it stores a choice,
/// so beside a stored choice it can only be newer, from an older launcher run
/// on this page since.
function storedChoice(): ThemeChoice {
  return priorPin() ?? storedTheme(STORAGE_KEY) ?? "system";
}

let choice = $state<ThemeChoice>(storedChoice());
let system = $state<Theme>(systemTheme());

export const themeState = {
  /// What the user chose. Assigning sets it for this page without storing it.
  get choice(): ThemeChoice {
    return choice;
  },
  set choice(next: ThemeChoice) {
    choice = next;
  },
  /// The theme showing: the choice, or the system's while the choice is to
  /// follow it. Assigning a theme pins it for this page without storing it,
  /// which is how a preview holds one theme whatever the system prefers.
  get theme(): Theme {
    return choice === "system" ? system : choice;
  },
  set theme(next: Theme) {
    choice = next;
  },
};

export function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", themeState.theme);
}

// The document carries the theme for as long as the page lives, so the
// system's preference is followed for as long: a change repaints while the
// choice is to follow it, and is remembered for when it becomes so.
function followSystem(): void {
  try {
    if (typeof matchMedia !== "function") return;
    matchMedia(LIGHT_SCHEME).addEventListener("change", () => {
      system = systemTheme();
      if (choice === "system") applyTheme();
    });
  } catch {
    // An engine that reports no changes keeps the preference read at load.
  }
}
followSystem();

/// Store a pinned theme; following the system is the absence of one. A
/// choice stored settles any prior pin, so it cannot come back.
function cacheChoice(next: ThemeChoice): void {
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    localStorage.removeItem(PRIOR_KEY);
  } catch {
    // Best-effort persistence; the in-memory choice still works without it.
  }
}

/// Take a choice another writer made as this page's own, without writing it
/// back. It is stored even when it is the choice showing, which settles a
/// prior pin the store already agrees with.
function adoptChoice(next: ThemeChoice): void {
  cacheChoice(next);
  if (next === choice) return;
  choice = next;
  applyTheme();
}

/// Mirror the launcher's choice to the desktop config so a local standalone
/// terminal window follows it (`PUT /api/library/local-theme`). The config
/// holds `"dark"`, `"light"`, or null for the system's preference, which is
/// how the desktop's own windows already read an unset value. Best-effort and
/// DESKTOP-only: a surface with no local-theme store (a plain browser, a
/// headless devserver) answers 404/401, which is swallowed, so the switch
/// never breaks. Resolves whether the store took the value. Kept off
/// `LibraryApi`: this is a desktop-config side-channel, not library-registry
/// data.
async function putLocalTheme(theme: Theme | null): Promise<boolean> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch("/api/library/local-theme", {
      method: "PUT",
      headers,
      body: JSON.stringify({ theme }),
    });
    return res.ok;
  } catch {
    // Network or store-less surface: the in-memory + cached choice still stands.
    return false;
  }
}

/// Make `next` the user's choice: show it, store it and mirror it to the
/// desktop. A theme pins: choosing the one already showing stops it following
/// the system. `system` un-pins, and follows the system from then on.
export function setThemeChoice(next: ThemeChoice): void {
  choice = next;
  cacheChoice(next);
  applyTheme();
  void putLocalTheme(next === "system" ? null : next);
}

/**
 * Follow changes written by another launcher webview. The native command deck
 * is a separate transparent webview, so its optimistic DOM update cannot
 * recolor the underlying Computers window by itself. The desktop-owned theme
 * feed pushes the authoritative value on connect and after every write, and
 * its null is the choice to follow the system: a caller subscribes only where
 * the desktop holds the theme, since a surface with no store reports null
 * whatever was chosen there. The one exception is a prior pin still waiting
 * to be carried to the store: its carry-over is in flight, or failed and runs
 * again at the next load, so the store's null says nothing about it yet.
 */
export function watchLocalTheme(): () => void {
  if (typeof WebSocket === "undefined" || typeof location === "undefined") return () => {};

  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = (): void => {
    if (stopped || timer !== null) return;
    const delay = Math.min(500 * 2 ** attempt, 15000);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) open();
    }, delay);
  };

  const open = (): void => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const token = authToken();
    const query = token ? `?t=${encodeURIComponent(token)}` : "";
    socket = new WebSocket(`${proto}//${location.host}/api/library/local-theme/watch${query}`);
    socket.onmessage = (event) => {
      attempt = 0;
      try {
        const frame = JSON.parse(event.data) as { theme?: unknown };
        if (frame.theme === null) {
          if (priorPin() === null) adoptChoice("system");
        } else if (isTheme(frame.theme)) adoptChoice(frame.theme);
      } catch {
        // Drop malformed frames; the next full value self-heals.
      }
    };
    socket.onclose = scheduleReconnect;
    socket.onerror = () => socket?.close();
  };

  open();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    socket?.close();
  };
}

/// After first paint, reconcile the launcher's theme with the authoritative
/// desktop-config value (`GET /api/library/local-theme`). localStorage is only
/// a first-paint cache; a cleared WebView store or a future second writer would
/// otherwise leave the launcher on one theme and the terminals on another. When
/// the config holds a theme, adopt it (and refresh the cache), over a prior pin
/// too, as the launcher that stored the pin did. A null settles nothing for a
/// choice this launcher stored, since a surface with no store answers null too:
/// the current choice stands, and where the desktop holds the theme its feed
/// decides. A prior pin is carried over once: on the desktop to the empty
/// store, and stored as this launcher's choice once the store has it;
/// elsewhere straight to the page's storage, the only store there.
export async function reconcileLocalTheme(): Promise<void> {
  const headers: Record<string, string> = {};
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let theme: unknown;
  try {
    const res = await fetch("/api/library/local-theme", { headers });
    if (!res.ok) return;
    theme = ((await res.json()) as { theme?: unknown } | null)?.theme;
  } catch {
    return;
  }
  if (isTheme(theme)) {
    adoptChoice(theme);
    return;
  }
  const prior = priorPin();
  if (theme !== null || prior === null) return;
  if (hasDesktopBridge && !(await putLocalTheme(prior))) return;
  // A choice made meanwhile, here or from the feed, has settled the pin.
  if (priorPin() === prior) cacheChoice(prior);
}
