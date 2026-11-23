// @vitest-environment jsdom
//
// The keys TerminalTab decides before the terminal encodes them. A
// TerminalTab is mounted on the shared fixture's widget and each key is a
// keydown at the element the widget focuses; the assertions read what the
// product shows for it: the frames sent the PTY and whether the key's
// default was prevented.

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
import { mountGhosttyTerminal, pressInGhostty } from "../__tests__/ghosttyTab";
import {
  attach,
  installTerminalDom,
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
  const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
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
  test("claims Alt+Space for no chord: the terminal sends it as Meta+Space", async () => {
    const { term, socket } = await attachedTerminal();
    pressInGhostty(term, { key: " ", code: "Space", keyCode: 32, altKey: true });

    expect(inputs(socket)).toEqual(["\x1b "]);
  });

  test("hands Alt+Left and Alt+Backspace to the shell as word motions", async () => {
    const { term, socket } = await attachedTerminal();
    const left = pressInGhostty(term, { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, altKey: true });
    const back = pressInGhostty(term, { key: "Backspace", code: "Backspace", keyCode: 8, altKey: true });

    expect(left.defaultPrevented).toBe(true);
    expect(back.defaultPrevented).toBe(true);
    // Exactly these bytes, once each: the terminal's own encoding of the
    // two keys never follows them.
    expect(inputs(socket)).toEqual(["\x1bb", "\x1b\x7f"]);
  });

  test("leaves a plain key to the terminal, which types it once", async () => {
    const { term, socket } = await attachedTerminal();
    pressInGhostty(term, { key: "a", code: "KeyA", keyCode: 65 });
    expect(inputs(socket)).toEqual(["a"]);
  });
});
