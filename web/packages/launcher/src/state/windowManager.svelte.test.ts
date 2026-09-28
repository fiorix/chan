// The client-side window manager: mint (open-blank-then-navigate + 409 close),
// re-open, leader-side close/hide, and the feed reconciler that retains and
// flags visible browser records without a local handle. backend is mocked;
// window.open is spied so we can inspect the spawned
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

const MOVED = "The new window was not opened because its tab was taken to another page.";
const MOVED_KEPT =
  "The new window was not opened because its tab was taken to another page, and its record could not be removed; close it from the list of windows.";

type MoveTarget = "another site" | "a page of this origin";

/** Take a new tab to another page, as its user can while its mint is pending.
 * Another site refuses every read and the name; a page of this origin is a
 * document of its own. Returns the page a same-origin tab holds. */
function moveTab(win: FakeWin, to: MoveTarget): Document {
  const page = document.implementation.createHTMLDocument();
  page.body.textContent = "User page";
  if (to === "another site") {
    const denied = () => { throw new DOMException("Blocked cross-origin access", "SecurityError"); };
    Object.defineProperty(win, "location", { get: denied });
    Object.defineProperty(win, "document", { get: denied });
    Object.defineProperty(win, "name", { get: denied, set: denied });
  } else {
    win.location.href = "http://localhost:3000/elsewhere";
    win.document = page;
  }
  return page;
}

