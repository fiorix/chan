// @vitest-environment jsdom
//
// The Rich Prompt card's chrome: the close button hides the card and keeps
// the draft; the editor's style toolbar floats over the text area while the
// terminal's toggle is on, without the image button, with the first row moved
// below it; the source toggle's chord swaps the rendered editor for the source
// one and back, keeps the text, hands the keyboard to the editor it mounts,
// and reaches nothing beyond the card. RichPrompt is mounted with its draft
// api stubbed; the assertions read the DOM, the draft writes and the state.

import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const draft = vi.hoisted(() => ({ content: "", writes: [] as string[] }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      createDraft: vi.fn(async () => ({ path: draftPath("chrome") })),
      read: vi.fn(async () => ({ content: draft.content })),
      write: vi.fn(async (_path: string, content: string) => {
        draft.writes.push(content);
        return {};
      }),
    },
  };
});

import RichPrompt from "./RichPrompt.svelte";
import {
  isRichPromptSource,
  isRichPromptVisible,
  richPrompt,
  setRichPromptToolbarOpen,
  showRichPromptForTab,
} from "../state/richPrompt.svelte";
import { assignOverride, clearOverride } from "../state/keymapOverrides.svelte";
import type { TerminalTab } from "../state/tabs.svelte";
import { installEditorDom, settle } from "../__tests__/wysiwyg";
import { draftPath } from "../__tests__/drafts";

installEditorDom();

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
const mounted: Array<Record<string, unknown>> = [];
let tab: TerminalTab;

beforeEach(() => {
  tab = {
    kind: "terminal",
    id: "term-chrome",
    title: "t",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    richPromptDraftPath: draftPath("chrome"),
  } as TerminalTab;
  draft.content = "Ask **twice**.";
  draft.writes = [];
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  richPrompt.byTab = {};
  richPrompt.toolbarByTab = {};
  richPrompt.sourceByTab = {};
  vi.restoreAllMocks();
});

async function waitFor(target: ParentNode, selector: string): Promise<HTMLElement> {
  for (let i = 0; i < 40; i += 1) {
    const el = target.querySelector<HTMLElement>(selector);
    if (el) return el;
    await tick();
    await Promise.resolve();
  }
  throw new Error(`never rendered: ${selector}`);
}

async function mountCard(): Promise<HTMLElement> {
  showRichPromptForTab(tab.id);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(RichPrompt, { target, props: { tab, focused: true } }) as Record<string, unknown>);
  await waitFor(target, ".cm-content");
  await settle();
  return target;
}

/// The card's toolbar, expanded as a hover or a tap on its pill expands it.
async function expandedToolbar(target: HTMLElement): Promise<HTMLElement> {
  const toolbar = target.querySelector<HTMLElement>(".rich-prompt [role='toolbar']");
  expect(toolbar, "the card shows the toolbar").not.toBeNull();
  toolbar!.querySelector(".expand-zone")!.dispatchEvent(new MouseEvent("mouseenter"));
  await tick();
  return toolbar!;
}

function text(content: HTMLElement): string {
  return EditorView.findFromDOM(content)!.state.doc.toString();
}

describe("the close button", () => {
  test("hides the card and keeps the draft", async () => {
    const target = await mountCard();
    const close = target.querySelector<HTMLButtonElement>("button[aria-label='Close Rich Prompt']");
    expect(close, "the card has a close button").not.toBeNull();
    close!.click();
    await settle();
    expect(isRichPromptVisible(tab.id)).toBe(false);
    expect(draft.writes.at(-1), "the draft is written as it stands").toBe("Ask **twice**.");
  });
});

