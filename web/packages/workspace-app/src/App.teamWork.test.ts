import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";
import terminal from "../components/TerminalTab.svelte?raw";
import shortcuts from "./shortcuts.ts?raw";

// The legacy `Alt+Space` team-work chord is removed. Cmd+P (native),
// Cmd+Alt+P (web Mac), and `Mod+. p` (Hybrid Nav) cover every entry
// point.

describe("Alt+Space chord removed from App.svelte", () => {
  test("no `altKey + Space` keymap branch for team-work spawn", () => {
    expect(app).not.toMatch(
      /if \(e\.altKey && !meta && !e\.shiftKey && e\.code === "Space"\) \{[\s\S]*?spawnTeamWorkFromContext\(\);/,
    );
  });

  test("keymap header doc-block no longer advertises Alt+Space", () => {
    expect(app).not.toMatch(/Alt\+Space\s+->\s+Team Work/);
  });
});

describe("Alt+Space chord removed from TerminalTab.svelte", () => {
  test("no secondary `altKey + Space` handler firing `openTeamWork`", () => {
    expect(terminal).not.toMatch(
      /if \(e\.altKey && !e\.ctrlKey && !e\.metaKey && !e\.shiftKey && e\.code === "Space"\) \{[\s\S]*?openTeamWork\(\);/,
    );
  });

  test("team-work entry-point comment present (no Alt+Space)", () => {
    expect(terminal).toMatch(
      /Team-work entry points are Cmd\+P[\s\S]*?Mod\+\. p/i,
    );
    expect(terminal).not.toMatch(/Alt\+Space/);
  });

  test("hamburger-menu comment no longer references Alt+Space as live", () => {
    expect(terminal).not.toMatch(/Alt\+Space still works as the/i);
  });
});

describe("shortcuts registry note updated for Alt+Space removal", () => {
  test("registry note no longer mentions Alt+Space", () => {
    expect(shortcuts).not.toMatch(/legacy Alt\+Space alias still bound/);
  });
});
