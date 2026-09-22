// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

const actions = vi.hoisted(() => ({
  close: vi.fn(),
  focus: vi.fn(),
  liveTerminalCount: vi.fn(),
  newTerminal: vi.fn(),
  newWorkspace: vi.fn(),
  setShown: vi.fn(),
  setPower: vi.fn(),
}));

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

vi.mock("../state/capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/capabilities")>()),
  surface: "devserver",
  canMutateRegistry: true,
  hasDesktopBridge: false,
  selfManagedWindows: true,
  readOnly: false,
  hostOs: "linux",
}));

vi.mock("../state/computerActions", () => ({
  canManageWindow: () => true,
  canOpenWorkspaceWindow: () => true,
  closeComputerWindow: actions.close,
  connectComputer: vi.fn(),
  focusComputerWindow: actions.focus,
  liveTerminalCountForWindow: actions.liveTerminalCount,
  newTerminal: actions.newTerminal,
  newWorkspaceWindow: actions.newWorkspace,
  setWindowShown: actions.setShown,
  setWorkspacePower: actions.setPower,
}));

import CommandLauncher from "./CommandLauncher.svelte";
import type { WindowRecord, WorkspaceEntry } from "../api/library";
import { library } from "../state/library.svelte";
import {
  activeCommandLauncherDraft,
  clearCommandLauncherDraft,
  closeCommandLauncher,
  commandLauncher,
  openCommandLauncher,
} from "../state/commandLauncher.svelte";
import { screen } from "../state/screen.svelte";

Element.prototype.scrollIntoView = vi.fn();

const workspace: WorkspaceEntry = {
  workspace_id: "ws-project",
  path: "/work/project",
  label: "Project",
  on: true,
  status: "running",
  library_id: "lib-local-live-shape",
  devserver_id: null,
  prefix: "ws-project",
};

const windowRecord: WindowRecord = {
  window_id: "w-project-1",
  library_id: "lib-local-live-shape",
  kind: "workspace",
  title: "⌂ /work/project Window 1",
  ordinal: 1,
  label: "release checks",
  workspace_path: "/work/project",
  prefix: "ws-project",
  token: "token",
  persisted: true,
  connected: true,
  active_transfer: false,
  control: false,
};

const terminalRecord: WindowRecord = {
  window_id: "w-terminal-2",
  library_id: "lib-local-live-shape",
  kind: "terminal",
  title: "⌂ Terminal Window 2",
  ordinal: 2,
  label: "deploy shell",
  workspace_path: null,
  prefix: "terminal",
  token: "token",
  persisted: true,
  connected: true,
  active_transfer: false,
  control: true,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let target: HTMLElement;
let app: Record<string, unknown>;

function result(title: string): HTMLButtonElement {
  const row = [...target.querySelectorAll<HTMLButtonElement>("button.deck-result")].find(
    (button) => button.querySelector(".deck-result-title")?.textContent === title,
  );
  if (!row) {
    const visible = [...target.querySelectorAll(".deck-result-title")].map((node) => node.textContent);
    throw new Error(`missing command result ${title}; visible: ${visible.join(", ")}`);
  }
  return row;
}

function titles(): string[] {
  return [...target.querySelectorAll(".deck-result-title")].map((node) => node.textContent ?? "");
}

function input(): HTMLInputElement {
  return target.querySelector(".deck-input") as HTMLInputElement;
}

async function query(value: string): Promise<void> {
  const field = input();
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  await tick();
}

async function key(value: string): Promise<void> {
  (target.querySelector('[role="dialog"]') as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true }),
  );
  await tick();
}

async function settle(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 280));
  await tick();
}

async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  await tick();
}

function closeDecision(): HTMLButtonElement {
  const button = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
    (candidate) => candidate.textContent === "Close",
  );
  if (!button) throw new Error("missing Close decision");
  return button;
}

