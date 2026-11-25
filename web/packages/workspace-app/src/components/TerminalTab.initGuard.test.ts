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
// A test that silences the console still fails on the error shown. A load the
// stand-in route asks for has its report let through, by its class, so an
// error that only reads like it is still reported; its terminal has no
// fallback to open on and fails on the error shown.

import { mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/terminalTab")).webglAddonModule());

// A case may replace the real loader's failure with an error of its own, or
// ask for the stand-in the way the route does.
const injected = vi.hoisted(() => ({ error: null as Error | null, route: false }));
vi.mock("../terminal/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../terminal/backend")>();
  const { requestXtermStandIn } = await import("../__tests__/xterm");
  return {
    ...actual,
    loadGhosttyKit: () => {
      if (injected.route) return requestXtermStandIn();
      return injected.error ? Promise.reject(injected.error) : actual.loadGhosttyKit();
    },
  };
});

import TerminalTab from "./TerminalTab.svelte";
import { failOnTerminalInitFailures, takeStandInReports } from "../../vitest.setup";
import { mountGhosttyTerminal } from "../__tests__/ghosttyTab";
import { terminalPreferences } from "../__tests__/standalone";
import { installTerminalDom, resetTerminals, seatTerminals, TERMINAL_PANE, terminalTab } from "../__tests__/terminalTab";
import { XtermStandInRequested, xterm } from "../__tests__/xterm";
import { __testSetStandalonePreferences } from "../state/store.svelte";

installTerminalDom();

const mounts: Array<Record<string, unknown>> = [];

beforeEach(() => {
  __testSetStandalonePreferences(terminalPreferences());
});

afterEach(() => {
  for (const component of mounts.splice(0)) unmount(component);
  injected.error = null;
  injected.route = false;
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

test("a terminal opened with neither fixture nor route fails its test under a silenced console", async () => {
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

test("a load the stand-in route asks for has its report let through, and its terminal still fails on the error shown", async () => {
  injected.route = true;
  await mountFailingTerminal();

  expect(xterm.terminals, "no stand-in opened in its place").toHaveLength(0);
  expect(takeStandInReports(), "the route's report").toBe(1);
  expect(() => failOnTerminalInitFailures()).toThrowError(
    /failed to initialize: .*In .*TerminalTab\.initGuard\.test\.ts\. 1 showed the terminal load error$/,
  );
});

test("an error that only reads like the stand-in route's is still reported", async () => {
  const lookalike = new Error(new XtermStandInRequested().message);
  lookalike.name = "XtermStandInRequested";
  injected.error = lookalike;
  await mountFailingTerminal();

  expect(() => failOnTerminalInitFailures()).toThrowError(
    /failed to initialize: .*Reported: \[chan\] ghostty-web failed to load: XtermStandInRequested/,
  );
});
