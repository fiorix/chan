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
import { press, release } from "../__tests__/pressFocus";
import { terminalTab } from "../__tests__/tabs";
import { api } from "../api/client";
import { resetSurveysForTest, showSurvey, surveyFor } from "../state/survey.svelte";
import { bumpTabFocusPulse, cancelPaneMode, layout, setActivePane } from "../state/tabs.svelte";

stubAppEnvironment();

const TOP = "pane-survey";
const BOTTOM = "pane-dashboard";
const TERMINAL = "term-survey";
const SURVEY = { surveyId: "unfocused-pane", title: "Choose", bodyMarkdown: "Pick one", options: ["A", "B"] };
/// A body the markdown renders focusables in: a bare URL and a link.
const LINKED = {
  ...SURVEY,
  bodyMarkdown: "Review https://example.com/pull/1 or [the notes](https://example.com/notes) first.",
};
/// A body of raw HTML the sanitizer keeps, with one element of each kind a
/// browser can put in the Tab order, each named by its `data-kind`, the
/// embed the markdown makes of a video link, named by its tag, and an
/// element written as `contenteditable`, which the rule has no term for.
const EVERY_KIND = {
  ...SURVEY,
  bodyMarkdown: [
    'A <a data-kind="link" href="https://example.com/l">link</a>, <button data-kind="button">a button</button>, ' +
      '<input data-kind="input" value="x">, <select data-kind="select"><option>a</option></select> ' +
      'and <textarea data-kind="textarea">t</textarea>.',
    '<details><summary data-kind="summary">more</summary>hidden</details>',
    '<details data-kind="details">no summary of its own</details>',
    'A map <img src="https://example.com/i.png" usemap="#m"><map name="m">' +
      '<area data-kind="area" href="https://example.com/a" shape="rect" coords="0,0,9,9"></map>',
    'A chart <svg width="20" height="20">' +
      '<a data-kind="svg-xlink" xlink:href="https://example.com/s"><text y="10">s</text></a>' +
      '<a data-kind="svg-href" href="https://example.com/t"><text y="10">t</text></a></svg>',
    'A formula <math><mi data-kind="mathml-link" href="https://example.com/m">x</mi></math>',
    'Media <audio data-kind="audio" controls src="https://example.com/a.mp3"></audio> ' +
      '<video data-kind="video" controls src="https://example.com/a.mp4"></video>',
    '<div data-kind="scroller" style="overflow-y: auto; height: 2em">a<br>b<br>c<br>d</div>',
    '<div data-kind="scroller-x" style="overflow-x: scroll; width: 4em; white-space: nowrap">a long line</div>',
    'A <span data-kind="tabindex" tabindex="0">note</span>.',
    '<div data-editable contenteditable="true">edit</div>',
    "![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
  ].join("\n\n"),
};
const KINDS = [
  "link", "button", "input", "select", "textarea", "summary", "details", "area",
  "svg-xlink", "svg-href", "mathml-link", "audio", "video", "scroller", "scroller-x", "tabindex", "iframe",
];
/// A body with an element whose style the engine cannot compute: the case
/// makes `getComputedStyle` throw for it, as jsdom 29 does for MathML.
const UNCOMPUTABLE = { ...SURVEY, bodyMarkdown: 'Sum <span data-uncomputable="">x</span> first.' };

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
async function surveyOverUnfocusedPane(survey: typeof SURVEY = SURVEY): Promise<HTMLElement> {
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
  showSurvey(survey, TERMINAL);
  await settleLong();
  const card = pane(TOP).querySelector<HTMLElement>(".survey-card");
  if (!card) throw new Error(`no survey card over the top pane's terminal${tabFailure(TOP) ? `; the tab failed: ${tabFailure(TOP)}` : ""}`);
  expect(layout.activePaneId, "the survey leaves the focused pane focused").toBe(BOTTOM);
  return card;
}

/// The text of the pane's tab failure surface, which replaces a tab that
/// threw while drawing, or null while the tab is drawn.
function tabFailure(id: string): string | null {
  return pane(id).querySelector(".tab-failed")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
}

function buttons(card: HTMLElement): HTMLButtonElement[] {
  return [...card.querySelectorAll<HTMLButtonElement>(".survey-option, .survey-followup, .survey-dismiss")];
}

/// Every element in the card that sequential navigation reaches, by the
/// element's own tabIndex, whatever rendered it: the template's buttons
/// and whatever the body's markdown renders.
function tabbables(card: HTMLElement): string[] {
  return [...card.querySelectorAll<HTMLElement>("*")]
    .filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled)
    .map(named);
}

function named(el: Element): string {
  return `${el.tagName.toLowerCase()} ${el.textContent?.replace(/\s+/g, " ").trim()}`;
}

/// The tabindex attribute of each element of the every-kind body, by kind.
/// jsdom gives media, a details and a scroller no tabIndex of their own,
/// and a MathML element no tabIndex property at all, so the attribute is
/// what shows whether the rule holds them.
function kindTabIndexes(card: HTMLElement): Record<string, string | null> {
  return Object.fromEntries([...card.querySelectorAll(".survey-body [data-kind], .survey-body iframe")]
    .map((el) => [el.getAttribute("data-kind") ?? el.localName, el.getAttribute("tabindex")]));
}

