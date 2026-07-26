// Raw-source assertions on the Hybrid Nav keymap in App.svelte.
// The dispatcher is hard to mount in isolation, so the source is read
// directly. Pins the arrow = move-focus and WASD = swap arrangement.

import { describe, expect, test } from "vitest";
import app from "../App.svelte?raw";

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
}

describe("Hybrid Nav keymap (inversion)", () => {
  test("arrow keys move focus", () => {
    expect(app).toContain('case "ArrowUp":\n        paneModeMoveFocus("up");');
    expect(app).toContain('case "ArrowLeft":\n        paneModeMoveFocus("left");');
    expect(app).toContain('case "ArrowDown":\n        paneModeMoveFocus("down");');
    expect(app).toContain('case "ArrowRight":\n        paneModeMoveFocus("right");');
  });

  test("WASD swaps tiles (lowercase + uppercase, including 's')", () => {
    expect(app).toContain('case "w":\n      case "W":\n        paneModeSwap("up");');
    expect(app).toContain('case "a":\n      case "A":\n        paneModeSwap("left");');
    expect(app).toContain('case "d":\n      case "D":\n        paneModeSwap("right");');
    // `s` rejoins WASD; Search moved to `f`.
    expect(app).toContain('case "s":\n      case "S":\n        paneModeSwap("down");');
  });
});

