// @vitest-environment jsdom
//
// What the terminal sends back while it parses PTY output: answers to the
// running program's queries, and the keyboard protocol that program
// negotiates. A TerminalTab is mounted on the shared fixture's widget; the
// program's queries and requests are PTY output its core parses, and the
// assertions read the frames sent on the socket.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { WS_RECONNECT_BACKOFF_MAX_MS } from "../api/transport";
import type { TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { createTerminalKeyboardProtocolState } from "../terminal/keymap";
import { mountGhosttyTerminal, pressInGhostty, typeInGhostty } from "../__tests__/ghosttyTab";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

/// The core's answer to a cursor position query at the top left cell.
const CPR = "\x1b[1;1R";
/// Shift+Enter, as a browser reports it.
const SHIFT_ENTER = { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true };

afterEach(() => {
  // Before resetTerminals, which puts back the requestAnimationFrame
  // stand-in that uninstalling the fake clock removes.
  vi.useRealTimers();
  resetTerminals();
});

async function attached(over: Partial<TerminalTabState> = {}, ready = true) {
  const [tab] = seatTerminals([terminalTab(over)]);
  const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
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

describe("answers the terminal generates while parsing output", () => {
  test("a live answer goes to this PTY only, even with broadcast on", async () => {
    const { socket } = await attached({ broadcastEnabled: true });
    await output(socket, "\x1b[6n");

    expect(frames(socket, "input")).toEqual([CPR]);
    expect(frames(socket, "broadcast-input")).toEqual([]);
  });

  test("an answer to history replayed into a reattached terminal is dropped", async () => {
    const { socket } = await attached({ terminalSessionId: "sess-9" }, false);
    await output(socket, "\x1b[6n");

    expect(frames(socket, "input")).toEqual([]);
    // The control: the same query once the replay is over is answered.
    await receive(socket, { type: "ready", cols: 80, rows: 24 });
    await output(socket, "\x1b[6n");
    expect(frames(socket, "input"), "a live query is answered").toEqual([CPR]);
  });

  test("an answer to history replayed on a redial of a live terminal is dropped", async () => {
    vi.useFakeTimers();
    const { socket: first } = await attached();
    first.close();
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_BACKOFF_MAX_MS);
    const redial = TerminalSocket.all.at(-1)!;
    expect(redial, "the redial").not.toBe(first);
    await attach(redial, { id: "sess-1" });
    await output(redial, "\x1b[6n");

    expect(frames(redial, "input")).toEqual([]);
    await receive(redial, { type: "ready", cols: 80, rows: 24 });
    await output(redial, "\x1b[6n");
    expect(frames(redial, "input"), "a live query is answered").toEqual([CPR]);
  });

  test("typing reaches the PTY and, with broadcast on, the broadcast group", async () => {
    const { term, socket } = await attached({ broadcastEnabled: true });
    typeInGhostty(term, "ls");

    expect(frames(socket, "input")).toEqual(["ls"]);
    expect(frames(socket, "broadcast-input")).toEqual(["ls"]);
  });
});

describe("the program's queries and requests", () => {
  test("color queries are consumed without answering the PTY", async () => {
    const { socket } = await attached();
    for (const query of ["\x1b]4;1;?\x07", "\x1b]10;?\x07", "\x1b]11;?\x07", "\x1b]12;?\x1b\\"]) {
      await output(socket, query);
    }
    expect(sentFrames(socket)).toEqual([]);
    // The control: a query the terminal does answer goes out on this socket.
    await output(socket, "\x1b[6n");
    expect(frames(socket, "input")).toEqual([CPR]);
  });

  test("a program's modifyOtherKeys request changes what Shift+Enter sends", async () => {
    const { term, socket } = await attached();
    pressInGhostty(term, SHIFT_ENTER);
    await output(socket, "\x1b[>4;2m");
    pressInGhostty(term, SHIFT_ENTER);

    expect(frames(socket, "input")).toEqual(["\n", "\x1b[27;2;13~"]);
  });

  describe("a restored tab's negotiated protocol", () => {
    /// A tab restored with a session id and the modifyOtherKeys its program
    /// negotiated, whose dial the server answers with `answeredId`.
    async function restored(answeredId: string) {
      const keyboardProtocol = createTerminalKeyboardProtocolState();
      keyboardProtocol.xtermModifyOtherKeys = 2;
      const [tab] = seatTerminals([terminalTab({ terminalSessionId: "sess-restored", keyboardProtocol })]);
      const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
      const socket = TerminalSocket.all.at(-1)!;
      await attach(socket, { id: answeredId });
      await receive(socket, { type: "ready", cols: 80, rows: 24 });
      socket.sent.splice(0);
      pressInGhostty(term, SHIFT_ENTER);
      return frames(socket, "input");
    }

    test("is dropped when a fresh shell replaces the session", async () => {
      expect(await restored("sess-fresh")).toEqual(["\n"]);
    });

    test("is kept when the session itself is resumed", async () => {
      expect(await restored("sess-restored")).toEqual(["\x1b[27;2;13~"]);
    });
  });

  test("a keyboard-protocol query is answered on the PTY", async () => {
    const { socket } = await attached();
    await output(socket, "\x1b[?u");
    // Once: the core's own answer is not sent beside chan's.
    expect(frames(socket, "input")).toEqual(["\x1b[?0u"]);
  });
});
