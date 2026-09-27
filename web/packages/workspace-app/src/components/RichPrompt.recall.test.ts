// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api,
    read: vi.fn(async () => ({ content: "recall this prompt" })),
    write: vi.fn(async () => ({})),
  } };
});

import TerminalTab from "./TerminalTab.svelte";
import { api } from "../api/client";
import { richPrompt, showRichPromptForTab } from "../state/richPrompt.svelte";
import { installEditorDom, press } from "../__tests__/wysiwyg";
import { attach, installTerminalDom, mountTerminal, receive, resetTerminals, seatTerminals, sentFrames, terminalTab, TerminalSocket } from "../__tests__/terminalTab";

installTerminalDom();
installEditorDom();
const TEXT = "recall this prompt";
const FAILED = "connection lost, message may still be queued";
const ORIGINS = ["pending card", "empty composer"] as const;
type Origin = typeof ORIGINS[number];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

afterEach(() => {
  resetTerminals();
  richPrompt.byTab = {};
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await tick();
}

async function recall(origin: Origin | "unacknowledged") {
  if (origin === "unacknowledged") {
    vi.mocked(api.read).mockResolvedValueOnce({ path: ".Drafts/recall/draft.md", content: "", mtime: 0 });
  }
  const [tab] = seatTerminals([terminalTab({ richPromptDraftPath: ".Drafts/recall/draft.md" })]);
  const { target } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  showRichPromptForTab(tab!.id);
  await flush();
  const content = target.querySelector<HTMLElement>(".cm-content")!;
  expect(content).not.toBeNull();
  const view = EditorView.findFromDOM(content)!;
  await flush();
  if (origin === "unacknowledged") {
    expect(view.state.doc.toString()).toBe("");
    view.dispatch({ changes: { from: 0, insert: TEXT } });
    await flush();
  }
  expect(view.state.doc.toString()).toBe(TEXT);
  socket.sent.splice(0);
  press(content, "Enter", { ctrlKey: true });
  await flush();
  const prompts = sentFrames(socket).filter((f) => f.type === "prompt");
  expect(prompts).toHaveLength(1);
  const id = prompts[0]!.id as string;
  if (origin !== "unacknowledged") {
    await receive(socket, { type: "prompt-ack", id, queued: true, depth: 1 });
    await flush();
  }
  if (origin === "empty composer") {
    press(content, "x");
    await flush();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    await flush();
  }
  press(content, "ArrowUp");
  await flush();
  return { tab: tab!, socket, id, target, content, view };
}

function cancels(socket: TerminalSocket) {
  return sentFrames(socket).filter((f) => f.type === "cancel-prompt");
}

describe("recall before prompt acknowledgement", () => {
  test("a refused prompt keeps its text after the cancellation reply", async () => {
    const { tab, socket, id, target, view } = await recall("unacknowledged");
    expect(view.state.readOnly).toBe(true);
    expect(tab.pendingPrompt).toEqual({ id, phase: "recalling", recallText: TEXT });
    expect(cancels(socket)).toEqual([{ type: "cancel-prompt", id }]);

    await receive(socket, { type: "prompt-ack", id, queued: false, depth: 100 });
    await flush();
    expect(target.textContent).not.toContain("already sent");
    await receive(socket, { type: "prompt-cancelled", id, removed: false });
    await flush();
    expect(view.state.doc.toString()).toBe(TEXT);
    expect(view.state.readOnly).toBe(false);
    expect(target.querySelector(".rp-text")?.textContent).toBe("queue full, try again");
    expect(target.textContent).not.toContain("already sent");
    expect(tab.pendingPrompt).toBeUndefined();
    expect(api.write).toHaveBeenLastCalledWith(".Drafts/recall/draft.md", TEXT);
  });

  test("a cancellation reply without rejection clears the text as already sent", async () => {
    const { tab, socket, id, target, view } = await recall("unacknowledged");
    expect(view.state.readOnly).toBe(true);
    expect(tab.pendingPrompt).toEqual({ id, phase: "recalling", recallText: TEXT });
    expect(cancels(socket)).toEqual([{ type: "cancel-prompt", id }]);

    await receive(socket, { type: "prompt-cancelled", id, removed: false });
    await flush();
    expect(view.state.doc.toString()).toBe("");
    expect(view.state.readOnly).toBe(false);
    expect(target.querySelector(".rp-text")?.textContent).toBe("already sent");
    expect(tab.pendingPrompt).toBeUndefined();
    expect(api.write).toHaveBeenLastCalledWith(".Drafts/recall/draft.md", "");
  });
});

describe("recall acknowledgement", () => {
  test.each(ORIGINS)("removed true unlocks the %s with its text", async (origin) => {
    const { tab, socket, id, target, content, view } = await recall(origin);
    const waitingText = origin === "pending card" ? TEXT : "";
    expect(view.state.readOnly).toBe(true);
    expect(tab.pendingPrompt?.id).toBe(id);
    expect(view.state.doc.toString()).toBe(waitingText);
    press(content, "y");
    content.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "z", bubbles: true, cancelable: true }));
    press(content, "ArrowUp");
    press(content, "Escape");
    press(content, "Enter", { ctrlKey: true });
    await flush();
    expect(view.state.doc.toString()).toBe(waitingText);
    expect(cancels(socket)).toEqual([{ type: "cancel-prompt", id }]);
    expect(sentFrames(socket).filter((f) => f.type === "prompt")).toHaveLength(1);
    await receive(socket, { type: "prompt-ack", id, queued: true, depth: 1 });
    await flush();
    expect(view.state.readOnly).toBe(true);
    await receive(socket, { type: "prompt-cancelled", id, removed: true });
    await flush();
    expect(view.state.readOnly).toBe(false);
    expect(view.state.doc.toString()).toBe(TEXT);
    expect(tab.pendingPrompt).toBeUndefined();
    expect(api.write).toHaveBeenLastCalledWith(".Drafts/recall/draft.md", TEXT);
    await vi.advanceTimersByTimeAsync(5000);
    expect(target.querySelector(".rp-text")?.textContent).not.toBe(FAILED);
  });

  test.each(ORIGINS)("removed false clears the %s and says already sent", async (origin) => {
    const { tab, socket, id, target, view } = await recall(origin);
    await receive(socket, { type: "prompt-delivered", id, depth: 0 });
    await flush();
    await receive(socket, { type: "prompt-cancelled", id, removed: false });
    await flush();
    expect(target.querySelector(".rp-text")?.textContent).toBe("already sent");
    expect(view.state.doc.toString()).toBe("");
    expect(view.state.readOnly).toBe(false);
    expect(tab.pendingPrompt).toBeUndefined();
    expect(cancels(socket)).toEqual([{ type: "cancel-prompt", id }]);
    expect(api.write).toHaveBeenLastCalledWith(".Drafts/recall/draft.md", "");
  });

  test.each(ORIGINS)("no acknowledgement fails the %s at five seconds", async (origin) => {
    const { tab, socket, id, target, view } = await recall(origin);
    await vi.advanceTimersByTimeAsync(4999);
    expect(target.querySelector(".rp-text")?.textContent).not.toBe(FAILED);
    expect(view.state.readOnly).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(target.querySelector(".rp-text")?.textContent).toBe(FAILED);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.doc.toString()).toBe(TEXT);
    expect(tab.pendingPrompt).toBeUndefined();
    expect(cancels(socket)).toEqual([{ type: "cancel-prompt", id }]);
  });

  test.each(ORIGINS)("socket close fails the %s while recall awaits acknowledgement", async (origin) => {
    const { tab, socket, id, target, view } = await recall(origin);
    socket.close();
    await flush();
    expect(target.querySelector(".rp-text")?.textContent).toBe(FAILED);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.doc.toString()).toBe(TEXT);
    expect(tab.pendingPrompt).toBeUndefined();
    expect(cancels(socket)).toEqual([{ type: "cancel-prompt", id }]);
  });
});
