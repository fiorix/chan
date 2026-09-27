import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "../components/TerminalTab.svelte";
import {
  installTerminalDom,
  mountTerminal,
  pressInTerminal,
  resetTerminals,
  seatTerminals,
  terminalTab,
  xterm,
} from "../__tests__/terminalTab";
import { currentOS, currentPlatform, shouldEscapeTerminal } from "./shortcuts";
import { persistStateToHash } from "./store.svelte";

installTerminalDom();

afterEach(() => {
  resetTerminals();
  persistStateToHash();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  ["linux", "Mozilla/5.0 (X11; Linux x86_64)"],
  ["windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
] as const)("native %s terminal shortcuts", (os, userAgent) => {
  test("Ctrl+[ escapes the focused terminal for pane navigation", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke: vi.fn(async () => undefined) });
    xterm.textareaFocus = true;
    const [tab] = seatTerminals([terminalTab()]);
    const { target, term } = await mountTerminal(TerminalTab, tab!);
    expect(currentOS()).toBe(os);
    expect(currentPlatform()).toBe("native");
    expect(target.querySelector(".terminal-tab.active")?.contains(document.activeElement)).toBe(true);

    const { event, handled } = pressInTerminal(term, {
      key: "[", code: "BracketLeft", ctrlKey: true,
    });

    expect(shouldEscapeTerminal(event)).toBe(true);
    // False asks xterm to skip encoding the key and let the app handle it.
    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
