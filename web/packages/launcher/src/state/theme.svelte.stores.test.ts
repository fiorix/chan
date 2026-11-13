import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Where the Computers page's theme choice is kept: the page's own storage,
// and on chan-desktop the desktop's local-theme store, which the desktop's
// own windows read and whose feed every launcher webview follows. Each case
// builds the state a page can arrive in, then starts the real state module
// as App.svelte's onMount does: paint the stored choice, reconcile with the
// store, and on the desktop surface follow the store's feed. A reload is a
// fresh module over the same page storage and the same store; to the page a
// relaunch of the desktop is the same arrival, since the store lives in the
// desktop's config file and the page's storage survives with its origin.

type Theme = "dark" | "light";

/** Where a release whose choice had no System kept a pinned theme. */
const PRIOR = "chan-launcher-theme";
/** Where the page keeps its choice. */
const STORED = "chan-launcher-theme-choice";
const ROUTE = "/api/library/local-theme";

/** A system whose preference can change under the page. */
function systemStub(start: Theme) {
  const listeners = new Set<() => void>();
  const light = {
    matches: start === "light",
    media: "(prefers-color-scheme: light)",
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
  };
  return {
    matchMedia: (query: string) =>
      (query === light.media ? light : { ...light, media: query, matches: false }) as unknown as MediaQueryList,
    prefer(next: Theme): void {
      light.matches = next === "light";
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * The local-theme routes as chan-server answers them (`routes/library.rs`):
 * `GET` reads the store as `{"theme":...}`, `{"theme":null}` without one;
 * `PUT` writes it and answers 204, 404 without a store, 400 when the store
 * refuses the write; the watch feed sends the value on connect and after
 * every write. `null` for the store is a surface without one, a devserver
 * page in a plain browser. `refuse` is how many writes the store refuses;
 * `duringWrite` runs once, after the first write is applied and before the
 * page has its answer.
 */
function localThemeRoutes(
  store: { theme: Theme | null } | null,
  { refuse = 0, duringWrite }: { refuse?: number; duringWrite?: () => void } = {},
) {
  const written: Array<Theme | null> = [];
  const sockets: FeedSocket[] = [];
  const frame = (): string => JSON.stringify({ theme: store ? store.theme : null });
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  class FeedSocket {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    connected = false;
    closed = false;
    constructor(readonly url: string) {
      sockets.push(this);
    }
    deliver(data: string): void {
      if (!this.closed) this.onmessage?.(new MessageEvent("message", { data }));
    }
    close(): void {
      this.closed = true;
    }
  }

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== ROUTE) return new Response(null, { status: 404 });
    if (init?.method !== "PUT") return json({ theme: store ? store.theme : null }, 200);
    const { theme } = JSON.parse(String(init.body)) as { theme: Theme | null };
    written.push(theme);
    if (!store) return json({ error: "local theme is not available on this surface" }, 404);
    if (refuse > 0) {
      refuse -= 1;
      return json({ error: "writing the desktop config failed" }, 400);
    }
    store.theme = theme;
    for (const socket of sockets) if (socket.connected) socket.deliver(frame());
    const hook = duringWrite;
    duringWrite = undefined;
    hook?.();
    return new Response(null, { status: 204 });
  });

  return {
    fetchMock,
    FeedSocket,
    written,
    get theme(): Theme | null {
      return store ? store.theme : null;
    },
    /** Send the connect frame to every feed opened since the last call. */
    connect(): void {
      for (const socket of sockets) {
        if (socket.connected || socket.closed) continue;
        socket.connected = true;
        socket.deliver(frame());
      }
    },
  };
}

type Routes = ReturnType<typeof localThemeRoutes>;

let stopPage: (() => void) | null = null;
/** The page `load` started last, for a write hook that acts on it. */
let current: typeof import("./theme.svelte") | null = null;

/**
 * Start a fresh page over the current storage and `routes`, as App.svelte's
 * onMount does, with the system preferring `system`. The previous page is
 * gone first, so its feed hears nothing more. `reconciled` settles when the
 * load's reconcile has.
 */
