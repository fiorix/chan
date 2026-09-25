// @vitest-environment jsdom
//
// The editors' focus() export, which the tab host calls on a chord-driven tab
// switch, focuses the view and re-measures it, so decorations laid out while
// the tab was hidden (images among them) are evaluated again. Both editors are
// mounted and their exported focus() is called.

import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount, type ComponentProps } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import SourceComponent from "./Source.svelte";
import { installEditorDom, mountWysiwyg, unmountWysiwygs } from "../__tests__/wysiwyg";

installEditorDom();

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  unmountWysiwygs();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

type Focusable = { focus(): boolean };

describe("focus()", () => {
  test("in Wysiwyg focuses the view and re-measures it", async () => {
    const { view, editor } = await mountWysiwyg({ value: "![](photo.png)\n\ntext", autoFocus: false });
    const measure = vi.spyOn(view, "requestMeasure");
    const focus = vi.spyOn(view, "focus");

    expect((editor as unknown as Focusable).focus()).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalled();
  });

  test("in Source does the same", () => {
    const target = document.createElement("div");
    document.body.append(target);
    const editor = mount(SourceComponent, {
      target,
      props: { autoFocus: false, path: "note.md", value: "text" } as ComponentProps<typeof SourceComponent>,
    });
    mounted.push(editor);
    flushSync();
    const view = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-editor")!)!;
    const measure = vi.spyOn(view, "requestMeasure");
    const focus = vi.spyOn(view, "focus");

    expect((editor as unknown as Focusable).focus()).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalled();
  });
});
