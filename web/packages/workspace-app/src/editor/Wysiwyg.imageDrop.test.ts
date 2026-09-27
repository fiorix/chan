import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import { installEditorDom } from "../__tests__/wysiwyg";
import WysiwygReadonlyHost from "../__tests__/WysiwygReadonlyHost.svelte";

installEditorDom();
const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) unmount(editor);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("pending image positions", () => {
  test("keeps the upload anchor across read-only toggles", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const editor = mount(WysiwygReadonlyHost, { target });
    mounted.push(editor);
    flushSync();
    const view = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-content")!)!;
    expect(view).toBeDefined();
    Object.defineProperty(view, "hasFocus", { get: () => true, configurable: true });
    let finishUpload!: (result: { path: string }) => void;
    const pending = new Promise<{ path: string }>((resolve) => { finishUpload = resolve; });
    let startUpload!: () => void;
    const started = new Promise<void>((resolve) => { startUpload = resolve; });
    vi.spyOn(api, "uploadAttachment").mockImplementationOnce(() => {
      startUpload();
      return pending;
    });
    const file = new File(["image"], "photo.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] },
    });
    view.contentDOM.dispatchEvent(event);
    await started;

    editor.setReadonly(true);
    flushSync();
    expect(view.state.facet(EditorView.editable)).toBe(false);
    view.dispatch({ changes: { from: 0, insert: "before\n" } });
    editor.setReadonly(false);
    flushSync();
    expect(view.state.facet(EditorView.editable)).toBe(true);
    view.dispatch({ changes: { from: 0, insert: "after\n" } });
    finishUpload({ path: "notes/photo.png" });

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe(
      "after\nbefore\n![](./photo.png#w=250)\ntail\n",
    ));
  });
});
