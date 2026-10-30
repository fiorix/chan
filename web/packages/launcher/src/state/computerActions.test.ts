import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowRecord } from "../api/library";
import { backend } from "../api/backend";
import {
  detachTmux,
  endTmux,
  focusComputerWindow,
  newTmuxWindow,
  openComputerWindow,
  openTmuxWindow,
  setWindowShown,
} from "./computerActions";
import { cancelConfirm, confirm, resolveConfirm } from "./confirm.svelte";
import { resetWindowManager } from "./windowManager.svelte";

vi.mock("./capabilities", () => ({ hasDesktopBridge: false, selfManagedWindows: true }));
vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

const record: WindowRecord = {
  window_id: "action-window", library_id: "local", kind: "terminal",
  title: "Terminal", ordinal: 1, workspace_path: null, prefix: "terminal",
  token: "", persisted: true, connected: false, hidden: true,
  active_transfer: false, control: false, origin: "browser",
};

function popup() {
  const child = {
    closed: false,
    location: { href: "about:blank" },
    document: document.implementation.createHTMLDocument(),
    focus: vi.fn(),
    close: vi.fn(() => { child.closed = true; }),
  };
  return child;
}

afterEach(() => {
  resetWindowManager();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("browser action visibility", () => {
  it("Show only changes visibility while another holder keeps a browser record connected", async () => {
    const rec = { ...record, window_id: "show other holder", connected: true, holders: ["theirs"] };
    const open = vi.spyOn(window, "open").mockReturnValue(popup() as unknown as Window);
    const check = vi.spyOn(backend, "checkWindowPage").mockResolvedValue(new Response("<html></html>"));
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);

    await setWindowShown(rec, true);

    expect(open).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledExactlyOnceWith(rec.window_id, false, undefined);
  });

  it.each(["closed", "refused", "blocked"])("Focus does not unhide a %s window", async (outcome) => {
    vi.useFakeTimers();
    const child = popup();
    vi.spyOn(window, "open").mockReturnValue(outcome === "blocked" ? null : child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const check = vi.spyOn(backend, "checkWindowPage").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response('{"error":"Focus refused."}', { status: 409 });
    });
    const report = vi.fn();
    const pending = focusComputerWindow({ ...record, window_id: `focus ${outcome}` }).catch(report);
    if (outcome === "closed") child.closed = true;
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(visibility).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(outcome === "closed" ? 0 : 1);
    if (outcome === "blocked") {
      expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "The browser blocked the Chan window" }));
    }
    expect(check).toHaveBeenCalledTimes(outcome === "blocked" ? 0 : 1);
  });

  it("Show reports a blocked window once and changes no visibility", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const report = vi.fn();
    await setWindowShown({ ...record, window_id: "show blocked" }, true).catch(report);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "The browser blocked the Chan window" }));
    expect(visibility).not.toHaveBeenCalled();
  });

  it.each([
    ["a native", "native"],
    ["an omitted", undefined],
  ] as const)("Show only changes visibility for a record of %s origin", async (label, origin) => {
    const child = popup();
    const open = vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const check = vi.spyOn(backend, "checkWindowPage").mockResolvedValue(new Response("<html></html>"));
    await setWindowShown({ ...record, window_id: `show ${label}`, origin }, true);
    expect(open).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledExactlyOnceWith(`show ${label}`, false, undefined);
  });

  it.each(["native", "unknown"] as const)("stale Focus refuses hidden and visible %s records before side effects", async (origin) => {
    const open = vi.spyOn(window, "open");
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const check = vi.spyOn(backend, "checkWindowPage");
    for (const hidden of [true, false]) {
      await expect(focusComputerWindow({ ...record, window_id: `focus ${origin} ${hidden}`, hidden, origin: origin === "native" ? "native" : undefined }))
        .rejects.toThrow(/native focus.*unavailable/i);
    }
    expect(open).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(visibility).not.toHaveBeenCalled();
  });

  it("Focus acquires and unhides a hidden browser-origin window", async () => {
    const child = popup();
    const open = vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const check = vi.spyOn(backend, "checkWindowPage").mockResolvedValue(new Response("<html></html>"));

    await focusComputerWindow({ ...record, window_id: "focus browser" });

    expect(open).toHaveBeenCalledExactlyOnceWith("", "focus browser");
    expect(check).toHaveBeenCalledOnce();
    expect(child.location.href).toContain("?w=focus+browser");
    expect(visibility).toHaveBeenCalledExactlyOnceWith("focus browser", false, undefined);
  });

  it("explicit Open of a hidden native record acquires a browser page without unhiding", async () => {
    const child = popup();
    const open = vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility");
    vi.spyOn(backend, "checkWindowPage").mockResolvedValue(new Response("<html></html>"));
    await openComputerWindow({ ...record, window_id: "open native", origin: "native" });

    expect(open).toHaveBeenCalledExactlyOnceWith("", "open native");
    expect(child.location.href).toContain("?w=open+native");
    expect(visibility).not.toHaveBeenCalled();
  });

  it.each(["navigating"])("Show does not focus a peer's %s document", async (phase) => {
    vi.useFakeTimers();
    const child = popup();
    child.document.documentElement.setAttribute("data-chan-window-page-owner", `${phase}:${Date.now() + 5_000}`);
    const open = vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const check = vi.spyOn(backend, "checkWindowPage");
    await setWindowShown({ ...record, window_id: `show peer ${phase}` }, true);
    expect(open).toHaveBeenCalledExactlyOnceWith("", `show peer ${phase}`);
    expect(child.focus).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledExactlyOnceWith(`show peer ${phase}`, false, undefined);
  });

  it("Show changes no visibility before a peer's wait decides", async () => {
    vi.useFakeTimers();
    const child = popup();
    child.document.documentElement.setAttribute("data-chan-window-page-owner", `waiting:${Date.now() + 30_000}`);
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const check = vi.spyOn(backend, "checkWindowPage");
    let settled = false;
    const pending = setWindowShown({ ...record, window_id: "show follows" }, true).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(visibility).not.toHaveBeenCalled();
    expect(child.focus).not.toHaveBeenCalled();
    child.document.documentElement.setAttribute("data-chan-window-page-owner", `navigating:${Date.now() + 10_000}`);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(check).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledExactlyOnceWith("show follows", false, undefined);
  });
});

