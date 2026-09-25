import { describe, expect, test, vi } from "vitest";
import shortcuts from "../state/shortcuts.ts?raw";
import { handleTerminalClipboardChord } from "../terminal/clipboardChord";
import terminalTab from "./TerminalTab.svelte?raw";

// Terminal copy / paste chords. macOS binds Cmd+C / Cmd+V (Cmd never
// collides with a control code); Linux / Windows bind Ctrl+Shift+C /
// Ctrl+Shift+V so bare Ctrl+C/V stay the shell's SIGINT / EOF. Same
// divergence shape as the reload Ctrl+R clash (cmdRWindowReload.test.ts).

describe("terminal copy/paste chord registry entries", () => {
  test("terminal.copy descriptor present (Cmd+C, Terminal group)", () => {
    expect(shortcuts).toMatch(
      /id: "terminal\.copy",[\s\S]*?label: "Copy selection",[\s\S]*?web: "Cmd\+C",[\s\S]*?native: "Cmd\+C",[\s\S]*?group: "Terminal",/,
    );
  });

  test("terminal.paste descriptor present (Cmd+V, Terminal group)", () => {
    expect(shortcuts).toMatch(
      /id: "terminal\.paste",[\s\S]*?label: "Paste",[\s\S]*?web: "Cmd\+V",[\s\S]*?native: "Cmd\+V",[\s\S]*?group: "Terminal",/,
    );
  });

  test("descriptors document the Linux/Windows Ctrl+Shift divergence", () => {
    expect(shortcuts).toMatch(
      /id: "terminal\.copy",[\s\S]*?note: "Ctrl\+Shift\+C on Linux \/ Windows",/,
    );
    expect(shortcuts).toMatch(
      /id: "terminal\.paste",[\s\S]*?note: "Ctrl\+Shift\+V on Linux \/ Windows",/,
    );
  });
});

describe("osChord per-OS divergence", () => {
  test("osChord moves copy/paste off Cmd+ to Ctrl+Shift+ on non-macOS", () => {
    // Mod+Shift+C/V -> Ctrl+Shift+C/V once Mod renders as Ctrl; the stored
    // Cmd+ form is the macOS display.
    expect(shortcuts).toMatch(
      /TERMINAL_COPY_ID && os !== "mac"\) return "Mod\+Shift\+C";/,
    );
    expect(shortcuts).toMatch(
      /TERMINAL_PASTE_ID && os !== "mac"\) return "Mod\+Shift\+V";/,
    );
  });
});

describe("TerminalTab wiring", () => {
  test("clipboard chord detection branches per-OS (Cmd vs Ctrl+Shift)", () => {
    // macOS: bare Cmd. Non-macOS: Ctrl+Shift (so bare Ctrl+C/V stays SIGINT).
    expect(terminalTab).toMatch(
      /handleTerminalClipboardChord\(e, \{[\s\S]*?os: currentOS\(\)/,
    );
  });

  test("context-menu Copy/Paste hints read the chord from the registry", () => {
    expect(terminalTab).toMatch(/chordFor\("terminal\.copy"\)/);
    expect(terminalTab).toMatch(/chordFor\("terminal\.paste"\)/);
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
