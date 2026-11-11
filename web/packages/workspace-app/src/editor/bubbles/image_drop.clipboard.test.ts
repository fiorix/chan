import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import * as desktop from "../../api/desktop";
import { dispatchTrusted } from "../../__tests__/trustedEvent";
import { setNotifyHandler } from "../../state/notify.svelte";
import { imageDropHandlers, nativePasteShape } from "./image_drop";

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const views: EditorView[] = [];
let notices: string[];

beforeEach(() => {
  notices = [];
  setNotifyHandler((message) => notices.push(message));
  vi.spyOn(desktop, "isTauriDesktop").mockReturnValue(true);
  vi.spyOn(desktop, "readClipboardImage").mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.spyOn(api, "uploadAttachment").mockResolvedValue({ path: "notes/pasted-image.png" });
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function editor(getUploadDir: () => string | null = () => "notes"): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: "tail\n",
      extensions: imageDropHandlers({
        getUploadDir,
        getCurrentPath: () => `${getUploadDir()}/note.md`,
      }),
    }),
  });
  Object.defineProperty(view, "hasFocus", { get: () => true, configurable: true });
  views.push(view);
  return view;
}

function paste(view: EditorView, data: Record<string, unknown> = {}, opts: { trusted?: boolean } = {}): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { types: ["Files"], items: [], files: [], getData: () => "", ...data },
  });
  if (opts.trusted) dispatchTrusted(view.contentDOM, event);
  else view.contentDOM.dispatchEvent(event);
  return event;
}

/// WebKitGTK's paste of an image: trusted, with no types, items or files.
const EMPTY = { types: [], items: [], files: [] };

