import { describe, expect, test } from "vitest";
import {
  identityPrompt,
  memberHandle,
  parseEnvLines,
  translateConfig,
  wireToDialog,
} from "./teamOrchestrator.svelte";
import { teamNameFromDir } from "./teamConfigPath";
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
  test("auto-prefixes with @@ when autoPrefix is on", () => {
    expect(
      memberHandle({ name: "Lead", command: "claude", env: "", isLead: true }, true),
    ).toBe("@@Lead");
  });

  test("returns raw name when autoPrefix is off", () => {
    expect(
      memberHandle({ name: "Lead", command: "claude", env: "", isLead: true }, false),
    ).toBe("Lead");
  });

  test("skips double-prefix when name already starts with @@", () => {
    expect(
      memberHandle({ name: "@@Lead", command: "claude", env: "", isLead: true }, true),
    ).toBe("@@Lead");
  });
});

describe("teamNameFromDir", () => {
  test("derives the team name from the team-dir basename", () => {
    expect(teamNameFromDir("new-team-1")).toBe("new-team-1");
    expect(teamNameFromDir("teams/alpha")).toBe("alpha");
  });

  test("strips a trailing slash; falls back to team for an empty basename", () => {
    expect(teamNameFromDir("new-team-1/")).toBe("new-team-1");
    expect(teamNameFromDir("")).toBe("team");
  });
});

