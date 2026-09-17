// @vitest-environment jsdom
//
// Chan-to-chan rich paste: a wrapper carrying the exact source
// markdown + inlined images pastes with its images carried. Foreign
// pastes upload the decoded bytes next to the destination doc and rewrite
// the refs (preserving alt / width / align / order); same-workspace pastes
// rebase the refs with zero uploads; a per-image failure keeps the ref;
// and a malformed wrapper parses to null (the handler falls to turndown).
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

import type { ChanClipboardContext } from "./copy_html";
import { applyChanHtmlPaste, parseChanWrapper } from "./paste_html";

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
