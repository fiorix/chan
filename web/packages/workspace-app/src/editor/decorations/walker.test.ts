// @vitest-environment jsdom

// The decoration walker recomputes on a geometry change as well as on doc,
// viewport and selection changes. Editor tabs remount on a tab switch, the
// remounted view walks its pre-layout viewport, and the settle that corrects
// the viewport can report only a geometry change; without the recompute the
// lower blocks keep their raw markdown until a caret move or a scroll.

import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { afterEach, describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { decorationWalker } from "./walker";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

/// A walker counting its walks, and the view it runs in.
function counted(): { view: EditorView; walks: () => number; plugin: { update(u: ViewUpdate): void } } {
  let walks = 0;
  const walker = decorationWalker({
    Paragraph: () => {
      walks += 1;
    },
  });
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "one paragraph\n", extensions: [chanMarkdown(), walker] }),
  });
  views.push(view);
  const plugin = view.plugin(walker as ViewPlugin<{ update(u: ViewUpdate): void }>);
  if (!plugin) throw new Error("walker plugin not installed");
  return { view, walks: () => walks, plugin };
}

/// An update that changed nothing but what `changed` names.
function update(view: EditorView, changed: Partial<ViewUpdate>): ViewUpdate {
  return {
    view,
    state: view.state,
    docChanged: false,
    viewportChanged: false,
    selectionSet: false,
    geometryChanged: false,
    ...changed,
  } as ViewUpdate;
}

describe("the decoration walker", () => {
  test("walks again on a geometry-only change", () => {
    const { view, walks, plugin } = counted();
    const before = walks();

    plugin.update(update(view, { geometryChanged: true }));
    expect(walks()).toBe(before + 1);
  });

  test("does not walk for an update that changed nothing it reads", () => {
    const { view, walks, plugin } = counted();
    const before = walks();

    plugin.update(update(view, {}));
    expect(walks()).toBe(before);
  });
});
