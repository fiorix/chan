// @vitest-environment jsdom
//
// The per-terminal rule the focus movers read: a modal
// dialog, a survey over that terminal, a window-wide survey, the Computers
// launcher while shown, and an overlay over the panes (the command launcher,
// Search, Settings). While one of them owns the keyboard, neither the
// terminal nor its composer takes focus by itself. The rule is reactive:
// every showing and hiding is state, so a derived value or effect that read
// it while an owner showed reads it again when the owner lets go.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import KeyboardOwnerProbe from "../__tests__/keyboardOwnerProbe.svelte";
import { LAUNCHER_SHOWN_ATTR, legacyKeyboardOwned } from "./keyboardOwner.svelte";
import { closeConfirmState } from "./closeConfirm.svelte";
import { confirmState } from "./confirm.svelte";
import {
  importContactsPanel,
  overlayStack,
  type OverlayId,
  pathPromptState,
  promptState,
  workspaceWarningsDialog,
} from "./store.svelte";
import { conflictDialog, draftCloseState } from "./tabs.svelte";
import { openTeamDialog, closeTeamDialog } from "./teamDialog.svelte";
import { resetSurveysForTest, showSurvey, type SurveySlot } from "./survey.svelte";
import type { SurveySpec } from "../api/client";

const SURVEY: SurveySpec = { surveyId: "survey-owner", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] };
const SLOT: SurveySlot = "tab-owner";
let probe: Record<string, unknown> | undefined;

beforeEach(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

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
});

type Owner = {
  name: string;
  take: () => void;
  release: () => void;
};

const OWNERS: Owner[] = [
  { name: "the prompt dialog", take: () => { promptState.open = true; }, release: () => { promptState.open = false; } },
  { name: "the path prompt dialog", take: () => { pathPromptState.open = true; }, release: () => { pathPromptState.open = false; } },
  { name: "the confirm dialog", take: () => { confirmState.open = true; }, release: () => { confirmState.open = false; } },
  { name: "the draft close dialog", take: () => { draftCloseState.open = true; }, release: () => { draftCloseState.open = false; } },
  { name: "the file conflict dialog", take: () => { conflictDialog.open = true; }, release: () => { conflictDialog.open = false; } },
  { name: "the workspace warnings dialog", take: () => { workspaceWarningsDialog.open = true; }, release: () => { workspaceWarningsDialog.open = false; } },
  { name: "the contacts import panel", take: () => { importContactsPanel.open = true; }, release: () => { importContactsPanel.open = false; } },
  {
    name: "the Team dialog",
    take: () => openTeamDialog({ leadTabId: SLOT, leadPaneId: "pane-owner" }),
    release: () => closeTeamDialog(),
  },
  { name: "the desktop close prompt", take: () => { closeConfirmState.open = true; }, release: () => { closeConfirmState.open = false; } },
  { name: "a survey over the terminal", take: () => showSurvey(SURVEY, SLOT), release: () => resetSurveysForTest() },
  { name: "a window-wide survey", take: () => showSurvey(SURVEY, null), release: () => resetSurveysForTest() },
  {
    name: "the Computers launcher",
    take: () => document.documentElement.setAttribute(LAUNCHER_SHOWN_ATTR, ""),
    release: () => document.documentElement.removeAttribute(LAUNCHER_SHOWN_ATTR),
  },
  { name: "the command launcher overlay", take: () => { overlayStack.ids = ["launcher"]; }, release: () => { overlayStack.ids = []; } },
  { name: "the Search overlay", take: () => { overlayStack.ids = ["search"]; }, release: () => { overlayStack.ids = []; } },
  { name: "the Settings overlay", take: () => { overlayStack.ids = ["settings"]; }, release: () => { overlayStack.ids = []; } },
];

describe("the rule names every owner", () => {
  test.each(OWNERS.map((owner) => [owner.name, owner] as const))("%s owns the keyboard while it shows", async (_name, owner) => {
    expect(legacyKeyboardOwned(SLOT), "nothing shows").toBe(false);
    owner.take();
    // The launcher's mark crosses a MutationObserver; the rest are synchronous.
    await tick();
    expect(legacyKeyboardOwned(SLOT), "the owner shows").toBe(true);
    owner.release();
    await tick();
    expect(legacyKeyboardOwned(SLOT), "the owner let go").toBe(false);
  });

  test("a survey over another terminal owns nothing here", () => {
    showSurvey(SURVEY, "tab-elsewhere");
    expect(legacyKeyboardOwned(SLOT)).toBe(false);
    expect(legacyKeyboardOwned("tab-elsewhere")).toBe(true);
  });

  test("the command launcher does not count against its own return", () => {
    const except: OverlayId = "launcher";
    overlayStack.ids = ["launcher"];
    expect(legacyKeyboardOwned(SLOT)).toBe(true);
    expect(legacyKeyboardOwned(SLOT, except)).toBe(false);
    overlayStack.ids = ["launcher", "search"];
    expect(legacyKeyboardOwned(SLOT, except)).toBe(true);
  });

  test("the rule counts an overlay against a terminal's refocus", () => {
    expect(legacyKeyboardOwned(SLOT)).toBe(false);
    overlayStack.ids = ["search"];
    expect(legacyKeyboardOwned(SLOT)).toBe(true);
    overlayStack.ids = [];
    expect(legacyKeyboardOwned(SLOT)).toBe(false);
  });
});

describe("the rule is reactive", () => {
  test.each(OWNERS.map((owner) => [owner.name, owner] as const))("%s re-reads when it lets go", async (_name, owner) => {
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(KeyboardOwnerProbe, { target, props: { slot: SLOT } });
    probe = component as Record<string, unknown>;
    const shown = () => target.querySelector("span")?.dataset.owned;
    await vi.waitFor(() => expect(shown()).toBe("no"));
    owner.take();
    await vi.waitFor(() => expect(shown(), "the owner shows").toBe("yes"));
    owner.release();
    await vi.waitFor(() => expect(shown(), "the owner let go").toBe("no"));
  });
});
