// @vitest-environment jsdom
//
// The Rich Prompt: a Drafts-backed composer over a terminal that submits into
// that terminal's write queue and keeps the text as a greyed card until the
// agent takes it. RichPrompt is mounted with its draft api stubbed and a real
// prompt sink registered for its terminal; the assertions read the editor,
// the sink, the draft writes and the strip. The control strip's own cases
// live in richPromptPendingMachine.svelte.test.ts, Tab in
// richPromptTabKeymap.test.ts, and the message id in
// richPromptInsecureContext.svelte.test.ts.

import { EditorView } from "@codemirror/view";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const drafts = vi.hoisted(() => ({
  content: "",
  created: 0,
  writes: [] as Array<[string, string]>,
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      createDraft: vi.fn(async () => {
        drafts.created += 1;
        return { path: ".Drafts/rp/draft.md" };
      }),
      read: vi.fn(async () => ({ content: drafts.content })),
      write: vi.fn(async (path: string, content: string) => {
        drafts.writes.push([path, content]);
        return {};
      }),
    },
  };
});

import App from "../App.svelte";
import RichPrompt from "./RichPrompt.svelte";
import { installDemoWorkspace } from "../demo/install";
import { teardownDemoApp } from "../demo/teardown";
import { trackTimers } from "../demo/timers";
import {
  hideRichPromptForTab,
  isRichPromptVisible,
  richPrompt,
  showRichPromptForTab,
  toggleRichPromptForTab,
} from "../state/richPrompt.svelte";
import { workspace } from "../state/store.svelte";
import {
  layout,
  registerTerminalCancelSink,
  registerTerminalPromptSink,
  reproveRestoredPrompt,
  sendPromptToTerminal,
  type LeafNode,
  type Tab,
  type TerminalTab,
} from "../state/tabs.svelte";
import { installEditorDom, press } from "../__tests__/wysiwyg";
import { installTerminalDom, terminalTab } from "../__tests__/terminalTab";

installTerminalDom();
installEditorDom();
// The editors measure on animation frames; a synchronous frame (the terminal
// harness's default) runs those measures inside an update.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;

type Sent = { data: string; agent?: string; id?: string };

const mounted: Array<Record<string, unknown>> = [];
const unregister: Array<() => void> = [];
let sent: Sent[];
let cancelled: string[];

