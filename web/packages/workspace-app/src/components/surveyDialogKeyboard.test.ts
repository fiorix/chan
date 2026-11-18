// @vitest-environment jsdom
//
// Who holds the keyboard when a window-wide survey and a dialog show
// together, and after either goes. The survey paints over the dialogs of
// its tier, so it holds the keyboard over them; a dialog that takes focus
// under it hands it straight back, and the survey's close hands it to the
// dialog. The Computers launcher and the covers over the window rank above
// both. The real survey overlay and dialog stack, in jsdom.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import BubbleOverlay from "./BubbleOverlay.svelte";
import CloseConfirmOverlay from "./CloseConfirmOverlay.svelte";
import OverlayShell from "./OverlayShell.svelte";
import { createRawSnippet } from "svelte";
import TeamDialog from "./TeamDialog.svelte";
import { resolveCloseConfirm, uiCloseConfirm } from "../state/closeConfirm.svelte";
import { resolveConfirm, uiConfirm } from "../state/confirm.svelte";
import { closeTeamDialog, openTeamDialog } from "../state/teamDialog.svelte";
import Harness from "../__tests__/ModalStackHarness.svelte";
import { focusOrigin, settle } from "../__tests__/dialog";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import type { SurveySpec } from "../api/client";
import { LAUNCHER_SHOWN_ATTR } from "../state/keyboardOwner.svelte";
import { FULL_WINDOW_COVERS, promptState, resolvePrompt, searchPanel, setCoverBlocking, syncOverlayStack, uiPrompt } from "../state/store.svelte";
import { resetSurveysForTest, showSurvey, surveyState } from "../state/survey.svelte";

const SURVEY: SurveySpec = { surveyId: "survey-wide", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] };
const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  resetLayout([terminalTab({ id: "t1" })]);
});

afterEach(async () => {
  if (promptState.open) resolvePrompt(null);
  for (const component of mounted.splice(0)) await unmount(component);
  resetSurveysForTest();
  document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
  for (const cover of FULL_WINDOW_COVERS) setCoverBlocking(cover, false);
  await settle();
  document.body.replaceChildren();
});

function overlay(tabId: string | null = null): HTMLElement {
  const target = document.createElement("div");
  // jsdom applies no component stylesheet: the window-wide layer paints at
  // its stylesheet's z-index, over the dialogs' 26000.
  target.style.position = "fixed";
  target.style.zIndex = "29900";
  document.body.append(target);
  mounted.push(mount(BubbleOverlay, { target, props: { tabId } }));
  flushSync();
  return target;
}

/// The app's dialogs, mounted as the app mounts them.
function dialogs(): void {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Harness, { target, props: { callers: true } }));
  flushSync();
}

/// Ask a question in the prompt dialog, as a command does: its field.
async function openDialog(): Promise<HTMLInputElement> {
  void uiPrompt("Name");
  await settle();
  return document.querySelector<HTMLInputElement>('.modal[role="dialog"] input')!;
}

const card = (target: HTMLElement) => target.querySelector<HTMLElement>(".survey-card");

describe("a window-wide survey and a dialog", () => {
  test("the card arriving under the Computers launcher takes nothing, and takes the keyboard when it hides", async () => {
    const origin = focusOrigin();
    const target = overlay();
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    showSurvey(SURVEY, null);
    await settle();
    expect(document.activeElement, "under the launcher").toBe(origin);
    document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
    await settle();
    expect(document.activeElement).toBe(card(target));
  });

  test("a survey arriving over an open dialog holds the keyboard, and its close hands it back to the dialog", async () => {
    focusOrigin();
    const target = overlay();
    dialogs();
    const field = await openDialog();
    field.focus();
    showSurvey(SURVEY, null);
    await settle();
    expect(document.activeElement, "the card over the dialog").toBe(card(target));
    await settle();
    expect(document.activeElement, "the dialog's repair leaves it").toBe(card(target));
    // jsdom sends focus events as it removes the focused card, which run the
    // dialog's own repair; an engine that sends none leaves the keyboard to
    // the hand-back alone.
    const hush = (event: FocusEvent) => event.stopImmediatePropagation();
    for (const type of ["focusout", "focusin"]) window.addEventListener(type, hush as EventListener, true);
    try {
      surveyState.windowWide = null;
      await settle();
    } finally {
      for (const type of ["focusout", "focusin"]) window.removeEventListener(type, hush as EventListener, true);
    }
    expect(document.activeElement, "the dialog's last field").toBe(field);
  });

  test("a dialog opening under a window-wide survey hands the keyboard back to its card", async () => {
    focusOrigin();
    const target = overlay();
    dialogs();
    showSurvey(SURVEY, null);
    await settle();
    expect(document.activeElement).toBe(card(target));
    await openDialog();
    await settle();
    expect(document.activeElement).toBe(card(target));
  });

  test("a dialog closing over another under a window-wide survey hands its opener nothing", async () => {
    focusOrigin();
    const target = overlay();
    dialogs();
    const field = await openDialog();
    field.focus();
    void uiConfirm({ title: "Sure?" });
    await settle();
    showSurvey(SURVEY, null);
    await settle();
    expect(document.activeElement, "the card over both dialogs").toBe(card(target));
    const restore = vi.spyOn(field, "focus");
    resolveConfirm(false);
    await settle();
    expect(restore, "the opener in the dialog left").not.toHaveBeenCalled();
    expect(document.activeElement).toBe(card(target));
  });

  test("the last dialog closing under a window-wide survey hands the keyboard to its card", async () => {
    focusOrigin();
    const target = overlay();
    dialogs();
    await openDialog();
    showSurvey(SURVEY, null);
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    resolvePrompt(null);
    await settle();
    expect(document.activeElement).toBe(card(target));
  });
});

