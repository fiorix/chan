// The client-side window manager: mint (open-blank-then-navigate + 409 close),
// re-open, leader-side close/hide, and the feed reconciler that flags connected
// browser windows opened elsewhere while discarding stale disconnected browser
// rows. backend is mocked; window.open is spied so we can inspect the spawned
// handle and its navigation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WindowRecord, WindowSet } from "../api/library";

const { createWindow, discardWindow, setWindowVisibility } = vi.hoisted(() => ({
  createWindow: vi.fn(),
  discardWindow: vi.fn(),
  setWindowVisibility: vi.fn(),
}));
vi.mock("../api/backend", () => ({
  backend: { createWindow, discardWindow, setWindowVisibility },
}));

import {
  mintWindow,
  openWindowRecord,
  closeWindowRecord,
  reconcileWindows,
  hasWindowHandle,
  resetWindowManager,
} from "./windowManager.svelte";
import { hasWindowAttention, clearAllWindowAttention } from "./windowAttention.svelte";
import { setDemoReset } from "./demo.svelte";

interface FakeWin {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  location: { href: string };
  sessionStorage: Storage;
}

let opened: { win: FakeWin; url: string; name: string }[] = [];

function clonedSessionStorage(source: Storage): Storage {
  const values = new Map<string, string>();
  for (let index = 0; index < source.length; index += 1) {
    const key = source.key(index);
    if (key !== null) values.set(key, source.getItem(key) ?? "");
  }
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function fakeWin(): FakeWin {
  const w: FakeWin = {
    closed: false,
    close: vi.fn(() => {
      w.closed = true;
    }),
    focus: vi.fn(),
    location: { href: "" },
    sessionStorage: clonedSessionStorage(sessionStorage),
  };
  return w;
}

function record(over: Partial<WindowRecord>): WindowRecord {
  return {
    window_id: "w-1",
    library_id: "local",
    kind: "workspace",
    title: "Window 1",
    ordinal: 1,
    workspace_path: "/x/proj",
    prefix: "proj-1",
    token: "tok",
    persisted: true,
    connected: true,
    active_transfer: false,
    control: false,
    ...over,
  };
}

const set = (windows: WindowRecord[]): WindowSet => ({ windows });

beforeEach(() => {
  sessionStorage.clear();
  resetWindowManager();
  clearAllWindowAttention();
  setDemoReset(null);
  createWindow.mockReset();
  discardWindow.mockReset().mockResolvedValue(undefined);
  setWindowVisibility.mockReset().mockResolvedValue(undefined);
  opened = [];
  vi.spyOn(window, "open").mockImplementation((url, name) => {
    const win = fakeWin();
    opened.push({ win, url: String(url ?? ""), name: String(name ?? "") });
    return win as unknown as Window;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mintWindow", () => {
  it("removes cloned launcher drafts from a newly minted child window", async () => {
    sessionStorage.setItem("chan.command-launcher.v1:contextual", '{"visible":true,"query":"ter"}');
    sessionStorage.setItem("chan.command-launcher.v1:computers", '{"visible":true,"query":"ter"}');
    sessionStorage.setItem("chan.auth.token", "keep-me");
    createWindow.mockResolvedValue(record({ window_id: "w-new", prefix: "proj-1", token: "tok9" }));

    await mintWindow("terminal");

    const childStorage = opened[0].win.sessionStorage;
    expect(childStorage.getItem("chan.command-launcher.v1:contextual")).toBeNull();
    expect(childStorage.getItem("chan.command-launcher.v1:computers")).toBeNull();
    expect(childStorage.getItem("chan.auth.token")).toBe("keep-me");
    expect(sessionStorage.getItem("chan.command-launcher.v1:contextual")).not.toBeNull();
  });

  it("opens a blank window, mints with origin:browser + acting id, then navigates it", async () => {
    createWindow.mockResolvedValue(record({ window_id: "w-new", prefix: "proj-1", token: "tok9" }));
    const rec = await mintWindow("workspace", { workspacePath: "/x/proj", actingWindowId: "w-leader" });
    expect(rec?.window_id).toBe("w-new");
    expect(createWindow).toHaveBeenCalledWith("workspace", {
      workspacePath: "/x/proj",
      origin: "browser",
      actingWindowId: "w-leader",
    });
    // blank opened first (url "", target _blank), then navigated to the record URL
    expect(opened[0].url).toBe("");
    expect(opened[0].name).toBe("_blank");
    expect(opened[0].win.location.href).toContain("/proj-1/");
    expect(opened[0].win.location.href).toContain("w=w-new");
    expect(hasWindowHandle("w-new")).toBe(true);
  });

  it("closes the blank window and rethrows when the mint fails (e.g. 409 not running)", async () => {
    createWindow.mockRejectedValue(new Error("workspace is not running"));
    await expect(mintWindow("workspace", { workspacePath: "/x/proj" })).rejects.toThrow("not running");
    expect(opened[0].win.close).toHaveBeenCalled();
    expect(hasWindowHandle("w-1")).toBe(false);
  });

  it("is inert under demoState.enabled (no window opened, no mint)", async () => {
    setDemoReset(() => {});
    const rec = await mintWindow("terminal");
    expect(rec).toBeNull();
    expect(opened).toHaveLength(0);
    expect(createWindow).not.toHaveBeenCalled();
  });
});

describe("openWindowRecord", () => {
  it("opens the record URL named by window_id, stores the handle, clears attention", () => {
    const rec = record({ window_id: "w-2", prefix: "proj-2" });
    reconcileWindows(set([{ ...rec, origin: "browser" }])); // flags it orphan first
    expect(hasWindowAttention("w-2")).toBe(true);
    const h = openWindowRecord(rec);
    expect(h).not.toBeNull();
    expect(opened.at(-1)!.url).toContain("/proj-2/");
    expect(opened.at(-1)!.name).toBe("w-2");
    expect(hasWindowHandle("w-2")).toBe(true);
    expect(hasWindowAttention("w-2")).toBe(false);
  });
});

describe("closeWindowRecord", () => {
  it("discards via the web op and closes the local handle by default", async () => {
    const rec = record({ window_id: "w-3" });
    openWindowRecord(rec);
    const handle = opened.at(-1)!.win;
    await closeWindowRecord(rec, { actingWindowId: "w-leader" });
    expect(discardWindow).toHaveBeenCalledWith("w-3", "w-leader");
    expect(setWindowVisibility).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalled();
    expect(hasWindowHandle("w-3")).toBe(false);
  });

  it("hides via visibility when opts.hide is set", async () => {
    const rec = record({ window_id: "w-4" });
    openWindowRecord(rec);
    await closeWindowRecord(rec, { hide: true, actingWindowId: "w-leader" });
    expect(setWindowVisibility).toHaveBeenCalledWith("w-4", true, "w-leader");
    expect(discardWindow).not.toHaveBeenCalled();
    expect(hasWindowHandle("w-4")).toBe(false);
  });
});

describe("reconcileWindows", () => {
  it("flags a connected visible browser-origin record with no handle as an orphan", () => {
    reconcileWindows(set([record({ window_id: "w-a", origin: "browser" })]));
    expect(hasWindowAttention("w-a")).toBe(true);
  });

  it("does not flag native or hidden records", () => {
    reconcileWindows(
      set([
        record({ window_id: "w-native", origin: "native" }),
        record({ window_id: "w-absent" }), // origin absent => native
        record({ window_id: "w-hidden", origin: "browser", hidden: true }),
      ]),
    );
    expect(hasWindowAttention("w-native")).toBe(false);
    expect(hasWindowAttention("w-absent")).toBe(false);
    expect(hasWindowAttention("w-hidden")).toBe(false);
  });

  it("clears the orphan flag once the record has a live handle", () => {
    const rec = record({ window_id: "w-b", origin: "browser" });
    reconcileWindows(set([rec]));
    expect(hasWindowAttention("w-b")).toBe(true);
    openWindowRecord(rec);
    reconcileWindows(set([rec]));
    expect(hasWindowAttention("w-b")).toBe(false);
  });

  it("discards a browser-origin record whose local browser handle was closed", () => {
    const rec = record({ window_id: "w-local-closed", origin: "browser" });
    openWindowRecord(rec);
    const handle = opened.at(-1)!.win;
    handle.closed = true;

    reconcileWindows(set([rec]));

    expect(discardWindow).toHaveBeenCalledWith("w-local-closed");
    expect(hasWindowHandle("w-local-closed")).toBe(false);
    expect(hasWindowAttention("w-local-closed")).toBe(false);
  });

  it("schedules cleanup for a disconnected browser-origin record with no handle", async () => {
    vi.useFakeTimers();
    const rec = record({ window_id: "w-stale", origin: "browser", connected: false });

    reconcileWindows(set([rec]));

    expect(hasWindowAttention("w-stale")).toBe(false);
    expect(discardWindow).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(discardWindow).toHaveBeenCalledWith("w-stale");
    expect(hasWindowAttention("w-stale")).toBe(false);
  });

  it("cancels stale cleanup when a browser-origin record reconnects", async () => {
    vi.useFakeTimers();
    const rec = record({ window_id: "w-reconnect", origin: "browser", connected: false });
    reconcileWindows(set([rec]));
    reconcileWindows(set([{ ...rec, connected: true }]));

    await vi.runOnlyPendingTimersAsync();

    expect(discardWindow).not.toHaveBeenCalled();
    expect(hasWindowAttention("w-reconnect")).toBe(true);
  });

  it("closes the handle and clears attention when a record leaves the feed", () => {
    const rec = record({ window_id: "w-c", origin: "browser" });
    openWindowRecord(rec);
    const handle = opened.at(-1)!.win;
    reconcileWindows(set([rec])); // present
    reconcileWindows(set([])); // gone => discard
    expect(handle.close).toHaveBeenCalled();
    expect(hasWindowHandle("w-c")).toBe(false);
    expect(hasWindowAttention("w-c")).toBe(false);
  });

  it("is inert under demoState.enabled", () => {
    setDemoReset(() => {});
    reconcileWindows(set([record({ window_id: "w-d", origin: "browser" })]));
    expect(hasWindowAttention("w-d")).toBe(false);
  });
});