beforeEach(() => {
  sent = [];
  cancelled = [];
  drafts.content = "";
  drafts.created = 0;
  drafts.writes = [];
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  for (const off of unregister.splice(0)) off();
  richPrompt.byTab = {};
  workspace.info = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/// A `$state` tab, so the pending phase the component reads follows changes.
function makeTab(over: Partial<TerminalTab> = {}): TerminalTab {
  const tab = $state({
    kind: "terminal",
    id: "term-rp",
    title: "t",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...over,
  });
  return tab as TerminalTab;
}

async function composer(tab: TerminalTab): Promise<{ target: HTMLElement; view: EditorView; content: HTMLElement }> {
  unregister.push(
    registerTerminalPromptSink(tab.id, (data, agent, id) => {
      sent.push({ data, agent, id });
      return true;
    }),
    registerTerminalCancelSink(tab.id, (id) => {
      cancelled.push(id);
      return true;
    }),
  );
  showRichPromptForTab(tab.id);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(RichPrompt, { target, props: { tab } }) as Record<string, unknown>);
  for (let i = 0; i < 20 && !target.querySelector(".cm-content"); i += 1) {
    await tick();
    await Promise.resolve();
  }
  const content = target.querySelector<HTMLElement>(".cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  for (let i = 0; i < 20 && view.state.doc.toString() !== drafts.content; i += 1) await tick();
  await tick();
  return { target, view, content };
}

/// Mod+Enter: Ctrl off the Mac, which is what jsdom reports.
function submit(content: HTMLElement): KeyboardEvent {
  return press(content, "Enter", { ctrlKey: true });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

describe("the per-terminal toggle", () => {
  test("shows, hides and toggles one terminal's composer at a time", () => {
    expect(isRichPromptVisible("t1")).toBe(false);
    toggleRichPromptForTab("t1");
    expect(isRichPromptVisible("t1")).toBe(true);
    expect(isRichPromptVisible("t2")).toBe(false);
    toggleRichPromptForTab("t1");
    expect(isRichPromptVisible("t1")).toBe(false);
    showRichPromptForTab("t2");
    expect(isRichPromptVisible("t2")).toBe(true);
    hideRichPromptForTab("t2");
    expect(isRichPromptVisible("t2")).toBe(false);
  });
});

describe("the draft behind the composer", () => {
  test("is created on first open, bound to the terminal and started empty", async () => {
    const tab = makeTab();
    await composer(tab);
    expect(drafts.created).toBe(1);
    expect(tab.richPromptDraftPath).toBe(".Drafts/rp/draft.md");
    expect(drafts.writes[0]).toEqual([".Drafts/rp/draft.md", ""]);
  });

  test("is reused when the terminal has one, and edits are written back to it", async () => {
    drafts.content = "kept text";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/old/draft.md" });
    const { view, target } = await composer(tab);
    expect(drafts.created).toBe(0);
    expect(view.state.doc.toString()).toBe("kept text");
    expect(target.querySelector(".md-wysiwyg-cm6"), "the composer is the Wysiwyg editor").not.toBeNull();

    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
    await new Promise((r) => setTimeout(r, 450));
    expect(drafts.writes.at(-1)).toEqual([".Drafts/old/draft.md", "kept text!"]);
  });
});

describe("the keymap", () => {
  test("Enter continues a list as the editor does, and does not submit", async () => {
    drafts.content = "- first";
    const { view, content } = await composer(makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" }));
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(content, "Enter");
    await settle();
    expect(view.state.doc.toString()).toBe("- first\n- ");
    expect(sent).toEqual([]);
  });

  test("Mod+Enter submits once and stops there, so no outer listener sees it", async () => {
    drafts.content = "run the tests";
    const { content } = await composer(makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" }));
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    submit(content);
    document.removeEventListener("keydown", outer);

    expect(sent.map((s) => s.data)).toEqual(["run the tests"]);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("a submit", () => {
  test("delivers draft images as their absolute path on disk", async () => {
    workspace.info = { root: "/home/me/ws" } as typeof workspace.info;
    drafts.content = "see ![](shot.png)";
    const { content } = await composer(makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" }));
    submit(content);
    expect(sent[0]!.data).toMatch(/^see \/home\/me\/ws\/\.Drafts\/rp\/shot\.png\s*$/);
  });

  test("names the agent the server identified, else the one the keyboard protocol implies", async () => {
    drafts.content = "hi";
    const named = await composer(makeTab({ id: "term-a", richPromptDraftPath: ".Drafts/rp/draft.md", submitAgent: "codex" }));
    submit(named.content);
    const inferred = await composer(
      makeTab({
        id: "term-b",
        richPromptDraftPath: ".Drafts/rp/draft.md",
        keyboardProtocol: {
          xtermModifyOtherKeys: 2,
          kitty: { screen: "main", mainFlags: 0, alternateFlags: 0, mainStack: [], alternateStack: [] },
        } as unknown as TerminalTab["keyboardProtocol"],
      }),
    );
    submit(inferred.content);
    expect(sent.map((s) => s.agent)).toEqual(["codex", "claude"]);
  });

  test("keeps the text as a greyed card, saved, and a second submit sends nothing", async () => {
    drafts.content = "careful now";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content, target } = await composer(tab);
    submit(content);
    await settle();

    expect(view.state.doc.toString()).toBe("careful now");
    expect(target.querySelector(".rich-prompt")!.classList.contains("pending"), "greyed").toBe(true);
    expect(drafts.writes.at(-1)).toEqual([".Drafts/rp/draft.md", "careful now"]);
    submit(content);
    expect(sent).toHaveLength(1);
  });

  test("a keymap edit leaves the pending card unchanged", async () => {
    drafts.content = "careful now";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content } = await composer(tab);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    submit(content);
    await settle();

    press(content, "Backspace");
    press(content, "Enter");
    await settle();
    expect(view.state.doc.toString()).toBe("careful now");
    expect(view.state.readOnly).toBe(true);
  });

  test("no editing key reaches a pending list card, and a failed send restores what was sent", async () => {
    drafts.content = "- run the tests\n- fix the lint";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content } = await composer(tab);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    submit(content);
    await settle();

    // One key at a time: Shift-Tab undoes what Tab would have done.
    const keys = [["Enter"], ["Tab"], ["Tab", { shiftKey: true }], ["b", { ctrlKey: true }], ["i", { ctrlKey: true }]] as const;
    for (const [key, mods] of keys) {
      press(content, key, mods);
      await settle();
      expect(view.state.doc.toString(), `${key} ${JSON.stringify(mods ?? {})}`).toBe("- run the tests\n- fix the lint");
    }

    tab.pendingPrompt = { id: sent[0]!.id!, phase: "failed" };
    flushSync();
    await settle();
    expect(view.state.doc.toString()).toBe(sent[0]!.data);
  });

  test("the fence escapes do not reach a pending card", async () => {
    drafts.content = "run this\n```\nls\n```";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content } = await composer(tab);
    // On the closer, the doc's last line: where both escapes append a line.
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    submit(content);
    await settle();

    press(content, "ArrowDown");
    submit(content);
    await settle();
    expect(view.state.doc.toString()).toBe("run this\n```\nls\n```");
    expect(sent).toHaveLength(1);
  });

  test("a pending card still moves the caret, and a typed key starts a fresh composer with it", async () => {
    drafts.content = "careful now";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content } = await composer(tab);
    submit(content);
    await settle();
    view.dispatch({ selection: { anchor: 0 } });

    press(content, "ArrowRight");
    expect(view.state.selection.main.head).toBe(1);
    // `>` over whole lines is also the editor's quote command.
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    press(content, ">");
    await settle();
    expect(view.state.doc.toString()).toBe(">");
    expect(view.state.readOnly).toBe(false);
    expect(tab.pendingPrompt).toBeUndefined();
  });

  test("a card restored while its message is still queued opens read-only", async () => {
    drafts.content = "from before the reload";
    const tab = makeTab({
      richPromptDraftPath: ".Drafts/rp/draft.md",
      pendingPrompt: { id: "p-1", phase: "sent" } as TerminalTab["pendingPrompt"],
    });
    const { view } = await composer(tab);
    expect(view.state.readOnly).toBe(true);
  });

  test("a restored card unlocks when the server no longer holds its message", async () => {
    drafts.content = "from before the reload";
    const tab = makeTab({
      richPromptDraftPath: ".Drafts/rp/draft.md",
      pendingPrompt: { id: "p-1", phase: "queued" } as TerminalTab["pendingPrompt"],
    });
    const { view } = await composer(tab);
    reproveRestoredPrompt(tab, []);
    flushSync();
    await settle();

    expect(tab.pendingPrompt).toBeUndefined();
    expect(view.state.readOnly).toBe(false);
  });

  test("typing over the card starts a fresh composer with what was typed", async () => {
    drafts.content = "queued text";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content } = await composer(tab);
    submit(content);
    await settle();

    content.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "n", bubbles: true, cancelable: true }));
    await settle();
    expect(view.state.doc.toString()).toBe("n");
    expect(view.state.readOnly).toBe(false);
    expect(tab.pendingPrompt).toBeUndefined();
  });
});

describe("the card's fate", () => {
  test("delivered clears the composer and the draft", async () => {
    drafts.content = "going out";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content } = await composer(tab);
    submit(content);
    tab.pendingPrompt = { id: sent[0]!.id!, phase: "delivered" };
    flushSync();
    await settle();

    expect(view.state.doc.toString()).toBe("");
    expect(view.state.readOnly).toBe(false);
    expect(drafts.writes.at(-1)).toEqual([".Drafts/rp/draft.md", ""]);
  });

  test("a failure un-greys the card, keeps the text and says so", async () => {
    drafts.content = "might be lost";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content, target } = await composer(tab);
    submit(content);
    tab.pendingPrompt = { id: sent[0]!.id!, phase: "failed" };
    flushSync();
    await settle();

    expect(view.state.doc.toString()).toBe("might be lost");
    expect(view.state.readOnly).toBe(false);
    expect(target.querySelector(".rp-text")?.textContent).toBe("connection lost, message may still be queued");
  });

  test("a failed send restores exactly the text that was sent", async () => {
    drafts.content = "send this";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content } = await composer(tab);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    submit(content);
    await settle();
    press(content, "Backspace");
    press(content, "Enter");
    await settle();
    tab.pendingPrompt = { id: sent[0]!.id!, phase: "failed" };
    flushSync();
    await settle();

    expect(sent.map((s) => s.data)).toEqual(["send this"]);
    expect(view.state.doc.toString()).toBe("send this");
    expect(view.state.readOnly).toBe(false);
  });

  test("no answer within 5s fails the send; the queued chip shows only after 300ms", async () => {
    drafts.content = "into the void";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { content, target } = await composer(tab);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    submit(content);
    await settle();
    const slot = () => target.querySelector(".rp-text")?.textContent ?? null;

    await vi.advanceTimersByTimeAsync(299);
    expect(slot(), "no chip for a send that drains at once").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(slot()).toBe("1 queued");
    await vi.advanceTimersByTimeAsync(4700);
    expect(slot()).toBe("connection lost, message may still be queued");
  });
});