// Hybrid Nav spawn cases: numeric 1/2/3/4 are gone. App keys stage into the
// draft layout: t/o/g/b/n/i, while Tab flips the draft pane side without
// committing.
describe("Hybrid Nav keymap (transactional staging)", () => {
  test("h toggles the Hybrid Nav help overlay without committing", () => {
    expect(app).toContain(
      'case "h":\n      case "H":\n        paneModeHelpVisible = !paneModeHelpVisible;',
    );
  });

  test("numeric 1 / 2 / 3 / 4 cases stay gone", () => {
    expect(app).not.toMatch(/case "1": \{[\s\S]{0,60}paneModeStageSpawn/);
    expect(app).not.toMatch(/case "2": \{[\s\S]{0,60}paneModeStageSpawn/);
    expect(app).not.toMatch(/case "3": \{[\s\S]{0,60}paneModeStageSpawn/);
    expect(app).not.toMatch(/case "4": \{[\s\S]{0,60}fileOps\.createFile/);
  });
});

describe("Hybrid Nav transactional staging", () => {
  test("Tab flips the draft pane side without committing", () => {
    expect(app).toMatch(
      /case "Tab":\s*\n\s*if \(paneMode\.draft\) flipHybrid\(paneMode\.draft\.activePaneId\);\s*\n\s*return;/,
    );
    expect(app).not.toMatch(/case "Tab":[\s\S]{0,160}commitPaneMode\(\);/);
  });

  test("t / T stages a terminal write into the draft (no immediate commit)", () => {
    expect(app).toMatch(
      /case "t":\s*\n\s*case "T":\s*\n?\s*paneModeOpenTerminal\(resolveSpawnContext\(\)\);\s*\n\s*return;/,
    );
    // No commitPaneMode inside the t/T branch.
    expect(app).not.toMatch(
      /case "t":\s*\n\s*case "T":\s*\n?\s*paneModeOpenTerminal\(resolveSpawnContext\(\)\);\s*\n\s*commitPaneMode/,
    );
  });

  test("o / g / b stage workspace app tabs into the draft", () => {
    expect(app).toMatch(
      /case "o":\s*\n\s*case "O":\s*\n\s*if \(ui\.terminalOnly\) return;\s*\n\s*paneModeOpenBrowser\(resolveSpawnContext\(\)\);\s*\n\s*return;/,
    );
    expect(app).toMatch(
      /case "g":\s*\n\s*case "G":\s*\n\s*if \(ui\.terminalOnly\) return;\s*\n\s*paneModeOpenGraph\(resolveSpawnContext\(\)\);\s*\n\s*return;/,
    );
    expect(app).toMatch(
      /case "b":\s*\n\s*case "B":\s*\n\s*if \(ui\.terminalOnly\) return;\s*\n\s*paneModeOpenDashboard\(\);\s*\n\s*return;/,
    );
  });

  test("n / i stage draft and diagram editors without committing", () => {
    expect(app).toMatch(
      /case "n":\s*\n\s*case "N":\s*\n\s*if \(ui\.terminalOnly\) return;\s*\n\s*paneModeStageDraftEditor\(\);\s*\n\s*return;/,
    );
    expect(app).toMatch(
      /case "i":\s*\n\s*case "I":\s*\n\s*if \(ui\.terminalOnly\) return;\s*\n\s*paneModeStageDiagramEditor\(\);\s*\n\s*return;/,
    );
  });

  test("p / P no longer stages a Team Work terminal (decoupled to lead-only)", () => {
    // The pane-mode P binding that spawned a bare Team Work bubble terminal on
    // an arbitrary pane was removed: the bubble renders only on a team LEAD
    // terminal via the Cmd+P workflow, so pane mode no longer references the
    // removed spawn.
    expect(app).not.toMatch(/paneModeOpenTeamWorkTerminal/);
  });

  test("Enter materializes staged draft editors before commit", () => {
    expect(app).toMatch(
      /case "Enter": \{[\s\S]*?materializeStagedDraftEditors\(\);[\s\S]*?commitPaneMode\(\);/,
    );
  });

  test("Escape cancels without materializing staged draft editors", () => {
    expect(app).toMatch(
      /case "Escape":[\s\S]{0,800}cancelPaneMode\(\);/,
    );
    // The Escape branch must not call materializeStagedDraftEditors.
    expect(app).not.toMatch(
      /case "Escape":[\s\S]{0,400}materializeStagedDraftEditors\(\);[\s\S]{0,400}cancelPaneMode\(\);/,
    );
  });
});

describe("New terminal web chord + the chan:command bridge", () => {
  test("Ctrl+Shift+T (web) routes through the context-aware spawn helper", () => {
    // The no-defaults round moved New terminal's web chord to the literal
    // Ctrl+Shift+T (every browser OS); it still routes through
    // spawnTerminalFromContext so resolveSpawnContext().dir threads as cwd.
    expect(app).toMatch(
      /e\.ctrlKey && e\.shiftKey && !e\.metaKey && !e\.altKey && e\.code === "KeyT"[\s\S]*?spawnTerminalFromContext\(\)/,
    );
  });

  test("chan:command bridge routes through context-aware helpers", () => {
    // chan-desktop's KEY_BRIDGE_JS fires these commands on native
    // Cmd+T / Cmd+O / Cmd+P / Cmd+Shift+M; they route through the same
    // helpers as the web chords.
    expect(app).toMatch(
      /case "app\.terminal\.toggle":\s*\n\s*spawnTerminalFromContext\(\);/,
    );
    expect(app).toMatch(
      /case "app\.files\.toggle":\s*\n\s*spawnBrowserFromContext\(\);/,
    );
    expect(app).toMatch(
      /case "app\.terminal\.teamWork":\s*\n\s*spawnTeamWorkFromContext\(\);/,
    );
    expect(app).toMatch(
      /case "app\.graph\.toggle":\s*\n\s*spawnGraphFromContext\(\);/,
    );
  });
});

describe("Hybrid Nav Team Work binding", () => {
  test("Hybrid Nav has no P Team Work binding (lead-only via the Cmd+P dialog)", () => {
    // The Hybrid Nav P binding that spawned a bare Team Work bubble terminal
    // was removed when the bubble was decoupled from arbitrary terminals. Team
    // Work is now reached ONLY through the top-level Cmd+P / Cmd+Alt+P dialog
    // (spawnTeamWorkFromContext); pane mode never spawns the bubble.
    expect(app).not.toMatch(/paneModeOpenTeamWorkTerminal/);
  });

  test("top-level Cmd+P flow creates a Team Work lead terminal then opens the dialog", () => {
    // The lead terminal is created first (createTeamWorkLeadTerminal),
    // then the Spawn-agents dialog is opened over it. The old
    // showOrSpawnTeamWorkInFocusedPane helper is gone.
    expect(app).toMatch(/import \{[\s\S]{1,4000}createTeamWorkLeadTerminal,/);
    expect(app).toMatch(
      /function spawnTeamWorkFromContext\(\): void \{[\s\S]*?createTeamWorkLeadTerminal\(\{ cwd: ctx\.dir \}\);[\s\S]*?openTeamDialog\(\{ leadTabId: lead\.id, leadPaneId: activePane\(\)\.id \}\);/,
    );
    expect(app).not.toMatch(/showOrSpawnTeamWorkInFocusedPane/);
  });
});

describe("Hybrid Nav kill-pane removed", () => {
  test("pane mode no longer binds Backspace (or k) to kill-pane", () => {
    // The no-defaults round dropped the Hybrid Nav kill-pane binding; kill-pane
    // is reachable via the app.pane.kill command (asserted above). Neither the
    // Backspace case nor the old k / K case remains in the pane-mode switch.
    expect(app).not.toMatch(/case "Backspace":[\s\S]{0,80}killActivePane\(\);/);
    expect(app).not.toMatch(
      /case "k":\s*\n\s*case "K":[\s\S]{0,80}killActivePane\(\);/,
    );
  });
});

describe("Track C pane shortcut wiring", () => {
  // Web pane nav uses Alt+[/] because Cmd+[/] is browser back/forward.
  // Desktop-native keeps Cmd+[/] via KEY_BRIDGE_JS.
  test("Alt+[ and Alt+] dispatch previous/next pane on web", () => {
    expect(app).toMatch(
      /e\.altKey && !e\.shiftKey && !meta && e\.code === "BracketLeft"[\s\S]*?selectPrevPane\(\);/,
    );
    expect(app).toMatch(
      /e\.altKey && !e\.shiftKey && !meta && e\.code === "BracketRight"[\s\S]*?selectNextPane\(\);/,
    );
  });

  test("close-all and kill-pane command ids route through transactional helpers", () => {
    expect(app).toMatch(
      /case "app\.pane\.closeTabs":[\s\S]*?closeTabsInActivePane\(\);/,
    );
    expect(app).toMatch(
      /case "app\.pane\.kill":[\s\S]*?killActivePane\(\);/,
    );
    expect(app).toMatch(
      /function closeTabsInActivePane\(\): void \{[\s\S]*?closeTabsInPane\(paneId\)\.then\(\(closed\) => \{[\s\S]*?if \(closed\) scheduleSessionSave\(\);/,
    );
    expect(app).toMatch(
      /function killActivePane\(opts\?: \{ force\?: boolean \}\): void \{[\s\S]*?closePane\(paneId, opts\)\.then\(\(closed\) => \{[\s\S]*?if \(closed\) scheduleSessionSave\(\);/,
    );
  });

  test("empty-pane close is wired through Ctrl+D, app.tab.close, and app.window.close", () => {
    expect(app).toMatch(
      /if \(!active\) \{[\s\S]*?if \(closeActiveEmptyPane\(\)\) \{[\s\S]*?e\.preventDefault\(\);[\s\S]*?e\.stopPropagation\(\);/,
    );
    expect(app).toMatch(
      /case "app\.tab\.close": \{[\s\S]*?else closeActiveEmptyPane\(\);/,
    );
    expect(app).toMatch(
      /case "app\.window\.close":[\s\S]*?if \(closeActiveEmptyPane\(\)\) return;[\s\S]*?discardWindowSession\(\);/,
    );
  });

  test("empty visible side flips to hidden tabs, flashes the A/B button, and blocks close", () => {
    const closeActiveEmptyPane = sourceBetween(
      "function closeActiveEmptyPane(): boolean",
      "// Terminal-only windows never sit empty",
    );
    expect(closeActiveEmptyPane).toMatch(
      /function closeActiveEmptyPane\(\): boolean \{[\s\S]*?if \(paneTabs\(p\)\.length !== 0\) return false;[\s\S]*?if \(allPaneTabs\(p\)\.length !== 0\) \{[\s\S]*?requestPaneSideToggleFlash\(p\.id\);[\s\S]*?flipHybrid\(p\.id\);[\s\S]*?return true;/,
    );
  });
});

describe("Hybrid Nav dock toggles", () => {
  test("< toggles the right-side file browser dock", () => {
    expect(app).toMatch(
      /case "<":[\s\S]*?commitPaneMode\(\);[\s\S]*?toggleBrowserSidePane\("right"\);/,
    );
  });

  test("> toggles the left-side file browser dock", () => {
    expect(app).toMatch(
      /case ">":[\s\S]*?commitPaneMode\(\);[\s\S]*?toggleBrowserSidePane\("left"\);/,
    );
  });
});

describe("Pane Mode entry flash removed", () => {
  test("no centre-window 'H for help' flash on Pane Mode entry", () => {
    // The status-bar Hybrid pill and PaneModeHelp cover discovery;
    // the centre-window flash is removed as visual noise.
    expect(app).not.toContain("pane-mode-flash");
    expect(app).not.toContain("paneModeFlashVisible");
    expect(app).not.toContain("paneModeFlashKey");
    expect(app).not.toContain("PANE_MODE_FLASH_MS");
  });
});
