import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import shortcutsRaw from "./shortcuts.ts?raw";
import terminalRaw from "../components/TerminalTab.svelte?raw";
import {
  SHORTCUTS,
  chordFromEvent,
  shouldEscapeTerminal,
} from "./shortcuts";

// Chord-escape registry. Global chords that must reach the App keymap even
// from a focused terminal (Command launcher, Settings, Search, New terminal,
// Reload, Hybrid Nav, Close window, Rich Prompt) carry `escapeTerminal: true`, and a
// user-assigned override chord escapes too (covered by the override-escape
// test in keymapOverrides.svelte.test.ts). The `handleTerminalKeyEvent`
// xterm-`customKeyEventHandler` callback consults the registry: matched
// events return false so no bytes reach the PTY.

describe("chord-escape registry shape", () => {
  test("Shortcut type carries an optional escapeTerminal flag", () => {
    expect(shortcutsRaw).toMatch(/escapeTerminal\?: boolean;/);
  });

  test("global chords flagged escapeTerminal=true", () => {
    const required = [
      "app.launcher.toggle",
      "app.settings.open",
      "app.search.toggle",
      "app.terminal.toggle",
      "app.pane.mode",
      "app.pane.flip",
      "app.pane.prev",
      "app.pane.next",
      "app.pane.splitRight",
      "app.pane.splitDown",
      "app.window.reload",
      "app.window.close",
      "app.tab.reopenClosed",
      "app.tab.next",
      "app.tab.prev",
      "app.tab.jump",
      "terminal.richPrompt",
    ];
    for (const id of required) {
      const entry = SHORTCUTS.find((s) => s.id === id);
      expect(entry?.escapeTerminal).toBe(true);
    }
  });

  test("non-flagged chords default to undefined (xterm consumes)", () => {
    // app.tab.close (Ctrl+D) is intentionally not listed: it goes
    // through a different dispatch path and must still reach shells
    // as EOF when a terminal is focused.
    const close = SHORTCUTS.find((s) => s.id === "app.tab.close");
    expect(close?.escapeTerminal).toBeUndefined();
  });
});

