// @vitest-environment jsdom
//
// Team Work starts from its command (the launcher's "New team", Cmd+P on the
// desktop, Mod+. p in Hybrid Nav), which opens a lead terminal and the team
// dialog over it. Alt+Space starts nothing: it belongs to the program in the
// terminal. The App is mounted over the demo workspace with a terminal tab
// focused; the assertions read the layout and the team dialog.

import { mount, tick } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("./__tests__/terminalTab")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("./__tests__/terminalTab")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("./__tests__/terminalTab")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("./__tests__/terminalTab")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("./__tests__/terminalTab")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("./__tests__/terminalTab")).webglAddonModule());

import App from "./App.svelte";
import { installDemoWorkspace } from "./demo/install";
import { teardownDemoApp } from "./demo/teardown";
import { trackTimers, type TimerTrack } from "./demo/timers";
import { closeTeamDialog, teamDialogState } from "./state/teamDialog.svelte";
import { layout, type LeafNode } from "./state/tabs.svelte";
import { installTerminalDom, terminalTab } from "./__tests__/terminalTab";

installTerminalDom();

const PANE = "team-work-pane";
let teardown: (() => Promise<void>) | null = null;

afterEach(async () => {
  await teardown?.();
  teardown = null;
  closeTeamDialog();
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function appWithTerminal(): Promise<LeafNode> {
  const timers: TimerTrack = trackTimers();
  const mounted: Array<Record<string, unknown>> = [];
  installDemoWorkspace({
    metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1_700_000_000_000, fileCount: 0, textCount: 0 },
    files: [],
  });
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(App, { target }));
  teardown = () => teardownDemoApp({ mounted, timers });
  await settle();
  const tab = terminalTab({ id: "term-existing" });
  layout.nodes = { [PANE]: { kind: "leaf", id: PANE, tabs: [tab], activeTabId: tab.id } };
  layout.rootId = PANE;
  layout.activePaneId = PANE;
  await settle();
  return layout.nodes[PANE] as LeafNode;
}

describe("Team Work", () => {
  test("its command opens a new lead terminal and the team dialog over it", async () => {
    const pane = await appWithTerminal();
    window.dispatchEvent(new CustomEvent("chan:command", { detail: { name: "app.terminal.teamWork" } }));
    await settle();

    const lead = pane.tabs.find((t) => t.id !== "term-existing");
    expect(lead?.kind).toBe("terminal");
    expect(teamDialogState.request?.leadTabId).toBe(lead!.id);
  });

  test("Alt+Space starts nothing", async () => {
    const pane = await appWithTerminal();
    const event = new KeyboardEvent("keydown", { key: " ", code: "Space", altKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    await settle();

    expect(pane.tabs.map((t) => t.id)).toEqual(["term-existing"]);
    expect(teamDialogState.request).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