/** A mint whose answer the test gives, so the tab can change before it. */
function pendingCreate(): { answer: (rec: WindowRecord) => void; refuse: (error: Error) => void } {
  const settle = { answer: (_rec: WindowRecord) => {}, refuse: (_error: Error) => {} };
  createWindow.mockImplementation(() => new Promise<WindowRecord>((resolve, reject) => {
    settle.answer = resolve;
    settle.refuse = reject;
  }));
  return settle;
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

  it.each([
    ["zero", "0"],
    ["negative zero", "-0"],
    ["fractional", "0.001"],
    ["past date", "Sun, 27 Sep 2026 11:00:00 GMT"],
    ["near date", "Sun, 27 Sep 2026 12:00:01 GMT"],
    ["invalid", "not a date"],
  ])("waits a full second after the answer with a %s Retry-After", async (_kind, header) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00Z"));
    createWindow.mockResolvedValue(record({}));
    checkWindowPage.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return gateResponse(header);
    });
    const pending = mintWindow("workspace");
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(999);
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    expect(opened[0].win.location.href).toBe("about:blank");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(checkWindowPage).toHaveBeenCalledTimes(2);
    expect(opened[0].win.location.href).toContain("/proj-1/?w=w-1");
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

  it("leaves a tab its user took to another site before the mint answered", async () => {
    const create = pendingCreate();
    const outcome = mintWindow("terminal").then(() => null, (error: unknown) => error);
    const child = opened[0].win;
    moveTab(child, "another site");
    create.answer(record({ window_id: "w-new" }));
    expect(await outcome).toMatchObject({ message: MOVED });
    expect(discardWindow).toHaveBeenCalledExactlyOnceWith("w-new");
    expect(child.close).not.toHaveBeenCalled();
    expect(checkWindowPage).not.toHaveBeenCalled();
    expect(hasWindowHandle("w-new")).toBe(false);
  });

  it("leaves a tab its user took to a page of this origin before the mint answered", async () => {
    const create = pendingCreate();
    const outcome = mintWindow("terminal").then(() => null, (error: unknown) => error);
    const child = opened[0].win;
    const page = moveTab(child, "a page of this origin");
    create.answer(record({ window_id: "w-new" }));
    expect(await outcome).toMatchObject({ message: MOVED });
    expect(child.name).toBe("");
    expect(child.location.href).toBe("http://localhost:3000/elsewhere");
    expect(page.documentElement.hasAttribute("data-chan-window-page-owner")).toBe(false);
    expect(page.body.textContent).toBe("User page");
    expect(checkWindowPage).not.toHaveBeenCalled();
    expect(child.close).not.toHaveBeenCalled();
    expect(discardWindow).toHaveBeenCalledExactlyOnceWith("w-new");
    expect(hasWindowHandle("w-new")).toBe(false);
  });

  it.each(["another site", "a page of this origin"] as const)("leaves a tab its user took to %s when the mint is refused", async (to) => {
    const create = pendingCreate();
    const outcome = mintWindow("terminal").then(() => null, (error: unknown) => error);
    const child = opened[0].win;
    moveTab(child, to);
    const refusal = new Error("workspace is not running");
    create.refuse(refusal);
    expect(await outcome).toBe(refusal);
    expect(child.close).not.toHaveBeenCalled();
    expect(discardWindow).not.toHaveBeenCalled();
  });

  it("says a moved tab's record stays when its discard is refused", async () => {
    discardWindow.mockRejectedValue(new Error("not the session leader for this window"));
    const create = pendingCreate();
    const outcome = mintWindow("terminal").then(() => null, (error: unknown) => error);
    const child = opened[0].win;
    moveTab(child, "another site");
    create.answer(record({ window_id: "w-new" }));
    expect(await outcome).toMatchObject({ message: MOVED_KEPT });
    expect(discardWindow).toHaveBeenCalledExactlyOnceWith("w-new");
    expect(child.close).not.toHaveBeenCalled();
  });

  it("discards the record of a tab its user closed before the mint answered", async () => {
    const create = pendingCreate();
    const outcome = mintWindow("terminal").then((value) => value, (error: unknown) => error);
    const child = opened[0].win;
    // Closed first: a closed tab whose location an engine will not read is
    // not a moved one.
    child.closed = true;
    Object.defineProperty(child, "location", {
      get() { throw new DOMException("The window is closed", "SecurityError"); },
    });
    create.answer(record({ window_id: "w-new" }));
    expect(await outcome).toBeNull();
    expect(discardWindow).toHaveBeenCalledExactlyOnceWith("w-new");
    expect(checkWindowPage).not.toHaveBeenCalled();
    expect(hasWindowHandle("w-new")).toBe(false);
  });

  it("leaves a tab its user took to another page during the wait when its page is refused", async () => {
    vi.useFakeTimers();
    createWindow.mockResolvedValue(record({ window_id: "w-new" }));
    checkWindowPage.mockImplementationOnce(async () => gateResponse("30"));
    checkWindowPage.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "Page is unavailable." }), { status: 409 }));
    const outcome = mintWindow("terminal").then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const child = opened[0].win;
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    moveTab(child, "a page of this origin");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ status: 409, message: "Page is unavailable." });
    expect(child.close).not.toHaveBeenCalled();
    expect(child.location.href).toBe("http://localhost:3000/elsewhere");
    expect(discardWindow).toHaveBeenCalledExactlyOnceWith("w-new");
    expect(hasWindowHandle("w-new")).toBe(false);
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

  it.each(["location", "document"] as const)("focuses a connected foreign window whose %s is unreadable", async (property) => {
    const child = fakeWin();
    child.location.href = "https://elsewhere.example/";
    Object.defineProperty(child, property, {
      get() { throw new DOMException("Blocked cross-origin access", "SecurityError"); },
    });
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const outcome = await openWindowRecord(record({ connected: true })).catch((error: unknown) => error);
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

  it.each(["mint", "re-open", "JSON page"])("keeps one navigation while a %s load commits", async (action) => {
    vi.useFakeTimers();
    const child = fakeWin();
    let href = action === "JSON page" ? "http://localhost:3000/proj-1/?w=w-1" : "about:blank";
    if (action === "JSON page") Object.defineProperty(child.document, "contentType", { value: "application/json" });
    const navigate = vi.fn();
    Object.defineProperty(child.location, "href", { get: () => href, set: navigate });
    const open = vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const rec = record({ connected: false });
    createWindow.mockResolvedValue(rec);
    await (action === "mint" ? mintWindow("workspace") : openWindowRecord(rec));
    child.document.body.textContent = "Navigation committing";
    await openWindowRecord(rec);
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(child.document.body.textContent).toBe("Navigation committing");

    // A later refusal is a different document on the same window object.
    href = "http://localhost:3000/proj-1/?w=w-1";
    child.document = document.implementation.createHTMLDocument();
    Object.defineProperty(child.document, "contentType", { value: "application/json" });
    await openWindowRecord(rec);
    expect(checkWindowPage).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(2);

    child.closed = true;
    const replacement = fakeWin();
    open.mockReturnValue(replacement as unknown as Window);
    expect(await openWindowRecord(rec)).toBe(replacement);
    expect(checkWindowPage).toHaveBeenCalledTimes(3);
    expect(replacement.location.href).toContain("/proj-1/?w=w-1");
  });

  it("returns a window another page waits on only once that wait navigates", async () => {
    vi.useFakeTimers();
    const child = fakeWin();
    child.document.documentElement.setAttribute("data-chan-window-page-owner", `waiting:${Date.now() + 30_000}`);
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    let answered: unknown = "pending";
    void openWindowRecord(record({ connected: false })).then((h) => { answered = h; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(answered).toBe("pending");
    expect(checkWindowPage).not.toHaveBeenCalled();
    child.document.documentElement.setAttribute("data-chan-window-page-owner", `navigating:${Date.now() + 10_000}`);
    await vi.advanceTimersByTimeAsync(100);
    expect(answered).toBe(child);
    expect(checkWindowPage).not.toHaveBeenCalled();
  });

  it.each(["blank", "stayed page"] as const)("repairs a %s whose navigation did not commit once ten seconds pass", async (state) => {
    vi.useFakeTimers();
    const child = fakeWin();
    const href = state === "blank" ? "about:blank" : "http://localhost:3000/proj-1/?w=w-1";
    const navigate = vi.fn();
    Object.defineProperty(child.location, "href", { get: () => href, set: navigate });
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const rec = record({ connected: false });

    await openWindowRecord(rec);
    await openWindowRecord(rec);
    expect(checkWindowPage).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await openWindowRecord(rec);

    expect(checkWindowPage).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledTimes(2);
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

  it.each(["an expired", "an older build's"] as const)("leaves open a blank with %s mark when its repairs are refused", async (kind) => {
    vi.useFakeTimers();
    const child = fakeWin();
    child.document.documentElement.setAttribute("data-chan-window-page-owner",
      kind === "an expired" ? `navigating:${Date.now() - 1}` : "navigating");
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    checkWindowPage.mockImplementation(async () => new Response('{"error":"Repair refused."}', { status: 409 }));
    const rec = record({ window_id: "w-left", origin: "browser", connected: false });

    for (const attempt of [1, 2]) {
      const report = vi.fn();
      await openWindowRecord(rec).catch(report);
      expect(child.close, `attempt ${attempt}`).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "Repair refused." }));
      expect(hasWindowHandle("w-left")).toBe(false);
      expect(child.document.documentElement.hasAttribute("data-chan-window-page-owner")).toBe(true);
    }
    expect(checkWindowPage).toHaveBeenCalledTimes(2);
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

  it("keeps a disconnected browser row without a handle available to open", async () => {
    vi.useFakeTimers();
    const rec = record({ window_id: "w-stale", origin: "browser", connected: false });

    reconcileWindows(set([rec]));

    await vi.advanceTimersByTimeAsync(3000);

    expect(discardWindow).not.toHaveBeenCalled();
    expect(hasWindowAttention("w-stale")).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
    await openWindowRecord(rec);
    expect(opened[0].win.location.href).toContain("?w=w-stale");
    expect(hasWindowHandle("w-stale")).toBe(true);
    expect(hasWindowAttention("w-stale")).toBe(false);
  });

  it("keeps a browser-origin record available when it reconnects", async () => {
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

  it("discards nothing for a window that closes while its Open is pending", async () => {
    vi.useFakeTimers();
    const rec = record({ window_id: "w-pending", origin: "browser", connected: false });
    reconcileWindows(set([rec]));
    checkWindowPage.mockImplementationOnce(async () => gateResponse("30"));
    const pending = openWindowRecord(rec);
    await vi.advanceTimersByTimeAsync(0);
    opened[0].win.closed = true;

    reconcileWindows(set([rec]));
    expect(discardWindow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
    reconcileWindows(set([rec]));

    expect(discardWindow).not.toHaveBeenCalled();
    expect(hasWindowAttention("w-pending")).toBe(true);
  });

  it("discards nothing when another page's refusal closes a window an Open follows", async () => {
    vi.useFakeTimers();
    const rec = record({ window_id: "w-peer", origin: "browser", connected: false });
    reconcileWindows(set([rec]));
    const child = fakeWin();
    child.document.documentElement.setAttribute("data-chan-window-page-owner", `waiting:${Date.now() + 30_000}`);
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const pending = openWindowRecord(rec);
    await vi.advanceTimersByTimeAsync(1_000);
    child.document.documentElement.removeAttribute("data-chan-window-page-owner");
    child.closed = true;

    reconcileWindows(set([rec]));
    expect(discardWindow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
    expect(checkWindowPage).not.toHaveBeenCalled();
    reconcileWindows(set([rec]));

    expect(discardWindow).not.toHaveBeenCalled();
    expect(hasWindowAttention("w-peer")).toBe(true);
  });


  it("is inert under demoState.enabled", () => {
    setDemoReset(() => {});
    reconcileWindows(set([record({ window_id: "w-d", origin: "browser" })]));
    expect(hasWindowAttention("w-d")).toBe(false);
  });
});

const repairDocuments = [
  { label: "tenant HTML", mime: "text/html" },
  { label: "initial blank", mime: "text/html", href: "about:blank" },
  { label: "empty location", mime: "text/html", href: "" },
  { label: "outgoing document with navigating mark", mime: "text/html", mark: "navigating" },
  { label: "gate 503 JSON", mime: "application/json" },
  { label: "gateway 502 JSON", mime: "application/json" },
  { label: "gateway 502 body-cap text", mime: "text/plain" },
  { label: "gateway 504 text", mime: "text/plain" },
  { label: "gateway 404 HTML", mime: "text/html" },
  { label: "gateway 404 JSON", mime: "application/json" },
  { label: "engine connection-error page", mime: "text/html", opaque: true },
  { label: "engine JSON viewer", mime: "text/html" },
  { label: "user text", mime: "text/plain" },
  { label: "user image", mime: "image/png" },
  { label: "user PDF", mime: "application/pdf" },
  { label: "user XML", mime: "application/xml", xml: true },
  { label: "user HTML", mime: "text/html" },
  { label: "user foreign page", mime: "text/html", opaque: true },
];

function repairPopup(spec: (typeof repairDocuments)[number]) {
  const page = spec.xml
    ? document.implementation.createDocument(null, "message")
    : document.implementation.createHTMLDocument();
  if (page.body) page.body.textContent = spec.label;
  if (spec.mark) page.documentElement.setAttribute("data-chan-window-page-owner", `${spec.mark}:${Date.now() + 5_000}`);
  const contentType = vi.fn(() => spec.mime);
  Object.defineProperty(page, "contentType", { get: contentType });
  const readDocument = vi.fn(() => {
    if (spec.opaque) throw new DOMException("Document access denied", "SecurityError");
    return page;
  });
  const href = spec.href ?? `https://chan.test/${encodeURIComponent(spec.label)}`;
  const navigate = vi.fn();
  const child = {
    closed: false,
    focus: vi.fn(),
    close: vi.fn(() => { child.closed = true; }),
    get document() { return readDocument(); },
    location: {
      get href() {
        if (spec.opaque) throw new DOMException("Location access denied", "SecurityError");
        return href;
      },
      set href(value: string) { navigate(value); },
    },
  };
  return { child, page, navigate, contentType, readDocument, handle: child as unknown as Window };
}

describe("record-based window repair", () => {
  for (const spec of repairDocuments) {
    for (const connected of [false, true]) {
      it(`repairs ${spec.label} with connected=${connected}`, async () => {
        vi.useFakeTimers();
        const fixture = repairPopup(spec);
        const { child, page, navigate, contentType, readDocument } = fixture;
        vi.spyOn(window, "open").mockReturnValue(fixture.handle);
        const blank = spec.href === "about:blank" || spec.href === "";
        const needsRepair = !spec.mark && (blank || !connected);
        checkWindowPage.mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return new Response("<html></html>");
        });
        const rec = record({ window_id: `rule ${spec.label} ${connected}`, connected });
        const failed = vi.fn();
        const pending = openWindowRecord(rec).catch(failed);
        const check = checkWindowPage;
        await vi.advanceTimersByTimeAsync(99);
        expect(check).toHaveBeenCalledTimes(needsRepair ? 1 : 0);
        expect(navigate).not.toHaveBeenCalled();
        expect(contentType).not.toHaveBeenCalled();
        if (connected && !blank) expect(readDocument).not.toHaveBeenCalled();
        if (page.body) expect(page.body.textContent).toBe(needsRepair && blank
          ? "Waiting for the window to be ready..." : spec.label);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(failed).not.toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledTimes(needsRepair ? 1 : 0);
        if (needsRepair) expect(new URL(navigate.mock.calls[0][0]).searchParams.get("w")).toBe(rec.window_id);
        expect(child.close).not.toHaveBeenCalled();
        expect(child.focus).toHaveBeenCalled();
      });
    }
  }

  for (const label of ["initial blank", "gateway 404 HTML", "user XML", "user foreign page"]) {
    it(`refused repair preserves only nonblank ${label}`, async () => {
      vi.useFakeTimers();
      const spec = repairDocuments.find((entry) => entry.label === label)!;
      const fixture = repairPopup(spec);
      vi.spyOn(window, "open").mockReturnValue(fixture.handle);
      const report = vi.fn();
      checkWindowPage.mockResolvedValue(new Response('{"error":"Repair refused."}', { status: 409 }));
      await openWindowRecord(record({ window_id: `refusal ${label}`, connected: false })).catch(report);
      expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "Repair refused." }));
      expect(fixture.child.close).toHaveBeenCalledTimes(label === "initial blank" ? 1 : 0);
      expect(fixture.navigate).not.toHaveBeenCalled();
      if (fixture.page.body && label !== "initial blank") expect(fixture.page.body.textContent).toBe(label);
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});

describe("the feed read before a repair", () => {
  const PAGE = "http://localhost:3000/proj-1/?w=w-back";

  function pageWindow(): FakeWin {
    const child = fakeWin();
    child.location.href = PAGE;
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    checkWindowPage.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response("<html></html>");
    });
    return child;
  }

  it("leaves a page whose record reconnects while its page is checked", async () => {
    vi.useFakeTimers();
    const rec = record({ window_id: "w-back", origin: "browser", connected: false });
    reconcileWindows(set([rec]));
    const child = pageWindow();
    const navigation = vi.spyOn(child.location, "href", "set");
    const pending = openWindowRecord(rec);
    await vi.advanceTimersByTimeAsync(50);
    reconcileWindows(set([{ ...rec, connected: true }]));
    await vi.advanceTimersByTimeAsync(50);

    expect(await pending).toBe(child);
    expect(navigation).not.toHaveBeenCalled();
    expect(child.document.documentElement.hasAttribute("data-chan-window-page-owner")).toBe(false);
    expect(hasWindowHandle("w-back")).toBe(true);
  });

  it("repairs a page whose latest record still reads disconnected", async () => {
    vi.useFakeTimers();
    const rec = record({ window_id: "w-back", origin: "browser", connected: false });
    reconcileWindows(set([rec]));
    const child = pageWindow();
    const navigation = vi.spyOn(child.location, "href", "set");
    const pending = openWindowRecord(rec);
    await vi.advanceTimersByTimeAsync(50);
    reconcileWindows(set([{ ...rec }]));
    await vi.advanceTimersByTimeAsync(50);

    expect(await pending).toBe(child);
    expect(navigation).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("/proj-1/?w=w-back"));
  });

  it("leaves a window it cannot close when its record leaves the feed during the check", async () => {
    vi.useFakeTimers();
    const rec = record({ window_id: "w-back", origin: "browser", connected: false });
    reconcileWindows(set([rec]));
    const child = pageWindow();
    child.close = vi.fn();
    const navigation = vi.spyOn(child.location, "href", "set");
    const pending = openWindowRecord(rec);
    await vi.advanceTimersByTimeAsync(50);
    reconcileWindows(set([]));
    await vi.advanceTimersByTimeAsync(50);

    expect(await pending).toBeNull();
    expect(navigation).not.toHaveBeenCalled();
    expect(child.document.documentElement.hasAttribute("data-chan-window-page-owner")).toBe(false);
    expect(hasWindowHandle("w-back")).toBe(false);
  });

  it("repairs a page before any feed has arrived", async () => {
    vi.useFakeTimers();
    const child = pageWindow();
    const navigation = vi.spyOn(child.location, "href", "set");
    const pending = openWindowRecord(record({ window_id: "w-back", origin: "browser", connected: false }));
    await vi.advanceTimersByTimeAsync(100);

    expect(await pending).toBe(child);
    expect(navigation).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("/proj-1/?w=w-back"));
  });
});
