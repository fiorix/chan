// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const caps = vi.hoisted(() => ({ workspace: true }));

vi.mock("../../state/windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/windowCaps")>()),
  windowCaps: {
    get workspace() {
      return caps.workspace;
    },
    files: true,
    drafts: true,
    terminal: true,
  },
}));

import { api } from "../../api/client";
import type { TreeEntry } from "../../api/types";
import { tree } from "../../state/store.svelte";
import { invalidateImageCatalog, openImageBubble, type ImageBubbleOpts } from "./image";

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const views: EditorView[] = [];

function entry(path: string): TreeEntry {
  return { path, is_dir: false, mtime: 1, size: 1 } as TreeEntry;
}

function open(doc: string, start: number, end: number, over: Partial<ImageBubbleOpts> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc }), parent });
  views.push(view);
  const handle = openImageBubble({
    view,
    triggerStart: start,
    triggerEnd: end,
    initialQuery: "",
    uploadDir: null,
    currentPath: null,
    onDismiss: () => {},
    ...over,
  });
  return { view, handle };
}

function rows(): string[] {
  return [...document.querySelectorAll(".md-bubble-list .md-bubble-row")].map((row) => row.textContent ?? "");
}

beforeEach(() => {
  caps.workspace = true;
  tree.entries = [];
  invalidateImageCatalog();
  vi.spyOn(api, "list").mockResolvedValue([entry("new.png")]);
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
  tree.entries = [];
  invalidateImageCatalog();
  vi.restoreAllMocks();
});

describe("the image picker", () => {
  test("keeps the width and alignment when replacing an existing URL", async () => {
    const doc = "![](a.png#w=400&right)";
    const start = doc.indexOf("a.png");
    const { view, handle } = open(doc, start, doc.indexOf(")"), { templateMode: "raw" });
    await vi.waitFor(() => expect(rows()).toEqual(["new.png"]));
    handle.handleKey(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(view.state.doc.toString()).toBe("![](new.png#w=400&right)");
  });

  test("defaults an existing URL without a width to 250 pixels", async () => {
    const doc = "![](a.png)";
    const start = doc.indexOf("a.png");
    const { view, handle } = open(doc, start, doc.indexOf(")"), { templateMode: "raw" });
    await vi.waitFor(() => expect(rows()).toEqual(["new.png"]));
    handle.handleKey(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(view.state.doc.toString()).toBe("![](new.png#w=250)");
  });

  test("defaults a new wrapped image to 250 pixels", async () => {
    const { view, handle } = open("![", 0, 2);
    await vi.waitFor(() => expect(rows()).toEqual(["new.png"]));
    handle.handleKey(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(view.state.doc.toString()).toBe("![](new.png#w=250)");
  });
});

describe("the picker's upload row", () => {
  function uploadRow(): HTMLElement {
    const row = document.querySelector<HTMLElement>(".md-bubble-action");
    if (!row) throw new Error("no upload row");
    return row;
  }

  test("with no document it is off, says why and opens no file picker", () => {
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    open("![", 2, 2, { uploadDir: null, currentPath: null });
    const row = uploadRow();

    expect.soft(row.getAttribute("aria-disabled")).toBe("true");
    expect.soft(row.title).toBe("Open or create a document first");
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect.soft(picker, "no file picker opens").not.toHaveBeenCalled();
  });

  test("with a document it opens the file picker", () => {
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    open("![", 2, 2, { uploadDir: "notes", currentPath: "notes/a.md" });
    const row = uploadRow();

    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(row.title).toBe("");
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(picker).toHaveBeenCalledTimes(1);
  });
});

describe("the image catalog", () => {
  test("uses loaded file browser entries without a workspace", async () => {
    caps.workspace = false;
    tree.entries = [entry("one.png"), entry("two.webp"), entry("note.md")];
    open("![", 0, 2);

    expect(api.list).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(rows()).toEqual(["one.png", "two.webp"]));
    expect(document.querySelector(".md-bubble-status")?.textContent).not.toMatch(/^Catalog failed/);
  });

  test("requests the workspace image listing once", async () => {
    open("![", 0, 2);

    await vi.waitFor(() => expect(rows()).toEqual(["new.png"]));
    expect(api.list).toHaveBeenCalledTimes(1);
  });
});
