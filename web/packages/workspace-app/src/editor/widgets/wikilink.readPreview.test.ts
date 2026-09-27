// @vitest-environment jsdom
//
// In read mode a click on a wiki pill previews the note the link names. A
// hand-written `[[Note]]` carries the note's stem, which the file route cannot
// read, so the preview reads the path the body menu's Preview reads for the
// same pill.

import { afterEach, describe, expect, test, vi } from "vitest";

const reads = vi.hoisted(() => [] as string[]);

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      // The workspace holds `Note.md`; the file route reads a path as it is
      // given and answers 404 for anything else.
      read: vi.fn(async (path: string) => {
        reads.push(path);
        if (path !== "Note.md") throw new Error("404 not found");
        return { path, content: "# Note" };
      }),
      resolveLink: vi.fn(async () => ({ path: "Note.md", kind: "file", is_dir: false })),
    },
  };
});

import { resolvePreviewTarget } from "../link_preview";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";

installEditorDom();

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  unmountWysiwygs();
  document.body.replaceChildren();
  reads.length = 0;
});

describe("a wiki pill in read mode", () => {
  test("previews the note its stem names", async () => {
    // The link does not start the document: a caret touching it would show
    // its source instead of the pill.
    const { target } = await mountWysiwyg({ value: "see [[Note]]", readonly: true });
    const pill = target.querySelector<HTMLElement>(".cm-md-wiki-pill");
    expect(pill?.dataset.target).toBe("Note");

    pill!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await settle();

    expect(reads).toEqual(["Note.md"]);
    expect(reads).toEqual([resolvePreviewTarget(pill!.dataset.target!)]);
    expect(document.querySelector(".md-preview-popover .md-preview-md")?.textContent).toBe("Note");
  });
});
