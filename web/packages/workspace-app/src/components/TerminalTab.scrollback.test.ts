// @vitest-environment jsdom
//
// TerminalTab sizes xterm's scrollback from the persisted MB setting when it
// spawns, and its copy actions serialize that much. The component is mounted
// over the stand-in xterm with the setting served as machine preferences.

import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import type { Preferences } from "../api/types";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { clampScrollbackMb, scrollbackLinesFromMb } from "../terminal/scrollback";
import {
  installTerminalDom,
  menuRow,
  mountTerminal,
  openBodyMenu,
  resetTerminals,
  seatTerminals,
  terminalTab,
  xterm,
} from "../__tests__/terminalTab";

installTerminalDom();

const clipboard = { writeText: vi.fn(async (_text: string) => {}) };
Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

function serveScrollbackMb(mb: number): void {
  __testSetStandalonePreferences({ terminal: { scrollback_mb: mb } } as unknown as Preferences);
}

beforeEach(() => {
  clipboard.writeText.mockClear();
});

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
});

describe("the scrollback cap", () => {
  test("comes from the setting when the terminal spawns", async () => {
    serveScrollbackMb(50);
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    expect(term.options.scrollback).toBe(scrollbackLinesFromMb(50));
  });

  test("falls back to the clamped default without a setting", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountTerminal(TerminalTab, tab!);
    expect(term.options.scrollback).toBe(scrollbackLinesFromMb(clampScrollbackMb(undefined)));
  });
});

describe("the copy actions", () => {
  test("Copy Scrollback serializes the configured cap", async () => {
    serveScrollbackMb(30);
    xterm.serialized = "line one\nline two";
    const [tab] = seatTerminals([terminalTab()]);
    const { target } = await mountTerminal(TerminalTab, tab!);
    await openBodyMenu(target);
    menuRow("Copy Scrollback").click();
    await tick();

    expect(xterm.serializeCalls).toEqual([{ scrollback: scrollbackLinesFromMb(30) }]);
    expect(clipboard.writeText).toHaveBeenCalledWith("line one\nline two");
  });

  test("Copy with no selection serializes the same cap", async () => {
    serveScrollbackMb(30);
    xterm.serialized = "all of it";
    const [tab] = seatTerminals([terminalTab()]);
    const { target } = await mountTerminal(TerminalTab, tab!);
    await openBodyMenu(target);
    menuRow("Copy").click();
    await tick();

    expect(xterm.serializeCalls).toEqual([{ scrollback: scrollbackLinesFromMb(30) }]);
    expect(clipboard.writeText).toHaveBeenCalledWith("all of it");
  });
});
