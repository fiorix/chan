// @vitest-environment jsdom
//
// The Files tree's right-click menu. It opens with a "From selection" label;
// a folder's menu then offers "New File or Directory", one row that makes
// either. The entry's actions follow (the same set the inspector offers):
// Open, which opens a file in an editor and a folder in a new Files tab
// with its inspector open, New Terminal and New Graph with their chords, and
// the transfer and viewer rows. After a separator come the tree's own Copy
// Path, Rename / Move and Delete, which asks before it deletes, and in a
// Files tab a Flip row for the pane. A docked tree offers the same rows,
// without Flip.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinks);

import { api } from "../api/client";
import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { resetLayout } from "../__tests__/tabs";
import { chordFor } from "../state/shortcuts";
import { browserSidePanes } from "../state/store.svelte";
import { layout, openBrowserInActivePane, type LeafNode, type Tab } from "../state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  await mountApp(
    demoData([
      { path: "a.md", kind: "document", size: 5, mtime: 100, content: "hello" },
      { path: "clip.mp4", kind: "binary", size: 10, mtime: 100 },
      { path: "docs/sub/b.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ]),
  );
  resetLayout([]);
  openBrowserInActivePane();
  await settle();
  await vi.waitFor(() => expect(row("a.md")).toBeDefined());
});

afterEach(async () => {
  document.querySelectorAll(".md-video-viewer").forEach((el) => el.remove());
  browserSidePanes.left = false;
  await unmountApp();
});

function row(path: string, scope: ParentNode = document): HTMLElement | undefined {
  return [...scope.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => {
    const title = el.title.replace(/ \(.*\)$/, "");
    return title === path || title.endsWith(`/${path}`);
  });
}

async function menuFor(path: string, scope: ParentNode = document): Promise<HTMLElement> {
  row(path, scope)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await settle();
  return document.querySelector<HTMLElement>(".ctx")!;
}

/// The menu read top to bottom: the label, each row's label, and "---" for
/// a separator.
function lines(menu: HTMLElement): string[] {
  return [...menu.children].map((child) => {
    if (child.classList.contains("ctx-sep")) return "---";
    if (child.classList.contains("from-selection-label")) return child.textContent!.trim();
    return (child.querySelector(".menu-row-label") ?? child.querySelector("span"))!.textContent!.trim();
  });
}

function item(menu: HTMLElement, label: string): HTMLButtonElement {
  return [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => (button.querySelector(".menu-row-label") ?? button.querySelector("span"))?.textContent?.trim() === label,
  )!;
}

function chord(menu: HTMLElement, label: string): string {
  return item(menu, label).querySelector(".menu-row-chord")?.textContent ?? "";
}

function tabs(): Tab[] {
  return (layout.nodes[layout.activePaneId] as LeafNode).tabs;
}

describe("a folder's menu", () => {
  test("reads From selection, New File or Directory, its actions, then the tree's own rows and Flip", async () => {
    const menu = lines(await menuFor("docs"));

    expect(menu.slice(0, 2)).toEqual(["From selection", "New File or Directory"]);
    expect(menu).toContain("Open in File Browser");
    expect(menu).not.toContain("New File");
    expect(menu).not.toContain("New Directory");
    expect(menu).not.toContain("Search");
    expect(menu.slice(menu.indexOf("---"))).toEqual(["---", "Copy Path", "Rename / Move", "Delete", "---", "Flip"]);
  });

  test("Open in File Browser opens a Files tab on the folder with its inspector open", async () => {
    item(await menuFor("docs"), "Open in File Browser").click();
    await settle();

    expect(tabs().at(-1)).toMatchObject({ kind: "browser", selected: "docs", inspectorOpen: true });
  });

  test("New Terminal opens a terminal in the folder, under the new-terminal chord", async () => {
    const menu = await menuFor("docs");
    expect(chord(menu, "New Terminal")).toBe(chordFor("app.terminal.toggle") ?? "");

    item(menu, "New Terminal").click();
    await settle();

    expect(tabs().at(-1)).toMatchObject({ kind: "terminal", cwd: "docs" });
  });

  test("New Graph opens a graph, under the graph chord", async () => {
    const menu = await menuFor("docs");
    expect(chord(menu, "New Graph")).toBe(chordFor("app.graph.toggle") ?? "");

    item(menu, "New Graph").click();
    await settle();

    expect(tabs().at(-1)?.kind).toBe("graph");
  });
});

describe("a file's menu", () => {
  test("has no New File or Directory row", async () => {
    expect(lines(await menuFor("a.md"))).not.toContain("New File or Directory");
  });

  test("Open opens the file in an editor", async () => {
    item(await menuFor("a.md"), "Open").click();

    await vi.waitFor(() => expect(tabs().at(-1)).toMatchObject({ kind: "file", path: "a.md" }));
  });

  test("View Video opens a video in its viewer", async () => {
    item(await menuFor("clip.mp4"), "View Video").click();
    await settle();

    expect(document.querySelector(".md-video-viewer")).not.toBeNull();
  });

  test("Delete shows its chord and deletes only after a destructive confirm", async () => {
    const menu = await menuFor("a.md");
    expect(chord(menu, "Delete")).toBe(chordFor("app.files.delete") ?? "");

    item(menu, "Delete").click();
    await settle();
    await expect(api.read("a.md")).resolves.toBeDefined();
    const confirm = document.querySelector<HTMLButtonElement>(".actions button.ok")!;
    expect(confirm.classList.contains("destructive")).toBe(true);
    confirm.click();

    await vi.waitFor(() => expect(api.read("a.md")).rejects.toThrow());
  });

  test("Flip flips the pane, under the flip chord", async () => {
    const menu = await menuFor("a.md");
    expect(chord(menu, "Flip")).toBe(chordFor("app.pane.flip") ?? "");

    item(menu, "Flip").click();
    await settle();

    expect((layout.nodes[layout.activePaneId] as LeafNode).side).toBe("b");
  });
});

describe("the docked tree", () => {
  test("offers the Files tab's rows, without Flip", async () => {
    const inTab = lines(await menuFor("a.md"));
    document.body.click();
    await settle();
    expect(document.querySelector(".ctx")).toBeNull();

    browserSidePanes.left = true;
    await settle();
    const dock = document.querySelector<HTMLElement>(".browser-side-pane")!;
    await vi.waitFor(() => expect(row("a.md", dock)).toBeDefined());
    const docked = lines(await menuFor("a.md", dock));

    expect(docked).toEqual(inTab.slice(0, inTab.lastIndexOf("---")));
  });
});
