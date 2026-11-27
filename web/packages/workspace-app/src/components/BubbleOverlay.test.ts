// @vitest-environment jsdom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import BubbleOverlay from "./BubbleOverlay.svelte";
import { api } from "../api/client";
import { LAUNCHER_SHOWN_ATTR } from "../state/keyboardOwner.svelte";
import { overlayStack, promptState, setCoverBlocking } from "../state/store.svelte";
import { surveyState } from "../state/survey.svelte";
import { activeTabInPane, layout, setActivePane, tabFocusPulse, type LeafNode } from "../state/tabs.svelte";
import { press, release } from "../__tests__/pressFocus";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import type { SurveySpec } from "../api/client";

// A workspace window's capabilities, which a case narrows to a window with
// no workspace (a terminal or control window) and the next case restores.
const caps = vi.hoisted(() => ({ workspace: true, files: true, drafts: true, terminal: true }));
vi.mock("../state/windowCaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/windowCaps")>()),
  windowCaps: caps,
}));

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
  Object.assign(caps, { workspace: true, files: true, drafts: true, terminal: true });
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

  test("a press on a window-wide survey's overlay beside its card gives the keyboard at large to the card", async () => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    surveyState.windowWide = { spec: spec(), busy: false };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: null } }));
    await tick();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const card = target.querySelector<HTMLElement>(".survey-card")!;
    expect(document.activeElement, "the card takes the keyboard as it shows").toBe(card);
    card.blur();
    expect(document.activeElement, "the keyboard at large, put there by script").toBe(document.body);

    const overlay = target.querySelector<HTMLElement>(".survey-overlay")!;
    await press(overlay);
    release(overlay);
    await tick();
    expect(document.activeElement, "the card takes the keyboard").toBe(card);

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

