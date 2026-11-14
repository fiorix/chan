// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

const actions = vi.hoisted(() => ({
  canManage: vi.fn(),
  canOpen: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  connectAndOpen: vi.fn(),
  copyKey: vi.fn(),
  detach: vi.fn(),
  focus: vi.fn(),
  liveTerminalCount: vi.fn(),
  newTerminal: vi.fn(),
  newTerminalWindow: vi.fn(),
  newTmuxWindow: vi.fn(),
  newWorkspace: vi.fn(),
  open: vi.fn(),
  openTmuxWindow: vi.fn(),
  setShown: vi.fn(),
  setPower: vi.fn(),
  showCard: vi.fn(),
  theme: vi.fn(),
  turnOff: vi.fn(),
  turnOnAndOpen: vi.fn(),
  workspaceCount: vi.fn(),
  desktop: false,
  readOnly: false,
  hostOs: "linux",
}));

// The props the host hands the deck, read where a test needs what no deck
// markup states the same way before and after a redesign: the sections, the
// rail, the crumbs, and the page a row opens on Right.
const deck = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));

vi.mock("@chan/web-shared/CommandDeck.svelte", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const Deck = real.default as (anchor: unknown, props: Record<string, unknown>) => unknown;
  return {
    ...real,
    default: function RecordingDeck(anchor: unknown, props: Record<string, unknown>) {
      deck.props = props;
      return Deck(anchor, props);
    },
  };
});

vi.mock("../state/theme.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/theme.svelte")>()),
  setThemeChoice: actions.theme,
}));

vi.mock("../api/backend", async () => {
  const { mockApi } = await import("../api/mock");
  return { backend: mockApi };
});

vi.mock("../state/capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/capabilities")>()),
  surface: "devserver",
  canMutateRegistry: true,
  get hasDesktopBridge() { return actions.desktop; },
  selfManagedWindows: true,
  get readOnly() { return actions.readOnly; },
  get hostOs() { return actions.hostOs; },
}));

vi.mock("../state/computerActions", () => ({
  canManageWindow: (...args: unknown[]) => actions.canManage(...args),
  canOpenWorkspaceWindow: (...args: unknown[]) => actions.canOpen(...args),
  closeComputerWindow: actions.close,
  connectAndOpenTerminal: actions.connectAndOpen,
  connectComputer: actions.connect,
  copyGatewayPublicKey: actions.copyKey,
  detachTmux: actions.detach,
  focusComputerWindow: actions.focus,
  liveTerminalCountForWindow: actions.liveTerminalCount,
  liveTerminalCountForWorkspace: actions.workspaceCount,
  newTerminal: actions.newTerminal,
  newTmuxWindow: actions.newTmuxWindow,
  newWorkspaceTerminalWindow: actions.newTerminalWindow,
  newWorkspaceWindow: actions.newWorkspace,
  openComputerWindow: actions.open,
  openTmuxWindow: actions.openTmuxWindow,
  setWindowShown: actions.setShown,
  setWorkspacePower: actions.setPower,
  showComputerCard: actions.showCard,
  turnOffWorkspace: actions.turnOff,
  turnOnAndOpenWorkspace: actions.turnOnAndOpen,
}));

import CommandLauncher from "./CommandLauncher.svelte";
import type {
  DevserverEntry,
  GatewayEntry,
  TmuxConnectionEntry,
  WindowRecord,
  WindowSet,
  WorkspaceEntry,
} from "../api/library";
import { library, loadLibrary, stopWatching } from "../state/library.svelte";
import {
  activeCommandLauncherDraft,
  clearCommandLauncherDraft,
  clearRecentWindows,
  closeCommandLauncher,
  commandLauncher,
  openCommandLauncher,
  persistCommandLauncherDraft,
  recentWindows,
} from "../state/commandLauncher.svelte";
import { loadSessionDeckDraft, type DeckItem, type DeckScope } from "@chan/web-shared/command-deck";
import { setPrivacy } from "@chan/web-shared/privacy";
import { screen } from "../state/screen.svelte";
import { confirm } from "../state/confirm.svelte";
import { dialog, closeDialog } from "../state/dialog.svelte";
import { selection, setSelectMode } from "../state/selection.svelte";
import { themeState, type ThemeChoice } from "../state/theme.svelte";
import { backend } from "../api/backend";
import { mintWindow, resetWindowManager } from "../state/windowManager.svelte";
import { clearAllWindowAttention } from "../state/windowAttention.svelte";
import { notices, clearNotices } from "../state/notices.svelte";

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
  title: "project Window 1",
  ordinal: 1,
  label: "release checks",
  workspace_path: "/work/project",
  prefix: "ws-project",
  token: "token",
  persisted: true,
  connected: true,
  active_transfer: false,
  control: false,
  origin: "browser",
};

const terminalRecord: WindowRecord = {
  window_id: "w-terminal-2",
  library_id: "lib-local-live-shape",
  kind: "terminal",
  title: "Terminal Window 2",
  ordinal: 2,
  label: "deploy shell",
  workspace_path: null,
  prefix: "terminal",
  token: "token",
  persisted: true,
  connected: true,
  active_transfer: false,
  control: true,
  origin: "browser",
};

const alpha: DevserverEntry = {
  id: "ds-a",
  url: "http://alpha:8000",
  host: "alpha",
  port: 8000,
  label: "alpha",
  script: "",
  has_token: true,
  library_id: "lib-a",
  status: "connected",
  pending_signin: false,
  auto_hide_control: false,
  os: "",
  pretty_name: null,
  gateway_id: null,
  gateway_url: "",
  shared: false,
  native_trust_required: false,
};

const home: GatewayEntry = {
  id: "gw-home",
  url: "https://gateway.example",
  label: "home",
  enabled: true,
  status: "disconnected",
  pending_signin: false,
  devserver_count: 0,
  last_error: null,
  wireguard: null,
  wireguard_public_key: "c2VjcmV0LXB1YmxpYy1rZXk=",
};

const WINDOW_1 = "Window 1 [release checks]";
const WINDOW_1_PAGE = "window:lib-local-live-shape:w-project-1";
const PROJECT_PAGE = "workspace:local:ws-project";

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

/** The rows the host hands the deck. */
function items(): DeckItem[] {
  return deck.props!.items as DeckItem[];
}

function item(title: string): DeckItem {
  const found = items().filter((candidate) => candidate.title === title);
  if (found.length !== 1) {
    throw new Error(`${found.length} rows titled ${title}; listed: ${outline().join(" | ")}`);
  }
  return found[0];
}

/** The list as `section: title` lines. */
function outline(): string[] {
  return items().map((candidate) => `${candidate.section ?? "-"}: ${candidate.title}`);
}

/** Right on a row: the deck asks the host for the row's page. */
async function expand(title: string): Promise<void> {
  (deck.props!.onExpand as (row: DeckItem) => void)(item(title));
  await tick();
}

