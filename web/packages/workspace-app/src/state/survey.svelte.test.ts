import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, type SurveySpec } from "../api/client";
import BubbleOverlay from "../components/BubbleOverlay.svelte";
import {
  surveyState,
  showSurvey,
  surveyFor,
  surveyBusy,
  closeSurveyFromRemote,
  pickOption,
  requestFollowup,
  dismissSurvey,
} from "./survey.svelte";

// The survey store holds active surveys keyed by slot (a terminal tab id, or
// `null` for the window-wide fallback) and round-trips the reply through
// api.surveyReply. We spy on that method so no network is hit.

function spec(over: Partial<SurveySpec> = {}): SurveySpec {
  return {
    surveyId: "survey-7",
    title: "T",
    bodyMarkdown: "the question",
    options: ["Yes", "No"],
    ...over,
  };
}

afterEach(() => {
  surveyState.byTab = {};
  surveyState.windowWide = null;
  vi.restoreAllMocks();
});

describe("survey store", () => {
  test("showSurvey sets the window-wide survey when slot is null", () => {
    showSurvey(spec(), null);
    expect(surveyFor(null)?.surveyId).toBe("survey-7");
    expect(surveyBusy(null)).toBe(false);
  });

  test("per-terminal surveys are independent: two tabs do not collide", () => {
    showSurvey(spec({ surveyId: "survey-a" }), "t1");
    showSurvey(spec({ surveyId: "survey-b" }), "t2");
    expect(surveyFor("t1")?.surveyId).toBe("survey-a");
    expect(surveyFor("t2")?.surveyId).toBe("survey-b");
    expect(surveyFor(null)).toBeNull();
  });

  test("pickOption posts the option reply and dismisses ONLY that slot", async () => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined as never);
    showSurvey(spec({ surveyId: "survey-a" }), "t1");
    showSurvey(spec({ surveyId: "survey-b" }), "t2");
    await pickOption("t1", 1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      surveyId: "survey-a",
      kind: "option",
      optionIndex: 1,
      optionLabel: "No",
      windowId: expect.any(String),
    });
    // t1 cleared; t2 untouched (independence).
    expect(surveyFor("t1")).toBeNull();
    expect(surveyFor("t2")?.surveyId).toBe("survey-b");
  });

  test("pickOption out of range is a no-op", async () => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined as never);
    showSurvey(spec(), null);
    await pickOption(null, 9);
    expect(reply).not.toHaveBeenCalled();
    expect(surveyFor(null)).not.toBeNull();
  });

  test("requestFollowup posts the bare dismiss-shaped followup signal", async () => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined as never);
    showSurvey(spec(), "t1");
    await requestFollowup("t1");
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      surveyId: "survey-7",
      kind: "followup",
      windowId: expect.any(String),
    });
    expect(surveyFor("t1")).toBeNull();
  });

  test("dismissSurvey posts the dismissed reply and clears ONLY that slot", async () => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined as never);
    showSurvey(spec({ surveyId: "survey-a" }), "t1");
    showSurvey(spec({ surveyId: "survey-b" }), "t2");
    await dismissSurvey("t1");
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      surveyId: "survey-a",
      kind: "dismissed",
      windowId: expect.any(String),
    });
    // t1 cleared; t2 untouched (independence).
    expect(surveyFor("t1")).toBeNull();
    expect(surveyFor("t2")?.surveyId).toBe("survey-b");
  });

  test("remote close clears only the matching per-terminal survey by id", () => {
    showSurvey(spec({ surveyId: "survey-a" }), "t1");
    showSurvey(spec({ surveyId: "survey-b" }), "t2");
    const closed = closeSurveyFromRemote("survey-a", "t1");
    expect(closed).toBe("t1");
    expect(surveyFor("t1")).toBeNull();
    expect(surveyFor("t2")?.surveyId).toBe("survey-b");
  });

  test("remote close without tabName clears the window-wide group survey", () => {
    showSurvey(spec({ surveyId: "survey-group" }), null);
    showSurvey(spec({ surveyId: "survey-tab" }), "t1");
    const closed = closeSurveyFromRemote("survey-group");
    expect(closed).toBeNull();
    expect(surveyFor(null)).toBeNull();
    expect(surveyFor("t1")?.surveyId).toBe("survey-tab");
  });

  test("remote close ignores stale ids", () => {
    showSurvey(spec({ surveyId: "survey-a" }), "t1");
    expect(closeSurveyFromRemote("survey-missing", "t1")).toBeUndefined();
    expect(surveyFor("t1")?.surveyId).toBe("survey-a");
  });

  test("remote close skips a busy (in-flight-reply) survey so the local clear wins", () => {
    showSurvey(spec({ surveyId: "survey-a" }), "t1");
    surveyState.byTab["t1"].busy = true;
    // A late `answered_elsewhere` fanned back to the answering window must not
    // clear a survey whose own reply is in flight.
    expect(closeSurveyFromRemote("survey-a", "t1")).toBeUndefined();
    expect(surveyFor("t1")?.surveyId).toBe("survey-a");
  });

  test("x, X and Escape on the survey card dismiss it, and the button names its key", async () => {
    const reply = vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    for (const key of ["x", "X", "Escape"]) {
      showSurvey(spec({ surveyId: `survey-${key}` }), "t1");
      const target = document.createElement("div");
      document.body.append(target);
      const overlay = mount(BubbleOverlay, { target, props: { tabId: "t1" } });
      flushSync();
      expect(target.querySelector(".survey-dismiss")?.textContent?.trim()).toBe("[X] Dismiss");

      target
        .querySelector(".survey-card")!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(surveyFor("t1")).toBeNull());
      unmount(overlay);
      target.remove();
    }
    expect(reply.mock.calls.map(([sent]) => [sent.surveyId, sent.kind])).toEqual([
      ["survey-x", "dismissed"],
      ["survey-X", "dismissed"],
      ["survey-Escape", "dismissed"],
    ]);
  });

  test("a failed dismiss keeps the survey up and clears busy", async () => {
    vi.spyOn(api, "surveyReply").mockRejectedValue(new Error("boom"));
    showSurvey(spec(), "t1");
    await dismissSurvey("t1");
    expect(surveyFor("t1")).not.toBeNull();
    expect(surveyBusy("t1")).toBe(false);
  });

  test("a failed reply keeps the survey up and clears busy", async () => {
    vi.spyOn(api, "surveyReply").mockRejectedValue(new Error("boom"));
    showSurvey(spec(), "t1");
    await pickOption("t1", 0);
    // Still showing so the user can retry; not wedged in busy.
    expect(surveyFor("t1")).not.toBeNull();
    expect(surveyBusy("t1")).toBe(false);
  });
});
