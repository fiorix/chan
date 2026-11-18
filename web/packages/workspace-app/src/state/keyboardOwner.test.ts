// @vitest-environment jsdom
//
// The keyboard's owner, read in the order owners show, top first: the
// Computers launcher; a modal dialog or a window-wide survey; the top overlay
// over the panes (Search, Settings, the command deck); the survey over the
// focused pane's active terminal. `mayFocus` lets an element take the
// keyboard only inside the owner's tagged root, and never while the launcher
// is shown.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import BubbleOverlay from "../components/BubbleOverlay.svelte";
import KeyboardOwnerKindProbe from "../__tests__/keyboardOwnerKindProbe.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import type { SurveySpec } from "../api/client";
import { closeConfirmState } from "./closeConfirm.svelte";
import { confirmState } from "./confirm.svelte";
import {
  KEYBOARD_OWNER_ATTR,
  LAUNCHER_SHOWN_ATTR,
  mayFocus,
  owner,
  ownerRoot,
  ownerTag,
} from "./keyboardOwner.svelte";
import {
  importContactsPanel,
  overlayStack,
  type OverlayId,
  pathPromptState,
  promptState,
  workspaceWarningsDialog,
} from "./store.svelte";
import { resetSurveysForTest, showSurvey } from "./survey.svelte";
import { conflictDialog, draftCloseState } from "./tabs.svelte";
import { closeTeamDialog, openTeamDialog } from "./teamDialog.svelte";

const SURVEY: SurveySpec = { surveyId: "survey-owner", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] };
// Raising a survey is idempotent by id, so a second survey shown at once
// needs its own.
const WIDE_SURVEY: SurveySpec = { ...SURVEY, surveyId: "survey-wide" };
let probe: Record<string, unknown> | undefined;

afterEach(async () => {
  if (probe) await unmount(probe as never);
  probe = undefined;
  promptState.open = false;
  pathPromptState.open = false;
  confirmState.open = false;
  draftCloseState.open = false;
  conflictDialog.open = false;
  workspaceWarningsDialog.open = false;
  importContactsPanel.open = false;
  closeTeamDialog();
  closeConfirmState.open = false;
  resetSurveysForTest();
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  overlayStack.ids = [];
  document.body.innerHTML = "";
  resetLayout([]);
});

/// A tagged owner root painted at `z`, holding one input.
function taggedRoot(tag: string, z?: number): { root: HTMLElement; field: HTMLInputElement } {
  const root = document.createElement("div");
  root.setAttribute(KEYBOARD_OWNER_ATTR, tag);
  root.style.position = "fixed";
  if (z !== undefined) root.style.zIndex = String(z);
  const field = document.createElement("input");
  root.append(field);
  document.body.append(root);
  return { root, field };
}

const MODALS: Array<[string, () => void]> = [
  ["the prompt dialog", () => { promptState.open = true; }],
  ["the path prompt dialog", () => { pathPromptState.open = true; }],
  ["the confirm dialog", () => { confirmState.open = true; }],
  ["the draft close dialog", () => { draftCloseState.open = true; }],
  ["the file conflict dialog", () => { conflictDialog.open = true; }],
  ["the workspace warnings dialog", () => { workspaceWarningsDialog.open = true; }],
  ["the contacts import panel", () => { importContactsPanel.open = true; }],
  ["the Team dialog", () => openTeamDialog({ leadTabId: "t1", leadPaneId: "pane-test" })],
  ["the desktop close prompt", () => { closeConfirmState.open = true; }],
  ["a window-wide survey", () => showSurvey(SURVEY, null)],
];

