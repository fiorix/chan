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
  active_transfer: false, control: false,
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
    expect(report).toHaveBeenCalledTimes(outcome === "refused" ? 1 : 0);
    expect(check).toHaveBeenCalledTimes(outcome === "blocked" ? 0 : 1);
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
