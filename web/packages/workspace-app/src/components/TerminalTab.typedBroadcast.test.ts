// @vitest-environment jsdom
//
// A key typed into a terminal of a broadcast group reaches the group while
// the terminal's output keeps arriving; a reply the terminal makes to its
// program reaches this PTY alone. TerminalTab is mounted on the shared
// fixture's widget. The widget marks no data as the user's, so every chunk
// takes the unmarked route, which reads only whether a write is in flight:
// a chunk the terminal emits inside a live write is a reply and stays here,
// any other chunk goes to the group. The core parses a write before write()
// returns and answers its queries from inside it, so a key, which a later
// event makes, always finds the write over.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyCompatModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { ghosttyLineText, mountGhosttyTerminal, pressInGhostty } from "../__tests__/ghosttyTab";
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

afterEach(() => {
  resetTerminals();
});

async function attached() {
  const [tab] = seatTerminals([terminalTab({ broadcastEnabled: true })]);
  const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: "sess-1" });
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  // The session prelude writes a reset of the program's input modes as a
  // replay. Let a frame pass, so a write completion held to one has run and
  // the output a test sends is the one write that can be pending, a live one.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  socket.sent.splice(0);
  return { term, socket };
}

function frames(socket: TerminalSocket, type: string): unknown[] {
  return sentFrames(socket)
    .filter((f) => f.type === type)
    .map((f) => f.data);
}

describe("a terminal in a broadcast group, while its output arrives", () => {
  test("sends a key the user types to the group", async () => {
    const { term, socket } = await attached();
    await output(socket, "steady output\r\n");
    // Parsed inside the write: the output is on the screen by the time the
    // next event, the key, can come.
    expect(ghosttyLineText(term, 0)).toBe("steady output");
    pressInGhostty(term, { key: "k", code: "KeyK", keyCode: 75 });

    expect(frames(socket, "input")).toEqual(["k"]);
    expect(frames(socket, "broadcast-input")).toEqual(["k"]);
  });

  test("sends the parser's reply to this PTY alone", async () => {
    const { socket } = await attached();
    await output(socket, "\x1b[6n");

    const sent = frames(socket, "input");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\x1b\[\d+;\d+R$/);
    expect(frames(socket, "broadcast-input")).toEqual([]);
  });
});