async function filterBy(scope: string): Promise<void> {
  (deck.props!.onScope as (id: string) => void)(scope);
  await tick();
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

function decision(label: string): HTMLButtonElement {
  const button = [...target.querySelectorAll<HTMLButtonElement>(".deck-decisions button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`missing ${label} decision`);
  return button;
}

function closeDecision(): HTMLButtonElement {
  return decision("Close");
}

function card(): string {
  return target.querySelector(".deck-operation")?.textContent ?? "";
}

function open(): void {
  openCommandLauncher();
  flushSync();
}

/** Mount again on another surface: the adapter reads the surface as it builds
 * its model. */
function remount(surface: { desktop: boolean; readOnly?: boolean }): void {
  unmount(app);
  actions.desktop = surface.desktop;
  actions.readOnly = surface.readOnly === true;
  app = mount(CommandLauncher, { target }) as Record<string, unknown>;
}

/** The deck open on the workspace window's own page. */
async function openWindowPage(): Promise<void> {
  open();
  await expand(WINDOW_1);
}

beforeEach(() => {
  actions.desktop = false;
  actions.readOnly = false;
  actions.hostOs = "linux";
  themeState.theme = "dark";
  actions.canManage.mockReturnValue(true);
  actions.canOpen.mockReturnValue(true);
  sessionStorage.clear();
  clearRecentWindows();
  clearNotices();
  resetWindowManager();
  // A feed frame flags the windows this page holds no handle to.
  clearAllWindowAttention();
  library.error = null;
  target = document.createElement("div");
  document.body.appendChild(target);
  library.workspaces = [{ ...workspace }];
  library.windows = [{ ...windowRecord }, { ...terminalRecord }];
  library.devservers = [];
  library.gateways = [];
  library.leaders = {};
  library.tmuxConnections = [];
  // The lists above are the library as read.
  library.loaded = true;
  screen.current = "computers";
  screen.flips = 0;
  clearCommandLauncherDraft();
  closeCommandLauncher();
  app = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(async () => {
  unmount(app);
  target.remove();
  stopWatching();
  closeCommandLauncher();
  closeDialog();
  setSelectMode(false);
  await setPrivacy({ enabled: false });
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("Computers command deck", () => {
  function windowKey(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      key: "k", code: "KeyK", bubbles: true, cancelable: true, ...init,
    });
    window.dispatchEvent(event);
    flushSync();
    return event;
  }

  it.each([
    ["macos", { metaKey: true }, { metaKey: true, shiftKey: true }],
    ["linux", { ctrlKey: true, altKey: true }, { ctrlKey: true, altKey: true, shiftKey: true }],
  ] as const)("opens only from the plain launcher chord on the %s desktop", (os, plain, shifted) => {
    actions.desktop = true;
    actions.hostOs = os;
    const ignored = windowKey({ ...shifted, key: "K" });
    expect(ignored.defaultPrevented).toBe(false);
    expect(activeCommandLauncherDraft().visible).toBe(false);
    expect(target.querySelector('[role="dialog"]')).toBeNull();

    const opened = windowKey(plain);
    expect(opened.defaultPrevented).toBe(true);
    expect(activeCommandLauncherDraft().visible).toBe(true);
    expect(activeCommandLauncherDraft().scope).toBeNull();
  });

  it("closes from the chord with the keyboard in the deck, and opens from it again", async () => {
    windowKey({ ctrlKey: true, altKey: true });
    expect(activeCommandLauncherDraft().visible).toBe(true);
    await query("deploy");

    // A key pressed in the deck is dispatched on its query, not the window.
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    const chord = new KeyboardEvent("keydown", {
      key: "k", code: "KeyK", ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    });
    input().dispatchEvent(chord);
    flushSync();
    window.removeEventListener("keydown", seen);
    expect(activeCommandLauncherDraft().visible, "the chord toggles").toBe(false);
    expect(chord.defaultPrevented).toBe(true);
    expect(seen, "the page behind the deck sees no key").not.toHaveBeenCalled();
    expect(activeCommandLauncherDraft().query, "a dismissal keeps what was typed").toBe("deploy");

    windowKey({ ctrlKey: true, altKey: true });
    expect(activeCommandLauncherDraft().visible).toBe(true);
  });

  it("opens from the chord on the Gateways screen as on Computers", () => {
    screen.current = "gateways";
    const opened = windowKey({ ctrlKey: true, altKey: true });
    expect(opened.defaultPrevented).toBe(true);
    expect(activeCommandLauncherDraft().visible).toBe(true);
    expect(target.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("opens from the web chord on the library, objects first", () => {
    windowKey({ ctrlKey: true, altKey: true });
    expect(activeCommandLauncherDraft().visible).toBe(true);
    // One machine and no registry of others: its workspaces and windows
    // stand at the root, with no gateways and no desktop commands. The
    // screen's own Select mode closes the list.
    expect(outline()).toEqual([
      "Workspaces: Project",
      "Windows: Control terminal",
      `Windows: ${WINDOW_1}`,
      "New: New terminal",
      "New: New workspace",
      "Computers screen: Select",
    ]);
    expect(titles()).toEqual(items().map((row) => row.title));
    expect((deck.props!.scopes as DeckScope[]).map((scope) => scope.label)).toEqual([
      "Windows",
      "Workspaces",
      "Computers",
    ]);
  });

  it("lists machines, gateways and the desktop's own commands on the desktop", () => {
    library.devservers = [{ ...alpha }, { ...alpha, id: "ds-b", label: "beta", library_id: "lib-b", status: "disconnected" }];
    library.gateways = [{ ...home }];
    remount({ desktop: true });
    open();
    expect(outline()).toEqual([
      "Needs attention: beta",
      "Computers: This machine",
      "Computers: alpha",
      "Gateways: home",
      "New: New terminal",
      "New: New workspace",
      "New: Add devserver",
      "New: Add gateway",
      "Chan Desktop: Theme",
      "Chan Desktop: Select",
      "Chan Desktop: Quit",
    ]);
    expect((deck.props!.scopes as DeckScope[]).map((scope) => scope.label)).toEqual([
      "Windows",
      "Workspaces",
      "Computers",
      "Gateways",
    ]);
  });

  it("does not expose the Desktop commands on a devserver", async () => {
    library.gateways = [{ ...home }];
    open();
    await query("theme");
    expect(titles()).toEqual([]);
    await query("");
    const listed = items().map((row) => row.title);
    for (const title of ["Theme", "Quit", "Add devserver", "Add gateway", "home"]) {
      expect(listed).not.toContain(title);
    }
  });

  it("enters select mode from Select on a devserver's page, as its top bar does", async () => {
    open();
    expect([item("Select").section, item("Select").value]).toEqual(["Computers screen", "off"]);
    result("Select").click();
    await flushPromises();
    expect(selection.selectMode).toBe(true);
    expect(activeCommandLauncherDraft().visible).toBe(false);
    open();
    expect(item("Select").value).toBe("on");
    await query("select");
    expect(titles()).toContain("Select");
  });

  it("offers no Select on a surface whose top bar has no such button", () => {
    remount({ desktop: false, readOnly: true });
    open();
    expect(items().map((row) => row.title)).not.toContain("Select");
    expect(outline().at(-1)).toBe("New: New workspace");
  });

  it("focuses a window from its own row", async () => {
    open();
    result(WINDOW_1).click();
    await settle();
    expect(actions.focus).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ window_id: "w-project-1" }),
    );
    expect(activeCommandLauncherDraft().visible).toBe(false);
  });

  it("deep-searches a control terminal note and focuses that exact record", async () => {
    open();
    await query("focus deploy shell");
    // Typed search reaches the action itself, titled with its window.
    result("Focus Control terminal").click();
    await settle();
    expect(actions.focus).toHaveBeenCalledWith(expect.objectContaining({ window_id: "w-terminal-2" }));
  });

  it("opens a window's page with its own actions, in the cards' words", async () => {
    await openWindowPage();
    expect(activeCommandLauncherDraft().path).toEqual([WINDOW_1_PAGE]);
    expect(deck.props!.crumbs).toEqual([WINDOW_1]);
    expect(titles()).toEqual(["Focus window", "Hide window", "Close window"]);

    result("Hide window").click();
    await settle();
    expect(actions.setShown).toHaveBeenCalledWith(
      expect.objectContaining({ window_id: "w-project-1" }),
      false,
    );
  });

  it("offers Show on a hidden window where a visible one offers Hide", async () => {
    library.windows = [{ ...windowRecord, hidden: true }];
    await openWindowPage();
    // Show here is a plain visibility flip, distinct from Focus, so a hidden
    // window keeps both.
    expect(titles()).toEqual(["Focus window", "Show window", "Close window"]);
  });

  it.each([true, false])("browser deck offers explicit Open and no Focus for hidden=%s native rows", async (hidden) => {
    library.windows = [{ ...windowRecord, origin: "native", hidden }];
    await openWindowPage();
    expect(titles()).toEqual(
      hidden
        ? ["Show window", "Open window", "Close window"]
        : ["Open window", "Hide window", "Close window"],
    );
    result("Open window").click();
    await settle();
    expect(actions.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ window_id: "w-project-1", origin: "native" }));
    expect(actions.focus).not.toHaveBeenCalled();
    expect(actions.setShown).not.toHaveBeenCalled();
  });

  it("runs a native row's first action from the row itself in a browser", async () => {
    library.windows = [{ ...windowRecord, origin: "native" }];
    open();
    result(WINDOW_1).click();
    await settle();
    expect(actions.open).toHaveBeenCalledOnce();
    expect(actions.focus).not.toHaveBeenCalled();
  });

  it("desktop-bridge deck keeps native Focus", async () => {
    library.windows = [{ ...windowRecord, origin: "native" }];
    remount({ desktop: true });
    await openWindowPage();
    expect(titles()).toContain("Focus window");
    result("Focus window").click();
    await settle();
    expect(actions.focus).toHaveBeenCalledOnce();
  });

  it("lists a window this page may not act on, disabled, with the card's reason", async () => {
    actions.canManage.mockReturnValue(false);
    library.windows = [{ ...windowRecord, label: "held elsewhere" }];
    open();
    const held = item("Window 1 [held elsewhere]");
    expect([held.disabled, held.subtitle]).toEqual([
      true,
      "Only the session leader can show or hide this window",
    ]);
    result("Window 1 [held elsewhere]").click();
    await settle();
    expect(actions.focus).not.toHaveBeenCalled();
    expect(actions.open).not.toHaveBeenCalled();
  });

  it("ArrowLeft goes back one page at a time", async () => {
    open();
    await expand("Project");
    expect(activeCommandLauncherDraft().path).toEqual([PROJECT_PAGE]);
    await expand(WINDOW_1);
    expect(activeCommandLauncherDraft().path).toEqual([PROJECT_PAGE, WINDOW_1_PAGE]);
    expect(deck.props!.crumbs).toEqual(["Project", WINDOW_1]);
    await key("ArrowLeft");
    expect(activeCommandLauncherDraft().path).toEqual([PROJECT_PAGE]);
    expect(result("Turn off")).toBeTruthy();
    await key("ArrowLeft");
    expect(activeCommandLauncherDraft().path).toEqual([]);
    expect(result("New terminal")).toBeTruthy();
  });

  it("falls back to the list when that window closes elsewhere", async () => {
    await openWindowPage();
    // The feed is pushed, so the window can go while its actions are on screen.
    library.windows = [{ ...terminalRecord }];
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual([]);
    expect(result("Control terminal")).toBeTruthy();
  });

  it.each([
    [3, "3 terminal sessions in this window will stop."],
    [0, "This window will close."],
    [null, "Open sessions in this window may stop."],
  ] as const)("uses the informed Close message for count %s", async (count, message) => {
    actions.liveTerminalCount.mockResolvedValue(count);
    await openWindowPage();
    result("Close window").click();
    await flushPromises();
    expect(card()).toContain(`Close ${WINDOW_1}?`);
    expect(card()).toContain(message);
    expect(actions.liveTerminalCount).toHaveBeenCalledOnce();
    expect(actions.close).not.toHaveBeenCalled();
    closeDecision().click();
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
    await openWindowPage();
    result("Close window").click();
    await flushPromises();
    expect(card()).toContain("This window will close.");

    closeDecision().click();
    await flushPromises();
    expect(actions.close).not.toHaveBeenCalled();
    expect(card()).toContain("2 terminal sessions in this window will stop.");

    closeDecision().click();
    await flushPromises();
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(3);
  });

  it("re-confirms a restored Close card before closing", async () => {
    actions.liveTerminalCount.mockResolvedValue(1);
    await openWindowPage();
    const draft = activeCommandLauncherDraft();
    draft.operation = {
      kind: "confirm",
      itemId: "computers:close:lib-local-live-shape:w-project-1",
      title: `Close ${WINDOW_1}?`,
      message: "This window will close.",
      actionLabel: "Close",
      danger: true,
      selected: "cancel",
    };
    await tick();

    closeDecision().click();
    await flushPromises();
    expect(actions.close).not.toHaveBeenCalled();
    expect(card()).toContain("1 terminal session in this window will stop.");

    closeDecision().click();
    await flushPromises();
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(2);
  });

  it("does not let a dropped Close preparation replace the painted count", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    actions.liveTerminalCount
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockResolvedValue(1);

    await openWindowPage();
    result("Close window").click();
    await tick();
    // Dismiss the card while it is still checking, then ask again.
    await key("Escape");
    result("Close window").click();
    await tick();

    second.resolve(2);
    await flushPromises();
    expect(card()).toContain("2 terminal sessions in this window will stop.");
    first.resolve(1);
    await flushPromises();
    expect(card()).toContain("2 terminal sessions in this window will stop.");

    closeDecision().click();
    await flushPromises();

    expect(actions.close).not.toHaveBeenCalled();
    expect(card()).toContain("1 terminal session in this window will stop.");
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(3);
  });

  it("does not close a window on a reading a later card replaced", async () => {
    const recheck = deferred<unknown>();
    const reopened = deferred<unknown>();
    actions.liveTerminalCount
      .mockResolvedValueOnce(5)
      .mockImplementationOnce(() => recheck.promise)
      .mockImplementationOnce(() => reopened.promise);

    await openWindowPage();
    result("Close window").click();
    await flushPromises();
    expect(card()).toContain("5 terminal sessions in this window will stop.");

    // Confirm, dismiss the working card inside the recheck's latency, then ask
    // again: the second card is prepared while the first recheck is still out.
    closeDecision().click();
    await tick();
    await key("Escape");
    result("Close window").click();
    await tick();

    reopened.resolve(7);
    await flushPromises();
    expect(card()).toContain("7 terminal sessions in this window will stop.");

    // The overtaken recheck still matches its own older reading. It must not
    // close the window under the card that now names a different number.
    recheck.resolve(5);
    await flushPromises();
    expect(actions.close).not.toHaveBeenCalled();
    expect(card()).toContain("7 terminal sessions in this window will stop.");
  });

  it("forgets a Close reading when its window leaves the roster", async () => {
    actions.liveTerminalCount.mockResolvedValue(2);
    await openWindowPage();
    result("Close window").click();
    await flushPromises();
    expect(card()).toContain("2 terminal sessions in this window will stop.");

    // The window goes and comes back while this always-mounted deck watches.
    library.windows = [{ ...terminalRecord }];
    await tick();
    library.windows = [{ ...windowRecord }, { ...terminalRecord }];
    await tick();

    await expand(WINDOW_1);
    const draft = activeCommandLauncherDraft();
    draft.operation = {
      kind: "confirm",
      itemId: "computers:close:lib-local-live-shape:w-project-1",
      title: `Close ${WINDOW_1}?`,
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
    expect(card()).toContain("2 terminal sessions in this window will stop.");
    expect(actions.liveTerminalCount).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "two"])("uses the generic Close message for payload %s", async (count) => {
    actions.liveTerminalCount.mockResolvedValueOnce(count);
    await openWindowPage();
    result("Close window").click();
    await flushPromises();
    expect(card()).toContain("Open sessions in this window may stop.");
  });

  it("uses the generic Close message when the count request fails", async () => {
    actions.liveTerminalCount.mockRejectedValueOnce(new Error("HTTP 503"));
    await openWindowPage();
    result("Close window").click();
    await flushPromises();
    expect(card()).toContain("Open sessions in this window may stop.");
  });

  it("keeps the control-terminal Close warning without querying a count", async () => {
    library.windows = [{ ...terminalRecord }];
    open();
    await expand("Control terminal");
    result("Close window").click();
    await tick();
    expect(card()).toContain("This stops the control terminal and its connection script.");
    closeDecision().click();
    await flushPromises();
    expect(actions.close).toHaveBeenCalledOnce();
    expect(actions.close).toHaveBeenCalledWith(
      expect.objectContaining({ window_id: "w-terminal-2" }),
    );
    expect(actions.liveTerminalCount).not.toHaveBeenCalled();
    expect(target.querySelector(".deck-decisions")).toBeNull();
  });

  it("opens a new window of a running workspace from its own row", async () => {
    open();
    result("Project").click();
    await settle();
    expect(actions.newWorkspace).toHaveBeenCalledWith(expect.objectContaining({ path: "/work/project" }));
  });

  it("opens a workspace's page with its actions and its windows", async () => {
    open();
    await expand("Project");
    expect(outline()).toEqual([
      "Actions: New window",
      "Actions: New terminal window",
      "Actions: Turn off",
      `Windows: ${WINDOW_1}`,
    ]);
    result("New terminal window").click();
    await settle();
    expect(actions.newTerminalWindow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspace_id: "ws-project" }),
    );
  });

  it("dismisses a launch as soon as the new terminal succeeds", async () => {
    let finishLaunch!: () => void;
    actions.newTerminal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLaunch = resolve;
        }),
    );
    open();
    await query("ter");
    // New terminal is a leaf: this machine is the one place it can open.
    result("New terminal").click();
    await tick();
    expect(actions.newTerminal).toHaveBeenCalledExactlyOnceWith();
    expect(activeCommandLauncherDraft().visible).toBe(true);
    finishLaunch();
    // Flush the nested action -> provider -> shared-deck promise chain without
    // advancing the 260 ms success timer this regression is guarding against.
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    await tick();

    expect(activeCommandLauncherDraft().visible).toBe(false);
    expect(target.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each<[string, () => Promise<void>]>([
    ["a click on the scrim", async () => {
      (target.querySelector(".deck-backdrop") as HTMLButtonElement).click();
    }],
    ["the page hiding the deck", async () => closeCommandLauncher()],
    ["Escape on its card and Escape again", async () => {
      await key("Escape");
      await key("Escape");
    }],
  ])("leaves the deck opened after a launch dismissed by %s alone when the launch succeeds", async (_how, dismiss) => {
    let finishLaunch!: () => void;
    actions.newTerminal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishLaunch = resolve;
        }),
    );
    open();
    await query("ter");
    result("New terminal").click();
    await tick();
    expect(card(), "the launch holds the card").toContain("Working");
    await dismiss();
    flushSync();
    expect(activeCommandLauncherDraft().visible).toBe(false);

    open();
    await query("project");
    finishLaunch();
    await settle();
    expect(activeCommandLauncherDraft().visible, "the deck opened since stays open").toBe(true);
    expect(activeCommandLauncherDraft().query, "with what was typed into it").toBe("project");
    expect(input().value).toBe("project");
    expect(card(), "and no card of the earlier launch").toBe("");
  });

  it("clears the query of a command that ran", async () => {
    open();
    await query("deploy shell focus");
    result("Focus Control terminal").click();
    await settle();
    const closed = activeCommandLauncherDraft();
    expect([closed.visible, closed.query, closed.path, closed.operation]).toEqual([
      false,
      "",
      [],
      null,
    ]);
    open();
    await tick();
    expect(input().value).toBe("");
    expect(outline()[0]).toBe("Recent windows: Control terminal");
  });

  it("clears the query of a command that opens a dialog as it starts", async () => {
    open();
    await query("new workspace");
    result("New workspace").click();
    await settle();
    expect(dialog.open).toBe(true);
    const closed = activeCommandLauncherDraft();
    expect([closed.visible, closed.query]).toEqual([false, ""]);
  });

  it("keeps the query of a deck that was dismissed", async () => {
    open();
    await query("deploy shell");
    await key("Escape");
    expect(activeCommandLauncherDraft().visible).toBe(false);
    open();
    await tick();
    expect(input().value).toBe("deploy shell");
  });

  it("carries no query out of a page into the next opening", async () => {
    open();
    await query("release");
    await expand(WINDOW_1);
    result("Focus window").click();
    await settle();
    open();
    expect(activeCommandLauncherDraft().query).toBe("");
    expect(outline()[0]).toBe(`Recent windows: ${WINDOW_1}`);
  });

  it("reopens at the root with the last query kept", async () => {
    open();
    await filterBy("windows");
    await expand(WINDOW_1);
    await query("close");
    expect(activeCommandLauncherDraft().path).toEqual([WINDOW_1_PAGE]);
    closeCommandLauncher();
    flushSync();
    open();
    const draft = activeCommandLauncherDraft();
    expect([draft.path, draft.scope, draft.query]).toEqual([[], null, "close"]);
    expect(input().value).toBe("close");
  });

  /// Mount the deck again as a reload does: over the saved draft and a
  /// library nothing has read yet. The registries answer when `listed`
  /// resolves and the window feed when `frame` is called.
  function reload(): {
    listed: { resolve: (rows: WorkspaceEntry[]) => void };
    frame: (set: WindowSet) => void;
  } {
    persistCommandLauncherDraft();
    unmount(app);
    stopWatching();
    library.workspaces = [];
    library.windows = [];
    commandLauncher.draft = loadSessionDeckDraft("chan.command-launcher.v1:contextual");
    const listed = deferred<WorkspaceEntry[]>();
    let onSet: ((set: WindowSet) => void) | null = null;
    vi.spyOn(backend, "listWorkspaces").mockImplementation(() => listed.promise);
    vi.spyOn(backend, "listDevservers").mockResolvedValue([]);
    vi.spyOn(backend, "listGateways").mockResolvedValue([]);
    vi.spyOn(backend, "watchWindows").mockImplementation((subscriber) => {
      onSet = subscriber;
      return () => {};
    });
    app = mount(CommandLauncher, { target }) as Record<string, unknown>;
    flushSync();
    return { listed, frame: (set) => onSet!(set) };
  }

  it("restores an open deck where it stood across a reload, once the library has been read", async () => {
    await openWindowPage();
    const path = (): string[] => activeCommandLauncherDraft().path;
    const { listed, frame } = reload();
    expect(path(), "a library nothing has read says nothing about the page").toEqual([WINDOW_1_PAGE]);

    // The app loads the library once it has mounted, after the deck.
    const loading = loadLibrary();
    flushSync();
    expect(path()).toEqual([WINDOW_1_PAGE]);
    listed.resolve([{ ...workspace }]);
    await loading;
    flushSync();
    expect(path(), "the registries do not list the windows").toEqual([WINDOW_1_PAGE]);
    frame({ windows: [{ ...windowRecord }, { ...terminalRecord }] });
    await flushPromises();
    expect(path()).toEqual([WINDOW_1_PAGE]);
    expect(result("Close window")).toBeTruthy();
  });

  it("leaves a restored page whose window is gone, once the library has been read", async () => {
    await openWindowPage();
    const { listed, frame } = reload();
    const loading = loadLibrary();
    listed.resolve([{ ...workspace }]);
    await loading;
    frame({ windows: [{ ...terminalRecord }] });
    await flushPromises();
    expect(activeCommandLauncherDraft().path).toEqual([]);
    expect(result("Control terminal")).toBeTruthy();
  });

  it("leaves the query that found an object behind when it enters its page", async () => {
    open();
    await query("release");
    await expand(WINDOW_1);
    expect(activeCommandLauncherDraft().query).toBe("");
    expect(titles()).toEqual(["Focus window", "Hide window", "Close window"]);
  });
});

