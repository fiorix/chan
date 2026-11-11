// A file dropped from another application on the Linux desktop: WebKitGTK
// hands the page a drop listing `text/uri-list` with no Files and keeps the
// list itself from the page, and the desktop, which saw the drop, reads its
// image files for the page.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import * as desktop from "../../api/desktop";
import { setNotifyHandler } from "../../state/notify.svelte";
import { imageDropHandlers } from "./image_drop";

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const views: EditorView[] = [];
let notices: string[];

beforeEach(() => {
  notices = [];
  setNotifyHandler((message) => notices.push(message));
  vi.spyOn(desktop, "isTauriDesktop").mockReturnValue(true);
  vi.spyOn(desktop, "listDroppedFiles").mockResolvedValue(["shot one.png"]);
  vi.spyOn(desktop, "readDroppedFile").mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.spyOn(api, "uploadAttachment").mockImplementation(async (file) => ({ path: `notes/${file.name}` }));
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function editor(): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "head\ntail\n",
      selection: { anchor: 0 },
      extensions: imageDropHandlers({
        getUploadDir: () => "notes",
        getCurrentPath: () => "notes/note.md",
      }),
    }),
  });
  // jsdom has no layout: the pointer is over the start of "tail", away from
  // the caret at 0.
  vi.spyOn(view, "posAtCoords").mockReturnValue(5);
  views.push(view);
  return view;
}

/// jsdom has no DragEvent; the handler reads `dataTransfer`, and the drop
/// point comes from the stubbed `posAtCoords`. By default the drop is
/// WebKitGTK's: `text/uri-list` listed, its list kept from the page.
function drop(view: EditorView, opts: { uriList?: string; files?: File[]; types?: string[] } = {}): Event {
  const files = opts.files ?? [];
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: opts.types ?? (files.length ? ["Files"] : ["text/uri-list", "text/html"]),
      files,
      items: [],
      getData: (type: string) => (type === "text/uri-list" ? (opts.uriList ?? "") : ""),
    },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("a desktop drop whose files the page cannot read", () => {
  test("reads the image through the desktop and embeds it where it was dropped", async () => {
    const view = editor();
    const event = drop(view);

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(
      "head\n![](./shot%20one.png#w=250)\ntail\n",
    ));
    expect(event.defaultPrevented).toBe(true);
    expect(desktop.listDroppedFiles).toHaveBeenCalledTimes(1);
    expect(desktop.readDroppedFile).toHaveBeenCalledExactlyOnceWith(0);
    expect(api.uploadAttachment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "shot one.png", type: "image/png", size: 3 }),
      "notes",
    );
    expect(notices).toEqual([]);
  });

  test("reads only the drop's images, by their places in the list", async () => {
    vi.mocked(desktop.listDroppedFiles).mockResolvedValue(["notes.txt", "c.GIF", "d.webp"]);
    const view = editor();
    drop(view);
    await vi.waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(2));
    expect(vi.mocked(desktop.readDroppedFile).mock.calls).toEqual([[1], [2]]);
    expect(api.uploadAttachment).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: "c.GIF", type: "image/gif" }), "notes");
    expect(api.uploadAttachment).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: "d.webp", type: "image/webp" }), "notes");
  });

  test("names a file the desktop refuses and still lands the others", async () => {
    vi.mocked(desktop.listDroppedFiles).mockResolvedValue(["a.jpg", "b.webp"]);
    vi.mocked(desktop.readDroppedFile).mockImplementation(async (index) => {
      if (index === 1) throw "no such file was just dropped on this window";
      return new Uint8Array([7]);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const view = editor();
    drop(view);

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("head\n![](./a.jpg#w=250)\ntail\n"));
    expect(notices).toEqual(["Could not read b.webp; skipped"]);
  });

  test("says so when the desktop cannot list the drop", async () => {
    vi.mocked(desktop.listDroppedFiles).mockRejectedValue("Command dropped_files not allowed by ACL");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const view = editor();
    drop(view);
    await vi.waitFor(() => expect(notices).toEqual(["Could not read the dropped files"]));
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("head\ntail\n");
  });

  test("lands nothing for a drop without images", async () => {
    vi.mocked(desktop.listDroppedFiles).mockResolvedValue(["notes.txt"]);
    const view = editor();
    const event = drop(view);
    await vi.waitFor(() => expect(desktop.listDroppedFiles).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(event.defaultPrevented).toBe(true);
    expect(desktop.readDroppedFile).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("head\ntail\n");
    expect(notices).toEqual([]);
  });

  test("takes a drop that names file URIs too", async () => {
    const view = editor();
    drop(view, { uriList: "file:///home/me/shot%20one.png\r\n" });
    await vi.waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1));
  });

  test.each([
    ["a link from a browser", { uriList: "https://example.com/a.png" }],
    ["a drag with no URI list", { types: ["text/plain"] }],
  ])("leaves %s to the editor's default", (_name, opts) => {
    const view = editor();
    drop(view, opts);
    expect(desktop.listDroppedFiles).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  test("never asks the desktop in a browser", () => {
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    const view = editor();
    drop(view);
    expect(desktop.listDroppedFiles).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  test("takes a drop's Files without asking the desktop", async () => {
    const image = new File(["png"], "given.png", { type: "image/png" });
    const view = editor();
    drop(view, { files: [image] });
    await vi.waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledExactlyOnceWith(image, "notes"));
    expect(desktop.listDroppedFiles).not.toHaveBeenCalled();
  });
});