describe("the style toolbar", () => {
  test("floats over the text area while turned on, without image insertion", async () => {
    setRichPromptToolbarOpen(tab.id, true);
    const target = await mountCard();
    const toolbar = await expandedToolbar(target);
    expect(toolbar.querySelector("button[aria-label='insert image']")).toBeNull();
    expect(toolbar.querySelector("button[aria-label='bold']")).not.toBeNull();
    expect(toolbar.querySelector("button[aria-label='show source']")).not.toBeNull();
  });

  test("moves the first row down while turned on, and the card is as before while off", async () => {
    const off = await mountCard();
    expect(off.querySelector(".rich-prompt [role='toolbar']")).toBeNull();
    expect(off.querySelector<HTMLElement>(".rp-editor")!.style.getPropertyValue("--editor-top-pad")).toBe("");

    setRichPromptToolbarOpen(tab.id, true);
    await settle();
    expect(off.querySelector<HTMLElement>(".rp-editor")!.style.getPropertyValue("--editor-top-pad")).toBe("2.5rem");
  });

  test("greys its formatting while a message is pending and keeps the source toggle", async () => {
    setRichPromptToolbarOpen(tab.id, true);
    tab.pendingPrompt = { id: "m-1", phase: "queued" };
    const target = await mountCard();
    const toolbar = await expandedToolbar(target);
    expect(toolbar.querySelector<HTMLButtonElement>("button[aria-label='bold']")!.disabled).toBe(true);
    expect(toolbar.querySelector<HTMLButtonElement>("button[aria-label='show source']")!.disabled).toBe(false);
  });
});

describe.each([
  ["macOS", MAC, { metaKey: true }],
  ["Linux", LINUX, { ctrlKey: true }],
])("the source toggle's chord on %s", (_os, userAgent, modifier) => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  });

  async function press(
    target: HTMLElement,
    keys: KeyboardEventInit = { key: "e", code: "KeyE" },
  ): Promise<KeyboardEvent> {
    const event = new KeyboardEvent("keydown", {
      ...keys,
      bubbles: true,
      cancelable: true,
      ...modifier,
    });
    target.querySelector<HTMLElement>(".cm-content")!.dispatchEvent(event);
    await settle();
    return event;
  }

  test("swaps to the source editor and back, keeping the text and the keyboard", async () => {
    const target = await mountCard();
    await press(target);
    expect(isRichPromptSource(tab.id)).toBe(true);
    const source = await waitFor(target, ".md-source .cm-content");
    expect(target.querySelector(".md-wysiwyg-cm6")).toBeNull();
    expect(text(source)).toBe("Ask **twice**.");
    expect(source.contains(document.activeElement), "the source editor has the keyboard").toBe(true);

    await press(target);
    const rendered = await waitFor(target, ".md-wysiwyg-cm6 .cm-content");
    expect(target.querySelector(".md-source")).toBeNull();
    expect(text(rendered)).toBe("Ask **twice**.");
    expect(rendered.contains(document.activeElement), "the rendered editor has the keyboard").toBe(true);
  });

  test("follows the chord the keymap assigns the toggle", async () => {
    assignOverride("app.editor.toggleMode", "Mod+Alt+Y");
    try {
      const target = await mountCard();
      await press(target);
      expect(isRichPromptSource(tab.id), "the built-in chord no longer swaps").toBe(false);
      await press(target, { key: "y", code: "KeyY", altKey: true });
      expect(isRichPromptSource(tab.id), "the assigned chord swaps").toBe(true);
      await waitFor(target, ".md-source .cm-content");
    } finally {
      clearOverride("app.editor.toggleMode");
    }
  });

  test("maps a caret at an image's edge into its URL, as a file tab does", async () => {
    draft.content = "![a](x.png)";
    const target = await mountCard();
    const rendered = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-content")!)!;
    rendered.dispatch({ selection: { anchor: draft.content.length } });
    await settle();
    await press(target);
    const source = EditorView.findFromDOM(await waitFor(target, ".md-source .cm-content"))!;
    await settle();
    expect(source.state.selection.main.head).toBe(draft.content.indexOf("x.png"));
  });

  test("flips a card whose message is pending", async () => {
    tab.pendingPrompt = { id: "m-1", phase: "queued" };
    const target = await mountCard();
    await press(target);
    expect(isRichPromptSource(tab.id)).toBe(true);
    await waitFor(target, ".md-source .cm-content");
  });

  test("reaches nothing beyond the card", async () => {
    const target = await mountCard();
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    try {
      const event = await press(target);
      expect(event.defaultPrevented).toBe(true);
      expect(heard).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", heard);
    }
  });
});
