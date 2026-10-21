// @vitest-environment jsdom
//
// The Rich Prompt card's chrome: the close button hides the card and keeps
// the draft; the editor's style toolbar floats over the text area while the
// terminal's toggle is on, without the image button, with the first row moved
// below it; the source toggle's chord swaps the rendered editor for the source
// one and back, keeps the text, hands the keyboard to the editor it mounts,
// and reaches nothing beyond the card. A card hidden and shown again while
// its draft is being written shows the text it was hidden with, and once
// every write has answered it shows the stored draft. RichPrompt is mounted
// with its draft api stubbed; the assertions read the DOM, the draft writes
// and the state.

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
import { api } from "../api/client";
import { DraftGoneError } from "../state/drafts.svelte";
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

describe("a card hidden and shown again while its draft is being written", () => {
  type HeldWrite = {
    path: string;
    content: string;
    settled: boolean;
    answer(): void;
    refuse(error: unknown): void;
  };
  let shown = 0;
  let stored: Map<string, string>;
  let writes: HeldWrite[];
  let reads: string[];

  beforeEach(() => {
    shown += 1;
    tab.richPromptDraftPath = draftPath(`reopen-${shown}`);
    stored = new Map([[tab.richPromptDraftPath, "Ask **twice**."]]);
    writes = [];
    reads = [];
    // The server's side: a read answers what the last answered write stored,
    // and a write is stored only when the test answers it.
    vi.spyOn(api, "read").mockImplementation(async (path: string) => {
      reads.push(path);
      return { content: stored.get(path) ?? "" } as Awaited<ReturnType<typeof api.read>>;
    });
    vi.spyOn(api, "write").mockImplementation(
      (path: string, content: string) =>
        new Promise((resolve, reject) => {
          const write: HeldWrite = {
            path,
            content,
            settled: false,
            answer: () => {
              write.settled = true;
              stored.set(path, content);
              resolve({} as Awaited<ReturnType<typeof api.write>>);
            },
            refuse: (error) => {
              write.settled = true;
              reject(error);
            },
          };
          writes.push(write);
        }),
    );
  });

  async function typeAtEnd(target: HTMLElement, typed: string): Promise<void> {
    const view = EditorView.findFromDOM(target.querySelector<HTMLElement>(".cm-content")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: typed } });
    await settle();
  }

  /// A card mounted and its write of what it loaded answered, so the steps
  /// after it start from no write in flight.
  async function mountWritten(): Promise<HTMLElement> {
    const target = await mountCard();
    await vi.waitFor(() => expect(writes, "the card writes what it loaded").toHaveLength(1));
    expect(writes[0]!.content).toBe("Ask **twice**.");
    writes[0]!.answer();
    await settle();
    writes.splice(0);
    return target;
  }

  function closeButton(target: HTMLElement): HTMLButtonElement {
    return target.querySelector<HTMLButtonElement>('button[aria-label="Close Rich Prompt"]')!;
  }

  /// The close button, then the unmount the terminal tab makes of a hidden card.
  async function hide(target: HTMLElement): Promise<void> {
    closeButton(target).click();
    await settle();
    unmount(mounted.pop()!);
    await settle();
  }

  function shownText(target: HTMLElement): string {
    return text(target.querySelector<HTMLElement>(".cm-content")!);
  }

  test("shows the text it was hidden with, and the stored draft ends holding it", async () => {
    const first = await mountWritten();
    await typeAtEnd(first, " Kept.");
    await hide(first);
    expect.soft(writes.map((w) => w.content), "the hide's write is unanswered").toEqual(["Ask **twice**. Kept."]);

    const readsBefore = reads.length;
    const second = await mountCard();
    expect.soft(shownText(second)).toBe("Ask **twice**. Kept.");
    expect.soft(reads.length, "no read while the write is unanswered").toBe(readsBefore);

    for (let i = 0; i < 6 && writes.some((w) => !w.settled); i += 1) {
      for (const write of writes) if (!write.settled) write.answer();
      await settle();
    }
    expect.soft(stored.get(tab.richPromptDraftPath!)).toBe("Ask **twice**. Kept.");
  });

  test("shows the text at once over a write that never answers, and queues its own write behind it", async () => {
    const first = await mountWritten();
    await typeAtEnd(first, " Held.");
    await hide(first);

    const second = await mountCard();
    expect.soft(shownText(second)).toBe("Ask **twice**. Held.");
    await typeAtEnd(second, " More.");
    closeButton(second).click();
    await settle();
    expect.soft(writes.map((w) => w.content), "the card's own write waits behind the held one").toEqual([
      "Ask **twice**. Held.",
    ]);
  });

  test("gives a write queued behind a held one the latest text, once", async () => {
    const card = await mountWritten();
    await typeAtEnd(card, " One.");
    closeButton(card).click();
    await settle();
    await typeAtEnd(card, " Two.");
    closeButton(card).click();
    await settle();
    await typeAtEnd(card, " Three.");
    closeButton(card).click();
    await settle();
    expect.soft(writes).toHaveLength(1);

    writes[0]!.answer();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1]!.answer();
    await settle();
    expect.soft(writes.map((w) => w.content), "one more write, with the latest text").toEqual([
      "Ask **twice**. One.",
      "Ask **twice**. One. Two. Three.",
    ]);
  });

  test("lets a refused write stop no later write and no later card", async () => {
    const first = await mountWritten();
    await typeAtEnd(first, " Again.");
    await hide(first);
    writes[0]!.refuse(new Error("the network is down"));
    await vi.waitFor(() => expect(writes, "the unmount's write follows the refused one").toHaveLength(2));

    const second = await mountCard();
    expect.soft(shownText(second)).toBe("Ask **twice**. Again.");
    expect.soft(second.querySelector(".rp-load-error"), "the card mounted").toBeNull();
  });

  test("writes a gone draft's replacement before the card's later writes to it", async () => {
    const next = draftPath(`reopen-${shown}-next`);
    vi.spyOn(api, "createDraft").mockResolvedValue({ path: next, name: `reopen-${shown}-next` });
    const card = await mountWritten();
    await typeAtEnd(card, " A.");
    closeButton(card).click();
    await settle();
    writes[0]!.refuse(new DraftGoneError(writes[0]!.path));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect.soft(writes[1]).toMatchObject({ path: next, content: "" });
    writes[1]!.answer();
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    expect.soft(writes[2]).toMatchObject({ path: next, content: "Ask **twice**. A." });

    await typeAtEnd(card, " B.");
    closeButton(card).click();
    await settle();
    expect.soft(writes, "the later write waits for the replacement's").toHaveLength(3);
    writes[2]!.answer();
    await vi.waitFor(() => expect(writes).toHaveLength(4));
    writes[3]!.answer();
    await settle();
    expect.soft(stored.get(next)).toBe("Ask **twice**. A. B.");
  });


  test("an earlier write of the same text answering leaves the reopened card its text while the close's write is held", async () => {
    const first = await mountWritten();
    await typeAtEnd(first, " Same.");
    await vi.waitFor(() => expect(writes, "the debounced write starts").toHaveLength(1));
    await hide(first);
    expect.soft(writes.map((w) => w.content), "the close's write waits behind it").toEqual(["Ask **twice**. Same."]);
    writes[0]!.answer();
    await vi.waitFor(() => expect(writes, "the close's write starts and is held").toHaveLength(2));
    showRichPromptForTab(tab.id);
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(RichPrompt, { target, props: { tab, focused: true } }) as Record<string, unknown>);
    for (let i = 0; i < 40 && !target.querySelector(".cm-content"); i += 1) {
      await tick();
      await Promise.resolve();
    }
    await settle();
    const content = target.querySelector<HTMLElement>(".cm-content");
    expect(content ? text(content) : "(no editor)", "the reopened card while the close's write is held").toBe(
      "Ask **twice**. Same.",
    );
  });

  test("keeps the text it was hidden with while the close's write is held, over a draft edited from outside", async () => {
    const first = await mountWritten();
    await typeAtEnd(first, " Same.");
    await vi.waitFor(() => expect(writes, "the debounced write starts").toHaveLength(1));
    await hide(first);
    writes[0]!.answer();
    await vi.waitFor(() => expect(writes, "the close's write starts and is held").toHaveLength(2));
    stored.set(tab.richPromptDraftPath!, "Edited elsewhere.");
    const second = await mountCard();
    expect(shownText(second), "the reopened card while the close's write is held").toBe("Ask **twice**. Same.");
  });

  test("once the window's writes answer, a reopened card shows the stored draft as it now stands", async () => {
    const first = await mountWritten();
    await typeAtEnd(first, " Mine.");
    await hide(first);
    for (let i = 0; i < 6 && writes.some((w) => !w.settled); i += 1) {
      for (const write of writes) if (!write.settled) write.answer();
      await settle();
    }
    stored.set(tab.richPromptDraftPath!, "Edited elsewhere.");
    const second = await mountCard();
    expect(shownText(second), "the reopened card reads the draft's outside edit").toBe("Edited elsewhere.");
  });
});
