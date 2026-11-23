// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import type { Terminal } from "@chan/ghostty-web-ng";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../api/client", async (original) => {
  const actual = await original<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api,
    read: vi.fn(async () => ({ content: "keep this prompt" })),
    write: vi.fn(async () => ({})),
  } };
});

import TerminalTab from "./TerminalTab.svelte";
import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { draftPath } from "../__tests__/drafts";
import { terminalPreferences } from "../__tests__/standalone";
import { installEditorDom, press } from "../__tests__/wysiwyg";
import { attach, installTerminalDom, output, receive, resetTerminals, seatTerminals, sentFrames, terminalTab, TerminalSocket } from "../__tests__/terminalTab";
import { richPrompt, showRichPromptForTab } from "../state/richPrompt.svelte";
import { __testSetStandalonePreferences } from "../state/store.svelte";

const TEXT = "keep this prompt";
const NOTICE = "terminal not connected; try again";

installTerminalDom();
installEditorDom();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  resetTerminals();
  richPrompt.byTab = {};
  richPrompt.toolbarByTab = {};
  richPrompt.sourceByTab = {};
  __testSetStandalonePreferences(null);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await tick();
}

function history(term: Terminal): number {
  return term.getViewportY();
}

async function composer() {
  __testSetStandalonePreferences(terminalPreferences({ secret_masking: false }));
  const [tab] = seatTerminals([terminalTab({ richPromptDraftPath: draftPath("offline"), submitAgent: "claude" })]);
  const mounted = await mountGhosttyTerminal(TerminalTab, tab!);
  const { target, term } = mounted;
  const socket = TerminalSocket.all[0]!;
  const prelude = { id: "sess-prompt", submit_agent: "claude" };
  await attach(socket, prelude);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, Array.from({ length: 100 }, (_, i) => `history ${i}\r\n`).join(""));
  await vi.waitFor(() => expect(term.getScrollbackLength()).toBeGreaterThan(50));
  term.scrollLines(-7);
  expect(history(term)).toBe(7);
  showRichPromptForTab(tab!.id);
  await vi.waitFor(() => expect(target.querySelector(".rich-prompt .cm-content")).not.toBeNull());
  const content = target.querySelector<HTMLElement>(".rich-prompt .cm-content")!;
  const view = EditorView.findFromDOM(content)!;
  await flush();
  expect(view.state.doc.toString()).toBe(TEXT);
  socket.sent.length = 0;
  const submit = () => press(content, "Enter", { ctrlKey: true });
  const note = () => target.querySelector(".rp-text")?.textContent;
  return { target, tab: tab!, term, socket, view, submit, note };
}

describe("Rich Prompt while disconnected", () => {
  test.each([0, 2, 3])("socket state %s shows a refusal and keeps editable text for an explicit retry", async (readyState) => {
    const { target, tab, term, socket, view, submit, note } = await composer();
    socket.readyState = readyState;
    if (readyState === 2) target.querySelector<HTMLButtonElement>(".rp-primary")!.click();
    else submit();
    await flush();
    expect(note()).toBe(NOTICE);
    expect(target.querySelector(".rp-text")?.getAttribute("aria-live")).toBe("polite");
    expect(sentFrames(socket)).toEqual([]);
    expect(tab.pendingPrompt).toBeUndefined();
    expect(view.state.doc.toString()).toBe(TEXT);
    expect(view.state.readOnly).toBe(false);
    expect(history(term)).toBe(7);

    view.dispatch({ changes: { from: view.state.doc.length, insert: " revised" } });
    await flush();
    expect(view.state.doc.toString()).toBe(`${TEXT} revised`);
    socket.readyState = 1;
    await flush();
    expect(sentFrames(socket)).toEqual([]);
    submit();
    await flush();
    expect(note()).not.toBe(NOTICE);
    expect(sentFrames(socket)).toEqual([{ type: "prompt", data: `${TEXT} revised`, agent: "claude", id: expect.any(String) }]);
    expect(tab.pendingPrompt?.phase).toBe("sent");
    expect(view.state.readOnly).toBe(true);
    expect(history(term)).toBe(0);
  });

  test("the refusal expires without sending or discarding the draft", async () => {
    const { tab, socket, view, submit, note } = await composer();
    socket.readyState = 0;
    submit();
    await flush();
    expect(note()).toBe(NOTICE);
    await vi.advanceTimersByTimeAsync(4999);
    await flush();
    expect(note()).toBe(NOTICE);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(note()).toBeUndefined();
    expect(sentFrames(socket)).toEqual([]);
    expect(tab.pendingPrompt).toBeUndefined();
    expect(view.state.doc.toString()).toBe(TEXT);
    expect(view.state.readOnly).toBe(false);
  });

  test("a connected retry preserves an unrelated queue rejection notice", async () => {
    const { tab, socket, view, submit, note } = await composer();
    submit();
    await flush();
    const id = tab.pendingPrompt!.id;
    await receive(socket, { type: "prompt-ack", id, queued: false, depth: 100 });
    await flush();
    expect(note()).toBe("queue full, try again");
    expect(view.state.readOnly).toBe(false);
    submit();
    await flush();
    expect(sentFrames(socket).filter((frame) => frame.type === "prompt")).toHaveLength(2);
    expect(note()).toBe("queue full, try again");
  });

  test("a successful retry cancels the timer before a later refusal", async () => {
    const { tab, socket, view, submit, note } = await composer();
    socket.readyState = 0;
    submit();
    await flush();
    expect(note()).toBe(NOTICE);
    await vi.advanceTimersByTimeAsync(1000);
    socket.readyState = 1;
    submit();
    await flush();
    expect(note()).not.toBe(NOTICE);
    const id = tab.pendingPrompt!.id;
    await receive(socket, { type: "prompt-ack", id, queued: true, depth: 1 });
    await receive(socket, { type: "prompt-delivered", id, depth: 0 });
    await flush();
    expect(view.state.doc.toString()).toBe("");
    expect(view.state.readOnly).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    view.dispatch({ changes: { from: 0, insert: "second prompt" } });
    socket.readyState = 0;
    submit();
    await flush();
    expect(note()).toBe(NOTICE);
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(note()).toBe(NOTICE);
    await vi.advanceTimersByTimeAsync(1999);
    await flush();
    expect(note()).toBe(NOTICE);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(note()).toBeUndefined();
    expect(view.state.doc.toString()).toBe("second prompt");
    expect(view.state.readOnly).toBe(false);
    expect(sentFrames(socket).filter((frame) => frame.type === "prompt")).toHaveLength(1);
  });
});
