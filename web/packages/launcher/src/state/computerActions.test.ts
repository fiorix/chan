import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/library";
import type { DevserverEntry, GatewayEntry, WindowRecord, WorkspaceEntry } from "../api/library";
import { backend } from "../api/backend";
import {
  connectAndOpenTerminal,
  copyGatewayPublicKey,
  detachTmux,
  focusComputerWindow,
  liveTerminalCountForWorkspace,
  newWorkspaceTerminalWindow,
  newWorkspaceWindow,
  newTmuxWindow,
  openComputerWindow,
  openTmuxWindow,
  setWindowShown,
  showComputerCard,
  turnOffWorkspace,
  turnOnAndOpenWorkspace,
} from "./computerActions";
import { cancelConfirm, confirm } from "./confirm.svelte";
import { decks, resetDeck } from "./deck.svelte";
import { screen } from "./screen.svelte";
import { resetWindowManager } from "./windowManager.svelte";

vi.mock("./capabilities", () => ({ hasDesktopBridge: false, selfManagedWindows: true }));
vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

describe("workspace window actions", () => {
  it("mints a local terminal window with one startup intent and leaves w unchanged", async () => {
    const workspace = (await backend.listWorkspaces()).find((entry) => entry.devserver_id === null && entry.status === "running");
    expect(workspace).toBeDefined();
    const children = [popup(), popup()];
    let opened = 0;
    vi.spyOn(window, "open").mockImplementation(() => children[opened++] as unknown as Window);
    vi.spyOn(backend, "checkWindowPage").mockResolvedValue(new Response("<html></html>"));
    const create = vi.spyOn(backend, "createWindow");

    await newWorkspaceTerminalWindow(workspace!);
    expect(create).toHaveBeenLastCalledWith("workspace", expect.objectContaining({ workspacePath: workspace!.path, startTerminal: true }));
    expect(new URL(children[0]!.location.href).searchParams.get("start")).toBe("terminal");

    await newWorkspaceWindow(workspace!);
    expect(create).toHaveBeenLastCalledWith("workspace", expect.objectContaining({ workspacePath: workspace!.path, startTerminal: false }));
    expect(new URL(children[1]!.location.href).searchParams.has("start")).toBe(false);
  });

  it("forwards the terminal intent to a connected devserver and leaves w unchanged", async () => {
    const workspace = (await backend.listWorkspaces()).find((entry) => entry.devserver_id !== null && entry.status === "running");
    expect(workspace).toBeDefined();
    const open = vi.spyOn(backend, "openDevserverWorkspace").mockResolvedValue(undefined);

    await newWorkspaceTerminalWindow(workspace!);
    await newWorkspaceWindow(workspace!);

    expect(open.mock.calls).toEqual([
      [workspace!.devserver_id, workspace!.path, true],
      [workspace!.devserver_id, workspace!.path, false],
    ]);
  });
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
        // The row a browser offers on such a record, by the name it carries.
        .rejects.toThrow("Native focus is unavailable in this browser. Use Open window.");
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

});

