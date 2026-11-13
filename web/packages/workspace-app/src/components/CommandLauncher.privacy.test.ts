// @vitest-environment jsdom
//
// Privacy mode in the Computers scope. The deck names a window `Window` and
// its workspace `Workspace`, as the launcher's own deck does, so the labels
// the user gave windows and workspaces and the roots' folder names are
// nowhere in the deck's markup, while a typed query still matches them. The
// scoped library route is mocked.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const scopedLibrary = vi.hoisted(() => ({ load: vi.fn(), liveTerminals: vi.fn() }));

vi.mock("../state/commands/install", () => ({}));
vi.mock("../api/libraryCommand", () => ({
  loadScopedLibrarySnapshot: scopedLibrary.load,
  loadScopedWindowLiveTerminals: scopedLibrary.liveTerminals,
  checkScopedWindowPage: vi.fn(),
  runScopedLibraryAction: vi.fn(),
}));

import { setPrivacy } from "@chan/web-shared/privacy";
import CommandLauncher from "./CommandLauncher.svelte";
import { clearLauncherDraft, launcherDraft, launcherPanel, overlayStack } from "../state/store.svelte";
import { resetLayout } from "../__tests__/tabs";

Element.prototype.scrollIntoView = vi.fn();

const PRIVATE = ["release checks", "Project A", "private-tree", "hidden-root", "secret-root"];

function workspaceWindow(window_id: string, ordinal: number, label: string, workspace_path: string) {
  return {
    window_id,
    kind: "workspace" as const,
    title: "an intentionally unrelated title",
    ordinal,
    label,
    workspace_path,
    connected: true,
    hidden: false,
    control: false,
    tmux: false,
    origin: "browser" as const,
    launch_path: `/api/library/command-capabilities/cap/windows/${window_id}/launch`,
  };
}

function workspaceRow(workspace_id: string, path: string, label: string) {
  return {
    workspace_id,
    path,
    label,
    on: true,
    status: "running" as const,
    library_id: "lib-local-test",
    devserver_id: null,
    prefix: workspace_id,
  };
}

const snapshot = {
  library_id: "lib-local-test",
  windows: [
    // A labelled window whose workspace row has a label of its own.
    workspaceWindow("w-captioned", 2, "release checks", "/work/project-a"),
    // A window whose workspace no row lists: the deck names it from its path.
    workspaceWindow("w-unlisted", 3, "", "/srv/private-tree"),
  ],
  workspaces: [
    workspaceRow("project-a", "/work/project-a", "Project A"),
    workspaceRow("project-b", "/work/hidden-root", ""),
    // A mount that cannot read its root: the server's reason names the path.
    {
      ...workspaceRow("project-c", "/work/secret-root", ""),
      status: "unavailable" as const,
      error: "workspace root does not exist: /work/secret-root",
    },
  ],
};

let app: Record<string, unknown> | null = null;
let target: HTMLElement;

async function flush(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function titles(): string[] {
  return [...target.querySelectorAll(".deck-result-title")].map((node) => node.textContent ?? "");
}

/// The second line of each row that has one: a window's workspace.
function subtitles(): string[] {
  return [...target.querySelectorAll(".deck-result-subtitle")].map((node) => node.textContent ?? "");
}

function crumbs(): string[] {
  return [...target.querySelectorAll(".deck-crumb")].map((node) => node.textContent ?? "");
}

async function key(value: string): Promise<void> {
  (target.querySelector('[role="dialog"]') as HTMLElement).dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true }),
  );
  await tick();
}

async function type(query: string): Promise<void> {
  const field = target.querySelector(".deck-input") as HTMLInputElement;
  field.value = query;
  field.dispatchEvent(new InputEvent("input", { bubbles: true, data: query }));
  await tick();
}

function row(title: string, index = 0): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>(".deck-result")].filter(
    (candidate) => candidate.querySelector(".deck-result-title")?.textContent === title,
  )[index];
  if (!found) throw new Error(`missing row ${title}; visible: ${titles().join(", ")}`);
  return found;
}

