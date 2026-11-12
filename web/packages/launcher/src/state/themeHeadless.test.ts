import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// The launcher's `system` fallback must resolve to dark when the OS
// appearance cannot be determined (headless linux), matching the main SPA.
// "Undeterminable" = matchMedia unavailable OR prefers-color-scheme: light
// does not match. A stored choice always wins. The stored choice and the
// system's preference are read at module load, so each scenario re-imports
// the module with matchMedia / localStorage primed first.

function matchMediaStub(opts: { light: boolean }) {
  return (query: string) =>
    ({
      matches: query === "(prefers-color-scheme: light)" ? opts.light : false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }) as unknown as MediaQueryList;
}

/** A system whose preference can change under the page. */
function systemStub(start: "light" | "dark") {
  const listeners = new Set<() => void>();
  const light = {
    matches: start === "light",
    media: "(prefers-color-scheme: light)",
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
  };
  return {
    matchMedia: (query: string) =>
      (query === light.media ? light : matchMediaStub({ light: false })(query)) as MediaQueryList,
    prefer(next: "light" | "dark"): void {
      light.matches = next === "light";
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A fetch that answers every write, and the themes the page wrote. */
function putStub() {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
  const written = (): unknown[] =>
    fetchMock.mock.calls
      .filter(([url, init]) => url === "/api/library/local-theme" && init?.method === "PUT")
      .map(([, init]) => (JSON.parse(String(init?.body)) as { theme: unknown }).theme);
  return { fetchMock, written };
}

const STORED = "chan-launcher-theme";
const shown = (): string | null => document.documentElement.getAttribute("data-theme");

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("launcher initial theme headless fallback", () => {
  test("dark when matchMedia is unavailable", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const { themeState } = await import("./theme.svelte");
    expect(themeState.theme).toBe("dark");
  });

  test("dark when prefers-color-scheme: light does not match (undeterminable)", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: false }));
    const { themeState } = await import("./theme.svelte");
    expect(themeState.theme).toBe("dark");
  });

  test("light only when the OS explicitly prefers light", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: true }));
    const { themeState } = await import("./theme.svelte");
    expect(themeState.theme).toBe("light");
  });

  test("a stored choice wins over the system fallback", async () => {
    localStorage.setItem("chan-launcher-theme", "light");
    vi.stubGlobal("matchMedia", undefined);
    const { themeState } = await import("./theme.svelte");
    expect(themeState.theme).toBe("light");
  });

  test("reads as System with nothing stored, and as the pinned theme with one", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: true }));
    expect((await import("./theme.svelte")).themeState.choice).toBe("system");
    for (const pinned of ["dark", "light"] as const) {
      vi.resetModules();
      localStorage.setItem(STORED, pinned);
      const { themeState } = await import("./theme.svelte");
      expect([themeState.choice, themeState.theme]).toEqual([pinned, pinned]);
    }
    // A value no theme is named by is no choice.
    vi.resetModules();
    localStorage.setItem(STORED, "sepia");
    const { themeState } = await import("./theme.svelte");
    expect([themeState.choice, themeState.theme]).toEqual(["system", "light"]);
  });
});

