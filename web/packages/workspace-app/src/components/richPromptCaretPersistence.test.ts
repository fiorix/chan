// @vitest-environment jsdom

// Rich Prompt caret / height / focus persistence. Two levers keep the
// composer's state alive: (1) TerminalTab keeps the bubble MOUNTED across
// tab switches (visibility-hidden like the terminal body), so the live
// EditorView carries caret/selection/undo through an active-flag flip; (2)
// the caret and drag-resized height are mirrored onto the TerminalTab
// record and serialized with the per-window session payload, so a reload or
// a cross-window restore reopens the composer where the user left it.

import { EditorView } from "@codemirror/view";
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

const draft = vi.hoisted(() => ({ content: "" }));
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      createDraft: vi.fn(async () => ({ path: ".Drafts/t/draft.md" })),
      read: vi.fn(async () => ({ content: draft.content })),
      write: vi.fn(async () => ({})),
    },
  };
});

import RichPrompt from "./RichPrompt.svelte";
import TerminalTabComponent from "./TerminalTab.svelte";
import { richPrompt, showRichPromptForTab } from "../state/richPrompt.svelte";
import { installEditorDom } from "../__tests__/wysiwyg";
import { installTerminalDom, mountTerminal, resetTerminals } from "../__tests__/terminalTab";
import {
  activePane,
  bumpTabFocusPulse,
  hydrateTerminalSessionsFromLayout,
  layout,
  restoreLayout,
  serializeLayout,
  setRichPromptCaret,
  setRichPromptHeight,
  type LeafNode,
  type TerminalTab,
} from "../state/tabs.svelte";

// The per-file caret index is a localStorage-backed store; mock it the same
// way tabs.test.ts does so importing the tabs store never touches storage.
vi.mock("../state/caretIndex");

function resetLayout(tabs: TerminalTab[]): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-rp-test",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

function terminalTab(partial: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal",
    id: "term-rp-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...partial,
  };
}

installTerminalDom();
installEditorDom();

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  resetTerminals();
  richPrompt.byTab = {};
  draft.content = "";
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/// Mount the composer for `tab` and wait for its editor.
async function composer(tab: TerminalTab, focused: boolean): Promise<{ target: HTMLElement; view: EditorView }> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(RichPrompt, { target, props: { tab, focused } }) as Record<string, unknown>);
  for (let i = 0; i < 20 && !target.querySelector(".cm-content"); i += 1) {
    await tick();
    await Promise.resolve();
  }
  const view = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-content")!)!;
  for (let i = 0; i < 20 && view.state.doc.toString() !== draft.content; i += 1) await tick();
  await Promise.resolve();
  return { target, view };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

describe("the composer keeps its state across a tab switch", () => {
  test("a hidden terminal keeps its Rich Prompt mounted", async () => {
    const tab = terminalTab({ richPromptDraftPath: ".Drafts/t/draft.md" });
    resetLayout([tab]);
    showRichPromptForTab(tab.id);
    const { target } = await mountTerminal(TerminalTabComponent, tab, { active: false, focused: false });
    await settle();
    expect(target.querySelector(".rich-prompt")).not.toBeNull();
  });

  test("an unfocused composer takes no focus, on mount or on a focus pulse", async () => {
    const focus = vi.spyOn(EditorView.prototype, "focus");
    await composer(terminalTab({ richPromptDraftPath: ".Drafts/t/draft.md" }), false);
    bumpTabFocusPulse();
    await settle();
    expect(focus).not.toHaveBeenCalled();
  });

  test("a focused composer takes focus again on each pulse, and keeps its caret", async () => {
    draft.content = "hello world";
    const tab = terminalTab({ richPromptDraftPath: ".Drafts/t/draft.md", richPromptCaret: { from: 2, to: 2 } });
    const { view } = await composer(tab, true);
    const focus = vi.spyOn(view, "focus");
    bumpTabFocusPulse();
    await settle();
    expect(focus).toHaveBeenCalled();
    expect(view.state.selection.main.head).toBe(2);
  });

  test("a message delivered while the composer was unfocused clears it without pulling focus", async () => {
    draft.content = "sent already";
    const focus = vi.spyOn(EditorView.prototype, "focus");
    const tab = terminalTab({
      richPromptDraftPath: ".Drafts/t/draft.md",
      pendingPrompt: { id: "p1", phase: "delivered" } as TerminalTab["pendingPrompt"],
    });
    const { view } = await composer(tab, false);
    await settle();
    expect(view.state.doc.toString()).toBe("");
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("the composer reopens where it was left", () => {
  test("at the saved caret, saving the caret as it moves", async () => {
    draft.content = "hello world";
    const tab = terminalTab({ richPromptDraftPath: ".Drafts/t/draft.md", richPromptCaret: { from: 3, to: 3 } });
    const { view } = await composer(tab, false);
    expect(view.state.selection.main.head).toBe(3);

    view.dispatch({ selection: { anchor: 5 } });
    expect(tab.richPromptCaret).toEqual({ from: 5, to: 5 });
  });

  test("at the saved height, saving a drag-resized one", async () => {
    const tab = terminalTab({ richPromptDraftPath: ".Drafts/t/draft.md", richPromptHeight: 180 });
    const { target } = await composer(tab, false);
    const root = target.querySelector<HTMLElement>(".rich-prompt")!;
    expect(root.style.height).toBe("180px");

    const handle = target.querySelector<HTMLElement>(".rp-resize")!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientY: 300 }));
    handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 200 }));
    handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientY: 200 }));
    await tick();
    expect(tab.richPromptHeight).toBe(100);
  });
});

