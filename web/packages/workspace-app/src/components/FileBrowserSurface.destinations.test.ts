// @vitest-environment jsdom

import { mount, tick, unmount, type ComponentProps } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const caps = vi.hoisted(() => ({ workspace: true }));
vi.mock("../state/windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/windowCaps")>()),
  windowCaps: {
    get workspace() { return caps.workspace; },
    files: true, drafts: true, terminal: true,
  },
}));

import FileBrowserSurface from "./FileBrowserSurface.svelte";
import Pane from "./Pane.svelte";
import { api } from "../api/client";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { setBrowserVim } from "../state/browserKeys.svelte";
import { commandById, commandContext } from "../state/commands";
import { commandSurfaceId } from "../state/commands/browser";
import { filesContext } from "../state/fileContext.svelte";
import {
  browserSelection, browserSidePanes, fbClipboardClear, fbClipboardSet,
  fbSelectSingle, fbTreeInstance, fileOps, loadTreeDir, pathPromptState,
  refreshTree, refreshWorkspace, resolvePathPrompt,
} from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { layout, selectTabInPane, type BrowserTab, type LeafNode } from "../state/tabs.svelte";

class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }),
});

const PANE = "destinations-pane";
const HOME = "notes/sub";
const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function seat(): BrowserTab {
  const tab: BrowserTab = { kind: "browser", id: "destinations-files", title: "Files", inspectorOpen: false, directory: "notes" };
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  return (layout.nodes[PANE] as LeafNode).tabs[0] as BrowserTab;
}

async function render(props: ComponentProps<typeof FileBrowserSurface>): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileBrowserSurface, { target, props }));
  await settle();
  return target;
}

function button(selector: string, title: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>(selector)].find(
    (candidate) => candidate.querySelector(".menu-row-label")?.textContent?.trim() === title,
  );
  if (!found) throw new Error(`missing ${title} in ${selector}`);
  return found;
}

function entry(surface: HTMLElement, path: string): HTMLElement | undefined {
  return [...surface.querySelectorAll<HTMLElement>('[role="treeitem"], [role="option"]')].find(
    (candidate) => candidate.title.replace(/ \(.*\)$/, "").endsWith(`/${path}`),
  );
}

type Case = {
  name: string;
  variant: "tab" | "dock";
  selected: string | null;
  destination: string;
  standalone?: boolean;
  collapsed?: boolean;
  menuAnchor?: string;
  menuDestination?: string;
};
const CASES: Case[] = [
  { name: "list, empty selection", variant: "tab", selected: null, destination: "notes" },
  { name: "list, directory selected", variant: "tab", selected: "notes/sub", destination: "notes", menuAnchor: "notes/sub", menuDestination: "notes/sub" },
  { name: "list, file selected", variant: "tab", selected: "notes/a.md", destination: "notes" },
  { name: "tree, empty selection", variant: "dock", selected: null, destination: "", menuAnchor: "notes", menuDestination: "notes" },
  { name: "tree, directory selected", variant: "dock", selected: "notes", destination: "notes" },
  { name: "tree, file selected", variant: "dock", selected: "notes/a.md", destination: "notes" },
  { name: "standalone tree, empty selection", variant: "dock", selected: null, destination: HOME, standalone: true, menuAnchor: "notes", menuDestination: "notes" },
  { name: "standalone tree, directory selected", variant: "dock", selected: "notes", destination: "notes", standalone: true },
  { name: "standalone tree, file selected", variant: "dock", selected: "notes/a.md", destination: "notes", standalone: true },
  { name: "tree, directory below collapsed parent", variant: "dock", selected: "notes/sub", destination: "notes/sub", collapsed: true, menuAnchor: "notes", menuDestination: "notes" },
];

