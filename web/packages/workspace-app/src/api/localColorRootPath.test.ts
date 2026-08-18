// @vitest-environment jsdom

// The per-library pane colour (`/api/library/local-color` PUT + `/watch`) is
// mounted ONLY on the ROOT launcher router, but a workspace/terminal/devserver
// window's SPA loads UNDER its tenant prefix (`serve.rs` mints
// `{prefix}/index.html`). `apiPath` / `withTokenQuery` would prepend that
// prefix and send the colour PUT + watch to
// `/{prefix}/api/library/local-color` → 404 → swallowed → never persisted →
// fresh window blue. Both go through the ROOT resolvers (`requestRoot` /
// `rootTokenQuery`) instead, while still carrying the window's `?t=` bearer.
// transport.ts reads `chan-prefix` ONCE at module load, so each test
// sets the meta + location and imports a FRESH module copy.

import { afterEach, describe, expect, test, vi } from "vitest";

const PREFIX = "/workspace-notes-1a2b3c4d";

function bootUnderPrefix(): void {
  document.head.querySelector('meta[name="chan-prefix"]')?.remove();
  const m = document.createElement("meta");
  m.setAttribute("name", "chan-prefix");
  m.setAttribute("content", PREFIX);
  document.head.appendChild(m);
  window.history.replaceState(null, "", `${PREFIX}/index.html?t=tok`);
  window.sessionStorage.clear();
  vi.resetModules();
}

afterEach(() => {
  document.head.querySelector('meta[name="chan-prefix"]')?.remove();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("local-color resolves to the ROOT path under a tenant prefix (C8)", () => {
  test("rootPath/rootTokenQuery ignore the prefix; apiPath still honours it", async () => {
    bootUnderPrefix();
    const t = await import("./transport");
    // Sanity: the prefix IS active -- ordinary tenant paths get it prepended.
    expect(t.apiPath("/api/fs/x")).toBe(`${PREFIX}/api/fs/x`);
    // The fix: surface-level local-color resolves at ROOT, never prefixed.
    expect(t.rootPath("/api/library/local-color")).toBe("/api/library/local-color");
    const wsPath = t.rootTokenQuery("/api/library/local-color/watch");
    expect(wsPath).not.toContain(PREFIX);
    expect(wsPath.startsWith("/api/library/local-color/watch?t=tok")).toBe(true);
  });

  test("api.setLocalColor PUTs the ROOT path + the tenant bearer (not prefixed)", async () => {
    bootUnderPrefix();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 204,
        statusText: "No Content",
        text: () => Promise.resolve(""),
      } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./client");
    await api.setLocalColor("#f97316");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/library/local-color");
    expect(url).not.toContain(PREFIX);
    expect(init?.method).toBe("PUT");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
  });

  test("openLocalColorWatch opens the ROOT WS path + bearer (not prefixed)", async () => {
    bootUnderPrefix();
    const urls: string[] = [];
    class FakeWS {
      static OPEN = 1;
      onopen: (() => void) | null = null;
      onmessage: ((m: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        urls.push(url);
      }
      close(): void {}
    }
    vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
    const t = await import("./transport");
    const dispose = t.openLocalColorWatch(() => {});
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain(PREFIX);
    expect(urls[0]).toContain("/api/library/local-color/watch?t=tok");
    dispose();
  });
});
