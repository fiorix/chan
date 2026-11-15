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
import { resizeTeamMembers, type TeamDialogConfig } from "../state/teamDialog.svelte";
import {
  findTeamWorkPendingLead,
  layout,
  restoreLayout,
  serializeLayout,
  teamWorkPendingConfig,
  type LeafNode,
  type TerminalTab,
} from "../state/tabs.svelte";
import { workspace } from "../state/workspace.svelte";
import TeamDialog from "./TeamDialog.svelte";

// The orchestrator refuses to start a team whose workspace root it does not
// know (the identity prompt names bootstrap.md by its absolute path), so the
// root every test here runs under is seeded once.
workspace.info = { root: "/ws" } as unknown as WorkspaceInfo;

// Load mode reads an existing team's config.toml from the directory the user
// names, fills the dialog's form with it (still editable), and says which
// file it found or why it could not. The directory field suggests workspace
// folders only. Bootstrap preserves an unchanged loaded config, saves edits,
// and leaves the team's bootstrap.md, which may carry a brief, as it is.

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

  async function loadDraft(wire = loadedWire()): Promise<TeamDialogConfig> {
    vi.spyOn(api, "list").mockResolvedValue([]);
    vi.spyOn(api, "readTeamConfig").mockResolvedValue(wire);
    const target = await openLoad();
    await enter(dirInput(target), "saved-team");
    const draft = teamWorkPendingConfig({ leadTabId: "lead-tab", leadPaneId: "pane-test" });
    expect(draft).not.toBeNull();
    return JSON.parse(JSON.stringify(draft)) as TeamDialogConfig;
  }

  async function expectConfigPolicy(config: TeamDialogConfig, keep: boolean): Promise<void> {
    const stopped = new Error("stop after the config request");
    const write = vi.spyOn(api, "writeTeamConfig").mockRejectedValue(stopped);
    await expect(runTeamBootstrap(config, { leadTabId: "lead-tab", leadPaneId: "pane-test" }))
      .rejects.toBe(stopped);
    expect(write.mock.lastCall?.[4], "whether Bootstrap preserves config.toml").toBe(keep);
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

  test("Bootstrap keeps the unchanged loaded config and its bootstrap.md", async () => {
    vi.spyOn(api, "list").mockResolvedValue([]);
    vi.spyOn(api, "readTeamConfig").mockResolvedValue(loadedWire());
    vi.spyOn(api, "spawnTerminal").mockImplementation(async (request) => ({
      session: `session-${request.name}`,
      tab_label: request.name ?? "",
    }));
    const requests = recordRequests(() => json({}));
    try {
      const target = await openLoad();
      await enter(dirInput(target), "saved-team");

      target.querySelector<HTMLButtonElement>(".team-dialog-bootstrap")!.click();

      await vi.waitFor(() =>
        expect(requests.filter((r) => r.path === "/api/team-config/write")).toHaveLength(1),
      );
      const write = requests.find((r) => r.path === "/api/team-config/write")!;
      expect(write.body).toMatchObject({
        dir: "saved-team",
        config: { host_name: "Trinity" },
        keep_bootstrap: true,
        keep_config: true,
      });
      expect(write.body, "a Load sends no brief").not.toHaveProperty("brief_content");
    } finally {
      stopRecordingRequests();
    }
  });

  test.each<[string, (config: TeamDialogConfig) => void]>([
    ["host", (config) => { config.hostName = "Morpheus"; }],
    ["prefix", (config) => { config.autoPrefix = false; }],
    ["MCP", (config) => { config.mcpEnv = true; }],
    ["group", (config) => { config.tabGroup = "edited-group"; }],
    ["member name", (config) => { config.members[1].name = "@@Editor"; }],
    ["command", (config) => { config.members[1].command = "codex --resume"; }],
    ["environment", (config) => { config.members[1].env = "WORKERS=2"; }],
    ["lead", (config) => {
      config.members[0].isLead = false;
      config.members[1].isLead = true;
    }],
    ["member count", (config) => { config.members.pop(); config.size = 1; }],
    ["layout", (config) => {
      config.realEstate = { kind: "split", grid: { rows: 1, cols: 2 }, slots: [[0], [1]] };
    }],
    ["directory", (config) => { config.teamDir = "other-team"; }],
    ["New mode", (config) => { config.configMode = "new"; }],
  ])("Bootstrap saves a loaded draft after changing %s", async (_field, change) => {
    const config = await loadDraft();
    change(config);
    await expectConfigPolicy(config, false);
  });

  test("edits do not mutate the loaded baseline and reverting them preserves again", async () => {
    const config = await loadDraft();
    const baseline = config.loadedConfigSnapshot;
    expect(typeof baseline).toBe("string");
    config.members[1].env = "WORKERS=2";
    await expectConfigPolicy(config, false);
    expect(config.loadedConfigSnapshot).toBe(baseline);
    config.members[1].env = "";
    await expectConfigPolicy(config, true);
    config.configMode = "new";
    await expectConfigPolicy(config, false);
    config.configMode = "load";
    await expectConfigPolicy(config, true);
  });

  test("the loaded snapshot matches the displayed form after layout and group normalization", async () => {
    const wire = loadedWire();
    wire.tab_group = "";
    wire.members[0].position = { row: 0, col: 0 };
    wire.members[1].position = { row: 1, col: 0 };
    const config = await loadDraft(wire);
    expect(config.tabGroup).toBe("saved-team");
    expect(config.realEstate).toEqual({ kind: "split", grid: { rows: 1, cols: 2 }, slots: [[0], [1]] });
    await expectConfigPolicy(config, true);
  });

  test.each(["grid", "slots"])("Bootstrap saves an edit to the loaded split layout's %s", async (field) => {
    const wire = loadedWire();
    wire.members[0].position = { row: 0, col: 0 };
    wire.members[1].position = { row: 0, col: 1 };
    const config = await loadDraft(wire);
    expect(config.realEstate.kind).toBe("split");
    if (config.realEstate.kind !== "split") throw new Error("expected split layout");
    if (field === "grid") config.realEstate.grid = { rows: 2, cols: 1 };
    else config.realEstate.slots = [[1], [0]];
    await expectConfigPolicy(config, false);
  });

  test("an unchanged loaded draft survives session serialization and reopening the dialog", async () => {
    await loadDraft();
    const saved = JSON.parse(JSON.stringify(serializeLayout({ terminalSessions: true })));
    expect(JSON.stringify(serializeLayout())).not.toContain("loadedConfigSnapshot");
    await unmount(view!);
    view = null;
    document.body.innerHTML = "";
    await restoreLayout(saved);
    const request = findTeamWorkPendingLead();
    expect(request).not.toBeNull();
    const target = document.createElement("div");
    document.body.append(target);
    view = mount(TeamDialog, { target, props: { request: request! } });
    await settle();
    const config = teamWorkPendingConfig(request!)!;
    await expectConfigPolicy(config, true);
  });

  test("an unchanged legacy Load reads its baseline and preserves config.toml", async () => {
    const wire = loadedWire();
    wire.tab_group = "";
    wire.members[0].position = { row: 0, col: 0 };
    wire.members[1].position = { row: 1, col: 0 };
    const config = resizeTeamMembers(wireToDialog(wire, "saved-team"));
    const read = vi.spyOn(api, "readTeamConfig").mockResolvedValue(wire);
    await expectConfigPolicy(config, true);
    expect(read).toHaveBeenCalledExactlyOnceWith("saved-team");
  });

  test("an edited legacy Load reads the baseline without replacing the edited draft", async () => {
    const config = resizeTeamMembers(wireToDialog(loadedWire(), "saved-team"));
    config.members[1].env = "WORKERS=2";
    const read = vi.spyOn(api, "readTeamConfig").mockResolvedValue(loadedWire());
    await expectConfigPolicy(config, false);
    expect(read).toHaveBeenCalledExactlyOnceWith("saved-team");
    const write = vi.mocked(api.writeTeamConfig);
    expect(write.mock.lastCall?.[1].members[1].env).toMatchObject({ WORKERS: "2" });
  });

  test("a legacy Load refuses a failed baseline read before writing", async () => {
    const config = resizeTeamMembers(wireToDialog(loadedWire(), "saved-team"));
    const refused = new Error("saved config is unavailable");
    vi.spyOn(api, "readTeamConfig").mockRejectedValue(refused);
    const write = vi.spyOn(api, "writeTeamConfig").mockRejectedValue(new Error("unexpected write"));
    await expect(runTeamBootstrap(config, { leadTabId: "lead-tab", leadPaneId: "pane-test" }))
      .rejects.toBe(refused);
    expect(write).not.toHaveBeenCalled();
  });

  test("New and a loaded snapshot need no baseline read at Bootstrap", async () => {
    const config = await loadDraft();
    const read = vi.mocked(api.readTeamConfig);
    read.mockClear();
    await expectConfigPolicy(config, true);
    expect(read).not.toHaveBeenCalled();
    delete config.loadedConfigSnapshot;
    config.configMode = "new";
    await expectConfigPolicy(config, false);
    expect(read).not.toHaveBeenCalled();
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
    vi.spyOn(api, "readTeamConfig").mockResolvedValue(loadedWire());

    const cfg = resizeTeamMembers(wireToDialog(loadedWire(), "saved-team"));
    cfg.members[1].command = "codex --resume";
    await runTeamBootstrap(cfg, { leadTabId: "lead-tab", leadPaneId: "pane-test" });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("saved-team");
    // The persisted wire carries the loaded host name.
    expect(write.mock.calls[0][1]).toMatchObject({ host_name: "Trinity" });
    expect(write.mock.calls[0][1].members[1].command).toBe("codex --resume");
    expect(write.mock.calls[0][4]).toBe(false);
  });

  test("a New bootstrap sends its brief and lets the server regenerate bootstrap.md", async () => {
    setLayout(leadTab());
    vi.spyOn(api, "spawnTerminal").mockResolvedValue({ session: "w", tab_label: "w" });
    const requests = recordRequests(() => json({}));
    try {
      const cfg = resizeTeamMembers({
        ...wireToDialog(loadedWire(), "saved-team"),
        configMode: "new",
        brief: "# Brief",
      });
      await runTeamBootstrap(cfg, { leadTabId: "lead-tab", leadPaneId: "pane-test" });

      const write = requests.find((r) => r.path === "/api/team-config/write")!;
      expect(write.body).toMatchObject({ dir: "saved-team", brief_content: "# Brief" });
      expect(write.body).not.toHaveProperty("keep_bootstrap");
      expect(write.body).not.toHaveProperty("keep_config");
    } finally {
      stopRecordingRequests();
    }
  });
});