describe("recall", () => {
  test("from an emptied composer, ArrowUp takes the queued message back for editing", async () => {
    drafts.content = "second thoughts";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content } = await composer(tab);
    submit(content);
    await settle();
    content.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true }));
    await settle();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    await settle();

    press(content, "ArrowUp");
    await settle();
    expect(cancelled).toEqual([sent[0]!.id]);
    expect(view.state.doc.toString()).toBe("second thoughts");
  });

  test("the strip offers recall for a queued message, disabled while the composer has text", async () => {
    drafts.content = "later";
    const tab = makeTab({ richPromptDraftPath: ".Drafts/rp/draft.md" });
    const { view, content, target } = await composer(tab);
    submit(content);
    await settle();
    content.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "y", bubbles: true, cancelable: true }));
    tab.queueDepth = 1;
    flushSync();
    await settle();

    const recall = () =>
      [...target.querySelectorAll<HTMLButtonElement>(".rp-action")].find((b) => b.textContent?.trim() === "↑ recall");
    expect(recall()?.disabled).toBe(true);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    await settle();
    expect(recall()?.disabled).toBe(false);
  });
});

describe("the prompt sender", () => {
  test("reaches only a terminal with a live sink, and passes the agent and id", () => {
    const got: Sent[] = [];
    unregister.push(
      registerTerminalPromptSink("term-live", (data, agent, id) => {
        got.push({ data, agent, id });
        return true;
      }),
    );
    expect(sendPromptToTerminal("term-live", "hello", "claude", "m-1")).toBe(true);
    expect(sendPromptToTerminal("term-gone", "hello")).toBe(false);
    expect(got).toEqual([{ data: "hello", agent: "claude", id: "m-1" }]);
  });
});