describe("keys through the deck", () => {
  it("Right opens the page of the row Enter would run, and runs nothing", async () => {
    open();
    await tick();
    // The first row is selected on open: the workspace.
    await key("ArrowRight");
    expect(activeCommandLauncherDraft().path).toEqual([PROJECT_PAGE]);
    expect(actions.newWorkspace).not.toHaveBeenCalled();
    // On its page the first row is an action, which Right leaves alone.
    await key("ArrowRight");
    await flushPromises();
    expect(activeCommandLauncherDraft().path).toEqual([PROJECT_PAGE]);
    expect(actions.newWorkspace).not.toHaveBeenCalled();
    await key("Enter");
    await flushPromises();
    expect(actions.newWorkspace).toHaveBeenCalledOnce();
  });

  it("Tab cycles the type filters and comes back to the whole library", async () => {
    open();
    await tick();
    const seen: (string | null)[] = [];
    for (let press = 0; press < 4; press += 1) {
      await key("Tab");
      seen.push(activeCommandLauncherDraft().scope);
    }
    expect(seen).toEqual(["windows", "workspaces", "computers", null]);
    expect(outline()[0]).toBe("Workspaces: Project");
  });

  it("Escape leaves a page before it closes the deck", async () => {
    await openWindowPage();
    await key("Escape");
    expect(activeCommandLauncherDraft().path).toEqual([]);
    expect(activeCommandLauncherDraft().visible).toBe(true);
    await key("Escape");
    expect(activeCommandLauncherDraft().visible).toBe(false);
  });

  it("Backspace on an empty query drops the filter", async () => {
    open();
    await filterBy("windows");
    await key("Backspace");
    expect(activeCommandLauncherDraft().scope).toBeNull();
    expect(activeCommandLauncherDraft().visible).toBe(true);
  });
});

