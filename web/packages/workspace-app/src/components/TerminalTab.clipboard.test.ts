// @vitest-environment jsdom
//
// Terminal copy / paste chords. macOS binds Cmd+C / Cmd+V (Cmd never
// collides with a control code); Linux / Windows bind Ctrl+Shift+C /
// Ctrl+Shift+V so bare Ctrl+C/V stay the shell's SIGINT / EOF. The registry
// entries and the chord handler are read directly; the handler's wiring is
// driven through a mounted TerminalTab over the stand-in xterm.

import { tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { allCommands } from "../state/commands";
import { chordFor, osChord, SHORTCUTS } from "../state/shortcuts";
import { showSurvey, surveyState } from "../state/survey.svelte";
import { handleTerminalClipboardChord } from "../terminal/clipboardChord";
import {
  attach,
  installTerminalDom,
  menuRow,
  mountTerminal,
  openBodyMenu,
  pressInTerminal,
  resetTerminals,
  seatTerminals,
  sentFrames,
  terminalTab,
  TerminalSocket,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

const clipboard = {
  writeText: vi.fn(async (_text: string) => {}),
  readText: vi.fn(async () => ""),
};
Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

afterEach(() => {
  resetTerminals();
  surveyState.byTab = {};
  surveyState.windowWide = null;
  document.getSelection()?.removeAllRanges();
  clipboard.writeText.mockClear();
  clipboard.readText.mockReset();
  clipboard.readText.mockResolvedValue("");
  vi.restoreAllMocks();
});

describe("copy owned by a terminal descendant", () => {
  async function attached() {
    xterm.textareaFocus = true;
    const [tab] = seatTerminals([terminalTab()]);
    const mounted = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    socket.sent.splice(0);
    return { ...mounted, socket, tab: tab! };
  }

  test.each([
    ["Cmd+C with no renderer selection", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", { metaKey: true }, ""],
    ["Cmd+C with stale renderer selection", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", { metaKey: true }, "old terminal output"],
    ["Ctrl+Shift+C with stale renderer selection", "Mozilla/5.0 (X11; Linux x86_64)", { ctrlKey: true, shiftKey: true }, "old terminal output"],
  ])("a selected survey body keeps native %s", async (_name, agent, chord, rendererSelection) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    const { target, term, socket, tab } = await attached();
    term.selection = rendererSelection;
    showSurvey({ surveyId: "copy-survey", title: null, bodyMarkdown: "Copy this survey text", options: ["OK"] }, tab.id);
    await tick();
    const card = target.querySelector<HTMLElement>(".survey-card")!;
    const body = card.querySelector<HTMLElement>(".survey-body")!;
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    card.focus();
    expect(selection.toString().trim()).toBe("Copy this survey text");
    expect(document.activeElement).toBe(card);

    const event = new KeyboardEvent("keydown", { key: "c", code: "KeyC", ...chord, bubbles: true, cancelable: true });
    card.dispatchEvent(event);
    await tick();

    expect(clipboard.writeText, "the renderer selection cannot replace the survey text").not.toHaveBeenCalled();
    expect(event.defaultPrevented, "the browser retains its selected-text copy").toBe(false);
    expect(sentFrames(socket).filter((frame) => frame.type === "input")).toEqual([]);
  });

  test.each([
    ["Cmd+C", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", { metaKey: true }],
    ["Ctrl+Shift+C", "Mozilla/5.0 (X11; Linux x86_64)", { ctrlKey: true, shiftKey: true }],
  ])("selected find input text keeps native %s", async (_name, agent, chord) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    const { target, term, socket } = await attached();
    term.selection = "old terminal output";
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.find.open" } }));
    await tick();
    const input = target.querySelector<HTMLInputElement>(".terminal-find input")!;
    expect(input).not.toBeNull();
    input.value = "find text";
    input.focus();
    input.setSelectionRange(0, 4);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(4);

    const event = new KeyboardEvent("keydown", { key: "c", code: "KeyC", ...chord, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    await tick();

    expect(event.defaultPrevented).toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(sentFrames(socket).filter((frame) => frame.type === "input")).toEqual([]);
  });

  test.each([
    ["Cmd+C", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", { key: "c", code: "KeyC", metaKey: true }],
    ["Ctrl+Shift+C", "Mozilla/5.0 (X11; Linux x86_64)", { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }],
  ])("%s on the renderer copies its selection once and never writes to the PTY", async (_name, agent, chord) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    const { term, socket } = await attached();
    term.selection = "renderer selection";
    term.textarea!.addEventListener("keydown", (event) => term.keyHandler?.(event), { capture: true });
    const event = new KeyboardEvent("keydown", { ...chord, bubbles: true, cancelable: true });
    term.textarea!.dispatchEvent(event);
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith("renderer selection");
    expect(sentFrames(socket).filter((frame) => frame.type === "input")).toEqual([]);
  });

  test("an empty renderer selection makes the copy chord a no-op", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)");
    const { term, socket } = await attached();
    term.selection = "";
    term.textarea!.addEventListener("keydown", (event) => term.keyHandler?.(event), { capture: true });
    const event = new KeyboardEvent("keydown", { key: "c", code: "KeyC", metaKey: true, bubbles: true, cancelable: true });
    term.textarea!.dispatchEvent(event);
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(sentFrames(socket).filter((frame) => frame.type === "input")).toEqual([]);
  });
});

describe("the chord registry", () => {
  const entry = (id: string) => SHORTCUTS.find((s) => s.id === id)!;

  test("binds copy and paste to Cmd+C and Cmd+V in the Terminal group, noting the other OSes", () => {
    expect(entry("terminal.copy")).toMatchObject({
      web: "Cmd+C",
      native: "Cmd+C",
      group: "Terminal",
      note: "Ctrl+Shift+C on Linux / Windows",
    });
    expect(entry("terminal.paste")).toMatchObject({
      web: "Cmd+V",
      native: "Cmd+V",
      group: "Terminal",
      note: "Ctrl+Shift+V on Linux / Windows",
    });
  });

  test("moves them to Mod+Shift off the Mac", () => {
    for (const platform of ["web", "native"] as const) {
      expect(osChord(entry("terminal.copy"), platform, "linux")).toBe("Mod+Shift+C");
      expect(osChord(entry("terminal.paste"), platform, "windows")).toBe("Mod+Shift+V");
      expect(osChord(entry("terminal.copy"), platform, "mac")).toBe("Cmd+C");
    }
  });
});

describe("in a mounted terminal off the Mac", () => {
  async function attached() {
    const [tab] = seatTerminals([terminalTab()]);
    const mounted = await mountTerminal(TerminalTab, tab!);
    const socket = TerminalSocket.all.at(-1)!;
    await attach(socket);
    socket.sent.splice(0);
    return { ...mounted, socket };
  }

  test("Ctrl+Shift+C copies the selection and xterm skips the key", async () => {
    const { term, socket } = await attached();
    term.selection = "selected text";
    const { event, handled } = pressInTerminal(term, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    await tick();

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith("selected text");
    expect(sentFrames(socket)).toEqual([]);
  });

  test("bare Ctrl+C is left to xterm, which sends the shell its interrupt", async () => {
    const { term } = await attached();
    term.selection = "selected text";
    const { handled } = pressInTerminal(term, { key: "c", code: "KeyC", ctrlKey: true });
    expect(handled).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  test("the body menu's Copy and Paste rows show the registry's chords", async () => {
    const { target } = await attached();
    await openBodyMenu(target);
    expect(menuRow("Copy").querySelector(".mbtn-chord")?.textContent).toBe(chordFor("terminal.copy"));
    expect(menuRow("Paste").querySelector(".mbtn-chord")?.textContent).toBe(chordFor("terminal.paste"));
    expect(chordFor("terminal.copy")).toBe("Ctrl+Shift+C");
  });
});

// The catalog's Copy, Paste and Copy scrollback reach the focused terminal as
// commands, from the launcher or a chord the user assigned, and run what its
// menu rows run. A Copy its command marks as run by the assigned chord is
// the one exception: it copies as the built-in copy chord does.
describe("the terminal's clipboard commands", () => {
  function run(id: string): void {
    const command = allCommands().find((candidate) => candidate.id === id);
    if (!command) throw new Error(`no command ${id}`);
    command.run();
  }

  async function attached(focused = true) {
    const [tab] = seatTerminals([terminalTab()]);
    const mounted = await mountTerminal(TerminalTab, tab!, { focused });
    await attach(TerminalSocket.all.at(-1)!);
    return mounted;
  }

  afterEach(() => {
    xterm.serialized = "";
  });

  test("Copy copies the selection, and the scrollback when nothing is selected, as its row does", async () => {
    const { term } = await attached();
    xterm.serialized = "line one\nline two";
    term.selection = "selected text";
    run("terminal.copy");
    await vi.waitFor(() => expect(clipboard.writeText.mock.calls).toEqual([["selected text"]]));

    term.selection = "";
    run("terminal.copy");
    await vi.waitFor(() =>
      expect(clipboard.writeText.mock.calls).toEqual([["selected text"], ["line one\nline two"]]),
    );
  });

  test("a Copy marked as its assigned chord's copies the selection only, and nothing when there is none", async () => {
    const { term } = await attached();
    xterm.serialized = "line one\nline two";
    const byChord = (): void => {
      window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "terminal.copy", chord: true } }));
    };

    term.selection = "";
    byChord();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clipboard.writeText, "no selection, so no copy").not.toHaveBeenCalled();

    term.selection = "selected text";
    byChord();
    await vi.waitFor(() => expect(clipboard.writeText.mock.calls).toEqual([["selected text"]]));
  });

  test("Copy scrollback copies the scrollback whatever is selected", async () => {
    const { term } = await attached();
    xterm.serialized = "line one\nline two";
    term.selection = "selected text";
    run("app.terminal.copyScrollback");
    await vi.waitFor(() => expect(clipboard.writeText.mock.calls).toEqual([["line one\nline two"]]));
  });

  test("Paste hands the clipboard's text to the terminal and gives it the keyboard", async () => {
    const { term } = await attached();
    clipboard.readText.mockResolvedValue("pasted text");
    const focused = term.focusCount;
    run("terminal.paste");
    await vi.waitFor(() => expect(term.pasted).toEqual(["pasted text"]));
    await vi.waitFor(() => expect(term.focusCount).toBe(focused + 1));
  });

  test("a terminal outside the focused pane leaves them to the one inside it", async () => {
    const { term } = await attached(false);
    xterm.serialized = "line one";
    term.selection = "selected text";
    clipboard.readText.mockResolvedValue("pasted text");
    run("terminal.copy");
    run("app.terminal.copyScrollback");
    run("terminal.paste");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(term.pasted).toEqual([]);
  });
});

describe("on the desktop, where the webview has no Clipboard API", () => {
  async function attachedOnDesktop(
    write: (cmd: string, args?: unknown) => Promise<unknown> = async () => undefined,
  ) {
    const [tab] = seatTerminals([terminalTab()]);
    const mounted = await mountTerminal(TerminalTab, tab!);
    await attach(TerminalSocket.all.at(-1)!);
    const invoke = vi.fn(write);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    return { ...mounted, invoke };
  }

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    xterm.serialized = "";
    vi.restoreAllMocks();
  });

  test("Ctrl+Shift+C copies the selection through the native clipboard", async () => {
    const { term, invoke } = await attachedOnDesktop();
    term.selection = "selected text";

    pressInTerminal(term, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "selected text" }),
    );
  });

  test("the menu's Copy copies the selection through the native clipboard", async () => {
    const { term, target, invoke } = await attachedOnDesktop();
    term.selection = "selected text";

    await openBodyMenu(target);
    menuRow("Copy").click();

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "selected text" }),
    );
  });

  test("the menu's Copy scrollback copies the scrollback through the native clipboard", async () => {
    const { target, invoke } = await attachedOnDesktop();
    xterm.serialized = "line one\nline two";

    await openBodyMenu(target);
    menuRow("Copy scrollback").click();

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "line one\nline two" }),
    );
  });

  test("the menu's Copy refocuses the terminal once the write lands", async () => {
    const { term, target, invoke } = await attachedOnDesktop();
    term.selection = "selected text";
    await openBodyMenu(target);
    const focused = term.focusCount;

    menuRow("Copy").click();

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "selected text" }));
    await vi.waitFor(() => expect(term.focusCount).toBe(focused + 1));
  });

  // Tauri rejects the failed command with the bare string its Result carried.
  // The menu fires the copy and forgets it, so a failure left unhandled would
  // be Node's unhandled rejection; the runner hears it, not jsdom's window.
  test("the menu's Copy warns on a native write that fails with no web fallback, and leaves focus alone", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const runner = globalThis as unknown as {
      process: {
        on: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
        off: (event: "unhandledRejection", fn: (reason: unknown) => void) => void;
      };
    };
    runner.process.on("unhandledRejection", onUnhandled);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { term, target, invoke } = await attachedOnDesktop(async (cmd) =>
        cmd === "write_clipboard_text" ? Promise.reject("clipboard busy") : undefined,
      );
      term.selection = "selected text";
      await openBodyMenu(target);
      const focused = term.focusCount;

      menuRow("Copy").click();

      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: "selected text" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled, "no unhandled rejection").toEqual([]);
      expect(warn).toHaveBeenCalledWith("terminal copy failed", "clipboard busy");
      expect(term.focusCount).toBe(focused);
    } finally {
      runner.process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("terminal clipboard keydown behavior", () => {
  function dispatchClipboardChord(
    init: KeyboardEventInit,
    os: string,
    copySelection = vi.fn(),
  ): { event: KeyboardEvent; handled: boolean; copySelection: ReturnType<typeof vi.fn> } {
    const target = document.createElement("div");
    let handled = false;
    target.addEventListener("keydown", (event) => {
      handled = handleTerminalClipboardChord(event, { os, copySelection });
    });
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return { event, handled, copySelection };
  }

  test("Cmd+V stays native and does not suppress WKWebView paste", () => {
    const { event, handled, copySelection } = dispatchClipboardChord(
      { key: "v", code: "KeyV", metaKey: true },
      "mac",
    );

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(copySelection).not.toHaveBeenCalled();
  });

  test("copy is handled directly and suppresses the browser default", () => {
    const { event, handled, copySelection } = dispatchClipboardChord(
      { key: "c", code: "KeyC", ctrlKey: true, shiftKey: true },
      "linux",
    );

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(copySelection).toHaveBeenCalledOnce();
  });
});
