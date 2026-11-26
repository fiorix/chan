// @vitest-environment jsdom
//
// TerminalTab passes the persisted MB setting to the widget as its history
// budget in bytes when it spawns, and no line count beside it.

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import TerminalTab from "./TerminalTab.svelte";
import { terminalPreferences } from "../__tests__/standalone";
import { __testSetStandalonePreferences } from "../state/store.svelte";
import { SCROLLBACK_MB_DEFAULT, SCROLLBACK_MB_MAX } from "../terminal/scrollback";
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

const MIB = 1_048_576;
/// The widget's line cap when none is passed, which a byte budget replaces.
const WIDGET_DEFAULT_LINES = 10_000;

describe("the scrollback budget", () => {
  test("is the setting in bytes when the terminal spawns, with no line cap", async () => {
    serveScrollbackMb(50);
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    expect(term.options.scrollbackBytes).toBe(50 * MIB);
    expect(term.options.scrollback, "no line cap converted from the setting").toBe(WIDGET_DEFAULT_LINES);
  });

  test("falls back to the clamped default without a setting", async () => {
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    expect(term.options.scrollbackBytes).toBe(SCROLLBACK_MB_DEFAULT * MIB);
  });

  test("takes a setting over the slider's range at its top", async () => {
    serveScrollbackMb(500);
    const [tab] = seatTerminals([terminalTab()]);
    const { term } = await mountGhosttyTerminal(TerminalTab, tab!);
    expect(term.options.scrollbackBytes).toBe(SCROLLBACK_MB_MAX * MIB);
  });
});