// Markup, so attributes count as well as text.
function expectNothingPrivate(where: string): void {
  expect.soft(PRIVATE.filter((value) => target.innerHTML.includes(value)), where).toEqual([]);
}

async function openComputers(): Promise<void> {
  launcherPanel.open = true;
  await flush();
  (target.querySelector('[aria-label="Computers scope"]') as HTMLButtonElement).click();
  await tick();
}

beforeEach(() => {
  sessionStorage.clear();
  clearLauncherDraft();
  resetLayout();
  overlayStack.ids = [];
  scopedLibrary.load.mockResolvedValue(snapshot);
  scopedLibrary.liveTerminals.mockResolvedValue(1);
  target = document.createElement("div");
  document.body.append(target);
  app = mount(CommandLauncher, { target }) as Record<string, unknown>;
});

afterEach(async () => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
  launcherPanel.open = false;
  overlayStack.ids = [];
  vi.clearAllMocks();
  await setPrivacy({ enabled: false });
});

test("privacy mode names windows and their workspaces as the launcher's deck does, live", async () => {
  await setPrivacy({ enabled: true });
  await openComputers();
  // The mount that needs attention, the two workspaces that serve, the
  // window no row lists, the captioned window, then the one action of the
  // machine.
  expect.soft(titles(), "the scope's rows").toEqual([
    "Workspace", "Workspace", "Workspace", "Window", "Window", "New terminal window",
  ]);
  expect.soft(subtitles(), "the mount's reason, then the workspace each window row names").toEqual([
    "Workspace unavailable", "Workspace", "Workspace",
  ]);
  expectNothingPrivate("the Computers scope");

  // Right on the fifth row: the page of the captioned window.
  for (let row = 0; row < 4; row += 1) await key("ArrowDown");
  await key("ArrowRight");
  expect(launcherDraft.path).toEqual(["window:w-captioned"]);
  expect.soft(crumbs(), "where the deck says it stands").toEqual(["Computers", "Window"]);
  expect.soft(titles(), "the window's actions").toEqual(["Focus window", "Hide window", "Close window"]);
  expectNothingPrivate("a window's page");

  // The Close card's title is a private field of the deck; revealed, it names
  // the window by its masked name.
  row("Close window").click();
  await flush();
  expect(target.querySelector('[aria-label="action details hidden"]')?.textContent).toBe("Hidden");
  (target.querySelector('[aria-label="Reveal action details"]') as HTMLButtonElement).click();
  await tick();
  expect(target.querySelector(".deck-operation")?.textContent).toContain("Close Window?");
  expectNothingPrivate("the revealed Close card");

  (target.querySelector(".deck-decisions button") as HTMLButtonElement).click();
  await tick();
  await key("ArrowLeft");
  expect(launcherDraft.path).toEqual([]);

  // A typed query still matches the names the rows conceal: the user's
  // caption, a workspace's label and a root's folder name.
  await type("release checks");
  expect.soft([...titles()].sort(), "the captioned window and its actions").toEqual([
    "Close Window", "Focus Window", "Hide Window", "Window",
  ]);
  expectNothingPrivate("a query on a window's caption");
  await type("hidden-root");
  expect.soft([...titles()].sort(), "a workspace found by its root's folder name").toEqual([
    "New window of Workspace", "Workspace",
  ]);
  expectNothingPrivate("a query on a root's folder name");
  await type("private-tree");
  expect.soft([...titles()].sort(), "a window found by the root of a workspace no row lists").toEqual([
    "Close Window", "Focus Window", "Hide Window", "Window",
  ]);
  expectNothingPrivate("a query on the root of a workspace no row lists");

  await type("");
  await setPrivacy({ enabled: false });
  await tick();
  expect(titles(), "the scope's rows with privacy mode off").toEqual([
    "secret-root", "Project A", "hidden-root", "Window 3", "Window 2 [release checks]", "New terminal window",
  ]);
  expect(subtitles()).toEqual([
    "workspace root does not exist: /work/secret-root", "private-tree", "Project A",
  ]);
});
