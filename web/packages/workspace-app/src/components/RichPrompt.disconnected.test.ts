// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { Terminal as GhosttyTerminal } from "@chan/ghostty-web-ng";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { useXtermStandIn } from "../__tests__/xterm";

const runtime = vi.hoisted(() => ({ terminals: [] as unknown[], module: null as WebAssembly.Module | null }));

vi.mock("@xterm/xterm", async (original) => {
  const actual = await original<typeof import("@xterm/xterm")>();
  return { ...actual, Terminal: class extends actual.Terminal {
    constructor(options: ConstructorParameters<typeof actual.Terminal>[0]) {
      super(options);
      runtime.terminals.push(this);
    }
  } };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { activate() {} dispose() {} fit() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (original) => {
  const actual = await original<typeof import("../terminal/backend")>();
  const { Terminal } = await import("@chan/ghostty-web-ng");
  return (await import("../__tests__/xterm")).xtermStandInSwitch({ ...actual, loadGhosttyKit: async () => actual.ghosttyKitFrom(runtime.module!, {
    Terminal: class extends Terminal {
      constructor(options: ConstructorParameters<typeof Terminal>[0]) {
        super(options);
        runtime.terminals.push(this);
      }
    },
  }) });
});
vi.mock("../api/client", async (original) => {
  const actual = await original<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api,
    read: vi.fn(async () => ({ content: "keep this prompt" })),
    write: vi.fn(async () => ({})),
  } };
});

import TerminalTab from "./TerminalTab.svelte";
import { installSoftwareCanvas } from "../__tests__/ghosttyTab";
import { draftPath } from "../__tests__/drafts";
import { terminalPreferences } from "../__tests__/standalone";
import { installEditorDom, press } from "../__tests__/wysiwyg";
import { attach, installTerminalDom, output, receive, resetTerminals, seatTerminals, sentFrames, terminalTab, TERMINAL_PANE, TerminalSocket } from "../__tests__/terminalTab";
import { richPrompt, showRichPromptForTab } from "../state/richPrompt.svelte";
import { __testSetStandalonePreferences } from "../state/store.svelte";

const TEXT = "keep this prompt";
const NOTICE = "terminal not connected; try again";
type Terminal = XtermTerminal | GhosttyTerminal;
let component: ReturnType<typeof mount> | undefined;

installTerminalDom();
installEditorDom();
beforeAll(async () => {
  runtime.module = await WebAssembly.compile(readFileSync("../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm"));
});
beforeEach(() => {
  runtime.terminals.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  installSoftwareCanvas();
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("xterm-char-measure-element") ? 256 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("xterm-char-measure-element") ? 17 : 0;
  });
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
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
  return term instanceof GhosttyTerminal ? term.getViewportY() : term.buffer.active.baseY - term.buffer.active.viewportY;
}

async function composer(backend: "xterm" | "ghostty") {
  useXtermStandIn(backend === "xterm");
  __testSetStandalonePreferences(terminalPreferences({ secret_masking: false }));
  const [tab] = seatTerminals([terminalTab({ richPromptDraftPath: draftPath("offline"), submitAgent: "claude" })]);
  const target = document.createElement("div");
  document.body.append(target);
  component = mount(TerminalTab, { target, props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true } });
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const term = runtime.terminals[0] as Terminal;
  expect(term instanceof GhosttyTerminal).toBe(backend === "ghostty");
  const socket = TerminalSocket.all[0]!;
  const prelude = { id: "sess-prompt", submit_agent: "claude" };
  await attach(socket, prelude);
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, Array.from({ length: 100 }, (_, i) => `history ${i}\r\n`).join(""));
  await vi.waitFor(() => expect(term instanceof GhosttyTerminal ? term.getScrollbackLength() : term.buffer.active.baseY).toBeGreaterThan(50));
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

describe.each(["xterm", "ghostty"] as const)("%s Rich Prompt while disconnected", (backend) => {
  test.each([0, 2, 3])("socket state %s shows a refusal and keeps editable text for an explicit retry", async (readyState) => {
    const { target, tab, term, socket, view, submit, note } = await composer(backend);
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
    const { tab, socket, view, submit, note } = await composer(backend);
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
    const { tab, socket, view, submit, note } = await composer(backend);
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
    const { tab, socket, view, submit, note } = await composer(backend);
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
