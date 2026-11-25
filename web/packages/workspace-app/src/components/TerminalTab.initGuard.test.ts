// @vitest-environment jsdom
//
// A mounted terminal that cannot initialize fails its test, and the failure
// names the shared widget fixture (the guard in vitest.setup.ts). This file
// opens a Ghostty terminal without that fixture on purpose: in jsdom the real
// loader cannot fetch the core, TerminalTab reports the failed load and shows
// its error in the terminal's area, and the guard has recorded the report and
// the error shown by the time the error is up. The first case takes the
// failure from the guard itself, so it passes while the guard still fails any
// other test that does the same; the second leaves it to the guard and is
// expected to fail. The runner settles an expected failure after the test's
// hooks, so that case passes only while the guard's own hook fails it, and the
// case after it reads that its body ran to the end, so the failure was the
// hook's.
//
// A test that silences the console still fails on the error shown.

import { mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import TerminalTab from "./TerminalTab.svelte";
import { failOnTerminalInitFailures } from "../../vitest.setup";
import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import { installTerminalDom, resetTerminals, seatTerminals, TERMINAL_PANE, terminalTab } from "../__tests__/terminalTab";
import { xterm } from "../__tests__/xterm";
import { __testSetStandalonePreferences } from "../state/store.svelte";

installTerminalDom();

const mounts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  __testSetStandalonePreferences(terminalPreferences());
});

afterEach(() => {
  for (const component of mounts.splice(0)) unmount(component);
  resetTerminals();
  __testSetStandalonePreferences(null);
  vi.restoreAllMocks();
});

/// Mount a terminal in a focused pane and wait for the error it shows in
/// place of the terminal it could not open.
async function mountFailingTerminal(): Promise<HTMLElement> {
  const [tab] = seatTerminals([terminalTab()]);
  const target = document.createElement("div");
  document.body.append(target);
  mounts.push(mount(TerminalTab, {
    target,
    props: { tab: tab!, paneId: TERMINAL_PANE, side: "a", active: true, focused: true },
  }));
  await vi.waitFor(() =>
    expect(target.querySelector(".terminal-main [role=alert]"), "the terminal's load error").not.toBeNull(),
  );
  return target;
}

// Set at the end of the expected failure's body.
let unguardedBodyRan = false;

test("a terminal opened without the shared widget fixture fails its test, naming the fixture", async () => {
  await mountFailingTerminal();

  expect(() => failOnTerminalInitFailures()).toThrowError(
    /failed to initialize: open it on the real widget through the shared fixture in src\/__tests__\/ghosttyTab\.ts .*Reported: \[chan\] ghostty-web failed to load.*\. 1 showed the terminal load error$/,
  );
  expect(() => failOnTerminalInitFailures(), "each failure fails one test").not.toThrow();
});

test.fails("a terminal opened without the shared widget fixture, its report left to the guard, fails the test", async () => {
  await mountFailingTerminal();
  unguardedBodyRan = true;
});

test("the expected failure above ran its body to the end, so the guard's hook failed it", () => {
  expect(unguardedBodyRan).toBe(true);
});

test("a terminal opened without the shared widget fixture fails its test under a silenced console", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await mountFailingTerminal();

  expect(xterm.terminals, "no stand-in opened in its place").toHaveLength(0);
  expect(() => failOnTerminalInitFailures()).toThrowError(
    /failed to initialize: .*In .*TerminalTab\.initGuard\.test\.ts\. 1 showed the terminal load error$/,
  );
});

test("the widget's checked mount refuses a file that did not declare the fixture", async () => {
  const [tab] = seatTerminals([terminalTab()]);
  await expect(mountGhosttyTerminal(TerminalTab, tab!)).rejects.toThrow(/needs the shared fixture/);
  expect(document.querySelector(".terminal-tab"), "nothing was mounted").toBeNull();
});