/// A primary press and release as a browser runs them for a trusted event,
/// the press's default focus move included (`press`).
async function click(el: HTMLElement): Promise<void> {
  await press(el);
  release(el);
  await settleLong();
}

/// An answer key typed where the keyboard is.
function typeKey(key: string, code: string): void {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true }));
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

  test("nothing in its card is in the Tab order, its body's links included, until its pane is focused", async () => {
    const card = await surveyOverUnfocusedPane(LINKED);
    const links = [...card.querySelectorAll<HTMLAnchorElement>(".survey-body a[href]")];
    expect(links.map(named), "the body renders the bare URL and the link")
      .toEqual(["a https://example.com/pull/1", "a the notes"]);
    expect(tabbables(card), "out of the Tab order while the other pane is focused").toEqual([]);

    setActivePane(TOP);
    await settleLong();
    expect(document.activeElement, "its pane focused, the survey takes the keyboard").toBe(card);
    expect(tabbables(card), "all of it back in the Tab order once its pane is focused")
      .toEqual([...links, ...buttons(card)].map(named));

    setActivePane(BOTTOM);
    await settleLong();
    expect(tabbables(card), "out again when the other pane is focused again").toEqual([]);
  });

  test("a body replaced while its pane is unfocused leaves the Tab order too, and each element keeps its own tabindex", async () => {
    await surveyOverUnfocusedPane(LINKED);
    showSurvey({
      ...LINKED,
      surveyId: "unfocused-pane-next",
      bodyMarkdown: 'See [the log](https://example.com/log), <span tabindex="0">a note</span> and <span tabindex="-1">an aside</span>.',
    }, TERMINAL);
    await settleLong();
    const card = pane(TOP).querySelector<HTMLElement>(".survey-card")!;
    expect(card.querySelector(".survey-body")?.textContent, "the new body shows").toContain("an aside");
    expect(tabbables(card), "the new body's focusables are out of the Tab order").toEqual([]);

    setActivePane(TOP);
    await settleLong();
    expect(tabbables(card), "each back as its markup has it, the aside still out")
      .toEqual(["a the log", "span a note", ...buttons(card).map(named)]);
  });

  test("every kind of focusable its body keeps leaves the Tab order, and each returns with its pane", async () => {
    const card = await surveyOverUnfocusedPane(EVERY_KIND);
    expect(Object.keys(kindTabIndexes(card)), "the body renders one element of each kind").toEqual(KINDS);
    // Browsers reflect a MathML element's tabIndex property into its
    // attribute; jsdom has no such property, which is what lets this kind
    // tell a hold written as the attribute from one written as the property.
    // A fresh element reads the engine, not what the hold wrote.
    const mathml = document.createElementNS("http://www.w3.org/1998/Math/MathML", "mi");
    expect("tabIndex" in mathml, "jsdom gives a MathML element no tabIndex property").toBe(false);
    const editable = card.querySelector(".survey-body [data-editable]");
    expect(editable?.textContent, "the body renders the element written as contenteditable").toBe("edit");
    expect(editable?.hasAttribute("contenteditable"), "the sanitizer strips contenteditable, which the rule has no term for")
      .toBe(false);
    const held = Object.fromEntries(KINDS.map((kind) => [kind, "-1"]));
    expect(kindTabIndexes(card), "every kind out of the Tab order while the other pane is focused").toEqual(held);
    expect(tabbables(card), "nothing in the card reads as tabbable").toEqual([]);

    setActivePane(TOP);
    await settleLong();
    expect(kindTabIndexes(card), "each back as its markup has it once its pane is focused")
      .toEqual({ ...Object.fromEntries(KINDS.map((kind) => [kind, null])), tabindex: "0" });

    setActivePane(BOTTOM);
    await settleLong();
    expect(kindTabIndexes(card), "out again when the other pane is focused again").toEqual(held);
  });

  test("a body element whose style cannot be computed leaves its terminal tab drawn and its card up", async () => {
    const computed = window.getComputedStyle.bind(window);
    const refused: Element[] = [];
    const style = vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      if (!el.matches("[data-uncomputable]")) return computed(el, pseudo);
      refused.push(el);
      throw new TypeError("no computed style for this element");
    });
    const card = await surveyOverUnfocusedPane(UNCOMPUTABLE);
    const uncomputable = card.querySelector(".survey-body [data-uncomputable]");
    expect(uncomputable?.textContent, "the body renders the element").toBe("x");
    expect(style, "the spy stands in for the engine's getComputedStyle").toHaveBeenCalled();
    expect(refused, "the hold asked for the element's style and met the throw").toContain(uncomputable);
    expect(tabFailure(TOP), "the terminal tab is drawn under the survey").toBeNull();
    expect(buttons(card).map((b) => b.tabIndex), "out of the Tab order while the other pane is focused")
      .toEqual([-1, -1, -1, -1]);

    setActivePane(TOP);
    await settleLong();
    expect(document.activeElement, "its pane focused, the survey takes the keyboard").toBe(card);

    setActivePane(BOTTOM);
    await settleLong();
    expect(tabFailure(TOP), "the tab stays drawn when its pane loses the focus").toBeNull();
    expect(pane(TOP).querySelector(".survey-card"), "and the card stays up").toBe(card);
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

  // jsdom dispatches the press at the link whatever covers it (`inert`,
  // `pointer-events`), so hit-testing is read by a browser check, which
  // presses the link through the page.
  test("a press on a link in its body makes its pane the focused one and leaves the link its click", async () => {
    const card = await surveyOverUnfocusedPane(LINKED);
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    const link = card.querySelector<HTMLAnchorElement>(".survey-body a[href]")!;
    const followed: boolean[] = [];
    // Read whether the click reached the document with the link's default
    // left alone, then hold the default: jsdom cannot navigate.
    const onDocumentClick = (e: MouseEvent) => {
      if (e.target !== link) return;
      followed.push(!e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener("click", onDocumentClick);
    await click(link);
    document.removeEventListener("click", onDocumentClick);

    expect(followed, "the link's click travels on with its default").toEqual([true]);
    expect(layout.activePaneId, "the press makes the survey's pane the focused one").toBe(TOP);
    expect(link.tabIndex, "the link is back in the Tab order with its pane").toBe(0);
    expect(reply, "a link answers nothing").not.toHaveBeenCalled();
    expect(surveyFor(TERMINAL)?.surveyId).toBe(LINKED.surveyId);
  });
});

