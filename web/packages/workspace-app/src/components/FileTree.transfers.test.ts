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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xterm);
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fit);
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).search);
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serialize);
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinks);

import { api } from "../api/client";
import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, readTab, resetLayout } from "../__tests__/tabs";
import { browserSelection, ui } from "../state/store.svelte";
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
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find((el) => {
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
      effectAllowed: "move",
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
    pick(document.querySelector<HTMLInputElement>("input.file-picker")!, new File(["new body"], "other.md"));

    await vi.waitFor(() => expect(ui.status).toBe("Replaced 'a.md'"));
    await expect(api.read("a.md")).resolves.toMatchObject({ content: "new body" });
    expect(readTab("doc")?.content).toBe("new body");
    expect(row("other.md")).toBeUndefined();
  });

  test("Upload on a folder uploads into it", async () => {
    await openFilesTab();

    (await menuRow("docs", "Upload")).click();
    pick(document.querySelector<HTMLInputElement>("input.file-picker")!, new File(["fresh"], "c.md"));

    await vi.waitFor(() => expect(api.read("docs/c.md")).resolves.toMatchObject({ content: "fresh" }));
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

    (await action("Download file")).click();
    await settle();

    expect(clicked.map((link) => link.getAttribute("href"))).toEqual([api.downloadUrl("a.md")]);
  });

  test("Upload on a folder uploads into it", async () => {
    await inspect("docs");

    (await action("Upload file here")).click();
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    pick(inputs[inputs.length - 1], new File(["fresh"], "d.md"));

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
