// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

const actions = vi.hoisted(() => ({
  close: vi.fn(),
  focus: vi.fn(),
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
  control: true,
};

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
  vi.clearAllMocks();
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
    for (const title of ["New terminal", "New window", "Focus", "Hide", "Show"]) {
      expect(result(title)).toBeTruthy();
    }
    expect(target.querySelectorAll(".deck-scope")).toHaveLength(1);
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
    result("Control terminal").click();
    await settle();
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ window_id: "w-terminal-2" }));
  });

  it("uses branches for Hide and Show, with ArrowLeft returning to root", async () => {
    openCommandLauncher("computers");
    flushSync();
    result("Hide").click();
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual(["hide"]);
    result("Window 1 [release checks]").click();
    await settle();
    expect(actions.setShown).toHaveBeenCalledWith(
      expect.objectContaining({ window_id: "w-project-1" }),
      false,
    );

    library.windows = [{ ...windowRecord, hidden: true }];
    openCommandLauncher("computers");
    flushSync();
    result("Show").click();
    await tick();
    await key("ArrowLeft");
    expect(activeCommandLauncherDraft().path).toEqual([]);
    expect(result("Show")).toBeTruthy();
  });

  it("keeps destructive Close inside the keyboard-visible confirmation", async () => {
    openCommandLauncher("computers");
    flushSync();
    await query("close");
    result("Close").click();
    await tick();
    result("Window 1 [release checks]").click();
    await tick();
    expect(target.querySelector(".deck-operation")?.textContent).toContain("Close Window 1 [release checks]?");
    expect(actions.close).not.toHaveBeenCalled();
    const confirm = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
      (button) => button.textContent === "Close",
    );
    confirm?.click();
    await settle();
    expect(actions.close).toHaveBeenCalledWith(expect.objectContaining({ window_id: "w-project-1" }));
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
    await query("close");
    result("Close").click();
    await tick();
    await key("Escape");
    expect(activeCommandLauncherDraft().visible).toBe(false);
    expect(activeCommandLauncherDraft().path).toEqual(["close"]);
    openCommandLauncher("computers");
    flushSync();
    expect(result("Window 1 [release checks]")).toBeTruthy();
  });
});