describe("a terminal's survey under a cover over the window", () => {
  test.each(FULL_WINDOW_COVERS)("%s: the card takes no keyboard, and takes it when the cover lifts", async (cover) => {
    const terminal = document.createElement("div");
    terminal.className = "terminal-tab";
    const pin = document.createElement("input");
    document.body.append(terminal, pin);
    pin.focus();
    setCoverBlocking(cover, true);
    const target = document.createElement("div");
    terminal.append(target);
    mounted.push(mount(BubbleOverlay, { target, props: { tabId: "t1" } }));
    showSurvey(SURVEY, "t1");
    await settle();
    expect(document.activeElement, "the cover's field").toBe(pin);
    setCoverBlocking(cover, false);
    await tick();
    await settle();
    expect(document.activeElement).toBe(card(target));
  });
});

describe("a window-wide survey over Search", () => {
  test("its close hands the keyboard back to Search's field when it remembered none", async () => {
    focusOrigin();
    const search = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(OverlayShell, {
      target: search,
      props: {
        id: "search",
        label: "Search",
        get open() { return searchPanel.open; },
        onClose: () => { searchPanel.open = false; },
        children: createRawSnippet(() => ({ render: () => '<input aria-label="query" />' })),
      },
    }));
    searchPanel.open = true;
    syncOverlayStack();
    await settle();
    const query = search.querySelector<HTMLInputElement>('[aria-label="query"]')!;
    query.focus();
    // The keyboard at large as the survey arrives: it remembers nothing to
    // return to, and its close hands the keyboard to Search, the owner.
    query.blur();
    const wide = overlay();
    showSurvey(SURVEY, null);
    await settle();
    expect(document.activeElement, "the card over Search").toBe(card(wide));
    surveyState.windowWide = null;
    await settle();
    expect(document.activeElement, "Search's field").toBe(query);
    searchPanel.open = false;
    syncOverlayStack();
    await settle();
  });
});

describe("the close prompt and the Team dialog", () => {
  test("the close prompt arriving under the Computers launcher takes nothing, and takes Cancel when it hides", async () => {
    const origin = focusOrigin();
    const target = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(CloseConfirmOverlay, { target }));
    document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, "");
    const answer = uiCloseConfirm();
    await settle();
    expect(document.activeElement, "under the launcher").toBe(origin);
    document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR);
    await settle();
    expect(document.activeElement).toBe(target.querySelector("button.cancel"));
    resolveCloseConfirm("cancel");
    await answer;
  });

  test("the Team dialog arriving under a window-wide survey leaves the card the keyboard, and takes it as the survey closes", async () => {
    resetLayout([terminalTab({ id: "lead-tab", terminalSessionId: "lead-session" })]);
    focusOrigin();
    const wide = overlay();
    showSurvey(SURVEY, null);
    await settle();
    expect(document.activeElement).toBe(card(wide));
    const request = { leadTabId: "lead-tab", leadPaneId: "pane-test" };
    openTeamDialog(request);
    const target = document.body.appendChild(document.createElement("div"));
    mounted.push(mount(TeamDialog, { target, props: { request } }));
    try {
      await settle();
      expect(document.activeElement, "the card over the dialog").toBe(card(wide));
      surveyState.windowWide = null;
      await settle();
      expect(document.activeElement, "the dialog's name field").toBe(target.querySelector(".team-field input"));
    } finally {
      closeTeamDialog();
    }
  });
});