// A link in a survey's body follows the editor's model: a plain click shows
// the editor's drop-down under the link, its OPEN row and the href as
// written, which Enter or a press on the row opens; Cmd or Ctrl with a
// click opens at once. The click itself never navigates the app.
describe("a link in a survey's body", () => {
  const URL = "https://chan.app/notes";

  // The owners a case raises over the survey: an overlay, a dialog, the
  // Computers launcher, a cover over the window.
  afterEach(() => {
    overlayStack.ids = [];
    promptState.open = false;
    setCoverBlocking("reconnect", false);
    document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  });

  /// A survey over terminal t1, or the window-wide one with `tabId` null,
  /// whose body is `bodyMarkdown`; returns its card once it holds the
  /// keyboard.
  async function linkedSurvey(bodyMarkdown: string, tabId: string | null = "t1"): Promise<HTMLElement> {
    if (tabId === null) surveyState.windowWide = { spec: spec({ bodyMarkdown }), busy: false };
    else surveyState.byTab = { [tabId]: { spec: spec({ bodyMarkdown }), busy: false } };
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId } }));
    await settle();
    const card = target.querySelector<HTMLElement>(".survey-card")!;
    expect(document.activeElement, "the card takes the keyboard as it shows").toBe(card);
    return card;
  }

  /// Microtasks and one task, so the drop-down's deferred outside-press
  /// rule is installed, as it is by a person's next press.
  async function settle(): Promise<void> {
    await tick();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await tick();
  }

  function bodyLink(card: HTMLElement, index = 0): HTMLElement {
    const link = card.querySelectorAll<HTMLElement>(".survey-body [href], .survey-body a")[index];
    if (!link) throw new Error(`no link ${index} in the survey body`);
    return link;
  }

  /// A press and release on `el` as an engine runs them, the click's
  /// modifiers as given; returns the click.
  async function clickOn(el: Element, mods: MouseEventInit = {}): Promise<MouseEvent> {
    await press(el as HTMLElement);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail: 1, ...mods }));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...mods });
    el.dispatchEvent(click);
    await settle();
    return click;
  }

  /// The drop-downs showing, each as its rows' text: the OPEN tag and the
  /// target as written.
  function dropDowns(): string[][][] {
    return [...document.querySelectorAll(".md-bubble")].map((wrap) =>
      [...wrap.querySelectorAll(".md-bubble-row")].map((row) =>
        [...row.querySelectorAll(":scope > span")].map((span) => span.textContent ?? "")));
  }

  function keyAt(el: Element, key: string, mods: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
    el.dispatchEvent(event);
    return event;
  }

  function opener() {
    return vi.spyOn(window, "open").mockReturnValue(null);
  }

  test("a plain click on an https link is cancelled and shows the drop-down with its OPEN row, opening nothing", async () => {
    const open = opener();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    const click = await clickOn(bodyLink(card));
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(dropDowns(), "one drop-down, its one OPEN row showing the URL").toEqual([[["OPEN", URL]]]);
    expect(document.querySelector(".md-bubble .md-bubble-row .copy-btn"), "the URL's copy button").not.toBeNull();
    expect(open, "the click opens nothing").not.toHaveBeenCalled();
    expect(reply, "a link answers nothing").not.toHaveBeenCalled();
  });

  // Chrome and WebKitGTK focus a pressed link; WebKit for macOS does not,
  // so the keyboard can be on the card instead.
  test.each(["the link", "the card"])("Enter at %s with the drop-down open opens the URL once and closes it", async (at) => {
    const open = opener();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    if (at === "the card") card.focus();
    const enter = keyAt(document.activeElement ?? card, "Enter");
    await settle();
    expect(open, "Enter opens the URL once, as the editor does").toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(URL, "_blank", "noopener,noreferrer");
    expect(enter.defaultPrevented, "the drop-down takes the Enter").toBe(true);
    expect(dropDowns(), "the drop-down closes").toEqual([]);
    expect(reply, "opening a link answers nothing").not.toHaveBeenCalled();
    expect(surveyState.byTab.t1?.spec.surveyId, "the survey stays up").toBe("survey-1");
  });

  test("a press on the drop-down's row opens the URL once and closes it", async () => {
    const open = opener();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    const row = document.querySelector<HTMLElement>(".md-bubble .md-bubble-row");
    expect(row, "the click shows the drop-down's row").not.toBeNull();
    await press(row!);
    release(row!);
    await settle();
    expect(open, "the press opens the URL once").toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(URL, "_blank", "noopener,noreferrer");
    expect(dropDowns(), "the drop-down closes").toEqual([]);
    expect(reply, "opening a link answers nothing").not.toHaveBeenCalled();
    expect(surveyState.byTab.t1?.spec.surveyId, "the survey stays up").toBe("survey-1");
  });

  test.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("%s with a click opens the URL at once, with no drop-down", async (_mod, mods) => {
    const open = opener();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    const click = await clickOn(bodyLink(card), mods);
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(open, "the modified click opens the URL once").toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(URL, "_blank", "noopener,noreferrer");
    expect(dropDowns(), "no drop-down").toEqual([]);
    expect(reply, "opening a link answers nothing").not.toHaveBeenCalled();
  });

  test.each([
    ["Cmd", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ])("%s+Enter opens the URL while the drop-down is open, and travels on while none is", async (_mod, mods) => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    const reached: boolean[] = [];
    const onDocumentKey = (e: KeyboardEvent) => reached.push(e.defaultPrevented);
    document.addEventListener("keydown", onDocumentKey);
    try {
      keyAt(card, "Enter", mods);
      expect(reached, "with no drop-down the chord travels on, its default left alone").toEqual([false]);
      expect(open, "and opens nothing").not.toHaveBeenCalled();

      await clickOn(bodyLink(card));
      expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
      const chord = keyAt(document.activeElement ?? card, "Enter", mods);
      await settle();
      expect(open, "the chord opens the URL once").toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(URL, "_blank", "noopener,noreferrer");
      expect(chord.defaultPrevented, "the drop-down takes the chord").toBe(true);
      expect(reached, "and the chord stops at the card").toHaveLength(1);
      expect(dropDowns(), "the drop-down closes").toEqual([]);
    } finally {
      document.removeEventListener("keydown", onDocumentKey);
    }
  });

  test("a link to a workspace path shows its OPEN row and opens through the editor's path opener, from the workspace root", async () => {
    const open = opener();
    const resolve = vi.spyOn(api, "resolveLink").mockReturnValue(new Promise(() => {}));
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const card = await linkedSurvey("See [a note](notes/a.md) first.");
    const click = await clickOn(bodyLink(card));
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(dropDowns(), "one drop-down, its OPEN row showing the path as written").toEqual([[["OPEN", "notes/a.md"]]]);
    expect(document.querySelector(".md-bubble .copy-btn"), "a path gets no copy button").toBeNull();
    expect(resolve, "the drop-down sends nothing yet").not.toHaveBeenCalled();
    keyAt(document.activeElement ?? card, "Enter");
    await settle();
    expect(resolve, "Enter resolves the path from the workspace root, once").toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("notes/a.md");
    expect(open, "a path is no browser tab").not.toHaveBeenCalled();
    expect(dropDowns(), "the drop-down closes").toEqual([]);
    expect(reply, "opening a link answers nothing").not.toHaveBeenCalled();
  });

  test.each([
    ["plain", {}],
    ["Ctrl", { ctrlKey: true }],
  ])("a %s click on a path that climbs out of the workspace is cancelled, shows nothing and opens nothing", async (_how, mods) => {
    const open = opener();
    const resolve = vi.spyOn(api, "resolveLink").mockReturnValue(new Promise(() => {}));
    const card = await linkedSurvey("See [outside](../x.md) first.");
    const click = await clickOn(bodyLink(card), mods);
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(dropDowns(), "no drop-down").toEqual([]);
    expect(resolve, "no request").not.toHaveBeenCalled();
    expect(open, "no browser tab").not.toHaveBeenCalled();
  });

  test("in a window with no workspace a path link is cancelled and shows nothing, and an https link still shows its row", async () => {
    Object.assign(caps, { workspace: false, files: false, drafts: false });
    const open = opener();
    const resolve = vi.spyOn(api, "resolveLink").mockReturnValue(new Promise(() => {}));
    const card = await linkedSurvey(`See [a note](notes/a.md) and [the notes](${URL}).`);
    const pathClick = await clickOn(bodyLink(card, 0));
    expect(pathClick.defaultPrevented, "the path's click never navigates the app").toBe(true);
    expect(dropDowns(), "the path shows no drop-down").toEqual([]);
    const modClick = await clickOn(bodyLink(card, 0), { ctrlKey: true });
    expect(modClick.defaultPrevented, "nor does its modified click").toBe(true);
    expect(resolve, "and nothing asks for the path").not.toHaveBeenCalled();

    const urlClick = await clickOn(bodyLink(card, 1));
    expect(urlClick.defaultPrevented, "the URL's click never navigates the app").toBe(true);
    expect(dropDowns(), "the URL still shows its OPEN row").toEqual([[["OPEN", URL]]]);
    expect(open, "and opens nothing yet").not.toHaveBeenCalled();
  });

  test.each([
    ["a bare fragment", "[the top](#top)"],
    ["another scheme", "[the archive](ftp://example.com/a)"],
  ])("a click on a link to %s is cancelled and shows nothing", async (_what, markdown) => {
    const open = opener();
    const resolve = vi.spyOn(api, "resolveLink").mockReturnValue(new Promise(() => {}));
    const card = await linkedSurvey(`See ${markdown} first.`);
    for (const mods of [{}, { metaKey: true }]) {
      const click = await clickOn(bodyLink(card), mods);
      expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
      expect(dropDowns(), "no drop-down").toEqual([]);
    }
    expect(resolve, "no request").not.toHaveBeenCalled();
    expect(open, "no browser tab").not.toHaveBeenCalled();
  });

  // Every href carrier the body renders is a link: an SVG link by either
  // spelling, a MathML element with an href, an image map's area.
  test.each([
    ["an SVG link by xlink:href", `<svg width="20" height="20"><a xlink:href="${URL}"><text y="10">s</text></a></svg>`, "text"],
    ["an SVG link by href", `<svg width="20" height="20"><a href="${URL}"><text y="10">s</text></a></svg>`, "text"],
    ["a MathML link", `<math><mi href="${URL}">x</mi></math>`, "mi"],
    ["an image map's area", `<img src="https://example.com/i.png" usemap="#m"><map name="m"><area href="${URL}" shape="rect" coords="0,0,9,9"></map>`, "area"],
  ])("a click on %s is cancelled and shows its OPEN row", async (_what, html, pressed) => {
    const open = opener();
    const card = await linkedSurvey(`A link: ${html}`);
    const at = card.querySelector(`.survey-body ${pressed}`);
    expect(at, "the body renders the link").not.toBeNull();
    const click = await clickOn(at!);
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(dropDowns(), "the drop-down shows its OPEN row").toEqual([[["OPEN", URL]]]);
    expect(open, "and opens nothing yet").not.toHaveBeenCalled();
  });

  test("a middle-button click on a body link is cancelled and opens nothing", async () => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    const aux = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, detail: 1 });
    bodyLink(card).dispatchEvent(aux);
    await settle();
    expect(aux.defaultPrevented, "the middle button never opens a tab past the app's openers").toBe(true);
    expect(open, "nothing opens").not.toHaveBeenCalled();
    expect(dropDowns(), "no drop-down").toEqual([]);
  });

  test("a second click on the link keeps its drop-down, and a click on another link moves it there", async () => {
    const other = "https://chan.app/other";
    const card = await linkedSurvey(`Read [the notes](${URL}) or [the other](${other}).`);
    await clickOn(bodyLink(card, 0));
    expect(dropDowns(), "the first link's drop-down").toEqual([[["OPEN", URL]]]);
    const first = document.querySelector(".md-bubble");
    await clickOn(bodyLink(card, 0));
    expect(dropDowns(), "a second click keeps it").toEqual([[["OPEN", URL]]]);
    expect(document.querySelector(".md-bubble"), "the same drop-down, not one shown again").toBe(first);
    await clickOn(bodyLink(card, 1));
    expect(dropDowns(), "a click on the other link moves it there").toEqual([[["OPEN", other]]]);
  });

  test("Cmd with a click on a link whose drop-down is open opens it once and closes the drop-down", async () => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    await clickOn(bodyLink(card), { metaKey: true });
    expect(open, "the modified click opens the URL once").toHaveBeenCalledTimes(1);
    expect(dropDowns(), "and closes the drop-down").toEqual([]);
  });

  test("Enter while an input method composes leaves the drop-down open and opens nothing", async () => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    keyAt(document.activeElement ?? card, "Enter", { isComposing: true });
    await settle();
    expect(open, "a composing Enter is the input method's").not.toHaveBeenCalled();
    expect(dropDowns(), "the drop-down stays").toEqual([[["OPEN", URL]]]);
  });

  // Focus can reach a body link outside the focused pane (a script,
  // assistive technology), and Enter on it makes the engine's click with no
  // press that would focus the pane first.
  test("a click on a body link while the survey does not own the keyboard is cancelled and shows nothing", async () => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    layout.nodes.other = { kind: "leaf", id: "other", tabs: [terminalTab({ id: "t2" })], activeTabId: "t2" };
    setActivePane("other");
    await settle();
    const link = bodyLink(card);
    link.focus();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 0 });
    link.dispatchEvent(click);
    await settle();
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(dropDowns(), "no drop-down where the survey does not own the keyboard").toEqual([]);
    expect(open, "nothing opens").not.toHaveBeenCalled();
  });

  test("Escape with the drop-down open closes it and answers nothing; a second Escape dismisses the survey", async () => {
    const open = opener();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    const first = keyAt(document.activeElement ?? card, "Escape");
    await settle();
    expect(first.defaultPrevented, "the drop-down takes the Escape").toBe(true);
    expect(dropDowns(), "the first Escape closes the drop-down").toEqual([]);
    expect(reply, "and answers nothing").not.toHaveBeenCalled();
    expect(surveyState.byTab.t1?.spec.surveyId, "the survey stays up").toBe("survey-1");

    keyAt(document.activeElement ?? card, "Escape");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply, "the second Escape dismisses the survey").toHaveBeenCalledWith({ surveyId: "survey-1", kind: "dismissed" });
    expect(open, "nothing opens").not.toHaveBeenCalled();
  });

  test("1 with the drop-down open answers the survey, and the drop-down closes with it", async () => {
    const open = opener();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    keyAt(document.activeElement ?? card, "1");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply, "1 answers the first option").toHaveBeenCalledWith({ surveyId: "survey-1", kind: "option", optionIndex: 0, optionLabel: "BM25" });
    await settle();
    expect(surveyState.byTab.t1, "the answered survey is gone").toBeUndefined();
    expect(dropDowns(), "and its drop-down with it").toEqual([]);
    expect(open, "nothing opens").not.toHaveBeenCalled();
  });

  test.each([
    ["the survey is replaced", () => {
      surveyState.byTab = { t1: { spec: spec({ surveyId: "survey-2", bodyMarkdown: "Another question" }), busy: false } };
    }],
    ["its tab is hidden behind another", () => {
      const pane = layout.nodes[layout.activePaneId] as LeafNode;
      pane.tabs.push(terminalTab({ id: "t3" }));
      pane.activeTabId = "t3";
    }],
    ["its pane stops being the focused one", () => {
      layout.nodes.other = { kind: "leaf", id: "other", tabs: [terminalTab({ id: "t2" })], activeTabId: "t2" };
      setActivePane("other");
    }],
    ["the card scrolls", () => {
      document.querySelector(".survey-card")!.dispatchEvent(new Event("scroll"));
    }],
  ])("the drop-down closes when %s", async (_when, change) => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    change();
    await settle();
    expect(dropDowns(), "the drop-down closes").toEqual([]);
    expect(open, "nothing opens").not.toHaveBeenCalled();
  });

  // The keyboard's owner decides whether the survey holds its keys, not
  // the focused pane alone: whatever takes the keyboard over the survey
  // takes the drop-down with it, so Enter at the card opens nothing once
  // that owner lets go.
  test.each([
    ["a window-wide survey shows over the window", () => {
      surveyState.windowWide = { spec: spec({ surveyId: "wide-1", bodyMarkdown: "Window-wide" }), busy: false };
    }, () => {
      surveyState.windowWide = null;
    }],
    ["Search opens over the panes", () => {
      overlayStack.ids = ["search"];
    }, () => {
      overlayStack.ids = [];
    }],
    ["the command deck opens", () => {
      overlayStack.ids = ["launcher"];
    }, () => {
      overlayStack.ids = [];
    }],
    ["Settings opens", () => {
      overlayStack.ids = ["settings"];
    }, () => {
      overlayStack.ids = [];
    }],
    ["a dialog opens", () => {
      promptState.open = true;
    }, () => {
      promptState.open = false;
    }],
    ["the Computers launcher shows over the window", () => {
      document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    }, () => {
      document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
    }],
    ["a cover rises over the window", () => {
      setCoverBlocking("reconnect", true);
    }, () => {
      setCoverBlocking("reconnect", false);
    }],
  ])("the drop-down closes when %s, and Enter at the card opens nothing after", async (_when, arrive, leave) => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    arrive();
    await settle();
    expect(dropDowns(), "the survey no longer holds the keyboard, so its drop-down closes").toEqual([]);
    leave();
    await settle();
    card.focus();
    const enter = keyAt(card, "Enter");
    await settle();
    expect(open, "Enter at the card opens nothing once the owner above lets go").not.toHaveBeenCalled();
    expect(enter.defaultPrevented, "and the key is not taken").toBe(false);
  });

  test.each([
    ["the Computers launcher shows over the window", () => {
      document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    }],
    ["a cover rises over the window", () => {
      setCoverBlocking("reconnect", true);
    }],
  ])("a window-wide survey's drop-down closes when %s", async (_when, arrive) => {
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`, null);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    arrive();
    await settle();
    expect(dropDowns(), "the survey no longer holds the keyboard, so its drop-down closes").toEqual([]);
  });

  // Focus can reach a body link under an overlay (a script, assistive
  // technology), and Enter on it makes the engine's click.
  test("a click on a body link while an overlay holds the keyboard is cancelled and shows nothing", async () => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    overlayStack.ids = ["search"];
    await settle();
    const link = bodyLink(card);
    link.focus();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 0 });
    link.dispatchEvent(click);
    await settle();
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(dropDowns(), "no drop-down where the survey does not hold the keyboard").toEqual([]);
    expect(open, "nothing opens").not.toHaveBeenCalled();
  });

  // The drop-down never takes the keyboard: a press anywhere in it, not
  // only on its row or its copy button, leaves the keyboard where it was.
  test.each([
    ["footer", ".md-bubble .md-bubble-status"],
    ["list beside its row", ".md-bubble .md-bubble-list"],
    ["frame", ".md-bubble"],
  ])("a press on the drop-down's %s keeps it and the keyboard, so 1 then answers", async (_where, selector) => {
    const open = opener();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    const held = document.activeElement;
    expect(card.contains(held), "precondition: the keyboard is in the card").toBe(true);
    const at = document.querySelector<HTMLElement>(selector);
    expect(at, "precondition: the drop-down shows").not.toBeNull();
    const down = await press(at!);
    release(at!);
    await settle();
    expect(
      { cancelled: down.defaultPrevented, keyboardStays: document.activeElement === held, dropDowns: dropDowns().length },
      "the press is cancelled, so the keyboard and the drop-down stay",
    ).toEqual({ cancelled: true, keyboardStays: true, dropDowns: 1 });
    keyAt(document.activeElement ?? card, "1");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(open, "nothing opens").not.toHaveBeenCalled();
  });

  // The editor's drop-down closes when the caret leaves its link; the
  // card's closes when the keyboard moves to another control in the card,
  // so Enter there is that control's.
  test.each([
    ["an answer", (card: HTMLElement) => card.querySelector<HTMLElement>(".survey-option")!],
    ["Follow up", (card: HTMLElement) => card.querySelector<HTMLElement>(".survey-followup")!],
    ["Dismiss", (card: HTMLElement) => card.querySelector<HTMLElement>(".survey-dismiss")!],
    ["another body link", (card: HTMLElement) => bodyLink(card, 1)],
  ])("the drop-down closes when the keyboard moves to %s, and Enter there is that control's", async (_to, control) => {
    const open = opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) or [the other](https://chan.app/other).`);
    await clickOn(bodyLink(card, 0));
    expect(dropDowns(), "the click shows the first link's drop-down").toEqual([[["OPEN", URL]]]);
    const to = control(card);
    to.focus();
    expect(document.activeElement, "precondition: the keyboard moved, as Tab moves it").toBe(to);
    await settle();
    expect(dropDowns(), "the keyboard left the link, so the drop-down closes").toEqual([]);
    const enter = keyAt(to, "Enter");
    await settle();
    expect(
      { opened: open.mock.calls.length, enterTaken: enter.defaultPrevented },
      "nothing opens and the key keeps its default, the control's activation",
    ).toEqual({ opened: 0, enterTaken: false });
  });

  test.each(["the card", "the drop-down's own link"])("the keyboard moving onto %s keeps the drop-down", async (onto) => {
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    const shown = document.querySelector(".md-bubble");
    expect(shown, "the click shows the drop-down").not.toBeNull();
    card.focus();
    if (onto === "the drop-down's own link") bodyLink(card).focus();
    await settle();
    expect(document.querySelector(".md-bubble"), "the same drop-down stays").toBe(shown);
  });

  // The drop-down's target is the nearest element an engine follows as a
  // link. An element that only carries an href is none, though its click
  // is still cancelled.
  test("a click on an image inside an SVG link shows the link's target, not the image's source", async () => {
    const card = await linkedSurvey(
      `An SVG: <svg width="20" height="20"><a href="${URL}"><image href="https://example.com/i.png" width="10" height="10"/></a></svg>`,
    );
    const image = card.querySelector(".survey-body image");
    expect(image, "the body renders the image in the link").not.toBeNull();
    const click = await clickOn(image!);
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(dropDowns(), "the link's row, not the image's").toEqual([[["OPEN", URL]]]);
  });

  test.each([
    ["an SVG image that is no link", `<svg width="20" height="20"><image href="https://example.com/i.png" width="10" height="10"/></svg>`, "image"],
    ["a span that carries an href", `<span href="${URL}">not a link</span>`, "span"],
  ])("a click on %s is cancelled and shows nothing", async (_what, html, pressed) => {
    const card = await linkedSurvey(`Here: ${html}`);
    const at = card.querySelector(`.survey-body ${pressed}`);
    expect(at?.hasAttribute("href"), "the body renders the element with its href").toBe(true);
    const click = await clickOn(at!);
    expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
    expect(dropDowns(), "no drop-down").toEqual([]);
  });

  test.each([
    ["Escape", (card: HTMLElement) => {
      keyAt(document.activeElement ?? card, "Escape");
    }],
    ["Enter", (card: HTMLElement) => {
      keyAt(document.activeElement ?? card, "Enter");
    }],
    ["a press beside the link", async (card: HTMLElement) => {
      await clickOn(card.querySelector(".survey-body p")!);
    }],
  ])("a link whose drop-down %s closed shows it again when clicked", async (_closer, close) => {
    opener();
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    await close(card);
    await settle();
    expect(dropDowns(), "the drop-down closes").toEqual([]);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "a later click shows it again").toEqual([[["OPEN", URL]]]);
  });

  test("a scroll inside the body closes the drop-down", async () => {
    const card = await linkedSurvey(`Read [the notes](${URL}) first.\n\n\`\`\`\nlong line\n\`\`\`\n`);
    await clickOn(bodyLink(card));
    expect(dropDowns(), "the click shows the drop-down").toEqual([[["OPEN", URL]]]);
    const pre = card.querySelector(".survey-body pre");
    expect(pre, "the body renders a code block, which scrolls a long line").not.toBeNull();
    pre!.dispatchEvent(new Event("scroll"));
    await settle();
    expect(dropDowns(), "the link moved under its drop-down, so it closes").toEqual([]);
  });

  test("a listener between the body and the app's root that stops the click leaves the link's click cancelled", async () => {
    const card = await linkedSurvey(`Read [the notes](${URL}) first.`);
    const stop = (e: Event) => e.stopPropagation();
    card.addEventListener("click", stop);
    try {
      const click = await clickOn(bodyLink(card));
      expect(click.defaultPrevented, "the click never navigates the app").toBe(true);
      expect(dropDowns(), "and shows the drop-down").toEqual([[["OPEN", URL]]]);
    } finally {
      card.removeEventListener("click", stop);
    }
  });

  // An image map's area has no box of its own, so the drop-down sits under
  // the image that uses its map.
  test("an image map's area shows its drop-down under its image", async () => {
    const card = await linkedSurvey(
      `A map: <img src="https://example.com/i.png" usemap="#m" width="120" height="60"><map name="m"><area href="${URL}" shape="rect" coords="0,0,9,9"></map>`,
    );
    const image = card.querySelector<HTMLImageElement>(".survey-body img[usemap='#m']");
    const area = card.querySelector(".survey-body map[name='m'] area");
    expect({ image: Boolean(image), area: Boolean(area) }, "the body renders the image and its map").toEqual({ image: true, area: true });
    image!.getBoundingClientRect = () =>
      ({ x: 40, y: 100, left: 40, top: 100, right: 160, bottom: 160, width: 120, height: 60, toJSON: () => ({}) }) as DOMRect;
    await clickOn(area!);
    const wrap = document.querySelector<HTMLElement>(".md-bubble");
    expect(wrap, "the click shows the drop-down").not.toBeNull();
    expect({ top: wrap!.style.top, left: wrap!.style.left }, "8px under the image, at its left edge").toEqual({ top: "168px", left: "40px" });
  });
});
