// @vitest-environment jsdom
//
// `survey_sync` tells a window's socket, on every attach and after it lagged,
// which surveys are still open in that window, oldest first, each in the
// `open_survey` shape. The overlays converge on that list, while
// `open_survey` and `close_survey` still apply in arrival order around it.
// An answered survey's close reaches every window it targeted, the one that
// answered included, where it leaves the slot to that window's own reply.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, type SurveySpec } from "../api/client";
import { setNotifyHandler } from "./notify.svelte";
import { richPrompt } from "./richPrompt.svelte";
import { onWatchEvent } from "./store.svelte";
import { pickOption, resetSurveysForTest, surveyBusy, surveyFor } from "./survey.svelte";
import { layout, type LeafNode, type TerminalTab } from "./tabs.svelte";

const WINDOW = "window-a";

type Listed = { survey: SurveySpec; tabName?: string };

function spec(surveyId: string): SurveySpec {
  return { surveyId, title: null, bodyMarkdown: `asks ${surveyId}`, options: ["ok"] };
}

async function deliver(command: Record<string, unknown>): Promise<void> {
  onWatchEvent({ type: "window_command", window_id: WINDOW, ...command });
  await Promise.resolve();
}

const sync = (...surveys: Listed[]) => deliver({ command: "survey_sync", surveys });
const open = (survey: SurveySpec, tabName?: string) =>
  deliver({ command: "open_survey", survey, ...(tabName ? { tabName } : {}) });
const close = (surveyId: string, tabName?: string) =>
  deliver({ command: "close_survey", surveyId, reason: "timed_out", ...(tabName ? { tabName } : {}) });

// A reply to the survey on `slot` that has not settled yet.
function replyInFlight(slot: string | null) {
  let answer!: { resolve: () => void; reject: (e: unknown) => void };
  vi.spyOn(api, "surveyReply").mockReturnValue(
    new Promise<void>((resolve, reject) => (answer = { resolve, reject })),
  );
  const sent = pickOption(slot, 0);
  return { answer, sent };
}

// Rename a terminal from its tab header, as the user can while its survey is
// up: the survey's `tabName` then resolves to no terminal.
function rename(id: string, title: string): void {
  const pane = layout.nodes["pane-sync"] as LeafNode;
  const tab = pane.tabs.find((t) => t.id === id);
  if (tab?.kind === "terminal") tab.title = title;
}

let notices: string[] = [];

beforeEach(() => {
  window.history.replaceState(null, "", `/?w=${WINDOW}`);
  const terminal = (id: string, title: string): TerminalTab =>
    ({ kind: "terminal", id, title, createdAt: 1, broadcastEnabled: false, broadcastTargetIds: [] }) as TerminalTab;
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-sync",
    tabs: [terminal("term-a", "@@A"), terminal("term-b", "@@B")],
    activeTabId: "term-a",
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  notices = [];
  setNotifyHandler((message) => notices.push(message));
});

afterEach(() => {
  resetSurveysForTest();
  richPrompt.byTab = {};
  vi.restoreAllMocks();
  const pane: LeafNode = { kind: "leaf", id: "reset", tabs: [], activeTabId: null };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  window.history.replaceState(null, "", "/");
});

