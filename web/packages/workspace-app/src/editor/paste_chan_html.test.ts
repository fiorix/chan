// @vitest-environment jsdom
//
// Chan-to-chan rich paste: a wrapper carrying the exact source
// markdown + inlined images pastes with its images carried. Foreign
// pastes upload the decoded bytes next to the destination doc and rewrite
// the refs (preserving alt / width / align / order); same-workspace pastes
// rebase the refs with zero uploads; a per-image failure keeps the ref;
// and a malformed wrapper parses to null (the handler falls to turndown).
// A workspace's drafts are kept outside it and apart from each other: a
// paste rebases only inside the workspace or inside one draft's lifetime,
// and copies the images at every other crossing. With no document open a
// paste keeps its references, says so and uploads nothing.
//
// api/client, the image catalog, and the notifier are mocked before the
// paste module evaluates, following the fbClipboard.test.ts precedent.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const uploadAttachment = vi.fn();
const invalidateImageCatalog = vi.fn();
const notify = vi.fn();

vi.mock("../api/client", () => ({
  api: { uploadAttachment: (f: File, d: string | null) => uploadAttachment(f, d) },
  withTokenQuery: (p: string) => p,
}));
vi.mock("./bubbles/image", () => ({
  invalidateImageCatalog: () => invalidateImageCatalog(),
}));
vi.mock("../state/notify.svelte", () => ({ notify: (m: string) => notify(m) }));

import { draftClientPath, isDraftClientPath } from "../api/fileIdentity";
import type { ChanClipboardContext } from "./copy_html";
import { applyChanHtmlPaste, parseChanWrapper, pasteHandler } from "./paste_html";

/// A chan-doc wrapper HTML string, built the same way copy_html does.
function wrapper(
  markdown: string,
  root: string,
  path: string,
  imgs: Array<{ ordinal: number; src: string }>,
): string {
  const div = document.createElement("div");
  div.setAttribute("data-chan-doc", "1");
  div.setAttribute("data-chan-workspace", root);
  div.setAttribute("data-chan-path", path);
  div.setAttribute("data-chan-markdown", markdown);
  for (const im of imgs) {
    const img = document.createElement("img");
    img.setAttribute("data-chan-ref", String(im.ordinal));
    img.setAttribute("src", im.src);
    div.appendChild(img);
  }
  return div.outerHTML;
}

/// A wrapper as copy_html writes one for a draft's document: its path
/// inside the drafts, with its root and the id of its lifetime beside it.
function draftWrapper(
  markdown: string,
  root: string,
  path: string,
  draftId: string | null,
  imgs: Array<{ ordinal: number; src: string }>,
): string {
  const doc = new DOMParser().parseFromString(wrapper(markdown, root, path, imgs), "text/html");
  const div = doc.querySelector("[data-chan-doc]")!;
  div.setAttribute("data-chan-root", "draft");
  if (draftId !== null) div.setAttribute("data-chan-draft-id", draftId);
  return div.outerHTML;
}

/// The client path of a file of the draft `name` in the lifetime `id`.
function draftFile(name: string, id: string, leaf = "draft.md"): string {
  return draftClientPath({ path: `${name}/${leaf}`, draft_id: id });
}

const MARK = String.fromCharCode(0);

/// An editor with no document: no path and nowhere to upload to.
const noDocument = (root: string): ChanClipboardContext => ({
  getCurrentPath: () => null,
  getUploadDir: () => null,
  getWorkspaceRoot: () => root,
});

function plainView(doc = ""): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}

const ctxTo = (root: string, path: string): ChanClipboardContext => ({
  getCurrentPath: () => path,
  getUploadDir: () => path.split("/").slice(0, -1).join("/") || null,
  getWorkspaceRoot: () => root,
});

