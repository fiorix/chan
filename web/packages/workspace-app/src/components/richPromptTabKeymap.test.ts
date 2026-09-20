// @vitest-environment jsdom
// R4: Tab in the Rich Prompt composer must NEVER escape to the browser's focus
// nav. On a plain (non-list) line it indents (indentMore) and consumes the key,
// unlike a plain Wysiwyg file editor where Tab is allowed to move focus.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";

const writeSpy = vi.fn(async (_p: string, _c: string) => ({}) as unknown);
const readMock = vi.fn(async (_p: string) => ({ content: "" }) as unknown);
const createDraftMock = vi.fn(async () => ({ path: ".Drafts/t/draft.md" }));

vi.mock("../api/client", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      createDraft: () => createDraftMock(),
      read: (p: string) => readMock(p),
      write: (p: string, c: string) => writeSpy(p, c),
    },
  };
});

import RichPrompt from "./RichPrompt.svelte";
import { richPrompt } from "../state/richPrompt.svelte";
import type { TerminalTab } from "../state/tabs.svelte";

const mounted: Array<Record<string, unknown>> = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  richPrompt.byTab = {};
});
beforeEach(() => {
  readMock.mockResolvedValue({ content: "" } as unknown);
});

function makeTab(over: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal",
    id: "term-1",
    title: "t",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    richPromptDraftPath: ".Drafts/t/draft.md",
    ...over,
  } as TerminalTab;
}

async function mountRP(tab: TerminalTab, draft: string): Promise<EditorView> {
  readMock.mockResolvedValue({ content: draft } as unknown);
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(RichPrompt, { target, props: { tab } }) as Record<string, unknown>);
  for (let i = 0; i < 20 && !target.querySelector(".cm-content"); i++) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector(".cm-content") as HTMLElement;
  const view = EditorView.findFromDOM(content)!;
  for (let i = 0; i < 20 && view.state.doc.toString() !== draft; i++) {
    await tick();
    await Promise.resolve();
  }
  return view;
}

function press(view: EditorView, key: string, mods: Partial<KeyboardEventInit> = {}): boolean {
  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  });
  view.contentDOM.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe("R4: Tab never escapes the Rich Prompt composer", () => {
  test("Tab on a plain line is consumed and indents (does not escape)", async () => {
    const view = await mountRP(makeTab(), "plain paragraph text");
    view.dispatch({ selection: { anchor: 5 } });
    const before = view.state.doc.toString();
    const consumed = press(view, "Tab");
    await tick();
    expect(consumed).toBe(true); // CM6 preventDefault -> no focus-nav escape
    expect(view.state.doc.toString()).not.toBe(before); // indent inserted
  });

  test("Shift-Tab on a plain line is also consumed (never escapes)", async () => {
    const view = await mountRP(makeTab(), "plain paragraph text");
    view.dispatch({ selection: { anchor: 5 } });
    const consumed = press(view, "Tab", { shiftKey: true });
    await tick();
    expect(consumed).toBe(true);
  });
});