describe("the launcher's theme choice", () => {
  test("System follows the system's preference as it changes", async () => {
    const os = systemStub("dark");
    vi.stubGlobal("matchMedia", os.matchMedia);
    const { themeState, applyTheme } = await import("./theme.svelte");
    applyTheme();
    expect([themeState.choice, themeState.theme, shown()]).toEqual(["system", "dark", "dark"]);

    os.prefer("light");
    expect([themeState.choice, themeState.theme, shown()]).toEqual(["system", "light", "light"]);
    os.prefer("dark");
    expect([themeState.theme, shown()]).toEqual(["dark", "dark"]);
    expect(localStorage.getItem(STORED), "following stores nothing").toBeNull();
  });

  test("a pinned theme holds whatever the system comes to prefer", async () => {
    const os = systemStub("dark");
    vi.stubGlobal("matchMedia", os.matchMedia);
    vi.stubGlobal("fetch", putStub().fetchMock);
    const { themeState, setThemeChoice } = await import("./theme.svelte");

    setThemeChoice("dark");
    os.prefer("light");
    expect([themeState.choice, themeState.theme, shown()]).toEqual(["dark", "dark", "dark"]);
  });

  test("System un-pins: it shows the system's theme now, stores nothing and tells the desktop null", async () => {
    const os = systemStub("light");
    vi.stubGlobal("matchMedia", os.matchMedia);
    const { fetchMock, written } = putStub();
    vi.stubGlobal("fetch", fetchMock);
    localStorage.setItem(STORED, "dark");
    const { themeState, applyTheme, setThemeChoice } = await import("./theme.svelte");
    applyTheme();
    expect([themeState.choice, shown()]).toEqual(["dark", "dark"]);

    setThemeChoice("system");
    expect([themeState.choice, themeState.theme, shown()]).toEqual(["system", "light", "light"]);
    expect(localStorage.getItem(STORED)).toBeNull();
    expect(written()).toEqual([null]);
    // And it follows from then on, a change made while pinned included.
    os.prefer("dark");
    expect([themeState.theme, shown()]).toEqual(["dark", "dark"]);
  });

  test("the choice survives a reload: a pin as stored, System as nothing stored", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: true }));
    vi.stubGlobal("fetch", putStub().fetchMock);
    const first = await import("./theme.svelte");
    first.setThemeChoice("dark");
    vi.resetModules();
    const second = await import("./theme.svelte");
    expect([second.themeState.choice, second.themeState.theme]).toEqual(["dark", "dark"]);
    second.setThemeChoice("system");
    vi.resetModules();
    const third = await import("./theme.svelte");
    expect([third.themeState.choice, third.themeState.theme]).toEqual(["system", "light"]);
  });

  test("a theme assigned to the state pins it for this page and stores nothing", async () => {
    const os = systemStub("light");
    vi.stubGlobal("matchMedia", os.matchMedia);
    const { fetchMock } = putStub();
    vi.stubGlobal("fetch", fetchMock);
    const { themeState, applyTheme } = await import("./theme.svelte");
    themeState.theme = "dark";
    applyTheme();
    os.prefer("dark");
    os.prefer("light");
    expect([themeState.choice, themeState.theme, shown()]).toEqual(["dark", "dark", "dark"]);
    expect(localStorage.getItem(STORED)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a theme chosen shows, is stored and is mirrored to the desktop config", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: false })); // start dark
    const { fetchMock, written } = putStub();
    vi.stubGlobal("fetch", fetchMock);
    const { themeState, setThemeChoice } = await import("./theme.svelte");
    expect(themeState.theme).toBe("dark");

    setThemeChoice("light");

    expect([themeState.choice, themeState.theme, shown()]).toEqual(["light", "light", "light"]);
    expect(localStorage.getItem(STORED)).toBe("light");
    // The PUT fires synchronously (fire-and-forget) with the new theme.
    expect(written()).toEqual(["light"]);

    setThemeChoice("dark");
    expect([themeState.choice, themeState.theme, shown()]).toEqual(["dark", "dark", "dark"]);
    expect(localStorage.getItem(STORED)).toBe("dark");
    expect(written()).toEqual(["light", "dark"]);
  });

  test("choosing the theme already showing pins it", async () => {
    // Light because the system prefers it, with nothing stored.
    vi.stubGlobal("matchMedia", matchMediaStub({ light: true }));
    const { fetchMock, written } = putStub();
    vi.stubGlobal("fetch", fetchMock);
    const { themeState, setThemeChoice } = await import("./theme.svelte");
    expect([themeState.choice, themeState.theme]).toEqual(["system", "light"]);

    setThemeChoice("light");

    expect([themeState.choice, themeState.theme]).toEqual(["light", "light"]);
    expect(localStorage.getItem(STORED)).toBe("light");
    expect(written()).toEqual(["light"]);
  });

  test("a choice still shows when the PUT fails (best-effort)", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: false }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no store");
      }),
    );
    const { themeState, setThemeChoice } = await import("./theme.svelte");
    setThemeChoice("light");
    expect(themeState.theme).toBe("light");
    setThemeChoice("system");
    expect([themeState.choice, themeState.theme]).toEqual(["system", "dark"]);
  });
});

describe("launcher local-theme desktop sync", () => {
  test("reconcileLocalTheme adopts the authoritative config value", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: false })); // boots dark
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ theme: "light" }), { status: 200 })),
    );
    const { themeState, reconcileLocalTheme } = await import("./theme.svelte");
    expect(themeState.theme).toBe("dark");
    await reconcileLocalTheme();
    expect([themeState.choice, themeState.theme]).toEqual(["light", "light"]);
    expect(localStorage.getItem(STORED)).toBe("light");
  });

  test("reconcileLocalTheme keeps the current choice when the config is null", async () => {
    // A surface with no store answers null too, so null un-pins nothing.
    vi.stubGlobal("matchMedia", matchMediaStub({ light: true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ theme: null }), { status: 200 })),
    );
    localStorage.setItem(STORED, "dark");
    const { themeState, reconcileLocalTheme } = await import("./theme.svelte");
    await reconcileLocalTheme();
    expect([themeState.choice, themeState.theme]).toEqual(["dark", "dark"]);
    expect(localStorage.getItem(STORED)).toBe("dark");
  });

  test("watchLocalTheme applies a change written by another launcher webview", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: false }));
    class SocketStub {
      static instances: SocketStub[] = [];
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;

      constructor(readonly url: string) {
        SocketStub.instances.push(this);
      }

      close(): void {
        this.closed = true;
      }
    }
    vi.stubGlobal("WebSocket", SocketStub);
    const { themeState, watchLocalTheme } = await import("./theme.svelte");

    const stop = watchLocalTheme();
    const socket = SocketStub.instances[0];
    expect(socket.url).toContain("/api/library/local-theme/watch");
    socket.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ theme: "light" }) }),
    );

    expect(themeState.theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    stop();
    expect(socket.closed).toBe(true);
  });

  test("the desktop feed's null is the choice to follow the system, and a malformed frame is none", async () => {
    vi.stubGlobal("matchMedia", matchMediaStub({ light: true }));
    const { fetchMock } = putStub();
    vi.stubGlobal("fetch", fetchMock);
    class SocketStub {
      static instances: SocketStub[] = [];
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        SocketStub.instances.push(this);
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", SocketStub);
    localStorage.setItem(STORED, "dark");
    const { themeState, applyTheme, watchLocalTheme } = await import("./theme.svelte");
    applyTheme();
    const stop = watchLocalTheme();
    const push = (data: string): void =>
      SocketStub.instances[0].onmessage?.(new MessageEvent("message", { data }));

    for (const frame of ["{}", "null", "not json", JSON.stringify({ theme: "sepia" })]) {
      push(frame);
      expect([themeState.choice, shown()], frame).toEqual(["dark", "dark"]);
    }
    // Another launcher webview chose System: the desktop config holds null.
    push(JSON.stringify({ theme: null }));
    expect([themeState.choice, themeState.theme, shown()]).toEqual(["system", "light", "light"]);
    expect(localStorage.getItem(STORED)).toBeNull();
    expect(fetchMock, "a choice the feed reports is not written back").not.toHaveBeenCalled();
    stop();
  });
});
