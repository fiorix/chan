// @vitest-environment jsdom

// The `-` (hyphen) and `1.` (ordered) list markers render as widgets that
// replace the marker text, not as a class on the text itself. A replacement
// puts a real DOM node in the line, which makes chan-desktop's WKWebView lay
// the line out again when the list decoration first applies; a class alone
// left a freshly typed `- ` or `1. ` without its hanging indent until an
// unrelated event forced a repaint. Blink and WebView2 repaint either way, so
// the tests read the decorations the walker produced rather than the pixels.

import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { afterEach, describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from ".";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

type Found = { from: number; to: number; widget?: WidgetType; cls?: string };

/// The decorations the walker put over [from, to) of `doc`, the caret left on
/// the first line so the list lines are decorated rather than shown as source.
function decorationsOver(doc: string, text: string): Found[] {
  const decorations = chanDecorations();
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({ doc, extensions: [chanMarkdown(), decorations] }),
  });
  views.push(view);
  const plugin = view.plugin(decorations as ViewPlugin<{ decorations: DecorationSet }>);
  if (!plugin) throw new Error("decorations not installed");
  const from = doc.indexOf(text);
  const to = from + text.length;
  const found: Found[] = [];
  plugin.decorations.between(from, to, (f, t, deco) => {
    if (f < to && t > from) {
      found.push({ from: f, to: t, widget: deco.spec.widget, cls: deco.spec.class });
    }
  });
  return found;
}

function widgetDom(found: Found[]): HTMLElement {
  const replacing = found.find((d) => d.widget instanceof WidgetType);
  expect(replacing, "a replacing widget covers the marker").toBeDefined();
  return replacing!.widget!.toDOM(undefined as unknown as EditorView);
}

describe("list markers", () => {
  test("a hyphen marker is replaced by a widget, not classed as text", () => {
    const found = decorationsOver("intro\n\n- hyphen item\n", "-");

    expect(found.some((d) => d.cls !== undefined && d.from <= 7 && d.to >= 8), "no mark on the `-`").toBe(false);
    const dom = widgetDom(found);
    expect(dom.classList.contains("cm-md-ul-hyphen")).toBe(true);
    expect(dom.textContent).toBe("-");
  });

  test("an ordered marker is replaced by a widget carrying the number", () => {
    const found = decorationsOver("intro\n\n1. first\n", "1.");

    const dom = widgetDom(found);
    expect(dom.classList.contains("cm-md-ol-marker")).toBe(true);
    expect(dom.textContent).toBe("1.");
  });
});
