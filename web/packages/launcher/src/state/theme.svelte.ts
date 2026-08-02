// Dark/light theme, applied as `data-theme` on the document element (the CSS
// tokens key off it) and persisted so a reload keeps the user's choice.

export type Theme = "dark" | "light";

const STORAGE_KEY = "chan-launcher-theme";

function prefersLight(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    return false;
  }
}

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // Storage unavailable (private mode): fall through to the system default.
  }
  return prefersLight() ? "light" : "dark";
}

export const themeState = $state<{ theme: Theme }>({ theme: initialTheme() });

export function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", themeState.theme);
}

function cacheTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Best-effort persistence; the in-memory toggle still works without it.
  }
}

function adoptLocalTheme(theme: string | null): void {
  if ((theme !== "dark" && theme !== "light") || theme === themeState.theme) return;
  themeState.theme = theme;
  cacheTheme(theme);
  applyTheme();
}

// The bearer the launcher is served with (loopback `?t=<token>`), mirroring
// library.ts. Empty means same-origin with no bearer. Guarded for non-browser
// (test) contexts where `location` may be absent.
function authToken(): string {
  try {
    return new URLSearchParams(location.search).get("t") ?? "";
  } catch {
    return "";
  }
}

/// Mirror the launcher's light/dark choice to the desktop config so a local
/// standalone terminal window follows it (`PUT /api/library/local-theme`).
/// Best-effort and DESKTOP-only: a surface with no local-theme store (a plain
/// browser, a headless devserver) answers 404/401, which is swallowed, so the
/// toggle never breaks. Kept off `LibraryApi`: this is a desktop-config
/// side-channel, not library-registry data.
async function putLocalTheme(theme: Theme): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    await fetch("/api/library/local-theme", {
      method: "PUT",
      headers,
      body: JSON.stringify({ theme }),
    });
  } catch {
    // Network or store-less surface: the in-memory + cached toggle still stands.
  }
}

export function toggleTheme(): void {
  themeState.theme = themeState.theme === "dark" ? "light" : "dark";
  cacheTheme(themeState.theme);
  applyTheme();
  void putLocalTheme(themeState.theme);
}

/**
 * Follow changes written by another launcher webview. The native command deck
 * is a separate transparent webview, so its optimistic DOM update cannot
 * recolor the underlying Computers window by itself. The desktop-owned theme
 * feed pushes the authoritative value on connect and after every write.
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
        const frame = JSON.parse(event.data) as { theme?: string | null };
        adoptLocalTheme(frame?.theme ?? null);
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
/// the config holds a value, adopt it (and refresh the cache); when it is null
/// (unset / no store / unreachable), keep the current choice, which the next
/// toggle seeds into the config.
export async function reconcileLocalTheme(): Promise<void> {
  const headers: Record<string, string> = {};
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let theme: string | null = null;
  try {
    const res = await fetch("/api/library/local-theme", { headers });
    if (!res.ok) return;
    const body = (await res.json()) as { theme?: string | null };
    theme = body?.theme ?? null;
  } catch {
    return;
  }
  adoptLocalTheme(theme);
}
