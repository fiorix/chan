// @vitest-environment jsdom
//
// A picker the user closed stays closed while the caret stays in the trigger
// that opened it: the next keystroke there changes the query, and without a
// memory of the dismissal it would open the picker again at once.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: { ...actual.api, linkTargets: vi.fn(async () => []), list: vi.fn(async () => []) },
  };
});

import { installEditorDom, mountWysiwyg, press, settle, unmountWysiwygs } from "../__tests__/wysiwyg";

installEditorDom();

afterEach(() => {
  unmountWysiwygs();
  document.body.innerHTML = "";
});

function picker(): Element | null {
  return document.body.querySelector(".md-wiki-bubble");
}

async function openPicker(doc: string) {
  const mounted = await mountWysiwyg({ value: doc, currentPath: "notes/a.md" });
  mounted.view.dispatch({ selection: { anchor: doc.length } });
  await settle();
  expect(picker(), "the trigger opens the picker").not.toBeNull();
  return mounted;
}

describe("a picker closed with Escape", () => {
  test("stays closed when the next keystroke lands in the same trigger", async () => {
    const { view, content } = await openPicker("see [[ab");
    press(content, "Escape");
    await settle();
    expect(picker()).toBeNull();

    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: "c" }, selection: { anchor: end + 1 } });
    await settle();
    expect(picker()).toBeNull();
  });

  test("opens again for a new trigger", async () => {
    const { view, content } = await openPicker("see [[ab");
    press(content, "Escape");
    await settle();

    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: "]] and [[x" }, selection: { anchor: end + 10 } });
    await settle();
    expect(picker()).not.toBeNull();
  });
});
