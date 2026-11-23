// @vitest-environment jsdom
//
// Copying from and pasting into a ghostty terminal. Every copy path of a
// mounted TerminalTab on the ghostty backend writes the same text through
// chan's writer, `writeClipboardText`: the copy chord, the menu's Copy and Copy
// Scrollback, and ghostty-web's own copies on mouse release, double and triple
// click. A command longer than the terminal is wide copies as one line, and a
// double or triple click takes a word or a line across the wrap. Every paste
// path sends the program the same cleaned bytes. Each copy case runs in a
// browser, where the writer is `navigator.clipboard.writeText`, and on
// chan-desktop, where it is the native `write_clipboard_text` and any write to
// the web clipboard went around it. ClipboardItem exists, as in Chrome and
// WebKit, so a copy that writes the clipboard itself, the way ghostty-web's
// does, shows as a `write`. The shared fixture opens the real widget on the
// vendored core, with its own selection and input handlers.


import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import type { Terminal } from "@chan/ghostty-web-ng";
import { openedGhostty } from "../__tests__/ghosttyTab";
import * as ghosttyPaste from "../terminal/ghosttyPaste";
import { terminalPreferences } from "../__tests__/standalone";
import { engineClick, modelPointerCapture, mousePointer } from "../__tests__/pointer";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { closeTabMenu } from "../state/tabMenu.svelte";
import {
  attach,
  installTerminalDom,
  menuRow,
  openBodyMenu,
  output,
  resetTerminals,
  seatTerminals,
  sentFrames,
  TERMINAL_PANE,
  TerminalSocket,
  terminalTab,
} from "../__tests__/terminalTab";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyCompatModule(importOriginal));

installTerminalDom();

const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
/// A command longer than the terminal's 80 columns; its second row starts
/// with a space.
const COMMAND =
  "$ curl -fsSL https://downloads.example.test/tools/install.sh | sh -s -- --prefix /opt/tools --yes";

const mounted: Array<Record<string, unknown>> = [];
let clipboard: {
  write: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
};
const tauri = window as unknown as { __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> } };

beforeEach(() => {
  __testSetStandalonePreferences(terminalPreferences());
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX);
  vi.stubGlobal("ClipboardItem", class {
    constructor(readonly items: Record<string, Blob>) {}
  });
  clipboard = {
    write: vi.fn(async () => {}),
    writeText: vi.fn(async (_text: string) => {}),
    readText: vi.fn(async () => ""),
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
});

afterEach(() => {
  delete tauri.__TAURI_INTERNALS__;
  closeTabMenu();
  for (const component of mounted.splice(0)) unmount(component);
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/// A command whose path the 80 columns cut inside the word.
const PATH = `/var/log/${"deep/".repeat(16)}messages.log`;
const PATH_COMMAND = `$ cat ${PATH}`;

/// Mount a terminal that spawns on ghostty, attach its session and print
/// the command and a prompt after it.
async function renderGhostty(command = COMMAND) {
  const [tab] = seatTerminals([terminalTab()]);
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(TerminalTab, { target, props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true } }),
  );
  await tick();
  await tick();
  await vi.waitFor(() => expect(TerminalSocket.all).toHaveLength(1));
  const term = await openedGhostty(target);
  const socket = TerminalSocket.all[0]!;
  await attach(socket);
  await output(socket, `\x1b[2J\x1b[3J\x1b[H${command}\r\n$ `);
  await vi.waitFor(() => expect(term.buffer.active.getLine(1)?.isWrapped, "the command wrapped on screen").toBe(true));
  return { target, term };
}

function canvas(term: Terminal): HTMLCanvasElement {
  return term.element!.querySelector("canvas")!;
}

