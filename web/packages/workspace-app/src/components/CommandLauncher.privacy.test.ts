// @vitest-environment jsdom
//
// Privacy mode in the Computers scope. The deck names a window `Window` and
// its workspace `Workspace`, as the launcher's own deck does, so the labels
// the user gave windows and workspaces and the roots' folder names are
// nowhere in the deck's markup. The scoped library route is mocked.

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

const PRIVATE = ["release checks", "Project A", "private-tree", "hidden-root"];

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

function paths(): string[] {
  return [...target.querySelectorAll(".deck-result-path")].map((node) => node.textContent ?? "");
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
  row("Windows").click();
  await tick();
  expect.soft(titles(), "the window rows").toEqual(["Window", "Window"]);
  expect.soft(paths(), "the window rows' breadcrumbs").toEqual([
    "Computers › Windows › Open › Workspace",
    "Computers › Windows › Open › Workspace",
  ]);
  expectNothingPrivate("the Windows branch");

  row("Window").click();
  await tick();
  expect(launcherDraft.path).toEqual(["windows", "w-captioned"]);
  expect(paths().every((path) => path === "Computers › Windows › Window"), paths().join(" | ")).toBe(true);
  expectNothingPrivate("a window's actions");

  // The Close card's title is a private field of the deck; revealed, it names
  // the window by its masked name.
  row("Close").click();
  await flush();
  expect(target.querySelector('[aria-label="action details hidden"]')?.textContent).toBe("Hidden");
  (target.querySelector('[aria-label="Reveal action details"]') as HTMLButtonElement).click();
  await tick();
  expect(target.querySelector(".deck-operation")?.textContent).toContain("Close Window?");
  expectNothingPrivate("the revealed Close card");

  (target.querySelector(".deck-decisions button") as HTMLButtonElement).click();
  await tick();
  launcherDraft.path = ["new-window"];
  await tick();
  expect(titles(), "the New window rows").toEqual(["Workspace", "Workspace"]);
  expectNothingPrivate("the New window branch");

  await setPrivacy({ enabled: false });
  await tick();
  expect(titles(), "the New window rows with privacy mode off").toEqual(["Project A", "hidden-root"]);
  launcherDraft.path = ["windows"];
  await tick();
  expect(titles(), "the window rows with privacy mode off").toEqual(["Window 2 [release checks]", "Window 3"]);
  expect(paths()).toEqual([
    "Computers › Windows › Open › Project A",
    "Computers › Windows › Open › private-tree",
  ]);
});