type Surface = { target: HTMLElement; tab: BrowserTab; id: string; scenario: Case };
async function surfaceFor(scenario: Case): Promise<Surface> {
  if (scenario.standalone) {
    caps.workspace = false;
    filesContext.current = { rootDisplay: "/", rootWire: "", homeWire: HOME, identity: "files" };
  }
  const tab = seat();
  const target = await render(scenario.variant === "tab" ? { variant: "tab", tab } : { variant: "dock", side: "left" });
  const id = scenario.variant === "tab" ? `fb-tab-${tab.id}` : "fb-dock-left";
  target.querySelector(".browser")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  if (scenario.variant === "dock") {
    fbTreeInstance(id)!.expanded.notes = !scenario.collapsed;
    await settle();
  }
  fbSelectSingle(scenario.selected, fbTreeInstance(id)!.selection);
  await settle();
  expect(commandSurfaceId()).toBe(id);
  if (scenario.collapsed) expect(entry(target, "notes/sub"), "selection is below a collapsed parent").toBeUndefined();
  return { target, tab, id, scenario };
}

const ACTIONS = {
  New: "app.browser.newFsEntry",
  Paste: "app.browser.pasteSelection",
  Upload: "app.browser.uploadSelection",
} as const;
type Action = keyof typeof ACTIONS;
type Origin = "menu" | "launcher";

async function act(surface: Surface, action: Action, origin: Origin, anchorPath?: string): Promise<void> {
  const command = commandById(ACTIONS[action])!;
  if (origin === "launcher") {
    expect(command.available(commandContext()), `${action} offered`).toBe(true);
    void command.run();
  } else if (action === "Paste") {
    const anchor = (anchorPath ? entry(surface.target, anchorPath) : undefined)
      ?? entry(surface.target, surface.scenario.selected ?? "notes")
      ?? entry(surface.target, "notes") ?? entry(surface.target, "notes/a.md");
    expect(anchor, "a row anchors the selection menu").toBeDefined();
    anchor!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await settle();
    button(".ctx button", command.title).click();
  } else {
    if (surface.scenario.variant === "tab") openTabMenu(surface.tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
    else surface.target.querySelector(".browser")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await settle();
    button(".hamburger-menu button", command.title).click();
  }
  await settle();
}

function pick(): HTMLInputElement {
  const picker = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].at(-1);
  expect(picker, "Upload opens its picker").toBeDefined();
  Object.defineProperty(picker!, "files", { configurable: true, value: [new File(["uploaded"], "upload.md")] });
  picker!.dispatchEvent(new Event("change"));
  return picker!;
}

beforeEach(async () => {
  timers = trackTimers();
  setBrowserVim(false);
  fbClipboardClear();
  sessionStorage.clear();
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 3, textCount: 3 },
    files: [
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "notes/sub/b.md", kind: "document", size: 5, mtime: 100, content: "deep" },
      { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hi" },
    ],
  });
  await refreshWorkspace();
  await refreshTree();
  await loadTreeDir("notes");
  await loadTreeDir("notes/sub");
  browserSelection.path = null;
  browserSelection.paths = [];
  browserSidePanes.left = false;
  browserSidePanes.right = false;
});

afterEach(async () => {
  if (pathPromptState.open) resolvePathPrompt(null);
  closeTabMenu();
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [], activeTabId: null } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  await settle(2);
  vi.restoreAllMocks();
  caps.workspace = true;
  filesContext.current = null;
  uninstallDemoWorkspace();
  timers.release();
});