describe("tmux connection requests", () => {
  const logs = { id: "@3", name: "logs", panes: 1, open: false };

  afterEach(() => {
    cancelConfirm();
  });

  it("sends the closed request objects for a new window, a detach and an opened window", async () => {
    const request = vi.spyOn(backend, "tmuxRequest").mockResolvedValue(undefined);
    await newTmuxWindow("tm-1");
    await detachTmux("tm-1");
    await openTmuxWindow("tm-1", logs);
    expect(request.mock.calls).toEqual([
      ["tm-1", { request: "new-window" }],
      ["tm-1", { request: "detach" }],
      ["tm-1", { request: "open-window", window: "@3" }],
    ]);
    expect(confirm.open).toBe(false);
  });

  it("ends the tmux server only once the confirm is resolved", async () => {
    const request = vi.spyOn(backend, "tmuxRequest").mockResolvedValue(undefined);
    await endTmux("tm-1");
    expect(confirm.open).toBe(true);
    expect(confirm.title).toBe("End tmux server?");
    expect(confirm.message).toBe("End the tmux server and every session it holds?");
    expect(confirm.confirmLabel).toBe("End");
    expect(request).not.toHaveBeenCalled();
    await resolveConfirm();
    expect(request).toHaveBeenCalledExactlyOnceWith("tm-1", { request: "end" });
    expect(confirm.open).toBe(false);
  });

  it("sends nothing when the End confirm is cancelled", async () => {
    const request = vi.spyOn(backend, "tmuxRequest").mockResolvedValue(undefined);
    await endTmux("tm-1");
    cancelConfirm();
    expect(request).not.toHaveBeenCalled();
    expect(confirm.open).toBe(false);
  });
});
