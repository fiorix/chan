import { describe, expect, test } from "vitest";
import tabs from "./tabs.svelte.ts?raw";
import pane from "../components/Pane.svelte?raw";

// Hybrid Nav transactional staging. T / O / G / B stage tab additions into the
// draft layout; N / I queue draft-editor materialization. Enter materializes,
// Esc discards. Tests pin the state machine + helper shape.

describe("paneMode state: stagedDraftEditors field", () => {
  test("paneMode singleton carries stagedDraftEditors as an array field", () => {
    expect(tabs).toMatch(
      /stagedDraftEditors: PaneModeStagedDraftEditor\[\];[\s\S]{1,600}stagedDraftEditors: \[\],/,
    );
  });

  test("enterPaneMode resets stagedDraftEditors to []", () => {
    expect(tabs).toMatch(
      /export function enterPaneMode\(\): void \{[\s\S]{1,800}paneMode\.stagedDraftEditors = \[\];/,
    );
  });

  test("commitPaneMode clears stagedDraftEditors as part of teardown", () => {
    expect(tabs).toMatch(
      /export function commitPaneMode\(\): void \{[\s\S]{1,1800}paneMode\.stagedDraftEditors = \[\];\s*notifyPaneModeSettled\(\);\s*\}/,
    );
  });

  test("cancelPaneMode clears stagedDraftEditors as part of teardown", () => {
    expect(tabs).toMatch(
      /export function cancelPaneMode\(\): void \{[\s\S]{1,900}paneMode\.stagedDraftEditors = \[\];\s*notifyPaneModeSettled\(pendingRemoteLayout\);\s*\}/,
    );
  });
});

describe("paneMode staging: spawn helpers", () => {
  test("there is no pane-mode Team Work bubble spawn", () => {
    // The Team Work bubble renders only on a team LEAD terminal via the
    // Cmd+P workflow; pane mode spawns plain terminals via
    // paneModeOpenTerminal, never a bare bubble terminal.
    expect(tabs).not.toMatch(/export function paneModeOpenTeamWorkTerminal\b/);
  });

  test("paneModeStageDraftEditor pushes pane id, side, and kind pinned at press time", () => {
    expect(tabs).toMatch(
      /export function paneModeStageDraftEditor\(kind: PaneModeDraftEditorKind = "draft"\): void \{[\s\S]{1,260}const paneId = paneMode\.draft\.activePaneId;[\s\S]{1,180}const node = leafPaneFrom\(paneMode\.draft, paneId\);[\s\S]{1,260}paneMode\.stagedDraftEditors\.push\(\{\s*id: id\("staged-editor"\),\s*paneId,\s*side: node \? paneSide\(node\) : "a",\s*kind,/,
    );
  });

  test("paneModeStageDiagramEditor stages a diagram editor intent", () => {
    expect(tabs).toMatch(
      /export function paneModeStageDiagramEditor\(\): void \{\s*paneModeStageDraftEditor\("diagram"\);\s*\}/,
    );
  });

  test("paneModeStagedTabIds derives the staged set by diffing draft against live", () => {
    expect(tabs).toMatch(
      /export function paneModeStagedTabIds\(\): Set<string> \{[\s\S]{1,400}if \(!paneMode\.active \|\| !paneMode\.draft\) return new Set\(\);[\s\S]{1,2000}return staged;/,
    );
  });
});

describe("paneMode staging: ghost-tab rendering in Pane.svelte", () => {
  test("Pane imports paneModeStagedTabIds + derives a Set", () => {
    expect(pane).toMatch(/paneModeStagedTabIds,/);
    expect(pane).toMatch(
      /const paneModeStagedSet = \$derived\(paneModeStagedTabIds\(\)\);/,
    );
  });

  test("tab DOM carries class:staged bound to the derived set", () => {
    expect(pane).toMatch(/class:staged=\{paneModeStagedSet\.has\(t\.id\)\}/);
  });

  test("CSS defines a dimmed dashed-border .tab.staged style", () => {
    expect(pane).toMatch(
      /\.tab\.staged \{[\s\S]{1,400}opacity: 0\.65;[\s\S]{1,200}border: 1px dashed/,
    );
  });
});

describe("paneMode staging: Esc kills staged terminal sessions", () => {
  // Staged panes RENDER, so a staged terminal mounts and spawns a real
  // PTY; dropping the draft on Esc would otherwise orphan that shell
  // in the registry until idle-prune. Cancel must run the
  // staged terminals' close sinks (the closeTab kill path) BEFORE the
  // draft stops rendering, while the sinks are still mounted.
  test("cancelPaneMode kills draft-only terminals first", () => {
    expect(tabs).toMatch(
      /export function cancelPaneMode\(\): void \{\s*killStagedTerminalSessions\(\);/,
    );
  });

  test("the kill targets exactly the staged set via the close sinks", () => {
    expect(tabs).toMatch(
      /function killStagedTerminalSessions\(\): void \{[\s\S]{1,1400}paneModeStagedTabIds\(\);[\s\S]{1,800}runTerminalCloseSink\(t\);/,
    );
  });
});
