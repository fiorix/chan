// @vitest-environment jsdom
//
// The shared widget fixture's own cases: what a mounted test that declares
// it gets, and that its helpers observe what they name.

import { Terminal } from "@chan/ghostty-web-ng";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("./terminalTab")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("./ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
  (await import("./ghosttyTab")).ghosttyCompatModule(importOriginal));

import TerminalTab from "../components/TerminalTab.svelte";
import { ghosttyFixture, ghosttyHasFocus, mountGhosttyTerminal, pressInGhostty, typeInGhostty } from "./ghosttyTab";
import {
  attach,
  installTerminalDom,
  mountTerminal,
  resetTerminals,
  seatTerminals,
  sentFrames,
  TerminalSocket,
  terminalTab,
  xterm,
} from "./terminalTab";

installTerminalDom();

afterEach(() => {
  resetTerminals();
});

async function opened() {
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountGhosttyTerminal(TerminalTab, tab!);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: "sess-fixture" });
  return { ...mounted, socket };
}

const inputs = (socket: TerminalSocket) =>
  sentFrames(socket).filter((frame) => frame.type === "input").map((frame) => frame.data);

test("the checked mount returns the fixture's widget, open in the tab, and no stand-in", async () => {
  const { target, term } = await opened();
  expect(term).toBeInstanceOf(Terminal);
  expect(term.element && target.contains(term.element)).toBe(true);
  expect(ghosttyFixture.terminals).toEqual([term]);
  expect(xterm.terminals).toHaveLength(0);
});

test("mountTerminal under the fixture refuses to hand the widget out as the stand-in", async () => {
  const [tab] = seatTerminals([terminalTab()]);
  const mounted = await mountTerminal(TerminalTab, tab!);
  expect(() => mounted.term).toThrow(/mountGhosttyTerminal/);
  expect({ ...mounted }, "a spread reads nothing").not.toHaveProperty("term");
  expect(ghosttyFixture.terminals).toHaveLength(1);
});

test("typed input reaches the PTY", async () => {
  const { term, socket } = await opened();
  typeInGhostty(term, "ls\r");
  await vi.waitFor(() => expect(inputs(socket)).toEqual(["ls\r"]));
});

// Whichever of the app's key handling and the widget's encoder takes a key,
// what it did is what went out on the socket.
test.each([
  ["a letter", { key: "a", code: "KeyA", keyCode: 65 }, "a"],
  ["Escape", { key: "Escape", code: "Escape", keyCode: 27 }, "\x1b"],
  ["Enter", { key: "Enter", code: "Enter", keyCode: 13 }, "\r"],
  ["Ctrl+C", { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true }, "\x03"],
])("%s sends what a terminal sends for it, its default prevented", async (_name, init, data) => {
  const { term, socket } = await opened();
  socket.sent.splice(0);
  const event = pressInGhostty(term, init);
  await vi.waitFor(() => expect(inputs(socket)).toEqual([data]));
  expect(event.defaultPrevented).toBe(true);
});

test("chan's copy chord sends the program nothing", async () => {
  const { term, socket } = await opened();
  socket.sent.splice(0);
  const event = pressInGhostty(term, { key: "C", code: "KeyC", keyCode: 67, ctrlKey: true, shiftKey: true });
  // A letter after it marks where the chord's input would have been.
  pressInGhostty(term, { key: "a", code: "KeyA", keyCode: 65 });
  await vi.waitFor(() => expect(inputs(socket)).toEqual(["a"]));
  expect(event.defaultPrevented).toBe(true);
});

test("focus inside the terminal follows focus() and blur()", async () => {
  const { term } = await opened();
  term.focus();
  expect(ghosttyHasFocus(term)).toBe(true);
  term.blur();
  expect(ghosttyHasFocus(term)).toBe(false);
});
