// @vitest-environment jsdom
//
// Where the keyboard lands when the launcher's "Split right" opens a terminal
// in a new pane of a terminal-only window. The launcher closes while the new
// terminal still loads and hands the keyboard back to the terminal it opened
// from; the new pane's terminal must still take it once it has loaded.

import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("./terminal/backend", async (importOriginal) =>
  (await import("./__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

const caps = vi.hoisted(() => ({}) as { workspace: boolean; files: boolean; drafts: boolean });

vi.mock("./state/windowCaps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/windowCaps")>();
  Object.assign(caps, actual.windowCaps);
  return { ...actual, windowCaps: caps };
});

import { demoData, hostCommand, mountApp, settle, stubAppEnvironment, unmountApp } from "./__tests__/app";
import { ghosttyHasFocus, seatedGhostty } from "./__tests__/ghosttyTab";
import { resetLayout, terminalTab } from "./__tests__/tabs";
import { launcherPanel } from "./state/store.svelte";
import { allTerminalTabs, layout } from "./state/tabs.svelte";

stubAppEnvironment();

beforeEach(async () => {
  Object.assign(caps, { workspace: false, files: false, drafts: false });
  await mountApp(demoData([]));
});

afterEach(async () => {
  launcherPanel.open = false;
  await settle();
  await unmountApp();
  vi.restoreAllMocks();
});

async function turns(n = 12): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Split right from the launcher gives the new pane's terminal the keyboard", async () => {
  resetLayout([terminalTab({ id: "t1" })]);
  await settle();
  const t1 = await seatedGhostty(await vi.waitFor(() => {
    const el = document.querySelector('[data-terminal-tab-id="t1"]');
    expect(el).not.toBeNull();
    return el!;
  }));
  await turns(4);
  expect(ghosttyHasFocus(t1), "the first terminal holds the keyboard as the launcher opens").toBe(true);

  hostCommand("app.launcher.toggle");
  await turns(4);
  expect(launcherPanel.open).toBe(true);
  const row = [...document.querySelectorAll<HTMLButtonElement>(".deck-result")]
    .find((candidate) => candidate.querySelector(".deck-result-title")?.textContent === "Split right");
  expect(row, "the launcher lists Split right").toBeDefined();
  const startPane = layout.activePaneId;
  row!.click();
  await turns(12);
  expect(launcherPanel.open).toBe(false);
  expect(layout.activePaneId, "the new pane is the active one").not.toBe(startPane);

  const second = allTerminalTabs().find((tab) => tab.id !== "t1");
  expect(second, "the split opened a second terminal").toBeDefined();
  const t2 = await seatedGhostty(document.querySelector(`[data-terminal-tab-id="${second!.id}"]`)!);
  await turns(4);
  expect(ghosttyHasFocus(t2), "the new pane's terminal holds the keyboard").toBe(true);
  expect(ghosttyHasFocus(t1), "the terminal the launcher opened from let it go").toBe(false);
});
