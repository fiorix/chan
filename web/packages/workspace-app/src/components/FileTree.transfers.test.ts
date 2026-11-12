// @vitest-environment jsdom
//
// Files leave and enter the workspace through the Download and Upload rows,
// never through a drag: dragging a tree row carries only the in-app move,
// the open-in-editor payload for a file, and the path as plain text, so
// nothing is offered to the OS as a file, and files dropped from the OS onto
// the tree upload nothing, while a row dropped on a folder moves into it. Download hands the browser the
// entry's download link. Upload on a folder uploads into it, and on a file
// replaces it in place and reloads any tab showing it. The inspector's
// Upload and Download do the same for the entry it shows.
//
// A transfer row runs for its entry what the launcher's command of the same
// title runs for the selection: the store's download, which the desktop
// streams itself, and the picker that takes many files into a folder or one
// file over a file.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { api } from "../api/client";
import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { commandById } from "../state/commands";
import { browserSelection, fbSelectSingle, fileOps, ui } from "../state/store.svelte";
import { openBrowserInActivePane, splitPane } from "../state/tabs.svelte";

stubAppEnvironment();

let clicked: HTMLAnchorElement[];

beforeEach(async () => {
  await mountApp(
    demoData([
      { path: "a.md", kind: "document", size: 8, mtime: 100, content: "old body" },
      { path: "docs/b.md", kind: "document", size: 5, mtime: 100, content: "hello" },
    ]),
  );
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await unmountApp();
});

async function openFilesTab(): Promise<void> {
  resetLayout([]);
  openBrowserInActivePane();
  await settle();
  await vi.waitFor(() => expect(row("a.md")).toBeDefined());
}

function row(path: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"], [role="option"]')].find((el) => {
    const title = el.title.replace(/ \(.*\)$/, "");
    return title === path || title.endsWith(`/${path}`);
  });
}

async function menuRow(path: string, label: string): Promise<HTMLButtonElement> {
  row(path)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  await settle();
  const button = [...document.querySelectorAll<HTMLButtonElement>(".ctx button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `menu row ${label}`).toBeDefined();
  return button!;
}

function pick(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/// The picker an Upload raised: the file input last added to the page.
function picker(): HTMLInputElement {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  expect(inputs.length, "a picker was raised").toBeGreaterThan(0);
  return inputs[inputs.length - 1]!;
}

/// Run the launcher's command `id` with `path` as the file browser's selection.
function runOnSelection(id: string, path: string): void {
  fbSelectSingle(path);
  const command = commandById(id);
  expect(command, id).toBeDefined();
  command!.run();
}

function drag(path: string): { types: string[]; effectAllowed: string } {
  const data = new Map<string, string>();
  const transfer = {
    effectAllowed: "",
    setData: (type: string, value: string) => void data.set(type, value),
    setDragImage: () => {},
  };
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  row(path)!.dispatchEvent(event);
  return { types: [...data.keys()], effectAllowed: transfer.effectAllowed };
}

describe("dragging a tree row", () => {
  test("a file carries the in-app move, the open-in-editor payload and its path, and nothing for the OS", async () => {
    await openFilesTab();

    expect(drag("a.md")).toEqual({
      types: ["application/x-chan-tree-move", "application/x-md-file", "text/plain"],
      // Moved onto a folder, copied when a pane opens it or an editor types
      // its path: a browser refuses a drop effect the source does not allow.
      effectAllowed: "copyMove",
    });
  });

  test("a folder carries the in-app move and its path only", async () => {
    await openFilesTab();

    expect(drag("docs").types).toEqual(["application/x-chan-tree-move", "text/plain"]);
  });
});

describe("dropping onto a tree folder", () => {
  function drop(path: string, data: Record<string, string>, files: File[] = []): void {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: Object.keys(data), files, getData: (type: string) => data[type] ?? "" },
    });
    row(path)!.dispatchEvent(event);
  }

  test("files from the OS upload nothing", async () => {
    await openFilesTab();
    const upload = vi.spyOn(api, "uploadFile");

    drop("docs", { Files: "" }, [new File(["os"], "os.md")]);
    await settle();

    expect(upload).not.toHaveBeenCalled();
    await expect(api.read("docs/os.md")).rejects.toThrow();
  });

  test("a tree row moves into the folder", async () => {
    await openFilesTab();

    drop("docs", {
      "application/x-chan-tree-move": JSON.stringify({ path: "a.md", isDir: false, paths: ["a.md"] }),
    });

    await vi.waitFor(() => expect(api.read("docs/a.md")).resolves.toMatchObject({ content: "old body" }));
  });
});