describe.each(CASES)("$name", (scenario) => {
  test.each(["menu", "launcher"] as const)("%s New starts in the surface's directory", async (origin) => {
    const surface = await surfaceFor(scenario);
    await act(surface, "New", origin);
    expect(pathPromptState.open).toBe(true);
    expect(pathPromptState.defaultValue).toBe(scenario.destination ? `${scenario.destination}/` : "");
  });

  test.each(["menu", "launcher"] as const)("%s Paste targets its own directory", async (origin) => {
    const surface = await surfaceFor(scenario);
    const transfer = vi.spyOn(api, "fsTransfer");
    fbClipboardSet("copy", ["README.md"]);
    await act(surface, "Paste", origin, origin === "menu" ? scenario.menuAnchor : undefined);
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledTimes(1));
    const expected = origin === "launcher" ? scenario.destination : (scenario.menuDestination ?? scenario.destination);
    expect(transfer).toHaveBeenCalledWith("copy", ["README.md"], expected);
  });

  test.each(["menu", "launcher"] as const)("%s Upload targets the surface's directory", async (origin) => {
    const surface = await surfaceFor(scenario);
    const upload = vi.spyOn(fileOps, "uploadFilesTo").mockResolvedValue(undefined);
    const replace = vi.spyOn(fileOps, "replaceFileAt").mockResolvedValue(undefined);
    await act(surface, "Upload", origin);
    expect(pick().multiple).toBe(true);
    expect(upload).toHaveBeenCalledExactlyOnceWith(scenario.destination, expect.any(Array), undefined);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("menu Paste follows the clicked row", () => {
  async function pasteAtRow(surface: Surface, rowPath: string): Promise<void> {
    const row = entry(surface.target, rowPath);
    expect(row, `row ${rowPath} exists`).toBeDefined();
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await settle();
  }

  test("right-click on a sibling directory pastes there, selection untouched", async () => {
    const surface = await surfaceFor({ name: "clicked dir", variant: "dock", selected: "notes/a.md", destination: "notes" });
    const transfer = vi.spyOn(api, "fsTransfer");
    fbClipboardSet("copy", ["README.md"]);
    await pasteAtRow(surface, "notes/sub");
    expect(fbTreeInstance(surface.id)!.selection.path, "right-click leaves the selection").toBe("notes/a.md");
    button(".ctx button", commandById(ACTIONS.Paste)!.title).click();
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledTimes(1));
    expect(transfer).toHaveBeenCalledWith("copy", ["README.md"], "notes/sub");
  });

  test("right-click on a file outside the selection pastes into its parent", async () => {
    const surface = await surfaceFor({ name: "clicked file", variant: "dock", selected: "notes/a.md", destination: "notes" });
    fbTreeInstance(surface.id)!.expanded["notes/sub"] = true;
    await settle();
    const transfer = vi.spyOn(api, "fsTransfer");
    fbClipboardSet("copy", ["README.md"]);
    await pasteAtRow(surface, "notes/sub/b.md");
    button(".ctx button", commandById(ACTIONS.Paste)!.title).click();
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledTimes(1));
    expect(transfer).toHaveBeenCalledWith("copy", ["README.md"], "notes/sub");
  });

  test("right-click on a folder row in a list pastes into that folder", async () => {
    const surface = await surfaceFor({ name: "list clicked dir", variant: "tab", selected: "notes/a.md", destination: "notes" });
    const transfer = vi.spyOn(api, "fsTransfer");
    fbClipboardSet("copy", ["README.md"]);
    await pasteAtRow(surface, "notes/sub");
    button(".ctx button", commandById(ACTIONS.Paste)!.title).click();
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledTimes(1));
    expect(transfer).toHaveBeenCalledWith("copy", ["README.md"], "notes/sub");
  });

  test("runCommand paste ignores an open row menu", async () => {
    const surface = await surfaceFor({ name: "open row menu", variant: "dock", selected: "notes/a.md", destination: "notes" });
    const transfer = vi.spyOn(api, "fsTransfer");
    fbClipboardSet("copy", ["README.md"]);
    await pasteAtRow(surface, "notes/sub");
    expect(document.querySelector(".ctx")).not.toBeNull();
    surface.target.querySelector<HTMLElement>('[role="tree"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledTimes(1));
    expect(transfer).toHaveBeenCalledWith("copy", ["README.md"], "notes");
  });
});

test("New without a browser surface uses the default directory", async () => {
  seat();
  caps.workspace = false;
  filesContext.current = { rootDisplay: "/", rootWire: "", homeWire: HOME, identity: "files" };
  browserSelection.path = "notes/a.md";
  expect(commandSurfaceId()).toBeNull();
  const command = commandById(ACTIONS.New)!;
  expect(command.available(commandContext())).toBe(true);
  void command.run();
  await settle();
  expect(pathPromptState.defaultValue).toBe(`${HOME}/`);
});

describe("landing below collapsed ancestors", () => {
  const hidden: Case = {
    name: "hidden file", variant: "dock", selected: "notes/sub/b.md",
    destination: "notes/sub", collapsed: true,
  };

  test.each(["file", "directory"] as const)("New %s reveals the destination's ancestors", async (kind) => {
    const surface = await surfaceFor(hidden);
    const create = vi.spyOn(api, "create");
    await act(surface, "New", "launcher");
    expect(pathPromptState.defaultValue).toBe("notes/sub/");
    const path = kind === "file" ? "notes/sub/created.md" : "notes/sub/created/";
    resolvePathPrompt(path);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    if (kind === "file") await vi.waitFor(() => expect(api.read(path)).resolves.toMatchObject({ content: "" }));
    else await vi.waitFor(() => expect(api.list("notes/sub")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "notes/sub/created", is_dir: true }),
    ])));
    await vi.waitFor(() => {
      expect(fbTreeInstance(surface.id)!.expanded.notes, "notes is expanded after creation").toBe(true);
      expect(fbTreeInstance(surface.id)!.expanded["notes/sub"], "notes/sub is expanded after creation").toBe(true);
      expect(entry(surface.target, path.replace(/\/$/, "")), "the created entry is visible").toBeDefined();
    });
  });

  test.each(["menu", "launcher"] as const)("%s Paste reveals the destination's ancestors", async (origin) => {
    const surface = await surfaceFor(hidden);
    fbClipboardSet("copy", ["README.md"]);
    if (origin === "menu") {
      fbTreeInstance(surface.id)!.expanded.notes = true;
      await settle();
    }
    await act(surface, "Paste", origin, origin === "menu" ? "notes/sub" : undefined);
    await vi.waitFor(() => expect(fbTreeInstance(surface.id)!.selection.path).toBe("notes/sub/README.md"));
    expect(fbTreeInstance(surface.id)!.expanded.notes).toBe(true);
    expect(fbTreeInstance(surface.id)!.expanded["notes/sub"]).toBe(true);
    await settle();
    expect(entry(surface.target, "notes/sub/README.md")).toBeDefined();
  });

  test.each(["menu", "launcher"] as const)("%s Upload reveals the destination's ancestors", async (origin) => {
    const surface = await surfaceFor(hidden);
    await act(surface, "Upload", origin);
    pick();
    await vi.waitFor(() => expect(fbTreeInstance(surface.id)!.selection.path).toBe("notes/sub/upload.md"));
    expect(fbTreeInstance(surface.id)!.expanded.notes).toBe(true);
    expect(fbTreeInstance(surface.id)!.expanded["notes/sub"]).toBe(true);
    await settle();
    expect(entry(surface.target, "notes/sub/upload.md")).toBeDefined();
  });
});

