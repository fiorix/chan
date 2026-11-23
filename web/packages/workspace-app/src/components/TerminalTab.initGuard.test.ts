// @vitest-environment jsdom
//
// A mounted terminal that cannot initialize fails its test, and the failure
// names the shared widget fixture (the guard in vitest.setup.ts). This file
// opens a Ghostty terminal without that fixture on purpose: in jsdom the real
// loader cannot fetch the core, TerminalTab reports the failed load and
// falls back, and the guard has recorded the report by the time the terminal
// is up. The first case takes the failure from the guard itself, so it passes
// while the guard still fails any other test that does the same; the second
// leaves it to the guard and is expected to fail. The runner settles an
// expected failure after the test's hooks, so that case passes only while the
// guard's own hook fails it.
//
// A load that fails with the stand-in route's own error is the one report the
// guard lets through, by its class: an error that only reads like it fails.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

// A case may replace the real loader's failure with an error of its own.
const injected = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  return {
    ...actual,
    loadGhosttyKit: () => (injected.error ? Promise.reject(injected.error) : actual.loadGhosttyKit()),
  };
});

import TerminalTab from "./TerminalTab.svelte";
import { failOnTerminalInitFailures } from "../../vitest.setup";
import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import { installTerminalDom, mountTerminal, resetTerminals, seatTerminals, terminalTab } from "../__tests__/terminalTab";
import { XtermStandInRequested, xterm } from "../__tests__/xterm";
import { __testSetStandalonePreferences } from "../state/store.svelte";

installTerminalDom();

beforeEach(() => {
  __testSetStandalonePreferences(terminalPreferences());
});

afterEach(() => {
  injected.error = null;
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

test.fails("a terminal opened without the shared widget fixture, its report left to the guard, fails the test", async () => {
  const [tab] = seatTerminals([terminalTab()]);
  await mountTerminal(TerminalTab, tab!);
});

test("the widget's checked mount refuses a file that did not declare the fixture", async () => {
  const [tab] = seatTerminals([terminalTab()]);
  await expect(mountGhosttyTerminal(TerminalTab, tab!)).rejects.toThrow(/needs the shared fixture/);
  expect(document.querySelector(".terminal-tab"), "nothing was mounted").toBeNull();
});

test("a load that fails with the stand-in route's error is let through", async () => {
  injected.error = new XtermStandInRequested();
  const [tab] = seatTerminals([terminalTab()]);
  await mountTerminal(TerminalTab, tab!);

  expect(xterm.terminals, "the terminal fell back to the stand-in").toHaveLength(1);
  expect(() => failOnTerminalInitFailures()).not.toThrow();
});

test("an error that only reads like the stand-in route's still fails its test", async () => {
  const lookalike = new Error(new XtermStandInRequested().message);
  lookalike.name = "XtermStandInRequested";
  injected.error = lookalike;
  const [tab] = seatTerminals([terminalTab()]);
  await mountTerminal(TerminalTab, tab!);

  expect(() => failOnTerminalInitFailures()).toThrowError(
    /failed to initialize: .*Reported: \[chan\] ghostty-web failed to load; falling back to xterm\.js: XtermStandInRequested/,
  );
});