describe("the tree's transfer rows", () => {
  test("Download hands the browser the file's download link", async () => {
    await openFilesTab();

    (await menuRow("a.md", "Download")).click();

    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute("href")).toBe(api.downloadUrl("a.md"));
    expect(clicked[0].download).toBe("a.md");
  });

  test("Upload on a file replaces it in place and reloads the tab showing it", async () => {
    resetLayout([fileTab({ id: "doc", path: "a.md", content: "old body", saved: "old body" })]);
    splitPane("pane-test", "row");
    openBrowserInActivePane();
    await settle();
    await vi.waitFor(() => expect(row("a.md")).toBeDefined());

    (await menuRow("a.md", "Upload")).click();
    expect(picker().multiple, "one file replaces a file").toBe(false);
    pick(picker(), new File(["new body"], "other.md"));

    await vi.waitFor(() => expect(ui.status).toBe("Replaced 'a.md'"));
    await expect(api.read("a.md")).resolves.toMatchObject({ content: "new body" });
    expect(readTab("doc")?.content).toBe("new body");
    expect(row("other.md")).toBeUndefined();
  });

  test("Upload on a folder uploads into it", async () => {
    await openFilesTab();

    (await menuRow("docs", "Upload")).click();
    expect(picker().multiple, "many files go into a folder").toBe(true);
    pick(picker(), new File(["fresh"], "c.md"));

    await vi.waitFor(() => expect(api.read("docs/c.md")).resolves.toMatchObject({ content: "fresh" }));
  });
});

describe("a transfer row and the command of its title", () => {
  test("Download: both run the store's download for the entry", async () => {
    await openFilesTab();
    const download = vi.spyOn(fileOps, "downloadPathWithProgress");

    (await menuRow("docs", "Download")).click();
    runOnSelection("app.browser.downloadSelection", "docs");
    (await menuRow("a.md", "Download")).click();
    runOnSelection("app.browser.downloadSelection", "a.md");

    expect(download.mock.calls).toEqual([["docs", true], ["docs", true], ["a.md", false], ["a.md", false]]);
    expect(clicked.map((link) => link.getAttribute("href"))).toEqual([
      api.downloadUrl("docs"), api.downloadUrl("docs"), api.downloadUrl("a.md"), api.downloadUrl("a.md"),
    ]);
    await settle();
    expect(document.querySelector(".ctx"), "the row closes its menu").toBeNull();
  });

  test("Upload: both raise the picker that replaces a file with one file", async () => {
    await openFilesTab();

    runOnSelection("app.browser.uploadSelection", "a.md");
    const forCommand = picker();
    expect(forCommand.multiple).toBe(false);
    pick(forCommand, new File(["from the launcher"], "x.md"));
    await vi.waitFor(() => expect(api.read("a.md")).resolves.toMatchObject({ content: "from the launcher" }));

    (await menuRow("a.md", "Upload")).click();
    const forRow = picker();
    expect(forRow).not.toBe(forCommand);
    expect(forRow.multiple).toBe(false);
    pick(forRow, new File(["from the row"], "y.md"));
    await vi.waitFor(() => expect(api.read("a.md")).resolves.toMatchObject({ content: "from the row" }));
    expect(document.querySelector(".ctx"), "the row closes its menu").toBeNull();
  });

  test("Upload: both raise the picker that takes many files into a folder", async () => {
    await openFilesTab();

    // The row first: an upload shows what landed, which takes the list into
    // the folder and its row out of view.
    (await menuRow("docs", "Upload")).click();
    expect(picker().multiple).toBe(true);
    pick(picker(), new File(["one"], "e.md"));
    await vi.waitFor(() => expect(api.read("docs/e.md")).resolves.toMatchObject({ content: "one" }));

    runOnSelection("app.browser.uploadSelection", "docs");
    expect(picker().multiple).toBe(true);
    pick(picker(), new File(["two"], "f.md"));
    await vi.waitFor(() => expect(api.read("docs/f.md")).resolves.toMatchObject({ content: "two" }));
  });
});

describe("the inspector's transfer actions", () => {
  async function inspect(path: string): Promise<void> {
    await openFilesTab();
    row(path)!.querySelector<HTMLElement>(".name")!.click();
    await settle();
    expect(browserSelection.path).toBe(path);
    await vi.waitFor(() => expect(document.querySelector(".pill-main")).not.toBeNull());
  }

  async function action(label: string): Promise<HTMLElement> {
    const main = document.querySelector<HTMLButtonElement>(".pill-main");
    if (main?.textContent?.trim() === label) return main;
    document.querySelector<HTMLButtonElement>(".pill-caret")!.click();
    await settle();
    const item = [...document.querySelectorAll<HTMLElement>(".action-menu-item")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(item, `inspector action ${label}`).toBeDefined();
    return item!;
  }

  test("Download hands the browser the entry's download link", async () => {
    await inspect("a.md");

    (await action("Download")).click();
    await settle();

    expect(clicked.map((link) => link.getAttribute("href"))).toEqual([api.downloadUrl("a.md")]);
  });

  test("Upload on a folder uploads into it", async () => {
    await inspect("docs");

    (await action("Upload")).click();
    pick(picker(), new File(["fresh"], "d.md"));

    await vi.waitFor(() => expect(api.read("docs/d.md")).resolves.toMatchObject({ content: "fresh" }));
  });
});

describe("api.downloadUrl", () => {
  test("names the workspace path, escaped, with the download flag", () => {
    expect(api.downloadUrl("my notes/a b.md")).toMatch(/\/api\/fs\/my%20notes\/a%20b\.md\?download=1$/);
  });

  test("adds the filesystem root when asked", () => {
    expect(api.downloadUrl("etc/hosts", "filesystem")).toMatch(/\/api\/fs\/etc\/hosts\?download=1&root=filesystem$/);
  });
});
