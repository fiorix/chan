// @vitest-environment jsdom

// The launcher-theme watch (`/api/library/local-theme/watch`) is mounted ONLY
// on the ROOT launcher router, but a standalone terminal window's SPA loads
// UNDER its tenant prefix. Like the local-colour watch, it must resolve at
// ROOT (through `rootTokenQuery`) while still carrying the window's `?t=`
// bearer, or it 404s under the prefix and the terminal never follows the
// launcher theme. transport.ts reads `chan-prefix` ONCE at module load, so the
// test sets the meta + location and imports a FRESH module copy.

import { afterEach, describe, expect, test, vi } from "vitest";

const PREFIX = "/terminal-notes-1a2b3c4d";

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

describe("local-theme resolves to the ROOT path under a tenant prefix", () => {
  test("rootTokenQuery ignores the prefix but keeps the bearer", async () => {
    bootUnderPrefix();
    const t = await import("./transport");
    // Sanity: the prefix IS active for ordinary tenant paths.
    expect(t.apiPath("/api/fs/x")).toBe(`${PREFIX}/api/fs/x`);
    const wsPath = t.rootTokenQuery("/api/library/local-theme/watch");
    expect(wsPath).not.toContain(PREFIX);
    expect(wsPath.startsWith("/api/library/local-theme/watch?t=tok")).toBe(true);
  });

  test("openLocalThemeWatch opens the ROOT WS path + bearer (not prefixed)", async () => {
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
    const dispose = t.openLocalThemeWatch(() => {});
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain(PREFIX);
    expect(urls[0]).toContain("/api/library/local-theme/watch?t=tok");
    dispose();
  });
});