describe("desktop image paste with no webview file payload", () => {
  test("reads the native image and uploads it once as PNG", async () => {
    const view = editor();
    const event = paste(view);

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(
      "![](./pasted-image.png#w=250)\ntail\n",
    ));
    expect(event.defaultPrevented).toBe(true);
    expect(desktop.readClipboardImage).toHaveBeenCalledTimes(1);
    expect(api.uploadAttachment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "pasted-image.png", type: "image/png", size: 3 }),
      "notes",
    );
    expect(notices).toEqual([]);
  });

  test("tracks the paste position and destination while the native read is pending", async () => {
    let finishRead!: (bytes: Uint8Array) => void;
    vi.mocked(desktop.readClipboardImage).mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
    let dir = "notes";
    const view = editor(() => dir);
    paste(view);
    view.dispatch({ changes: { from: 0, insert: "typed " } });
    dir = "elsewhere";
    finishRead(new Uint8Array([1]));

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(
      "typed ![](./pasted-image.png#w=250)\ntail\n",
    ));
    expect(api.uploadAttachment).toHaveBeenCalledExactlyOnceWith(expect.any(File), "notes");
  });

  test.each([null, new Uint8Array()])("reports an empty native image (%s)", async (bytes) => {
    vi.mocked(desktop.readClipboardImage).mockResolvedValue(bytes);
    const view = editor();
    paste(view);

    await vi.waitFor(() => expect(notices).toEqual(["No image found on the clipboard"]));
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("tail\n");
  });

  test("reports a rejected native read without uploading or editing", async () => {
    vi.mocked(desktop.readClipboardImage).mockRejectedValue(new Error("IPC refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const view = editor();
    paste(view);

    await vi.waitFor(() => expect(notices).toEqual(["Could not read image from the clipboard"]));
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("tail\n");
  });

  test("does not read or upload without an open document", () => {
    paste(editor(() => null));
    expect(notices).toEqual(["Open or create a document first"]);
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  test("does not upload when the editor closes during the native read", async () => {
    let finishRead!: (bytes: Uint8Array) => void;
    const read = new Promise<Uint8Array>((resolve) => { finishRead = resolve; });
    vi.mocked(desktop.readClipboardImage).mockReturnValue(read);
    const view = editor();
    paste(view);
    expect(desktop.readClipboardImage).toHaveBeenCalledTimes(1);
    view.destroy();
    finishRead(new Uint8Array([1]));
    await read;
    // Drain the read, conversion and upload continuations if wrongly started.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("tail\n");
  });
});

describe("desktop image paste that hands the page nothing at all", () => {
  test("reads the native image for a trusted empty paste and uploads it once as PNG", async () => {
    const view = editor();
    const event = paste(view, EMPTY, { trusted: true });

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(
      "![](./pasted-image.png#w=250)\ntail\n",
    ));
    expect(event.defaultPrevented).toBe(true);
    expect(desktop.readClipboardImage).toHaveBeenCalledTimes(1);
    expect(api.uploadAttachment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "pasted-image.png", type: "image/png", size: 3 }),
      "notes",
    );
    expect(notices).toEqual([]);
  });

  test("leaves an empty paste a script dispatched alone", () => {
    const view = editor();
    const event = paste(view, EMPTY);
    expect(event.isTrusted).toBe(false);
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("tail\n");
  });

  test.each([null, new Uint8Array()])("says nothing when the clipboard holds no image (%s)", async (bytes) => {
    vi.mocked(desktop.readClipboardImage).mockResolvedValue(bytes);
    const view = editor();
    paste(view, EMPTY, { trusted: true });

    await vi.waitFor(() => expect(desktop.readClipboardImage).toHaveBeenCalledTimes(1));
    // Drain the read's continuation before judging that nothing followed it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notices).toEqual([]);
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("tail\n");
  });

  test("reports a rejected native read of a trusted empty paste", async () => {
    vi.mocked(desktop.readClipboardImage).mockRejectedValue(new Error("IPC refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const view = editor();
    paste(view, EMPTY, { trusted: true });

    await vi.waitFor(() => expect(notices).toEqual(["Could not read image from the clipboard"]));
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  test("pastes a trusted text paste as text", () => {
    const view = editor();
    paste(view, {
      types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? "hello " : "",
    }, { trusted: true });
    expect(view.state.doc.toString()).toBe("hello tail\n");
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
  });

  test("never reads the native clipboard for a trusted empty paste in a browser", () => {
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    const view = editor();
    paste(view, EMPTY, { trusted: true });
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("tail\n");
  });
});

describe("ordinary clipboard payloads", () => {
  test("uses an exposed image file without also reading the native clipboard", async () => {
    const image = new File(["png"], "original.png", { type: "image/png" });
    const view = editor();
    paste(view, {
      items: [{ kind: "file", type: image.type, getAsFile: () => image }],
      files: [image],
    });
    await vi.waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledExactlyOnceWith(image, "notes"));
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
  });

  test.each([false, true])("pastes text normally when Files is also advertised: %s", (withFiles) => {
    const view = editor();
    paste(view, {
      types: withFiles ? ["Files", "text/plain"] : ["text/plain"],
      getData: (type: string) => type === "text/plain" ? "hello " : "",
    });
    expect(view.state.doc.toString()).toBe("hello tail\n");
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  test("leaves non-image file pastes alone", () => {
    const file = new File(["text"], "note.txt", { type: "text/plain" });
    const view = editor();
    paste(view, {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      files: [file],
    });
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("tail\n");
  });

  test("never invokes native clipboard access in a browser", () => {
    vi.mocked(desktop.isTauriDesktop).mockReturnValue(false);
    const view = editor();
    paste(view);
    expect(desktop.readClipboardImage).not.toHaveBeenCalled();
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("tail\n");
  });
});

describe("nativePasteShape", () => {
  const file = new File(["png"], "a.png", { type: "image/png" });
  test.each([
    ["WKWebView's Files with nothing exposed", false, { types: ["Files"], items: [], files: [] }, "files"],
    ["WKWebView's Files, trusted", true, { types: ["Files"], items: [], files: [] }, "files"],
    ["WebKitGTK's trusted empty paste", true, { types: [], items: [], files: [] }, "empty"],
    ["an untrusted empty paste", false, { types: [], items: [], files: [] }, null],
    ["a trusted text paste", true, { types: ["text/plain"], items: [], files: [] }, null],
    ["Files beside text", true, { types: ["Files", "text/plain"], items: [], files: [] }, null],
    ["an accessible file item", true, { types: [], items: [{ kind: "file" }], files: [] }, null],
    ["an accessible file", true, { types: ["Files"], items: [], files: [file] }, null],
    ["an unknown type alone", true, { types: ["application/x-other"], items: [], files: [] }, null],
  ])("%s", (_name, isTrusted, clipboard, expected) => {
    expect(nativePasteShape({ isTrusted }, clipboard as unknown as DataTransfer)).toBe(expected);
  });
});