describe("survey_sync", () => {
  test("an empty list clears every slot", async () => {
    await open(spec("survey-a"), "@@A");
    await open(spec("survey-b"), "@@B");
    await open(spec("survey-group"));

    await sync();

    expect(surveyFor("term-a")).toBeNull();
    expect(surveyFor("term-b")).toBeNull();
    expect(surveyFor(null)).toBeNull();
  });

  test("raises each listed survey the window does not show on its slot", async () => {
    await sync({ survey: spec("survey-a"), tabName: "@@A" }, { survey: spec("survey-group") });

    expect(surveyFor("term-a")?.surveyId).toBe("survey-a");
    expect(surveyFor(null)?.surveyId).toBe("survey-group");
    expect(surveyFor("term-b")).toBeNull();
  });

  test("raises a survey the window already shows once, keeping its reply in flight", async () => {
    await open(spec("survey-a"), "@@A");
    replyInFlight("term-a");
    expect(surveyBusy("term-a")).toBe(true);

    await sync({ survey: spec("survey-a"), tabName: "@@A" });
    await open(spec("survey-a"), "@@A");

    expect(surveyFor("term-a")?.surveyId).toBe("survey-a");
    expect(surveyBusy("term-a")).toBe(true);
  });

  test("an open_survey after a sync that did not list it still raises", async () => {
    await sync();
    await open(spec("survey-a"), "@@A");

    expect(surveyFor("term-a")?.surveyId).toBe("survey-a");
  });

  test("a close_survey after a sync that listed it still closes", async () => {
    await open(spec("survey-a"), "@@A");
    await sync({ survey: spec("survey-a"), tabName: "@@A" });
    await close("survey-a", "@@A");

    expect(surveyFor("term-a")).toBeNull();
  });

  test("the later of two group entries wins the window-wide slot, and the earlier takes it once the later closes", async () => {
    await sync({ survey: spec("survey-early") }, { survey: spec("survey-late") });
    expect(surveyFor(null)?.surveyId).toBe("survey-late");

    await close("survey-late");
    expect(surveyFor(null)).toBeNull();

    await sync({ survey: spec("survey-early") });
    expect(surveyFor(null)?.surveyId).toBe("survey-early");
  });

  test("a survey this window answered is dropped from a later sync or open", async () => {
    await open(spec("survey-a"), "@@A");
    vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    await pickOption("term-a", 0);
    expect(surveyFor("term-a")).toBeNull();

    await sync({ survey: spec("survey-a"), tabName: "@@A" });
    expect(surveyFor("term-a")).toBeNull();
    await open(spec("survey-a"), "@@A");
    expect(surveyFor("term-a")).toBeNull();
  });

  test("an answered group entry leaves the window-wide slot to the one before it", async () => {
    await open(spec("survey-late"));
    vi.spyOn(api, "surveyReply").mockResolvedValue(undefined);
    await pickOption(null, 0);

    await sync({ survey: spec("survey-early") }, { survey: spec("survey-late") });

    expect(surveyFor(null)?.surveyId).toBe("survey-early");
  });

  test("a survey it leaves out waits for its reply in flight, which applies the close if it fails", async () => {
    await open(spec("survey-a"), "@@A");
    const { answer, sent } = replyInFlight("term-a");

    await sync();
    expect(surveyFor("term-a")?.surveyId).toBe("survey-a");

    answer.reject(new TypeError("Failed to fetch"));
    await sent;
    expect(surveyFor("term-a")).toBeNull();
    expect(notices).toEqual([expect.stringMatching(/^survey expired/)]);
  });

  test("a survey keeps the terminal it shows on after that terminal is renamed, beside a group survey", async () => {
    await open(spec("survey-a"), "@@A");
    rename("term-a", "@@Renamed");

    await sync({ survey: spec("survey-a"), tabName: "@@A" }, { survey: spec("survey-group") });

    expect(surveyFor("term-a")?.surveyId).toBe("survey-a");
    expect(surveyFor(null)?.surveyId).toBe("survey-group");
  });

  test("a later group entry sets the one showing aside, and a sync listing it alone raises it again", async () => {
    await open(spec("survey-early"));

    await sync({ survey: spec("survey-early") }, { survey: spec("survey-late") });
    expect(surveyFor(null)?.surveyId).toBe("survey-late");

    await sync({ survey: spec("survey-early") });
    expect(surveyFor(null)?.surveyId).toBe("survey-early");
  });

  test("an earlier group entry does not take the window-wide slot from a later one that shows", async () => {
    await open(spec("survey-early"));
    await open(spec("survey-late"));
    replyInFlight(null);

    await sync({ survey: spec("survey-early") }, { survey: spec("survey-late") });

    expect(surveyFor(null)?.surveyId).toBe("survey-late");
    expect(surveyBusy(null)).toBe(true);
  });

  test("a group survey set aside with its reply in flight is still open when that reply fails", async () => {
    await open(spec("survey-early"));
    const { answer, sent } = replyInFlight(null);

    await sync({ survey: spec("survey-early") }, { survey: spec("survey-late") });
    expect(surveyFor(null)?.surveyId).toBe("survey-late");

    answer.reject(new TypeError("Failed to fetch"));
    await sent;
    expect(surveyFor(null)?.surveyId).toBe("survey-late");
    expect(notices).toEqual([expect.stringMatching(/^survey reply failed: .*; the survey is still open$/)]);
  });

  test("a survey on a renamed terminal keeps its overlay when its reply in flight fails", async () => {
    await open(spec("survey-a"), "@@A");
    const { answer, sent } = replyInFlight("term-a");
    rename("term-a", "@@Renamed");

    await sync({ survey: spec("survey-a"), tabName: "@@A" });
    answer.reject(new TypeError("Failed to fetch"));
    await sent;

    expect(surveyFor("term-a")?.surveyId).toBe("survey-a");
    expect(surveyBusy("term-a")).toBe(false);
    expect(notices).toEqual([expect.stringMatching(/^survey reply failed: /)]);
  });

  test("leaves the Rich Prompt composers alone", async () => {
    richPrompt.byTab["term-a"] = true;
    await open(spec("survey-a"), "@@A");

    await sync();

    expect(surveyFor("term-a")).toBeNull();
    expect(richPrompt.byTab["term-a"]).toBe(true);
  });
});

describe("an answered_elsewhere close delivered to the window that answered", () => {
  const answeredElsewhere = (surveyId: string, tabName: string) =>
    deliver({ command: "close_survey", surveyId, reason: "answered_elsewhere", tabName });

  test("while its reply is in flight leaves the slot to that reply", async () => {
    await open(spec("survey-1"), "@@A");
    const { answer, sent } = replyInFlight("term-a");

    await answeredElsewhere("survey-1", "@@A");
    expect({ shown: surveyFor("term-a")?.surveyId, busy: surveyBusy("term-a") }).toEqual({
      shown: "survey-1",
      busy: true,
    });

    answer.resolve();
    await sent;
    expect({ shown: surveyFor("term-a"), notices }).toEqual({ shown: null, notices: [] });
  });

  test("after its reply settled leaves a later survey on the slot alone", async () => {
    await open(spec("survey-1"), "@@A");
    vi.spyOn(api, "surveyReply").mockResolvedValue(undefined as never);
    await pickOption("term-a", 0);
    await open(spec("survey-2"), "@@A");

    await answeredElsewhere("survey-1", "@@A");

    expect({ shown: surveyFor("term-a")?.surveyId, notices }).toEqual({ shown: "survey-2", notices: [] });
  });
});
