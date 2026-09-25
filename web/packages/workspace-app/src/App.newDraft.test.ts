// @vitest-environment jsdom
//
// New draft asks the server to mint a draft, refreshes the workspace's view
// of it, and opens it in the active pane with the seeded `# Draft` title
// selected, ready to type over. The launcher, the pane menu and the host
// reach it through the `app.draft.new` command; it has no built-in chord.
// Hybrid Nav stages new drafts and diagrams instead, one per press, and
// creates each only when the layout commits, in the pane it was staged on.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinks);

vi.mock("./state/store.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/store.svelte")>();
  return { ...actual, noteDraftCreated: vi.fn(actual.noteDraftCreated) };
});

import { api } from "./api/client";
import { demoData, hostCommand, mountApp, press, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { json, recordRequests, stopRecordingRequests } from "./__tests__/fetch";
import { fileTab, resetLayout } from "./__tests__/tabs";
import { allCommands, type CommandContext } from "./state/commands";
import { SHORTCUTS } from "./state/shortcuts";
import { noteDraftCreated, ui } from "./state/store.svelte";
import { cancelPaneMode, enterPaneMode, layout, splitPane, type FileTab } from "./state/tabs.svelte";

stubAppEnvironment();

// "Draft" inside the `# Draft` heading the server seeds a new draft with.
const TITLE = { from: 2, to: 7 };

afterEach(async () => {
  stopRecordingRequests();
  cancelPaneMode();
  await unmountApp();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// The demo server mints an empty draft; the real one seeds the `# Draft`
// heading the new tab selects.
function mintSeededDrafts() {
  const mint = api.createDraft;
  return vi.spyOn(api, "createDraft").mockImplementation(async (kind) => {
    const draft = await mint(kind);
    await api.write(draft.path, "# Draft\n");
    return draft;
  });
}

function fileTabsIn(paneId: string): FileTab[] {
  const pane = layout.nodes[paneId];
  if (pane?.kind !== "leaf") return [];
  return pane.tabs.filter((tab): tab is FileTab => tab.kind === "file");
}

function launcherContext(): CommandContext {
  return {
    terminalOnly: false,
    terminalControl: false,
    caps: { workspace: true, files: true, drafts: true, terminal: true },
    activeSurface: null,
    activeSide: null,
    activeTabId: null,
    activeExtensionId: null,
  };
}

describe("api.createDraft", () => {
  test("posts to /api/drafts/new with no body and answers the draft's path and name", async () => {
    const requests = recordRequests(() => json({ path: ".Drafts/untitled-1/draft.md", name: "untitled-1" }));

    await expect(api.createDraft()).resolves.toEqual({ path: ".Drafts/untitled-1/draft.md", name: "untitled-1" });
    expect(requests).toMatchObject([{ method: "POST", path: "/api/drafts/new", body: null }]);
    expect([...requests[0].query]).toEqual([]);
  });

  test("names the kind in the body when it seeds a slide deck", async () => {
    const requests = recordRequests(() => json({ path: ".Drafts/deck/deck.md", name: "deck" }));

    await api.createDraft("slides");

    expect(requests).toMatchObject([{ method: "POST", path: "/api/drafts/new", body: { kind: "slides" } }]);
  });
});

describe("the New draft command", () => {
  test("creates a draft and opens it in the active pane with the title selected", async () => {
    await mountApp();
    resetLayout([]);
    await settle();
    mintSeededDrafts();

    hostCommand("app.draft.new");

    await vi.waitFor(() => expect(fileTabsIn("pane-test")).toHaveLength(1));
    const [tab] = fileTabsIn("pane-test");
    expect(tab.path).toMatch(/^\.Drafts\/untitled-\d+\/draft\.md$/);
    expect(tab.caret).toEqual(TITLE);
    expect(noteDraftCreated).toHaveBeenCalledWith(tab.path);
  });

  test("is what the launcher runs", async () => {
    await mountApp();
    resetLayout([]);
    await settle();
    const command = allCommands().find((candidate) => candidate.id === "app.draft.new");
    expect(command?.available(launcherContext())).toBe(true);

    command!.run();

    await vi.waitFor(() => expect(fileTabsIn("pane-test")).toHaveLength(1));
  });

  test("reports a failed create in the status bar and opens nothing", async () => {
    await mountApp();
    resetLayout([]);
    await settle();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(api, "createDraft").mockRejectedValue(new Error("disk full"));

    hostCommand("app.draft.new");

    await vi.waitFor(() => expect(ui.status).toBe("New draft failed: disk full"));
    expect(fileTabsIn("pane-test")).toEqual([]);
  });

  test("has no built-in chord", async () => {
    await mountApp();
    resetLayout([]);
    await settle();
    const createDraft = vi.spyOn(api, "createDraft");

    expect(SHORTCUTS.find((shortcut) => shortcut.id === "app.draft.new")).toBeUndefined();
    press({ key: "n", code: "KeyN", ctrlKey: true });
    press({ key: "n", code: "KeyN", metaKey: true });
    await settle();

    expect(createDraft).not.toHaveBeenCalled();
  });
});

describe("drafts staged in Hybrid Nav", () => {
  test("are created on commit, each in the pane it was staged on, with the title selected", async () => {
    await mountApp();
    resetLayout([fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" })]);
    const other = splitPane("pane-test", "row")!;
    layout.activePaneId = "pane-test";
    await settle();
    const createDraft = mintSeededDrafts();

    enterPaneMode();
    press({ key: "n", code: "KeyN" });
    press({ key: "ArrowRight", code: "ArrowRight" });
    press({ key: "n", code: "KeyN" });
    await settle();
    expect(createDraft).not.toHaveBeenCalled();
    press({ key: "Enter", code: "Enter" });

    await vi.waitFor(() => {
      expect(fileTabsIn("pane-test")).toHaveLength(2);
      expect(fileTabsIn(other)).toHaveLength(1);
    });
    expect(createDraft).toHaveBeenCalledTimes(2);
    const drafts = [fileTabsIn("pane-test")[1], fileTabsIn(other)[0]];
    for (const draft of drafts) {
      expect(draft.path).toMatch(/^\.Drafts\/untitled-\d+\/draft\.md$/);
      expect(draft.caret).toEqual(TITLE);
      expect(noteDraftCreated).toHaveBeenCalledWith(draft.path);
    }
  });

  test("a staged diagram is created as a diagram and opens with no selection", async () => {
    await mountApp(
      demoData([
        { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
        { path: "board.excalidraw", kind: "document", size: 2, mtime: 100, content: "{}" },
      ]),
    );
    resetLayout([]);
    await settle();
    const createDraft = vi.spyOn(api, "createDraft");
    const createDiagram = vi
      .spyOn(api, "createDiagram")
      .mockResolvedValue({ path: "board.excalidraw", name: "board" });

    enterPaneMode();
    press({ key: "i", code: "KeyI" });
    press({ key: "Enter", code: "Enter" });

    await vi.waitFor(() => expect(fileTabsIn("pane-test")).toHaveLength(1));
    expect(createDiagram).toHaveBeenCalledTimes(1);
    expect(createDraft).not.toHaveBeenCalled();
    expect(fileTabsIn("pane-test")[0]).toMatchObject({ path: "board.excalidraw" });
    expect(fileTabsIn("pane-test")[0].caret).toBeUndefined();
  });

  test("Escape drops them, creating nothing", async () => {
    await mountApp();
    resetLayout([]);
    await settle();
    const createDraft = vi.spyOn(api, "createDraft");

    enterPaneMode();
    press({ key: "n", code: "KeyN" });
    press({ key: "Escape", code: "Escape" });
    await settle();

    expect(createDraft).not.toHaveBeenCalled();
    expect(fileTabsIn("pane-test")).toEqual([]);
  });
});