describe("the type filter", () => {
  it("narrows the list to one type and names it in the placeholder", async () => {
    open();
    await filterBy("workspaces");
    expect(outline()).toEqual(["This machine: Project", "New: New workspace"]);
    expect(deck.props!.placeholder).toBe("Workspaces");
    await filterBy("windows");
    expect(outline()).toEqual([
      "This machine: Control terminal",
      `This machine: ${WINDOW_1}`,
      "New: New terminal",
    ]);
    (deck.props!.onClearScope as () => void)();
    await tick();
    expect(outline()[0]).toBe("Workspaces: Project");
  });

  it("keeps the filter's name ahead of a page's in the crumbs", async () => {
    open();
    await filterBy("windows");
    await expand(WINDOW_1);
    expect(deck.props!.crumbs).toEqual(["Windows", WINDOW_1]);
  });
});

describe("workspace power", () => {
  it("asks once on the deck's card with the live count and raises no dialog", async () => {
    actions.workspaceCount.mockResolvedValue(2);
    actions.turnOff.mockResolvedValueOnce(2).mockResolvedValueOnce(null);
    open();
    await expand("Project");
    result("Turn off").click();
    await flushPromises();
    expect(card()).toContain("Turn off Project?");
    expect(card()).toContain("2 terminal sessions in this workspace will stop.");
    expect(actions.workspaceCount).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspace_id: "ws-project" }),
      [expect.objectContaining({ window_id: "w-project-1" })],
    );
    expect(actions.turnOff).not.toHaveBeenCalled();

    decision("Turn off").click();
    await flushPromises();
    expect(actions.turnOff.mock.calls.map((call) => call[1])).toEqual([false, true]);
    expect(target.querySelector(".deck-decisions"), "no second question").toBeNull();
    expect(confirm.open, "the dialog the cards raise stays closed").toBe(false);
    expect(actions.setPower).not.toHaveBeenCalled();
  });

  it("asks again on the card when the server's count is not the one it named", async () => {
    actions.workspaceCount.mockResolvedValue(0);
    actions.turnOff.mockResolvedValueOnce(3).mockResolvedValueOnce(3).mockResolvedValueOnce(null);
    open();
    await expand("Project");
    result("Turn off").click();
    await flushPromises();
    expect(card()).toContain("This workspace will turn off.");
    decision("Turn off").click();
    await flushPromises();
    expect(card()).toContain("3 terminal sessions in this workspace will stop.");
    expect(actions.turnOff).toHaveBeenCalledExactlyOnceWith(expect.anything(), false);
    expect(confirm.open).toBe(false);
    decision("Turn off").click();
    await flushPromises();
    expect(actions.turnOff).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it("turns an off workspace on and opens it from its own row", async () => {
    library.workspaces = [{ ...workspace, on: false, status: "stopped" }];
    library.windows = [];
    open();
    expect(item("Project").value).toBe("off");
    result("Project").click();
    await settle();
    expect(actions.turnOnAndOpen).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspace_id: "ws-project" }),
    );
    expect(actions.newWorkspace).not.toHaveBeenCalled();
  });

  it("offers turn on and turn off only on workspaces this process may act on", async () => {
    library.windows = [];
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
    ];
    open();
    const power = async (name: string, id: string): Promise<[string, boolean | undefined, string | undefined]> => {
      activeCommandLauncherDraft().path = [`workspace:local:${id}`];
      await tick();
      const row = items().find((candidate) => candidate.title === "Turn on" || candidate.title === "Turn off")!;
      return [`${name}: ${row.title}`, row.disabled, row.disabled ? row.subtitle : undefined];
    };
    expect(await power("Idle", "ws-off")).toEqual(["Idle: Turn on", undefined, undefined]);
    expect(await power("Held", "ws-held")).toEqual([
      "Held: Turn on",
      true,
      "Workspace is open in another Chan process",
    ]);
    expect(await power("Unread", "ws-unread")).toEqual([
      "Unread: Turn on",
      true,
      "Could not read this workspace's lock state",
    ]);
    expect(await power("Up", "ws-up")).toEqual(["Up: Turn off", undefined, undefined]);
  });

  it("shows New window disabled with the leader's reason, and opens the page from the row", async () => {
    actions.canOpen.mockReturnValue(false);
    // The mocked gate is not reactive state: build the model again.
    remount({ desktop: false });
    open();
    const row = item("Project");
    expect([row.kind, row.disabled]).toEqual(["branch", undefined]);
    result("Project").click();
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual([PROJECT_PAGE]);
    expect([item("New window").disabled, item("New window").subtitle]).toEqual([
      true,
      "The session leader manages this workspace's windows",
    ]);
    expect(actions.newWorkspace).not.toHaveBeenCalled();
  });
});

