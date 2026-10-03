// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ChanClipboardContext } from "./copy_html";
import { pasteHandler } from "./paste_html";

const notify = vi.fn();

vi.mock("turndown", () => ({
  default: class {
    constructor() {
      throw new Error("converter unavailable");
    }
  },
}));
vi.mock("../api/client", () => ({
  api: { uploadAttachment: vi.fn() },
  withTokenQuery: (path: string) => path,
}));
vi.mock("./bubbles/image", () => ({ invalidateImageCatalog: vi.fn() }));
vi.mock("../state/notify.svelte", () => ({ notify: (message: string) => notify(message) }));

const ctx: ChanClipboardContext = {
  getWorkspaceRoot: () => "/destination",
  getCurrentPath: () => "notes/a.md",
  getUploadDir: () => { throw new Error("upload context unavailable"); },
};

describe("failed rich paste", () => {
  test.each([
    ["rich HTML", "<p><strong>rich</strong></p>"],
    ["chan wrapper", '<div data-chan-markdown="rich" data-chan-workspace="/source"></div>'],
  ])("pastes the captured plain text without a notice for %s", async (_label, html) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const { doc, from, to, text, expected, anchor } of [
        { doc: "", from: 0, to: 0, text: "hello", expected: "hello", anchor: 5 },
        { doc: "- replace tail", from: 2, to: 9, text: "- hello", expected: "- hello tail", anchor: 7 },
        { doc: "keep", from: 0, to: 4, text: "", expected: "keep", anchor: 4 },
      ]) {
        notify.mockClear();
        warn.mockClear();
        const view = new EditorView({
          state: EditorState.create({
            doc,
            selection: { anchor: from, head: to },
            extensions: [pasteHandler(ctx)],
          }),
        });
        try {
          let readable = true;
          const event = new Event("paste", { bubbles: true, cancelable: true });
          Object.defineProperty(event, "clipboardData", { value: {
            items: [],
            getData: (format: string) => {
              if (!readable) throw new Error("clipboard data expired");
              return format === "text/html" ? html : text;
            },
          } });
          view.contentDOM.dispatchEvent(event);
          readable = false;
          expect(event.defaultPrevented).toBe(true);
          await vi.waitFor(() => expect(view.state.doc.toString()).toBe(expected));
          await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
          expect(view.state.selection.main.head).toBe(anchor);
          expect(notify).not.toHaveBeenCalled();
        } finally {
          view.destroy();
        }
      }
    } finally {
      warn.mockRestore();
    }
  });
});
