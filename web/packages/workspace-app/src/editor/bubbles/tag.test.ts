// @vitest-environment jsdom
//
// What the tag bubble says when the workspace has no tags: it asked, and
// there are none, rather than loading for ever.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...actual.api, graph: vi.fn(async () => ({ nodes: [], edges: [] })) } };
});

import { openTagBubble } from "./tag";

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const views: EditorView[] = [];
const handles: Array<{ dismiss(): void }> = [];

afterEach(() => {
  for (const h of handles.splice(0)) h.dismiss();
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = "";
});

async function openOn(typed: string): Promise<void> {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: typed, selection: { anchor: typed.length } }),
    parent,
  });
  views.push(view);
  handles.push(
    openTagBubble({
      view,
      triggerStart: 0,
      triggerEnd: typed.length,
      initialQuery: typed.slice(1),
      onDismiss: () => {},
    }),
  );
  await new Promise((r) => setTimeout(r, 0));
}

function status(): string {
  return document.querySelector(".md-tag-bubble .md-bubble-status")?.textContent ?? "";
}

describe("the tag bubble in a workspace with no tags", () => {
  test.each(["#", "#pro"])("says there are none once it has asked (%s)", async (typed) => {
    await openOn(typed);
    await vi.waitFor(() => expect(status()).toBe("No tags"));
  });
});
