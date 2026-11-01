// @vitest-environment jsdom
//
// Two machine rows can resolve to one library_id: a directly registered devserver beside its gateway roster row, or one box registered twice. The deck flattens machine windows into one keyed list, so only the first claimant of the id is handed them: two rows holding the same WindowRecord objects put one window in that list twice, and each_key_duplicate takes the whole command surface down. Any root-level query reaches that list.
//
// Mounted, because the failure is a render throw in the deck itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

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
  closeComputerWindow: vi.fn(),
  connectComputer: vi.fn(),
  focusComputerWindow: vi.fn(),
  liveTerminalCountForWindow: vi.fn(),
  newTerminal: vi.fn(),
  newWorkspaceWindow: vi.fn(),
  setWindowShown: vi.fn(),
  setWorkspacePower: vi.fn(),
}));

import CommandLauncher from "./CommandLauncher.svelte";
import type { DevserverEntry, TmuxConnectionEntry, WindowRecord, WorkspaceEntry } from "../api/library";
import { library } from "../state/library.svelte";
import {
  activeCommandLauncherDraft,
  clearCommandLauncherDraft,
  closeCommandLauncher,
} from "../state/commandLauncher.svelte";
import { screen } from "../state/screen.svelte";

Element.prototype.scrollIntoView = vi.fn();

const SHARED = "lib-shared";

function ds(over: Partial<DevserverEntry> & Pick<DevserverEntry, "id">): DevserverEntry {
  return {
    url: "http://host:8000",
    host: "host",
    port: 8000,
    label: "",
    script: "",
    has_token: false,
    library_id: null,
    status: "connected",
    pending_signin: false,
    auto_hide_control: false,
    os: "linux",
    pretty_name: null,
    gateway_id: null,
    gateway_url: "",
    shared: false,
    native_trust_required: false,
    ...over,
  };
}

const sharedWindow: WindowRecord = {
  window_id: "w-shared-1",
  library_id: SHARED,
  kind: "terminal",
  title: "shared terminal",
  ordinal: 1,
  label: "shared terminal",
  workspace_path: null,
  prefix: "terminal",
  token: "token",
  persisted: true,
  connected: true,
  active_transfer: false,
  control: false,
};

/** The web chord the launcher binds; Cmd+K belongs to the browser. */
function openDeck(): void {
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
}

let target: HTMLElement;
let app: Record<string, unknown>;

function titles(): string[] {
  return [...target.querySelectorAll(".deck-result-title")].map((n) => n.textContent ?? "");
}

async function query(value: string): Promise<void> {
  const field = target.querySelector(".deck-input") as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  await tick();
}

beforeEach(() => {
  sessionStorage.clear();
  target = document.createElement("div");
  document.body.appendChild(target);
  // The same box reached twice: registered directly and again through its
  // gateway roster, so both rows carry one library_id.
  library.devservers = [
    ds({ id: "direct", label: "zeta", library_id: SHARED }),
    ds({ id: "roster", label: "beta", library_id: SHARED, gateway_id: "gw-1" }),
  ];
  library.workspaces = [];
  library.windows = [{ ...sharedWindow }];
  library.tmuxConnections = [];
  library.gateways = [];
  library.leaders = {};
  screen.current = "computers";
  screen.flips = 0;
  clearCommandLauncherDraft();
  closeCommandLauncher();
  app = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(() => {
  unmount(app);
  target.remove();
  closeCommandLauncher();
  library.devservers = [];
  library.windows = [];
  library.tmuxConnections = [];
  vi.resetAllMocks();
});

describe("Computers deck with two rows on one library", () => {
  it("renders the deck instead of going down", async () => {
    openDeck();

    expect(activeCommandLauncherDraft().visible, "the deck opened").toBe(true);
    expect(target.querySelector(".deck-input"), "the deck mounted").not.toBeNull();
    expect(titles().length, "the root action set rendered").toBeGreaterThan(0);
  });

  it("survives a root-level query, which reaches the flattened window list", async () => {
    openDeck();
    await query("shared");
    await tick();

    expect(target.querySelector(".deck-input"), "the deck survived the query").not.toBeNull();
    const shown = titles().filter((t) => t.includes("shared terminal"));
    // Assert the row is THERE before asserting it is unique: a uniqueness
    // check alone passes on an empty list, so it would go green against the
    // very render throw this test exists to catch.
    expect(shown.length, `the window is offered: ${titles()}`).toBeGreaterThan(0);
    expect(new Set(shown).size, `and offered once: ${shown}`).toBe(shown.length);
  });

  it("names plain and tmux windows of one library by the same machine", async () => {
    library.tmuxConnections = [{
      connection: "tm-1",
      library_id: SHARED,
      origin: { program: "tmux", command: "tmux -CC", local: true },
      version: "3.5",
      session: { id: "$main", name: "main" },
      windows: [],
      window_cap: 8,
      errors: [],
      control_window: "tm-control",
    } as TmuxConnectionEntry];
    library.windows = [
      { ...sharedWindow },
      { ...sharedWindow, window_id: "tm-window", tmux: { connection: "tm-1", control: false } },
    ];

    openDeck();
    const windows = [...target.querySelectorAll<HTMLButtonElement>("button.deck-result")].find(
      (button) => button.querySelector(".deck-result-title")?.textContent === "Windows",
    );
    expect(windows, "the Windows branch exists").toBeDefined();
    windows!.click();
    await tick();
    const paths = [...target.querySelectorAll(".deck-result-path")].map((node) => node.textContent);
    expect(paths).toContain("Computers › Windows › beta › Open");
    expect(paths).toContain("Computers › Windows › tmux -CC on beta (main) › Open");
  });

  it("uses the library's machine name for a workspace target", async () => {
    library.workspaces = [{
      workspace_id: "project",
      path: "/project",
      label: "Project",
      on: true,
      status: "running",
      library_id: SHARED,
      devserver_id: "direct",
      prefix: "project",
    } as WorkspaceEntry];

    openDeck();
    const turnOff = [...target.querySelectorAll<HTMLButtonElement>("button.deck-result")].find(
      (button) => button.querySelector(".deck-result-title")?.textContent === "Turn off",
    );
    expect(turnOff, "the Turn off branch exists").toBeDefined();
    turnOff!.click();
    await tick();
    const paths = [...target.querySelectorAll(".deck-result-path")].map((node) => node.textContent);
    expect(paths).toContain("Computers › Turn off › beta");
  });
});
