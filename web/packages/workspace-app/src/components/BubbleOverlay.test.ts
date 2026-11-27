// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import BubbleOverlay from "./BubbleOverlay.svelte";
import { api } from "../api/client";
import { surveyState } from "../state/survey.svelte";
import { activeTabInPane, layout, setActivePane, tabFocusPulse, type LeafNode } from "../state/tabs.svelte";
import { press, release } from "../__tests__/pressFocus";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import type { SurveySpec } from "../api/client";

// The survey overlay renders ONE slot's survey (per-terminal): a markdown
// body, numbered options, plus a standard [F] follow-up + Dismiss.
// `tabId` null = window-wide
// fallback (centered modal); a tab id = per-terminal (anchored, `.per-terminal`
// class). Renders nothing when that slot has no survey. Render assertions only
// (no clicks, so no /api/survey/reply network).

const mounted: Array<Record<string, any>> = [];

beforeEach(() => {
  resetLayout([terminalTab({ id: "t1" })]);
});

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
  vi.restoreAllMocks();
});

describe("a survey's pane owns its keyboard", () => {
  async function twoPanes({ captured = true } = {}) {
    const ownerPane = layout.activePaneId;
    layout.nodes.other = { kind: "leaf", id: "other", tabs: [terminalTab({ id: "t2" })], activeTabId: "t2" };
    const owner = document.createElement("div");
    owner.className = "terminal-tab";
    const terminal = document.createElement("textarea");
    const target = document.createElement("div");
    const other = document.createElement("textarea");
    owner.append(terminal, target);
    document.body.append(owner, other);
    (captured ? terminal : other).focus();
    const restoreFocus = vi.fn(() => terminal.focus());
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: "t1", restoreFocus } }));
    await tick();
    return { ownerPane, owner, target, terminal, other, restoreFocus };
  }

  function show() {
    surveyState.byTab = { t1: { spec: spec(), busy: false } };
  }

  test.each([true, false])("closing remotely in another pane does not restore focus (captured=%s)", async (captured) => {
    const { target, other, restoreFocus } = await twoPanes({ captured });
    show();
    await tick();
    expect(document.activeElement).toBe(target.querySelector(".survey-card"));
    setActivePane("other");
    other.focus();
    await tick();
    surveyState.byTab = {};
    await tick();
    expect(document.activeElement).toBe(other);
    expect(restoreFocus).not.toHaveBeenCalled();
  });

  test.each(["appear", "close"])("a queued %s respects a focus move before its microtask", async (operation) => {
    const { target, other, restoreFocus } = await twoPanes();
    if (operation === "close") {
      show();
      await tick();
      expect(document.activeElement).toBe(target.querySelector(".survey-card"));
    }
    flushSync(() => {
      if (operation === "appear") show();
      else surveyState.byTab = {};
    });
    setActivePane("other");
    other.focus();
    await tick();
    expect(document.activeElement).toBe(other);
    expect(restoreFocus).not.toHaveBeenCalled();
  });

  test("returning to the survey pane and relocating it both reclaim its card", async () => {
    const { target, owner, ownerPane, other } = await twoPanes();
    show();
    await tick();
    const card = target.querySelector<HTMLElement>(".survey-card")!;
    expect(document.activeElement).toBe(card);
    setActivePane("other");
    other.focus();
    await tick();
    expect(document.activeElement).toBe(other);
    setActivePane(ownerPane);
    await tick();
    expect(document.activeElement).toBe(card);

    owner.remove();
    document.body.append(owner);
    expect(document.activeElement).not.toBe(card);
    const source = layout.nodes[ownerPane] as LeafNode;
    const destination = layout.nodes.other as LeafNode;
    destination.tabs.push(source.tabs[0]);
    source.tabs = [];
    source.activeTabId = null;
    destination.activeTabId = "t1";
    setActivePane("other");
    await tick();
    expect(document.activeElement).toBe(card);
  });

  test("the visible side and active tab determine whether the survey takes focus", async () => {
    const { target, ownerPane, other } = await twoPanes();
    const pane = layout.nodes[ownerPane] as LeafNode;
    pane.bTabs = [terminalTab({ id: "t2" })];
    pane.bActiveTabId = "t2";
    pane.side = "b";
    other.focus();
    show();
    await tick();
    expect(document.activeElement).toBe(other);
    pane.side = "a";
    await tick();
    expect(document.activeElement).toBe(target.querySelector(".survey-card"));
    pane.activeTabId = "missing";
    other.focus();
    tabFocusPulse.value += 1;
    await tick();
    expect(document.activeElement).toBe(other);
  });

  test("an unfocused survey still accepts a pointer answer", async () => {
    const { target, other } = await twoPanes();
    setActivePane("other");
    other.focus();
    show();
    await tick();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    target.querySelector<HTMLButtonElement>(".survey-option")!.click();
    await tick();
    expect(reply).toHaveBeenCalledWith({ surveyId: "survey-1", kind: "option", optionIndex: 0, optionLabel: "BM25" });
    expect(document.activeElement).toBe(other);
  });
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

  test("window-wide selected survey text keeps the browser's copy chord", async () => {
    surveyState.windowWide = { spec: spec({ bodyMarkdown: "Copy the window survey" }), busy: false };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();
    const card = target.querySelector<HTMLElement>(".survey-card")!;
    const range = document.createRange();
    range.selectNodeContents(card.querySelector(".survey-body")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    card.focus();
    const event = new KeyboardEvent("keydown", { key: "c", code: "KeyC", metaKey: true, bubbles: true, cancelable: true });
    card.dispatchEvent(event);
    expect(selection.toString().trim()).toBe("Copy the window survey");
    expect(event.defaultPrevented).toBe(false);
    selection.removeAllRanges();
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

  // The window-wide overlay covers the window around the card, so a press
  // anywhere outside the card lands on the overlay itself.
  test("a press on a window-wide survey's overlay beside its card leaves the keyboard on the card", async () => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    surveyState.windowWide = { spec: spec(), busy: false };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const card = target.querySelector<HTMLElement>(".survey-card")!;
    expect(document.activeElement, "the card takes the keyboard as it shows").toBe(card);

    const overlay = target.querySelector<HTMLElement>(".survey-overlay")!;
    await press(overlay);
    release(overlay);
    await tick();
    expect(document.activeElement, "the keyboard stays on the card").toBe(card);

    const event = new KeyboardEvent("keydown", { key: "1", code: "Digit1", bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply).toHaveBeenCalledWith({ surveyId: "survey-1", kind: "option", optionIndex: 0, optionLabel: "BM25" });
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

describe("the survey card's keys", () => {
  test.each([
    ["1", "option", 0],
    ["F", "followup", undefined],
    ["X", "dismissed", undefined],
    ["Escape", "dismissed", undefined],
  ])("%s answers the per-terminal survey as %s", async (key, kind, optionIndex) => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    surveyState.byTab = { t1: { spec: spec(), busy: false } };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: "t1" } }));
    await tick();
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    target.querySelector(".survey-card")!.dispatchEvent(event);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ surveyId: "survey-1", kind, ...(optionIndex === undefined ? {} : { optionIndex }) }));
    expect(event.defaultPrevented).toBe(true);
  });

  // A window-wide survey is no pane's: whatever the focused pane shows,
  // everything in its card stays in the Tab order, its body's link and its
  // buttons alike, and its card answers its keys.
  test.each([
    ["1", "option", 0],
    ["F", "followup", undefined],
    ["X", "dismissed", undefined],
  ])("%s answers a window-wide survey over a focused pane showing no terminal, as %s", async (key, kind, optionIndex) => {
    resetLayout([{ kind: "dashboard", id: "dashboard-1", title: "Dashboard", autoRotate: false }]);
    expect(activeTabInPane(layout.nodes[layout.activePaneId] as LeafNode)?.kind, "the focused pane shows a dashboard")
      .toBe("dashboard");
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    surveyState.windowWide = {
      spec: spec({ bodyMarkdown: "Pick a backend; [the notes](https://example.com/notes) compare them." }),
      busy: false,
    };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();
    const card = target.querySelector<HTMLElement>(".survey-card")!;
    const tabbable = [...card.querySelectorAll<HTMLElement>("*")].filter((el) => el.tabIndex >= 0);
    expect(tabbable.map((el) => el.localName), "the body's link and every button in the Tab order")
      .toEqual(["a", "button", "button", "button", "button"]);

    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    card.dispatchEvent(event);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ surveyId: "survey-1", kind, ...(optionIndex === undefined ? {} : { optionIndex }) }));
    expect(event.defaultPrevented).toBe(true);
  });

  // The card answers its keys unmodified, as the viewers do: a chord with
  // Ctrl, Cmd or Alt held is the app's and travels on.
  test.each([
    ["Ctrl+X", { key: "x", code: "KeyX", ctrlKey: true }],
    ["Cmd+F", { key: "f", code: "KeyF", metaKey: true }],
    ["Alt+1", { key: "1", code: "Digit1", altKey: true }],
  ])("leave %s to the app", async (_chord, init) => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    surveyState.windowWide = { spec: spec(), busy: false };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();
    const reached = vi.fn();
    document.addEventListener("keydown", reached);

    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.querySelector(".survey-card")!.dispatchEvent(event);
    await tick();
    document.removeEventListener("keydown", reached);

    expect(reply).not.toHaveBeenCalled();
    expect(surveyState.windowWide?.spec.surveyId).toBe("survey-1");
    expect(event.defaultPrevented).toBe(false);
    expect(reached).toHaveBeenCalledTimes(1);
  });
});