async function load(routes: Routes, system: Theme = "light") {
  stopPage?.();
  vi.resetModules();
  const os = systemStub(system);
  vi.stubGlobal("matchMedia", os.matchMedia);
  vi.stubGlobal("fetch", routes.fetchMock);
  vi.stubGlobal("WebSocket", routes.FeedSocket);
  const theme = await import("./theme.svelte");
  const { hasDesktopBridge } = await import("./capabilities");
  current = theme;
  theme.applyTheme();
  const reconciled = theme.reconcileLocalTheme();
  const stop = hasDesktopBridge ? theme.watchLocalTheme() : () => {};
  stopPage = stop;
  return { ...theme, os, reconciled };
}

/** Make this document a devserver page, which the desktop does not serve. */
function devserverSurface(): void {
  const meta = document.createElement("meta");
  meta.name = "chan-launcher-surface";
  meta.content = "devserver";
  document.head.append(meta);
}

const shown = (): string | null => document.documentElement.getAttribute("data-theme");
const stored = (): [string | null, string | null] => [localStorage.getItem(STORED), localStorage.getItem(PRIOR)];

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  stopPage?.();
  stopPage = null;
  current = null;
  document.head.querySelectorAll('meta[name="chan-launcher-surface"]').forEach((meta) => meta.remove());
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("on chan-desktop, a theme pinned in the page's storage before System was offered", () => {
  for (const first of ["feed", "reconcile"] as const) {
    test(`is kept and carried once to the desktop's empty store (the ${first} answers first)`, async () => {
      localStorage.setItem(PRIOR, "dark");
      const routes = localThemeRoutes({ theme: null });

      const page = await load(routes);
      if (first === "feed") routes.connect();
      await page.reconciled;
      routes.connect();

      expect([page.themeState.choice, shown()]).toEqual(["dark", "dark"]);
      expect([routes.theme, routes.written]).toEqual(["dark", ["dark"]]);
      expect(stored(), "kept as the page's own choice, the old key read once").toEqual(["dark", null]);

      const reloaded = await load(routes);
      await reloaded.reconciled;
      routes.connect();
      expect([reloaded.themeState.choice, shown()]).toEqual(["dark", "dark"]);
      expect(routes.written, "nothing carried twice").toEqual(["dark"]);
    });
  }

  for (const first of ["feed", "reconcile"] as const) {
    test(`is settled beside a store holding the same theme, with nothing written (the ${first} answers first)`, async () => {
      // The usual arrival: v0.128.0 mirrored the pin to the store.
      localStorage.setItem(PRIOR, "dark");
      const routes = localThemeRoutes({ theme: "dark" });

      const page = await load(routes);
      if (first === "feed") routes.connect();
      await page.reconciled;
      routes.connect();

      expect([page.themeState.choice, shown()]).toEqual(["dark", "dark"]);
      expect([routes.theme, routes.written]).toEqual(["dark", []]);
      expect(stored(), "kept as the page's own choice, the old key gone").toEqual(["dark", null]);
    });
  }

  test("gives way to the other theme the desktop's store holds, as v0.128.0 did", async () => {
    // v0.128.0 painted the page's pin, then adopted the store's theme at
    // load and from the feed: the store is what its terminal windows showed.
    localStorage.setItem(PRIOR, "dark");
    const routes = localThemeRoutes({ theme: "light" });

    const page = await load(routes, "dark");
    expect(shown(), "first paint").toBe("dark");
    await page.reconciled;
    routes.connect();

    expect([page.themeState.choice, shown()]).toEqual(["light", "light"]);
    expect([routes.theme, routes.written]).toEqual(["light", []]);
    expect(stored()).toEqual(["light", null]);
  });

  test("once carried, System chosen stays System across reloads and follows the system", async () => {
    localStorage.setItem(PRIOR, "dark");
    const routes = localThemeRoutes({ theme: null });
    const page = await load(routes);
    await page.reconciled;
    routes.connect();
    expect([page.themeState.choice, routes.theme]).toEqual(["dark", "dark"]);

    page.setThemeChoice("system");
    expect([page.themeState.choice, shown(), routes.theme]).toEqual(["system", "light", null]);
    expect(stored()).toEqual([null, null]);

    for (const system of ["light", "dark"] as const) {
      const reloaded = await load(routes, system);
      await reloaded.reconciled;
      routes.connect();
      expect([reloaded.themeState.choice, shown()], `reload, system ${system}`).toEqual(["system", system]);
    }
    expect(routes.written).toEqual(["dark", null]);

    const last = await load(routes, "dark");
    await last.reconciled;
    routes.connect();
    last.os.prefer("light");
    expect([last.themeState.theme, shown()]).toEqual(["light", "light"]);
  });

  test("a choice made while the carry-over's write is in flight stands when the writes land in the order sent", async () => {
    // The fake applies the carry-over's write before the choice's. The module
    // orders nothing itself: a store that applied the choice's write first
    // would end on the carried pin.
    localStorage.setItem(PRIOR, "dark");
    const routes = localThemeRoutes({ theme: null }, { duringWrite: () => current?.setThemeChoice("system") });

    const page = await load(routes);
    await page.reconciled;
    // Read before the feed's frame, which would store its null over anything.
    expect([page.themeState.choice, shown(), routes.theme]).toEqual(["system", "light", null]);
    expect([routes.written, stored()]).toEqual([["dark", null], [null, null]]);
  });

  test("a carry-over the desktop's store refuses leaves the pin showing and runs at the next load", async () => {
    localStorage.setItem(PRIOR, "dark");
    const routes = localThemeRoutes({ theme: null }, { refuse: 1 });

    const page = await load(routes);
    routes.connect();
    await page.reconciled;
    expect([page.themeState.choice, shown(), routes.theme]).toEqual(["dark", "dark", null]);
    expect(stored(), "still waiting to be carried").toEqual([null, "dark"]);

    const reloaded = await load(routes);
    routes.connect();
    await reloaded.reconciled;
    expect([reloaded.themeState.choice, shown(), routes.theme]).toEqual(["dark", "dark", "dark"]);
    expect([routes.written, stored()]).toEqual([["dark", "dark"], ["dark", null]]);
  });
});

