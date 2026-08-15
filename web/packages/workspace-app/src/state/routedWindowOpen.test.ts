// @vitest-environment jsdom
//
// A `cs open` whose path left the workspace lands in a standalone window, and
// when the server had to CREATE that window the surface that asked is the one
// that has to open it: on chan-desktop the window watcher does it natively and
// this command never arrives, in a browser the page opens a tab, which is what
// a window is there.
//
// The wrinkle this pins is the popup grant. Every other window-opening path in
// the app runs inside a click or a chord, so `window.open` inherits the
// gesture; this one arrives over a socket with no gesture behind it, and the
// browser blocks it. The fallback asks, and the answer supplies the gesture.

import { beforeEach, describe, expect, test, vi } from "vitest";

const uiConfirm = vi.fn<() => Promise<boolean>>();
const isTauriDesktop = vi.fn<() => boolean>();

vi.mock("./confirm.svelte", () => ({ uiConfirm: () => uiConfirm() }));
vi.mock("../api/desktop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/desktop")>();
  return { ...actual, isTauriDesktop: () => isTauriDesktop() };
});

let store: typeof import("./store.svelte");
let opened: { url: string; name: string }[] = [];
let openResult: Window | null = null;

const FRAME = {
  type: "window_command",
  window_id: "w-caller",
  command: "open_window",
  window: "w-minted",
  prefix: "/api/terminal",
  token: "tok",
  path: "etc/hosts",
} as const;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  opened = [];
  openResult = {} as Window;
  window.history.replaceState({}, "", "/?w=w-caller&lib=local");
  vi.stubGlobal("open", (url: string, name: string) => {
    opened.push({ url, name });
    return openResult;
  });
  isTauriDesktop.mockReturnValue(false);
  uiConfirm.mockResolvedValue(false);
  store = await import("./store.svelte");
});

describe("a routed open that had to create a window", () => {
  test("opens a tab onto the minted window, against this page's own origin", async () => {
    await store.onWatchEvent(FRAME as unknown as Parameters<typeof store.onWatchEvent>[0]);

    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!.url);
    // Composed here, not by the server: behind a gateway the server does not
    // know the origin the user reached it on.
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe("/api/terminal/");
    expect(url.searchParams.get("w")).toBe("w-minted");
    expect(url.searchParams.get("t")).toBe("tok");
    expect(url.searchParams.get("kind")).toBe("terminal");
    expect(url.searchParams.get("lib")).toBe("local");
    // Named for the window, so a second routed open reuses the tab.
    expect(opened[0]!.name).toBe("w-minted");
    expect(uiConfirm).not.toHaveBeenCalled();
  });

  test("a blocked tab asks, and the answer is the gesture the browser wanted", async () => {
    openResult = null;
    uiConfirm.mockResolvedValue(true);

    await store.onWatchEvent(FRAME as unknown as Parameters<typeof store.onWatchEvent>[0]);

    // One blocked attempt, one prompt, one retry from inside the click. The
    // retry lands a microtask after the prompt resolves, which the dispatch
    // does not await.
    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(uiConfirm).toHaveBeenCalledTimes(1);
  });

  test("a declined prompt opens nothing and says nothing more", async () => {
    openResult = null;
    uiConfirm.mockResolvedValue(false);

    await store.onWatchEvent(FRAME as unknown as Parameters<typeof store.onWatchEvent>[0]);

    await vi.waitFor(() => expect(uiConfirm).toHaveBeenCalledTimes(1));
    expect(opened).toHaveLength(1);
    expect(store.ui.statusKind).not.toBe("persistent");
  });

  test("chan-desktop ignores it: its watcher opens the window natively", async () => {
    isTauriDesktop.mockReturnValue(true);

    await store.onWatchEvent(FRAME as unknown as Parameters<typeof store.onWatchEvent>[0]);

    expect(opened).toEqual([]);
    expect(uiConfirm).not.toHaveBeenCalled();
  });
});
