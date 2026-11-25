// @vitest-environment jsdom
//
// A survey over a terminal whose pane is not the focused one is answered by
// a press only. The whole app is mounted over the demo workspace with a
// terminal in the top pane on the real widget (the shared fixture) and a
// dashboard in the bottom pane, the focused one. A dashboard takes no
// keyboard on a tab-focus pulse, so whatever moves the keyboard off the
// survey's card at a pulse is the card's own release. jsdom runs no Tab
// default, so focus that sequential navigation or assistive technology
// would place on a button is placed by script, as in
// `Pane.browserFocus.test.ts`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../terminal/backend", async (importOriginal) =>
  (await import("../__tests__/ghosttyTab")).ghosttyBackendModule(importOriginal));

import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { seatedGhostty } from "../__tests__/ghosttyTab";
import { terminalTab } from "../__tests__/tabs";
import { api } from "../api/client";
import { resetSurveysForTest, showSurvey, surveyFor } from "../state/survey.svelte";
import { bumpTabFocusPulse, cancelPaneMode, layout, setActivePane } from "../state/tabs.svelte";

stubAppEnvironment();

const TOP = "pane-survey";
const BOTTOM = "pane-dashboard";
const TERMINAL = "term-survey";
const SURVEY = { surveyId: "unfocused-pane", title: "Choose", bodyMarkdown: "Pick one", options: ["A", "B"] };

beforeEach(async () => {
  await mountApp(demoData([]));
});

afterEach(async () => {
  cancelPaneMode();
  resetSurveysForTest();
  await unmountApp();
  vi.restoreAllMocks();
});

async function settleLong(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await settle();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function pane(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`);
  if (!el) throw new Error(`no pane ${id}`);
  return el;
}

/// The terminal above the dashboard, split in a column, with the dashboard's
/// pane focused, and the survey shown over the terminal.
async function surveyOverUnfocusedPane(): Promise<HTMLElement> {
  layout.nodes = {
    root: { kind: "split", id: "root", direction: "column", a: TOP, b: BOTTOM, ratio: 0.5 },
    [TOP]: { kind: "leaf", id: TOP, tabs: [terminalTab({ id: TERMINAL })], activeTabId: TERMINAL },
    [BOTTOM]: {
      kind: "leaf",
      id: BOTTOM,
      tabs: [{ kind: "dashboard", id: "dashboard-keys", title: "Dashboard", autoRotate: false }],
      activeTabId: "dashboard-keys",
    },
  };
  layout.rootId = "root";
  layout.activePaneId = BOTTOM;
  await settleLong();
  await seatedGhostty(pane(TOP));
  expect(pane(BOTTOM).querySelector(".dashboard"), "the focused pane shows the dashboard").not.toBeNull();
  showSurvey(SURVEY, TERMINAL);
  await settleLong();
  const card = pane(TOP).querySelector<HTMLElement>(".survey-card");
  if (!card) throw new Error("no survey card over the top pane's terminal");
  expect(layout.activePaneId, "the survey leaves the focused pane focused").toBe(BOTTOM);
  return card;
}

function buttons(card: HTMLElement): HTMLButtonElement[] {
  return [...card.querySelectorAll<HTMLButtonElement>(".survey-option, .survey-followup, .survey-dismiss")];
}

/// A primary press and release as a browser runs them for a trusted event:
/// each listener's microtasks run before the press's default action, which
/// focuses the pressed element's nearest focusable ancestor.
async function click(el: HTMLElement): Promise<void> {
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(down);
  await settle();
  if (!down.defaultPrevented) el.closest<HTMLElement>("[tabindex], button")?.focus();
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await settleLong();
}

describe("a survey over a terminal whose pane is not focused", () => {
  test("its buttons leave the Tab order until its pane is focused", async () => {
    const card = await surveyOverUnfocusedPane();
    expect(buttons(card), "two options, the follow-up and the dismiss").toHaveLength(4);
    expect(buttons(card).map((b) => b.tabIndex), "out of the Tab order while the other pane is focused")
      .toEqual([-1, -1, -1, -1]);

    setActivePane(TOP);
    await settleLong();
    expect(document.activeElement, "its pane focused, the survey takes the keyboard").toBe(card);
    expect(buttons(card).map((b) => b.tabIndex), "back in the Tab order once its pane is focused")
      .toEqual([0, 0, 0, 0]);

    setActivePane(BOTTOM);
    await settleLong();
    expect(buttons(card).map((b) => b.tabIndex), "out again when the other pane is focused again")
      .toEqual([-1, -1, -1, -1]);
    expect(card.contains(document.activeElement), "the card lets the keyboard go with its pane").toBe(false);
  });

  test.each([
    ["1", "Digit1"],
    ["F", "KeyF"],
    ["X", "KeyX"],
    ["Escape", "Escape"],
  ])("%s at its card answers nothing and travels on", async (key, code) => {
    const card = await surveyOverUnfocusedPane();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const option = card.querySelector<HTMLButtonElement>(".survey-option")!;
    option.focus();
    expect(document.activeElement, "focus placed on the option by script").toBe(option);

    const reached: boolean[] = [];
    const onDocumentKey = (e: KeyboardEvent) => reached.push(e.defaultPrevented);
    document.addEventListener("keydown", onDocumentKey);
    option.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
    document.removeEventListener("keydown", onDocumentKey);
    await settleLong();

    expect(reply, "a key at an unfocused pane's card must not answer its survey").not.toHaveBeenCalled();
    expect(surveyFor(TERMINAL)?.surveyId).toBe(SURVEY.surveyId);
    expect(reached, "the key travels on past the card, its default left alone").toEqual([false]);
    expect(layout.activePaneId).toBe(BOTTOM);
  });

  test("the next pulse takes the keyboard off its card, however the keyboard reached it", async () => {
    const card = await surveyOverUnfocusedPane();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const option = card.querySelector<HTMLButtonElement>(".survey-option")!;
    option.focus();
    expect(document.activeElement, "focus placed on the option by script").toBe(option);

    bumpTabFocusPulse();
    await settleLong();
    expect(card.contains(document.activeElement), "the next pulse takes the keyboard off the card").toBe(false);
    expect(layout.activePaneId).toBe(BOTTOM);
    expect(surveyFor(TERMINAL)?.surveyId, "the survey stays up, unanswered").toBe(SURVEY.surveyId);
    expect(reply).not.toHaveBeenCalled();
  });

  test("a click on an option answers it and makes its pane the focused one", async () => {
    const card = await surveyOverUnfocusedPane();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    await click(card.querySelector<HTMLButtonElement>(".survey-option")!);
    expect(reply).toHaveBeenCalledWith({ surveyId: SURVEY.surveyId, kind: "option", optionIndex: 0, optionLabel: "A" });
    expect(layout.activePaneId, "the press makes the survey's pane the focused one").toBe(TOP);
  });
});