describe("chordFromEvent normalisation", () => {
  beforeEach(() => {
    // Force macOS so `Mod` maps to metaKey deterministically.
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("Cmd+P on Mac yields `Mod+P`", () => {
    const e = new KeyboardEvent("keydown", { key: "p", metaKey: true });
    expect(chordFromEvent(e)).toBe("Mod+P");
  });

  test("Cmd+Shift+M on Mac yields `Mod+Shift+M`", () => {
    const e = new KeyboardEvent("keydown", {
      key: "m",
      metaKey: true,
      shiftKey: true,
    });
    expect(chordFromEvent(e)).toBe("Mod+Shift+M");
  });

  test("modifier-only events return null", () => {
    const e = new KeyboardEvent("keydown", { key: "Shift", shiftKey: true });
    expect(chordFromEvent(e)).toBeNull();
  });

  test("plain printable keys (no modifier) return null", () => {
    const e = new KeyboardEvent("keydown", { key: "a" });
    expect(chordFromEvent(e)).toBeNull();
  });
});

describe("shouldEscapeTerminal lookup", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { userAgent: "Mac OS X" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("Ctrl+Shift+T (new terminal web chord) escapes", () => {
    // Test env runs as web platform (no Tauri global). New terminal's web chord
    // is the literal Ctrl+Shift+T after the no-defaults round, and it keeps its
    // escapeTerminal flag.
    const e = new KeyboardEvent("keydown", {
      key: "t",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("Cmd+R (reload window) escapes", () => {
    const e = new KeyboardEvent("keydown", { key: "r", metaKey: true });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("plain Cmd+S is not a global default", () => {
    const e = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    expect(shouldEscapeTerminal(e)).toBe(false);
  });

  test("Cmd+, (Settings) escapes", () => {
    const e = new KeyboardEvent("keydown", { key: ",", metaKey: true });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("Cmd+Shift+S (Search on macOS) escapes", () => {
    const e = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      shiftKey: true,
    });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("Ctrl+Alt+S (Search off macOS) escapes", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows" });
    const e = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      altKey: true,
    });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("Ctrl+Alt+K (web command launcher) escapes", () => {
    const e = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      altKey: true,
    });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("Ctrl+Alt+K (off-mac command launcher) escapes", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows" });
    const e = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      altKey: true,
    });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("Cmd+K (native macOS command launcher) escapes", () => {
    const w = window as typeof window & { __TAURI__?: unknown };
    w.__TAURI__ = {};
    const e = new KeyboardEvent("keydown", { key: "k", metaKey: true });
    expect(shouldEscapeTerminal(e)).toBe(true);
    delete w.__TAURI__;
  });

  test("Cmd+. (Hybrid Nav) escapes", () => {
    const e = new KeyboardEvent("keydown", { key: ".", metaKey: true });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test("Ctrl+` (pane side flip) escapes", () => {
    const e = new KeyboardEvent("keydown", {
      key: "`",
      code: "Backquote",
      ctrlKey: true,
    });
    expect(shouldEscapeTerminal(e)).toBe(true);
  });

  test.each([
    [
      "Ctrl+Alt+K launcher with an Option-mangled key",
      { key: "˚", code: "KeyK", ctrlKey: true, altKey: true },
    ],
    [
      "Alt+[ pane navigation with an Option-mangled key",
      { key: "“", code: "BracketLeft", altKey: true },
    ],
    [
      "Alt+] pane navigation with an Option-mangled key",
      { key: "‘", code: "BracketRight", altKey: true },
    ],
    [
      "Alt+Shift+[ tab navigation with an Option-mangled key",
      { key: "”", code: "BracketLeft", altKey: true, shiftKey: true },
    ],
    [
      "Alt+Shift+] tab navigation with an Option-mangled key",
      { key: "’", code: "BracketRight", altKey: true, shiftKey: true },
    ],
    [
      "Ctrl+Alt+/ split right",
      { key: "/", code: "Slash", ctrlKey: true, altKey: true },
    ],
    [
      "Ctrl+Alt+? split down",
      {
        key: "?",
        code: "Slash",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      },
    ],
    [
      "Ctrl+Alt+Shift+T reopen closed tab",
      {
        key: "T",
        code: "KeyT",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      },
    ],
    [
      "Ctrl+Alt+3 jump to tab",
      { key: "3", code: "Digit3", ctrlKey: true, altKey: true },
    ],
  ])("%s escapes", (_name, init) => {
    expect(shouldEscapeTerminal(new KeyboardEvent("keydown", init))).toBe(true);
  });

  test("plain alphabet keys (typing in terminal) do NOT escape", () => {
    const e = new KeyboardEvent("keydown", { key: "a" });
    expect(shouldEscapeTerminal(e)).toBe(false);
  });

  test("Ctrl+D (tab.close, not flagged) does NOT escape", () => {
    const e = new KeyboardEvent("keydown", { key: "d", ctrlKey: true });
    expect(shouldEscapeTerminal(e)).toBe(false);
  });
});

describe("TerminalTab escapes terminal-owned shortcut chords", () => {
  test("handleTerminalKeyEvent imports + calls shouldEscapeTerminal", () => {
    expect(terminalRaw).toMatch(
      /import \{[\s\S]*?\bshouldEscapeTerminal\b[\s\S]*?\} from "\.\.\/state\/shortcuts";/,
    );
    expect(terminalRaw).toMatch(
      /function handleTerminalKeyEvent\(e: KeyboardEvent\): boolean \{[\s\S]*?if \(shouldEscapeTerminal\(e\)\) return false;/,
    );
  });

  test("rationale comment cites the registry", () => {
    expect(terminalRaw).toMatch(/chord-escape registry/i);
  });
});
