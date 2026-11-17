// @vitest-environment jsdom

import type { Terminal } from "@chan/ghostty-web-ng";
import { tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const ghostty = vi.hoisted(() => ({
  module: null as WebAssembly.Module | null,
  terminals: [] as Terminal[],
}));

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { recordingKit } = await import("../__tests__/ghosttyTab");
  return { ...actual, loadGhosttyKit: async () => recordingKit(ghostty, actual.ghosttyKitFrom) };
});
vi.mock("../terminal/ghosttyCompat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal/ghosttyCompat")>()),
  ...(await import("../__tests__/ghosttyTab")).ghosttyCompatStubs(),
}));

import TerminalTab from "./TerminalTab.svelte";
import {
  compileGhosttyCore, ghosttyLineText, installSoftwareCanvas, mountGhostty,
} from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import {
  attach, installTerminalDom, output, receive, resetTerminals, seatTerminals,
  sentFrames, terminalTab, TerminalSocket,
} from "../__tests__/terminalTab";
import { WS_RECONNECT_BACKOFF_MIN_MS } from "../api/transport";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { registerTerminalInputSink } from "../state/tabs.svelte";

const SESSION = "sess-stream";
const QUERY = "\x1b[12;3H\x1b[6n";
const CPR = "\x1b[12;3R";
const mounted: Array<Record<string, unknown>> = [];
const cleanups: Array<() => void> = [];
let canvas: ReturnType<typeof installSoftwareCanvas>;

installTerminalDom();

beforeAll(async () => {
  await compileGhosttyCore(ghostty);
});

