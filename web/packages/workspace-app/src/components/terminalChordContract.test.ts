// @vitest-environment jsdom
//
// The renderer keyboard contract: each chord the terminal claims produces
// exactly one action, from whichever owner sees it first, whether the renderer
// has focus or not.
//
// TerminalTab is mounted on the shared fixture's widget, and a chord is a
// keydown at the element the widget focuses or at the component root. On
// the widget's element chan's capture listener decides every key first: a
// chord chan claims flows on to the widget, which calls chan's custom key
// handler, any other key is encoded there or left to the widget's own
// encoder, and the frames sent the PTY are what each key did.
//
// The Ctrl+D-on-an-exited-terminal half of the single-dispatch rule has its
// own file; this one covers the chords around it.
//
// Terminal find is here: the owner settled who owns Mod+F in a focused
// terminal, and the chord carries Shift off macOS so a bare Ctrl+F stays the
// shell's. The chord reaches the component root from the widget only
// because its registry entry is flagged `escapeTerminal`, which is how chan's
// capture listener knows to let it through: without the flag find does not
// open from the widget. The decision the flag feeds is pinned in
// `state/chordEscapeRegistry.test.ts` as well.

import { tick } from "svelte";
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
import { currentOS } from "../state/shortcuts";
import { layout, type LeafNode, type TerminalTab as TerminalTabState } from "../state/tabs.svelte";
import { ghosttySelect, ghosttySelection, mountGhosttyTerminal, pressInGhostty } from "../__tests__/ghosttyTab";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";
import {
  attach,
  installTerminalDom,
  output,
  receive,
  resetTerminals,
  sentFrames,
  TERMINAL_PANE,
  TerminalSocket,
} from "../__tests__/terminalTab";

installTerminalDom();

const SELECTION = "selected terminal text";

const writeText = vi.fn(async (_text: string) => {});
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});

afterEach(() => {
  resetTerminals();
  writeText.mockClear();
});

function paneTabIds(): string[] {
  return (layout.nodes[TERMINAL_PANE] as LeafNode).tabs.map((t) => t.id);
}

/// Mount the pane's terminal beside a neighbour, with SELECTION on its first
/// row and selected. `exited` drives it to the state in which Ctrl+D is the
/// close-this-tab chord rather than EOF.
async function mountTerminal(exited: boolean) {
  const pane = resetLayout([terminalTab({ id: "term-chords" }), fileTab({ id: "file-neighbour", path: "notes/neighbour.md" })], {
    id: TERMINAL_PANE,
  });
  const tab = pane.tabs.find((t) => t.kind === "terminal") as TerminalTabState;
  const { term } = await mountGhosttyTerminal(TerminalTab, tab);
  const socket = TerminalSocket.all.at(-1)!;
  await attach(socket, { id: "term-session" });
  await receive(socket, { type: "ready", cols: 80, rows: 24 });
  await output(socket, SELECTION);
  ghosttySelect(term, 0, 0, SELECTION.length);
  expect(ghosttySelection(term), "the fixture's selection").toBe(SELECTION);
  if (exited) await receive(socket, { type: "exit", code: 0 });
  await tick();
  socket.sent.splice(0);
  return { socket, term };
}

function root(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(".terminal-tab");
  expect(el).not.toBeNull();
  return el!;
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await tick();
}

function inputFrames(socket: TerminalSocket): unknown[] {
  return sentFrames(socket)
    .filter((f) => f.type === "input")
    .map((f) => f.data);
}

const COPY = { key: "C", code: "KeyC", keyCode: 67, ctrlKey: true, shiftKey: true };

describe("the chord the terminal claims for copy", () => {
  test("the fixture runs on the OS whose copy chord is Ctrl+Shift+C", () => {
    // Off macOS the copy chord is Ctrl+Shift+C, because bare Ctrl+C is the
    // shell's SIGINT. A jsdom user agent reads as linux; if that ever
    // changes, the chord below is the wrong one and this says so.
    expect(currentOS()).toBe("linux");
  });

  test("copies once from the widget's own key path", async () => {
    const { socket, term } = await mountTerminal(false);

    pressInGhostty(term, COPY);
    await settle();

    expect(writeText.mock.calls).toEqual([[SELECTION]]);
    expect(inputFrames(socket), "and sends the shell nothing").toEqual([]);
  });

  test("copies once from the component root", async () => {
    await mountTerminal(false);

    root().dispatchEvent(key(COPY));
    await settle();

    expect(writeText.mock.calls).toEqual([[SELECTION]]);
  });
});

describe("the chord that opens terminal find", () => {
  test("opens find from the widget's own key path", async () => {
    // The find bar is the terminal's, and its chord is claimed by the
    // component root. A renderer that consumed the key would leave the root
    // waiting for a keystroke that never bubbles.

    const { socket, term } = await mountTerminal(false);
    pressInGhostty(term, { key: "F", code: "KeyF", keyCode: 70, ctrlKey: true, shiftKey: true });
    await settle();

    expect(document.body.querySelector(".terminal-find")).not.toBeNull();
    // And the renderer let it out rather than encoding it: a chord that opens
    // find and also types a byte at the shell is the double dispatch this
    // item is about.
    expect(inputFrames(socket)).toEqual([]);
  });

  test("a bare Ctrl+F is the shell's, not find's", async () => {
    const { socket, term } = await mountTerminal(false);

    pressInGhostty(term, { key: "f", code: "KeyF", keyCode: 70, ctrlKey: true });
    await settle();

    expect(inputFrames(socket)).toEqual(["\x06"]);
    expect(document.body.querySelector(".terminal-find")).toBeNull();
  });

  test("Ctrl+G and Ctrl+[ reach the shell too", async () => {
    // The other two keys the ruling keeps for the shell. Off macOS nothing in
    // the app competes for them; the macOS key bridge is where they were being
    // taken, and that arm is native.
    const { socket, term } = await mountTerminal(false);

    pressInGhostty(term, { key: "g", code: "KeyG", keyCode: 71, ctrlKey: true });
    pressInGhostty(term, { key: "[", code: "BracketLeft", keyCode: 219, ctrlKey: true });
    await settle();

    expect(inputFrames(socket)).toEqual(["\x07", "\x1b"]);
  });
});

describe("Ctrl+Shift+D", () => {
  test("does not close an exited terminal", async () => {
    const { term } = await mountTerminal(true);

    pressInGhostty(term, { key: "D", code: "KeyD", keyCode: 68, ctrlKey: true, shiftKey: true });
    await settle();

    expect(paneTabIds()).toEqual(["term-chords", "file-neighbour"]);
  });
});

describe("Ctrl+D on a live shell", () => {
  // A guard, green today and required to stay green: the close-tab chord is
  // the alternate on every platform, and the registry entry says in as many
  // words that it must still reach a focused shell as EOF.
  test("reaches the shell as EOF and closes no tab", async () => {
    const { socket, term } = await mountTerminal(false);

    pressInGhostty(term, { key: "d", code: "KeyD", keyCode: 68, ctrlKey: true });
    await settle();

    expect(inputFrames(socket)).toEqual(["\x04"]);
    expect(paneTabIds()).toEqual(["term-chords", "file-neighbour"]);
  });
});