describe("owner() names the owner and its root", () => {
  test("nothing owns the keyboard by default", () => {
    resetLayout([terminalTab({ id: "t1" })]);
    expect(owner()).toBeNull();
  });

  test.each(MODALS)("%s is the modal owner, rooted at the modal's tag", (_name, take) => {
    const { root } = taggedRoot(ownerTag("modal"));
    take();
    expect(owner()).toEqual({ kind: "modal", tag: "modal" });
    expect(ownerRoot()).toBe(root);
  });

  test.each(["search", "launcher", "settings"] as OverlayId[])("the %s overlay is the overlay owner, rooted at its own tag", (id) => {
    taggedRoot(ownerTag("overlay", id === "search" ? "settings" : "search"));
    const { root } = taggedRoot(ownerTag("overlay", id));
    overlayStack.ids = [id];
    expect(owner()).toEqual({ kind: "overlay", tag: `overlay:${id}` });
    expect(ownerRoot()).toBe(root);
  });

  test("the top overlay of the stack owns it", () => {
    const { root } = taggedRoot(ownerTag("overlay", "search"));
    taggedRoot(ownerTag("overlay", "settings"));
    overlayStack.ids = ["settings", "search"];
    expect(owner()).toEqual({ kind: "overlay", tag: "overlay:search" });
    expect(ownerRoot()).toBe(root);
  });

  test("the survey over the focused pane's active terminal owns it, rooted at that terminal's tag", () => {
    resetLayout([terminalTab({ id: "t1" })]);
    taggedRoot(ownerTag("terminal-survey", "t2"));
    const { root } = taggedRoot(ownerTag("terminal-survey", "t1"));
    showSurvey(SURVEY, "t1");
    expect(owner()).toEqual({ kind: "terminal-survey", tag: "terminal-survey:t1" });
    expect(ownerRoot()).toBe(root);
  });

  test("a survey over a terminal that is not the focused pane's active tab owns nothing", () => {
    resetLayout([terminalTab({ id: "t1" }), terminalTab({ id: "t2" })]);
    showSurvey(SURVEY, "t2");
    expect(owner()).toBeNull();
  });

  test("the Computers launcher owns it with no root in the page", () => {
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    expect(owner()).toEqual({ kind: "launcher", tag: null });
    expect(ownerRoot()).toBeNull();
  });

  test("the Computers launcher stops owning it as its mark goes, before the observer runs", async () => {
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    await tick();
    expect(owner()?.kind).toBe("launcher");
    document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
    expect(owner()).toBeNull();
  });

  test("of two roots of one kind, the one that paints on top is the owner's", () => {
    const { root: upper } = taggedRoot(ownerTag("modal"), 39000);
    taggedRoot(ownerTag("modal"), 26000);
    promptState.open = true;
    expect(ownerRoot()).toBe(upper);
  });

  test("of two roots of one kind painting at one level, the later one in the document is the owner's", () => {
    taggedRoot(ownerTag("modal"), 26000);
    const { root: later } = taggedRoot(ownerTag("modal"), 26000);
    promptState.open = true;
    expect(ownerRoot()).toBe(later);
  });

  test("a modal shown without a tagged root owns the keyboard with no root", () => {
    promptState.open = true;
    expect(owner()).toEqual({ kind: "modal", tag: "modal" });
    expect(ownerRoot()).toBeNull();
  });

  test("a root that mounts after the owner shows is found when asked", () => {
    promptState.open = true;
    const before = owner();
    expect(ownerRoot(before)).toBeNull();
    const { root, field } = taggedRoot(ownerTag("modal"));
    expect(ownerRoot(before)).toBe(root);
    expect(mayFocus(field)).toBe(true);
  });

  test("the survey overlays are the roots the owner names", async () => {
    resetLayout([terminalTab({ id: "t1" })]);
    const terminalTarget = document.createElement("div");
    const wideTarget = document.createElement("div");
    document.body.append(terminalTarget, wideTarget);
    const overTerminal = mount(BubbleOverlay, { target: terminalTarget, props: { tabId: "t1" } });
    const windowWide = mount(BubbleOverlay, { target: wideTarget });
    try {
      showSurvey(SURVEY, "t1");
      await tick();
      expect(owner()?.kind).toBe("terminal-survey");
      expect(ownerRoot()).toBe(terminalTarget.querySelector(".survey-overlay"));
      showSurvey(WIDE_SURVEY, null);
      await tick();
      expect(owner()?.kind).toBe("modal");
      expect(ownerRoot()).toBe(wideTarget.querySelector(".survey-overlay"));
    } finally {
      await unmount(overTerminal);
      await unmount(windowWide);
    }
  });
});