describe("translateConfig", () => {
  function sample(overrides: Partial<TeamDialogConfig> = {}): TeamDialogConfig {
    return {
      hostName: "Alice",
      configMode: "new",
      teamDir: "demo",
      tabGroup: "chan-team",
      size: 2,
      autoPrefix: true,
      mcpEnv: false,
      members: [
        { name: "Lead", command: "claude", env: "", isLead: true },
        { name: "Worker1", command: "claude", env: "", isLead: false },
      ],
      realEstate: { kind: "tabs" },
      brief: "",
      ...overrides,
    };
  }

  test("maps camelCase -> snake_case shape", () => {
    const out = translateConfig(sample());
    // team_name comes from the team-dir basename.
    expect(out.team_name).toBe("demo");
    expect(out.host_name).toBe("Alice");
    expect(out.host_handle).toBe("@@Alice");
    expect(out.auto_prefix_at).toBe(true);
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

  test("auto-injects CHAN_TAB_NAME=<handle> when env doesn't carry it", () => {
    const out = translateConfig(sample());
    expect(out.members[0].env.CHAN_TAB_NAME).toBe("@@Lead");
    expect(out.members[1].env.CHAN_TAB_NAME).toBe("@@Worker1");
  });

  test("preserves user-supplied CHAN_TAB_NAME override", () => {
    const out = translateConfig(
      sample({
        members: [
          { name: "Lead", command: "claude", env: "CHAN_TAB_NAME=Custom", isLead: true },
          { name: "Worker1", command: "claude", env: "", isLead: false },
        ],
      }),
    );
    expect(out.members[0].env.CHAN_TAB_NAME).toBe("Custom");
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

  test("the wire carries no agent field (the server derives it from command)", () => {
    // The submit agent is no longer carried on the wire: the server derives
    // it from the command (+ CHAN_AGENT) via SubmitAgent::derive. The TS
    // derivation (agentForMember) is unit-tested in teamDialogAgent.test.ts.
    const out = translateConfig(
      sample({
        members: [
          { name: "Lead", command: "claude --resume", env: "", isLead: true },
          { name: "Worker1", command: "bash", env: "CHAN_AGENT=codex", isLead: false },
        ],
      }),
    );
    expect("agent" in out.members[0]).toBe(false);
    expect("agent" in out.members[1]).toBe(false);
    // CHAN_AGENT stays in the member's env so the server can read it.
    expect(out.members[1].env.CHAN_AGENT).toBe("codex");
  });
});

describe("wireToDialog", () => {
  function wire(overrides: Partial<TeamConfigWire> = {}): TeamConfigWire {
    return {
      team_name: "demo",
      host_name: "Alice",
      host_handle: "@@Alice",
      tab_group: "demo",
      auto_prefix_at: true,
      mcp_env: false,
      created_at: "2026-05-29T08:00:00.000Z",
      members: [
        {
          handle: "@@Lead",
          command: "claude",
          env: { CHAN_TAB_NAME: "@@Lead", FOO: "bar" },
          is_lead: true,
        },
        {
          handle: "@@Worker1",
          command: "claude",
          env: { CHAN_TAB_NAME: "@@Worker1" },
          is_lead: false,
        },
      ],
      ...overrides,
    };
  }

  test("inverse of translateConfig: snake_case -> camelCase round-trip", () => {
    const dialog = wireToDialog(wire(), "demo");
    expect(dialog.hostName).toBe("Alice");
    expect(dialog.configMode).toBe("load");
    expect(dialog.teamDir).toBe("demo");
    expect(dialog.autoPrefix).toBe(true);
    expect(dialog.size).toBe(2);
    expect(dialog.members).toEqual([
      // The draft carries no `agent`; it is derived from the command at wire
      // time, not stored on the member.
      { name: "@@Lead", command: "claude", env: "FOO=bar", isLead: true },
      { name: "@@Worker1", command: "claude", env: "", isLead: false },
    ]);
  });

  test("strips CHAN_TAB_NAME from the visible env field", () => {
    const dialog = wireToDialog(wire(), "demo");
    expect(dialog.members[0].env).not.toContain("CHAN_TAB_NAME");
    expect(dialog.members[1].env).not.toContain("CHAN_TAB_NAME");
  });

  test("no member position -> real estate is tabs", () => {
    const dialog = wireToDialog(wire(), "demo");
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
      "demo",
    );
    expect(dialog.realEstate.kind).toBe("split");
    if (dialog.realEstate.kind === "split") {
      expect(dialog.realEstate.grid).toEqual({ rows: 1, cols: 2 });
      expect(dialog.realEstate.slots).toEqual([[0], [1]]);
    }
  });

  test("preserves auto_prefix_at when false", () => {
    const dialog = wireToDialog(wire({ auto_prefix_at: false }), "demo");
    expect(dialog.autoPrefix).toBe(false);
  });

  test("the draft never carries an agent field (it is derived from command)", () => {
    const dialog = wireToDialog(
      wire({
        members: [
          { handle: "@@Lead", command: "claude", env: {}, is_lead: true },
          { handle: "@@Worker1", command: "bash", env: {}, is_lead: false },
        ],
      }),
      "demo",
    );
    expect("agent" in dialog.members[0]).toBe(false);
    expect("agent" in dialog.members[1]).toBe(false);
  });
});

describe("translateConfig <-> wireToDialog round-trips real estate", () => {
  test("split layout survives a full save -> load -> save round-trip", () => {
    const original: TeamDialogConfig = {
      hostName: "Neo",
      configMode: "new",
      teamDir: "round",
      tabGroup: "chan-team",
      size: 3,
      autoPrefix: true,
      mcpEnv: false,
      members: [
        { name: "Lead", command: "claude", env: "", isLead: true },
        { name: "Worker1", command: "claude", env: "", isLead: false },
        { name: "Worker2", command: "claude", env: "", isLead: false },
      ],
      realEstate: {
        kind: "split",
        grid: { rows: 2, cols: 2 },
        slots: [[0], [1], [2], []],
      },
      brief: "",
    };
    const wireOut = translateConfig(original);
    const back = wireToDialog(wireOut, "round");
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

  test("commands survive a save -> load round-trip (the agent re-derives)", () => {
    const original: TeamDialogConfig = {
      hostName: "Neo",
      configMode: "new",
      teamDir: "round",
      tabGroup: "chan-team",
      size: 3,
      autoPrefix: true,
      mcpEnv: false,
      members: [
        { name: "Lead", command: "claude", env: "", isLead: true },
        { name: "Worker1", command: "gemini", env: "", isLead: false },
        { name: "Worker2", command: "bash", env: "", isLead: false },
      ],
      realEstate: { kind: "tabs" },
      brief: "",
    };
    // The agent is not stored anywhere: it is derived from the command at use
    // time (server-side, and SPA-side for the lead poke). The command round-
    // trips, so the derivation stays stable. The wire never carries `agent`.
    const wireOut = translateConfig(original);
    expect(wireOut.members.every((m) => !("agent" in m))).toBe(true);
    const back = wireToDialog(wireOut, "round");
    expect(back.members.map((m) => m.command)).toEqual(["claude", "gemini", "bash"]);
  });
});

describe("identityPrompt", () => {
  test("renders the # Team work prompt with size / host / lead + worker bullets + bootstrap lines", () => {
    const out = identityPrompt(
      3,
      "@@Neo",
      "@@Lead",
      ["@@Worker1", "@@Worker2"],
      "/ws",
      "new-team-1",
    );
    expect(out).toBe(
      "# Team work\n" +
        "We are a team of 3. Our host is @@Neo and the team lead is @@Lead.\n" +
        "You are $CHAN_TAB_NAME. Identify yourself and get ready to work with\n" +
        "the rest of the team:\n" +
        "- @@Worker1\n" +
        "- @@Worker2\n" +
        "Read the team process at /ws/new-team-1/bootstrap.md before you start.\n" +
        "Relative paths in that document resolve against /ws.",
    );
  });

  test("does NOT escape $CHAN_TAB_NAME (agents read it as a live env-var)", () => {
    const out = identityPrompt(2, "@@Neo", "@@Lead", ["@@Worker1"], "/ws", "t");
    expect(out).toContain("$CHAN_TAB_NAME");
    expect(out).not.toContain("\\$CHAN_TAB_NAME");
  });

  test("solo lead (no workers) renders a placeholder bullet", () => {
    const out = identityPrompt(1, "@@Neo", "@@Lead", [], "/ws", "t");
    expect(out).toContain("- (no other agents)");
  });

  test("joins the root and the team dir with one separator", () => {
    // A root or team dir spelled with trailing slashes still joins cleanly,
    // and the root the prompt names is the trimmed spelling.
    const out = identityPrompt(1, "@@Neo", "@@Lead", [], "/ws/", "teams/alpha/");
    expect(out).toContain(
      "Read the team process at /ws/teams/alpha/bootstrap.md before you start.",
    );
    expect(out).toContain("Relative paths in that document resolve against /ws.");
  });

  test("a bare filesystem root keeps its one separator", () => {
    const out = identityPrompt(1, "@@Neo", "@@Lead", [], "/", "t");
    expect(out).toContain("Read the team process at /t/bootstrap.md before you start.");
    expect(out).toContain("Relative paths in that document resolve against /.");
  });

  test("names the team dir as the server trims it before writing", () => {
    // The dialog sends the team dir as typed and the server trims it before
    // it creates the directory, so a pasted `berries ` lands in `berries/`;
    // the poke has to name that directory, not one that does not exist.
    const out = identityPrompt(1, "@@Neo", "@@Lead", [], "/ws", "berries ");
    expect(out).toContain("Read the team process at /ws/berries/bootstrap.md before you start.");
  });
});