/// The user's drag from one screen cell to another, handled by
/// ghostty-web's own pointer code; its release copies.
function drag(term: Terminal, from: { col: number; row: number }, to: { col: number; row: number }): void {
  const surface = canvas(term);
  modelPointerCapture(surface);
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, term.cols * 8, term.rows * 19));
  const at = (cell: { col: number; row: number }) => ({ clientX: cell.col * 8 + 1, clientY: cell.row * 19 + 1 });
  mousePointer(surface, "pointerdown", at(from));
  mousePointer(surface, "pointermove", at(to));
  mousePointer(surface, "pointerup", at(to));
}

/// Where chan's writer puts a copy on each platform, and what reads it back.
const PLATFORMS = [
  {
    name: "a browser",
    enter() {},
    /// The texts chan's writer put on the clipboard since the last read.
    takeWrites(): string[] {
      const texts = clipboard.writeText.mock.calls.map(([text]) => text as string);
      clipboard.writeText.mockClear();
      return texts;
    },
    expectNoBypass() {
      expect(clipboard.write, "no copy wrote the clipboard itself").not.toHaveBeenCalled();
    },
  },
  {
    name: "chan-desktop",
    enter() {
      tauri.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => undefined) };
    },
    takeWrites(): string[] {
      const invoke = tauri.__TAURI_INTERNALS__!.invoke;
      const texts = invoke.mock.calls
        .filter(([cmd]) => cmd === "write_clipboard_text")
        .map(([, args]) => (args as { text: string }).text);
      invoke.mockClear();
      return texts;
    },
    expectNoBypass() {
      expect(clipboard.write, "no copy wrote the web clipboard itself").not.toHaveBeenCalled();
      expect(clipboard.writeText, "no copy wrote the web clipboard around the native one").not.toHaveBeenCalled();
    },
  },
] as const;

describe.each(PLATFORMS)("every copy from a ghostty terminal in $name writes the same text through chan's writer", (platform) => {
  test("a wrapped command copies as one line on release, by the chord and by the menu's Copy", async () => {
    const { target, term } = await renderGhostty();
    platform.enter();
    const lastCol = COMMAND.length - 80 - 1;

    drag(term, { col: 0, row: 0 }, { col: lastCol, row: 1 });
    await tick();
    expect(platform.takeWrites(), "ghostty-web's copy on release").toEqual([COMMAND]);

    term.element!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(platform.takeWrites(), "the copy chord").toEqual([COMMAND]);

    await openBodyMenu(target);
    menuRow("Copy").click();
    await tick();
    expect(platform.takeWrites(), "the menu's Copy").toEqual([COMMAND]);

    platform.expectNoBypass();
  });

  test("Copy scrollback copies the wrapped command as one line", async () => {
    const { target } = await renderGhostty();
    platform.enter();
    await openBodyMenu(target);
    menuRow("Copy scrollback").click();
    await tick();
    expect(platform.takeWrites()).toEqual([`${COMMAND}\n$`]);
    platform.expectNoBypass();
  });

  test("a double click copies the word under it through chan's writer", async () => {
    const { term } = await renderGhostty();
    platform.enter();
    canvas(term).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2, clientX: 3 * 8 + 1, clientY: 1 }));
    await tick();
    expect(platform.takeWrites()).toEqual(["curl"]);
    platform.expectNoBypass();
  });

  test("a double click copies a word the wrap cut whole, and a triple click the whole wrapped command", async () => {
    const { term } = await renderGhostty(PATH_COMMAND);
    platform.enter();
    const click = (detail: number, col: number, row: number) =>
      canvas(term).dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail, clientX: col * 8 + 1, clientY: row * 19 + 1 }),
      );
    click(2, 10, 0);
    await tick();
    expect(platform.takeWrites(), "a double click before the wrap").toEqual([PATH]);
    click(2, 3, 1);
    await tick();
    expect(platform.takeWrites(), "a double click after the wrap").toEqual([PATH]);
    click(3, 3, 1);
    await tick();
    expect(platform.takeWrites(), "a triple click").toEqual([PATH_COMMAND]);
    platform.expectNoBypass();
  });
});