describe("the Rich Prompt chord", () => {
  async function appWith(tab: Tab): Promise<() => Promise<void>> {
    const timers = trackTimers();
    const app: Array<Record<string, unknown>> = [];
    installDemoWorkspace({
      metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 0, textCount: 0 },
      files: [],
    });
    const target = document.createElement("div");
    document.body.append(target);
    app.push(mount(App, { target }));
    await settle();
    const pane: LeafNode = { kind: "leaf", id: "chord-pane", tabs: [tab], activeTabId: tab.id };
    layout.nodes = { [pane.id]: pane };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    await settle();
    return () => teardownDemoApp({ mounted: app, timers });
  }

  function chord(): void {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
  }

  test("Ctrl+Shift+P toggles the focused terminal's composer", async () => {
    const tab = terminalTab({ id: "term-chord" });
    const teardown = await appWith(tab);
    try {
      chord();
      expect(isRichPromptVisible("term-chord")).toBe(true);
      chord();
      expect(isRichPromptVisible("term-chord")).toBe(false);
    } finally {
      await teardown();
    }
  });

  test("does nothing when the focused tab is not a terminal", async () => {
    const teardown = await appWith({ kind: "dashboard", id: "dash-chord", title: "Dashboard" });
    try {
      chord();
      expect(richPrompt.byTab).toEqual({});
    } finally {
      await teardown();
    }
  });
});