describe("owners take precedence in the order they show", () => {
  test("the Computers launcher over a modal dialog", () => {
    promptState.open = true;
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    expect(owner()?.kind).toBe("launcher");
  });

  test("a modal dialog over an overlay", () => {
    overlayStack.ids = ["search"];
    promptState.open = true;
    expect(owner()?.kind).toBe("modal");
  });

  test("a window-wide survey over an overlay", () => {
    overlayStack.ids = ["launcher"];
    showSurvey(SURVEY, null);
    expect(owner()?.kind).toBe("modal");
  });

  test("an overlay over the survey over the focused pane's terminal", () => {
    resetLayout([terminalTab({ id: "t1" })]);
    showSurvey(SURVEY, "t1");
    overlayStack.ids = ["search"];
    expect(owner()?.kind).toBe("overlay");
  });

  test("a window-wide survey over the survey over the focused pane's terminal", () => {
    resetLayout([terminalTab({ id: "t1" })]);
    showSurvey(SURVEY, "t1");
    showSurvey(WIDE_SURVEY, null);
    expect(owner()?.kind).toBe("modal");
  });
});

describe("mayFocus", () => {
  test("lets any element take the keyboard while nothing owns it", () => {
    const field = document.createElement("input");
    document.body.append(field);
    expect(mayFocus(field)).toBe(true);
  });

  test("lets an element inside the owner's root take it, and refuses one outside", () => {
    const { field: inside } = taggedRoot(ownerTag("modal"));
    const outside = document.createElement("input");
    document.body.append(outside);
    promptState.open = true;
    expect(mayFocus(inside)).toBe(true);
    expect(mayFocus(outside)).toBe(false);
    expect(mayFocus(null)).toBe(false);
  });

  test("follows the owner: inside the terminal's survey card, not the terminal under it", () => {
    resetLayout([terminalTab({ id: "t1" })]);
    const terminal = document.createElement("div");
    const { root, field: card } = taggedRoot(ownerTag("terminal-survey", "t1"));
    terminal.append(root);
    const host = document.createElement("textarea");
    terminal.append(host);
    document.body.append(terminal);
    showSurvey(SURVEY, "t1");
    expect(mayFocus(card)).toBe(true);
    expect(mayFocus(host)).toBe(false);
  });

  test("refuses every element while the Computers launcher is shown, one inside a root included", () => {
    const { field } = taggedRoot(ownerTag("modal"));
    promptState.open = true;
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    expect(mayFocus(field)).toBe(false);
    expect(mayFocus(document.body)).toBe(false);
  });

  test("refuses every element when the owner has no root in the page", () => {
    const field = document.createElement("input");
    document.body.append(field);
    overlayStack.ids = ["settings"];
    expect(mayFocus(field)).toBe(false);
  });
});

describe("owner() is reactive", () => {
  test.each([
    ["the Computers launcher", "launcher",
      () => document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, ""),
      () => document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR)],
    ["a modal dialog", "modal", () => { promptState.open = true; }, () => { promptState.open = false; }],
    ["an overlay", "overlay", () => { overlayStack.ids = ["search"]; }, () => { overlayStack.ids = []; }],
  ] as const)("a reader of %s reads again when it lets go", async (_name, kind, take, release) => {
    const target = document.createElement("div");
    document.body.append(target);
    probe = mount(KeyboardOwnerKindProbe, { target }) as Record<string, unknown>;
    const shown = () => target.querySelector("span")?.dataset.owner;
    await tick();
    expect(shown()).toBe("none");
    take();
    await vi.waitFor(() => expect(shown(), "the owner shows").toBe(kind));
    release();
    await vi.waitFor(() => expect(shown(), "the owner let go").toBe("none"));
  });
});
