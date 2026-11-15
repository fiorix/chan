// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());
vi.mock("@xterm/addon-webgl", async () => (await import("../__tests__/xterm")).webglAddonModule());

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
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { xterm } from "../__tests__/xterm";
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
  xterm.textareaFocus = true;
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
  xterm.terminals.splice(0);
  xterm.textareaFocus = false;
});

function rendererFor(tabId: string) {
  const root = document.querySelector<HTMLElement>(`[data-terminal-tab-id="${tabId}"]`);
  return xterm.terminals.find((terminal) =>
    !terminal.disposed && terminal.textarea && root?.contains(terminal.textarea));
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
    await vi.waitFor(() => {
      for (const tab of terminals) expect(rendererFor(tab.id)?.textarea?.isConnected).toBe(true);
    });
    await settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(teamDialogState.request, "the dialog still owns the keyboard while Bootstrap is pending").not.toBeNull();
    expect(document.activeElement).toBe(button);

    const pane = layout.nodes[layout.activePaneId] as LeafNode;
    expect(pane.id).toBe("pane-test");
    const selected = pane.tabs.find((tab) => tab.id === pane.activeTabId)!;
    expect(selected.kind).toBe("terminal");
    expect(selected.kind === "terminal" && selected.title).toBe(kind === "tabs" ? "@@Worker" : "@@Lead");
    const textarea = rendererFor(selected.id)!.textarea!;
    expect(textarea.isConnected).toBe(true);

    finishBootstrap();
    await vi.waitFor(() => expect(document.querySelector(".team-dialog")).toBeNull());
    await settle();
    expect(teamDialogState.request).toBeNull();
    expect(document.activeElement, "Bootstrap returns the keyboard to the active terminal").toBe(textarea);
  });
});