describe("richPromptCaret / richPromptHeight round-trip the tabs store", () => {
  test("session serialization round-trips caret + height like tab.caret", async () => {
    const term = terminalTab({ richPromptDraftPath: "drafts/t1/draft.md" });
    resetLayout([term]);
    setRichPromptCaret(term, 7, 12);
    setRichPromptHeight(term, 240);

    const snapshot = serializeLayout({ terminalSessions: true });
    expect(snapshot).not.toBeNull();
    await restoreLayout(snapshot!);

    const restored = activePane().tabs[0];
    if (restored?.kind !== "terminal") throw new Error("expected terminal tab");
    expect(restored.richPromptCaret).toEqual({ from: 7, to: 12 });
    expect(restored.richPromptHeight).toBe(240);
  });

  test("a caret at offset 0 (the fresh-composer default) is omitted", () => {
    const term = terminalTab();
    resetLayout([term]);
    setRichPromptCaret(term, 0, 0);

    const snapshot = serializeLayout({ terminalSessions: true });
    if (snapshot?.k !== "l") throw new Error("expected a leaf snapshot");
    expect(snapshot.t[0]?.rpc).toBeUndefined();
    expect(snapshot.t[0]?.rph).toBeUndefined();
  });

  test("the shareable URL hash carries neither field (session payloads only)", () => {
    const term = terminalTab();
    resetLayout([term]);
    setRichPromptCaret(term, 3, 3);
    setRichPromptHeight(term, 180);

    const snapshot = serializeLayout();
    if (snapshot?.k !== "l") throw new Error("expected a leaf snapshot");
    expect(snapshot.t[0]?.rpc).toBeUndefined();
    expect(snapshot.t[0]?.rph).toBeUndefined();
  });

  test("hydrateTerminalSessionsFromLayout grafts caret + height onto a hash restore", async () => {
    // A hash reload restores the layout WITHOUT session-only fields, then
    // grafts them positionally from the per-window session payload - same
    // path that rebinds the draft (rpd).
    const term = terminalTab({ richPromptDraftPath: "drafts/t1/draft.md" });
    resetLayout([term]);
    setRichPromptCaret(term, 5, 9);
    setRichPromptHeight(term, 300);
    const sessionSnapshot = serializeLayout({ terminalSessions: true });
    const hashSnapshot = serializeLayout();

    await restoreLayout(hashSnapshot!);
    const bare = activePane().tabs[0];
    if (bare?.kind !== "terminal") throw new Error("expected terminal tab");
    expect(bare.richPromptCaret).toBeUndefined();

    hydrateTerminalSessionsFromLayout(sessionSnapshot);
    expect(bare.richPromptCaret).toEqual({ from: 5, to: 9 });
    expect(bare.richPromptHeight).toBe(300);
  });
});