describe("recent windows", () => {
  it("lists the windows the deck acted on first, most recent first", async () => {
    open();
    result(WINDOW_1).click();
    await settle();
    open();
    result("Control terminal").click();
    await settle();
    expect(recentWindows.keys).toEqual([
      "lib-local-live-shape:w-terminal-2",
      "lib-local-live-shape:w-project-1",
    ]);
    open();
    expect(outline().slice(0, 3)).toEqual([
      "Recent windows: Control terminal",
      `Recent windows: ${WINDOW_1}`,
      "Workspaces: Project",
    ]);
    expect(titles().filter((title) => title === WINDOW_1), "each window is listed once").toHaveLength(1);
  });

  it("counts a window that arrives after the deck asked for it", async () => {
    open();
    result("New terminal").click();
    await settle();
    library.windows = [
      ...library.windows,
      { ...terminalRecord, window_id: "w-terminal-9", ordinal: 9, label: "", control: false },
    ];
    await tick();
    expect(recentWindows.keys).toEqual(["lib-local-live-shape:w-terminal-9"]);
  });

  it("does not count a window that arrives unasked", async () => {
    open();
    library.windows = [
      ...library.windows,
      { ...terminalRecord, window_id: "w-terminal-9", ordinal: 9, label: "", control: false },
    ];
    await tick();
    expect(recentWindows.keys).toEqual([]);
  });
});