describe("the command deck's wrappers", () => {
  const local: WorkspaceEntry = {
    workspace_id: "ws-deck",
    path: "/work/deck",
    label: "Deck",
    on: true,
    status: "running",
    library_id: "local",
    devserver_id: null,
    prefix: "ws-deck",
  };
  const served: WorkspaceEntry = { ...local, devserver_id: "ds-deck", prefix: "w/deck", library_id: "lib-deck" };
  const devserver = { id: "ds-deck" } as DevserverEntry;

  function liveTerminals(count: number): ApiError {
    return new ApiError(
      409,
      JSON.stringify({ error: "workspace has live terminal sessions", code: "live_terminals", active_terminals: count }),
    );
  }

  afterEach(() => {
    cancelConfirm();
    resetDeck();
    screen.current = "computers";
    screen.flips = 0;
  });

  it("turnOffWorkspace answers the count the server refused over and raises no dialog", async () => {
    const off = vi.spyOn(backend, "setWorkspaceOn").mockRejectedValueOnce(liveTerminals(2)).mockResolvedValue(undefined);
    expect(await turnOffWorkspace(local)).toBe(2);
    expect(confirm.open, "the caller asks on a surface of its own").toBe(false);
    expect(await turnOffWorkspace(local, true)).toBeNull();
    expect(off.mock.calls).toEqual([
      ["ws-deck", false, false],
      ["ws-deck", false, true],
    ]);
  });

  it("turnOffWorkspace passes every other refusal on, and a forced one whole", async () => {
    const off = vi.spyOn(backend, "setWorkspaceOn").mockRejectedValue(new ApiError(409, '{"error":"workspace is locked"}'));
    await expect(turnOffWorkspace(local)).rejects.toThrow("workspace is locked");
    off.mockRejectedValue(liveTerminals(1));
    await expect(turnOffWorkspace(local, true)).rejects.toThrow("workspace has live terminal sessions");
  });

  it("turnOffWorkspace turns a served workspace off on its devserver", async () => {
    const off = vi.spyOn(backend, "setDevserverWorkspaceOn").mockRejectedValueOnce(liveTerminals(4)).mockResolvedValue(undefined);
    expect(await turnOffWorkspace(served)).toBe(4);
    expect(await turnOffWorkspace(served, true)).toBeNull();
    expect(off.mock.calls).toEqual([
      ["ds-deck", "w/deck", false, false],
      ["ds-deck", "w/deck", false, true],
    ]);
  });

  it("turnOnAndOpenWorkspace turns the workspace on before it opens the window", async () => {
    const order: string[] = [];
    vi.spyOn(backend, "setDevserverWorkspaceOn").mockImplementation(async (_id, _prefix, on) => {
      order.push(`on:${on}`);
      return undefined;
    });
    vi.spyOn(backend, "openDevserverWorkspace").mockImplementation(async (_id, path, startTerminal) => {
      order.push(`open:${path}:${startTerminal}`);
    });
    await turnOnAndOpenWorkspace(served);
    expect(order).toEqual(["on:true", "open:/work/deck:false"]);
  });

  it("turnOnAndOpenWorkspace opens nothing when the turn-on is refused", async () => {
    vi.spyOn(backend, "setDevserverWorkspaceOn").mockRejectedValue(new Error("mount failed"));
    const open = vi.spyOn(backend, "openDevserverWorkspace").mockResolvedValue(undefined);
    await expect(turnOnAndOpenWorkspace(served)).rejects.toThrow("mount failed");
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["opens the terminal once the devserver is connected", false, 1],
    ["waits for a later gesture while a sign-in is pending", true, 0],
  ])("connectAndOpenTerminal %s", async (_name, pending_signin, opened) => {
    const connect = vi.spyOn(backend, "connectDevserver").mockResolvedValue(undefined);
    vi.spyOn(backend, "listDevservers").mockResolvedValue([
      { ...devserver, status: pending_signin ? "disconnected" : "connected", pending_signin } as DevserverEntry,
    ]);
    const terminal = vi.spyOn(backend, "openDevserverTerminal").mockResolvedValue(undefined);
    await connectAndOpenTerminal(devserver);
    expect(connect).toHaveBeenCalledExactlyOnceWith("ds-deck");
    expect(terminal).toHaveBeenCalledTimes(opened);
  });

  it("connectAndOpenTerminal opens nothing when the connect is refused", async () => {
    vi.spyOn(backend, "connectDevserver").mockRejectedValue(new Error("no route to host"));
    const terminal = vi.spyOn(backend, "openDevserverTerminal").mockResolvedValue(undefined);
    await expect(connectAndOpenTerminal(devserver)).rejects.toThrow("no route to host");
    expect(terminal).not.toHaveBeenCalled();
  });

  it("liveTerminalCountForWorkspace sums its windows' counts", async () => {
    const count = vi.spyOn(backend, "liveTerminalCount").mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const windows = [{ ...record, window_id: "a" }, { ...record, window_id: "b" }];
    expect(await liveTerminalCountForWorkspace(local, windows)).toBe(3);
    expect(count.mock.calls).toEqual([["a"], ["b"]]);
    expect(await liveTerminalCountForWorkspace(local, [])).toBe(0);
  });

  it("liveTerminalCountForWorkspace names no figure it cannot stand behind", async () => {
    const count = vi.spyOn(backend, "liveTerminalCount").mockResolvedValueOnce(2).mockResolvedValueOnce(null);
    const windows = [{ ...record, window_id: "a" }, { ...record, window_id: "b" }];
    expect(await liveTerminalCountForWorkspace(local, windows)).toBeNull();
    count.mockClear();
    expect(await liveTerminalCountForWorkspace(served, windows), "a devserver's feed carries no count").toBeNull();
    expect(count).not.toHaveBeenCalled();
  });

  it("showComputerCard turns the Computers screen to the card and asks focus onto it", () => {
    screen.current = "gateways";
    const asked = decks.computers.focusSeq;
    showComputerCard("ds-deck");
    expect(screen.current).toBe("computers");
    expect(decks.computers.activeKey).toBe("ds-deck");
    expect(decks.computers.focusSeq).toBe(asked + 1);
  });

  it("copyGatewayPublicKey writes the whole key to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await copyGatewayPublicKey({ id: "gw", wireguard_public_key: "cHVibGljLWtleQ==" } as GatewayEntry);
      expect(writeText).toHaveBeenCalledExactlyOnceWith("cHVibGljLWtleQ==");
      await expect(copyGatewayPublicKey({ id: "gw", wireguard_public_key: null } as GatewayEntry)).rejects.toThrow(
        "This gateway has no WireGuard key",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
