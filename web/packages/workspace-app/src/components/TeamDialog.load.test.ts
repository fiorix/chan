// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/client";
import type { TeamConfigWire } from "../api/client";
import type { WorkspaceInfo } from "../api/types";
import { json, recordRequests, stopRecordingRequests } from "../__tests__/fetch";
import {
  runTeamBootstrap,
  translateConfig,
  wireToDialog,
} from "../state/teamOrchestrator.svelte";
import { resizeTeamMembers } from "../state/teamDialog.svelte";
import { layout, type LeafNode, type TerminalTab } from "../state/tabs.svelte";
import { workspace } from "../state/workspace.svelte";
import TeamDialog from "./TeamDialog.svelte";

// The orchestrator refuses to start a team whose workspace root it does not
// know (the identity prompt names bootstrap.md by its absolute path), so the
// root every test here runs under is seeded once.
workspace.info = { root: "/ws" } as unknown as WorkspaceInfo;

// Load mode reads an existing team's config.toml from the directory the user
// names, fills the dialog's form with it (still editable), and says which
// file it found or why it could not. The directory field suggests workspace
// folders only. Bootstrap writes the edited config back to that directory.

describe("the team-config client calls", () => {
  afterEach(stopRecordingRequests);

  test("readTeamConfig posts the directory and answers the config", async () => {
    const requests = recordRequests(() => json(loadedWire()));

    await expect(api.readTeamConfig("saved-team")).resolves.toMatchObject({ team_name: "saved-team" });
    expect(requests).toMatchObject([
      { method: "POST", path: "/api/team-config/read", body: { dir: "saved-team" } },
    ]);
  });

  test("writeTeamConfig posts the directory, the config and the brief", async () => {
    const requests = recordRequests(() => new Response(null, { status: 204 }));

    await api.writeTeamConfig("saved-team", loadedWire(), "# Brief");

    expect(requests).toMatchObject([
      {
        method: "POST",
        path: "/api/team-config/write",
        body: { dir: "saved-team", config: { team_name: "saved-team" }, brief_content: "# Brief" },
      },
    ]);
  });
});

describe("the dialog's Load mode", () => {
  let view: Record<string, unknown> | null = null;

  afterEach(() => {
    if (view) unmount(view);
    view = null;
    document.body.innerHTML = "";
  });

  async function openLoad(): Promise<HTMLElement> {
    setLayout(leadTab());
    const target = document.createElement("div");
    document.body.append(target);
    view = mount(TeamDialog, { target, props: { request: { leadTabId: "lead-tab", leadPaneId: "pane-test" } } });
    flushSync();
    [...target.querySelectorAll<HTMLButtonElement>(".team-realestate-mode")]
      .find((button) => button.textContent?.trim() === "Load")!
      .click();
    await settle();
    return target;
  }

  function dirInput(target: HTMLElement): HTMLInputElement {
    return target.querySelector<HTMLInputElement>('input[list="team-dir-suggestions"]')!;
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function enter(input: HTMLInputElement, value: string): Promise<void> {
    type(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) await tick();
    flushSync();
  }

  test("reads the named directory's config and names the file it found", async () => {
    vi.spyOn(api, "list").mockResolvedValue([]);
    const read = vi.spyOn(api, "readTeamConfig").mockResolvedValue(loadedWire());
    const target = await openLoad();

    await enter(dirInput(target), "saved-team/");

    expect(read).toHaveBeenCalledWith("saved-team");
    const found = target.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, " ").trim();
    expect(found).toBe("saved-team/config.toml saved-team · 2 members");
  });

  test("fills the form from the loaded config, which stays editable", async () => {
    vi.spyOn(api, "list").mockResolvedValue([]);
    vi.spyOn(api, "readTeamConfig").mockResolvedValue({ ...loadedWire(), tab_group: "saved-group" });
    const target = await openLoad();

    await enter(dirInput(target), "saved-team");

    const group = target.querySelector<HTMLInputElement>('input[placeholder="chan-team"]')!;
    expect(group.value).toBe("saved-group");
    type(group, "edited-group");
    flushSync();
    expect(group.value).toBe("edited-group");
  });

  test("shows the server's refusal inline", async () => {
    vi.spyOn(api, "list").mockResolvedValue([]);
    vi.spyOn(api, "readTeamConfig").mockRejectedValue(new Error("no config.toml in saved-team"));
    const target = await openLoad();

    await enter(dirInput(target), "saved-team");

    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe("no config.toml in saved-team");
  });

  test("asks for a directory when none is named", async () => {
    vi.spyOn(api, "list").mockResolvedValue([]);
    const read = vi.spyOn(api, "readTeamConfig");
    const target = await openLoad();

    await enter(dirInput(target), "  ");

    expect(read).not.toHaveBeenCalled();
    expect(target.querySelector('[role="alert"]')?.textContent?.trim()).toBe("Team directory required");
  });

  test("suggests workspace folders only, matching what is typed", async () => {
    const list = vi.spyOn(api, "list").mockImplementation(async (dir) =>
      dir === "teams"
        ? [{ path: "teams/alpha", is_dir: true, size: 0, mtime: null }]
        : [
            { path: "teams", is_dir: true, size: 0, mtime: null },
            { path: "tmp", is_dir: true, size: 0, mtime: null },
            { path: "todo.md", is_dir: false, size: 1, mtime: null },
          ],
    );
    const target = await openLoad();
    const options = () => [...target.querySelectorAll("#team-dir-suggestions option")].map((option) => option.getAttribute("value"));

    type(dirInput(target), "t");
    await settle();
    expect(options()).toEqual(["teams/", "tmp/"]);

    type(dirInput(target), "te");
    await settle();
    expect(options()).toEqual(["teams/"]);

    type(dirInput(target), "teams/");
    await settle();
    expect(list).toHaveBeenLastCalledWith("teams");
    expect(options()).toEqual(["teams/alpha/"]);
  });
});

