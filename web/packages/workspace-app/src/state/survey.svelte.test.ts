import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, type SurveySpec } from "../api/client";
import { ApiError } from "../api/errors";
import BubbleOverlay from "../components/BubbleOverlay.svelte";
import { setNotifyHandler } from "./notify.svelte";
import {
  surveyState,
  showSurvey,
  surveyFor,
  surveyBusy,
  closeSurveyFromRemote,
  pickOption,
  requestFollowup,
  dismissSurvey,
  type SurveySlot,
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

// The three replies an overlay sends, each for the survey on `slot`.
const REPLIES: Array<[string, (slot: SurveySlot) => Promise<void>]> = [
  ["an option", (slot) => pickOption(slot, 0)],
  ["the follow-up", (slot) => requestFollowup(slot)],
  ["Dismiss", (slot) => dismissSurvey(slot)],
];

// What the reply route answers once no survey is parked under the id.
const REFUSED = new ApiError(404, "no survey parked with id survey-7 (already answered or stale)");

let notices: string[] = [];

beforeEach(() => {
  notices = [];
  setNotifyHandler((message) => notices.push(message));
});

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

});

describe("a reply the server refuses as unknown", () => {
  test.each(REPLIES)("to %s clears the slot and says the survey expired", async (_reply, send) => {
    vi.spyOn(api, "surveyReply").mockRejectedValue(REFUSED);
    showSurvey(spec(), "t1");
    await send("t1");
    expect(surveyFor("t1")).toBeNull();
    expect(notices).toEqual([expect.stringMatching(/^survey expired/)]);
  });
});

describe("a reply that fails any other way", () => {
  test.each(
    REPLIES.flatMap(([reply, send]) => [
      [reply, "the network", new TypeError("Failed to fetch"), send] as const,
      [reply, "a server error", new ApiError(500, "boom"), send] as const,
    ]),
  )("to %s through %s keeps the survey up for a retry", async (_reply, _failure, error, send) => {
    vi.spyOn(api, "surveyReply").mockRejectedValue(error);
    showSurvey(spec(), "t1");
    await send("t1");
    expect(surveyFor("t1")?.surveyId).toBe("survey-7");
    expect(surveyBusy("t1")).toBe(false);
    expect(notices).toEqual([expect.stringMatching(/^survey \w+ failed: /)]);
  });
});

describe("a reply that settles after another survey took its slot", () => {
  test.each([
    ["is accepted", (answer: { resolve: () => void; reject: (e: unknown) => void }) => answer.resolve()],
    ["is refused", (answer: { resolve: () => void; reject: (e: unknown) => void }) => answer.reject(REFUSED)],
  ])("leaves that survey up when it %s", async (_outcome, settle) => {
    let answer!: { resolve: () => void; reject: (e: unknown) => void };
    vi.spyOn(api, "surveyReply").mockReturnValue(
      new Promise<void>((resolve, reject) => (answer = { resolve, reject })),
    );
    showSurvey(spec({ surveyId: "survey-a" }), null);
    const sent = dismissSurvey(null);
    showSurvey(spec({ surveyId: "survey-b" }), null);
    settle(answer);
    await sent;
    expect(surveyFor(null)?.surveyId).toBe("survey-b");
  });
});