// base64 "AQID" decodes to bytes [1, 2, 3].
const PNG_A = "data:image/png;base64,AQID";
const PNG_B = "data:image/png;base64,BAUG"; // [4, 5, 6]

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseChanWrapper", () => {
  test("parses markdown, origin, and the ref data map", () => {
    const html = wrapper("![a](./a.png)", "/ws", "notes/foo.md", [
      { ordinal: 0, src: PNG_A },
    ]);
    const parsed = parseChanWrapper(html);
    expect(parsed?.markdown).toBe("![a](./a.png)");
    expect(parsed?.workspaceRoot).toBe("/ws");
    expect(parsed?.sourcePath).toBe("notes/foo.md");
    expect(parsed?.refData.get(0)).toBe(PNG_A);
  });

  test("a missing or empty markdown attr parses to null (falls to turndown)", () => {
    expect(parseChanWrapper('<div data-chan-doc="1"></div>')).toBeNull();
    expect(
      parseChanWrapper('<div data-chan-doc="1" data-chan-markdown=""></div>'),
    ).toBeNull();
    expect(parseChanWrapper("<p>plain</p>")).toBeNull();
  });
});

describe("applyChanHtmlPaste: foreign workspace (uploads)", () => {
  test("uploads decoded bytes with the ref name into the dest dir", async () => {
    uploadAttachment.mockResolvedValue({ path: "notes/a-1.png" });
    const md = "text ![alt](./a.png#w=250&left) end";
    const parsed = parseChanWrapper(
      wrapper(md, "/ws-A", "docs/orig.md", [{ ordinal: 0, src: PNG_A }]),
    )!;
    const view = plainView("");
    await applyChanHtmlPaste(parsed, view, ctxTo("/ws-B", "notes/bar.md"));

    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    const [file, dir] = uploadAttachment.mock.calls[0]!;
    expect((file as File).name).toBe("a.png");
    expect(dir).toBe("notes");
    expect(Array.from(new Uint8Array(await (file as File).arrayBuffer()))).toEqual([1, 2, 3]);
    // Rewritten to the returned (relativized) path, fragment verbatim.
    expect(view.state.doc.toString()).toBe("text ![alt](./a-1.png#w=250&left) end");
    expect(invalidateImageCatalog).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  test("rewrites multiple refs preserving alt / width / align / order", async () => {
    uploadAttachment
      .mockResolvedValueOnce({ path: "notes/a-1.png" })
      .mockResolvedValueOnce({ path: "notes/b-1.png" });
    const md = "![one](./a.png#w=100) mid ![two](./b.png#right)";
    const parsed = parseChanWrapper(
      wrapper(md, "/ws-A", "docs/orig.md", [
        { ordinal: 0, src: PNG_A },
        { ordinal: 1, src: PNG_B },
      ]),
    )!;
    const view = plainView("");
    await applyChanHtmlPaste(parsed, view, ctxTo("/ws-B", "notes/bar.md"));
    expect(view.state.doc.toString()).toBe(
      "![one](./a-1.png#w=100) mid ![two](./b-1.png#right)",
    );
    view.destroy();
  });

  test("a per-image upload failure keeps the ref and notifies once", async () => {
    uploadAttachment.mockRejectedValue(new Error("boom"));
    const md = "![](./a.png#w=1)";
    const parsed = parseChanWrapper(
      wrapper(md, "/ws-A", "docs/orig.md", [{ ordinal: 0, src: PNG_A }]),
    )!;
    const view = plainView("");
    await applyChanHtmlPaste(parsed, view, ctxTo("/ws-B", "notes/bar.md"));
    expect(view.state.doc.toString()).toBe("![](./a.png#w=1)");
    expect(notify).toHaveBeenCalledTimes(1);
    view.destroy();
  });
});

describe("applyChanHtmlPaste: same workspace (zero uploads)", () => {
  test("rebases the ref from the source dir to the dest dir", async () => {
    const md = "![alt](./a.png#w=250)";
    const parsed = parseChanWrapper(
      wrapper(md, "/ws-A", "docs/orig.md", [{ ordinal: 0, src: PNG_A }]),
    )!;
    const view = plainView("");
    // Same root -> short-circuit; no uploads, refs rebased docs/ -> other/.
    await applyChanHtmlPaste(parsed, view, ctxTo("/ws-A", "other/bar.md"));
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("![alt](../docs/a.png#w=250)");
    view.destroy();
  });
});

describe("parseChanWrapper: a draft's origin", () => {
  test("is the draft's client path, built from its root, path and lifetime id", () => {
    const parsed = parseChanWrapper(
      draftWrapper("![a](./a.png)", "/ws", "untitled/draft.md", "life-a", [{ ordinal: 0, src: PNG_A }]),
    );
    expect(parsed?.sourcePath).toBe(draftFile("untitled", "life-a"));
    expect(parsed?.workspaceRoot).toBe("/ws");
  });

  test("without its lifetime id a draft's wrapper names no origin", () => {
    const parsed = parseChanWrapper(draftWrapper("![a](./a.png)", "/ws", "untitled/draft.md", null, []));
    expect(parsed?.sourcePath).toBe("");
  });

  test("no client path comes in through a wrapper's path attribute", () => {
    const parsed = parseChanWrapper(wrapper("![a](./a.png)", "/ws", draftFile("untitled", "life-a"), []));
    expect(parsed).not.toBeNull();
    expect(parsed!.sourcePath.includes(MARK)).toBe(false);
    expect(isDraftClientPath(parsed!.sourcePath)).toBe(false);
  });
});

describe("applyChanHtmlPaste: a workspace and its drafts", () => {
  const MD = "see ![a](./a.png#w=100) here";

  test("inside one draft's lifetime the refs are rebased and nothing is uploaded", async () => {
    const parsed = parseChanWrapper(
      draftWrapper(MD, "/ws", "untitled/draft.md", "life-a", [{ ordinal: 0, src: PNG_A }]),
    )!;
    const view = plainView("");
    await applyChanHtmlPaste(parsed, view, ctxTo("/ws", draftFile("untitled", "life-a", "parts/more.md")));

    expect.soft(uploadAttachment).not.toHaveBeenCalled();
    expect.soft(view.state.doc.toString()).toBe("see ![a](../a.png#w=100) here");
    view.destroy();
  });

  const crossings: Array<[string, () => string, string, string, string]> = [
    // name, the wrapper, the destination, where the upload answers, the ref written
    [
      "from one draft into another",
      () => draftWrapper(MD, "/ws", "untitled/draft.md", "life-a", [{ ordinal: 0, src: PNG_A }]),
      draftFile("sketch", "life-b"),
      draftFile("sketch", "life-b", "a.png"),
      "see ![a](./a.png#w=100) here",
    ],
    [
      "between two lifetimes of one draft name",
      () => draftWrapper(MD, "/ws", "untitled/draft.md", "life-a", [{ ordinal: 0, src: PNG_A }]),
      draftFile("untitled", "life-b"),
      draftFile("untitled", "life-b", "a.png"),
      "see ![a](./a.png#w=100) here",
    ],
    [
      "from a draft into the workspace",
      () => draftWrapper(MD, "/ws", "untitled/draft.md", "life-a", [{ ordinal: 0, src: PNG_A }]),
      "notes/bar.md",
      "notes/a.png",
      "see ![a](./a.png#w=100) here",
    ],
    [
      "from the workspace into a draft",
      () => wrapper(MD, "/ws", "notes/foo.md", [{ ordinal: 0, src: PNG_A }]),
      draftFile("sketch", "life-b"),
      draftFile("sketch", "life-b", "a.png"),
      "see ![a](./a.png#w=100) here",
    ],
  ];
  test.each(crossings)("%s the image is copied beside the destination", async (_name, html, dest, answer, written) => {
    uploadAttachment.mockReset();
    uploadAttachment.mockResolvedValue({ path: answer });
    const parsed = parseChanWrapper(html())!;
    const view = plainView("");
    const ctx = ctxTo("/ws", dest);
    await applyChanHtmlPaste(parsed, view, ctx);

    expect.soft(uploadAttachment, "one copy of the one image").toHaveBeenCalledTimes(1);
    expect.soft(uploadAttachment.mock.calls[0]?.[1], "into the destination's directory").toBe(ctx.getUploadDir());
    expect.soft(view.state.doc.toString()).toBe(written);
    view.destroy();
  });

  test("inside the workspace the refs are still rebased with no upload", async () => {
    const parsed = parseChanWrapper(wrapper(MD, "/ws", "notes/foo.md", [{ ordinal: 0, src: PNG_A }]))!;
    const view = plainView("");
    await applyChanHtmlPaste(parsed, view, ctxTo("/ws", "other/bar.md"));

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("see ![a](../notes/a.png#w=100) here");
    view.destroy();
  });
});

describe("a paste with no document open", () => {
  const KEPT = "Open or create a document first; pasted images keep their references";

  test("a wrapper from another workspace keeps its references, says so and uploads nothing", async () => {
    uploadAttachment.mockReset();
    const md = "text ![alt](./a.png#w=250) end";
    const parsed = parseChanWrapper(wrapper(md, "/ws-A", "docs/orig.md", [{ ordinal: 0, src: PNG_A }]))!;
    const view = plainView("");
    await applyChanHtmlPaste(parsed, view, noDocument("/ws-B"));

    expect.soft(uploadAttachment).not.toHaveBeenCalled();
    expect.soft(notify.mock.calls.map((call) => call[0])).toEqual([KEPT]);
    expect.soft(view.state.doc.toString()).toBe(md);
    view.destroy();
  });

  test("a wrapper from a draft keeps its references, says so and uploads nothing", async () => {
    uploadAttachment.mockReset();
    const md = "text ![alt](./a.png#w=250) end";
    const parsed = parseChanWrapper(
      draftWrapper(md, "/ws", "untitled/draft.md", "life-a", [{ ordinal: 0, src: PNG_A }]),
    )!;
    const view = plainView("");
    await applyChanHtmlPaste(parsed, view, noDocument("/ws"));

    expect.soft(uploadAttachment).not.toHaveBeenCalled();
    expect.soft(notify.mock.calls.map((call) => call[0])).toEqual([KEPT]);
    expect.soft(view.state.doc.toString()).toBe(md);
    view.destroy();
  });

  test("a rich paste with an inlined image keeps it, says so and uploads nothing", async () => {
    uploadAttachment.mockReset();
    const view = new EditorView({
      state: EditorState.create({ extensions: [pasteHandler(noDocument("/ws"))] }),
    });
    try {
      const img = document.createElement("img");
      img.src = PNG_A;
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: {
        items: [],
        getData: (format: string) => format === "text/html" ? `<p>${img.outerHTML}</p>` : "",
      } });
      view.contentDOM.dispatchEvent(event);
      await vi.waitFor(() => expect(view.state.doc.toString()).not.toBe(""));

      expect.soft(view.state.doc.toString()).toBe(`![](${PNG_A})`);
      expect.soft(uploadAttachment).not.toHaveBeenCalled();
      expect.soft(notify.mock.calls.map((call) => call[0])).toEqual([KEPT]);
    } finally {
      view.destroy();
    }
  });
});

