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
import {
  ghosttyFixture,
  ghosttyHasFocus,
  holdGhosttyLoads,
  mountGhosttyTerminal,
  pressInGhostty,
  typeInGhostty,
} from "./ghosttyTab";
import { SoftwareCanvasContext } from "./softwareCanvas";
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
  vi.restoreAllMocks();
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

test("the product's glyph painter and overlay scrollbar install on the fixture's widget", async () => {
  const compat = await import("../terminal/ghosttyCompat");
  const actual = await vi.importActual<typeof import("../terminal/ghosttyCompat")>("../terminal/ghosttyCompat");
  expect(compat.installGhosttyCustomGlyphs, "the product's glyph painter").toBe(actual.installGhosttyCustomGlyphs);
  expect(compat.installGhosttyOverlayScrollbar, "the product's overlay scrollbar").toBe(actual.installGhosttyOverlayScrollbar);

  const warn = vi.spyOn(console, "warn");
  await opened();
  const hooks = warn.mock.calls.filter(([first]) => typeof first === "string" && first.startsWith("[chan] ghostty-web"));
  expect(hooks, "no compat hook failed open").toEqual([]);
});

// The widget dials once it has loaded and opened, so the mount waits for the
// widget before it looks for the socket; a socket wait first would give up at
// its own bound, a second, on a load slower than that.
test("mountTerminal outlasts a load slower than a second", async () => {
  const release = holdGhosttyLoads();
  const [tab] = seatTerminals([terminalTab()]);
  const mounting = mountTerminal(TerminalTab, tab!);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(TerminalSocket.all, "nothing dials before the widget opens").toHaveLength(0);
  release();
  await mounting;
  expect(ghosttyFixture.terminals).toHaveLength(1);
  expect(TerminalSocket.all).toHaveLength(1);
});

// A hold lasts until its release or the next reset, so a case that holds and
// never releases leaves the file's later loads alone.
test("a reset lets go of a hold its case never released", async () => {
  holdGhosttyLoads();
  resetTerminals();
  const { term } = await opened();
  expect(ghosttyFixture.terminals).toEqual([term]);
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

test("while a terminal is open only a 2D context is the fixture's, and the last one to close gives canvases back", async () => {
  const environment = HTMLCanvasElement.prototype.getContext;
  await opened();
  const canvas = document.createElement("canvas");
  expect(canvas.getContext("2d")).toBeInstanceOf(SoftwareCanvasContext);
  expect(canvas.getContext("webgl2"), "another id gets the environment's answer").not.toBeInstanceOf(SoftwareCanvasContext);
  resetTerminals();
  expect(HTMLCanvasElement.prototype.getContext).toBe(environment);
});

test("a reset gives canvases back even when a terminal was never disposed", async () => {
  const environment = HTMLCanvasElement.prototype.getContext;
  const { term } = await opened();
  const dispose = vi.spyOn(term, "dispose").mockImplementation(() => {});
  try {
    resetTerminals();
    expect(dispose, "the unmount asked the terminal to dispose").toHaveBeenCalled();
    expect(HTMLCanvasElement.prototype.getContext).toBe(environment);
  } finally {
    dispose.mockRestore();
    term.dispose();
  }
  expect(HTMLCanvasElement.prototype.getContext, "a late dispose takes nothing back").toBe(environment);

  // The next terminal is served and gives canvases back on its own close.
  await opened();
  expect(document.createElement("canvas").getContext("2d")).toBeInstanceOf(SoftwareCanvasContext);
  resetTerminals();
  expect(HTMLCanvasElement.prototype.getContext).toBe(environment);
});

test("focus inside the terminal follows focus() and blur()", async () => {
  const { term } = await opened();
  term.focus();
  expect(ghosttyHasFocus(term)).toBe(true);
  term.blur();
  expect(ghosttyHasFocus(term)).toBe(false);
});
