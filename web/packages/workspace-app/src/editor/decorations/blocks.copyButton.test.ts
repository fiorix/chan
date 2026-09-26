// @vitest-environment jsdom
//
// A fenced code block wears a badge with a copy button. A click copies the
// block's body through the app's one UI copy (native on the desktop, the
// Clipboard API in a browser) and flashes the button: `copied` when the
// write landed, `copy-failed` when it did not.

import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { afterEach, describe, expect, test, vi } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from ".";

type W = Window & typeof globalThis & { __TAURI_INTERNALS__?: unknown };

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
  delete (window as W).__TAURI_INTERNALS__;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

/// The badge's copy button for the one fenced block in `doc`, rendered from
/// the widget the walker placed, the caret left on the first line so the
/// block is decorated rather than shown as source.
function copyButton(doc: string): HTMLButtonElement {
  const decorations = chanDecorations();
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({ doc, extensions: [chanMarkdown(), decorations] }),
  });
  views.push(view);
  const plugin = view.plugin(decorations as ViewPlugin<{ decorations: DecorationSet }>);
  if (!plugin) throw new Error("decorations not installed");
  let badge: HTMLElement | null = null;
  plugin.decorations.between(0, doc.length, (_from, _to, deco) => {
    const widget = deco.spec.widget as WidgetType | undefined;
    const dom = widget?.toDOM(view);
    if (dom?.classList.contains("cm-md-fence-badge")) badge = dom;
  });
  if (!badge) throw new Error("no fence badge");
  document.body.append(badge);
  const button = (badge as HTMLElement).querySelector<HTMLButtonElement>(".cm-md-fence-badge-copy");
  if (!button) throw new Error("no copy button on the badge");
  return button;
}

const DOC = "intro\n\n```js\nconst a = 1;\nconst b = 2;\n```\n";
const CODE = "const a = 1;\nconst b = 2;";

describe("the code block's copy button", () => {
  test("copies the block's body in a browser and flashes copied", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const button = copyButton(DOC);

    button.click();

    await vi.waitFor(() => expect(button.classList.contains("copied")).toBe(true));
    expect(writeText).toHaveBeenCalledWith(CODE);
  });

  test("copies through the native clipboard on the desktop", async () => {
    const invoke = vi.fn(async () => undefined);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
    const button = copyButton(DOC);

    button.click();

    await vi.waitFor(() => expect(button.classList.contains("copied")).toBe(true));
    expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: CODE });
  });

  test("flashes copy-failed in a browser without the Clipboard API", async () => {
    const button = copyButton(DOC);

    button.click();

    await vi.waitFor(() => expect(button.classList.contains("copy-failed")).toBe(true));
    expect(button.classList.contains("copied")).toBe(false);
  });

  test("flashes copy-failed when the browser refuses the write", async () => {
    const writeText = vi.fn(async () => Promise.reject(new Error("Write permission denied.")));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const button = copyButton(DOC);

    button.click();

    await vi.waitFor(() => expect(button.classList.contains("copy-failed")).toBe(true));
  });
});