describe("the desktop's library", () => {
  beforeEach(() => {
    library.devservers = [
      { ...alpha },
      { ...alpha, id: "ds-b", label: "beta", library_id: "lib-b", status: "disconnected" },
    ];
    library.gateways = [{ ...home }];
    remount({ desktop: true });
  });

  it("opens a machine's page from its row and runs the cards' actions", async () => {
    open();
    result("alpha").click();
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual(["machine:ds-a"]);
    expect(titles()).toEqual(["New terminal", "Disconnect", "Edit config", "Show on Computers screen"]);
    result("New terminal").click();
    await settle();
    expect(actions.newTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "ds-a" }));
  });

  it("opens the config form from Edit config and leaves the deck", async () => {
    open();
    result("alpha").click();
    await tick();
    result("Edit config").click();
    await flushPromises();
    expect(dialog.open).toBe(true);
    expect(dialog.editing).toMatchObject({ id: "ds-a" });
    expect(activeCommandLauncherDraft().visible).toBe(false);
  });

  it("connects a disconnected devserver, or connects and opens its terminal", async () => {
    open();
    result("beta").click();
    await tick();
    expect(titles()).toEqual(["Connect", "Connect and open", "Edit config", "Show on Computers screen"]);
    result("Connect and open").click();
    await settle();
    expect(actions.connectAndOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "ds-b" }));
    open();
    await query("connect beta");
    result("Connect beta").click();
    await settle();
    expect(actions.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "ds-b" }));
  });

  it("keeps the Disconnect card", async () => {
    const disconnect = vi.spyOn(backend, "disconnectDevserver").mockResolvedValue(undefined);
    open();
    result("alpha").click();
    await tick();
    result("Disconnect").click();
    await tick();
    expect(card()).toContain("Disconnect alpha?");
    expect(card()).toContain("Its Chan windows will close locally. The remote computer keeps running.");
    expect(disconnect).not.toHaveBeenCalled();
    decision("Disconnect").click();
    await flushPromises();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith("ds-a");
  });

  it("turns the Computers screen to a machine's card from the Gateways screen", async () => {
    screen.current = "gateways";
    open();
    await query("show alpha");
    result("Show alpha on Computers screen").click();
    await flushPromises();
    expect(actions.showCard).toHaveBeenCalledExactlyOnceWith("ds-a");
    expect(activeCommandLauncherDraft().visible).toBe(false);
  });

  it("reaches a gateway's actions", async () => {
    const connect = vi.spyOn(backend, "connectGateway").mockResolvedValue(undefined);
    open();
    result("home").click();
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual(["gateway:gw-home"]);
    expect(titles()).toEqual(["Connect", "Rename", "Copy WireGuard public key"]);
    result("Copy WireGuard public key").click();
    await settle();
    expect(actions.copyKey).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "gw-home" }));
    open();
    await query("connect gateway");
    result("Connect gateway home").click();
    await flushPromises();
    expect(connect).toHaveBeenCalledExactlyOnceWith("gw-home");
  });

  it("opens the rename form of a gateway", async () => {
    open();
    await query("rename home");
    result("Rename gateway home").click();
    await flushPromises();
    expect(dialog.open).toBe(true);
    expect(dialog.editingGateway).toMatchObject({ id: "gw-home" });
  });

  it.each([
    ["New workspace", "local"],
    ["Add devserver", "devserver"],
    ["Add gateway", "gateway"],
  ])("opens the form behind %s", async (title, choice) => {
    open();
    result(title).click();
    await flushPromises();
    expect([dialog.open, dialog.choice, dialog.editing, dialog.editingGateway]).toEqual([
      true,
      choice,
      null,
      null,
    ]);
    expect(activeCommandLauncherDraft().visible).toBe(false);
  });

  it("lists the themes under Theme, checks the current one, and switches in place", async () => {
    actions.theme.mockImplementation((choice: ThemeChoice) => {
      themeState.choice = choice;
    });
    open();
    expect([item("Theme").kind, item("Theme").value]).toEqual(["choice", "Dark"]);
    result("Theme").click();
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual(["app:theme"]);
    expect(deck.props!.crumbs).toEqual(["Theme"]);
    const themes = (): unknown[] => items().map((row) => [row.title, row.checked]);
    expect(themes()).toEqual([["System", false], ["Light", false], ["Dark", true]]);

    result("Light").click();
    await flushPromises();
    expect(actions.theme).toHaveBeenCalledExactlyOnceWith("light");
    expect(activeCommandLauncherDraft().visible, "the deck stays on the themes").toBe(true);
    expect(activeCommandLauncherDraft().path).toEqual(["app:theme"]);
    expect(target.querySelector(".deck-operation"), "no card for a change in place").toBeNull();
    expect(themes()).toEqual([["System", false], ["Light", true], ["Dark", false]]);

    await key("Escape");
    expect(activeCommandLauncherDraft().path).toEqual([]);
    expect(activeCommandLauncherDraft().visible).toBe(true);
    expect(item("Theme").value).toBe("Light");
  });

  it("offers System first, and names the choice rather than the theme it resolves to", async () => {
    actions.theme.mockImplementation((choice: ThemeChoice) => {
      themeState.choice = choice;
    });
    open();
    result("Theme").click();
    await tick();
    result("System").click();
    await flushPromises();
    expect(actions.theme).toHaveBeenCalledExactlyOnceWith("system");
    expect(items().map((row) => [row.title, row.checked])).toEqual([
      ["System", true],
      ["Light", false],
      ["Dark", false],
    ]);
    // Whichever theme the system prefers, the row says System.
    expect(["light", "dark"]).toContain(themeState.theme);
    await key("Escape");
    expect(item("Theme").value).toBe("System");
  });

  it("switches the theme in one step from a typed query and keeps the deck open", async () => {
    actions.theme.mockImplementation((choice: ThemeChoice) => {
      themeState.choice = choice;
    });
    open();
    await query("theme");
    expect(titles()).toEqual(["Theme", "Theme: Dark", "Theme: Light", "Theme: System"]);
    const checks = (): unknown[] =>
      ["Theme: System", "Theme: Light", "Theme: Dark"].map((title) => item(title).checked);
    expect(checks()).toEqual([false, false, true]);
    result("Theme: Light").click();
    await flushPromises();
    expect(actions.theme).toHaveBeenCalledExactlyOnceWith("light");
    expect(activeCommandLauncherDraft().visible).toBe(true);
    expect(activeCommandLauncherDraft().query).toBe("theme");
    expect(checks()).toEqual([false, true, false]);
    await query("system");
    result("Theme: System").click();
    await flushPromises();
    expect(actions.theme).toHaveBeenLastCalledWith("system");
    expect(item("Theme: System").checked).toBe(true);
  });

  it("enters select mode from Select and shows its state", async () => {
    open();
    expect(item("Select").value).toBe("off");
    result("Select").click();
    await flushPromises();
    expect(selection.selectMode).toBe(true);
    expect(activeCommandLauncherDraft().visible).toBe(false);
    open();
    expect(item("Select").value).toBe("on");
  });

  it("asks a tmux connection for a window, a detach, and a window past its cap", async () => {
    const connection: TmuxConnectionEntry = {
      connection: "tm-1",
      library_id: "lib-local-live-shape",
      origin: { program: "tmux", command: "tmux -CC", local: true },
      version: "3.5",
      session: { id: "$main", name: "main" },
      windows: [{ id: "@7", name: "logs", panes: 2, open: false }],
      window_cap: 8,
      errors: [],
      control_window: "tm-control",
    };
    library.tmuxConnections = [connection];
    open();
    await filterBy("computers");
    result("tmux -CC on this machine (main)").click();
    await tick();
    expect(activeCommandLauncherDraft().path).toEqual(["machine:tmux:tm-1"]);
    expect(outline()).toEqual([
      "Actions: New tmux window",
      "Actions: Detach",
      "Actions: Show on Computers screen",
      "Windows: logs",
    ]);
    // A tmux window with no chan window yet reads hidden; its one action
    // asks the connection to open it.
    expect([item("logs").value, item("logs").subtitle]).toEqual(["hidden", "@7, 2 panes"]);
    result("logs").click();
    await settle();
    expect(actions.openTmuxWindow).toHaveBeenCalledExactlyOnceWith("tm-1", connection.windows[0]);
    open();
    await query("new tmux window");
    result("New tmux window in tmux -CC on this machine (main)").click();
    await settle();
    expect(actions.newTmuxWindow).toHaveBeenCalledExactlyOnceWith("tm-1");
    open();
    await query("detach");
    result("Detach tmux -CC on this machine (main)").click();
    await settle();
    expect(actions.detach).toHaveBeenCalledExactlyOnceWith("tm-1");
  });
});

