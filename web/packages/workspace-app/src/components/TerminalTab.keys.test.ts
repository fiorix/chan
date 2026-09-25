// @vitest-environment jsdom
//
// The key handler TerminalTab registers with xterm, which sees every key
// before xterm does. A TerminalTab is mounted over the stand-in xterm and
// keys are handed to that handler the way xterm hands them; the assertions
// read its answer (false tells xterm to skip the key) and the frames the
// component sent the PTY.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  pressInTerminal,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

afterEach(() => {
  resetTerminals();
});

async function attachedTerminal() {
  const [tab] = seatTerminals([terminalTab()]);
  const { term } = await mountTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket);
  socket.sent.splice(0);
  return { term, socket };
}

function inputs(socket: TerminalSocket): unknown[] {
  return sentFrames(socket)
    .filter((f) => f.type === "input")
    .map((f) => f.data);
}

describe("the terminal key handler", () => {
  test("leaves Alt+Space to xterm and sends the PTY nothing of its own", async () => {
    const { term, socket } = await attachedTerminal();
    const { event, handled } = pressInTerminal(term, { key: " ", code: "Space", altKey: true });

    expect(handled, "xterm processes the key").toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(inputs(socket)).toEqual([]);
  });

  test("hands Alt+Left and Alt+Backspace to the shell as word motions", async () => {
    const { term, socket } = await attachedTerminal();
    const left = pressInTerminal(term, { key: "ArrowLeft", altKey: true });
    const back = pressInTerminal(term, { key: "Backspace", altKey: true });

    expect([left.handled, back.handled], "xterm skips both").toEqual([false, false]);
    expect(left.event.defaultPrevented).toBe(true);
    expect(inputs(socket)).toEqual(["\x1bb", "\x1b\x7f"]);
  });

  test("leaves a plain key to xterm", async () => {
    const { term, socket } = await attachedTerminal();
    expect(pressInTerminal(term, { key: "a" }).handled).toBe(true);
    expect(inputs(socket)).toEqual([]);
  });
});
