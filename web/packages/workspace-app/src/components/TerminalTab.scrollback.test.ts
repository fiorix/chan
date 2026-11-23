// @vitest-environment jsdom
//
// TerminalTab converts the persisted MB setting into the line count it
// passes the widget when it spawns.

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
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { clampScrollbackMb, scrollbackLinesFromMb } from "../terminal/scrollback";
import {
  installTerminalDom,
  resetTerminals,
  seatTerminals,
  terminalTab,
} from "../__tests__/terminalTab";

import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";

installTerminalDom();

function serveScrollbackMb(mb: number): void {
  __testSetStandalonePreferences(terminalPreferences({ scrollback_mb: mb }));
}

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
});

describe("the scrollback cap", () => {
  test("comes from the setting when the terminal spawns", async () => {
    serveScrollbackMb(50);
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    expect(term.options.scrollback).toBe(scrollbackLinesFromMb(50));
  });

  test("falls back to the clamped default without a setting", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    expect(term.options.scrollback).toBe(scrollbackLinesFromMb(clampScrollbackMb(undefined)));
  });
});