describe("privacy mode", () => {
  it("conceals names on the rows while a query still matches them", async () => {
    await setPrivacy({ enabled: true });
    open();
    await tick();
    expect(outline().slice(0, 3)).toEqual([
      "Workspaces: Workspace",
      "Windows: Window",
      "Windows: Window",
    ]);
    expect(target.textContent).not.toContain("release checks");
    expect(target.textContent).not.toContain("Project");
    const listed = (): string[] => items().map((row) => row.id);
    await query("release checks");
    expect(listed()).toContain("computers:window:lib-local-live-shape:w-project-1");
    expect(listed()).not.toContain("computers:workspace:local:ws-project");
    await query("/work/project");
    expect(listed()).toContain("computers:workspace:local:ws-project");
    expect(target.textContent).not.toContain("/work/project");
  });
});

describe("focus around the deck", () => {
  it("hands focus back to the control it opened from when dismissed", async () => {
    const control = document.createElement("button");
    document.body.append(control);
    control.focus();
    open();
    await flushPromises();
    expect(document.activeElement, "the deck takes focus").toBe(target.querySelector(".deck-input"));

    await key("Escape");
    await flushPromises();
    expect(document.activeElement).toBe(control);
    control.remove();
  });

  /// Send one keydown to the element that holds the keyboard, as a key press
  /// does.
  async function pressFocused(value: string): Promise<void> {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    );
    await flushPromises();
  }

  it("keeps the keyboard on the query when a row that changes in place moves focus", async () => {
    remount({ desktop: true });
    // A surface the row's action focuses in a microtask, under the open deck.
    const surface = document.createElement("textarea");
    document.body.append(surface);
    actions.theme.mockImplementation((choice: ThemeChoice) => {
      themeState.choice = choice;
      queueMicrotask(() => surface.focus());
    });
    try {
      open();
      await flushPromises();
      await query("theme light");
      await pressFocused("Enter");
      expect(actions.theme).toHaveBeenCalledExactlyOnceWith("light");
      expect(activeCommandLauncherDraft().visible, "the row changes in place").toBe(true);
      expect(document.activeElement, "the query keeps the keyboard").toBe(input());

      await pressFocused("Escape");
      expect(activeCommandLauncherDraft().visible, "the next Escape is the deck's").toBe(false);
      expect(document.activeElement, "the close hands the keyboard to what the row focused").toBe(surface);
    } finally {
      surface.remove();
    }
  });

  it("hands the keyboard to what a row focused before the deck closed behind it", async () => {
    remount({ desktop: true });
    library.devservers = [{ ...alpha }];
    // The card a machine's row turns the Computers screen to takes focus as
    // the row runs; this host closes the deck once the run has answered.
    const cardSlot = document.createElement("div");
    cardSlot.tabIndex = -1;
    document.body.append(cardSlot);
    actions.showCard.mockImplementation(() => cardSlot.focus());
    try {
      open();
      await flushPromises();
      await query("show alpha");
      await pressFocused("Enter");
      expect(actions.showCard).toHaveBeenCalledExactlyOnceWith("ds-a");
      expect(activeCommandLauncherDraft().visible).toBe(false);
      expect(document.activeElement).toBe(cardSlot);
    } finally {
      cardSlot.remove();
    }
  });
});


