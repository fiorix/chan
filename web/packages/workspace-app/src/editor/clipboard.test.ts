// @vitest-environment jsdom
//
// The editors' body-menu Copy and Cut. Both write the selection through one
// chain: the rich HTML and plain flavors when the WYSIWYG editor's context
// finds a workspace image in it, else (or when that write fails) the plain
// text through the app's UI copy, native on the desktop. A failed write says
// so, and a Cut then keeps its text.

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const rich = vi.hoisted(() => ({ write: vi.fn(async (_markdown: string, _ctx: unknown) => {}) }));
vi.mock("./copy_html", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./copy_html")>()),
  writeDocSelectionToClipboard: rich.write,
}));

import { copySelection, cutSelection } from "./clipboard";
import type { ChanClipboardContext } from "./copy_html";
import { setNotifyHandler } from "../state/notify.svelte";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

const views: EditorView[] = [];
let notes: string[] = [];
let writeText: ReturnType<typeof vi.fn>;

const CTX: ChanClipboardContext = {
  getCurrentPath: () => "notes/a.md",
  getUploadDir: () => "notes",
  getWorkspaceRoot: () => "/ws",
};
const WITH_IMAGE = "see ![a](pic.png) here";

beforeEach(() => {
  notes = [];
  setNotifyHandler((msg) => notes.push(msg));
  writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  rich.write.mockReset();
  rich.write.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
  delete (window as W).__TAURI_INTERNALS__;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  vi.restoreAllMocks();
});

function editor(doc: string, from: number, to: number): EditorView {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to) }),
  });
  views.push(view);
  return view;
}

describe("Copy", () => {
  test("writes the selection as plain text", async () => {
    await copySelection(editor("hello world", 0, 5));

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(notes).toEqual([]);
  });

  test("writes nothing for an empty selection", async () => {
    await copySelection(editor("hello world", 2, 2), CTX);

    expect(writeText).not.toHaveBeenCalled();
    expect(rich.write).not.toHaveBeenCalled();
  });

  test("says so when the write is refused", async () => {
    writeText.mockRejectedValue(new Error("Write permission denied."));

    await copySelection(editor("hello world", 0, 5));

    expect(notes).toEqual(["Couldn't copy to clipboard"]);
  });

  test("writes the rich flavors for a selection holding a workspace image", async () => {
    await copySelection(editor(WITH_IMAGE, 0, WITH_IMAGE.length), CTX);

    expect(rich.write).toHaveBeenCalledWith(WITH_IMAGE, CTX);
    expect(writeText).not.toHaveBeenCalled();
  });

  test("falls back to plain text when the rich write fails", async () => {
    rich.write.mockRejectedValue(new Error("image fetch failed"));

    await copySelection(editor(WITH_IMAGE, 0, WITH_IMAGE.length), CTX);

    expect(writeText).toHaveBeenCalledWith(WITH_IMAGE);
    expect(notes).toEqual([]);
  });

  test("writes plain text without a rich context, image or not", async () => {
    await copySelection(editor(WITH_IMAGE, 0, WITH_IMAGE.length));

    expect(rich.write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(WITH_IMAGE);
  });
});

describe("Cut", () => {
  test("writes the selection, deletes it and leaves the caret where it started", async () => {
    const view = editor("hello world", 0, 6);

    await cutSelection(view);

    expect(writeText).toHaveBeenCalledWith("hello ");
    expect(view.state.doc.toString()).toBe("world");
    expect(view.state.selection.main.head).toBe(0);
  });

  test("does nothing for an empty selection", async () => {
    const view = editor("hello world", 2, 2);

    await cutSelection(view, CTX);

    expect(writeText).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("hello world");
  });

  test("keeps the text and says so when the write is refused", async () => {
    writeText.mockRejectedValue(new Error("Write permission denied."));
    const view = editor("hello world", 0, 6);

    await cutSelection(view);

    expect(view.state.doc.toString()).toBe("hello world");
    expect(notes).toEqual(["Couldn't copy to clipboard"]);
  });

  test("writes the rich flavors for a selection holding a workspace image, then deletes it", async () => {
    const view = editor(WITH_IMAGE, 0, WITH_IMAGE.length);

    await cutSelection(view, CTX);

    expect(rich.write).toHaveBeenCalledWith(WITH_IMAGE, CTX);
    expect(writeText).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("");
  });

  test("falls back to plain text when the rich write fails, then deletes", async () => {
    rich.write.mockRejectedValue(new Error("image fetch failed"));
    const view = editor(WITH_IMAGE, 0, WITH_IMAGE.length);

    await cutSelection(view, CTX);

    expect(writeText).toHaveBeenCalledWith(WITH_IMAGE);
    expect(view.state.doc.toString()).toBe("");
  });
});

describe("in a browser without the Clipboard API", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });

  test("Copy says it could not copy", async () => {
    await copySelection(editor("hello world", 0, 5));

    expect(notes).toEqual(["Couldn't copy to clipboard"]);
  });

  test("Cut says it could not copy and keeps the text", async () => {
    const view = editor("hello world", 0, 6);

    await cutSelection(view);

    expect(notes).toEqual(["Couldn't copy to clipboard"]);
    expect(view.state.doc.toString()).toBe("hello world");
  });
});

describe("on the desktop, where the webview has no Clipboard API", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  });

  test("Copy writes the selection through the native clipboard", async () => {
    const invoke = vi.fn(async () => undefined);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });

    await copySelection(editor("hello world", 0, 5));

    expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "hello" });
    expect(notes).toEqual([]);
  });

  test("Cut writes the selection through the native clipboard and deletes it", async () => {
    const invoke = vi.fn(async () => undefined);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
    const view = editor("hello world", 0, 6);

    await cutSelection(view);

    expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "hello " });
    expect(view.state.doc.toString()).toBe("world");
  });
});
