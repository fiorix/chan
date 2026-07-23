// @vitest-environment jsdom
// S-B: a group/window-wide close_survey must NOT force-hide the INDEPENDENT
// Rich Prompt composers on the window's terminals. The composer is a general
// chat box, not the survey's reply surface (surveys reply through
// BubbleOverlay), so closing a survey leaves every open composer untouched.
import { afterEach, describe, expect, test } from "vitest";
import { onWatchEvent } from "./store.svelte";
import { layout, type LeafNode, type TerminalTab } from "./tabs.svelte";
import { richPrompt } from "./richPrompt.svelte";
import { surveyFor, surveyState } from "./survey.svelte";

function twoTerminalLayout(): void {
  const mk = (id: string, draft: string): TerminalTab =>
    ({
      kind: "terminal",
      id,
      title: id,
      createdAt: 1,
      broadcastEnabled: false,
      broadcastTargetIds: [],
      richPromptDraftPath: draft,
    }) as TerminalTab;
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs: [mk("term-1", ".Drafts/d1/draft.md"), mk("term-2", ".Drafts/d2/draft.md")],
    activeTabId: "term-1",
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
}

afterEach(() => {
  richPrompt.byTab = {};
  surveyState.byTab = {};
  surveyState.windowWide = null;
  const pane: LeafNode = { kind: "leaf", id: "reset", tabs: [], activeTabId: null };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
});

describe("S-B: group close_survey does not blast independent composers", () => {
  test("a window-wide close leaves BOTH terminals' composers open", async () => {
    window.history.replaceState(null, "", "/?w=window-a");
    twoTerminalLayout();
    // Both terminals have an INDEPENDENT Rich Prompt composer open, unrelated to
    // any survey.
    richPrompt.byTab["term-1"] = true;
    richPrompt.byTab["term-2"] = true;

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "open_survey",
      survey: {
        surveyId: "survey-group",
        title: null,
        bodyMarkdown: "Group pick",
        options: ["A"],
      },
    } as never);
    await Promise.resolve();
    expect(surveyFor(null)?.surveyId).toBe("survey-group");

    onWatchEvent({
      type: "window_command",
      window_id: "window-a",
      command: "close_survey",
      surveyId: "survey-group",
      reason: "answered_elsewhere",
    } as never);
    await Promise.resolve();

    // The survey overlay closes; neither composer is force-hidden (no over-reach).
    expect(surveyFor(null)).toBeNull();
    expect(richPrompt.byTab["term-1"]).toBe(true);
    expect(richPrompt.byTab["term-2"]).toBe(true);
  });
});