describe("pasting into a ghostty terminal", () => {
  /// A text that would end its own bracket and colour the screen, with CRLF
  /// and LF line ends, and the same text as chan pastes it under bracketed
  /// paste.
  const HOSTILE = "echo one\x1b[201~; echo two\r\nprintf '\x1b[31mred'\x03\nlast";
  const CLEANED = "\x1b[200~echo one [201~; echo two\rprintf ' [31mred' \rlast\x1b[201~";

  function inputs(): string[] {
    return sentFrames(TerminalSocket.all[0]!)
      .filter((frame) => frame.type === "input")
      .map((frame) => frame.data as string);
  }

  test("the paste chord and the menu's Paste row send the same cleaned bytes, once each", async () => {
    const { target, term } = await renderGhostty();
    await output(TerminalSocket.all[0]!, "\x1b[?2004h");
    expect(term.hasBracketedPaste()).toBe(true);
    const before = inputs().length;

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? HOSTILE : "") },
    });
    term.element!.dispatchEvent(paste);
    await tick();
    expect(inputs().slice(before), "the chord's native paste").toEqual([CLEANED]);

    clipboard.readText.mockResolvedValue(HOSTILE);
    await openBodyMenu(target);
    menuRow("Paste").click();
    await vi.waitFor(() => expect(inputs().length).toBe(before + 2));
    expect(inputs().slice(before + 1), "the menu's Paste row").toEqual([CLEANED]);

    term.element!.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertFromPaste", data: HOSTILE, bubbles: true, cancelable: true }),
    );
    await tick();
    expect(inputs().slice(before + 2), "an insertFromPaste input").toEqual([CLEANED]);
  });
});