test.each(["menu", "launcher"] as const)("%s Paste retains its selection when focus moves during the request", async (origin) => {
  const surface = await surfaceFor(CASES[4]!);
  const original = fbTreeInstance(surface.id)!.selection;
  const tab: BrowserTab = { kind: "browser", id: "other-files", title: "Files", inspectorOpen: false,
    directory: "notes/sub", selected: "notes/sub/b.md", selectedPaths: ["notes/sub/b.md"] };
  const other = await render({ variant: "tab", tab });
  const transfer = api.fsTransfer;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.spyOn(api, "fsTransfer").mockImplementation(async (...args) => {
    await held;
    return transfer(...args);
  });
  fbClipboardSet("copy", ["README.md"]);
  try {
    await act(surface, "Paste", origin);
    expect(request).toHaveBeenCalledExactlyOnceWith("copy", ["README.md"], "notes");
    other.querySelector(".browser")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await settle();
    expect(commandSurfaceId()).toBe("fb-tab-other-files");
  } finally { release(); }
  await vi.waitFor(() => expect(original.path).toBe("notes/README.md"));
  expect(fbTreeInstance("fb-tab-other-files")!.selection.path).toBe("notes/sub/b.md");
  expect(commandSurfaceId()).toBe("fb-tab-other-files");
});

test.each(["notes/sub", "notes/a.md"])("entry Upload keeps its own destination for %s", async (path) => {
  const surface = await surfaceFor(CASES[0]!);
  const upload = vi.spyOn(fileOps, "uploadFilesTo").mockResolvedValue(undefined);
  const replace = vi.spyOn(fileOps, "replaceFileAt").mockResolvedValue(undefined);
  entry(surface.target, path)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await settle();
  button(".ctx button", "Upload").click();
  const picker = pick();
  if (path === "notes/sub") {
    expect(picker.multiple).toBe(true);
    expect(upload).toHaveBeenCalledExactlyOnceWith(path, expect.any(Array), undefined);
    expect(replace).not.toHaveBeenCalled();
  } else {
    expect(picker.multiple).toBe(false);
    expect(replace).toHaveBeenCalledExactlyOnceWith(path, expect.any(File));
    expect(upload).not.toHaveBeenCalled();
  }
});