beforeEach(() => {
  vi.useFakeTimers();
  canvas = installSoftwareCanvas();
  __testSetStandalonePreferences(terminalPreferences({ ghostty: true, secret_masking: false }));
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  resetTerminals();
  ghostty.terminals.splice(0);
  __testSetStandalonePreferences(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openStream(options: { restored?: boolean; ready?: boolean; focused?: boolean; unseen?: number } = {}) {
  const [tab, sibling] = seatTerminals([
    terminalTab({ broadcastEnabled: true, ...(options.restored && { terminalSessionId: SESSION }) }),
    terminalTab({ id: "term-sibling", broadcastEnabled: true }),
  ]);
  const siblingInput: string[] = [];
  cleanups.push(registerTerminalInputSink(sibling!.id, (data) => siblingInput.push(data)));
  const opened = mountGhostty(TerminalTab, tab!, { focused: options.focused ?? true });
  mounted.push(opened.component);
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(opened.socketCount + 1));
  const socket = TerminalSocket.all.at(-1)!;
  socket.open();
  await receive(socket, {
    type: "session", id: SESSION, seq: 0, generation: 1, missed_bytes: 0,
    bytes_since_focus: options.unseen ?? 0,
  });
  if (options.ready !== false) await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await tick();
  socket.sent.splice(0);
  const term = ghostty.terminals.at(-1)!;
  const host = opened.target.querySelector<HTMLElement>(".terminal-host")!;
  expect(host.querySelector("canvas")).not.toBeNull();
  const emitted: string[] = [];
  const subscription = term.onData((data) => emitted.push(data));
  cleanups.push(() => subscription.dispose());
  return { tab: tab!, term, host, socket, siblingInput, emitted };
}

function inputFrames(socket: TerminalSocket) {
  return sentFrames(socket).filter((frame) => frame.type === "input" || frame.type === "broadcast-input");
}

describe("queries parsed by a mounted Ghostty terminal", () => {
  test("a fresh program's query before ready reaches only its PTY, while typing reaches its group", async () => {
    const { socket, host, siblingInput, emitted } = await openStream({ ready: false });
    await output(socket, QUERY);
    expect(emitted, "the real core generated a cursor position report").toEqual([CPR]);
    expect(inputFrames(socket)).toEqual([{ type: "input", data: CPR }]);
    expect(siblingInput).toEqual([]);

    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    socket.sent.splice(0);
    host.dispatchEvent(new KeyboardEvent("keydown", {
      key: "a", code: "KeyA", bubbles: true, cancelable: true,
    }));
    expect(inputFrames(socket)).toEqual([
      { type: "input", data: "a" }, { type: "broadcast-input", data: "a" },
    ]);
    expect(siblingInput, "the sibling route is live for user input").toEqual(["a"]);
  });

  test.each([false, true])("replayed DSR stays local to the parser and live DSR reaches the PTY after ready, cut redial %s", async (cut) => {
    const opened = await openStream({ restored: true, ready: false });
    let socket = opened.socket;
    if (cut) {
      await output(socket, "abandoned replay");
      socket.close();
      await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MIN_MS);
      expect(TerminalSocket.all).toHaveLength(2);
      socket = TerminalSocket.all.at(-1)!;
      await attach(socket, { id: SESSION, replay_bytes: QUERY.length });
      socket.sent.splice(0);
    }

    await output(socket, QUERY);
    expect(opened.emitted, "suppression follows parsing, not removal of the query").toEqual([CPR]);
    expect(inputFrames(socket), "historical replies must not reach either socket route").toEqual([]);
    expect(opened.siblingInput).toEqual([]);

    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await output(socket, QUERY);
    expect(opened.emitted).toEqual([CPR, CPR]);
    expect(inputFrames(socket), "a current query is answered once without broadcast").toEqual([{ type: "input", data: CPR }]);
    expect(opened.siblingInput).toEqual([]);
    expect(ghostty.terminals, "redial keeps the same real widget").toEqual([opened.term]);
  });
});

describe("server-owned activity on a mounted Ghostty terminal", () => {
  test.each([
    ["a control-only repaint", "\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[?2026l", ""],
    ["visible output without an activity frame", "unannounced", "unannounced"],
  ])("%s cannot raise or pulse an unfocused tab's dot", async (_name, bytes, text) => {
    const { tab, term, socket } = await openStream({ focused: false });
    await output(socket, bytes);
    canvas.frame();
    expect(ghosttyLineText(term, 0), "the real core consumed the output").toBe(text);
    expect(tab.terminalActivity).toBeUndefined();
    expect(tab.terminalActivityPulsing).toBeUndefined();
  });

  test("an activity frame raises the dot, output pulses it, and a zero count clears both", async () => {
    const { tab, term, socket } = await openStream({ focused: false });
    await receive(socket, { type: "activity", bytes_since_focus: 5 });
    expect(tab.terminalActivity).toBe(true);
    expect(tab.terminalActivityPulsing).toBeUndefined();
    await output(socket, "hello");
    canvas.frame();
    expect(ghosttyLineText(term, 0)).toBe("hello");
    expect(tab.terminalActivityPulsing).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(tab.terminalActivity, "quiet output leaves a solid unseen dot").toBe(true);
    expect(tab.terminalActivityPulsing).toBeUndefined();

    await output(socket, " again");
    expect(tab.terminalActivityPulsing).toBe(true);
    await receive(socket, { type: "activity", bytes_since_focus: 0 });
    expect(tab.terminalActivity).toBeUndefined();
    expect(tab.terminalActivityPulsing).toBeUndefined();
    await output(socket, " uncounted");
    expect(tab.terminalActivity).toBeUndefined();
    expect(tab.terminalActivityPulsing).toBeUndefined();
  });

  test.each([
    { focused: false, unseen: 0, marked: undefined },
    { focused: false, unseen: 7, marked: true },
    { focused: true, unseen: 7, marked: undefined },
  ])("session count $unseen with focused $focused decides activity before and after replay", async ({ focused, unseen, marked }) => {
    const { tab, term, socket } = await openStream({ restored: true, ready: false, focused, unseen });
    expect(tab.terminalActivity).toBe(marked);
    expect(tab.terminalActivityPulsing).toBeUndefined();
    await output(socket, "history");
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    canvas.frame();
    expect(ghosttyLineText(term, 0)).toBe("history");
    expect(tab.terminalActivity).toBe(marked);
    expect(tab.terminalActivityPulsing).toBe(marked);
    await receive(socket, { type: "activity", bytes_since_focus: 9 });
    expect(tab.terminalActivity, "focused readers ignore subsequent activity frames too").toBe(focused ? undefined : true);
  });
});
