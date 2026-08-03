// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
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

vi.mock("../state/capabilities", () => ({
  surface: "desktop",
  canMutateRegistry: true,
  hasDesktopBridge: true,
  selfManagedWindows: false,
  readOnly: false,
  hostOs: "linux",
}));

vi.mock("../state/computerActions", () => ({
  canManageWindow: () => true,
  canOpenWorkspaceWindow: () => true,
  connectComputer: vi.fn(),
  focusComputerWindow: actions.focus,
  newTerminal: actions.newTerminal,
  newWorkspaceWindow: actions.newWorkspace,
  setWindowShown: actions.setShown,
  setWorkspacePower: actions.setPower,
}));

import CommandLauncher from "./CommandLauncher.svelte";
import type { DevserverEntry, WindowRecord, WorkspaceEntry } from "../api/library";
import { library } from "../state/library.svelte";
import {
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
  library_id: "local",
  devserver_id: null,
  prefix: "ws-project",
};

const windowRecord: WindowRecord = {
  window_id: "w-project-1",
  library_id: "local",
  kind: "workspace",
  title: "⌂ /work/project Window 1",
  ordinal: 1,
  workspace_path: "/work/project",
  prefix: "ws-project",
  token: "token",
  persisted: true,
  connected: true,
  control: false,
};

const terminalRecord: WindowRecord = {
  window_id: "w-terminal-2",
  library_id: "local",
  kind: "terminal",
  title: "⌂ Terminal Window 2",
  ordinal: 2,
  workspace_path: null,
  prefix: "terminal",
  token: "token",
  persisted: true,
  connected: true,
  control: true,
};

const remote: DevserverEntry = {
  id: "remote-1",
  url: "http://devbox:8787",
  host: "devbox",
  port: 8787,
  label: "Dev box",
  script: "",
  has_token: true,
  library_id: "lib-remote",
  status: "connected",
  pending_signin: false,
  auto_hide_control: false,
  os: "linux",
  pretty_name: "Linux",
  gateway_id: null,
  gateway_url: "",
  shared: false,
  native_trust_required: false,
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
  closeCommandLauncher();
  clearCommandLauncherDraft();
  app = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(() => {
  unmount(app);
  target.remove();
  closeCommandLauncher();
  vi.clearAllMocks();
});

describe("Computers inline command deck", () => {
  it("opens from the desktop chord without a native overlay", () => {
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
    expect(commandLauncher.draft.visible).toBe(true);
    expect(result("New terminal")).toBeTruthy();
    expect(result("New window")).toBeTruthy();
    expect(result("Focus")).toBeTruthy();
    expect(target.querySelectorAll(".deck-scope")).toHaveLength(1);
  });

  it("deep-searches the control terminal and focuses its exact record", async () => {
    openCommandLauncher();
    flushSync();
    await query("focus control terminal");
    result("Control terminal").click();
    await settle();
    expect(actions.focus).toHaveBeenCalledWith(
      expect.objectContaining({ window_id: "w-terminal-2" }),
    );
  });

  it("uses branches for hide and show", async () => {
    openCommandLauncher();
    flushSync();
    await query("hide");
    result("Hide").click();
    await tick();
    expect(commandLauncher.draft.path).toEqual(["hide"]);
    result("Window 1").click();
    await settle();
    expect(actions.setShown).toHaveBeenCalledWith(
      expect.objectContaining({ window_id: "w-project-1" }),
      false,
    );

    library.windows = [{ ...windowRecord, hidden: true }];
    openCommandLauncher();
    flushSync();
    await query("show");
    result("Show").click();
    await tick();
    result("Window 1").click();
    await settle();
    expect(actions.setShown).toHaveBeenLastCalledWith(
      expect.objectContaining({ window_id: "w-project-1" }),
      true,
    );
  });

  it("selects the first target after a pointer-opened branch replaces the list", async () => {
    openCommandLauncher();
    flushSync();
    result("Focus").click();
    await tick();

    expect(target.querySelector("button.deck-result")?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("opens a local running workspace from the New window submenu", async () => {
    openCommandLauncher();
    flushSync();
    result("New window").click();
    await tick();
    result("Project").click();
    await settle();
    expect(actions.newWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/work/project" }),
    );
  });

  it("offers connected-devserver terminals from the aggregate SPA", async () => {
    library.devservers = [{ ...remote }];
    openCommandLauncher();
    flushSync();
    result("New terminal").click();
    await tick();
    result("Dev box").click();
    await settle();
    expect(actions.newTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: "remote-1" }));
  });

  it("offers a connected-devserver workspace from the aggregate SPA", async () => {
    library.devservers = [{ ...remote }];
    library.workspaces = [
      { ...workspace },
      {
        ...workspace,
        workspace_id: "remote-project",
        path: "/srv/remote-project",
        label: "Remote project",
        library_id: "lib-remote",
        devserver_id: "remote-1",
        prefix: "remote-project",
      },
    ];
    openCommandLauncher();
    flushSync();
    result("New window").click();
    await tick();
    result("Remote project").click();
    await settle();
    expect(actions.newWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ devserver_id: "remote-1", path: "/srv/remote-project" }),
    );
  });

  it("dismisses as soon as a new terminal succeeds", async () => {
    let finishLaunch!: () => void;
    actions.newTerminal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLaunch = resolve;
        }),
    );
    openCommandLauncher();
    flushSync();
    result("New terminal").click();
    await tick();
    result("This machine").click();
    await tick();
    expect(commandLauncher.draft.visible).toBe(true);
    finishLaunch();
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    await tick();
    expect(commandLauncher.draft.visible).toBe(false);
    expect(commandLauncher.draft.query).toBe("");
  });

  it("does not let a dismissed pending action close a reused deck", async () => {
    let finishLaunch!: () => void;
    actions.newTerminal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLaunch = resolve;
        }),
    );
    openCommandLauncher();
    flushSync();
    result("New terminal").click();
    await tick();
    result("This machine").click();
    await tick();
    const dismiss = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Dismiss",
    );
    expect(dismiss).toBeTruthy();
    dismiss?.click();
    await tick();

    finishLaunch();
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    await tick();
    expect(commandLauncher.draft.visible).toBe(true);
    expect(commandLauncher.draft.operation).toBeNull();
  });

  it("Escape hides and preserves the current submenu", async () => {
    openCommandLauncher();
    flushSync();
    result("New window").click();
    await tick();
    await key("Escape");
    expect(commandLauncher.draft.visible).toBe(false);
    expect(commandLauncher.draft.path).toEqual(["new-window"]);
    openCommandLauncher();
    flushSync();
    expect(result("Project")).toBeTruthy();
  });
});
