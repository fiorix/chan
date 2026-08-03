// @vitest-environment jsdom
// Real RichPrompt mount + real key dispatch, covering two pending-machine
// regressions:
//   R1 - one Escape on a queued card must cancel ONCE and keep the bubble open
//        (not also hide it via the container Escape handler).
//   R2 - a delivered-while-hidden prompt must be cleared on reopen (empty
//        composer + a clear-write to disk), not restored as stale text.
// The same harness drives the control strip with real clicks, since the strip
// exists so a pointer alone can reach every action the keymap runs.
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorView } from "@codemirror/view";

const writeSpy = vi.fn(async (_p: string, _c: string) => ({}) as unknown);
const readMock = vi.fn(async (_p: string) => ({ content: "" }) as unknown);
const createDraftMock = vi.fn(async () => ({ path: ".Drafts/t/draft.md" }));
const sendPromptSpy = vi.fn((..._a: unknown[]) => true);
const sendCancelSpy = vi.fn((..._a: unknown[]) => {});

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
vi.mock("../state/tabs.svelte", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    sendPromptToTerminal: (...a: unknown[]) => sendPromptSpy(...a),
    sendCancelToTerminal: (...a: unknown[]) => sendCancelSpy(...a),
  };
});

import RichPrompt from "./RichPrompt.svelte";
import {
  isRichPromptVisible,
  showRichPromptForTab,
  richPrompt,
} from "../state/richPrompt.svelte";
import type { TerminalTab } from "../state/tabs.svelte";

const mounted: Array<Record<string, unknown>> = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  richPrompt.byTab = {};
});
beforeEach(() => {
  writeSpy.mockClear();
  sendCancelSpy.mockClear();
  sendPromptSpy.mockClear();
  readMock.mockResolvedValue({ content: "" } as unknown);
});

// A `$state` proxy, not a plain object: the component reads `tab.pendingPrompt`
// through a derived, and a plain object's mutations are invisible to it, so the
// strip's labels would never follow a submit or a cancel.
function makeTab(over: Partial<TerminalTab> = {}): TerminalTab {
  const tab = $state({
    kind: "terminal",
    id: "term-1",
    title: "t",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...over,
  });
  return tab as TerminalTab;
}

async function mountRP(
  tab: TerminalTab,
): Promise<{ target: HTMLElement; content: HTMLElement | null }> {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(RichPrompt, { target, props: { tab } }) as Record<string, unknown>);
  for (let i = 0; i < 20 && !target.querySelector(".cm-content"); i++) {
    await tick();
    await Promise.resolve();
  }
  return { target, content: target.querySelector(".cm-content") };
}

function press(el: HTMLElement, key: string, mods: Partial<KeyboardEventInit> = {}): void {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
  );
}

async function settle(view: EditorView, want: string): Promise<void> {
  for (let i = 0; i < 20 && view.state.doc.toString() !== want; i++) {
    await tick();
    await Promise.resolve();
  }
}

describe("R1: Escape on a queued card cancels once and keeps the bubble open", () => {
  test("one Escape drops the queued message without hiding the composer", async () => {
    // Mount already holding a queued message (the reload-rehydration path): the
    // pending phase is `sent` and the restored draft is its text, so onMount
    // seeds `lastQueued` and the card is up.
    const tab = makeTab({
      richPromptDraftPath: ".Drafts/t/draft.md",
      pendingPrompt: { id: "p1", phase: "sent" } as TerminalTab["pendingPrompt"],
    });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "hello agent" } as unknown);
    const { content } = await mountRP(tab);
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!)!;
    await settle(view, "hello agent");

    press(content!, "Escape");
    await tick();

    expect(sendCancelSpy).toHaveBeenCalledTimes(1); // dropped once, not twice
    expect(isRichPromptVisible(tab.id)).toBe(true); // bubble kept open
  });

  test("Escape on a plain editable draft still abandons and hides", async () => {
    const tab = makeTab({ richPromptDraftPath: ".Drafts/t/draft.md" });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "a draft" } as unknown);
    const { content } = await mountRP(tab);
    const view = EditorView.findFromDOM(content!)!;
    await settle(view, "a draft");

    press(content!, "Escape");
    await tick();

    expect(sendCancelSpy).not.toHaveBeenCalled();
    expect(isRichPromptVisible(tab.id)).toBe(false); // abandoned + hidden
  });
});

describe("R2: delivered-while-hidden is cleared on reopen", () => {
  test("mounting with a delivered phase + stale draft clears the composer and disk", async () => {
    const tab = makeTab({
      richPromptDraftPath: ".Drafts/t/draft.md",
      pendingPrompt: { id: "p1", phase: "delivered" } as TerminalTab["pendingPrompt"],
    });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "STALE delivered text" } as unknown);
    const { content } = await mountRP(tab);
    for (let i = 0; i < 10; i++) {
      await tick();
      await Promise.resolve();
    }

    const doc = content ? (content.textContent ?? "") : "";
    const clearWriteCalled = writeSpy.mock.calls.some((c) => c[1] === "");
    expect(doc).toBe("");
    expect(clearWriteCalled).toBe(true);
    expect(tab.pendingPrompt).toBeUndefined();
  });
});

const SUBMIT_LABEL = /submit with (cmd|ctrl)\+enter/;