describe("rich paste image names", () => {
  test.each([
    ["parameterless SVG", "data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E", "svg", "image/svg+xml"],
    ["SVG with a payload semicolon", "data:image/svg+xml,%3Csvg%20style%3D%22fill:red;%22%3E%3C%2Fsvg%3E", "svg", "image/svg+xml"],
    ["base64 SVG", "data:image/svg+xml;base64,AQID", "svg", "image/svg+xml"],
    ["JPEG", "data:image/jpeg;base64,AQID", "jpg", "image/jpeg"],
  ])("uses the image extension for %s", async (_label, src, ext, mime) => {
    let receiveFile!: (file: File) => void;
    const uploaded = new Promise<File>((resolve) => { receiveFile = resolve; });
    uploadAttachment.mockImplementation((file: File) => {
      receiveFile(file);
      return Promise.resolve({ path: `notes/image.${ext}` });
    });
    const view = new EditorView({
      state: EditorState.create({ extensions: [pasteHandler(ctxTo("/ws", "notes/a.md"))] }),
    });
    try {
      const img = document.createElement("img");
      img.src = src!;
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: {
        items: [],
        getData: (format: string) => format === "text/html" ? `<p>${img.outerHTML}</p>` : "",
      } });
      view.contentDOM.dispatchEvent(event);
      const file = await uploaded;
      await vi.waitFor(() => expect(view.state.doc.toString()).toBe(`![](./image.${ext})`));
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(file.name).toBe(`pasted-image.${ext}`);
      expect(file.type).toBe(mime);
    } finally {
      view.destroy();
    }
  });
});
