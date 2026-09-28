import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowRecord } from "../api/library";
import { backend } from "../api/backend";
import { focusComputerWindow, setWindowShown } from "./computerActions";
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

  it("Focus still acquires and repairs the window of a native record", async () => {
    const child = popup();
    const open = vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    vi.spyOn(backend, "checkWindowPage").mockResolvedValue(new Response("<html></html>"));
    await focusComputerWindow({ ...record, window_id: "focus native", origin: "native" });
    expect(open).toHaveBeenCalledExactlyOnceWith("", "focus native");
    expect(child.location.href).toContain("?w=focus+native");
    expect(visibility).toHaveBeenCalledExactlyOnceWith("focus native", false, undefined);
  });

  it.each(["waiting", "navigating"])("Show does not focus a peer's %s document", async (phase) => {
    vi.useFakeTimers();
    const child = popup();
    child.document.documentElement.setAttribute("data-chan-window-page-owner", phase);
    const open = vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const check = vi.spyOn(backend, "checkWindowPage");
    await setWindowShown({ ...record, window_id: `show peer ${phase}` }, true);
    expect(open).toHaveBeenCalledExactlyOnceWith("", `show peer ${phase}`);
    expect(child.focus).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(visibility).toHaveBeenCalledExactlyOnceWith(`show peer ${phase}`, false, undefined);
  });
});
