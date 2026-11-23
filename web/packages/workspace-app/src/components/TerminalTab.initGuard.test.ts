// @vitest-environment jsdom
//
// A mounted terminal that cannot initialize fails its test, and the failure
// names the shared widget fixture (the guard in vitest.setup.ts). This file
// opens a Ghostty terminal without that fixture on purpose: in jsdom the real
// loader cannot fetch the core, TerminalTab reports the failed load and
// falls back, and the guard has recorded the report by the time the terminal
// is up. The case takes the failure from the guard itself, so it passes while
// the guard still fails any other test that does the same.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

import TerminalTab from "./TerminalTab.svelte";
import { failOnTerminalInitFailures } from "../../vitest.setup";
import { terminalPreferences } from "../__tests__/standalone";
import { installTerminalDom, mountTerminal, resetTerminals, seatTerminals, terminalTab } from "../__tests__/terminalTab";
import { __testSetStandalonePreferences } from "../state/store.svelte";

installTerminalDom();

beforeEach(() => {
  __testSetStandalonePreferences(terminalPreferences());
});

afterEach(() => {
  resetTerminals();
  __testSetStandalonePreferences(null);
});

test("a terminal opened without the shared widget fixture fails its test, naming the fixture", async () => {
  const [tab] = seatTerminals([terminalTab()]);
  await mountTerminal(TerminalTab, tab!);

  expect(() => failOnTerminalInitFailures()).toThrowError(
    /failed to initialize: open it on the real widget through the shared fixture in src\/__tests__\/ghosttyTab\.ts .*Reported: \[chan\] ghostty-web failed to load/,
  );
  expect(() => failOnTerminalInitFailures(), "each report fails one test").not.toThrow();
});
