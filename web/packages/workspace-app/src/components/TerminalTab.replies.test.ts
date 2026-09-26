// @vitest-environment jsdom
//
// What xterm sends back while it parses PTY output: answers to the running
// program's queries, and the keyboard protocol that program negotiates. A
// TerminalTab is mounted over the stand-in xterm, which can answer during a
// write and runs the parser handlers the component registered; the
// assertions read the frames sent on the socket.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { WS_RECONNECT_BACKOFF_MAX_MS } from "../api/transport";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  output,
  pressInTerminal,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const CPR = "\x1b[12;1R";

afterEach(() => {
  // Before resetTerminals, which puts back the requestAnimationFrame
  // stand-in that uninstalling the fake clock removes.
  vi.useRealTimers();
  resetTerminals();
});

async function attached(over: Partial<TerminalTabState> = {}, ready = true) {
  const [tab] = seatTerminals([terminalTab(over)]);
  const { term } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: over.terminalSessionId ?? "sess-1" });
  if (ready) await receive(socket, { type: "ready", cols: 80, rows: 24 });
  socket.sent.splice(0);
  return { term, socket };
}

function frames(socket: TerminalSocket, type: string): unknown[] {
  return sentFrames(socket)
    .filter((f) => f.type === type)
    .map((f) => f.data);
}

describe("answers xterm generates while parsing output", () => {
  test("a live answer goes to this PTY only, even with broadcast on", async () => {
    const { term, socket } = await attached({ broadcastEnabled: true });
    term.replyDuringWrite = CPR;
    await output(socket, "\x1b[6n");

    expect(frames(socket, "input")).toEqual([CPR]);
    expect(frames(socket, "broadcast-input")).toEqual([]);
  });

  test("an answer to history replayed into a reattached terminal is dropped", async () => {
    const { term, socket } = await attached({ terminalSessionId: "sess-9" }, false);
    term.replyDuringWrite = CPR;
    await output(socket, "\x1b[6n");

    expect(frames(socket, "input")).toEqual([]);
  });

  test("an answer to history replayed on a redial of a live terminal is dropped", async () => {
    vi.useFakeTimers();
    const { term, socket: first } = await attached();
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    const redial = TerminalSocket.all.at(-1)!;
    expect(redial, "the redial").not.toBe(first);
    await attach(redial, { id: "sess-1" });
    term.replyDuringWrite = CPR;
    await output(redial, "\x1b[6n");

    expect(frames(redial, "input")).toEqual([]);
  });

  test("typing reaches the PTY and, with broadcast on, the broadcast group", async () => {
    const { term, socket } = await attached({ broadcastEnabled: true });
    term.type("ls");

    expect(frames(socket, "input")).toEqual(["ls"]);
    expect(frames(socket, "broadcast-input")).toEqual(["ls"]);
  });
});

describe("the parser handlers", () => {
  test("color queries are consumed without answering the PTY", async () => {
    const { term, socket } = await attached();
    for (const ident of [4, 10, 11, 12]) {
      expect(term.parser.osc.get(ident)?.(ident === 4 ? "1;?" : "?"), `OSC ${ident}`).toBe(true);
    }
    expect(sentFrames(socket)).toEqual([]);
  });

  test("a program's modifyOtherKeys request changes what Shift+Enter sends", async () => {
    const { term, socket } = await attached();
    pressInTerminal(term, { key: "Enter", shiftKey: true });
    term.csi(">", "m", [4, 2]);
    pressInTerminal(term, { key: "Enter", shiftKey: true });

    expect(frames(socket, "input")).toEqual(["\n", "\x1b[27;2;13~"]);
  });

  test("a keyboard-protocol query is answered on the PTY", async () => {
    const { term, socket } = await attached();
    term.csi("?", "u", []);
    expect(frames(socket, "input")).toEqual(["\x1b[?0u"]);
  });
});