describe("on chan-desktop with no pin anywhere", () => {
  test("the choice is System and follows the system's preference live", async () => {
    const routes = localThemeRoutes({ theme: null });
    const page = await load(routes, "dark");
    await page.reconciled;
    routes.connect();
    expect([page.themeState.choice, shown()]).toEqual(["system", "dark"]);

    page.os.prefer("light");
    expect([page.themeState.theme, shown()]).toEqual(["light", "light"]);
    expect([routes.written, stored()]).toEqual([[], [null, null]]);
  });
});

describe("on a surface with no desktop store (a devserver page in a plain browser)", () => {
  test("a pin in the page's storage is kept there, moved to the page's own key once", async () => {
    devserverSurface();
    localStorage.setItem(PRIOR, "dark");
    const routes = localThemeRoutes(null);

    const page = await load(routes);
    await page.reconciled;
    expect([page.themeState.choice, shown()]).toEqual(["dark", "dark"]);
    expect([routes.written, stored()]).toEqual([[], ["dark", null]]);

    const reloaded = await load(routes);
    await reloaded.reconciled;
    expect([reloaded.themeState.choice, shown()]).toEqual(["dark", "dark"]);

    reloaded.setThemeChoice("system");
    const after = await load(routes);
    await after.reconciled;
    expect([after.themeState.choice, shown(), stored()]).toEqual(["system", "light", [null, null]]);
  });

  test("a pin an older launcher stored after this one stored a choice is the choice", async () => {
    // An older release run on this page again pins under its own key and
    // leaves this launcher's key as it was.
    devserverSurface();
    localStorage.setItem(STORED, "light");
    localStorage.setItem(PRIOR, "dark");
    const routes = localThemeRoutes(null);

    const page = await load(routes);
    await page.reconciled;
    expect([page.themeState.choice, shown(), stored()]).toEqual(["dark", "dark", ["dark", null]]);
  });

  test("with no pin the choice is System and nothing is stored or written", async () => {
    devserverSurface();
    const routes = localThemeRoutes(null);
    const page = await load(routes);
    await page.reconciled;
    expect([page.themeState.choice, shown()]).toEqual(["system", "light"]);
    expect([routes.written, stored()]).toEqual([[], [null, null]]);
  });
});