beforeEach(() => {
  sessionStorage.clear();
  target = document.createElement("div");
  document.body.appendChild(target);
  library.workspaces = [{ ...workspace }];
  library.windows = [{ ...windowRecord }, { ...terminalRecord }];
  library.devservers = [];
  library.gateways = [];
  library.leaders = {};
  screen.current = "computers";
  screen.flips = 0;
  commandLauncher.entryMode = "computers";
  clearCommandLauncherDraft("contextual");
  clearCommandLauncherDraft("computers");
  closeCommandLauncher();
  app = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(() => {
  unmount(app);
  target.remove();
  closeCommandLauncher();
  vi.resetAllMocks();
});

describe("Computers command deck", () => {
  it("opens from the web chord with the clean root action set", () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        altKey: true,
        bubbles: true,
      }),
    );
    flushSync();
    expect(activeCommandLauncherDraft().visible).toBe(true);
    // One Windows branch where Focus / Hide / Show / Close used to sit as four
    // siblings, each listing the same roster through its own filter.
    for (const title of ["New terminal", "New window", "Windows", "Turn on", "Turn off"]) {
      expect(result(title)).toBeTruthy();
    }
    expect(titles()).not.toContain("Focus");
    expect(titles()).not.toContain("Hide");
    expect(target.querySelectorAll(".deck-scope")).toHaveLength(1);
  });

  it("offers turn on and turn off only on workspaces this process may act on", async () => {
    library.workspaces = [
      { ...workspace, workspace_id: "ws-off", label: "Idle", prefix: "ws-off", on: false, status: "stopped" },
      { ...workspace, workspace_id: "ws-held", label: "Held", prefix: "ws-held", on: false, status: "locked" },
      {
        ...workspace,
        workspace_id: "ws-unread",
        label: "Unread",
        prefix: "ws-unread",
        on: false,
        status: "unknown",
        error: "lock file could not be opened",
      },
      { ...workspace, workspace_id: "ws-up", label: "Up", prefix: "ws-up", on: true, status: "running" },
      { ...workspace, workspace_id: "ws-held-on", label: "Held on", prefix: "ws-held-on", on: true, status: "locked" },
      { ...workspace, workspace_id: "ws-unread-on", label: "Unread on", prefix: "ws-unread-on", on: true, status: "unknown" },
    ];
    openCommandLauncher("computers");
    flushSync();
    result("Turn on").click();
    await tick();
    expect(titles()).toEqual(["Idle"]);

    closeCommandLauncher();
    clearCommandLauncherDraft("computers");
    openCommandLauncher("computers");
    flushSync();
    result("Turn off").click();
    await tick();
    expect(titles()).toEqual(["Up"]);
  });

  it("does not expose the Desktop theme command on a devserver", async () => {
    openCommandLauncher("computers");
    flushSync();
    await query("theme");
    const titles = [...target.querySelectorAll(".deck-result-title")].map(
      (node) => node.textContent,
    );
    expect(titles).not.toContain("Switch to light theme");
    expect(titles).not.toContain("Switch to dark theme");
  });

  it("deep-searches a control terminal note and focuses that exact record", async () => {
    openCommandLauncher("computers");
    flushSync();
    await query("focus deploy shell");
    // Typed search still reaches the action itself, not just the window it
    // belongs to: the flattened list carries every window's leaves.
    result("Focus").click();
    await settle();
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ window_id: "w-terminal-2" }));
  });

  it("lists windows as targets, each branching into its own actions", async () => {
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual(["windows"]);
    // The Library screen's order: control terminal, then workspace windows.
    expect(titles()).toEqual(["Control terminal", "Window 1 [release checks]"]);

    result("Window 1 [release checks]").click();
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual([
      "windows",
      "lib-local-live-shape:w-project-1",
    ]);
    expect(titles()).toEqual(["Focus", "Hide", "Close"]);

    result("Hide").click();
    await settle();
    expect(actions.setShown).toHaveBeenCalledWith(
      expect.objectContaining({ window_id: "w-project-1" }),
      false,
    );
  });

  it("offers Show on a hidden window where a visible one offers Hide", async () => {
    library.windows = [{ ...windowRecord, hidden: true }];
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    expect(result("Window 1 [release checks]")).toBeTruthy();
    result("Window 1 [release checks]").click();
    await tick();
    // Show here is a plain visibility flip, distinct from Focus, so a hidden
    // window keeps both.
    expect(titles()).toEqual(["Focus", "Show", "Close"]);
  });

  it("ArrowLeft from a window's actions returns to the window list", async () => {
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Control terminal").click();
    await tick();
    await key("ArrowLeft");
    expect(activeCommandLauncherDraft().path).toEqual(["windows"]);
    expect(result("Window 1 [release checks]")).toBeTruthy();
    await key("ArrowLeft");
    expect(activeCommandLauncherDraft().path).toEqual([]);
    expect(result("Windows")).toBeTruthy();
  });

  it("falls back to the window list when that window closes elsewhere", async () => {
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    // The feed is pushed, so the window can go while its actions are on screen.
    library.windows = [{ ...terminalRecord }];
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual(["windows"]);
    expect(result("Control terminal")).toBeTruthy();
  });

  it.each([
    [3, "3 terminal sessions in this window will stop."],
    [0, "This window will close."],
    [null, "Open sessions in this window may stop."],
  ] as const)("uses the informed Close message for count %s", async (count, message) => {
    actions.liveTerminalCount.mockResolvedValue(count);
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Close Window 1 [release checks]?");
    expect(target.querySelector(".deck-operation")?.textContent).toContain(message);
    expect(actions.liveTerminalCount).toHaveBeenCalledOnce();
    expect(actions.close).not.toHaveBeenCalled();
    const confirm = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
      (button) => button.textContent === "Close",
    );
    confirm?.click();
    await flushPromises();
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.close).toHaveBeenCalledWith(
      expect.objectContaining({ window_id: "w-project-1" }),
    );
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(2);
    expect(target.querySelector(".deck-decisions")).toBeNull();
  });

  it("re-confirms with a grown terminal count before closing", async () => {
    actions.liveTerminalCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2);
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "This window will close.",
    );

    closeDecision().click();
    await flushPromises();
    expect(actions.close).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "2 terminal sessions in this window will stop.",
    );

    closeDecision().click();
    await flushPromises();
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(3);
  });

  it("re-confirms a restored Close card before closing", async () => {
    actions.liveTerminalCount.mockResolvedValue(1);
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    const draft = activeCommandLauncherDraft();
    draft.operation = {
      kind: "confirm",
      itemId: "computers:close:lib-local-live-shape:w-project-1",
      title: "Close Window 1 [release checks]?",
      message: "This window will close.",
      actionLabel: "Close",
      danger: true,
      selected: "cancel",
    };
    await tick();

    closeDecision().click();
    await flushPromises();
    expect(actions.close).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "1 terminal session in this window will stop.",
    );

    closeDecision().click();
    await flushPromises();
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(2);
  });

  it("keeps Close counts separate between contextual and Computers drafts", async () => {
    actions.liveTerminalCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "This window will close.",
    );
    await key("Escape");

    openCommandLauncher("contextual");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "1 terminal session in this window will stop.",
    );
    await key("Escape");

    openCommandLauncher("computers");
    flushSync();
    closeDecision().click();
    await flushPromises();

    expect(actions.close).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "1 terminal session in this window will stop.",
    );
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(3);
  });

  it("does not let a dropped Close preparation replace the painted count", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    actions.liveTerminalCount
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue(1);

    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await tick();
    await key("Escape");
    result("Close").click();
    await tick();

    second.resolve(2);
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "2 terminal sessions in this window will stop.",
    );
    first.resolve(1);
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "2 terminal sessions in this window will stop.",
    );

    closeDecision().click();
    await flushPromises();

    expect(actions.close).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "1 terminal session in this window will stop.",
    );
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(3);
  });

  it("does not close a window on a reading a later card replaced", async () => {
    const recheck = deferred<unknown>();
    const reopened = deferred<unknown>();
    actions.liveTerminalCount
      .mockResolvedValueOnce(5)
      .mockImplementationOnce(() => recheck.promise)
      .mockImplementationOnce(() => reopened.promise);

    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "5 terminal sessions in this window will stop.",
    );

    // Confirm, dismiss the working card inside the recheck's latency, then ask
    // again: the second card is prepared while the first recheck is still out.
    closeDecision().click();
    await tick();
    await key("Escape");
    result("Close").click();
    await tick();

    reopened.resolve(7);
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "7 terminal sessions in this window will stop.",
    );

    // The overtaken recheck still matches its own older reading. It must not
    // close the window under the card that now names a different number.
    recheck.resolve(5);
    await flushPromises();
    expect(actions.close).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "7 terminal sessions in this window will stop.",
    );
  });

  it("forgets a Close reading when its window leaves the roster", async () => {
    actions.liveTerminalCount.mockResolvedValue(2);
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "2 terminal sessions in this window will stop.",
    );

    // The window goes and comes back while this always-mounted deck watches.
    library.windows = [{ ...terminalRecord }];
    await tick();
    library.windows = [{ ...windowRecord }, { ...terminalRecord }];
    await tick();

    result("Window 1 [release checks]").click();
    await tick();
    const draft = activeCommandLauncherDraft();
    draft.operation = {
      kind: "confirm",
      itemId: "computers:close:lib-local-live-shape:w-project-1",
      title: "Close Window 1 [release checks]?",
      message: "2 terminal sessions in this window will stop.",
      actionLabel: "Close",
      danger: true,
      selected: "cancel",
    };
    await tick();

    // Nothing records a count for the new roster entry, so Close asks again
    // instead of matching the reading the departed window left behind.
    closeDecision().click();
    await flushPromises();
    expect(actions.close).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "2 terminal sessions in this window will stop.",
    );
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "two"])("uses the generic Close message for payload %s", async (count) => {
    actions.liveTerminalCount.mockResolvedValueOnce(count);
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "Open sessions in this window may stop.",
    );
  });

  it("uses the generic Close message when the count request fails", async () => {
    actions.liveTerminalCount.mockRejectedValueOnce(new Error("HTTP 503"));
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    result("Close").click();
    await flushPromises();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "Open sessions in this window may stop.",
    );
  });

  it("keeps the control-terminal Close warning without querying a count", async () => {
    library.windows = [{ ...terminalRecord }];
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Control terminal").click();
    await tick();
    result("Close").click();
    await tick();
    expect(target.querySelector(".deck-operation")?.textContent).toContain(
      "This stops the control terminal and its connection script.",
    );
    closeDecision().click();
    await flushPromises();
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.close).toHaveBeenCalledWith(
      expect.objectContaining({ window_id: "w-terminal-2" }),
    );
    expect(actions.liveTerminalCount).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-decisions")).toBeNull();
  });

  it("opens a running workspace from the New window submenu", async () => {
    openCommandLauncher("computers");
    flushSync();
    result("New window").click();
    await tick();
    result("Project").click();
    await settle();
    expect(actions.newWorkspace).toHaveBeenCalledWith(expect.objectContaining({ path: "/work/project" }));
  });

  it("dismisses a typed keyboard launch as soon as the new terminal succeeds", async () => {
    let finishLaunch!: () => void;
    actions.newTerminal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLaunch = resolve;
        }),
    );
    openCommandLauncher("computers");
    flushSync();
    await query("ter");

    const rootTitles = [...target.querySelectorAll(".deck-result-title")].map(
      (node) => node.textContent,
    );
    const branchIndex = rootTitles.indexOf("New terminal");
    expect(branchIndex).toBeGreaterThanOrEqual(0);
    for (let index = 0; index <= branchIndex; index += 1) await key("ArrowDown");
    expect(target.querySelector(".deck-result.active .deck-result-title")?.textContent).toBe(
      "New terminal",
    );
    await key("Enter");
    expect(activeCommandLauncherDraft().path).toEqual(["new-terminal"]);
    expect(result("This machine")).toBeTruthy();

    await key("ArrowDown");
    await key("Enter");
    expect(actions.newTerminal).toHaveBeenCalledOnce();
    expect(activeCommandLauncherDraft().visible).toBe(true);
    finishLaunch();
    // Flush the nested action -> provider -> shared-deck promise chain without
    // advancing the 260 ms success timer this regression is guarding against.
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    await tick();

    expect(activeCommandLauncherDraft().visible).toBe(false);
    expect(activeCommandLauncherDraft().query).toBe("");
    expect(target.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Escape hides and preserves the current submenu until explicitly cleared", async () => {
    openCommandLauncher("computers");
    flushSync();
    result("Windows").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    await key("Escape");
    expect(activeCommandLauncherDraft().visible).toBe(false);
    expect(activeCommandLauncherDraft().path).toEqual([
      "windows",
      "lib-local-live-shape:w-project-1",
    ]);
    openCommandLauncher("computers");
    flushSync();
    expect(result("Close")).toBeTruthy();
  });
});
