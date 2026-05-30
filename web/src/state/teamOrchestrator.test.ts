import { describe, expect, test } from "vitest";
import {
  identityPrompt,
  memberHandle,
  parseEnvLines,
  teamNameFromPath,
  translateConfig,
  wireToDialog,
} from "./teamOrchestrator.svelte";
import type { TeamDialogConfig } from "./teamDialog.svelte";
import type { TeamConfigWire } from "../api/client";

// Pure translator unit tests. The full bootstrap chain is exercised
// in teamBootstrapOrchestrator.test.ts; here we pin the translators.
describe("parseEnvLines", () => {
  test("parses KEY=value lines into a Record", () => {
    expect(parseEnvLines("FOO=bar\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  test("skips empty lines + trims whitespace", () => {
    expect(parseEnvLines("\n  FOO=bar  \n\nBAZ=qux\n")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  test("preserves values containing equals signs", () => {
    expect(parseEnvLines("URL=https://example.com?x=1&y=2")).toEqual({
      URL: "https://example.com?x=1&y=2",
    });
  });

  test("throws on line without an `=`", () => {
    expect(() => parseEnvLines("INVALID")).toThrow(/env line 1 must be KEY=value/);
  });

  test("throws on invalid key (starts with digit)", () => {
    expect(() => parseEnvLines("1FOO=bar")).toThrow(/invalid key/);
  });

  test("empty text returns empty record", () => {
    expect(parseEnvLines("")).toEqual({});
  });
});

describe("memberHandle", () => {
  test("returns canonical handles unchanged", () => {
    expect(
      memberHandle({ name: "@@Lead", command: "claude", env: "", isLead: true }, true),
    ).toBe("@@Lead");
  });

  test("does not auto-prefix non-canonical names", () => {
    expect(
      memberHandle({ name: "Lead", command: "claude", env: "", isLead: true }, false),
    ).toBe("Lead");
  });
});

describe("teamNameFromPath", () => {
  test("derives the team name from the config dir", () => {
    expect(teamNameFromPath("/tmp/new-team-1/chan-team.toml")).toBe("new-team-1");
  });

  test("uses the file name when the path has no parent dir segment", () => {
    // `/chan-team.toml` has no intermediate dir, so the derived
    // team name is the file base. The default flow always nests
    // under a team dir (e.g. /tmp/new-team-1/...), so this is an
    // edge case rather than the common path.
    expect(teamNameFromPath("/chan-team.toml")).toBe("team");
  });
});

describe("translateConfig", () => {
  function sample(overrides: Partial<TeamDialogConfig> = {}): TeamDialogConfig {
    return {
      hostName: "@@Alice",
      configMode: "new",
      configPath: "/tmp/demo/chan-team.toml",
      size: 2,
      autoPrefix: false,
      members: [
        { name: "@@Lead", command: "claude", env: "", isLead: true },
        { name: "@@Worker1", command: "claude", env: "", isLead: false },
      ],
      realEstate: { kind: "tabs" },
      ...overrides,
    };
  }

  test("maps camelCase -> snake_case shape", () => {
    const out = translateConfig(sample());
    // team_name comes from the config path's directory.
    expect(out.team_name).toBe("demo");
    expect(out.host_name).toBe("@@Alice");
    expect(out.host_handle).toBe("@@Alice");
    expect(out.auto_prefix_at).toBe(false);
    expect(typeof out.created_at).toBe("string");
    expect(out.members.length).toBe(2);
  });

  test("each member carries handle / command / env / is_lead", () => {
    const out = translateConfig(sample());
    expect(out.members[0]).toMatchObject({
      handle: "@@Lead",
      command: "claude",
      is_lead: true,
    });
    expect(out.members[1]).toMatchObject({
      handle: "@@Worker1",
      command: "claude",
      is_lead: false,
    });
  });

  test("injects system-owned Team Work identity env", () => {
    const out = translateConfig(sample());
    expect(out.members[0].env.CHAN_TEAM_NAME).toBe("demo");
    expect(out.members[1].env.CHAN_TEAM_NAME).toBe("demo");
    expect(out.members[0].env.CHAN_TAB_NAME).toBe("@@Lead");
    expect(out.members[1].env.CHAN_TAB_NAME).toBe("@@Worker1");
  });

  test("rewrites legacy user-supplied Team Work identity env", () => {
    const out = translateConfig(
      sample({
        members: [
          {
            name: "@@Lead",
            command: "claude",
            env: "CHAN_TEAM_NAME=old\nCHAN_TAB_NAME=Custom",
            isLead: true,
          },
          { name: "@@Worker1", command: "claude", env: "", isLead: false },
        ],
      }),
    );
    expect(out.members[0].env.CHAN_TEAM_NAME).toBe("demo");
    expect(out.members[0].env.CHAN_TAB_NAME).toBe("@@Lead");
  });

  test("rejects non-canonical handles instead of repairing them", () => {
    expect(() =>
      translateConfig(
        sample({
          members: [
            { name: "Lead", command: "claude", env: "", isLead: true },
            { name: "@@Worker1", command: "claude", env: "", isLead: false },
          ],
        }),
      ),
    ).toThrow(/canonical/);
  });

  test("tabs mode persists no member position", () => {
    const out = translateConfig(sample());
    expect(out.members[0].position).toBeUndefined();
    expect(out.members[1].position).toBeUndefined();
  });

  test("split mode persists each member's row-major {row,col} position", () => {
    const out = translateConfig(
      sample({
        size: 2,
        realEstate: {
          kind: "split",
          grid: { rows: 1, cols: 2 },
          slots: [[0], [1]],
        },
      }),
    );
    expect(out.members[0].position).toEqual({ row: 0, col: 0 });
    expect(out.members[1].position).toEqual({ row: 0, col: 1 });
  });
});

describe("wireToDialog", () => {
  function wire(overrides: Partial<TeamConfigWire> = {}): TeamConfigWire {
    return {
      team_name: "demo",
      host_name: "@@Alice",
      host_handle: "@@Alice",
      auto_prefix_at: false,
      created_at: "2026-05-29T08:00:00.000Z",
      members: [
        {
          handle: "@@Lead",
          command: "claude",
          env: { CHAN_TEAM_NAME: "demo", CHAN_TAB_NAME: "@@Lead", FOO: "bar" },
          is_lead: true,
        },
        {
          handle: "@@Worker1",
          command: "claude",
          env: { CHAN_TEAM_NAME: "demo", CHAN_TAB_NAME: "@@Worker1" },
          is_lead: false,
        },
      ],
      ...overrides,
    };
  }

  test("inverse of translateConfig: snake_case -> camelCase round-trip", () => {
    const dialog = wireToDialog(wire(), "/tmp/demo/chan-team.toml");
    expect(dialog.hostName).toBe("@@Alice");
    expect(dialog.configMode).toBe("load");
    expect(dialog.configPath).toBe("/tmp/demo/chan-team.toml");
    expect(dialog.autoPrefix).toBe(false);
    expect(dialog.size).toBe(2);
    expect(dialog.members).toEqual([
      { name: "@@Lead", command: "claude", env: "FOO=bar", isLead: true },
      { name: "@@Worker1", command: "claude", env: "", isLead: false },
    ]);
  });

  test("strips system-owned identity from the visible env field", () => {
    const dialog = wireToDialog(wire(), "/tmp/demo/chan-team.toml");
    expect(dialog.members[0].env).not.toContain("CHAN_TEAM_NAME");
    expect(dialog.members[0].env).not.toContain("CHAN_TAB_NAME");
    expect(dialog.members[1].env).not.toContain("CHAN_TEAM_NAME");
    expect(dialog.members[1].env).not.toContain("CHAN_TAB_NAME");
  });

  test("no member position -> real estate is tabs", () => {
    const dialog = wireToDialog(wire(), "/tmp/demo/chan-team.toml");
    expect(dialog.realEstate).toEqual({ kind: "tabs" });
  });

  test("member positions -> split real estate reconstructed from grid", () => {
    const dialog = wireToDialog(
      wire({
        members: [
          {
            handle: "@@Lead",
            command: "claude",
            env: {},
            is_lead: true,
            position: { row: 0, col: 0 },
          },
          {
            handle: "@@Worker1",
            command: "claude",
            env: {},
            is_lead: false,
            position: { row: 0, col: 1 },
          },
        ],
      }),
      "/tmp/demo/chan-team.toml",
    );
    expect(dialog.realEstate.kind).toBe("split");
    if (dialog.realEstate.kind === "split") {
      expect(dialog.realEstate.grid).toEqual({ rows: 1, cols: 2 });
      expect(dialog.realEstate.slots).toEqual([[0], [1]]);
    }
  });

  test("keeps legacy auto_prefix_at disabled on load", () => {
    const dialog = wireToDialog(
      wire({ auto_prefix_at: true }),
      "/tmp/demo/chan-team.toml",
    );
    expect(dialog.autoPrefix).toBe(false);
  });
});

describe("translateConfig <-> wireToDialog round-trips real estate", () => {
  test("split layout survives a full save -> load -> save round-trip", () => {
    const original: TeamDialogConfig = {
      hostName: "@@Neo",
      configMode: "new",
      configPath: "/tmp/round/chan-team.toml",
      size: 3,
      autoPrefix: false,
      members: [
        { name: "@@Lead", command: "claude", env: "", isLead: true },
        { name: "@@Worker1", command: "claude", env: "", isLead: false },
        { name: "@@Worker2", command: "claude", env: "", isLead: false },
      ],
      realEstate: {
        kind: "split",
        grid: { rows: 2, cols: 2 },
        slots: [[0], [1], [2], []],
      },
    };
    const wireOut = translateConfig(original);
    const back = wireToDialog(wireOut, "/tmp/round/chan-team.toml");
    expect(back.realEstate.kind).toBe("split");
    if (back.realEstate.kind === "split") {
      // Cells 0..2 hold the three members in order; the grid is
      // derived from the max row/col seen (2x2).
      expect(back.realEstate.grid).toEqual({ rows: 2, cols: 2 });
      expect(back.realEstate.slots[0]).toEqual([0]);
      expect(back.realEstate.slots[1]).toEqual([1]);
      expect(back.realEstate.slots[2]).toEqual([2]);
    }
  });
});

describe("identityPrompt", () => {
  test("names MCP inbox tools, task files, cursors, and poke", () => {
    const out = identityPrompt(3, "@@Neo", "@@Lead", ["@@Worker1", "@@Worker2"]);
    expect(out).toContain("send_agent_task");
    expect(out).toContain("list_agent_tasks");
    expect(out).toContain("context_path");
    expect(out).toContain("latest_id");
    expect(out).toContain("poke");
    expect(out).toContain("- @@Worker1");
    expect(out).toContain("- @@Worker2");
  });

  test("does NOT escape $CHAN_TAB_NAME (agents read it as a live env-var)", () => {
    const out = identityPrompt(2, "@@Neo", "@@Lead", ["@@Worker1"]);
    expect(out).toContain("$CHAN_TAB_NAME");
    expect(out).not.toContain("\\$CHAN_TAB_NAME");
  });

  test("solo lead (no workers) renders a placeholder bullet", () => {
    const out = identityPrompt(1, "@@Neo", "@@Lead", []);
    expect(out).toContain("- (no other agents)");
  });

  test("duplicate teammate handles are listed once", () => {
    const out = identityPrompt(3, "@@Neo", "@@Lead", ["@@Worker1", "@@Worker1"]);
    expect(out.match(/@@Worker1/g) ?? []).toHaveLength(1);
  });
});
