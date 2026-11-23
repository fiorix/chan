// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/xterm")).webglAddonModule());
vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));
vi.mock("../terminal/ghosttyCompat", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyCompatModule(importOriginal));

const completion = vi.hoisted(() => ({
  arrived: false,
  wait: Promise.resolve(),
}));
vi.mock("../state/teamOrchestrator.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/teamOrchestrator.svelte")>();
  return {
    ...actual,
    runTeamBootstrap: async (...args: Parameters<typeof actual.runTeamBootstrap>) => {
      await actual.runTeamBootstrap(...args);
      // Keep the dialog open until every created renderer has finished its
      // startup focus request. A late startup must not hide a missing return.
      completion.arrived = true;
      await completion.wait;
    },
  };
});

import { mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import type { Terminal } from "@chan/ghostty-web-ng";
import { ghosttyHasFocus, seatedGhostty } from "../__tests__/ghosttyTab";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { api } from "../api/client";
import {
  closeTeamDialog,
  defaultTeamConfig,
  openTeamDialog,
  teamDialogState,
  type TeamDialogConfig,
} from "../state/teamDialog.svelte";
import { allTerminalTabs, layout, type LeafNode } from "../state/tabs.svelte";

stubAppEnvironment();

let finishBootstrap = () => {};

beforeEach(async () => {
  completion.arrived = false;
  completion.wait = new Promise<void>((resolve) => { finishBootstrap = resolve; });
  await mountApp();
  vi.spyOn(api, "writeTeamConfig").mockResolvedValue();
  vi.spyOn(api, "spawnTerminal").mockImplementation(async (request) => ({
    session: `session-${request.name}`,
    tab_label: request.name ?? "",
  }));
});

afterEach(async () => {
  finishBootstrap();
  await settle();
  closeTeamDialog();
  await unmountApp();
  vi.restoreAllMocks();
});

/// The widget open in this tab's terminal, once the tab has mounted it.
async function rendererFor(tabId: string): Promise<Terminal> {
  const root = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-terminal-tab-id="${tabId}"]`);
    expect(found, `the terminal of ${tabId} mounted`).not.toBeNull();
    return found!;
  });
  return seatedGhostty(root);
}

describe("Team Bootstrap keyboard focus", () => {
  test.each(["tabs", "split"] as const)("returns focus to the active terminal after %s Bootstrap", async (kind) => {
    const config: TeamDialogConfig = {
      ...defaultTeamConfig(),
      size: 2,
      members: [
        { name: "Lead", command: "bash", env: "", isLead: true },
        { name: "Worker", command: "bash", env: "", isLead: false },
      ],
      realEstate: kind === "tabs"
        ? { kind: "tabs" }
        : { kind: "split", grid: { rows: 1, cols: 2 }, slots: [[0], [1]] },
    };
    resetLayout([terminalTab({
      id: "pending-lead",
      terminalSessionId: "pending-session",
      teamWorkPending: config,
    })]);
    openTeamDialog({ leadTabId: "pending-lead", leadPaneId: "pane-test" });
    await settle();
    const button = document.querySelector<HTMLButtonElement>(".team-dialog-bootstrap")!;
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();

    await vi.waitFor(() => expect(completion.arrived).toBe(true));
    expect(api.spawnTerminal).toHaveBeenCalledTimes(2);
    const terminals = allTerminalTabs();
    expect(terminals.map((tab) => tab.title).sort()).toEqual(["@@Lead", "@@Worker"]);
    expect(Object.values(layout.nodes).filter((node) => node.kind === "leaf")).toHaveLength(kind === "tabs" ? 1 : 2);
    for (const tab of terminals) await rendererFor(tab.id);
    await settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(teamDialogState.request, "the dialog still owns the keyboard while Bootstrap is pending").not.toBeNull();
    expect(document.activeElement).toBe(button);

    const pane = layout.nodes[layout.activePaneId] as LeafNode;
    expect(pane.id).toBe("pane-test");
    const selected = pane.tabs.find((tab) => tab.id === pane.activeTabId)!;
    expect(selected.kind).toBe("terminal");
    expect(selected.kind === "terminal" && selected.title).toBe(kind === "tabs" ? "@@Worker" : "@@Lead");
    const term = await rendererFor(selected.id);
    expect(ghosttyHasFocus(term), "the dialog's button holds the keyboard, not the terminal").toBe(false);

    finishBootstrap();
    await vi.waitFor(() => expect(document.querySelector(".team-dialog")).toBeNull());
    await settle();
    expect(teamDialogState.request).toBeNull();
    expect(ghosttyHasFocus(term), "Bootstrap returns the keyboard to the active terminal").toBe(true);
  });
});
