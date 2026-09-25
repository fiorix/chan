// @vitest-environment jsdom
//
// The Team Work dialog opens over the lead terminal it was spawned with. By
// default the host is Neo and a new team of one lead agent lives in
// new-team-1, with names auto-prefixed. It asks for the host's name, the
// auto-prefix, where the team lives (Load is in TeamDialog.load.test.ts), the
// number of agents from a one-to-nine dropdown, and per agent a name, a
// command, env and the lead; the agent kind is read off the command, with
// CHAN_AGENT in the env to override it, so there is no agent picker. With
// split panes, an agent not yet placed in the grid reads drag-me. Bootstrap starts
// the team on the lead terminal; Cancel or Escape, which the dialog takes
// ahead of the terminal holding the focus, closes the lead terminal and the
// dialog.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../state/teamOrchestrator.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/teamOrchestrator.svelte")>()),
  runTeamBootstrap: vi.fn(async () => {}),
}));

import { resetLayout, terminalTab } from "../__tests__/tabs";
import {
  closeTeamDialog,
  defaultTeamConfig,
  openTeamDialog,
  TEAM_MIN_SIZE,
  teamDialogState,
  validateTeamConfig,
} from "../state/teamDialog.svelte";
import { runTeamBootstrap } from "../state/teamOrchestrator.svelte";
import { layout, type LeafNode } from "../state/tabs.svelte";
import TeamDialog from "./TeamDialog.svelte";

describe("the default team", () => {
  test("is Neo's, new, in new-team-1, with one lead and auto-prefixed names", () => {
    const cfg = defaultTeamConfig();
    expect(cfg.hostName).toBe("Neo");
    expect(cfg.configMode).toBe("new");
    expect(cfg.teamDir).toBe("new-team-1");
    expect(cfg.size).toBe(TEAM_MIN_SIZE);
    expect(cfg.members).toHaveLength(1);
    expect(cfg.members[0].isLead).toBe(true);
    expect(cfg.autoPrefix).toBe(true);
  });

  test("needs a team directory inside the workspace", () => {
    const cfg = { ...defaultTeamConfig(), teamDir: "/tmp/new-team-1" };
    expect(validateTeamConfig(cfg)).toBe("Team directory must be a path inside the workspace");
    const empty = { ...defaultTeamConfig(), teamDir: "" };
    expect(validateTeamConfig(empty)).toBe("Team directory required");
    expect(validateTeamConfig(defaultTeamConfig())).toBeNull();
  });
});

describe("the dialog", () => {
  const request = { leadTabId: "lead-tab", leadPaneId: "pane-test" };
  let view: Record<string, unknown> | null = null;
  let target: HTMLElement;

  beforeEach(() => {
    resetLayout([terminalTab({ id: "lead-tab", terminalSessionId: "lead-session" })]);
    openTeamDialog(request);
    target = document.createElement("div");
    document.body.append(target);
    view = mount(TeamDialog, { target, props: { request } });
    flushSync();
  });

  afterEach(() => {
    if (view) unmount(view);
    view = null;
    closeTeamDialog();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function button(label: string): HTMLButtonElement | undefined {
    return [...target.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  }

  function members(): HTMLElement[] {
    return [...target.querySelectorAll<HTMLElement>(".team-member-row")];
  }

  test("opens on the defaults", () => {
    expect(target.querySelector<HTMLInputElement>('input[placeholder="Neo"]')!.value).toBe("Neo");
    expect(
      [...target.querySelectorAll<HTMLLabelElement>("label.team-checkbox-row")]
        .find((row) => row.textContent?.includes("Auto-prefix"))!
        .querySelector<HTMLInputElement>("input")!.checked,
    ).toBe(true);
    expect(target.textContent).toContain("Team files will be created in <workspace>/new-team-1/");
    expect(members()).toHaveLength(1);
    expect(members()[0].querySelector<HTMLInputElement>('input[name="team-lead"]')!.checked).toBe(true);
  });

  test("picks the number of agents from one to nine, adding a row for each", async () => {
    const size = [...target.querySelectorAll<HTMLSelectElement>("select")].find((select) =>
      select.closest("label")?.textContent?.includes("Number of agents"),
    )!;
    expect([...size.options].map((option) => option.value)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(target.querySelector('input[type="range"]')).toBeNull();

    size.value = "3";
    size.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();

    expect(members()).toHaveLength(3);
  });

  test("asks each agent for a name, a command and env, with CHAN_AGENT as the agent override", () => {
    const row = members()[0];

    expect(row.querySelector(".team-member-name")).not.toBeNull();
    expect(row.querySelector(".team-member-command")).not.toBeNull();
    expect(row.querySelector<HTMLInputElement>(".team-member-env")!.placeholder).toContain("CHAN_AGENT");
    expect(row.querySelector("select")).toBeNull();
  });

  test("marks an agent not yet placed in the split grid drag-me", async () => {
    expect(members()[0].querySelector(".team-member-cell-badge")).toBeNull();

    button("Split panes")!.click();
    await tick();

    expect(members()[0].querySelector(".team-member-cell-badge.unassigned")?.textContent).toBe("drag-me");
  });

  test("offers Cancel and Bootstrap, and no copy or paste of the config", () => {
    const labels = [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());

    expect(target.querySelector(".team-dialog-cancel")?.textContent?.trim()).toBe("Cancel");
    expect(target.querySelector(".team-dialog-bootstrap")?.textContent?.trim()).toBe("Bootstrap");
    expect(labels).not.toContain("Copy config");
    expect(labels).not.toContain("Paste config");
  });

  test("Bootstrap starts the team on the lead terminal and closes the dialog", async () => {
    target.querySelector<HTMLButtonElement>(".team-dialog-bootstrap")!.click();

    await vi.waitFor(() => expect(teamDialogState.request).toBeNull());
    expect(runTeamBootstrap).toHaveBeenCalledWith(expect.objectContaining({ hostName: "Neo" }), request);
  });

  test("Cancel closes the lead terminal and the dialog", async () => {
    target.querySelector<HTMLButtonElement>(".team-dialog-cancel")!.click();

    expect(teamDialogState.request).toBeNull();
    await vi.waitFor(() => expect((layout.nodes["pane-test"] as LeafNode).tabs).toEqual([]));
  });

  test("Escape cancels ahead of the terminal holding the focus", async () => {
    const terminal = document.createElement("div");
    document.body.append(terminal);
    const terminalKeys = vi.fn((event: KeyboardEvent) => event.stopPropagation());
    terminal.addEventListener("keydown", terminalKeys);

    terminal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(teamDialogState.request).toBeNull();
    expect(terminalKeys).not.toHaveBeenCalled();
    await vi.waitFor(() => expect((layout.nodes["pane-test"] as LeafNode).tabs).toEqual([]));
  });
});