test.each(["menu", "launcher"] as const)("%s Paste does not change a dock reopened with the same id", async (origin) => {
  const surface = await surfaceFor({
    name: "hidden file", variant: "dock", selected: "notes/sub/b.md",
    destination: "notes/sub", collapsed: true,
  });
  const original = fbTreeInstance(surface.id)!;
  const component = mounted[0]!;
  const transfer = api.fsTransfer;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.spyOn(api, "fsTransfer").mockImplementation(async (...args) => {
    await held;
    return transfer(...args);
  });
  fbClipboardSet("copy", ["README.md"]);
  try {
    if (origin === "menu") {
      fbTreeInstance(surface.id)!.expanded.notes = true;
      await settle();
    }
    await act(surface, "Paste", origin, origin === "menu" ? "notes/sub" : undefined);
    expect(request).toHaveBeenCalledExactlyOnceWith("copy", ["README.md"], "notes/sub");
    mounted.splice(mounted.indexOf(component), 1);
    unmount(component);
    surface.target.remove();
    await settle();
    expect(fbTreeInstance(surface.id)).toBeNull();
    const reopened = await render({ variant: "dock", side: "left" });
    const replacement = fbTreeInstance(surface.id)!;
    expect(replacement).not.toBe(original);
    replacement.expanded.notes = false;
    replacement.expanded["notes/sub"] = false;
    reopened.querySelector(".browser")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    fbSelectSingle("notes", replacement.selection);
    await settle();
  } finally { release(); }
  await vi.waitFor(() => expect(original.selection.path).toBe("notes/sub/README.md"));
  const replacement = fbTreeInstance(surface.id)!;
  expect(replacement.selection.path, "the new dock keeps its selection").toBe("notes");
  expect(replacement.expanded.notes, "the completed paste cannot expand the new dock").toBe(false);
  expect(replacement.expanded["notes/sub"]).toBe(false);
});

test("Paste retains the originating selection when the mounted pane switches browser tabs", async () => {
  const first = seat();
  first.selected = "notes/a.md";
  first.selectedPaths = ["notes/a.md"];
  const second: BrowserTab = { kind: "browser", id: "second-files", title: "Other files", inspectorOpen: false,
    directory: "notes/sub", selected: "notes/sub/b.md", selectedPaths: ["notes/sub/b.md"] };
  const pane = layout.nodes[PANE] as LeafNode;
  pane.tabs.push(second);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane } }));
  await settle();
  const surface = target.querySelector<HTMLElement>(".browser")!;
  surface.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  const original = fbTreeInstance(`fb-tab-${first.id}`)!.selection;
  const transfer = api.fsTransfer;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = vi.spyOn(api, "fsTransfer").mockImplementation(async (...args) => {
    await held;
    return transfer(...args);
  });
  fbClipboardSet("copy", ["README.md"]);
  try {
    void commandById(ACTIONS.Paste)!.run();
    await vi.waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith("copy", ["README.md"], "notes"));
    selectTabInPane(PANE, second.id);
    await settle();
    expect(target.querySelector(".browser"), "the pane reuses its mounted file browser").toBe(surface);
    expect(fbTreeInstance(`fb-tab-${first.id}`)).toBeNull();
    expect(commandSurfaceId()).toBe(`fb-tab-${second.id}`);
    expect(fbTreeInstance(`fb-tab-${second.id}`)!.selection.path).toBe("notes/sub/b.md");
  } finally { release(); }
  await vi.waitFor(() => expect(original.path, "the completed paste selects on the originating tab").toBe("notes/README.md"));
  expect(fbTreeInstance(`fb-tab-${second.id}`)!.selection.path, "the new tab keeps its own selection").toBe("notes/sub/b.md");
});