// The overlay covers its terminal around the card, so a press anywhere in the
// terminal outside the card lands on the overlay itself.
describe("a press on a survey's overlay beside its card", () => {
  function overlayOf(card: HTMLElement): HTMLElement {
    const overlay = card.closest<HTMLElement>(".survey-overlay");
    if (!overlay) throw new Error("the card is in no survey overlay");
    return overlay;
  }

  test("over an unfocused pane, makes its pane the focused one and leaves the keyboard on the card", async () => {
    const card = await surveyOverUnfocusedPane();
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    await click(overlayOf(card));
    expect(layout.activePaneId, "the press makes the survey's pane the focused one").toBe(TOP);
    expect(document.activeElement, "the keyboard is on the card").toBe(card);

    typeKey("2", "Digit2");
    await settleLong();
    expect(reply, "a 2 answers the survey's second option")
      .toHaveBeenCalledWith({ surveyId: SURVEY.surveyId, kind: "option", optionIndex: 1, optionLabel: "B" });
  });

  test("with its pane focused, leaves the keyboard on the card", async () => {
    const card = await surveyOverUnfocusedPane();
    setActivePane(TOP);
    await settleLong();
    expect(document.activeElement, "its pane focused, the survey takes the keyboard").toBe(card);
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);

    await click(overlayOf(card));
    expect(layout.activePaneId, "its pane stays the focused one").toBe(TOP);
    expect(document.activeElement, "the keyboard stays on the card").toBe(card);

    typeKey("2", "Digit2");
    await settleLong();
    expect(reply, "a 2 answers the survey's second option")
      .toHaveBeenCalledWith({ surveyId: SURVEY.surveyId, kind: "option", optionIndex: 1, optionLabel: "B" });
  });

  // Only a press on the overlay itself is held: one on the card or in it
  // keeps its default, as here an option takes the keyboard from the card.
  test("leaves a press inside the card its own default", async () => {
    const card = await surveyOverUnfocusedPane();
    setActivePane(TOP);
    await settleLong();
    expect(document.activeElement, "its pane focused, the survey takes the keyboard").toBe(card);
    const option = card.querySelector<HTMLButtonElement>(".survey-option")!;

    const down = await press(option);
    expect(down.defaultPrevented, "the press on the option keeps its default").toBe(false);
    expect(document.activeElement, "the option takes the keyboard").toBe(option);
  });
});

describe("a style element in its body", () => {
  test("restyles nothing outside the card: the focused pane stays visible", async () => {
    const card = await surveyOverUnfocusedPane({
      ...SURVEY,
      bodyMarkdown: `A note.\n\n<style>.pane[data-pane-id="${BOTTOM}"]{visibility:hidden}</style>\n\nAfter.`,
    });
    try {
      expect(card.querySelector(".survey-body")?.textContent, "the body renders the content beside it").toContain("After.");
      expect.soft(card.querySelector("style"), "the card holds no style element").toBeNull();
      expect.soft(getComputedStyle(pane(BOTTOM)).visibility, "the focused pane stays visible").toBe("visible");
    } finally {
      // jsdom leaves a style element's sheet applied after an ancestor of it
      // is removed, where a browser drops it, so the element itself goes
      // before the app unmounts and the later mounts start unstyled.
      for (const style of card.querySelectorAll("style")) style.remove();
    }
  });
});
