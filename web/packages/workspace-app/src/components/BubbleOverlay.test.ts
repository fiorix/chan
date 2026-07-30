// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import BubbleOverlay from "./BubbleOverlay.svelte";
import { surveyState } from "../state/survey.svelte";
import { tabFocusPulse } from "../state/tabs.svelte";
import type { SurveySpec } from "../api/client";

// The survey overlay renders ONE slot's survey (per-terminal): a markdown
// body, numbered options, plus a standard [F] follow-up + Dismiss.
// `tabId` null = window-wide
// fallback (centered modal); a tab id = per-terminal (anchored, `.per-terminal`
// class). Renders nothing when that slot has no survey. Render assertions only
// (no clicks, so no /api/survey/reply network).

const mounted: Array<Record<string, any>> = [];

function spec(over: Partial<SurveySpec> = {}): SurveySpec {
  return {
    surveyId: "survey-1",
    title: null,
    bodyMarkdown: "Pick a backend",
    options: ["BM25", "Semantic"],
    ...over,
  };
}

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  surveyState.byTab = {};
  surveyState.windowWide = null;
  tabFocusPulse.value = 0;
});

describe("survey overlay", () => {
  test("renders nothing when the slot has no survey", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();
    expect(target.querySelector(".survey-overlay")).toBeNull();
  });

  test("renders the body + numbered options for a window-wide survey", async () => {
    surveyState.windowWide = { spec: spec({ title: "Search backend" }), busy: false };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();

    const overlay = target.querySelector(".survey-overlay");
    expect(overlay).not.toBeNull();
    // Window-wide = centered modal, NOT the per-terminal anchored variant.
    expect(overlay?.classList.contains("per-terminal")).toBe(false);
    expect(target.querySelector(".survey-title")?.textContent).toBe("Search backend");
    expect(target.querySelector(".survey-body")?.textContent).toContain("Pick a backend");
    const options = target.querySelectorAll(".survey-option");
    expect(options.length).toBe(2);
    expect(options[0].querySelector(".survey-option-key")?.textContent).toBe("1");
    expect(options[1].querySelector(".survey-option-key")?.textContent).toBe("2");
    expect(options[1].querySelector(".survey-option-label")?.textContent).toBe("Semantic");
  });

  test("takes focus after a terminal's pending refocus", async () => {
    const terminal = document.createElement("textarea");
    const target = document.createElement("div");
    document.body.append(terminal, target);
    terminal.focus();
    surveyState.windowWide = { spec: spec(), busy: false };

    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    queueMicrotask(() => terminal.focus());
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(document.activeElement).toBe(target.querySelector(".survey-card"));
  });

  test("returns focus to the terminal when the survey closes", async () => {
    const terminal = document.createElement("textarea");
    const target = document.createElement("div");
    document.body.append(terminal, target);
    terminal.focus();
    surveyState.windowWide = { spec: spec(), busy: false };

    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(document.activeElement).toBe(target.querySelector(".survey-card"));

    surveyState.windowWide = null;
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(document.activeElement).toBe(terminal);
  });

  test("a hidden terminal survey leaves the visible tab's focus alone", async () => {
    const visibleTerminal = document.createElement("textarea");
    const hiddenTerminal = document.createElement("div");
    hiddenTerminal.className = "terminal-tab";
    const target = document.createElement("div");
    hiddenTerminal.append(target);
    document.body.append(visibleTerminal, hiddenTerminal);
    visibleTerminal.focus();
    surveyState.byTab = { t1: { spec: spec(), busy: false } };

    mounted.push(
      mount(BubbleOverlay, {
        target,
        props: { tabId: "t1", shown: false },
      }),
    );
    await tick();
    tabFocusPulse.value += 1;
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(target.querySelector(".survey-card")).toBeNull();
    expect(document.activeElement).toBe(visibleTerminal);
  });

  test("a tab-focus pulse re-grabs the card without replacing its return target", async () => {
    const owner = document.createElement("div");
    owner.className = "terminal-tab";
    const terminal = document.createElement("textarea");
    const target = document.createElement("div");
    owner.append(terminal, target);
    const other = document.createElement("textarea");
    document.body.append(owner, other);
    terminal.focus();
    surveyState.byTab = { t1: { spec: spec(), busy: false } };

    mounted.push(
      mount(BubbleOverlay, {
        target,
        props: { tabId: "t1", shown: true },
      }),
    );
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const card = target.querySelector(".survey-card");
    expect(document.activeElement).toBe(card);

    other.focus();
    tabFocusPulse.value += 1;
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(document.activeElement).toBe(card);

    surveyState.byTab = {};
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(document.activeElement).toBe(terminal);
  });

  test("a survey first shown from a hidden tab restores its owning terminal", async () => {
    const owner = document.createElement("div");
    owner.className = "terminal-tab";
    const terminal = document.createElement("textarea");
    const target = document.createElement("div");
    owner.append(terminal, target);
    const previousTab = document.createElement("textarea");
    document.body.append(owner, previousTab);
    previousTab.focus();
    surveyState.byTab = { t1: { spec: spec(), busy: false } };

    mounted.push(
      mount(BubbleOverlay, {
        target,
        props: {
          tabId: "t1",
          shown: true,
          restoreFocus: () => terminal.focus(),
        },
      }),
    );
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(document.activeElement).toBe(target.querySelector(".survey-card"));

    surveyState.byTab = {};
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(document.activeElement).toBe(terminal);
  });

  test("a per-terminal survey renders anchored (.per-terminal) for its tab only", async () => {
    surveyState.byTab = { t1: { spec: spec({ title: "On t1" }), busy: false } };
    const target = document.createElement("div");
    document.body.append(target);
    // The overlay for t1 shows its survey, anchored.
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: "t1" } }));
    // A second overlay for t2 (no survey) renders nothing.
    const other = document.createElement("div");
    document.body.append(other);
    mounted.push(mount(BubbleOverlay, { target: other, props: { tabId: "t2" } }));
    await tick();

    const t1 = target.querySelector(".survey-overlay");
    expect(t1).not.toBeNull();
    expect(t1?.classList.contains("per-terminal")).toBe(true);
    expect(target.querySelector(".survey-title")?.textContent).toBe("On t1");
    // t2 has no survey -> nothing.
    expect(other.querySelector(".survey-overlay")).toBeNull();
  });

  // F (follow up) + Dismiss are STANDARD on every survey, not an opt-in.
  test("[F] follow-up + Dismiss render on every survey", async () => {
    surveyState.windowWide = { spec: spec(), busy: false };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();
    expect(target.querySelector(".survey-followup")).not.toBeNull();
    expect(target.querySelector(".survey-dismiss")).not.toBeNull();
    expect(target.querySelector(".survey-followup")?.textContent).toContain("Follow up");
    expect(target.querySelector(".survey-dismiss")?.textContent).toContain("Dismiss");
  });
});