describe("the Linux desktop PRIMARY selection", () => {
  function desktop(primary: string | null = "from another application") {
    const invoke = vi.fn(async (cmd: string, _args?: unknown) => cmd === "read_primary_selection" ? primary : undefined);
    tauri.__TAURI_INTERNALS__ = { invoke };
    return invoke;
  }

  function middle(host: HTMLElement): MouseEvent {
    return engineClick(host, 1).click;
  }

  function inputs(): string[] {
    return sentFrames(TerminalSocket.all[0]!).filter((f) => f.type === "input").map((f) => f.data as string);
  }

  /// A task after the current one: what chan defers past a release has run.
  function nextTask(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("ghostty mouse copies also write PRIMARY, while chord and menu copies leave PRIMARY alone", async () => {
    const invoke = desktop();
    const { term, target } = await renderGhostty(PATH_COMMAND);
    invoke.mockClear();
    drag(term, { col: 0, row: 0 }, { col: PATH_COMMAND.length - 81, row: 1 });
    await nextTask();
    expect(invoke.mock.calls).toEqual([
      ["write_clipboard_text", { text: PATH_COMMAND }], ["write_primary_selection", { text: PATH_COMMAND }],
    ]);
    invoke.mockClear();
    for (const [detail, text] of [[2, PATH], [3, PATH_COMMAND]] as const) {
      canvas(term).dispatchEvent(new MouseEvent("click", { bubbles: true, detail, clientX: 25, clientY: 20 }));
      await tick();
      expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text }], ["write_primary_selection", { text }]]);
      invoke.mockClear();
    }
    term.element!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "C", code: "KeyC", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    }));
    await tick();
    expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text: PATH_COMMAND }]]);
    invoke.mockClear();
    await openBodyMenu(target);
    menuRow("Copy").click();
    await tick();
    expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text: PATH_COMMAND }]]);
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("middle click sends hostile PRIMARY through ghostty's cleaned paste exactly once", async () => {
    const invoke = desktop("echo one\x1b[201~; echo two\r\nprintf '\x1b[31mred'\x03\nlast");
    const { term } = await renderGhostty();
    await output(TerminalSocket.all[0]!, "\x1b[?2004h");
    invoke.mockClear();
    const before = inputs().length;
    const widget = vi.fn();
    term.element!.addEventListener("auxclick", widget);
    const event = middle(canvas(term));
    await vi.waitFor(() => expect(inputs().slice(before)).toEqual([
      "\x1b[200~echo one [201~; echo two\rprintf ' [31mred' \rlast\x1b[201~",
    ]));
    expect(event.defaultPrevented).toBe(true);
    expect(widget).not.toHaveBeenCalled();
    expect(invoke.mock.calls).toEqual([["read_primary_selection", undefined]]);
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  /// A right click as the engine dispatches it, at a cell of the terminal.
  function rightClick(on: Element): MouseEvent {
    const event = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true, clientX: 25, clientY: 20 });
    on.dispatchEvent(event);
    return event;
  }

  test("a right click on ghostty opens chan's menu before ghostty-web selects its textarea", async () => {
    const invoke = desktop();
    const { term } = await renderGhostty(PATH_COMMAND);
    drag(term, { col: 0, row: 0 }, { col: PATH_COMMAND.length - 81, row: 1 });
    await tick();
    invoke.mockClear();
    const select = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    const range = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");
    const event = rightClick(canvas(term));
    await tick();
    await tick();
    expect(select, "a selected textarea is what WebKitGTK copies into PRIMARY").not.toHaveBeenCalled();
    expect(range).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    menuRow("Copy").click();
    await tick();
    expect(invoke.mock.calls).toEqual([["write_clipboard_text", { text: PATH_COMMAND }]]);
  });

  test("in a browser ghostty-web's right click still selects its textarea under chan's menu", async () => {
    const { term } = await renderGhostty(PATH_COMMAND);
    drag(term, { col: 0, row: 0 }, { col: PATH_COMMAND.length - 81, row: 1 });
    await tick();
    const select = vi.spyOn(HTMLTextAreaElement.prototype, "select");
    const event = rightClick(canvas(term));
    await tick();
    await tick();
    expect(select).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(menuRow("Copy")).toBeTruthy();
  });

  test("ghostty installs no PRIMARY handler in a browser", async () => {
    const { term } = await renderGhostty();
    const event = middle(term.element!);
    await tick();
    expect(event.defaultPrevented).toBe(false);
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(inputs()).toEqual([]);
  });

  test.each(["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "Mozilla/5.0 (Windows NT 10.0)"])("non-Linux desktops keep native middle click (%s)", async (ua) => {
    const invoke = desktop();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    const { term } = await renderGhostty();
    invoke.mockClear();
    expect(middle(canvas(term)).defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  test("teardown ignores a delayed PRIMARY read and removes the mouse handlers", async () => {
    const invoke = desktop();
    const { term } = await renderGhostty();
    const host = term.element!;
    const paste = vi.spyOn(ghosttyPaste, "pasteIntoGhostty");
    let finish!: (text: string) => void;
    invoke.mockImplementation((cmd) => cmd === "read_primary_selection"
      ? new Promise<string>((resolve) => { finish = resolve; }) : Promise.resolve(undefined));
    const before = inputs().length;
    middle(host);
    await unmount(mounted.pop()!);
    finish("must not reach a disposed terminal");
    // Drain the nested invoke/read continuations before the negative assertion.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inputs().length).toBe(before);
    expect(paste, "no paste reaches the disposed widget").not.toHaveBeenCalled();
    invoke.mockClear();
    expect(middle(host).defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    const reached = vi.fn();
    host.addEventListener("contextmenu", reached);
    rightClick(host);
    expect(reached, "a right click reaches the host's own listeners again").toHaveBeenCalledOnce();
  });

  test.each([null, ""])("an absent or empty PRIMARY does not paste (%s)", async (text) => {
    const invoke = desktop(text);
    const { term } = await renderGhostty();
    const before = inputs().length;
    invoke.mockClear();
    middle(canvas(term));
    await tick();
    expect(invoke.mock.calls).toEqual([["read_primary_selection", undefined]]);
    expect(inputs().length).toBe(before);
  });
});
