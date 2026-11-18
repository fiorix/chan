// @vitest-environment jsdom
//
// A survey over a terminal under a cover over the window (the screen lock,
// the reconnect or session-ended cover): the cover keeps the keyboard until
// it lifts, and the card takes it then. The real survey overlay, in jsdom.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import BubbleOverlay from "./BubbleOverlay.svelte";
import { settle } from "../__tests__/dialog";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import type { SurveySpec } from "../api/client";
import { FULL_WINDOW_COVERS, setCoverBlocking } from "../state/store.svelte";
import { resetSurveysForTest, showSurvey } from "../state/survey.svelte";

const SURVEY: SurveySpec = { surveyId: "survey-terminal", title: "Pick one", bodyMarkdown: "Which?", options: ["A", "B"] };
const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  resetLayout([terminalTab({ id: "t1" })]);
});

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  resetSurveysForTest();
  for (const cover of FULL_WINDOW_COVERS) setCoverBlocking(cover, false);
  await settle();
  document.body.replaceChildren();
});

const card = (target: HTMLElement) => target.querySelector<HTMLElement>(".survey-card");

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