function leadTab(): TerminalTab {
  return {
    kind: "terminal",
    id: "lead-tab",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    terminalSessionId: "lead-session",
  };
}

function setLayout(lead: TerminalTab): void {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs: [lead],
    activeTabId: lead.id,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
}

function loadedWire(): TeamConfigWire {
  return {
    team_name: "saved-team",
    host_name: "Trinity",
    host_handle: "@@Trinity",
    tab_group: "saved-team",
    auto_prefix_at: true,
    mcp_env: false,
    created_at: "2026-05-29T00:00:00.000Z",
    members: [
      { handle: "@@Lead", command: "claude", env: { CHAN_TAB_NAME: "@@Lead" }, is_lead: true },
      {
        handle: "@@Worker1",
        command: "codex",
        env: { CHAN_TAB_NAME: "@@Worker1" },
        is_lead: false,
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setLayout(leadTab());
});

describe("Load -> edit -> Bootstrap re-saves the config", () => {
  test("a loaded config round-trips into an editable dialog config", () => {
    const cfg = resizeTeamMembers(wireToDialog(loadedWire(), "saved-team"));
    expect(cfg.configMode).toBe("load");
    expect(cfg.hostName).toBe("Trinity");
    expect(cfg.members.map((m) => m.name)).toEqual(["@@Lead", "@@Worker1"]);
    // The config is a plain editable object; translating it back
    // yields the same members (the round-trip the dialog uses on
    // Bootstrap).
    const back = translateConfig(cfg);
    expect(back.members.map((m) => m.handle)).toEqual(["@@Lead", "@@Worker1"]);
  });

  test("Bootstrap writes the (edited) config back to the team dir", async () => {
    const lead = leadTab();
    setLayout(lead);
    const write = vi
      .spyOn(api, "writeTeamConfig")
      .mockResolvedValue(undefined as unknown as void);
    vi.spyOn(api, "restartTerminal").mockResolvedValue(undefined as unknown as void);
    vi.spyOn(api, "spawnTerminal").mockResolvedValue({ session: "w", tab_label: "w" });

    const cfg = resizeTeamMembers(wireToDialog(loadedWire(), "saved-team"));
    await runTeamBootstrap(cfg, { leadTabId: "lead-tab", leadPaneId: "pane-test" });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("saved-team");
    // The persisted wire carries the loaded host name.
    expect(write.mock.calls[0][1]).toMatchObject({ host_name: "Trinity" });
  });
});
