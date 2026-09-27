// The client-side window manager: mint (open-blank-then-navigate + 409 close),
// re-open, leader-side close/hide, and the feed reconciler that flags connected
// browser windows opened elsewhere while discarding stale disconnected browser
// rows. backend is mocked; window.open is spied so we can inspect the spawned
// handle and its navigation.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WindowRecord, WindowSet } from "../api/library";

const { createWindow, discardWindow, setWindowVisibility, checkWindowPage } = vi.hoisted(() => ({
  createWindow: vi.fn(),
  checkWindowPage: vi.fn(),
  discardWindow: vi.fn(),
  setWindowVisibility: vi.fn(),
}));
vi.mock("../api/backend", () => ({
  backend: { createWindow, discardWindow, setWindowVisibility, checkWindowPage },
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
  name: string;
  close: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  location: { href: string };
  sessionStorage: Storage;
  document: Document;
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
  let href = "about:blank";
  const w: FakeWin = {
    closed: false,
    name: "",
    close: vi.fn(() => {
      w.closed = true;
    }),
    focus: vi.fn(),
    location: { get href() { return href; }, set href(value: string) { href = value; } },
    sessionStorage: clonedSessionStorage(sessionStorage),
    document: document.implementation.createHTMLDocument(),
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

function gateResponse(retryAfter: string | null = "1"): Response {
  return new Response(JSON.stringify({ error: "devserver is restoring terminal sessions" }), {
    status: 503,
    headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
  });
}

beforeEach(() => {
  sessionStorage.clear();
  resetWindowManager();
  clearAllWindowAttention();
  setDemoReset(null);
  createWindow.mockReset();
  checkWindowPage.mockReset().mockImplementation(async () => new Response("<html></html>"));
  discardWindow.mockReset().mockResolvedValue(undefined);
  setWindowVisibility.mockReset().mockResolvedValue(undefined);
  opened = [];
  vi.spyOn(window, "open").mockImplementation((url, name) => {
    const win = opened.find((entry) => entry.win.name === name && name !== "_blank" && !entry.win.closed)?.win ?? fakeWin();
    if (name !== "_blank") win.name = String(name ?? "");
    if (url) win.location.href = String(url);
    opened.push({ win, url: String(url ?? ""), name: String(name ?? "") });
    return win as unknown as Window;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("opens in the gesture before minting or checking the page", async () => {
    const calls: string[] = [];
    vi.spyOn(window, "open").mockImplementation(() => {
      calls.push("open");
      return fakeWin() as unknown as Window;
    });
    createWindow.mockImplementation(async () => {
      calls.push("mint");
      return record({});
    });
    checkWindowPage.mockImplementation(async () => {
      calls.push("check");
      return new Response("<html></html>");
    });
    const pending = mintWindow("terminal");
    expect(calls).toEqual(["open", "mint"]);
    await pending;
    expect(calls).toEqual(["open", "mint", "check"]);
  });

  it.each([
    ["seconds", "2", 2000],
    ["date", "Sun, 27 Sep 2026 12:00:03 GMT", 3000],
    ["absent", null, 1000],
  ])("waits for the page and honours the %s Retry-After", async (_kind, retryAfter, delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    createWindow.mockResolvedValue(record({}));
    checkWindowPage.mockImplementationOnce(async () => gateResponse(retryAfter));
    const pending = mintWindow("workspace");
    await vi.advanceTimersByTimeAsync(0);
    const child = opened[0].win;
    expect(child.location.href).toBe("about:blank");
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    expect(child.location.href).toBe("about:blank");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(checkWindowPage).toHaveBeenCalledTimes(2);
    expect(child.location.href).toContain("/proj-1/?w=w-1");
    expect(checkWindowPage.mock.calls[0][0]).toBe(child.location.href);
    expect(child.closed).toBe(false);
  });

  it.each([404, 409, 500])("closes and discards on a page's %s refusal with its sentence", async (status) => {
    createWindow.mockResolvedValue(record({}));
    checkWindowPage.mockResolvedValue(new Response(JSON.stringify({ error: "Page is unavailable." }), { status }));
    const outcome = await mintWindow("workspace").then(() => null, (error: unknown) => error);
    expect(outcome).toMatchObject({ status, message: "Page is unavailable." });
    expect(opened[0].win.location.href).toBe("about:blank");
    expect(opened[0].win.closed).toBe(true);
    expect(discardWindow).toHaveBeenCalledWith("w-1");
    expect(hasWindowHandle("w-1")).toBe(false);
  });

  it("ends the wait when the user closes the blank window", async () => {
    vi.useFakeTimers();
    createWindow.mockResolvedValue(record({}));
    checkWindowPage.mockImplementation(async () => gateResponse("30"));
    let settled = false;
    const pending = mintWindow("terminal").then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    opened[0].win.closed = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect(await pending).toBeNull();
    expect(opened[0].win.location.href).toBe("about:blank");
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    expect(discardWindow).toHaveBeenCalledWith("w-1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends at sixty seconds with the last refusal sentence", async () => {
    vi.useFakeTimers();
    createWindow.mockResolvedValue(record({}));
    checkWindowPage.mockImplementation(async () => gateResponse("120"));
    let settled = false;
    const pending = mintWindow("workspace").then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    await vi.advanceTimersByTimeAsync(59999);
    expect(settled).toBe(false);
    expect(opened[0].win.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ status: 503, message: "devserver is restoring terminal sessions" });
    expect(opened[0].win.closed).toBe(true);
    expect(opened[0].win.location.href).toBe("about:blank");
    expect(discardWindow).toHaveBeenCalledWith("w-1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the waiting handle through disconnected feed reconciliation", async () => {
    vi.useFakeTimers();
    const rec = record({ connected: false, origin: "browser" });
    createWindow.mockResolvedValue(rec);
    checkWindowPage.mockImplementation(async () => gateResponse("1"));
    const pending = mintWindow("workspace");
    await vi.advanceTimersByTimeAsync(0);
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    expect(hasWindowHandle("w-1")).toBe(true);
    reconcileWindows(set([rec]));
    await vi.advanceTimersByTimeAsync(3000);
    reconcileWindows(set([rec]));
    expect(discardWindow).not.toHaveBeenCalled();
    expect(hasWindowHandle("w-1")).toBe(true);
    expect(hasWindowAttention("w-1")).toBe(false);
    checkWindowPage.mockImplementation(async () => new Response("<html></html>"));
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
  });

  it("keeps the waiting window when its disconnected feed record arrives before the mint", async () => {
    vi.useFakeTimers();
    const rec = record({ connected: false, origin: "browser" });
    let answerMint!: (rec: WindowRecord) => void;
    createWindow.mockReturnValue(new Promise<WindowRecord>((resolve) => { answerMint = resolve; }));
    checkWindowPage.mockImplementationOnce(async () => gateResponse("4"));
    const pending = mintWindow("workspace");
    reconcileWindows(set([rec]));
    expect(hasWindowHandle(rec.window_id)).toBe(false);
    answerMint(rec);
    await vi.advanceTimersByTimeAsync(3000);
    expect(opened[0].win.closed).toBe(false);
    expect(discardWindow).not.toHaveBeenCalled();
    expect(opened[0].win.location.href).toBe("about:blank");
    expect(hasWindowHandle(rec.window_id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(rec);
    expect(opened[0].win.location.href).toContain("/proj-1/?w=w-1");
  });

  it("bounds a Retry-After beyond the timer range without checking early", async () => {
    vi.useFakeTimers();
    createWindow.mockResolvedValue(record({}));
    checkWindowPage.mockImplementation(async () => gateResponse("9999999999"));
    const pending = mintWindow("terminal").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59900);
    expect(await pending).toMatchObject({ status: 503 });
  });

  it("aborts a stalled page check when the window closes", async () => {
    vi.useFakeTimers();
    createWindow.mockResolvedValue(record({}));
    checkWindowPage.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const pending = mintWindow("terminal").then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    const signal = checkWindowPage.mock.calls[0][1] as AbortSignal;
    opened[0].win.closed = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect(await pending).toBeNull();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled retry and keeps the last server refusal", async () => {
    vi.useFakeTimers();
    createWindow.mockResolvedValue(record({}));
    checkWindowPage.mockImplementationOnce(async () => gateResponse());
    checkWindowPage.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const pending = mintWindow("terminal").catch((error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(60000);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ message: "devserver is restoring terminal sessions" });
    expect((checkWindowPage.mock.calls[1][1] as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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
  it("opens blank by name in the gesture, checks, then navigates", async () => {
    const rec = record({ window_id: "w-2", prefix: "proj-2" });
    reconcileWindows(set([{ ...rec, origin: "browser" }]));
    const pending = openWindowRecord(rec);
    expect(opened).toHaveLength(1);
    expect(opened[0].url).toBe("");
    expect(opened[0].name).toBe("w-2");
    expect(window.open).toHaveBeenCalledBefore(checkWindowPage);
    const h = await pending;
    expect(h).toBe(opened[0].win);
    expect(opened[0].win.location.href).toContain("/proj-2/");
    expect(hasWindowHandle("w-2")).toBe(true);
    expect(hasWindowAttention("w-2")).toBe(false);
  });

  it("focuses an existing page without navigating or checking it", async () => {
    const live = fakeWin();
    live.location.href = "http://localhost:3000/proj-1/?w=w-1#editor";
    vi.spyOn(window, "open").mockImplementation((url) => {
      if (url) live.location.href = String(url);
      return live as unknown as Window;
    });
    const h = await openWindowRecord(record({}));
    expect(h).toBe(live);
    expect(live.focus).toHaveBeenCalledOnce();
    expect(live.location.href).toBe("http://localhost:3000/proj-1/?w=w-1#editor");
    expect(checkWindowPage).not.toHaveBeenCalled();
  });

  it.each(["location", "document"] as const)("focuses a foreign window whose %s is unreadable", async (property) => {
    const child = fakeWin();
    child.location.href = "https://elsewhere.example/";
    Object.defineProperty(child, property, {
      get() { throw new DOMException("Blocked cross-origin access", "SecurityError"); },
    });
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const outcome = await openWindowRecord(record({})).catch((error: unknown) => error);
    expect(outcome).toBe(child);
    expect(child.focus).toHaveBeenCalledOnce();
    expect(child.close).not.toHaveBeenCalled();
    expect(checkWindowPage).not.toHaveBeenCalled();
  });

  it("reuses a minted window by its record name", async () => {
    createWindow.mockResolvedValue(record({}));
    await mintWindow("workspace");
    const child = opened[0].win;
    checkWindowPage.mockClear();
    await openWindowRecord(record({}));
    expect(opened[1].win).toBe(child);
    expect(checkWindowPage).not.toHaveBeenCalled();
  });

  it("keeps a re-opened window blank until the gate opens", async () => {
    vi.useFakeTimers();
    checkWindowPage.mockImplementationOnce(async () => gateResponse());
    const pending = openWindowRecord(record({}));
    await vi.advanceTimersByTimeAsync(999);
    expect(opened[0].win.location.href).toBe("about:blank");
    expect(hasWindowHandle("w-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(opened[0].win.location.href).toContain("/proj-1/");
    expect(checkWindowPage).toHaveBeenCalledTimes(2);
  });

  it.each(["about:blank", ""])("waits and navigates a window whose location reads %j", async (href) => {
    vi.useFakeTimers();
    const child = fakeWin();
    child.location.href = href;
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    checkWindowPage.mockImplementationOnce(async () => gateResponse());
    const pending = openWindowRecord(record({}));
    await vi.advanceTimersByTimeAsync(999);
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    expect(child.location.href).toBe(href);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(child.location.href).toContain("/proj-1/?w=w-1");
    expect(checkWindowPage).toHaveBeenCalledTimes(2);
  });

  it("shares a waiting named window check and navigates only once", async () => {
    vi.useFakeTimers();
    checkWindowPage.mockImplementationOnce(async () => gateResponse());
    const first = openWindowRecord(record({}));
    const child = opened[0].win;
    const navigation = vi.spyOn(child.location, "href", "set");
    const second = openWindowRecord(record({}));
    await vi.advanceTimersByTimeAsync(0);
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);
    expect(navigation).toHaveBeenCalledTimes(1);
  });

  it.each(["mint", "re-open"] as const)("keeps a replacement handle when a %s wait ends", async (action) => {
    vi.useFakeTimers();
    const rec = record({});
    createWindow.mockResolvedValue(rec);
    checkWindowPage.mockImplementationOnce(async () => gateResponse("30"));
    const first = action === "mint" ? mintWindow("workspace") : openWindowRecord(rec);
    await vi.advanceTimersByTimeAsync(0);
    opened[0].win.closed = true;
    const replacement = await openWindowRecord(rec);
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(hasWindowHandle("w-1")).toBe(true);
    expect(replacement?.closed).toBe(false);
    expect(discardWindow).not.toHaveBeenCalled();
  });

  it("closes a refused re-open and raises the server sentence", async () => {
    checkWindowPage.mockResolvedValue(new Response('{"error":"This page cannot open."}', { status: 409 }));
    const outcome = await Promise.resolve(openWindowRecord(record({}))).then(() => null, (error: unknown) => error);
    expect(outcome).toMatchObject({ status: 409, message: "This page cannot open." });
    expect(opened[0].win.closed).toBe(true);
    expect(opened[0].win.location.href).toBe("about:blank");
    expect(hasWindowHandle("w-1")).toBe(false);
  });

  it("ends a re-open wait at sixty seconds with the server sentence", async () => {
    vi.useFakeTimers();
    checkWindowPage.mockImplementation(async () => gateResponse("120"));
    let settled = false;
    const pending = Promise.resolve(openWindowRecord(record({}))).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ status: 503, message: "devserver is restoring terminal sessions" });
    expect(opened[0].win.closed).toBe(true);
    expect(opened[0].win.location.href).toBe("about:blank");
  });
});

describe("closeWindowRecord", () => {
  it("discards via the web op and closes the local handle by default", async () => {
    const rec = record({ window_id: "w-3" });
    await openWindowRecord(rec);
    const handle = opened.at(-1)!.win;
    await closeWindowRecord(rec, { actingWindowId: "w-leader" });
    expect(discardWindow).toHaveBeenCalledWith("w-3", "w-leader");
    expect(setWindowVisibility).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalled();
    expect(hasWindowHandle("w-3")).toBe(false);
  });

  it("hides via visibility when opts.hide is set", async () => {
    const rec = record({ window_id: "w-4" });
    await openWindowRecord(rec);
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

  it("clears the orphan flag once the record has a live handle", async () => {
    const rec = record({ window_id: "w-b", origin: "browser" });
    reconcileWindows(set([rec]));
    expect(hasWindowAttention("w-b")).toBe(true);
    await openWindowRecord(rec);
    reconcileWindows(set([rec]));
    expect(hasWindowAttention("w-b")).toBe(false);
  });

  it("discards a browser-origin record whose local browser handle was closed", async () => {
    const rec = record({ window_id: "w-local-closed", origin: "browser" });
    await openWindowRecord(rec);
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

  it("closes the handle and clears attention when a record leaves the feed", async () => {
    const rec = record({ window_id: "w-c", origin: "browser" });
    await openWindowRecord(rec);
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