function primaryOf(target: HTMLElement): HTMLButtonElement {
  return target.querySelector<HTMLButtonElement>(".rp-primary")!;
}
function secondaryOf(target: HTMLElement): HTMLButtonElement | null {
  return target.querySelector<HTMLButtonElement>(".rp-action:not(.rp-primary)");
}
function labelOf(el: Element | null): string {
  return (el?.textContent ?? "").trim();
}

describe("the control strip drives the composer with a pointer alone", () => {
  test("the primary control submits, becomes cancel, and returns to submit", async () => {
    const tab = makeTab({ richPromptDraftPath: ".Drafts/t/draft.md" });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "hello agent" } as unknown);
    const { target, content } = await mountRP(tab);
    const view = EditorView.findFromDOM(content!)!;
    await settle(view, "hello agent");
    await tick();

    expect(labelOf(primaryOf(target))).toMatch(SUBMIT_LABEL);
    expect(primaryOf(target).disabled).toBe(false);

    primaryOf(target).click();
    await tick();
    expect(sendPromptSpy).toHaveBeenCalledTimes(1);
    expect(labelOf(primaryOf(target))).toBe("esc cancel");

    primaryOf(target).click();
    await tick();
    expect(sendCancelSpy).toHaveBeenCalledTimes(1);
    expect(labelOf(primaryOf(target))).toMatch(SUBMIT_LABEL);
    expect(isRichPromptVisible(tab.id)).toBe(true);
  });

  test("the primary control is inert on a blank composer", async () => {
    const tab = makeTab({ richPromptDraftPath: ".Drafts/t/draft.md" });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "" } as unknown);
    const { target } = await mountRP(tab);
    await tick();

    expect(primaryOf(target).disabled).toBe(true);
    expect(sendPromptSpy).not.toHaveBeenCalled();
  });

  test("cancelling a prompt restored from a blank draft keeps the composer", async () => {
    // onMount only seeds `lastQueued` when the restored draft still has text,
    // so this pending bubble genuinely holds `lastQueued === null`. Escape
    // falls through to abandonDraft() there and hides the bubble; the strip's
    // cancel runs its own action and must not.
    const tab = makeTab({
      richPromptDraftPath: ".Drafts/t/draft.md",
      pendingPrompt: { id: "p1", phase: "sent" } as TerminalTab["pendingPrompt"],
    });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "" } as unknown);
    const { target } = await mountRP(tab);
    await tick();

    expect(labelOf(primaryOf(target))).toBe("esc cancel");
    primaryOf(target).click();
    await tick();

    expect(isRichPromptVisible(tab.id)).toBe(true);
    expect(tab.pendingPrompt).toBeUndefined();
    expect(labelOf(primaryOf(target))).toMatch(SUBMIT_LABEL);
  });

  test("the secondary control appears only when there is something to reach", async () => {
    const tab = makeTab({ richPromptDraftPath: ".Drafts/t/draft.md" });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "hello agent" } as unknown);
    const { target, content } = await mountRP(tab);
    const view = EditorView.findFromDOM(content!)!;
    await settle(view, "hello agent");
    await tick();

    expect(secondaryOf(target)).toBeNull(); // nothing queued, nothing to recall

    primaryOf(target).click();
    await tick();
    expect(labelOf(secondaryOf(target))).toBe("↑ edit");

    secondaryOf(target)!.click();
    await tick();
    expect(sendCancelSpy).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("hello agent"); // pulled back, not dropped
  });

  test("no recall control for a queue this client cannot reach", async () => {
    // A teammate's `cs terminal write` raises the server's queue depth, but
    // there is no local message to pull back. Offering recall there would be
    // a control that does nothing, so it stays absent.
    const tab = makeTab({
      richPromptDraftPath: ".Drafts/t/draft.md",
      queueDepth: 2,
    });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "" } as unknown);
    const { target } = await mountRP(tab);
    await tick();

    expect(labelOf(target.querySelector(".rp-text"))).toBe("2 queued");
    expect(secondaryOf(target)).toBeNull();
  });

  test("a transient note takes the text slot without disabling the controls", async () => {
    const tab = makeTab({
      richPromptDraftPath: ".Drafts/t/draft.md",
      pendingPrompt: {
        id: "p1",
        phase: "rejected",
      } as TerminalTab["pendingPrompt"],
    });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "hello agent" } as unknown);
    const { target, content } = await mountRP(tab);
    const view = EditorView.findFromDOM(content!)!;
    await settle(view, "hello agent");
    await tick();

    expect(labelOf(target.querySelector(".rp-text"))).toBe("queue full, try again");
    expect(primaryOf(target).disabled).toBe(false);
    expect(labelOf(primaryOf(target))).toMatch(SUBMIT_LABEL);
  });

  test("the strip exposes real controls, not aria-hidden chrome", async () => {
    const tab = makeTab({ richPromptDraftPath: ".Drafts/t/draft.md" });
    showRichPromptForTab(tab.id);
    readMock.mockResolvedValue({ content: "hi" } as unknown);
    const { target } = await mountRP(tab);
    await tick();

    expect(target.querySelector(".rp-strip")!.getAttribute("aria-hidden")).toBeNull();
    const primary = primaryOf(target);
    expect(primary.tagName).toBe("BUTTON");
    expect(primary.getAttribute("type")).toBe("button");
    expect(labelOf(primary).length).toBeGreaterThan(0);
  });
});
