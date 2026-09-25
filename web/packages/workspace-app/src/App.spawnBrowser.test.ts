// @vitest-environment jsdom
//
// A new Files tab opens where the focused tab points. A folder (a terminal's
// working directory, or nothing at all) is entered: the tab opens on it,
// expanded along with its parents, rather than highlighted under a collapsed
// root. A file is selected inside its expanded parent. With nothing focused a
// workspace window opens on its root, while a standalone window, whose root
// is the whole machine, opens on the home folder its tenant reported. The
// inspector keeps the pane's own default.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/xterm")).webLinks);

// The capabilities are fixed per window at load; a mutable copy lets this
// window stand in for a standalone one.
const caps = vi.hoisted(() => ({}) as { workspace: boolean; files: boolean });

vi.mock("./state/windowCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/windowCaps")>();
  Object.assign(caps, actual.windowCaps);
  return { ...actual, windowCaps: caps };
});

import { demoData, hostCommand, mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { fileTab, resetLayout, terminalTab } from "./__tests__/tabs";
import { filesContext, filesContextFrom } from "./state/fileContext.svelte";
import { browserSelection, treeExpanded } from "./state/store.svelte";
import { layout, type BrowserTab, type LeafNode, type Tab } from "./state/tabs.svelte";

stubAppEnvironment();

const WIDE = window.innerWidth;

beforeEach(async () => {
  Object.assign(caps, { workspace: true, files: true });
  await mountApp(
    demoData([
      { path: "notes/a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "notes/sub/b.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ]),
  );
  treeExpanded.map = {};
});

afterEach(async () => {
  filesContext.current = null;
  window.innerWidth = WIDE;
  await unmountApp();
});

async function spawnFrom(tabs: Tab[]): Promise<BrowserTab> {
  resetLayout(tabs);
  await settle();
  hostCommand("app.files.toggle");
  await settle();
  const pane = layout.nodes["pane-test"] as LeafNode;
  const spawned = pane.tabs[pane.tabs.length - 1];
  expect(spawned.kind).toBe("browser");
  return spawned as BrowserTab;
}

describe("a new Files tab", () => {
  test("enters a terminal's folder, expanding it and its parents", async () => {
    const tab = await spawnFrom([terminalTab({ id: "term", cwd: "notes/sub" })]);

    expect(tab.selected).toBe("notes/sub");
    expect(tab.expanded).toEqual(["notes", "notes/sub"]);
    expect(browserSelection.showWorkspace).toBe(false);
    expect(treeExpanded.map).toMatchObject({ notes: true, "notes/sub": true });
  });

  test("selects a doc inside its parent, which is expanded and the doc is not", async () => {
    const tab = await spawnFrom([fileTab({ id: "doc", path: "notes/sub/b.md", content: "hello", saved: "hello" })]);

    expect(tab.selected).toBe("notes/sub/b.md");
    expect(treeExpanded.map).toMatchObject({ notes: true, "notes/sub": true });
    expect(treeExpanded.map["notes/sub/b.md"]).toBeUndefined();
  });

  test("opens a workspace window's root when nothing is focused, whatever home a tenant reported", async () => {
    filesContext.current = filesContextFrom("home/user");

    const tab = await spawnFrom([]);

    expect(tab.selected ?? null).toBeNull();
    expect(tab.expanded).toBeUndefined();
  });

  test("opens a standalone window's home folder when nothing is focused", async () => {
    caps.workspace = false;
    filesContext.current = filesContextFrom("home/user");

    const tab = await spawnFrom([]);

    expect(tab.selected).toBe("home/user");
    expect(tab.expanded).toEqual(["home", "home/user"]);
  });

  test("keeps the inspector closed on a narrow window", async () => {
    window.innerWidth = 600;

    const tab = await spawnFrom([terminalTab({ id: "term", cwd: "notes" })]);

    expect(tab.inspectorOpen).toBe(false);
  });

  test("opens nothing in a window with no files", async () => {
    caps.files = false;
    resetLayout([terminalTab({ id: "term", cwd: "notes" })]);
    await settle();

    hostCommand("app.files.toggle");
    await settle();

    expect((layout.nodes["pane-test"] as LeafNode).tabs.map((tab) => tab.kind)).toEqual(["terminal"]);
  });
});