describe("Waiting command refusals", () => {
  it.each([
    ["refusal", "dismissed"],
    ["refusal", "replaced"],
    ["refusal", "visible"],
    ["timeout", "dismissed"],
    ["timeout", "replaced"],
    ["timeout", "visible"],
  ])("shows a %s once when the deck is %s", async (outcome, surface) => {
    vi.useFakeTimers();
    const sentence = outcome === "refusal" ? "This window cannot open." : "The window is still restoring.";
    const child = {
      closed: false,
      name: "",
      location: { href: "about:blank" },
      document: document.implementation.createHTMLDocument(),
      sessionStorage: { length: 0 },
      close: vi.fn(() => { child.closed = true; }),
    };
    vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    vi.spyOn(backend, "createWindow").mockResolvedValue({ ...windowRecord, origin: "browser", connected: false });
    vi.spyOn(backend, "discardWindow").mockResolvedValue(undefined);
    vi.spyOn(backend, "checkWindowPage")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "The window is still restoring." }), {
        status: 503, headers: { "Retry-After": outcome === "timeout" ? "120" : "1" },
      }))
      .mockResolvedValue(new Response(JSON.stringify({ error: sentence }), { status: 409 }));
    actions.newWorkspace.mockImplementation(() => mintWindow("workspace").then(() => {}));
    open();
    result("Project").click();
    await vi.advanceTimersByTimeAsync(0);
    const executionDraft = activeCommandLauncherDraft();
    expect(executionDraft.operation?.kind).toBe("pending");
    expect(child.location.href).toBe("about:blank");
    if (surface !== "visible") {
      // Release the working card, then hide the deck.
      await key("Escape");
      closeCommandLauncher();
      flushSync();
      expect(activeCommandLauncherDraft().visible).toBe(false);
    }
    if (surface === "replaced") {
      open();
      await query("focus deploy shell");
      result("Focus Control terminal").click();
      await flushPromises();
      expect(actions.focus).toHaveBeenCalledOnce();
      expect(activeCommandLauncherDraft()).not.toBe(executionDraft);
      open();
    }
    const retainedOperation = surface === "replaced" ? executionDraft.operation : null;
    await vi.advanceTimersByTimeAsync(outcome === "timeout" ? 60_000 : 1000);
    await flushPromises();
    if (surface === "visible") {
      expect(card()).toContain(sentence);
      expect(target.querySelectorAll(".deck-operation-icon.error")).toHaveLength(1);
      expect(notices.items).toHaveLength(0);
      expect(activeCommandLauncherDraft().visible).toBe(true);
    } else {
      expect(notices.items.map((notice) => notice.message)).toEqual([`Project: ${sentence}`]);
      expect(library.error).toBe(`Project: ${sentence}`);
      if (surface === "replaced") expect(target.querySelector(".deck-operation-icon.error")).toBeNull();
      else expect(activeCommandLauncherDraft().visible).toBe(false);
      expect(executionDraft.operation).toBe(retainedOperation);
      openCommandLauncher();
      await flushPromises();
      expect(target.querySelector(".deck-operation")).toBeNull();
      persistCommandLauncherDraft();
      unmount(app);
      commandLauncher.draft = loadSessionDeckDraft("chan.command-launcher.v1:contextual");
      app = mount(CommandLauncher, { target }) as Record<string, unknown>;
      await flushPromises();
      expect(target.querySelector(".deck-operation")).toBeNull();
      expect(notices.items.map((notice) => notice.message)).toEqual([`Project: ${sentence}`]);
    }
    expect(child.closed).toBe(true);
    expect(backend.discardWindow).toHaveBeenCalledExactlyOnceWith(windowRecord.window_id);
  });

  it("reports a hidden plain launcher rejection once with its title", async () => {
    vi.useFakeTimers();
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    actions.theme.mockImplementation(() => pending);
    remount({ desktop: true });
    open();
    await query("theme light");
    const title = "Theme: Light";
    result(title).click();
    await flushPromises();
    expect(actions.theme).toHaveBeenCalledExactlyOnceWith("light");
    closeCommandLauncher();
    await flushPromises();
    reject(new Error("Theme write refused"));
    await flushPromises();
    expect(notices.items.map((notice) => notice.message)).toEqual([`${title}: Theme write refused`]);
    expect(activeCommandLauncherDraft().operation).toBeNull();
    openCommandLauncher();
    await flushPromises();
    expect(target.querySelector(".deck-operation")).toBeNull();
  });
});

describe("tmux windows", () => {
  it("names each window's machine by its devserver and tmux session", async () => {
    const connection = (id: string, session: string): TmuxConnectionEntry => ({
      connection: id,
      library_id: "lib-a",
      origin: { program: "tmux", command: "tmux -CC", local: true },
      version: "3.5",
      session: { id: `$${session}`, name: session },
      windows: [],
      window_cap: 8,
      errors: [],
      control_window: `${id}-control`,
    });
    const tmuxWindow = (id: string, connection: string, label: string): WindowRecord => ({
      ...terminalRecord,
      window_id: id,
      library_id: "lib-a",
      label,
      control: false,
      tmux: { connection, control: false },
    });
    library.devservers = [alpha];
    library.tmuxConnections = [connection("tm-1", "main"), connection("tm-2", "work")];
    library.windows = [tmuxWindow("tm-1-w1", "tm-1", "vim"), tmuxWindow("tm-2-w1", "tm-2", "logs")];
    open();
    await filterBy("windows");
    expect(outline()).toEqual([
      "tmux -CC on alpha (main): Terminal Window 2 [vim]",
      "tmux -CC on alpha (work): Terminal Window 2 [logs]",
      "New: New terminal",
    ]);
    // Under the root, where machines interleave, each row names its own.
    (deck.props!.onClearScope as () => void)();
    await tick();
    await query("vim");
    expect(item("Terminal Window 2 [vim]").subtitle).toBe("tmux -CC on alpha (main)");
  });
});

describe("browser Show readiness", () => {
  it.each([
    ["Show window", "Show"],
    ["Focus window", "Focus"],
  ])("%s from the deck reports a blocked window and shows no success", async (title, verb) => {
    const realActions = await vi.importActual<typeof import("../state/computerActions")>("../state/computerActions");
    actions.setShown.mockImplementation(realActions.setWindowShown);
    actions.focus.mockImplementation(realActions.focusComputerWindow);
    vi.spyOn(window, "open").mockReturnValue(null);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    library.windows = [{
      ...windowRecord, window_id: `deck blocked ${verb}`, hidden: true, connected: false, origin: "browser",
    }];
    open();
    await expand(WINDOW_1);
    result(title).click();
    await flushPromises();
    expect(activeCommandLauncherDraft().operation).toMatchObject({ kind: "error", message: "The browser blocked the Chan window" });
    expect(card()).toContain("The browser blocked the Chan window");
    expect(visibility).not.toHaveBeenCalled();
    expect(recentWindows.keys, "a window that did not open is not a recent one").toEqual([]);
  });

  it.each(["ready", "closed", "refused", "connected", "native"])("Show from the deck handles %s before visibility", async (outcome) => {
    const visibilityOnly = outcome === "connected" || outcome === "native";
    vi.useFakeTimers();
    const realActions = await vi.importActual<typeof import("../state/computerActions")>("../state/computerActions");
    actions.setShown.mockImplementation(realActions.setWindowShown);
    const child = {
      closed: false,
      location: { href: "https://chan.test/refusal" },
      document: document.implementation.createHTMLDocument(),
      focus: vi.fn(),
      close: vi.fn(() => { child.closed = true; }),
    };
    child.document.body.textContent = "Refusal page";
    const opened = vi.spyOn(window, "open").mockReturnValue(child as unknown as Window);
    const visibility = vi.spyOn(backend, "setWindowVisibility").mockResolvedValue(undefined);
    const check = vi.spyOn(backend, "checkWindowPage").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return outcome === "refused"
        ? new Response('{"error":"Show refused."}', { status: 409 })
        : new Response("<html></html>");
    });
    library.windows = [{
      ...windowRecord, window_id: `deck show ${outcome}`, hidden: true,
      connected: outcome === "connected", origin: outcome === "native" ? "native" : "browser",
    }];
    open();
    await expand(WINDOW_1);
    result("Show window").click();
    await vi.advanceTimersByTimeAsync(99);
    flushSync();
    expect(visibility).toHaveBeenCalledTimes(visibilityOnly ? 1 : 0);
    expect(opened).toHaveBeenCalledTimes(visibilityOnly ? 0 : 1);
    expect(check).toHaveBeenCalledTimes(visibilityOnly ? 0 : 1);
    if (outcome === "closed") child.closed = true;
    await vi.advanceTimersByTimeAsync(101);
    flushSync();
    expect(visibility).toHaveBeenCalledTimes(visibilityOnly || outcome === "ready" ? 1 : 0);
    if (outcome === "ready") {
      expect(visibility).toHaveBeenCalledExactlyOnceWith(`deck show ${outcome}`, false, undefined);
      expect(child.location.href).toContain("?w=");
    }
    expect(child.focus).not.toHaveBeenCalled();
    expect(child.close).not.toHaveBeenCalled();
    expect(child.document.body.textContent).toBe("Refusal page");
    if (outcome === "refused") {
      expect(card()).toContain("Show refused.");
      expect(notices.items).toHaveLength(0);
    }
  });
});
